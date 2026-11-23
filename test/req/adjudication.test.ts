// Consistent adjudications (specs/adjudication.spec.md): after schema validation an
// adjudication must name only findings that exist, decide every blocking finding, and never approve
// while accepting a blocker; it gets one retry with the errors, then the phase fails. The merge
// re-checks the stored approval, and the adjudicator sees the card's diff, clipped.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { adjudicationErrors } from "../../src/engine/adjudication.ts";
import type { Adjudication, Findings } from "../../src/engine/context.ts";
import { artifactStore, loadState, saveState } from "../../src/engine/state.ts";
import { git, read, write } from "../helpers.ts";
import { adjudication, counters, finding, findings, project, promptFiles, run, runPath, script, state, subjects, useScript } from "../engine-helpers.ts";

const BLOCKER = "reviewer:R-01";
/** The review every run here gets: one blocking finding (so the adjudicate phase runs) and one minor. */
const review = () => findings([finding("R-01", true), finding("R-02", false)]);
/** The same review as the runtime stores it: each id prefixed with the reviewer's role id. */
const stored = () => ({ summary: "some findings", findings: [finding(BLOCKER, true), finding("reviewer:R-02", false)] }) as unknown as Findings;
const rejectBlocker = { rejected: [{ id: BLOCKER, reason: "the brief allows the empty case" }] };

/** Runs DEMO-1 with the adjudicator replying `replies` in turn; returns the state and the adjudicator prompts. */
async function adjudicate(replies: Record<string, unknown>[]) {
  useScript(script({ reviewer: [{ output: review() }], adjudicator: replies.map((output) => ({ output })) }));
  const dir = project();
  const main = git(dir, "rev-parse", "main");
  const s = await run(dir);
  // The first attempt, then the retry (sorted by name the retry would come first).
  const prompts = [...promptFiles(dir, /-adjudicate-adjudicator\.prompt\.md$/), ...promptFiles(dir, /-adjudicate-adjudicator-retry\.prompt\.md$/)];
  return { dir, s, main, prompts };
}

