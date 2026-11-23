// Regression tests for the repository lock of the committing MCP tools, the Hermes lock takeover,
// literal git paths and the Codex home sweep. Each test reproduces a trigger and asserts the state
// the runtime must leave. Newer symbols are reached through `added`, so that a missing one fails its
// own test instead of the whole file.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { openHub } from "../src/hub.ts";
import * as repo from "../src/mcpserver/repo.ts";
import { callTool, TOOLS } from "../src/mcpserver/server.ts";
import type { ToolContext } from "../src/mcpserver/tool.ts";
import { sweepCodexHomes } from "../src/engine/run.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { Project } from "../src/project.ts";
import { as, hubPair } from "./engine-helpers.ts";
import { card, git, hermesPackage, hermesTools, newProject, read, tmpDir, write } from "./helpers.ts";

/** The hermes package's module (configLock, testHooks). */
const hermes = await hermesPackage();

const src = (rel: string) => JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT, "src", rel)).href);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A newer symbol of a module, failing this test (not the whole file) when it is missing. */
function added<T>(mod: object, name: string): T | undefined {
  return (mod as Record<string, unknown>)[name] as T | undefined;
}

function ctxFor(dir: string): ToolContext {
  return { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined };
}

async function call(dir: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, name);
  const r = await callTool(tool, args, ctxFor(dir));
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
}

/** A node process running module `code`; `done` resolves with what it printed. */
function child(code: string): { proc: ChildProcess; done: Promise<string> } {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  proc.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  return { proc, done: new Promise((r) => proc.on("close", () => r(out.trim()))) };
}

async function waitFor(file: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await sleep(20);
  }
}

const subjects = (dir: string, rev = "HEAD", n = 2) => git(dir, "log", `-${n}`, "--format=%s", rev).split("\n");

test("committing MCP tools hold the cross-process repository lock; on a hub they take the lease, adopt, push fenced and release, and refuse while another machine holds it", async () => {
  // (a) Another process holds the repository lock while it writes and commits: the tool waits for it.
  const dir = newProject();
  const scratch = tmpDir("mw-r7-");
  const ready = path.join(scratch, "ready");
  const other = child(`import fs from "node:fs";
const repo = await import(${src("mcpserver/repo.ts")});
const { Project } = await import(${src("project.ts")});
const p = new Project(${JSON.stringify(dir)});
const lock = repo.withRepoLock ?? ((_p, f) => f());
await lock(p, async () => {
  fs.mkdirSync(${JSON.stringify(path.join(dir, "notes"))}, { recursive: true });
  fs.writeFileSync(${JSON.stringify(path.join(dir, "notes", "other.txt"))}, "other\\n");
  fs.writeFileSync(${JSON.stringify(ready)}, "");
  await new Promise((r) => setTimeout(r, 1000));
  console.log(repo.commitAlone(p, ["notes/other.txt"], "other: first"));
});`);
  try {
    await waitFor(ready);
    const t0 = Date.now();
    const r = await call(dir, "mw_card_new", { title: "second", kind: "chore" });
    const waited = Date.now() - t0;
    assert.equal(r.isError, false, r.text);
    assert.match(await other.done, /committed notes\/other\.txt/);
    assert.deepEqual(subjects(dir), ["card: DEMO-1 second", "other: first"], "the tool's commit comes after the other process's, not in between");
    assert.ok(waited >= 500, `the tool waited for the other process (${waited} ms)`);
    assert.equal(fs.existsSync(path.join(dir, ".mergewright", "local", "locks", "repo.lock")), false, "the repository lock is released");
  } finally {
    other.proc.kill();
  }

  // (b) Two checkouts of one hub: different ids, both commits on the hub; the lease is respected.
  const p = hubPair();
  const first = await as("alpha", undefined, () => call(p.a, "mw_card_new", { title: "from a", kind: "chore" }));
  assert.equal(first.isError, false, first.text);
  assert.match(first.text, /cards\/DEMO-2\.card\.md/);
  assert.match(first.text, /on the hub/);
  const second = await as("beta", undefined, () => call(p.b, "mw_card_new", { title: "from b", kind: "chore" }));
  assert.equal(second.isError, false, second.text);
  assert.match(second.text, /cards\/DEMO-3\.card\.md/, "b adopted a's card first, so it minted the next id");
  assert.match(second.text, /on the hub/);
  assert.deepEqual(subjects(p.hubDir, "main"), ["card: DEMO-3 from b", "card: DEMO-2 from a"], "both commits reached the hub, in order");
  assert.equal(git(p.hubDir, "for-each-ref", "refs/mergewright/lease"), "", "the lease taken for each change was released");

  // a holds the lease: b's call is refused before anything is written.
  await as("alpha", undefined, () => openHub(new Project(p.a)).take());
  const before = git(p.b, "rev-parse", "HEAD");
  const refused = await as("beta", undefined, () => call(p.b, "mw_card_new", { title: "while a drives", kind: "chore" }));
  assert.equal(refused.isError, true, refused.text);
  assert.match(refused.text, /alpha .*holds the lease/);
  assert.equal(git(p.b, "rev-parse", "HEAD"), before, "nothing committed on b");
  assert.equal(fs.existsSync(path.join(p.b, "cards", "DEMO-4.card.md")), false, "nothing written on b");
  const transaction = added<(project: Project, f: () => string) => Promise<string>>(repo, "repoTransaction");
  assert.ok(transaction, "repoTransaction exists");
  await as("beta", undefined, () => assert.rejects(transaction(new Project(p.b), () => "x"), (e: { code?: string }) => e.code === "lease/held"));
  assert.match(git(p.hubDir, "log", "-1", "--format=%B", "refs/mergewright/lease"), /"host":"alpha"/, "a still holds it");
});

