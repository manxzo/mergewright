// Two real machines end to end: the real hub (src/hub.ts) and the real engine, with a bare repository
// as the hub and two clones standing in for the laptop (a) and the server (b). Hosts are simulated
// with MW_HOST, lease ages with MW_NOW, and file sync by copying files between the clones (never .git).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCard } from "../src/engine/run.ts";
import { hubFor, LEASE_REF, openHub } from "../src/hub.ts";
import { Project } from "../src/project.ts";
import { git, MW, read, write } from "./helpers.ts";
import { as, at, branchExists, counters, handoff, hubPair, mirror, phases, runPath, script, setRoles, state, subjects, useScript } from "./engine-helpers.ts";


const ID = "DEMO-1";
const FULL = ["brief:ok", "implement:ok", "gate:ok", "review:ok", "adjudicate:skipped", "merge:ok", "reflect:ok", "docs:ok"];
const wtOf = (dir: string) => path.join(dir, ".mergewright", "worktrees", ID);
const hubRef = (hubDir: string, ref: string) => {
  try {
    return git(hubDir, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
};
const leaseHost = async (dir: string) => (await openHub(new Project(dir)).observe()).lease?.host;
const run = (dir: string, opts: Parameters<typeof runCard>[2] = {}) => runCard(new Project(dir), ID, opts);

/** Every file under `dir` (without .git) with its content, plus the repository's refs and worktrees. */
function snapshot(dir: string): string {
  const files: string[] = [];
  const visit = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      if (e.name === ".git") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) visit(full);
      else files.push(`${path.relative(dir, full)}\n${fs.readFileSync(full, "utf8")}`);
    }
  };
  visit(dir);
  // refs/mergewright/ only caches the last lease commit read from the hub; lease-seen.json is this
  // machine's own record of when it first saw that lease (the hub's clock-skew rule).
  files.splice(0, files.length, ...files.filter((f) => !f.startsWith(path.join(".mergewright", "local", "lease-seen.json"))));
  const refs = git(dir, "for-each-ref").split("\n").filter((l) => !l.includes("refs/mergewright/")).join("\n");
  return [refs, git(dir, "worktree", "list", "--porcelain"), git(dir, "status", "--porcelain"), ...files].join("\n--\n");
}

/** The entries of two snapshots that differ (first line of each), for a readable failure. */
function changed(before: string, after: string): string[] {
  const a = new Set(before.split("\n--\n"));
  const b = new Set(after.split("\n--\n"));
  return [...[...a].filter((x) => !b.has(x)).map((x) => `- ${x.split("\n")[0]}`), ...[...b].filter((x) => !a.has(x)).map((x) => `+ ${x.split("\n")[0]}`)];
}

test("a card started on a and stopped part-way is finished on b after a's lease went stale; a then syncs clean", async () => {
  const p = hubPair();
  useScript(script());
  const first = await as("alpha", at(0), () => run(p.a, { until: "gate" }));
  assert.equal(first.status, "running");
  assert.deepEqual(phases(first), ["brief:ok", "implement:ok"]);
  const worked = git(p.a, "rev-parse", `card/${ID}`);
  assert.equal(hubRef(p.hubDir, `card/${ID}`), worked, "a pushed the card branch after the worker's commit");
  assert.equal(git(p.hubDir, "show", `card/${ID}:src/app.txt`), "hello");
  assert.equal(await leaseHost(p.a), "alpha");
  const baseBefore = hubRef(p.hubDir, "main");

  mirror(p.a, p.b); // file sync delivers the run state (worktrees are per machine)
  // a's lease is older than three lease times by its own timestamp, so b may take it over.
  const done = await as("beta", at(31), () => run(p.b));
  assert.equal(done.status, "done");
  assert.deepEqual(phases(done), FULL);
  assert.deepEqual(counters(p.b), { planner: 1, worker: 1, reviewer: 1, reflector: 1 }, "b did not redo a's phases");
  assert.equal(done.host, "beta");
  assert.equal(await leaseHost(p.b), "beta");

  // The hub: base at b's memory commit on top of the squash commit, card branch gone.
  const hubMain = hubRef(p.hubDir, "main");
  assert.equal(hubMain, git(p.b, "rev-parse", "main"));
  assert.equal(hubRef(p.hubDir, "main^"), done.merged);
  assert.equal(hubRef(p.hubDir, "main~2"), baseBefore, "one squash commit and one memory commit");
  assert.deepEqual(subjects(p.hubDir).slice(0, 2), [`${ID}: update project memory`, `${ID}: Card ${ID}`]);
  assert.equal(git(p.hubDir, "show", "main:src/app.txt"), "hello");
  assert.match(git(p.hubDir, "show", `main:cards/${ID}.card.md`), /status: done/);
  assert.equal(hubRef(p.hubDir, `card/${ID}`), "");
  assert.equal(branchExists(p.b, `card/${ID}`), false);
  assert.equal(fs.existsSync(wtOf(p.b)), false);
  assert.equal(git(p.b, "status", "--porcelain"), "");

  // a: file sync brings the files, sync adopts the history, and a ends clean with the card done.
  mirror(p.b, p.a);
  const synced = await as("alpha", at(50), () => hubFor(new Project(p.a)).sync());
  assert.equal(synced.action, "adopted");
  assert.equal(git(p.a, "rev-parse", "main"), hubMain);
  assert.equal(git(p.a, "status", "--porcelain"), "");
  assert.match(read(p.a, `cards/${ID}.card.md`), /status: done/);
  assert.equal(read(p.a, "src/app.txt"), "hello\n");
  assert.match(read(p.a, "memory/STATE.md"), /DEMO-1 is finished/);
  assert.equal(state(p.a).status, "done");
  const again = await as("alpha", at(51), () => run(p.a));
  assert.equal(again.status, "done");
  assert.equal(git(p.a, "rev-parse", "main"), hubMain, "running a done card again changes nothing");
});

