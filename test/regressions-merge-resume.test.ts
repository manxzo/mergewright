// Regression tests for resuming an interrupted merge, process identity and stale guards, process
// groups that survive, and runtime git's environment. Each test reproduces a trigger and asserts the
// state the runtime must leave. Newer symbols are reached through `added` or a dynamic import, so
// that a missing one fails its own test instead of the whole file.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import * as gitops from "../src/engine/gitops.ts";
import * as proc from "../src/engine/harness/proc.ts";
import * as registry from "../src/engine/registry.ts";
import { runCard } from "../src/engine/run.ts";
import * as stateModule from "../src/engine/state.ts";
import type { HarnessRequest, RunState } from "../src/engine/types.ts";
import { setCardStatus } from "../src/cards.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { Project } from "../src/project.ts";
import * as util from "../src/util.ts";
import { work } from "../src/work.ts";
import { git, mw, read, tmpDir, write } from "./helpers.ts";
import { branchExists, fakeHub, fakeIntegrations, lockPath, project, run, runPath, script, setRoles, state, useScript } from "./engine-helpers.ts";


const ID = "DEMO-1";
const WT = (dir: string) => path.join(dir, ".mergewright", "worktrees", ID);
const LOCKS = (dir: string, ...rel: string[]) => path.join(dir, ".mergewright", "local", "locks", ...rel);
const saveRunState = (dir: string, s: unknown) => fs.writeFileSync(runPath(dir, "state.json"), JSON.stringify(s, null, 2) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A newer symbol of a module, failing this test (not the whole file) when it is missing. */
function added<T>(mod: object, name: string): T | undefined {
  return (mod as Record<string, unknown>)[name] as T | undefined;
}

async function waitFor(what: string, f: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!f()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Field 22 of /proc/<pid>/stat, read here independently of the runtime. */
function startTime(pid: number): string {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 2).split(" ")[19]!;
}

function procState(pid: number): string | undefined {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return undefined;
  }
}

/** A live process of this machine in a process group of its own (a detached `sleep`). */
function sleeper(): { pid: number; stop: () => void } {
  const c = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  c.unref();
  return { pid: c.pid!, stop: () => { try { process.kill(c.pid!, "SIGKILL"); } catch { /* gone */ } } };
}

// ── A recorded pending merge is trusted only when it is the card's checked work ─────

test("a state file whose pendingMerge is the current base commit keeps the branch and blocks the run", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  const main = git(dir, "rev-parse", "main");
  const branch = git(dir, "rev-parse", `card/${ID}`);
  // A worker edits state.json: the merge phase, with "the merge" being the base commit itself.
  saveRunState(dir, { ...state(dir), pendingMerge: main });
  const hub = fakeHub();
  let s = await run(dir, {}, { hub });
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason!, /the recorded merge does not match the card's work/);
  assert.equal(s.merged, undefined, "nothing is recorded as merged");
  assert.ok(branchExists(dir, `card/${ID}`), "the card branch is kept");
  assert.equal(git(dir, "rev-parse", `card/${ID}`), branch);
  assert.ok(fs.existsSync(WT(dir)), "the worktree is kept");
  assert.equal(hub.names().includes("deleteBranch"), false, "nothing was deleted on the hub");
  assert.equal(git(dir, "rev-parse", "main"), main);

  // The same forgery naming the real branch head: the base commit's tree is not that work merged.
  saveRunState(dir, { ...state(dir), status: "running", reason: undefined, pendingMerge: main, pendingMergeHead: branch });
  s = await run(dir, {}, { hub });
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason!, /the recorded merge does not match the card's work: .*its content is not the card's work/);
  assert.ok(branchExists(dir, `card/${ID}`));
  assert.equal(hub.names().includes("deleteBranch"), false);
});