/** Asserts the adjudicate phase failed after exactly one retry, and nothing was merged. */
function failedAfterOneRetry(r: Awaited<ReturnType<typeof adjudicate>>, error: RegExp): void {
  const adj = r.s.history.filter((h) => h.phase === "adjudicate");
  assert.deepEqual(adj.map((h) => h.outcome), ["fail"], r.s.reason);
  assert.match(adj[0]!.detail, /adjudicator returned an invalid adjudication twice/);
  assert.match(adj[0]!.detail, error);
  assert.equal(counters(r.dir).adjudicator, 2, "asked once, then once more: never a third time");
  assert.equal(r.prompts.length, 2);
  assert.match(r.prompts[1]!, /## Your previous reply was not valid/);
  assert.match(r.prompts[1]!, error, "the retry carries the error");
  assert.equal(git(r.dir, "rev-parse", "main"), r.main, "nothing was merged");
  assert.notEqual(r.s.status, "done");
}

// @req REQ-adjudication-001
test("REQ-adjudication-001: an unknown finding id is refused, asked once more, then the phase fails with the unknown ids", async () => {
  const bad = adjudication("approve", { rejected: [{ id: BLOCKER, reason: "fine" }, { id: "reviewer:R-99", reason: "noise" }], accepted: ["R-77"] });
  const r = await adjudicate([bad, bad]);
  failedAfterOneRetry(r, /no finding with the id 'R-77', 'reviewer:R-99'/);
  assert.match(r.s.history.find((h) => h.phase === "adjudicate")!.detail, /use only these ids: reviewer:R-01, reviewer:R-02/);
});

// @req REQ-adjudication-001
test("REQ-adjudication-001: a retry that fixes the unknown id is accepted (one retry, not a failure)", async () => {
  const bad = adjudication("approve", { rejected: [{ id: "reviewer:R-42", reason: "noise" }] });
  const r = await adjudicate([bad, adjudication("approve", rejectBlocker)]);
  assert.equal(r.s.status, "done", r.s.reason);
  assert.equal(counters(r.dir).adjudicator, 2);
  assert.match(r.prompts[1]!, /no finding with the id 'reviewer:R-42'/);
});

// @req REQ-adjudication-002
test("REQ-adjudication-002: a blocking finding in neither accepted nor rejected is refused, retried once, then fail", async () => {
  const bad = adjudication("approve", { rejected: [{ id: "reviewer:R-02", reason: "style only" }] });
  const r = await adjudicate([bad, bad]);
  failedAfterOneRetry(r, /the blocking finding 'reviewer:R-01' is in neither 'accepted' nor 'rejected'/);
});

// @req REQ-adjudication-002
test("REQ-adjudication-002: every verdict must decide every blocker; a short id fitting one finding decides it", () => {
  const f = stored();
  const reject = adjudication("reject", { instructions: "fix it" }) as unknown as Adjudication;
  assert.match(adjudicationErrors(reject, f).join("\n"), /'reviewer:R-01' is in neither/);
  const short = adjudication("reject", { accepted: ["R-01"], instructions: "fix it" }) as unknown as Adjudication;
  assert.deepEqual(adjudicationErrors(short, f), []);
  const two = { summary: "s", findings: [{ ...finding("R-01", true), id: "reviewer:R-01" }, { ...finding("R-01", true), id: "redteam:R-01" }] } as unknown as Findings;
  assert.match(adjudicationErrors(short, two).join("\n"), /'R-01' fits more than one finding/);
});

// @req REQ-adjudication-003
test("REQ-adjudication-003: an approval that accepts a blocker is refused, retried once, then fail", async () => {
  const bad = adjudication("approve", { accepted: [BLOCKER], rejected: [{ id: "reviewer:R-02", reason: "style only" }] });
  const r = await adjudicate([bad, bad]);
  failedAfterOneRetry(r, /the verdict is 'approve' but 'accepted' holds the blocking finding 'reviewer:R-01'/);
});

// @req REQ-adjudication-003
test("REQ-adjudication-003: an approval that rejects every blocker with a reason gives ok and merges", async () => {
  const r = await adjudicate([adjudication("approve", rejectBlocker)]);
  assert.equal(r.s.status, "done", r.s.reason);
  assert.equal(r.s.history.find((h) => h.phase === "adjudicate")?.outcome, "ok");
  assert.equal(counters(r.dir).adjudicator, 1, "no retry");
  assert.ok(subjects(r.dir).includes("DEMO-1: Card DEMO-1"), "merged");
  // A non-blocking finding may be accepted under an approval.
  const minor = adjudication("approve", { ...rejectBlocker, accepted: ["reviewer:R-02"] }) as unknown as Adjudication;
  assert.deepEqual(adjudicationErrors(minor, stored()), []);
});

// @req REQ-adjudication-003
test("REQ-adjudication-003: mergeEvidence refuses a stored approval that accepts a blocker, and a missing one", async () => {
  useScript(script({ reviewer: [{ output: review() }], adjudicator: [{ output: adjudication("approve", rejectBlocker) }] }));
  const dir = project();
  const main = git(dir, "rev-parse", "main");
  await run(dir, { until: "merge" });
  assert.equal(state(dir).history.find((h) => h.phase === "adjudicate")?.outcome, "ok");
  // A forged approval that accepts the blocker, stored as the runtime stores artifacts (a worker
  // running as the same user could write the run files this way).
  const rd = runPath(dir);
  const st = loadState(rd)!;
  artifactStore(rd, st, () => saveState(rd, st)).put("adjudication", adjudication("approve", { accepted: [BLOCKER] }));
  let s = await run(dir);
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason!, /DEMO-1 was not merged: the recorded approval does not keep the adjudication rules: .*'accepted' holds the blocking finding 'reviewer:R-01'.*--from adjudicate/);
  assert.equal(git(dir, "rev-parse", "main"), main, "nothing was merged");
  // Fail closed: no adjudication at all, while the adjudicate phase applies, refuses too.
  const st2 = loadState(rd)!;
  delete st2.artifacts!.adjudication;
  saveState(rd, st2);
  fs.rmSync(path.join(rd, "adjudication.json"));
  s = await run(dir);
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason!, /DEMO-1 was not merged: no adjudication is recorded/);
  assert.equal(git(dir, "rev-parse", "main"), main, "nothing was merged");
});

// @req REQ-adjudication-004
test("REQ-adjudication-004: the shipped adjudicator's prompt contains the card's diff against the base, clipped to limits.diff_chars", async () => {
  const body = Array.from({ length: 2000 }, (_, i) => `line ${i} of the app`).join("\n");
  useScript(script({
    worker: [{ writes: { "src/app.txt": `${body}\n` }, output: { status: "done", summary: "Added the app file", changed: ["src/app.txt"], verified: ["gate"], not_done: [], docs_updated: [], notes: "" } }],
    reviewer: [{ output: review() }],
    adjudicator: [{ output: adjudication("approve", rejectBlocker) }],
  }));
  const dir = project();
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace(/^limits:\n/m, "limits:\n  diff_chars: 1000\n"));
  git(dir, "commit", "-qam", "small diff limit");
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  const [prompt] = promptFiles(dir, /-adjudicate-adjudicator\.prompt\.md$/);
  assert.ok(prompt);
  const section = prompt.split("## Diff against main\n\n")[1]?.split("\n\nReturn only the JSON object.")[0];
  assert.ok(section, "the prompt has a labelled diff section");
  assert.match(section, /src\/app\.txt/, "the diff of the card's change");
  assert.match(section, /\+line 0 of the app/, "the start of the diff");
  assert.match(section, /\[\.\.\. \d+ characters omitted \.\.\.\]/, "the truncation marker");
  assert.doesNotMatch(section, /line 1000 of the app/, "the middle of the diff is clipped");
  assert.ok(section.length <= 1000 + 60, `the diff is clipped to diff_chars (${section.length} chars)`);
});