test("while a holds a fresh lease, b's run is refused naming a, and nothing on b or the hub changes", async () => {
  const p = hubPair();
  useScript(script());
  await as("alpha", at(0), () => run(p.a, { until: "gate" }));
  // A lock file an older runtime kept in the run directory arrives on b with the rest of it.
  fs.writeFileSync(runPath(p.a, "lock"), JSON.stringify({ pid: process.ppid, host: "alpha", started: at(0) }));
  mirror(p.a, p.b);
  const before = snapshot(p.b);
  const hubBefore = git(p.hubDir, "for-each-ref");
  await assert.rejects(as("beta", at(4), () => run(p.b)), (e: Error) => {
    assert.match(e.message, /alpha \(pid \d+\) holds the lease on hub 'hub', taken or refreshed 4 min ago/);
    return true;
  });
  assert.deepEqual(changed(before, snapshot(p.b)), [], "b's files, refs and worktrees are unchanged (including the old lock file)");
  assert.equal(git(p.hubDir, "for-each-ref"), hubBefore);
  assert.equal(await leaseHost(p.b), "alpha");
  assert.equal(state(p.b).host, "alpha");
});

test("a resumes after b took the lease over: a's phase is discarded and a stops, having committed, pushed and saved nothing", async () => {
  const p = hubPair();
  // While a's worker runs, b (whose clock says a's lease is stale) takes the lease over.
  const env = `MW_HOST=beta MW_NOW=${at(31)} MW_ENV_FILE=/dev/null`;
  const takeover = path.join(p.a, ".mergewright", "takeover.sh");
  // The worker first keeps a copy of the run state as the phase started (the test's reference).
  const atStart = path.join(p.a, ".mergewright", "state-at-start.json");
  setRoles(p.a, { worker: { runs: "shell", command: `cp '${runPath(p.a, "state.json")}' '${atStart}'; mkdir -p src; echo partial > src/app.txt; sh '${takeover}'; sleep 30; echo '{}'` } });
  git(p.a, "commit", "-qam", "worker on the shell");
  git(p.a, "push", "-q", "hub", "main");
  useScript(script());
  write(p.a, ".mergewright/takeover.sh", `cd '${p.b}' && ${env} '${process.execPath}' '${MW}' lease take > /dev/null 2>&1\n`);
  const baseBefore = hubRef(p.hubDir, "main");
  process.env.MW_HEARTBEAT_MS = "200";
  try {
    await assert.rejects(as("alpha", at(0), () => run(p.a)), /this machine lost the lease to beta/);
  } finally {
    delete process.env.MW_HEARTBEAT_MS;
  }
  const saved = fs.readFileSync(atStart, "utf8");
  assert.equal(await leaseHost(p.a), "beta");
  assert.equal(git(p.a, "rev-parse", `card/${ID}`), git(p.a, "rev-parse", "main"), "no commit on a's card branch");
  assert.equal(read(wtOf(p.a), "src/app.txt"), "partial\n", "the phase's leftovers in a's worktree were not touched");
  assert.equal(hubRef(p.hubDir, `card/${ID}`), "", "the card branch was never pushed");
  assert.equal(hubRef(p.hubDir, "main"), baseBefore, "the base was not pushed");
  assert.equal(git(p.a, "rev-parse", "main"), baseBefore);
  assert.ok(saved, "the worker started");
  assert.equal(fs.readFileSync(runPath(p.a, "state.json"), "utf8"), saved, "a saved nothing after losing the lease");
  assert.deepEqual(phases(state(p.a)), ["brief:ok"]);

  // Running again on a, while b's lease is fresh, is refused and leaves the state alone.
  await assert.rejects(as("alpha", at(1), () => run(p.a)), /beta \(pid \d+\) holds the lease/);
  assert.equal(fs.readFileSync(runPath(p.a, "state.json"), "utf8"), saved);
});

