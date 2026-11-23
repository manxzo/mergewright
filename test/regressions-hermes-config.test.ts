// Regression tests for the installed runtime: delegation and the mock harness, the delegate reply,
// the Hermes config lock and backup, comment layout in mergewright.yaml, and `mw version`.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { setConfig } from "../src/config.ts";
import { callTool, TOOLS } from "../src/mcpserver/server.ts";
import type { ToolContext } from "../src/mcpserver/tool.ts";
import { delegate, delegateRole } from "../src/mcpserver/tools/delegate.ts";
import { runtimeOrigin } from "../src/paths.ts";
import { loadPackages } from "../src/packages/loader.ts";
import { Project } from "../src/project.ts";
import { mockServer, type Recorded } from "./fixtures/integrations/support.ts";
import { project } from "./engine-helpers.ts";
import { addPackage, hermesPackage, hermesTools, newProject, tmpDir } from "./helpers.ts";

/** The hermes package's module (configLock, testHooks). */
const hermes = await hermesPackage();


// ── The mock harness ─────────────────────────────────────────────────────────────────────

test("delegation refuses the mock harness unless MW_DELEGATE_ALLOW_MOCK=1", () => {
  const p = new Project(project());
  const saved = process.env.MW_DELEGATE_ALLOW_MOCK;
  try {
    delete process.env.MW_DELEGATE_ALLOW_MOCK;
    assert.throws(() => delegateRole(p, { runs: "mock" }), /'mock', the test harness, which delegation refuses unless MW_DELEGATE_ALLOW_MOCK=1/);
    assert.throws(() => delegateRole(p, { role: "reviewer" }), /refuses unless MW_DELEGATE_ALLOW_MOCK=1/, "a project role on mock too");
    process.env.MW_DELEGATE_ALLOW_MOCK = "0";
    assert.throws(() => delegateRole(p, { runs: "mock" }), /MW_DELEGATE_ALLOW_MOCK/);
    process.env.MW_DELEGATE_ALLOW_MOCK = "1";
    assert.equal(delegateRole(p, { runs: "mock" }).runs, "mock");
    const tool = TOOLS.find((t) => t.name === "mw_delegate")!;
    assert.match(JSON.stringify(tool.inputSchema), /test harness: refused unless MW_DELEGATE_ALLOW_MOCK=1/);
    assert.match(tool.description, /There is no OS sandbox/);
    assert.doesNotMatch(JSON.stringify(tool.inputSchema), /no files/);
  } finally {
    if (saved === undefined) delete process.env.MW_DELEGATE_ALLOW_MOCK; else process.env.MW_DELEGATE_ALLOW_MOCK = saved;
  }
});

// ── Model and usage in the reply ─────────────────────────────────────────────────────────

test("a hermes delegate's reply names the model (or provider) and says usage: null", async () => {
  const dir = project();
  addPackage(dir, "hermes");
  const p = new Project(dir);
  // The harness the loaded package provides; the engine looks its run up on every call.
  const hermesHarness = (await loadPackages(p)).find((l) => l.name === "hermes")!.exports!.harness!.hermes!;
  const real = hermesHarness.run;
  hermesHarness.run = async () => ({ ok: true, text: "Use a queue.", seconds: 0 }); // Hermes reports no usage
  try {
    const byProvider = await delegate(p, delegateRole(p, { runs: "hermes", provider: "openrouter" }), "How?");
    assert.equal(byProvider.ok, true, byProvider.error);
    assert.equal(byProvider.model, "openrouter");
    assert.equal(byProvider.usage, null);
    const byModel = await delegate(p, delegateRole(p, { runs: "hermes", model: "gpt-6-astra", provider: "openrouter" }), "How?");
    assert.equal(byModel.model, "gpt-6-astra");
    // Through the tool: both keys are in the JSON (undefined would drop them).
    const ctx: ToolContext = { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined };
    const cwd = process.cwd();
    let text: string;
    try {
      text = (await callTool(TOOLS.find((t) => t.name === "mw_delegate")!, { task: "How?", runs: "hermes" }, ctx)).content.map((c) => c.text).join("\n");
    } finally {
      process.chdir(cwd);
    }
    const reply = JSON.parse(text) as Record<string, unknown>;
    assert.equal(reply.model, "(harness default)");
    assert.ok("usage" in reply && reply.usage === null, text);
  } finally {
    hermesHarness.run = real;
  }
});

