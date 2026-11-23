// Engine safety: each test reproduces a way an agent, a crash or another process could damage the
// repository, and asserts the state the engine must leave behind.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { acquireLock } from "../src/engine/state.ts";
import { abort, pruneFinished } from "../src/engine/run.ts";
import { claudeSandbox } from "../src/engine/harness/claude.ts";
import type { Hub, Integrations } from "../src/engine/types.ts";
import { hubFor } from "../src/hub.ts";
import { Project } from "../src/project.ts";
import { MwError } from "../src/util.ts";
import { git, read, tmpDir, write } from "./helpers.ts";
import {
  as, at, brief, branchExists, counters, fakeHub, fakeIntegrations, handoff, hubPair, lockPath, mirror, phases, project, promptFiles, reflection,
  run, runPath, script, setRoles, state, subjects, useScript,
} from "./engine-helpers.ts";


const WT = (dir: string) => path.join(dir, ".mergewright", "worktrees", "DEMO-1");
const DISCARDED = (dir: string) => path.join(dir, ".mergewright", "local", "discarded");
/** The entries of .mergewright/local/discarded/ (worktrees moved aside), as absolute paths. */
const discarded = (dir: string) => (fs.existsSync(DISCARDED(dir)) ? fs.readdirSync(DISCARDED(dir)).sort().map((n) => path.join(DISCARDED(dir), n)) : []);
const CARD = "cards/DEMO-1.card.md";

/** Commit a tracked file in the main checkout, then give it an uncommitted edit (the owner's work). */
function ownerEdit(dir: string): void {
  write(dir, "notes.md", "committed\n");
  git(dir, "add", "notes.md");
  git(dir, "commit", "-qm", "notes");
  write(dir, "notes.md", "the owner's uncommitted edit\n");
}

/** Run with the heartbeat failing once `marker` exists (the worker started). */
async function loseLeaseWhen(dir: string, marker: string): Promise<Error> {
  process.env.MW_HEARTBEAT_MS = "50";
  const hub = fakeHub({ holder: "other-host", refresh: () => { if (fs.existsSync(marker)) throw new Error("the lease is held by other-host"); } });
  try {
    return await run(dir, {}, { hub }).then(() => new Error("the run did not stop"), (e: Error) => e);
  } finally {
    delete process.env.MW_HEARTBEAT_MS;
  }
}

// ── Destructive operations only ever touch a verified card worktree ────────────

test("a worker that deletes the worktree's .git file cannot make the lease clean-up reset the main checkout", async () => {
  const dir = project();
  const marker = path.join(dir, ".mergewright", "worker-started");
  setRoles(dir, { worker: { runs: "shell", command: `rm .git; mkdir -p src; echo partial > src/app.txt; touch '${marker}'; sleep 30; echo '{}'` } });
  git(dir, "commit", "-qam", "worker on the shell");
  useScript(script());
  ownerEdit(dir);
  const main = git(dir, "rev-parse", "main");
  const err = await loseLeaseWhen(dir, marker);
  assert.equal(read(dir, "notes.md"), "the owner's uncommitted edit\n", "the main checkout's edit survived");
  assert.equal(git(dir, "rev-parse", "main"), main);
  assert.match(err.message, /this machine lost the lease to other-host/);
  assert.match(err.message, /What the phase left in this machine's worktree was not touched/);
  assert.equal(read(WT(dir), "src/app.txt"), "partial\n", "nothing in the worktree was touched either");
  assert.deepEqual(discarded(dir), []);
});

test("a worktree path that is a symbolic link to the main checkout is moved aside (the link itself), and the work runs in a fresh worktree", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "implement" });
  git(dir, "worktree", "remove", "--force", WT(dir));
  fs.symlinkSync(dir, WT(dir));
  ownerEdit(dir);
  const main = git(dir, "rev-parse", "main");
  const s = await run(dir, { until: "gate" });
  assert.equal(s.status, "running", s.reason);
  const [aside, ...more] = discarded(dir);
  assert.deepEqual(more, []);
  assert.match(path.basename(aside!), /^DEMO-1-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  assert.ok(fs.lstatSync(aside!).isSymbolicLink(), "the link itself was moved");
  assert.equal(fs.readlinkSync(aside!), dir);
  assert.ok(s.warnings.some((w) => /moved to \.mergewright\/local\/discarded\/DEMO-1-/.test(w)), s.warnings.join("\n"));
  assert.equal(counters(dir).worker, 1);
  assert.equal(read(WT(dir), "src/app.txt"), "hello\n", "the worker ran in a real worktree");
  assert.ok(fs.lstatSync(WT(dir)).isDirectory());
  assert.equal(read(dir, "notes.md"), "the owner's uncommitted edit\n");
  assert.equal(fs.existsSync(path.join(dir, "src/app.txt")), false, "nothing was written into the main checkout");
  assert.equal(git(dir, "rev-parse", "main"), main, "nothing was committed on the base branch");
});