/** DEMO-1 run up to the merge with a clean approval; then `forge` rewrites the stored artifacts and the run resumes. */
async function mergeWithForged(forge: (put: (kind: "findings" | "adjudication", value: unknown) => void, reviewed: Record<string, unknown>, rd: string) => void) {
  useScript(script({ reviewer: [{ output: review() }], adjudicator: [{ output: adjudication("approve", rejectBlocker) }] }));
  const dir = project();
  const main = git(dir, "rev-parse", "main");
  await run(dir, { until: "merge" });
  assert.equal(state(dir).history.find((h) => h.phase === "adjudicate")?.outcome, "ok");
  const rd = runPath(dir);
  const st = loadState(rd)!;
  const reviewed = JSON.parse(fs.readFileSync(path.join(rd, "findings.json"), "utf8")) as Record<string, unknown>;
  const store = artifactStore(rd, st, () => saveState(rd, st));
  forge((kind, value) => store.put(kind, value), reviewed, rd);
  const s = await run(dir);
  assert.equal(s.status, "blocked", s.reason);
  assert.equal(git(dir, "rev-parse", "main"), main, "nothing was merged");
  return s;
}

// @req REQ-adjudication-003
test("REQ-adjudication-003: mergeEvidence refuses the merge when the stored findings artifact is null", async () => {
  const s = await mergeWithForged((put) => put("findings", null));
  assert.match(s.reason!, /DEMO-1 was not merged: .*no review is recorded/);
});

// @req REQ-adjudication-003
test("REQ-adjudication-003: mergeEvidence refuses, without throwing, stored findings whose list is null or holds a non-object", async () => {
  let s = await mergeWithForged((put, reviewed) => put("findings", { summary: "x", findings: null, head: reviewed.head }));
  assert.match(s.reason!, /DEMO-1 was not merged: the recorded findings are malformed \('findings' is not a list\)/);
  s = await mergeWithForged((put, reviewed) => put("findings", { summary: "x", findings: [null], head: reviewed.head }));
  assert.match(s.reason!, /DEMO-1 was not merged: the recorded findings are malformed \(a finding is not an object with a string id\)/);
  s = await mergeWithForged((put) => put("adjudication", { verdict: "approve", summary: "s", accepted: null, rejected: [] }));
  assert.match(s.reason!, /DEMO-1 was not merged: the recorded adjudication is malformed \('accepted' is not a list of finding ids\)/);
});

// @req REQ-adjudication-003
test("REQ-adjudication-003: a blocking and a non-blocking finding sharing one id cannot be approved by accepting that id", async () => {
  const twins = { summary: "s", findings: [finding(BLOCKER, false), finding(BLOCKER, true)] } as unknown as Findings;
  const approve = adjudication("approve", { accepted: [BLOCKER] }) as unknown as Adjudication;
  assert.match(adjudicationErrors(approve, twins).join("\n"), /more than one finding with the id 'reviewer:R-01'/);
  // The same rule refuses the stored pair at the merge.
  const s = await mergeWithForged((put, reviewed) => {
    put("findings", { ...twins, head: reviewed.head });
    put("adjudication", approve);
  });
  assert.match(s.reason!, /DEMO-1 was not merged: the recorded approval does not keep the adjudication rules: .*more than one finding with the id 'reviewer:R-01'/);
});

// @req REQ-adjudication-003
test("REQ-adjudication-003: emptied stored findings and a deleted adjudication do not lift the adjudication check", async () => {
  const s = await mergeWithForged((put, reviewed, rd) => {
    put("findings", { findings: [], head: reviewed.head });
    const st = loadState(rd)!;
    delete st.artifacts!.adjudication;
    saveState(rd, st);
    fs.rmSync(path.join(rd, "adjudication.json"));
  });
  assert.match(s.reason!, /DEMO-1 was not merged: no adjudication is recorded\. Run 'mw run DEMO-1 --from adjudicate'/);
});

