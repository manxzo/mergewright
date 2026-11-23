// Engine control: stop points, scope, briefs, invalid output, resume, locks, merge failures,
// abort, usage pauses, the lease heartbeat, interrupted merges, and the mw commands.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setCardStatus } from "../src/cards.ts";
import { buildSquash, moveBase } from "../src/engine/gitops.ts";
import { cardStatuses, describeRun } from "../src/engine/run.ts";
import type { RunState } from "../src/engine/types.ts";
import { Project } from "../src/project.ts";
import { git, mw, newProject, read, write } from "./helpers.ts";
import {
  adjudication, brief, branchExists, counters, fakeHub, fakeIntegrations, findings, handoff, phases, project, promptFiles,
  lockPath, run, runPath, script, setRoles, state, subjects, useScript,
} from "./engine-helpers.ts";

const squashes = (dir: string) => subjects(dir).filter((s) => s === "DEMO-1: Card DEMO-1").length;

test("stop points: a high-risk card waits for 'go' and then 'merge'; mw approve continues", () => {
  const dir = project({ cardExtra: "risk: high\n" });
  const env = { MW_MOCK_SCRIPT: useScript(script()) };
  let r = mw(dir, ["run", "DEMO-1"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /waiting before 'implement' for approval 'go'\. Run 'mw approve DEMO-1 go'/);
  let s = state(dir);
  assert.equal(s.status, "waiting");
  assert.equal(s.reason, "go");
  assert.deepEqual(phases(s), ["brief:ok", "implement:waiting"]);
  assert.equal(counters(dir).worker, undefined, "the worker has not run");
  // Running again only repeats what it waits for.
  r = mw(dir, ["run", "DEMO-1"], env);
  assert.match(r.out, /for approval 'go'/);
  assert.equal(state(dir).history.length, 2);
  assert.match(mw(dir, ["status"], env).out, /DEMO-1\s+waiting\s+standard\s+implement\s+Card DEMO-1/);
  // The wrong word is refused.
  r = mw(dir, ["approve", "DEMO-1", "merge"], env);
  assert.equal(r.code, 1);
  assert.match(r.err, /waiting before 'implement' for 'go', not 'merge'/);

  r = mw(dir, ["approve", "DEMO-1", "go"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /waiting before 'merge' for approval 'merge'/);
  s = state(dir);
  assert.deepEqual(s.approvals, ["implement:go"]);
  assert.deepEqual(s.history.find((h) => h.phase === "review")!.roles, ["reviewer", "reviewer-deep"], "high risk adds the deep reviewer");
  assert.ok(phases(s).includes("adjudicate:ok"), "high risk always adjudicates");
  assert.equal(squashes(dir), 0);

  r = mw(dir, ["approve", "DEMO-1", "merge"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /DEMO-1 is done: merged into main as [0-9a-f]{10}\./);
  s = state(dir);
  assert.equal(s.status, "done");
  assert.deepEqual(s.approvals, ["implement:go", "merge:merge"]);
  assert.equal(squashes(dir), 1);
  assert.match(mw(dir, ["run", "DEMO-1"], env).out, /DEMO-1 is done/);
});

test("--approve grants stop points up front", async () => {
  const dir = project({ cardExtra: "risk: high\n" });
  useScript(script());
  const s = await run(dir, { approve: ["go", "merge"] });
  assert.equal(s.status, "done");
  assert.deepEqual(s.approvals, ["implement:go", "merge:merge"]);
});

test("a worker writing outside its scope fails the phase and is remediated", async () => {
  const dir = project();
  useScript(script({
    worker: [
      { writes: { "src/app.txt": "hello\n", "other/x.txt": "stray\n" }, output: handoff() },
      { deletes: ["other/x.txt"], output: handoff({ summary: "Reverted the stray file" }) },
    ],
  }));
  const s = await run(dir);
  assert.equal(s.status, "done");
  assert.deepEqual(phases(s).slice(0, 3), ["brief:ok", "implement:fail", "implement:ok"]);
  assert.match(s.history[1]!.detail, /other\/x\.txt \(outside the scope\)/);
  assert.match(promptFiles(dir, /implement-worker\.prompt\.md$/)[1]!, /Revert these files/);
  assert.equal(fs.existsSync(path.join(dir, "other/x.txt")), false);
  assert.equal(read(dir, "src/app.txt"), "hello\n");
});

test("a protected path fails unless the card grants it", async () => {
  const scope = ["src/**", "memory/**"];
  const dir = project({ scope });
  // Lint refuses to start a card whose scope covers an ungranted protected path, except under a
  // documentation path; make memory/** one, so the run starts and the runtime's own check is tested.
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml") + "docs:\n  paths: [docs/**, README.md, memory/**]\n");
  git(dir, "commit", "-qam", "memory/** is a documentation path");
  const original = read(dir, "memory/RULES.md");
  useScript(script({
    planner: [{ output: brief({ scope }) }],
    worker: [
      { writes: { "memory/RULES.md": "# Rules\n\n- hacked\n" }, output: handoff() },
      { writes: { "memory/RULES.md": original, "src/app.txt": "ok\n" }, output: handoff() },
    ],
  }));
  const s = await run(dir);
  assert.equal(s.status, "done");
  assert.match(s.history[1]!.detail, /memory\/RULES\.md \(a protected path this card was not granted\)/);
  assert.equal(read(dir, "memory/RULES.md"), original);

  const granted = project({ scope, cardExtra: "allow_protected: [memory/RULES.md]\n" });
  useScript(script({ planner: [{ output: brief({ scope }) }], worker: [{ writes: { "memory/RULES.md": "# Rules\n\n- granted\n" }, output: handoff() }] }));
  const g = await run(granted);
  assert.equal(g.status, "done");
  assert.equal(g.round, 0);
  assert.equal(read(granted, "memory/RULES.md"), "# Rules\n\n- granted\n");
});

test("a brief that is not ready blocks before any work", async () => {
  const dir = project();
  useScript(script({ planner: [{ output: brief({ ready: false, blockers: ["needs a change to REQ-auth-001"] }) }] }));
  const s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.match(s.reason!, /not ready: needs a change to REQ-auth-001/);
  assert.deepEqual(phases(s), ["brief:block"]);
  assert.equal(counters(dir).worker, undefined);
});

// The card's scope is always enforced; a brief can narrow it, never widen it.
for (const [name, briefScope] of [["an empty brief scope", []], ["a wider brief scope", ["src/**", "lib/**"]]] as const) {
  test(`${name} does not widen the card's scope: nested and outside paths fail`, async () => {
    const dir = project({ scope: ["src/*"] });
    useScript(script({
      planner: [{ output: brief({ scope: briefScope }) }],
      worker: [
        { writes: { "src/app.txt": "hello\n", "src/deep/x.txt": "nested\n", "lib/y.txt": "outside\n" }, output: handoff() },
        { deletes: ["src/deep", "lib"], output: handoff({ summary: "Kept to the card's scope" }) },
      ],
    }));
    const s = await run(dir);
    assert.equal(s.status, "done", s.reason);
    assert.deepEqual(phases(s).slice(0, 3), ["brief:ok", "implement:fail", "implement:ok"]);
    assert.match(s.history[1]!.detail, /src\/deep\/x\.txt \(outside the scope\)/);
    assert.match(s.history[1]!.detail, /lib\/y\.txt \(outside the scope\)/);
    assert.equal(fs.existsSync(path.join(dir, "src/deep/x.txt")), false, "nothing outside the card's scope was merged");
    assert.equal(fs.existsSync(path.join(dir, "lib/y.txt")), false);
    assert.equal(read(dir, "src/app.txt"), "hello\n");
  });
}

test("a worker handing off as blocked blocks the run, with its work committed on the branch", async () => {
  const dir = project();
  useScript(script({ worker: [{ writes: { "src/app.txt": "partial\n" }, output: handoff({ status: "blocked", summary: "The brief conflicts with REQ-x", not_done: ["everything else"] }) }] }));
  const s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.match(s.reason!, /the worker stopped: The brief conflicts with REQ-x; everything else/);
  assert.equal(git(dir, "log", "-1", "--format=%s", "card/DEMO-1"), "DEMO-1: The brief conflicts with REQ-x");
});

test("invalid role output is retried once with the errors, then fails", async () => {
  const dir = project();
  useScript(script({ planner: [{ output: "I think the card is fine." }, { output: { summary: "only this" } }] }));
  const s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.equal(counters(dir).planner, 2);
  assert.match(s.reason!, /planner returned an invalid brief twice: .*missing required field 'approach'/);
  const retry = fs.readFileSync(runPath(dir, "phases", "01-brief-planner-retry.prompt.md"), "utf8");
  assert.match(retry, /Your previous reply was not valid\n\n- the reply contains no JSON object/);
  assert.equal(fs.existsSync(runPath(dir, "brief.json")), false);

  const ok = project();
  useScript(script({ planner: [{ output: { summary: "only this" } }, { output: `Here it is:\n\`\`\`json\n${JSON.stringify(brief())}\n\`\`\`\n` }] }));
  const t = await run(ok, { until: "gate" });
  assert.equal(t.status, "running");
  assert.deepEqual(phases(t), ["brief:ok", "implement:ok"]);
  assert.equal(JSON.parse(fs.readFileSync(runPath(ok, "brief.json"), "utf8")).summary, "Add the app file.");
});

test("resume: a run stopped with --until continues where it left off without redoing phases", async () => {
  const dir = project();
  useScript(script());
  const first = await run(dir, { until: "gate" });
  assert.equal(first.status, "running");
  assert.deepEqual(phases(first), ["brief:ok", "implement:ok"]);
  assert.match(describeRun(new Project(dir), first), /stopped before 'gate'/);
  assert.ok(fs.existsSync(path.join(dir, ".mergewright/worktrees/DEMO-1/src/app.txt")));
  const second = await run(dir);
  assert.equal(second.status, "done");
  assert.deepEqual(phases(second).slice(0, 3), ["brief:ok", "implement:ok", "gate:ok"]);
  assert.deepEqual(counters(dir), { planner: 1, worker: 1, reviewer: 1, reflector: 1 });
  assert.equal(squashes(dir), 1);
});

test("a second run of the same card is refused while the first one's process is alive", async () => {
  const dir = project();
  useScript(script());
  fs.mkdirSync(path.dirname(lockPath(dir)), { recursive: true });
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, host: os.hostname(), started: "earlier" }));
  await assert.rejects(run(dir), /DEMO-1 is already being run by process \d+ on this machine/);
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999999999, host: os.hostname(), started: "earlier" }));
  const s = await run(dir);
  assert.equal(s.status, "done", "a stale lock is taken over");
  assert.equal(fs.existsSync(lockPath(dir)), false, "the lock is released");
});

test("a merge conflict with the base branch fails the merge phase and leaves the base alone", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  write(dir, "src/app.txt", "other\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "someone else's change");
  const before = git(dir, "rev-parse", "main");
  const s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.deepEqual(phases(s).slice(-1), ["merge:fail"]);
  assert.match(s.reason!, /conflicts with main in: src\/app\.txt/);
  assert.equal(git(dir, "rev-parse", "main"), before);
  assert.equal(read(dir, "src/app.txt"), "other\n");
  assert.equal(s.pendingMerge, undefined);
  assert.ok(branchExists(dir, "card/DEMO-1"));
});

test("a local edit the merge would overwrite fails the merge with nothing lost; a retry then merges", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  write(dir, "src/app.txt", "my local work\n"); // untracked in the main checkout
  const before = git(dir, "rev-parse", "main");
  const s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.match(s.reason!, /git refused to update main .*nothing was changed/);
  assert.equal(read(dir, "src/app.txt"), "my local work\n");
  assert.equal(git(dir, "rev-parse", "main"), before);
  assert.equal(state(dir).pendingMerge, undefined);

  fs.rmSync(path.join(dir, "src/app.txt"));
  const again = await run(dir);
  assert.equal(again.status, "done");
  assert.equal(squashes(dir), 1);
  assert.equal(read(dir, "src/app.txt"), "hello\n");
});

test("an interrupted merge (base moved, state not saved) finishes on resume without merging twice", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  // Do what the merge phase does up to the crash: mark done, squash, move the base, record pendingMerge.
  const wt = path.join(dir, ".mergewright/worktrees/DEMO-1");
  setCardStatus(path.join(wt, "cards/DEMO-1.card.md"), "done");
  git(wt, "commit", "-qam", "DEMO-1: mark done");
  const built = buildSquash(dir, "main", "card/DEMO-1", "DEMO-1: Card DEMO-1\n");
  assert.ok(built.ok);
  const s0 = state(dir);
  s0.pendingMerge = built.commit;
  s0.pendingMergeHead = git(dir, "rev-parse", "card/DEMO-1"); // the runtime records the head it squashed
  fs.writeFileSync(runPath(dir, "state.json"), JSON.stringify(s0));
  assert.ok(moveBase(dir, "main", built.commit!).ok);

  const hub = fakeHub();
  const s = await run(dir, {}, { hub });
  assert.equal(s.status, "done");
  assert.equal(squashes(dir), 1);
  assert.equal(s.merged, built.commit);
  assert.equal(s.pendingMerge, undefined);
  assert.match(s.history.find((h) => h.phase === "merge")!.detail, /finished an interrupted merge/);
  assert.equal(branchExists(dir, "card/DEMO-1"), false);
  assert.equal(fs.existsSync(wt), false);
  assert.ok(hub.names().includes("pushBase"));
  assert.match(read(dir, "cards/DEMO-1.card.md"), /status: done/);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("mw abort moves the worktree aside and keeps the branch; --force deletes it; a new run starts over", () => {
  const dir = project();
  const env = { MW_MOCK_SCRIPT: useScript(script()) };
  assert.equal(mw(dir, ["run", "DEMO-1", "--until", "gate"], env).code, 0);
  let r = mw(dir, ["abort", "DEMO-1"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /DEMO-1 aborted: its worktree was moved to \.mergewright\/local\/discarded\/DEMO-1-\S+ \(kept there for seven days\) and branch card\/DEMO-1 was kept\./);
  assert.equal(state(dir).status, "aborted");
  assert.equal(fs.existsSync(path.join(dir, ".mergewright/worktrees/DEMO-1")), false);
  assert.ok(branchExists(dir, "card/DEMO-1"));
  assert.match(mw(dir, ["status"], env).out, /DEMO-1\s+aborted/);

  r = mw(dir, ["run", "DEMO-1", "--until", "gate"], env);
  assert.equal(r.code, 0, r.err);
  const s = state(dir);
  assert.equal(s.status, "running");
  assert.deepEqual(phases(s), ["brief:ok", "implement:ok"], "the aborted run's history is gone");
  assert.equal(counters(dir).worker, 1);

  r = mw(dir, ["abort", "DEMO-1", "--force"], env);
  assert.match(r.out, /its branch was deleted/);
  assert.equal(branchExists(dir, "card/DEMO-1"), false);
});

test("usage pause: the run waits before a write-mode role and continues later", async () => {
  // REQ-usage-004: only roles on a paid harness are guarded, so the worker is on codex while paused.
  const dir = project({ roles: { worker: { runs: "codex" } } });
  useScript(script());
  let allowed = false;
  const integ = fakeIntegrations({ usage: () => (allowed ? { ok: true, detail: "fine" } : { ok: false, detail: "5-hour window at 92%" }) });
  const s = await run(dir, {}, { integrations: integ });
  assert.equal(s.status, "waiting");
  assert.equal(s.reason, "usage");
  assert.deepEqual(phases(s), ["brief:ok", "implement:waiting"]);
  assert.match(s.history[1]!.detail, /usage: 5-hour window at 92%/);
  assert.equal(counters(dir).worker, undefined);
  assert.match(describeRun(new Project(dir), s), /paused before 'implement' because agent usage is too high \(5-hour window at 92%\)/);
  assert.ok(integ.of("notify").some((c) => /paused for usage/.test(String(c.args[0]))));
  allowed = true;
  setRoles(dir); // back on mock, so the resumed run needs no real codex
  git(dir, "commit", "-qam", "roles on mock");
  const t = await run(dir, {}, { integrations: integ });
  assert.equal(t.status, "done");
  assert.equal(counters(dir).worker, 1);
});

test("losing the lease mid-phase aborts the agent, commits, pushes and saves nothing, and fails", async () => {
  const dir = project();
  const pidFile = path.join(dir, ".mergewright", "agent.pid");
  setRoles(dir, { worker: { runs: "shell", command: `mkdir -p src; echo partial > src/app.txt; echo $$ > '${pidFile}'; sleep 30; echo '{}'` } });
  git(dir, "commit", "-qam", "worker on the shell");
  useScript(script());
  process.env.MW_HEARTBEAT_MS = "50";
  let before = "";
  const hub = fakeHub({
    holder: "other-host",
    refresh: () => {
      if (!fs.existsSync(pidFile)) return;
      before ||= fs.readFileSync(runPath(dir, "state.json"), "utf8");
      throw new Error("the lease is held by other-host");
    },
  });
  const t0 = Date.now();
  try {
    await assert.rejects(run(dir, {}, { hub }), (e: Error & { code?: string }) => {
      assert.equal(e.code, "lease/lost");
      assert.match(e.message, /this machine lost the lease to other-host/);
      assert.match(e.message, /nothing was committed, pushed or saved/);
      return true;
    });
  } finally {
    delete process.env.MW_HEARTBEAT_MS;
  }
  assert.ok(Date.now() - t0 < 15_000, "the agent was not waited for");
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the agent process was killed");
  assert.equal(git(dir, "rev-parse", "card/DEMO-1"), git(dir, "rev-parse", "main"), "no commit");
  // Nothing is done to the worktree on losing the lease; the next run deals with it.
  assert.equal(read(path.join(dir, ".mergewright/worktrees/DEMO-1"), "src/app.txt"), "partial\n", "the phase's leftovers were not touched");
  assert.ok(!hub.names().includes("pushBranch"), "no push");
  // Decision A: the shared run state is exactly as it was when the phase started.
  assert.ok(before);
  assert.equal(fs.readFileSync(runPath(dir, "state.json"), "utf8"), before);
  assert.equal(state(dir).status, "running");
  assert.deepEqual(phases(state(dir)), ["brief:ok"]);
  assert.equal(fs.readdirSync(runPath(dir, "phases")).some((f) => f.includes("implement")), false, "no audit copy of the stopped phase");
  assert.equal(fs.existsSync(lockPath(dir)), false, "this machine's own lock is released");
});

test("mw status works with no runs, lists run state when there is one, and has --json", async () => {
  const empty = newProject();
  const r0 = mw(empty, ["status"]);
  assert.equal(r0.code, 0, r0.err);
  assert.match(r0.out, /no cards yet/);

  const dir = project();
  let r = mw(dir, ["status"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /DEMO-1\s+todo\s+standard\s+-\s+Card DEMO-1/);
  useScript(script());
  await run(dir, { until: "review" });
  r = mw(dir, ["status", "--json"]);
  const rows = JSON.parse(r.out) as { usage?: { byHarness: Record<string, { inputTokens?: number; costUsd?: number }>; summary: string } }[];
  // The mock harness reports tokens and no price, like Codex.
  assert.equal(rows[0]!.usage?.byHarness.mock?.costUsd, undefined);
  assert.ok((rows[0]!.usage?.byHarness.mock?.inputTokens ?? 0) > 0);
  assert.match(rows[0]!.usage?.summary ?? "", /^mock [\d,]+ in \/ [\d,]+ out tokens$/);
  delete rows[0]!.usage;
  // The harness and model each role ran with.
  assert.deepEqual((rows[0] as { agents?: { role: string; harness: string }[] }).agents?.map((x) => `${x.role}:${x.harness}`), ["planner:mock", "worker:mock"]);
  delete (rows[0] as { agents?: unknown }).agents;
  // REQ-engine-014: the run stopped with --until and no process drives it, so it is queued.
  const queued = "queued ('mw work' or 'mw run DEMO-1' resumes it at 'review')";
  assert.deepEqual(rows, [{ id: "DEMO-1", title: "Card DEMO-1", status: queued, flow: "standard", phase: "review" }]);
  assert.deepEqual(cardStatuses(new Project(dir)).map((x) => x.status), [queued]);
});

test("mw run refuses when the main checkout is not on the base branch, and exits 1 when blocked", async () => {
  const dir = project();
  const env = { MW_MOCK_SCRIPT: useScript(script({ planner: [{ output: brief({ ready: false, blockers: ["no"] }) }] })) };
  git(dir, "switch", "-q", "-c", "elsewhere");
  let r = mw(dir, ["run", "DEMO-1"], env);
  assert.equal(r.code, 1);
  assert.match(r.err, /the main checkout is on 'elsewhere', but runs start from the base branch 'main'; run 'git switch main' first/);
  git(dir, "switch", "-q", "main");
  r = mw(dir, ["run", "DEMO-1"], env);
  assert.equal(r.code, 1);
  assert.match(r.out, /DEMO-1 is blocked at 'brief': the planner says the card is not ready: no\nFix the cause, then run 'mw run DEMO-1' to retry that phase\./);
  assert.match(r.out, /^brief\s+block/m);
});

test("adjudicator 'block' blocks the run", async () => {
  const dir = project({ cardExtra: "risk: high\n" });
  useScript(script({ adjudicator: [{ output: adjudication("block", { summary: "needs a requirement change" }) }], reviewer: [{ output: findings() }] }));
  const s = await run(dir, { approve: ["go"] });
  assert.equal(s.status, "blocked");
  assert.match(s.reason!, /the adjudicator blocked the card: needs a requirement change/);
  assert.equal(squashes(dir), 0);
});

test("--from sends a blocked card back to an earlier phase with its fix rounds restored; a merged card cannot go back", async () => {
  const dir = project();
  // The gate fails three times: round budget (2) is spent and the card blocks.
  useScript(script({ worker: [{ writes: { "src/app.txt": "BROKEN\n" }, output: handoff() }] }));
  let s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.match(s.reason!, /remediation budget/);
  assert.equal(s.round, 2);
  // The owner fixes the cause; the card goes back to the brief and runs through.
  useScript(script());
  s = await run(dir, { from: "brief" });
  assert.equal(s.status, "done", s.reason);
  assert.equal(s.round, 0);
  assert.equal(phases(s).filter((p) => p === "brief:ok").length, 2, "the brief was written again");
  await assert.rejects(run(dir, { from: "brief" }), /already merged/);
  await assert.rejects(run(project(), { from: "nonesuch" }), /has no phase 'nonesuch'/);
});

test("mw retry puts a blocked card back without running anything, so unattended work can continue it", async () => {
  const dir = project();
  const blocked = useScript(script({ planner: [{ output: brief({ ready: false, blockers: ["docs/guide.md is outside the card's scope"] }) }] }));
  assert.equal(mw(dir, ["run", "DEMO-1"], { MW_MOCK_SCRIPT: blocked }).code, 1);
  assert.equal(state(dir).status, "blocked");
  const before = counters(dir);
  const r = mw(dir, ["retry", "DEMO-1", "--from", "brief"], { MW_MOCK_SCRIPT: blocked });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /DEMO-1 is back at 'brief'/);
  assert.deepEqual(counters(dir), before, "no agent ran");
  assert.equal(state(dir).status, "running");
  assert.equal(state(dir).phase, 0);
  // Without --from it goes back to the phase fix rounds return to.
  assert.equal(mw(dir, ["retry", "DEMO-1"], { MW_MOCK_SCRIPT: blocked }).code, 0);
  assert.equal(state(dir).phase, 1);
});