test("a directory at the worktree path with its own .git that git does not list is moved aside, never deleted", async () => {
  const dir = project();
  useScript(script());
  fs.mkdirSync(WT(dir), { recursive: true });
  git(WT(dir), "init", "-q");
  write(WT(dir), "precious.txt", "someone's work\n");
  const s = await run(dir, { until: "gate" });
  assert.equal(s.status, "running", s.reason);
  const [aside] = discarded(dir);
  assert.equal(read(aside!, "precious.txt"), "someone's work\n");
  assert.equal(fs.existsSync(path.join(WT(dir), "precious.txt")), false);
  assert.equal(git(WT(dir), "symbolic-ref", "--short", "HEAD"), "card/DEMO-1");
});

// ── Reflection never overwrites the owner's uncommitted memory edits ───────────

test("uncommitted memory edits block the reflection; afterwards only the runtime's files are committed", async () => {
  const dir = project();
  useScript(script());
  write(dir, "memory/STATE.md", "# State\n\nThe owner's own note.\n");
  const s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.deepEqual(phases(s).slice(-2), ["merge:ok", "reflect:block"]);
  assert.match(s.reason!, /memory\/ has uncommitted changes \(memory\/STATE\.md\); commit or discard them, then run 'mw run DEMO-1' again$/);
  assert.equal(read(dir, "memory/STATE.md"), "# State\n\nThe owner's own note.\n", "the edit was not overwritten");
  assert.equal(subjects(dir)[0], "DEMO-1: Card DEMO-1", "no memory commit");
  assert.equal(git(dir, "status", "--porcelain"), "M memory/STATE.md");

  git(dir, "commit", "-qam", "the owner's state");
  const t = await run(dir);
  assert.equal(t.status, "done", t.reason);
  assert.equal(subjects(dir)[0], "DEMO-1: update project memory");
  const files = git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").sort();
  assert.deepEqual(files, ["memory/INDEX.md", "memory/STATE.md", "memory/lessons/testing.md", "memory/outcomes/DEMO-1.md"]);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

// ── A flow without a worktree cannot have a writing role ─────────

test("a writing role in a flow without a worktree is blocked, pointing at mw check, whether or not the checkout is clean", async () => {
  const dir = project({ cardExtra: "flow: direct\n" });
  write(dir, "flows/direct.flow.yaml", "id: direct\ndescription: Work directly on the base branch.\nworktree: false\nphases:\n  - id: implement\n    role: worker\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "direct flow");
  useScript(script());
  const main = git(dir, "rev-parse", "main");
  for (const dirty of [false, true]) {
    if (dirty) ownerEdit(dir);
    const s = await run(dir);
    assert.equal(s.status, "blocked");
    assert.match(s.reason!, /^flow 'direct' has 'worktree: false', so its writing role 'worker' would work in the main checkout; that is not supported\. Run 'mw check' \(it reports flow\/write\)/);
    assert.equal(counters(dir).worker, undefined, "the worker never ran");
    assert.equal(fs.existsSync(path.join(dir, "src/app.txt")), false);
  }
  assert.equal(git(dir, "rev-parse", "main~1"), main, "only the owner's notes commit was added; nothing was committed by the runtime");
  assert.equal(read(dir, "notes.md"), "the owner's uncommitted edit\n");
  assert.equal(git(dir, "status", "--porcelain"), "M notes.md");
});

// ── `mw abort` does not destroy uncommitted work ──────────────────────────────────

test("abort commits uncommitted worktree work to the branch before removing the worktree", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "gate" });
  write(WT(dir), "src/wip.txt", "half done\n");
  write(WT(dir), "src/app.txt", "edited after the commit\n");
  const hub = fakeHub();
  const s = await abort(new Project(dir), "DEMO-1", {}, { hub, integrations: fakeIntegrations() });
  assert.equal(s.status, "aborted");
  assert.equal(fs.existsSync(WT(dir)), false);
  assert.equal(git(dir, "log", "-1", "--format=%s", "card/DEMO-1"), "DEMO-1: work in progress (abort)");
  assert.equal(git(dir, "show", "card/DEMO-1:src/wip.txt"), "half done");
  assert.equal(git(dir, "show", "card/DEMO-1:src/app.txt"), "edited after the commit");
  assert.ok(hub.names().includes("prepare"), "abort takes the lease first");
  assert.ok(hub.names().includes("pushBranch"));
});