test("a real merge interrupted after the base moved still finishes on resume", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  // What the merge phase does up to the crash: mark done, record the squash and its head, move the base.
  setCardStatus(path.join(WT(dir), `cards/${ID}.card.md`), "done");
  git(WT(dir), "commit", "-qam", `${ID}: mark done`);
  const tip = git(dir, "rev-parse", `card/${ID}`);
  const built = gitops.buildSquash(dir, "main", tip, `${ID}: Card ${ID}\n`);
  assert.ok(built.ok, built.detail);
  saveRunState(dir, { ...state(dir), pendingMerge: built.commit, pendingMergeHead: tip });
  assert.ok(gitops.moveBase(dir, "main", built.commit!).ok);
  // The base moves on after the crash, too.
  write(dir, "README.extra.md", "later work on main\n");
  git(dir, "add", "README.extra.md");
  git(dir, "commit", "-qm", "later work on main");
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.equal(s.merged, built.commit);
  assert.equal(s.pendingMerge, undefined);
  assert.equal((s as RunState & { pendingMergeHead?: string }).pendingMergeHead, undefined);
  assert.equal(branchExists(dir, `card/${ID}`), false, "the clean-up ran");
});

test("the merge records the branch head it merged next to the pending merge (forge path)", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  let tip = "";
  let recorded: (RunState & { pendingMergeHead?: string }) | undefined;
  // The forge squashes the pushed branch onto main and reports its commit.
  const integrations = {
    ...fakeIntegrations(),
    async forgeMerge() {
      tip = git(dir, "rev-parse", `card/${ID}`);
      const built = gitops.buildSquash(dir, "main", tip, `${ID}: Card ${ID}\n`);
      assert.ok(built.ok && gitops.moveBase(dir, "main", built.commit!).ok);
      return built.commit;
    },
  };
  const base = fakeHub();
  // The sync after the forge's merge: the state holds the pending merge and the head it was made from.
  const hub = { ...base, async sync(o?: { offline?: boolean }) { recorded = state(dir); return base.sync(o); } };
  const s = await run(dir, {}, { hub, integrations });
  assert.equal(s.status, "done", s.reason);
  assert.ok(recorded?.pendingMerge, "the sync ran while the merge was pending");
  assert.equal(recorded.pendingMergeHead, tip);
  assert.equal(s.merged, recorded.pendingMerge);
});

test("--from does not accept a forged pendingMerge as the card's merge; the rewind goes ahead", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  const main = git(dir, "rev-parse", "main");
  saveRunState(dir, { ...state(dir), pendingMerge: main, pendingMergeHead: git(dir, "rev-parse", `card/${ID}`) });
  const s = await run(dir, { from: "implement", until: "gate" });
  assert.equal(s.merged, undefined, "the forged commit was not recorded as the merge");
  assert.equal(s.pendingMerge, undefined);
  assert.equal(s.status, "running", s.reason);
  assert.ok(s.warnings.some((w) => /the recorded merge [0-9a-f]{10} was set aside/.test(w)), s.warnings.join("\n"));
  assert.ok(branchExists(dir, `card/${ID}`));
});

// ── Process identity, and a guard that a live holder keeps fresh ─────────────

test("a lock whose pid is alive but whose process start time differs is stale and is taken over", async () => {
  const procid = (await import("../src/engine/procid.ts").catch(() => ({}))) as { processIdentity?: (pid: number) => { pid: number; started?: string } };
  const other = sleeper();
  try {
    const dir = tmpDir("mw-lock-");
    const file = path.join(dir, "locks", `${ID}.lock`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The process that wrote this lock died; the OS gave its pid to an unrelated, live process.
    fs.writeFileSync(file, JSON.stringify({ pid: other.pid, host: "here", started: "2026-10-01T00:00:00.000Z", procStart: "1" }));
    assert.equal(stateModule.lockHolder(file), undefined, "a reused pid is not the lock's holder");
    const release = stateModule.acquireLock(file, ID);
    const mine = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number; procStart?: string };
    assert.equal(mine.pid, process.pid);
    assert.equal(mine.procStart, startTime(process.pid), "a new lock carries this process's start time");
    release();
    // The same pid with its real start time is a live holder.
    fs.writeFileSync(file, JSON.stringify({ pid: other.pid, host: "here", started: "2026-10-01T00:00:00.000Z", procStart: startTime(other.pid) }));
    assert.throws(() => stateModule.acquireLock(file, ID), new RegExp(`already being run by process ${other.pid}`));
    // The one helper behind the lock, the guard and the orphans record.
    assert.ok(procid.processIdentity, "processIdentity exists");
    assert.deepEqual(procid.processIdentity(other.pid), { pid: other.pid, started: startTime(other.pid) });
  } finally {
    other.stop();
  }
});