// ── B: the Hermes config ─────────────────────────────────────────────────────────────────────

/** A PATH with git, sh, bash and env but neither hermes nor mw. */
function barePath(): string {
  const bin = tmpDir("mw-path-");
  for (const tool of ["git", "sh", "bash", "env"]) {
    for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
      const f = path.join(d, tool);
      if (fs.existsSync(f)) { fs.symlinkSync(f, path.join(bin, tool)); break; }
    }
  }
  return bin;
}

const CONFIG = "model:\n  default: m   # chat model\nmcp_servers:\n  other:\n    url: https://example.test/mcp\n";

interface HermesEnv { home: string; hermesHome: string; configFile: string; lockFile: string; bin: string; log: string; calls: () => { args: string[]; backups: number; m0: number; m1: number; lock: string }[] }

/**
 * Point HOME, HERMES_HOME and PATH at a scratch setup for `f`. With `fakeHermes`, PATH has a `hermes`
 * that records its arguments, how many config backups exist, and the lock's mtime before and after
 * sleeping `sleepMs`; it changes nothing, so MergeWright falls back to editing the YAML.
 */
async function withHermes(opts: { fakeHermes?: boolean; sleepMs?: number; realDir?: string }, f: (h: HermesEnv) => void | Promise<void>): Promise<void> {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, HERMES_HOME: process.env.HERMES_HOME };
  const savedLock = { ...hermes.configLock };
  const home = tmpDir("mw-home-");
  const hermesHome = path.join(home, ".hermes");
  fs.mkdirSync(hermesHome, { recursive: true });
  const configFile = path.join(hermesHome, "config.yaml");
  const bin = barePath();
  const log = path.join(home, "hermes.log");
  if (opts.fakeHermes) {
    const backupsIn = opts.realDir ?? hermesHome;
    fs.writeFileSync(path.join(bin, "hermes"), `#!${process.execPath}
const fs = process.getBuiltinModule("node:fs");
const lock = ${JSON.stringify(`${configFile}.mw-lock`)};
const m0 = fs.statSync(lock).mtimeMs;
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${opts.sleepMs ?? 0});
const m1 = fs.statSync(lock).mtimeMs;
const backups = fs.readdirSync(${JSON.stringify(backupsIn)}).filter((f) => f.startsWith("config.yaml.bak-")).length;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), backups, m0, m1, lock: fs.readFileSync(lock, "utf8") }) + "\\n");
`, { mode: 0o755 });
  }
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  Object.assign(process.env, { PATH: bin, HOME: home, HERMES_HOME: hermesHome });
  try {
    await f({ home, hermesHome, configFile, lockFile: `${configFile}.mw-lock`, bin, log, calls });
  } finally {
    Object.assign(hermes.configLock, savedLock);
    hermes.testHooks.beforeLock = hermes.testHooks.beforeRename = hermes.testHooks.beforeTakeover = undefined;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const servers = (file: string) => Object.keys((YAML.parse(fs.readFileSync(file, "utf8")) as { mcp_servers?: object }).mcp_servers ?? {});

/** A process that stays alive (a live lock holder that is not this process). */
function liveProcess(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
}

test("'hermes mcp add' and 'hermes mcp remove' run after a timestamped backup of config.yaml", async () => {
  const dir = await hermesTools(newProject());
  await withHermes({ fakeHermes: true }, ({ configFile, hermesHome, calls }) => {
    fs.writeFileSync(configFile, CONFIG, { mode: 0o600 });
    const r = dir.init({ name: "mergewright-b4" });
    const add = calls().find((c) => c.args[1] === "add")!;
    assert.ok(add, "hermes mcp add ran");
    assert.equal(add.backups, 1, "a backup existed before 'hermes mcp add' ran");
    assert.ok(r.backup && fs.readFileSync(r.backup, "utf8") === CONFIG, "the reported backup is the file from before");
    assert.equal(path.dirname(r.backup!), hermesHome);
    const before = fs.readdirSync(hermesHome).filter((f) => f.startsWith("config.yaml.bak-")).length;
    const rm = dir.remove({ name: "mergewright-b4" });
    const remove = calls().find((c) => c.args[1] === "remove")!;
    assert.ok(remove, "hermes mcp remove ran");
    assert.equal(remove.backups, before + 1, "a new backup existed before 'hermes mcp remove' ran");
    assert.ok(rm.backup && fs.readFileSync(rm.backup, "utf8").includes("mergewright-b4"));
    assert.equal(rm.removed, true);
  });
});

test("a lock is stale only when its process is gone or it is older than 300 s; the CLI holder refreshes it; only the holder removes it", async () => {
  const dir = await hermesTools(newProject());
  const holder = liveProcess();
  try {
    await withHermes({ fakeHermes: true, sleepMs: 800 }, ({ configFile, lockFile, bin, log, calls }) => {
      fs.writeFileSync(configFile, CONFIG, { mode: 0o600 });
      assert.equal(hermes.configLock.staleMs, 300_000);
      assert.equal(hermes.configLock.refreshMs, 20_000);

      // While 'hermes mcp add' runs (here 0.8 s), the lock's mtime is refreshed.
      hermes.configLock.refreshMs = 100;
      dir.init({ name: "mergewright-r" });
      const add = calls()[0]!;
      assert.ok(add.m1 > add.m0, `the lock was refreshed while the CLI ran (${add.m0} -> ${add.m1})`);
      assert.match(add.lock, /"nonce":"[0-9a-f]{24}"/);
      assert.equal(fs.existsSync(lockFile), false, "released");
      fs.rmSync(log);

      // A live holder's lock two minutes old (stale under the old 60 s rule) is waited for, then refused.
      fs.rmSync(path.join(bin, "hermes"));
      hermes.configLock.waitMs = 300;
      fs.writeFileSync(lockFile, JSON.stringify({ pid: holder.pid, time: Date.now() - 120_000, nonce: "theirs" }));
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(lockFile, old, old);
      assert.throws(() => dir.init({ name: "mergewright-s" }), /being changed by another MergeWright process/);
      assert.match(fs.readFileSync(lockFile, "utf8"), /theirs/, "the live lock is untouched");

      // Older than 300 s: taken over, even though its process is alive.
      const older = new Date(Date.now() - 301_000);
      fs.utimesSync(lockFile, older, older);
      dir.init({ name: "mergewright-s" });
      assert.ok(servers(configFile).includes("mergewright-s"));
      assert.equal(fs.existsSync(lockFile), false);

      // Another process's lock in place of ours when we finish (ours was taken over): left alone.
      hermes.testHooks.beforeRename = () => fs.writeFileSync(lockFile, JSON.stringify({ pid: holder.pid, time: Date.now(), nonce: "other" }));
      dir.init({ name: "mergewright-t" });
      hermes.testHooks.beforeRename = undefined;
      assert.match(fs.readFileSync(lockFile, "utf8"), /"nonce":"other"/, "another process's lock is never removed");
      fs.rmSync(lockFile);
    });
  } finally {
    holder.kill();
  }
});

test("a stale lock is taken over by moving it aside; the loser of that race waits and never removes the winner's lock", async () => {
  const dir = await hermesTools(newProject());
  const holder = liveProcess();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  try {
    await withHermes({}, ({ configFile, lockFile, hermesHome }) => {
      fs.writeFileSync(configFile, CONFIG, { mode: 0o600 });
      const winner = JSON.stringify({ pid: holder.pid, time: Date.now(), nonce: "winner" });
      const leftovers = () => fs.readdirSync(hermesHome).filter((f) => f.includes(".mw-lock.stale-"));

      // Between this process judging the lock stale and moving it, another one took it over.
      hermes.configLock.waitMs = 300;
      fs.writeFileSync(lockFile, JSON.stringify({ pid: dead, time: Date.now(), nonce: "dead" }));
      hermes.testHooks.beforeTakeover = () => {
        hermes.testHooks.beforeTakeover = undefined;
        fs.rmSync(lockFile); // the other process moved the stale lock aside...
        fs.writeFileSync(lockFile, winner); // ...and created its own
      };
      assert.throws(() => dir.init({ name: "mergewright-race" }), /being changed by another MergeWright process/);
      assert.equal(fs.readFileSync(lockFile, "utf8"), winner, "the winner's lock is back in place, unchanged");
      assert.deepEqual(leftovers(), []);
      assert.ok(!servers(configFile).includes("mergewright-race"));
      fs.rmSync(lockFile);

      // The stale lock disappeared before the rename (another process moved it first): wait, then take it.
      hermes.configLock.waitMs = 5_000;
      fs.writeFileSync(lockFile, JSON.stringify({ pid: dead, time: Date.now(), nonce: "dead" }));
      hermes.testHooks.beforeTakeover = () => {
        hermes.testHooks.beforeTakeover = undefined;
        fs.rmSync(lockFile);
      };
      dir.init({ name: "mergewright-late" });
      assert.ok(servers(configFile).includes("mergewright-late"));

      // An ordinary takeover goes through a uniquely named file and leaves nothing behind.
      fs.writeFileSync(lockFile, JSON.stringify({ pid: dead, time: Date.now(), nonce: "dead" }));
      let renamed = "";
      hermes.testHooks.beforeTakeover = () => {
        hermes.testHooks.beforeTakeover = undefined;
        const realRename = fs.renameSync;
        fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => { renamed = String(to); fs.renameSync = realRename; return realRename(from, to); }) as typeof fs.renameSync;
      };
      dir.init({ name: "mergewright-taken" });
      assert.match(path.basename(renamed), new RegExp(`^config\\.yaml\\.mw-lock\\.stale-${process.pid}-[0-9a-f]{8}$`));
      assert.deepEqual(leftovers(), []);
      assert.equal(fs.existsSync(lockFile), false);
    });
  } finally {
    holder.kill();
  }
});