test("b replaces a synced copy of the worktree (no .git) with a real worktree of the hub's card branch", async () => {
  const p = hubPair();
  useScript(script());
  await as("alpha", at(0), () => run(p.a, { until: "gate" }));
  mirror(p.a, p.b, { worktrees: true }); // as the file-sync tool did before worktrees were excluded from it
  assert.ok(fs.existsSync(path.join(wtOf(p.b), "src/app.txt")), "the copy arrived");
  assert.equal(fs.existsSync(path.join(wtOf(p.b), ".git")), false, "without .git");
  assert.equal(git(p.b, "worktree", "list").split("\n").length, 1);
  assert.equal(branchExists(p.b, `card/${ID}`), false);

  const s = await as("beta", at(31), () => run(p.b, { until: "review" }));
  assert.equal(s.status, "running");
  assert.deepEqual(phases(s), ["brief:ok", "implement:ok", "gate:ok"]);
  assert.equal(s.worktree, wtOf(p.b));
  const listed = git(p.b, "worktree", "list", "--porcelain");
  assert.ok(listed.includes(`worktree ${fs.realpathSync(wtOf(p.b))}`) || listed.includes(`worktree ${wtOf(p.b)}`), listed);
  assert.match(listed, new RegExp(`branch refs/heads/card/${ID}`));
  assert.ok(fs.statSync(path.join(wtOf(p.b), ".git")).isFile());
  assert.equal(git(wtOf(p.b), "rev-parse", "HEAD"), git(p.a, "rev-parse", `card/${ID}`));
  assert.equal(git(wtOf(p.b), "status", "--porcelain"), "");
  assert.equal(read(wtOf(p.b), "src/app.txt"), "hello\n");
  assert.deepEqual(counters(p.b), { planner: 1, worker: 1 }, "only the gate ran on b");
  assert.ok(fs.existsSync(runPath(p.b, "gate.json")));
});

test("ping-pong: a starts, b remediates and pushes, a finishes from the hub's newer branch over its stale one", async () => {
  const p = hubPair();
  useScript(script({
    worker: [
      { writes: { "src/app.txt": "BROKEN\n" }, output: handoff() },
      { writes: { "src/app.txt": "fixed\n" }, output: handoff({ summary: "Fixed the app file" }) },
    ],
  }));
  await as("alpha", at(0), () => run(p.a, { until: "gate" }));
  const c1 = git(p.a, "rev-parse", `card/${ID}`);

  mirror(p.a, p.b);
  const onB = await as("beta", at(31), () => run(p.b, { until: "review" }));
  assert.deepEqual(phases(onB), ["brief:ok", "implement:ok", "gate:fail", "implement:ok", "gate:ok"]);
  const c2 = hubRef(p.hubDir, `card/${ID}`);
  assert.notEqual(c2, c1);
  assert.equal(git(p.hubDir, "rev-parse", `${c2}^`), c1);

  // a's own branch and worktree are still at c1 (worktrees are not synced); the run fast-forwards them.
  mirror(p.b, p.a);
  assert.equal(git(p.a, "rev-parse", `card/${ID}`), c1);
  const done = await as("alpha", at(62), () => run(p.a));
  assert.equal(done.status, "done", done.reason);
  assert.deepEqual(phases(done).slice(5), ["review:ok", "adjudicate:skipped", "merge:ok", "reflect:ok", "docs:ok"]);
  assert.equal(counters(p.a).worker, 2, "nothing was redone");
  assert.equal(git(p.hubDir, "show", "main:src/app.txt"), "fixed");
  assert.equal(hubRef(p.hubDir, "main"), git(p.a, "rev-parse", "main"));
  assert.equal(hubRef(p.hubDir, "main^"), done.merged);
  assert.equal(hubRef(p.hubDir, `card/${ID}`), "");
  assert.equal(git(p.a, "status", "--porcelain"), "");
});

test("a full card on one machine with the hub: base on the hub ends at the squash and memory commits, card branch deleted", async () => {
  const p = hubPair();
  useScript(script());
  const baseBefore = hubRef(p.hubDir, "main");
  const s = await as("alpha", at(0), () => run(p.a));
  assert.equal(s.status, "done");
  assert.deepEqual(phases(s), FULL);
  const hubMain = hubRef(p.hubDir, "main");
  assert.equal(hubMain, git(p.a, "rev-parse", "main"));
  assert.equal(git(p.hubDir, "log", "-1", "--format=%s", "main"), `${ID}: update project memory`);
  assert.equal(hubRef(p.hubDir, "main^"), s.merged, "the squash commit sits under the memory commit");
  assert.equal(hubRef(p.hubDir, "main~2"), baseBefore);
  assert.equal(git(p.hubDir, "rev-list", "--parents", "-n", "1", s.merged!).split(" ").length, 2, "a squash, not a merge");
  assert.match(git(p.hubDir, "show", "main:memory/STATE.md"), /DEMO-1 is finished/);
  assert.match(git(p.hubDir, "show", "main:memory/lessons/testing.md"), /Keep tests hermetic/);
  assert.equal(hubRef(p.hubDir, `card/${ID}`), "");
  assert.equal(git(p.hubDir, "for-each-ref", "--format=%(refname)", "refs/heads/"), "refs/heads/main");
  assert.ok(hubRef(p.hubDir, LEASE_REF), "the run leaves the lease to whoever releases it");
  assert.equal(git(p.a, "status", "--porcelain"), "");
});