test("a guard whose owner process is gone is reclaimed at once, without waiting for it to age", () => {
  const dir = tmpDir("mw-guard-");
  const locks = path.join(dir, "locks");
  const other = sleeper();
  const pid = other.pid;
  const identity = startTime(pid);
  other.stop();
  fs.mkdirSync(path.join(locks, ".guard"), { recursive: true });
  fs.writeFileSync(path.join(locks, ".guard", "owner"), JSON.stringify({ pid, started: identity, nonce: "left-behind" }));
  const t0 = Date.now();
  const release = stateModule.acquireLock(path.join(locks, `${ID}.lock`), ID);
  const took = Date.now() - t0;
  release();
  assert.ok(took < 5_000, `the guard of a dead owner was reclaimed in ${took} ms`);
});

test("a guard held across a slow lease release is kept fresh, so another process does not reclaim it", async () => {
  const dir = tmpDir("mw-guard-");
  const proj = { root: dir };
  const locks = registry.locksDir(proj);
  const timing = added<{ staleMs: number; refreshMs: number }>(registry, "guardTiming");
  const before = timing ? { ...timing } : undefined;
  if (timing) timing.refreshMs = 100;
  const ready = path.join(dir, "child-ready");
  const stateUrl = pathToFileURL(path.join(PACKAGE_ROOT, "src", "engine", "state.ts")).href;
  const code = `import fs from "node:fs"; import { acquireLock } from ${JSON.stringify(stateUrl)};
fs.writeFileSync(${JSON.stringify(ready)}, "");
try { const r = acquireLock(${JSON.stringify(path.join(locks, "DEMO-2.lock"))}, "DEMO-2"); console.log("ACQUIRED " + Date.now()); r(); } catch (e) { console.log("REFUSED " + e.message); }`;
  let child: Promise<string> | undefined;
  let releaseEnd = 0;
  try {
    const released = await registry.releaseUnlessBusy(proj, async () => {
      // The network call takes long. Here its guard is made to look 60 s old, as it would after a
      // minute of waiting without a refresh.
      const guard = path.join(locks, ".guard");
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(guard, old, old);
      await sleep(400); // a holder that refreshes has refreshed by now
      const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d: Buffer) => (out += d.toString()));
      c.stderr.on("data", (d: Buffer) => (out += d.toString()));
      child = new Promise((r) => c.on("close", () => r(out.trim())));
      await waitFor("the other process to start", () => fs.existsSync(ready));
      await sleep(1_000); // the other process tries for the guard meanwhile
      releaseEnd = Date.now();
    });
    assert.equal(released, true);
  } finally {
    if (timing && before) Object.assign(timing, before);
  }
  const out = await child!;
  const m = /^ACQUIRED (\d+)$/.exec(out);
  assert.ok(m, out);
  assert.ok(Number(m[1]) >= releaseEnd, `the other process took the guard only after the release finished (${Number(m[1]) - releaseEnd} ms)`);
});

// ── A process group that cannot be stopped is never ignored ────────────────────────

function sleepingWorker(dir: string): string {
  const pidFile = path.join(dir, ".mergewright", "agent.pid");
  setRoles(dir, { worker: { runs: "shell", command: `mkdir -p src; echo $$ > '${pidFile}'; sleep 30; echo '{}'` } });
  git(dir, "commit", "-qam", "worker on the shell");
  return pidFile;
}