test("abort refuses an unverifiable worktree and deletes nothing", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "gate" });
  fs.rmSync(path.join(WT(dir), ".git"));
  write(WT(dir), "src/wip.txt", "half done\n");
  await assert.rejects(abort(new Project(dir), "DEMO-1", {}, { hub: fakeHub(), integrations: fakeIntegrations() }), (e: MwError) => {
    assert.equal(e.code, "worktree/unsafe");
    assert.match(e.message, /Nothing was aborted/);
    return true;
  });
  assert.equal(read(WT(dir), "src/wip.txt"), "half done\n");
  assert.equal(state(dir).status, "running");
});

// ── Confinement, denylist, integrity ────────────────────────────────────────────

test("a changed hash-named artifact blocks the run; a changed plain copy is rewritten and changes nothing", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "gate" });
  const sha = state(dir).artifacts!.brief!;
  const hashed = runPath(dir, "artifacts", `brief-${sha}.json`);
  const original = fs.readFileSync(hashed, "utf8");
  assert.equal(fs.readFileSync(runPath(dir, "brief.json"), "utf8"), original, "the plain copy is the same content");
  const b = JSON.parse(original);
  // The plain copy is for people: editing it is undone, and the run uses what the runtime wrote.
  fs.writeFileSync(runPath(dir, "brief.json"), JSON.stringify({ ...b, scope: [] }, null, 2) + "\n");
  let s = await run(dir, { until: "review" });
  assert.equal(s.status, "running", s.reason);
  assert.equal(fs.readFileSync(runPath(dir, "brief.json"), "utf8"), original);
  // The hash-named file decides: changing it blocks.
  fs.writeFileSync(hashed, JSON.stringify({ ...b, scope: [] }, null, 2) + "\n");
  s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.match(s.reason!, new RegExp(`^run files were changed outside the runtime \\(artifacts/brief-${sha}\\.json\\)`));
  assert.equal(counters(dir).reviewer, undefined, "nothing ran on the changed files");
  assert.equal(git(dir, "log", "-1", "--format=%s", "main"), "setup");
  fs.rmSync(hashed);
  fs.writeFileSync(runPath(dir, "brief.json"), JSON.stringify({ ...b, scope: [] }, null, 2) + "\n");
  s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.match(s.reason!, /^run files were changed outside the runtime \(brief\.json\)/, "no hash-named file and a plain copy that does not match");
});