test("a stale Hermes lock is taken over only under the takeover guard and only while it is the file judged; a displaced lock is never deleted", async () => {
  const home = tmpDir("mw-r7-home-");
  const hermesHome = path.join(home, ".hermes");
  fs.mkdirSync(hermesHome, { recursive: true });
  const configFile = path.join(hermesHome, "config.yaml");
  const lockFile = `${configFile}.mw-lock`;
  const bin = tmpDir("mw-r7-path-");
  for (const tool of ["git", "sh", "env"]) {
    for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
      const f = path.join(d, tool);
      if (fs.existsSync(f)) { fs.symlinkSync(f, path.join(bin, tool)); break; }
    }
  }
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, HERMES_HOME: process.env.HERMES_HOME };
  const savedLock = { ...hermes.configLock };
  const realRename = fs.renameSync;
  const realWrite = process.stderr.write.bind(process.stderr);
  const winnerProc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const thirdProc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  const winner = JSON.stringify({ pid: winnerProc.pid, time: Date.now(), nonce: "winner" });
  const third = JSON.stringify({ pid: thirdProc.pid, time: Date.now(), nonce: "third" });
  const stale = JSON.stringify({ pid: dead, time: Date.now(), nonce: "dead" });
  const asides = () => fs.readdirSync(hermesHome).filter((f) => f.startsWith("config.yaml.mw-lock.stale-"));
  const holdsWinner = () => [lockFile, ...asides().map((f) => path.join(hermesHome, f))].some((f) => fs.existsSync(f) && fs.readFileSync(f, "utf8") === winner);
  /** Once, when the lock is moved: `before` runs first, then the rename, then a third process takes the lock. */
  const onLockRename = (before: () => void) => {
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) !== lockFile) return realRename(from, to);
      fs.renameSync = realRename;
      before();
      realRename(from, to);
      fs.writeFileSync(lockFile, third);
    }) as typeof fs.renameSync;
  };
  const dir = await hermesTools(newProject());
  Object.assign(process.env, { PATH: bin, HOME: home, HERMES_HOME: hermesHome });
  try {
    fs.writeFileSync(configFile, "mcp_servers: {}\n", { mode: 0o600 });
    hermes.configLock.waitMs = 300;

    // Between judging the lock stale and moving it, another process replaced it with its own (then a
    // third would take the path after any rename). The new holder's lock must survive; this one waits.
    fs.writeFileSync(lockFile, stale);
    hermes.testHooks.beforeTakeover = () => {
      hermes.testHooks.beforeTakeover = undefined;
      fs.rmSync(lockFile);
      fs.writeFileSync(lockFile, winner);
    };
    onLockRename(() => undefined);
    const t0 = Date.now();
    assert.throws(() => dir.init({ name: "mergewright-r7" }), /being changed by another MergeWright process/);
    assert.ok(Date.now() - t0 >= 250, "it waited for the live holder");
    assert.ok(holdsWinner(), "the new holder's lock was not deleted");
    assert.equal(read(hermesHome, "config.yaml.mw-lock"), winner, "and it is still in place: the stale judgement was not applied to another file");
    fs.renameSync = realRename;
    for (const f of asides()) fs.rmSync(path.join(hermesHome, f));

    // The lock is replaced in the very instant before the rename, and a third process takes the path
    // right after: what was moved cannot be put back, so it is kept aside, with a warning naming it.
    fs.writeFileSync(lockFile, stale);
    onLockRename(() => { fs.rmSync(lockFile); fs.writeFileSync(lockFile, winner); });
    let warned = "";
    process.stderr.write = ((chunk: string | Uint8Array) => { warned += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      assert.throws(() => dir.init({ name: "mergewright-r7" }), /being changed by another MergeWright process/);
    } finally {
      process.stderr.write = realWrite;
    }
    assert.ok(holdsWinner(), "the displaced lock was not deleted");
    const kept = asides();
    assert.equal(kept.length, 1);
    assert.equal(read(hermesHome, kept[0]!), winner);
    assert.match(warned, new RegExp(kept[0]!.replace(/\./g, "\\.")), "the warning names the file kept aside");
    assert.equal(read(hermesHome, "config.yaml.mw-lock"), third, "the third holder's lock is untouched");
    assert.equal(fs.existsSync(`${lockFile}.takeover`), false, "the takeover guard is released");
  } finally {
    fs.renameSync = realRename;
    process.stderr.write = realWrite;
    Object.assign(hermes.configLock, savedLock);
    hermes.testHooks.beforeTakeover = undefined;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    winnerProc.kill();
    thirdProc.kill();
  }
});