test("the harness reports a process group that survived SIGTERM and SIGKILL", async () => {
  const hooks = added<{ reapGroup?: (pgid: number, ms: number) => Promise<boolean> }>(proc, "reapTestHooks") ?? {};
  const take = added<() => number[]>(proc, "takeSurvivors");
  const dir = tmpDir("mw-proc-");
  const ctl = new AbortController();
  const req = { role: { id: "worker" }, prompt: "", cwd: dir, mode: "write", outputKind: "text", limits: { minutes: 1 }, env: {}, runDir: dir, label: "t", signal: ctl.signal } as unknown as HarnessRequest;
  hooks.reapGroup = async () => false;
  try {
    const p = proc.runCli({ harness: "t", cmd: "sh", args: ["-c", "echo $$ > pid; sleep 30"], req, env: { PATH: process.env.PATH ?? "" } });
    await waitFor("the child", () => fs.existsSync(path.join(dir, "pid")) && read(dir, "pid").trim() !== "");
    const pid = Number(read(dir, "pid"));
    ctl.abort();
    const r = await p;
    assert.equal((r as { survivor?: number }).survivor, pid, "the surviving group is in the result");
    assert.match(proc.failedRun("t", r)?.error ?? "", new RegExp(`process group ${pid} is still running`));
    assert.deepEqual(take?.(), [pid], "and recorded for the engine");
  } finally {
    delete hooks.reapGroup;
  }
});

test("a surviving group ends 'mw run' with an error naming it and an orphans record; the card then refuses to start while it lives", async () => {
  const hooks = added<{ reapGroup?: (pgid: number, ms: number) => Promise<boolean> }>(proc, "reapTestHooks") ?? {};
  const dir = project();
  const pidFile = sleepingWorker(dir);
  useScript(script());
  const ctl = new AbortController();
  const prevBudget = process.env.MW_REAP_MS;
  process.env.MW_REAP_MS = "300";
  hooks.reapGroup = async () => false; // as if the group were stuck where no signal reaches it
  let agent = 0;
  let err: unknown;
  try {
    const p = runCard(new Project(dir), ID, {}, { hub: fakeHub(), integrations: fakeIntegrations(), stop: ctl.signal });
    await waitFor("the worker to start", () => fs.existsSync(pidFile) && read(dir, ".mergewright/agent.pid").trim() !== "");
    agent = Number(read(dir, ".mergewright/agent.pid"));
    ctl.abort();
    await p.catch((e: unknown) => { err = e; });
  } finally {
    delete hooks.reapGroup;
    if (prevBudget === undefined) delete process.env.MW_REAP_MS; else process.env.MW_REAP_MS = prevBudget;
    if (agent) try { process.kill(-agent, "SIGKILL"); } catch { /* gone */ }
  }
  assert.ok(err instanceof util.MwError, `the run failed with an error, not a clean stop: ${String(err)}`);
  assert.equal(err.code, "run/orphans");
  assert.match(err.message, new RegExp(`process group ${agent}\\b.*is still running after SIGTERM, SIGKILL`));
  assert.match(err.message, /DEMO-1\.orphans/);
  const file = LOCKS(dir, `${ID}.orphans`);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as { groups: { pgid: number; members: { pid: number; started?: string }[] }[] };
  assert.equal(record.groups[0]!.pgid, agent);
  assert.equal(fs.existsSync(lockPath(dir)), false, "the run lock was released");

  // The record now names a group that is alive: the card refuses to start, and nothing of the run changes.
  const stuck = sleeper();
  try {
    record.groups = [{ pgid: stuck.pid, members: [{ pid: stuck.pid, started: startTime(stuck.pid) }] }];
    fs.writeFileSync(file, JSON.stringify(record));
    const before = read(runPath(dir), "state.json");
    await assert.rejects(run(dir), new RegExp(`DEMO-1 was not started: process group ${stuck.pid} .*left running by an earlier run of this card`));
    assert.equal(read(runPath(dir), "state.json"), before);
  } finally {
    stuck.stop();
  }
  await waitFor("the stuck group to end", () => procState(stuck.pid) === undefined || procState(stuck.pid) === "Z");
  // Once the group is gone the card runs again, and the record is removed.
  useScript(script());
  setRoles(dir, {});
  git(dir, "commit", "-qam", "worker back on mock");
  const s = await run(dir, { until: "gate" });
  assert.equal(s.status, "running", s.reason);
  assert.equal(fs.existsSync(file), false, "the orphans record was removed");
});