test("a run an older runtime wrote (plain artifact files only, a lock file in the run directory) continues", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "gate" });
  // The old layout: no hash-named files, and a lock file of a live process in the shared run directory.
  fs.rmSync(runPath(dir, "artifacts"), { recursive: true });
  fs.writeFileSync(runPath(dir, "lock"), JSON.stringify({ pid: process.ppid, host: "alpha", started: "earlier" }));
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.deepEqual(counters(dir), { planner: 1, worker: 1, reviewer: 1, reflector: 1 }, "nothing was redone");
  assert.ok(fs.existsSync(runPath(dir, "lock")), "the old lock file is left alone");
});

test("within a run, a worker rewriting brief.json changes nothing the runtime decides", async () => {
  const dir = project({ scope: ["src/**", "other/**"] }); // the card covers every path written (an empty scope or "**" fails lint): only the brief's scope bounds the work
  const forged = JSON.stringify(brief({ scope: [] }));
  useScript(script({
    worker: [
      { writes: { "src/app.txt": "hello\n", "other/x.txt": "stray\n", "../../runs/DEMO-1/brief.json": forged }, output: handoff() },
      { deletes: ["other"], output: handoff({ summary: "Reverted the stray file" }) },
    ],
  }));
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.deepEqual(phases(s).slice(0, 3), ["brief:ok", "implement:fail", "implement:ok"]);
  assert.match(s.history[1]!.detail, /other\/x\.txt \(outside the scope\)/);
  assert.equal(fs.existsSync(path.join(dir, "other/x.txt")), false);
});

test("write-mode agents are not told where the run directory is; read-mode ones are", async () => {
  const dir = project();
  setRoles(dir, {
    worker: { runs: "shell", command: `cat > /dev/null; mkdir -p src; printf '%s' "\${MW_RUN_DIR:-none}" > src/rundir.txt; printf '%s' '${JSON.stringify(handoff())}'` },
    reviewer: { runs: "shell", command: `cat > /dev/null; test -d "$MW_RUN_DIR" && printf '%s' '${JSON.stringify({ summary: "fine", findings: [] })}'` },
  });
  git(dir, "commit", "-qam", "shell roles");
  useScript(script());
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.equal(read(dir, "src/rundir.txt"), "none");
});

test("a write-mode claude role on a machine without the sandbox records one warning", { skip: claudeSandbox().ok ? "the sandbox works on this machine" : false }, async () => {
  const bin = tmpDir("mw-fakeclaude-");
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho 'claude: not really' >&2\nexit 3\n", { mode: 0o755 });
  const dir = project({ roles: { worker: { runs: "claude" } } });
  useScript(script());
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    const s = await run(dir);
    assert.equal(s.status, "blocked");
    const w = s.warnings.filter((x) => /without its shell sandbox/.test(x));
    assert.equal(w.length, 1, s.warnings.join("\n"));
    // Why it cannot run differs by machine (a missing tool here, a kernel restriction there):
    // the warning must carry this machine's own reason.
    assert.match(w[0]!, /write-mode role 'worker' without its shell sandbox .* because /);
    const state = claudeSandbox();
    assert.ok(!state.ok && w[0]!.includes(state.why), w[0]);
  } finally {
    process.env.PATH = old;
  }
});

// ── Scope ──────────────────────────────────────────────────────────────

