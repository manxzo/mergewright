// Engine end-to-end: the standard flow's happy path, remediation, adjudication, other flows, dry run.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { git, read } from "./helpers.ts";
import {
  adjudication, branchExists, counters, fakeHub, fakeIntegrations, finding, findings, handoff, phases, project, promptFiles,
  reflection, run, runPath, script, state, subjects, useScript,
} from "./engine-helpers.ts";

test("happy path through the standard flow: squash merge, memory, artifacts, history, hub and integrations", async () => {
  const dir = project();
  useScript(script());
  const hub = fakeHub();
  const integ = fakeIntegrations();
  const lines: string[] = [];
  const s = await run(dir, { onProgress: (l) => lines.push(l) }, { hub, integrations: integ });

  assert.equal(s.status, "done");
  assert.deepEqual(phases(s), ["brief:ok", "implement:ok", "gate:ok", "review:ok", "adjudicate:skipped", "merge:ok", "reflect:ok", "docs:ok"]);
  assert.deepEqual(s.history.find((h) => h.phase === "implement")!.roles, ["worker"]);
  assert.equal(state(dir).status, "done");
  // One squash commit on main with a single parent, carrying the work and the card marked done.
  const log = subjects(dir);
  assert.deepEqual(log.slice(0, 2), ["DEMO-1: update project memory", "DEMO-1: Card DEMO-1"]);
  assert.equal(git(dir, "rev-list", "--parents", "-n", "1", s.merged!).split(" ").length, 2);
  assert.match(git(dir, "log", "-1", "--format=%B", s.merged!), /Add the app file\.[\s\S]*Reviewers: reviewer[\s\S]*Rounds: 1/);
  assert.equal(read(dir, "src/app.txt"), "hello\n");
  assert.match(read(dir, "cards/DEMO-1.card.md"), /status: done/);
  assert.equal(git(dir, "status", "--porcelain"), "");
  // Worktree and branch are gone.
  assert.equal(fs.existsSync(path.join(dir, ".mergewright/worktrees/DEMO-1")), false);
  assert.equal(branchExists(dir, "card/DEMO-1"), false);
  assert.equal(git(dir, "worktree", "list").split("\n").length, 1);
  // Memory updated and committed.
  assert.match(read(dir, "memory/STATE.md"), /DEMO-1 is finished/);
  assert.match(read(dir, "memory/lessons/testing.md"), /## Keep tests hermetic/);
  assert.match(read(dir, "memory/outcomes/DEMO-1.md"), /Delivered the app file/);
  assert.match(git(dir, "show", "--stat", "--format=", "HEAD"), /memory\/STATE\.md/);
  // Artifacts.
  for (const a of ["brief", "handoff", "findings", "gate", "reflection", "state"]) assert.ok(fs.existsSync(runPath(dir, `${a}.json`)), a);
  assert.equal(fs.existsSync(runPath(dir, "adjudication.json")), false);
  const f = JSON.parse(fs.readFileSync(runPath(dir, "findings.json"), "utf8"));
  assert.equal(f.findings[0].id, "reviewer:R-01");
  assert.equal(JSON.parse(fs.readFileSync(runPath(dir, "gate.json"), "utf8")).ok, true);
  // Prompts and outputs are kept for audit, with variables filled in.
  const planner = promptFiles(dir, /brief-planner\.prompt\.md$/)[0]!;
  assert.match(planner, /- id: DEMO-1/);
  assert.match(planner, /Because the demo needs it/);
  assert.match(planner, /Remote lesson: from the semantic store/);
  assert.doesNotMatch(planner, /\{\{/);
  const reviewer = promptFiles(dir, /review-reviewer\.prompt\.md$/)[0]!;
  assert.match(reviewer, /\+hello/, "the reviewer sees the diff");
  assert.match(reviewer, /- check: ok/, "the reviewer sees the gate");
  assert.ok(fs.existsSync(runPath(dir, "schemas", "output.brief.schema.json")));
  assert.ok(lines.some((l) => /^brief\s+ok\s+\(planner, \d+s\)/.test(l)), lines.join("\n"));
  // Hub: branch pushed after the worker's commit, base pushed after merge and memory, branch deleted.
  const names = hub.names();
  assert.ok(names.includes("prepare"));
  assert.ok(names.filter((n) => n === "pushBase").length >= 2);
  assert.deepEqual(hub.calls.filter((c) => c.name === "deleteBranch").map((c) => c.args[0]), ["card/DEMO-1"]);
  const firstPush = names.indexOf("pushBranch");
  assert.ok(firstPush > 0 && names[firstPush - 1] === "refresh", "a push is preceded by a lease refresh");
  // Integrations.
  const remembered = integ.of("remember")[0]!.args[0] as { title: string; card: string }[];
  assert.deepEqual(remembered.map((l) => [l.title, l.card]), [["Keep tests hermetic", "DEMO-1"]]);
  assert.deepEqual(integ.of("docsSync")[0]!.args, [["docs/guide.md"], []]);
  assert.ok(integ.of("notify").some((c) => /DEMO-1 is done/.test(String(c.args[0]))));
  assert.deepEqual(integ.of("mirrorCard").map((c) => c.args[2]), ["running", "done"]);
  assert.equal(integ.of("usageOk").length, 0, "every role runs on mock, which the usage guard does not check (REQ-usage-004)");
});

test("a failing gate sends the run back once and then passes in round 1", async () => {
  const dir = project();
  useScript(script({
    worker: [
      { writes: { "src/app.txt": "BROKEN\n" }, output: handoff() },
      { writes: { "src/app.txt": "fixed\n" }, output: handoff({ summary: "Fixed the app file" }) },
    ],
  }));
  const s = await run(dir);
  assert.equal(s.status, "done");
  assert.equal(s.round, 1);
  assert.deepEqual(phases(s).slice(0, 6), ["brief:ok", "implement:ok", "gate:fail", "implement:ok", "gate:ok", "review:ok"]);
  assert.equal(s.history[2]!.round, 0);
  assert.equal(s.history[3]!.round, 1);
  const second = promptFiles(dir, /implement-worker\.prompt\.md$/)[1]!;
  assert.match(second, /Fix requested \(round 1\)/);
  assert.match(second, /app is broken: src\/app\.txt says BROKEN/, "the remediation carries the failing step's log");
  assert.equal(read(dir, "src/app.txt"), "fixed\n");
  assert.ok(git(dir, "log", "--format=%s", "main").includes("DEMO-1: Card DEMO-1"));
});

test("a gate that keeps failing spends the remediation budget and blocks", async () => {
  const dir = project();
  useScript(script({ worker: [{ writes: { "src/app.txt": "BROKEN\n" }, output: handoff() }] }));
  const integ = fakeIntegrations();
  const s = await run(dir, {}, { integrations: integ });
  assert.equal(s.status, "blocked");
  assert.match(s.reason!, /remediation budget spent \(2 round\(s\)\)/);
  assert.equal(s.round, 2);
  assert.equal(counters(dir).worker, 3);
  assert.equal(fs.existsSync(path.join(dir, "src/app.txt")), false, "nothing merged");
  assert.equal(state(dir).status, "blocked");
  assert.ok(integ.of("notify").some((c) => /blocked at 'gate'/.test(String(c.args[0]))));
  assert.deepEqual(integ.of("mirrorCard").map((c) => c.args[2]), ["running", "blocked"]);
});

test("a blocking finding is rejected by the adjudicator, remediated, then approved and merged", async () => {
  const dir = project();
  useScript(script({
    worker: [
      { writes: { "src/app.txt": "v1\n" }, output: handoff() },
      { writes: { "src/app.txt": "v2\n" }, output: handoff({ summary: "Handled the empty case" }) },
    ],
    reviewer: [{ output: findings([finding("R-01", true)]) }],
    adjudicator: [
      { output: adjudication("reject", { accepted: ["reviewer:R-01"], instructions: "Handle the empty case in src/app.txt (R-01)." }) },
      { output: adjudication("approve", { accepted: [], rejected: [{ id: "reviewer:R-01", reason: "fixed" }] }) },
    ],
  }));
  const s = await run(dir);
  assert.equal(s.status, "done");
  assert.deepEqual(phases(s), [
    "brief:ok", "implement:ok", "gate:ok", "review:ok", "adjudicate:reject",
    "implement:ok", "gate:ok", "review:ok", "adjudicate:ok", "merge:ok", "reflect:ok", "docs:ok",
  ]);
  const second = promptFiles(dir, /implement-worker\.prompt\.md$/)[1]!;
  assert.match(second, /Handle the empty case in src\/app\.txt \(R-01\)\./);
  assert.match(second, /reviewer:R-01 src\/app\.txt:1 problem R-01: detail of R-01/);
  assert.equal(JSON.parse(fs.readFileSync(runPath(dir, "adjudication.json"), "utf8")).verdict, "approve");
  assert.equal(read(dir, "src/app.txt"), "v2\n");
  assert.ok(subjects(dir).includes("DEMO-1: Card DEMO-1"));
});

test("spike flow: no merge, the branch is kept, memory is still updated", async () => {
  const dir = project({ kind: "spike" });
  useScript(script({ worker: [{ writes: { "src/notes.txt": "found things\n" }, output: handoff({ summary: "Explored" }) }] }));
  const s = await run(dir);
  assert.equal(s.flow, "spike");
  assert.equal(s.status, "done");
  assert.deepEqual(phases(s), ["explore:ok", "reflect:ok"]);
  assert.equal(s.merged, undefined);
  assert.ok(branchExists(dir, "card/DEMO-1"));
  assert.equal(git(dir, "show", "card/DEMO-1:src/notes.txt"), "found things");
  assert.equal(fs.existsSync(path.join(dir, "src/notes.txt")), false);
  assert.match(read(dir, "cards/DEMO-1.card.md"), /status: todo/);
  assert.equal(subjects(dir)[0], "DEMO-1: update project memory");
});

test("quick flow, with the reviewer running on the shell harness", async () => {
  const reply = JSON.stringify(findings());
  const dir = project({
    cardExtra: "flow: quick\n",
    roles: { reviewer: { runs: "shell", command: `cat > /dev/null; test "$MW_ROLE" = reviewer && test -f "$MW_OUTPUT_SCHEMA" && printf 'Review done.\\n\`\`\`json\\n%s\\n\`\`\`\\n' '${reply}'` } },
  });
  useScript(script());
  const s = await run(dir);
  assert.equal(s.status, "done");
  assert.deepEqual(phases(s), ["implement:ok", "gate:ok", "review:ok", "adjudicate:skipped", "merge:ok", "reflect:ok", "docs:ok"]);
  assert.equal(JSON.parse(fs.readFileSync(runPath(dir, "findings.json"), "utf8")).summary, "reviewer: looks fine");
  assert.equal(read(dir, "src/app.txt"), "hello\n");
});

test("--dry-run prints the phases and executes nothing", async () => {
  const dir = project();
  useScript(script());
  const hub = fakeHub();
  const lines: string[] = [];
  const s = await run(dir, { dryRun: true, onProgress: (l) => lines.push(l) }, { hub });
  assert.equal(s.status, "running");
  assert.ok(lines.some((l) => /^brief\s+planner\s+mock\/sonnet advise, ~\d+ tokens/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /^review\s+reviewer-deep .*only when deep_review or risk >= high: now false/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /^gate\s+gate default/.test(l)));
  assert.ok(lines.some((l) => /^merge\s+action merge/.test(l)));
  assert.equal(fs.existsSync(path.join(dir, ".mergewright")), false);
  assert.equal(branchExists(dir, "card/DEMO-1"), false);
  assert.deepEqual(hub.calls, []);
  assert.equal(subjects(dir)[0], "setup");
});

test("an over-long reflected state gets one rerun, then everything but the state is applied", async () => {
  const dir = project();
  const long = `# State\n${"- line\n".repeat(200)}`;
  useScript(script({ reflector: [{ output: reflection({ state: long }) }] }));
  const s = await run(dir);
  assert.equal(s.status, "done");
  assert.equal(counters(dir).reflector, 2);
  assert.match(promptFiles(dir, /reflect-reflector-memory\.prompt\.md$/)[0]!, /the cap is 150/);
  assert.doesNotMatch(read(dir, "memory/STATE.md"), /- line/);
  assert.match(read(dir, "memory/outcomes/DEMO-1.md"), /Delivered/);
  assert.ok(s.warnings.some((w) => /STATE\.md was left unchanged/.test(w)));
  assert.equal(subjects(dir)[0], "DEMO-1: update project memory");
});