test("a symbolic link config.yaml stays a link: the file it leads to is read, backed up and replaced", async () => {
  const dir = await hermesTools(newProject());
  const realDir = tmpDir("mw-hermes-real-");
  await withHermes({ realDir }, ({ configFile, hermesHome }) => {
    const real = path.join(realDir, "config.yaml");
    fs.writeFileSync(real, CONFIG, { mode: 0o600 });
    fs.symlinkSync(real, configFile);
    const r = dir.init({ name: "mergewright-link" });
    assert.equal(r.how, "config");
    assert.ok(fs.lstatSync(configFile).isSymbolicLink(), "config.yaml is still a link");
    assert.equal(fs.realpathSync(configFile), fs.realpathSync(real));
    assert.ok(servers(real).includes("mergewright-link"), "the target file got the entry");
    assert.equal(path.dirname(r.backup!), fs.realpathSync(realDir), "the backup is next to the real file");
    assert.equal(fs.readFileSync(r.backup!, "utf8"), CONFIG);
    assert.equal(fs.statSync(real).mode & 0o777, 0o600);
    dir.remove({ name: "mergewright-link" });
    assert.ok(fs.lstatSync(configFile).isSymbolicLink());
    assert.equal(fs.readFileSync(real, "utf8"), CONFIG);
    assert.deepEqual(fs.readdirSync(hermesHome).filter((f) => f.startsWith("config.yaml.")), [], "nothing written beside the link");
  });
});