test("moving a protected file into an allowed directory fails as a delete plus an add", async () => {
  const dir = project();
  const rules = read(dir, "memory/RULES.md");
  useScript(script({
    worker: [
      { deletes: ["memory/RULES.md"], writes: { "src/RULES.md": rules, "src/app.txt": "hello\n" }, output: handoff() },
      { deletes: ["src/RULES.md"], writes: { "memory/RULES.md": rules }, output: handoff({ summary: "Put the rules back" }) },
    ],
  }));
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.deepEqual(phases(s).slice(0, 3), ["brief:ok", "implement:fail", "implement:ok"]);
  assert.match(s.history[1]!.detail, /- memory\/RULES\.md \(/);
  assert.equal(read(dir, "memory/RULES.md"), rules);
  assert.equal(fs.existsSync(path.join(dir, "src/RULES.md")), false);
});

test("a worker editing its own card file fails the scope check", async () => {
  const dir = project();
  const original = read(dir, CARD);
  useScript(script({
    worker: [
      { writes: { "src/app.txt": "hello\n", [CARD]: original.replace('scope: ["src/**", "docs/**"]', 'scope: ["**"]') }, output: handoff() },
      { writes: { [CARD]: original }, output: handoff({ summary: "Left the card alone" }) },
    ],
  }));
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.deepEqual(phases(s).slice(0, 3), ["brief:ok", "implement:fail", "implement:ok"]);
  assert.match(s.history[1]!.detail, /cards\/DEMO-1\.card\.md \(outside the scope\)/);
  assert.equal(read(dir, CARD), original.replace("status: todo", "status: done"), "only the runtime's status edit reached the base");
});

// ── The merge commits only what was checked ────────────────────────────────────

test("a file left in the worktree after the checks fails the merge and is not merged", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  write(WT(dir), "other/late.txt", "appeared after the review\n");
  const s = await run(dir, { until: "reflect" });
  const m = s.history.find((h) => h.phase === "merge")!;
  assert.equal(m.outcome, "fail");
  assert.match(m.detail, /the worktree has changes that were never committed or checked: other\/late\.txt/);
  assert.equal(git(dir, "ls-tree", "-r", "--name-only", "main").split("\n").some((f) => f.startsWith("other/")), false, "the late file never reached the base");
});

test("a commit outside the scope added to the branch after the checks fails the merge", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  write(WT(dir), "other/late.txt", "committed behind the runtime's back\n");
  git(WT(dir), "add", "-A");
  git(WT(dir), "commit", "-qm", "sneaky");
  const before = git(dir, "rev-parse", "main");
  const s = await run(dir, { until: "reflect" });
  const m = s.history.find((h) => h.phase === "merge")!;
  assert.equal(m.outcome, "fail");
  assert.match(m.detail, /other\/late\.txt \(outside the scope\)/);
  assert.notEqual(s.merged, before);
  assert.throws(() => git(dir, "show", "main:other/late.txt"));
});

// ── The card branch is reconciled with the hub at every run start ──────────────

test("a resumed run asks the hub for the card branch before it uses the existing worktree", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "gate" });
  const hub = fakeHub();
  await run(dir, { until: "review" }, { hub });
  const names = hub.names();
  assert.deepEqual(hub.calls.filter((c) => c.name === "fetchBranch").map((c) => c.args[0]), ["card/DEMO-1"]);
  assert.ok(names.indexOf("fetchBranch") > names.indexOf("prepare") && names.indexOf("fetchBranch") < names.indexOf("refresh"), names.join(","));
});

// ── The run lock is exclusive ──────────────────────────────────────────────────

test("the run lock is exclusive, even within one process, and a dead holder's lock is taken over", async () => {
  const dir = tmpDir("mw-lock-");
  const file = path.join(dir, "locks", "DEMO-1.lock");
  const release = acquireLock(file, "DEMO-1");
  assert.throws(() => acquireLock(file, "DEMO-1"), /DEMO-1 is already being run by process \d+ on this machine/);
  release();
  assert.equal(fs.existsSync(file), false);
  for (const stale of [JSON.stringify({ pid: 999999999, host: (await import("../src/hub.ts")).hostName(), started: "x" }), "{torn"]) {
    fs.writeFileSync(file, stale);
    const r = acquireLock(file, "DEMO-1");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
    r();
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
  // The lock is this machine's own file: a live process holds it whatever host name it recorded.
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, host: "renamed-host", started: "x" }));
  assert.throws(() => acquireLock(file, "DEMO-1"), /already being run by process/);
});