test("git paths are literal; a card whose file name does not match its id is refused before any change", async () => {
  const dir = newProject();
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1"));
  write(dir, "cards/*.card.md", card("DEMO-9"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "cards");
  const head = git(dir, "rev-parse", "HEAD");
  // The owner's own change to another card, not committed.
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1").replace("status: todo", "status: ready"));

  const r = await call(dir, "mw_card_set_status", { id: "DEMO-9", status: "ready" });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /not in a file named DEMO-9\.card\.md/);
  assert.equal(git(dir, "rev-parse", "HEAD"), head, "nothing committed");
  assert.match(read(dir, "cards/*.card.md"), /status: todo/, "the misnamed card is unchanged");
  assert.match(git(dir, "show", "HEAD:cards/DEMO-1.card.md"), /status: todo/, "the other card was not committed");
  assert.match(git(dir, "status", "--porcelain"), /^ ?M cards\/DEMO-1\.card\.md$/m, "the other card's change is still the owner's, unstaged");

  // A direct commit naming the wildcard file commits that file alone.
  write(dir, "cards/*.card.md", card("DEMO-9").replace("status: todo", "status: ready"));
  repo.commitAlone(new Project(dir), ["cards/*.card.md"], "wild");
  assert.deepEqual(git(dir, "show", "--name-only", "--format=", "HEAD").split("\n"), ["cards/*.card.md"]);
  assert.match(git(dir, "show", "HEAD:cards/DEMO-1.card.md"), /status: todo/);
});

test("the Codex home sweep runs under the registry guard: it waits for a registering process, and keeps the home of the run that registered", async () => {
  const dir = newProject();
  const local = path.join(dir, ".mergewright", "local");
  const locks = path.join(local, "locks");
  const home = path.join(local, "codex-home", "DEMO-5");
  write(home, "auth.json", "{}\n");
  fs.mkdirSync(locks, { recursive: true });
  const ready = path.join(tmpDir("mw-r7-"), "ready");
  // Another process registers a run of DEMO-5 the way acquireLock does: under the guard, and slowly.
  const other = child(`import fs from "node:fs";
const reg = await import(${src("engine/registry.ts")});
const { processIdentity } = await import(${src("engine/procid.ts")});
reg.withGuardSync(${JSON.stringify(locks)}, "lock", () => {
  fs.writeFileSync(${JSON.stringify(ready)}, "");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  const me = processIdentity(process.pid);
  fs.writeFileSync(${JSON.stringify(path.join(locks, "DEMO-5.lock"))}, JSON.stringify({ pid: process.pid, host: "here", started: new Date().toISOString(), procStart: me.started }) + "\\n");
});
console.log("REGISTERED");
setTimeout(() => {}, 20000);`);
  try {
    await waitFor(ready);
    const t0 = Date.now();
    const swept = sweepCodexHomes(new Project(dir));
    const waited = Date.now() - t0;
    assert.ok(waited >= 400, `the sweep waited for the guard (${waited} ms)`);
    assert.deepEqual(swept, [], "nothing removed");
    assert.ok(fs.existsSync(path.join(home, "auth.json")), "the home of the run that registered meanwhile is kept, with its login");
  } finally {
    other.proc.kill();
  }
  await other.done;
  // Its process gone, the home is a leftover again: the next sweep removes it.
  const swept = sweepCodexHomes(new Project(dir));
  assert.equal(swept.length, 1);
  assert.equal(fs.existsSync(home), false);
});