// @req REQ-adjudication-003
test("REQ-adjudication-003: an adjudicate phase the runtime skipped after the latest review needs no adjudication, even with an old one recorded", async () => {
  useScript(script({
    worker: [
      { writes: { "src/app.txt": "hello\n" }, output: { status: "done", summary: "Added the app file", changed: ["src/app.txt"], verified: ["gate"], not_done: [], docs_updated: [], notes: "" } },
      { writes: { "src/app.txt": "hello again\n" }, output: { status: "done", summary: "Fixed the app file", changed: ["src/app.txt"], verified: ["gate"], not_done: [], docs_updated: [], notes: "" } },
    ],
    reviewer: [{ output: review() }, { output: findings([finding("R-02", false)]) }],
    adjudicator: [{ output: adjudication("reject", { accepted: [BLOCKER], instructions: "fix the blocker" }) }],
  }));
  const dir = project();
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.deepEqual(s.history.filter((h) => h.phase === "adjudicate").map((h) => h.outcome), ["reject", "skipped"]);
  assert.match(fs.readFileSync(path.join(runPath(dir), "adjudication.json"), "utf8"), /"verdict": ?"reject"/, "the first round's rejection is still recorded");
  assert.ok(subjects(dir).includes("DEMO-1: Card DEMO-1"), "merged");
});

// The gate and review phases that need evidence at the merge come from the run history,
// not from a `when` evaluated against stored artifacts a worker could rewrite.

/** DEMO-1 on a custom flow whose gate runs only when the review has a blocking finding (a failed gate carries on). */
function gatedByFindings(): string {
  const dir = project({ cardExtra: "flow: checked\n" });
  write(dir, "flows/checked.flow.yaml", `id: checked
description: Review, then gate only when the review found a blocker.
phases:
  - id: implement
    role: worker
  - id: review
    role: reviewer
  - id: gate
    gate: default
    when: "findings.blocking > 0"
    on: {fail: continue}
  - id: merge
    action: merge
`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "checked flow");
  return dir;
}

const worked = (text: string) => ({ writes: { "src/app.txt": text }, output: { status: "done", summary: "Wrote the app file", changed: ["src/app.txt"], verified: ["gate"], not_done: [], docs_updated: [], notes: "" } });

// @req REQ-adjudication-003
test("REQ-adjudication-003: emptied stored findings do not lift a gate that ran and failed when the flow's gate depends on findings", async () => {
  useScript(script({ worker: [worked("BROKEN\n")], reviewer: [{ output: review() }] }));
  const dir = gatedByFindings();
  const main = git(dir, "rev-parse", "main");
  await run(dir, { until: "merge" });
  assert.deepEqual(state(dir).history.filter((h) => h.phase === "gate").map((h) => h.outcome), ["fail"], "the gate ran and failed");
  // Rewrite the stored findings so `findings.blocking > 0` is false now: the old filter dropped the gate.
  const rd = runPath(dir);
  const st = loadState(rd)!;
  const reviewed = JSON.parse(fs.readFileSync(path.join(rd, "findings.json"), "utf8")) as Record<string, unknown>;
  artifactStore(rd, st, () => saveState(rd, st)).put("findings", { summary: "looks fine", findings: [], head: reviewed.head });
  const s = await run(dir);
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason!, /DEMO-1 was not merged: the merge needs a passing gate and a review of the commit it merges .*but the gate failed on it\. Run 'mw run DEMO-1 --from gate'/);
  assert.equal(git(dir, "rev-parse", "main"), main, "nothing was merged");
  assert.equal(s.merged, undefined);
});

// @req REQ-adjudication-003
test("REQ-adjudication-003: on the same flow a passing gate merges, and a gate the runtime skipped needs no gate result", async () => {
  useScript(script({ worker: [worked("hello\n")], reviewer: [{ output: review() }] }));
  let dir = gatedByFindings();
  let s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.deepEqual(s.history.filter((h) => h.phase === "gate").map((h) => h.outcome), ["ok"]);
  assert.ok(subjects(dir).includes("DEMO-1: Card DEMO-1"), "merged");

  useScript(script({ worker: [worked("hello\n")], reviewer: [{ output: findings([finding("R-02", false)]) }] }));
  dir = gatedByFindings();
  s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.deepEqual(s.history.filter((h) => h.phase === "gate").map((h) => h.outcome), ["skipped"]);
  assert.equal(fs.existsSync(path.join(runPath(dir), "gate.json")), false, "no gate result was recorded");
  assert.ok(subjects(dir).includes("DEMO-1: Card DEMO-1"), "merged");
});