test("the run lock lives in .mergewright/local/locks/; a lock file an older runtime left in the run directory is ignored and kept", async () => {
  const dir = project();
  useScript(script());
  fs.mkdirSync(runPath(dir), { recursive: true });
  // An old-layout lock of a live process (on the other machine, say): it no longer means anything.
  const old = JSON.stringify({ pid: process.ppid, host: "alpha", started: "earlier" });
  fs.writeFileSync(runPath(dir, "lock"), old);
  let during = "";
  const integ = { ...fakeIntegrations(), async notify() { during ||= fs.existsSync(lockPath(dir)) ? fs.readFileSync(lockPath(dir), "utf8") : "none"; } };
  const s = await run(dir, {}, { integrations: integ });
  assert.equal(s.status, "done", s.reason);
  assert.equal(JSON.parse(during).pid, process.pid, "the run held its lock under .mergewright/local/locks/");
  assert.equal(fs.existsSync(lockPath(dir)), false, "and released it");
  assert.equal(fs.readFileSync(runPath(dir, "lock"), "utf8"), old, "the old lock file is left as it was");
});

test("two runs of one card started at once: exactly one runs", async () => {
  const dir = project();
  useScript(script());
  const results = await Promise.allSettled([run(dir), run(dir)]);
  const done = results.filter((r) => r.status === "fulfilled");
  const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(done.length, 1);
  assert.equal(refused.length, 1);
  assert.match(String(refused[0]!.reason), /already being run/);
  assert.equal(subjects(dir).filter((x) => x === "DEMO-1: Card DEMO-1").length, 1);
  assert.equal(counters(dir).worker, 1);
});

// ── Merge clean-up is resumable ────────────────────────────────────────────────

test("a clean-up interrupted after the merge is finished on the next run", async () => {
  const dir = project();
  useScript(script());
  let deletes = 0;
  const base = fakeHub();
  const flaky: Hub = { ...base, async deleteBranch(b) { base.calls.push({ name: "deleteBranch", args: [b] }); if (++deletes === 1) throw new MwError("hub/unreachable", "the hub could not be reached"); } };
  await assert.rejects(run(dir, {}, { hub: flaky }), /the hub could not be reached/);
  const mid = state(dir);
  assert.ok(mid.merged);
  assert.equal(mid.cleanupPending, true);
  const s = await run(dir, {}, { hub: flaky });
  assert.equal(s.status, "done", s.reason);
  assert.equal(deletes, 2, "the hub branch deletion was retried");
  assert.equal(s.cleanupPending, undefined);
  assert.match(s.history.find((h) => h.phase === "merge")!.detail, /finished the clean-up after the merge/);
  assert.equal(subjects(dir).filter((x) => x === "DEMO-1: Card DEMO-1").length, 1);
});

// ── A forge merge is verified before clean-up ───────────────────

test("a forge merge commit that is not on the local base blocks the run and cleans up nothing", async () => {
  const dir = project();
  useScript(script());
  const ghost = "1234567890abcdef1234567890abcdef12345678";
  const integ: Integrations = { ...fakeIntegrations(), forgeMerge: async () => ghost };
  const hub = fakeHub();
  const s = await run(dir, {}, { hub, integrations: integ });
  assert.equal(s.status, "blocked");
  assert.match(s.reason!, /the forge reported the merge as 1234567890, but that commit is not on the local main after syncing with the hub/);
  assert.equal(s.merged, undefined);
  assert.ok(fs.existsSync(WT(dir)));
  assert.ok(branchExists(dir, "card/DEMO-1"));
  assert.ok(!hub.names().includes("deleteBranch"));
  assert.ok(hub.names().includes("sync"));
});

// ── Gates get a minimal environment; their logs are redacted in prompts ───────