test("'mw work' stops taking cards and ends with the error when a group survives", async () => {
  const hooks = added<{ reapGroup?: (pgid: number, ms: number) => Promise<boolean> }>(proc, "reapTestHooks") ?? {};
  const dir = project();
  const pidFile = sleepingWorker(dir);
  write(dir, `cards/${ID}.card.md`, read(dir, `cards/${ID}.card.md`).replace("status: todo", "status: ready"));
  git(dir, "commit", "-qam", "ready");
  useScript(script());
  const now = new AbortController();
  const prevBudget = process.env.MW_REAP_MS;
  process.env.MW_REAP_MS = "300";
  hooks.reapGroup = async () => false;
  const lines: string[] = [];
  let agent = 0;
  try {
    const p = work(dir, { out: (l) => lines.push(l), stopNow: now.signal, hub: () => fakeHub(), integrations: () => fakeIntegrations() });
    await waitFor("the worker to start", () => fs.existsSync(pidFile) && read(dir, ".mergewright/agent.pid").trim() !== "");
    agent = Number(read(dir, ".mergewright/agent.pid"));
    now.abort();
    await assert.rejects(p, new RegExp(`process group ${agent}\\b.*still running`));
  } finally {
    delete hooks.reapGroup;
    if (prevBudget === undefined) delete process.env.MW_REAP_MS; else process.env.MW_REAP_MS = prevBudget;
    if (agent) try { process.kill(-agent, "SIGKILL"); } catch { /* gone */ }
  }
  assert.ok(fs.existsSync(LOCKS(dir, `${ID}.orphans`)));
});

test("a zombie does not count as a live member of its process group", async () => {
  const dir = tmpDir("mw-zombie-");
  // The shell starts a child in a group of its own, then becomes 'sleep', which never reaps it.
  const parent = spawn("sh", ["-c", `setsid sleep 0.2 & echo $! > '${path.join(dir, "z")}'; exec sleep 30`], { stdio: "ignore" });
  try {
    await waitFor("the child's pid", () => fs.existsSync(path.join(dir, "z")) && read(dir, "z").trim() !== "");
    const z = Number(read(dir, "z"));
    await waitFor("the child to become a zombie", () => procState(z) === "Z");
    assert.equal(proc.groupAlive(z), false, "a group of only a zombie is not alive");
    const t0 = Date.now();
    assert.equal(await proc.reapGroup(z, 200), true, "and reaping it succeeds at once");
    assert.ok(Date.now() - t0 < 1_000);
  } finally {
    parent.kill("SIGKILL");
  }
  const procid = (await import("../src/engine/procid.ts").catch(() => ({}))) as { parseStat?: (t: string) => { pid: number; state: string; pgrp: number; started: string } | undefined };
  assert.ok(procid.parseStat, "parseStat exists");
  const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
  fields[0] = "Z";
  fields[2] = "77";
  fields[19] = "123456";
  assert.deepEqual(procid.parseStat(`42 (odd) name (x)) ${fields.join(" ")}`), { pid: 42, state: "Z", pgrp: 77, started: "123456" });
});

// ── Runtime git gets a minimal environment ──────────────────────────────────────