// ── Comment layout ───────────────────────────────────────────────────────────────────────

test("mw config set changes one line; every other line, aligned comments included, stays byte-identical", () => {
  const dir = newProject();
  const file = path.join(dir, "mergewright.yaml");
  const before = fs.readFileSync(file, "utf8").split("\n");
  assert.ok(before.some((l) => /\S {2,}# /.test(l)), "the template aligns its comments");
  setConfig(new Project(dir), "limits.rounds", "3");
  const after = fs.readFileSync(file, "utf8").split("\n");
  assert.equal(after.length, before.length);
  const changed = after.map((l, i) => [before[i], l] as const).filter(([a, b]) => a !== b);
  assert.equal(changed.length, 1, JSON.stringify(changed));
  const [was, now] = changed[0]!;
  assert.equal(now, was!.replace("rounds: 2", "rounds: 3"), "the changed line keeps its comment column");
  // A new key goes in; the old lines stay as they were.
  setConfig(new Project(dir), "cards.prefix", "MW");
  const third = fs.readFileSync(file, "utf8").split("\n");
  assert.equal(third.filter((l, i) => l !== after[i]).length, 1);
  assert.match(third.find((l) => l.includes("prefix: MW"))!, /prefix: MW {2,}# card ids/);
});

// ── `mw version` ──────────────────────────────────────────────────────────────────────────

test("the runtime says whether it is an install from a commit, a checkout, or the npm package", () => {
  const d = tmpDir("mw-origin-");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "mergewright", version: "1.2.3" }));
  assert.equal(runtimeOrigin(d), "installed from the npm package 1.2.3");
  fs.mkdirSync(path.join(d, ".git"));
  assert.equal(runtimeOrigin(d), "running from a checkout");
  fs.writeFileSync(path.join(d, "INSTALLED_COMMIT"), "abc1234\n");
  assert.equal(runtimeOrigin(d), "installed from commit abc1234");
});