test("a gate sees only the minimal environment plus gate.env, and a printed token is redacted from the remediation", async () => {
  const dir = project();
  write(dir, "mergewright.yaml", `${read(dir, "mergewright.yaml").trimEnd()}\ngate:\n  env: [MW_TEST_ALLOWED]\n`);
  const token = `ghp_${"A1b2C3d4E5".repeat(4)}`;
  write(dir, "gates/default.gate.sh", `#!/usr/bin/env bash
mkdir -p "$MERGEWRIGHT_GATE_LOGS"
env > "$MERGEWRIGHT_GATE_LOGS/env.txt"
log="$MERGEWRIGHT_GATE_LOGS/check.log"
if grep -q BROKEN src/app.txt; then echo "auth failed with ${token}" > "$log"; ok=false; code=1; else echo fine > "$log"; ok=true; code=0; fi
printf '{"ok":%s,"steps":[{"name":"check","ok":%s,"log":"%s"}]}' $ok $ok "$log" > "$MERGEWRIGHT_GATE_JSON"
exit $code
`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "gate");
  useScript(script({ worker: [{ writes: { "src/app.txt": "BROKEN\n" }, output: handoff() }, { writes: { "src/app.txt": "fixed\n" }, output: handoff() }] }));
  process.env.MW_TEST_SECRET_TOKEN = "integration-secret-value";
  process.env.MW_TEST_ALLOWED = "visible";
  try {
    const s = await run(dir);
    assert.equal(s.status, "done", s.reason);
    const env = fs.readFileSync(runPath(dir, "gate-logs", "env.txt"), "utf8");
    assert.doesNotMatch(env, /MW_TEST_SECRET_TOKEN|integration-secret-value/);
    assert.match(env, /^MW_TEST_ALLOWED=visible$/m);
    assert.match(env, /^MERGEWRIGHT_GATE_JSON=/m);
    assert.match(env, /^MERGEWRIGHT_BASE=main$/m);
    const second = promptFiles(dir, /implement-worker\.prompt\.md$/)[1]!;
    assert.match(second, /auth failed with \[redacted\]/);
    assert.doesNotMatch(second, new RegExp(token));
    assert.doesNotMatch(JSON.stringify(state(dir).history), new RegExp(token));
  } finally {
    delete process.env.MW_TEST_SECRET_TOKEN;
    delete process.env.MW_TEST_ALLOWED;
  }
});

// ── project.deepReviewOf ────────────────────────────────────────────────────────────────────

test("deep_review follows project.deepReviewOf: a card tagged with a deep-review subject gets the deep reviewer", async () => {
  const dir = project({ cardExtra: "tags: [auth]\n" });
  useScript(script());
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.deepEqual(s.history.find((h) => h.phase === "review")!.roles, ["reviewer", "reviewer-deep"]);
});

test("a critical card is reviewed by the routine reviewer, the deep reviewer and the red team, and stops for go and merge", async () => {
  const dir = project({ cardExtra: "risk: critical\n" });
  useScript(script());
  let s = await run(dir);
  assert.equal(s.status, "waiting");
  assert.equal(s.reason, "go");
  s = await run(dir, { approve: ["go", "merge"] });
  assert.equal(s.status, "done", s.reason);
  assert.deepEqual(s.history.find((h) => h.phase === "review")!.roles, ["reviewer", "reviewer-deep", "redteam"]);
  // High risk always passes through adjudication, even with no blocking finding.
  assert.equal(s.history.find((h) => h.phase === "adjudicate")!.outcome, "ok");
});

// ── Per-machine worktrees, leftovers, pruning ────────────────────────────