test("git started by the runtime does not see the runtime's other variables; PATH, HOME, GIT_* and SSH_AUTH_SOCK reach it", () => {
  const keep = { DATABASE_URL: process.env.DATABASE_URL, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, GIT_MW_PROBE: process.env.GIT_MW_PROBE, AWS_SESSION_CREDENTIALS: process.env.AWS_SESSION_CREDENTIALS };
  process.env.DATABASE_URL = "postgres://user:pw@db/app";
  process.env.AWS_SESSION_CREDENTIALS = "session";
  process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
  process.env.GIT_MW_PROBE = "probe";
  try {
    const env = util.gitEnv();
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.AWS_SESSION_CREDENTIALS, undefined);
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.SSH_AUTH_SOCK, "/tmp/agent.sock");
    assert.equal(env.GIT_MW_PROBE, "probe");
    // What a command git runs (an alias here, a worker's core.sshCommand in the review) actually sees.
    const dir = tmpDir("mw-gitenv-");
    git(dir, "init", "-q");
    const r = util.sh("git", ["-c", "alias.envdump=!env", "envdump"], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /^DATABASE_URL=/m);
    assert.doesNotMatch(r.stdout, /^AWS_SESSION_CREDENTIALS=/m);
    assert.match(r.stdout, /^GIT_MW_PROBE=probe$/m);
    // A variable a caller passes on purpose does reach git.
    const r2 = util.sh("git", ["-c", "alias.envdump=!env", "envdump"], { cwd: dir, env: { MW_EXPLICIT: "yes" } });
    assert.match(r2.stdout, /^MW_EXPLICIT=yes$/m);
  } finally {
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// ── Doc 1: a flow without a worktree also needs the merge evidence ──────────────────────────

const DIRECT = "id: direct\ndescription: Checked and reviewed on the base branch.\nworktree: false\nphases:\n  - id: gate\n    gate: default\n  - id: review\n    role: reviewer\n  - id: merge\n    action: merge\n";

test("in a flow with 'worktree: false', a state edited to skip the gate and the review does not mark the card done", async () => {
  const dir = project({ cardExtra: "flow: direct\n" });
  write(dir, "flows/direct.flow.yaml", DIRECT);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "direct flow");
  useScript(script());
  await run(dir, { until: "gate" });
  const main = git(dir, "rev-parse", "main");
  saveRunState(dir, { ...state(dir), phase: 2 }); // direct flow: 2 = merge
  const s = await run(dir);
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason!, /was not merged: .*no gate result is recorded, and no review is recorded/);
  assert.equal(s.merged, undefined);
  assert.equal(git(dir, "rev-parse", "main"), main, "nothing was committed");
  assert.match(read(dir, `cards/${ID}.card.md`), /status: todo/);

  // Run properly from the start, the same flow marks the card done.
  const other = project({ cardExtra: "flow: direct\n" });
  write(other, "flows/direct.flow.yaml", DIRECT);
  git(other, "add", "-A");
  git(other, "commit", "-qm", "direct flow");
  const ok = await run(other);
  assert.equal(ok.status, "done", ok.reason);
  assert.match(git(other, "show", `main:cards/${ID}.card.md`), /status: done/);
});

// ── Doc 3: only 'mw sync' takes --offline ───────────────────────────────────────────────────

test("run, work, approve, retry and abort reject --offline with a usage error naming 'mw sync --offline', even without a hub", () => {
  const dir = project();
  const env = { MW_MOCK_SCRIPT: useScript(script()) };
  for (const args of [["run", ID, "--offline"], ["work", "--offline"], ["approve", ID, "go", "--offline"], ["retry", ID, "--offline"], ["abort", ID, "--offline"]]) {
    const r = mw(dir, args, env);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}${r.err}`);
    assert.match(r.err, new RegExp(`'mw ${args[0]}' does not take --offline: only 'mw sync --offline' works without the hub`), args.join(" "));
  }
  assert.equal(fs.existsSync(runPath(dir)), false, "nothing ran");
  assert.equal(mw(dir, ["sync", "--offline"], env).code, 0, "mw sync --offline still works");
});