test("leftovers in this machine's worktree are moved aside, with the worktree, when the other machine moved the card on", async () => {
  const p = hubPair();
  useScript(script({
    worker: [
      { writes: { "src/app.txt": "BROKEN\n" }, output: handoff() },
      { writes: { "src/app.txt": "fixed\n" }, output: handoff({ summary: "Fixed the app file" }) },
    ],
  }));
  await as("alpha", at(0), () => runCardOn(p.a, { until: "gate" }));
  // An interrupted phase on a left edits behind.
  write(WT(p.a), "src/app.txt", "leftover\n");
  write(WT(p.a), "src/stray.txt", "untracked leftover\n");
  mirror(p.a, p.b);
  const onB = await as("beta", at(31), () => runCardOn(p.b, { until: "review" }));
  assert.deepEqual(phases(onB), ["brief:ok", "implement:ok", "gate:fail", "implement:ok", "gate:ok"], onB.reason);
  const c2 = git(p.hubDir, "rev-parse", "card/DEMO-1");
  mirror(p.b, p.a);
  const s = await as("alpha", at(62), () => runCardOn(p.a, { until: "merge" }));
  assert.equal(s.status, "running", s.reason);
  assert.equal(git(WT(p.a), "rev-parse", "HEAD"), c2, "fast-forwarded to the hub's branch");
  assert.equal(git(WT(p.a), "status", "--porcelain"), "");
  assert.equal(read(WT(p.a), "src/app.txt"), "fixed\n");
  const [aside, ...more] = discarded(p.a);
  assert.deepEqual(more, []);
  assert.equal(read(aside!, "src/app.txt"), "leftover\n", "the leftovers are kept on disk");
  assert.equal(read(aside!, "src/stray.txt"), "untracked leftover\n");
  assert.equal(fs.readdirSync(runPath(p.a)).filter((f) => /discarded/.test(f)).length, 0, "nothing is written to the shared run directory");
  assert.ok(s.warnings.some((w) => /moved to \.mergewright\/local\/discarded\/DEMO-1-/.test(w)), s.warnings.join("\n"));
});

test("decision C: pruneFinished removes a clean worktree and branch of a card finished elsewhere, and keeps a dirty one", async () => {
  const p = hubPair();
  useScript(script());
  await as("alpha", at(0), () => runCardOn(p.a, { until: "gate" }));
  mirror(p.a, p.b);
  const done = await as("beta", at(31), () => runCardOn(p.b));
  assert.equal(done.status, "done");
  mirror(p.b, p.a);
  await as("alpha", at(50), () => hubFor(new Project(p.a)).sync());
  write(WT(p.a), "src/mine.txt", "not committed\n");
  let r = pruneFinished(new Project(p.a));
  assert.deepEqual(r.removed, []);
  assert.match(r.kept[0]!, /DEMO-1 is done, but its worktree .* has uncommitted changes \(src\/mine\.txt\)/);
  assert.ok(fs.existsSync(WT(p.a)));
  fs.rmSync(path.join(WT(p.a), "src/mine.txt"));
  r = pruneFinished(new Project(p.a));
  assert.deepEqual(r, { removed: ["DEMO-1"], kept: [] });
  assert.equal(fs.existsSync(WT(p.a)), false);
  assert.equal(branchExists(p.a, "card/DEMO-1"), false);
  assert.equal(git(p.a, "worktree", "list").split("\n").length, 1);
  assert.equal(git(p.a, "status", "--porcelain"), "");
});

/** runCard with the project's real hub (two-machine tests). */
async function runCardOn(dir: string, opts: Parameters<typeof run>[1] = {}) {
  const { runCard } = await import("../src/engine/run.ts");
  return runCard(new Project(dir), "DEMO-1", opts);
}


// Found by the first real two-machine run: the merge removes the worktree, and the reflect phase
// then tried to start its agent in that deleted folder.
test("a role that runs after the merge starts in the main checkout, because the worktree is gone", async () => {
  const outside = tmpDir("mw-reflector-");
  const reply = path.join(outside, "reflection.json");
  fs.writeFileSync(reply, JSON.stringify(reflection()));
  const tool = path.join(outside, "reflector.sh");
  // A real process: it fails to start at all if its working directory does not exist.
  fs.writeFileSync(tool, `#!/bin/sh\npwd > "${outside}/cwd"\ncat "${reply}"\n`, { mode: 0o755 });
  const dir = project({ roles: { reflector: { runs: "shell", command: tool } } });
  useScript(script());
  const s = await run(dir);
  assert.equal(s.status, "done", JSON.stringify(s.history.at(-1)));
  assert.deepEqual(phases(s).filter((p) => p.startsWith("reflect")), ["reflect:ok"]);
  assert.equal(fs.readFileSync(path.join(outside, "cwd"), "utf8").trim(), fs.realpathSync(dir));
  assert.equal(fs.existsSync(path.join(dir, ".mergewright/worktrees/DEMO-1")), false);
});
