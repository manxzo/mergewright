// Regression tests for delegation (`mw_delegate`), the TUI's shutdown, the MCP server's
// repository-mutating tools and the Hermes config lock. Each test reproduces a trigger and asserts
// the state the runtime must leave. Newer symbols are reached through `added` or a dynamic import,
// so that a missing one fails its own test instead of the whole file.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import mock from "../src/engine/harness/mock.ts";
import type { HarnessRequest, HarnessResult } from "../src/engine/types.ts";
import { callTool, TOOLS } from "../src/mcpserver/server.ts";
import type { ToolContext } from "../src/mcpserver/tool.ts";
import { delegate, delegateRole } from "../src/mcpserver/tools/delegate.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { Project } from "../src/project.ts";
import * as tuiRun from "../src/tui/run.ts";
import type { Effect, Result } from "../src/tui/model.ts";
import type { Term } from "../src/tui/term.ts";
import * as util from "../src/util.ts";
import { finding, findings, project, script, useScript } from "./engine-helpers.ts";
import { addPackage, git, hermesPackage, hermesTools, MW, newProject, read, tmpDir, write } from "./helpers.ts";

/** The hermes package's module (configLock, testHooks). */
const hermes = await hermesPackage();

// Delegation refuses the mock harness unless this is set (it is for tests only); the server inherits it.
process.env.MW_DELEGATE_ALLOW_MOCK = "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A newer symbol of a module, failing this test (not the whole file) when it is missing. */
function added<T>(mod: object, name: string): T | undefined {
  return (mod as Record<string, unknown>)[name] as T | undefined;
}

/** Wrap the mock harness: `around` sees every request and calls the real mock run. */
async function withMock<T>(around: (req: HarnessRequest, real: (req: HarnessRequest) => Promise<HarnessResult>) => Promise<HarnessResult>, f: () => Promise<T>): Promise<T> {
  const real = mock.run.bind(mock);
  mock.run = (req) => around(req, real);
  try {
    return await f();
  } finally {
    mock.run = real;
  }
}

function ctxFor(dir: string): ToolContext {
  return { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined };
}

async function call(dir: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, name);
  const cwd = process.cwd(); // tools that go through the CLI change directory to the project
  try {
    const r = await callTool(tool, args, ctxFor(dir));
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  } finally {
    process.chdir(cwd);
  }
}

test("a delegated run gets no MCP servers whatever the role lists; mw_mcp_add writes roles: [] and says so", async () => {
  const dir = project();
  // A server offered to every role, which references a credential that is not set: wiring it would fail.
  write(dir, "mcps/leaky.mcp.yaml", "id: leaky\ntransport: stdio\ncommand: sh\nargs: [-c, 'touch pwned']\nenv: {TOKEN: '${MW_REVIEW6_UNSET_TOKEN}'}\nroles: all\n");
  delete process.env.MW_REVIEW6_UNSET_TOKEN;
  useScript(script({ reviewer: [{ output: findings([finding("R-01", false)]) }] }));
  const p = new Project(dir);
  const seen: HarnessRequest[] = [];
  const r = await withMock(async (req, real) => { seen.push(req); return real(req); }, () => delegate(p, delegateRole(p, { role: "reviewer" }), "Check it"));
  assert.equal(r.ok, true, r.error);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.mcp, undefined, "no MCP wiring reaches the harness");
  assert.equal("TOKEN" in seen[0]!.env, false);
  assert.equal(fs.existsSync(path.join(dir, "pwned")), false);

  const ok = await call(dir, "mw_mcp_add", { id: "newsrv", command: "npx -y some-server" });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /roles: \[\] \(no role gets this server\)/);
  assert.deepEqual(YAML.parse(read(dir, "mcps/newsrv.mcp.yaml")).roles, []);
  const withRoles = await call(dir, "mw_mcp_add", { id: "other", command: "npx other", roles: ["reviewer"] });
  assert.equal(withRoles.isError, true, "the MCP tool cannot attach a server to a role");
  assert.equal(fs.existsSync(path.join(dir, "mcps/other.mcp.yaml")), false);
});

test("delegation drops the role's args and command, and keeps its prompt, limits, model and provider", async () => {
  const dir = project();
  write(dir, "roles/consult.role.md", "---\nid: consult\ndescription: A consulting role with harness extras.\nruns: mock\nmodel: some-model\nprovider: some-provider\nmode: read\noutput: text\nlimits: {minutes: 7}\nargs: [-t, terminal]\nmcps: [leaky]\n---\nConsult on: {{card}}\n");
  useScript(script({ consult: [{ output: "fine" }] }));
  const p = new Project(dir);
  const role = delegateRole(p, { role: "consult" });
  assert.deepEqual(role.args, [], "harness arguments are not delegated");
  assert.equal(role.command, undefined);
  assert.deepEqual(role.mcps, []);
  assert.deepEqual([role.model, role.provider, role.limits.minutes, role.mode, role.output], ["some-model", "some-provider", 7, "read", "text"]);
  assert.match(role.prompt, /Consult on: \{\{card\}\}/);
  const seen: HarnessRequest[] = [];
  const r = await withMock(async (req, real) => { seen.push(req); return real(req); }, () => delegate(p, role, "Is this fine?"));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(seen[0]!.role.args, []);
});

test("advise runs in an empty temporary folder outside the project, removed afterwards; read runs in the real project", async () => {
  const dir = project();
  useScript(script({ delegate: [{ output: "advice" }] }));
  const p = new Project(dir);
  let during: { cwd: string; entries: string[] } | undefined;
  const r = await withMock(async (req, real) => {
    during = { cwd: req.cwd, entries: fs.readdirSync(req.cwd) };
    return real(req);
  }, () => delegate(p, delegateRole(p, { runs: "mock" }), "Advise me"));
  assert.equal(r.ok, true, r.error);
  assert.ok(during);
  assert.equal(path.dirname(during.cwd), os.tmpdir(), `advise cwd ${during.cwd} is in the system temp folder`);
  assert.match(path.basename(during.cwd), /^mw-advise-/);
  assert.deepEqual(during.entries, [], "the folder is empty");
  const rel = path.relative(fs.realpathSync(dir), during.cwd);
  assert.ok(rel.startsWith(".."), "advise cwd is outside the project");
  assert.equal(fs.existsSync(during.cwd), false, "the folder is removed after the run");

  useScript(script({ reviewer: [{ output: findings() }] }));
  let readCwd = "";
  await withMock(async (req, real) => { readCwd = req.cwd; return real(req); }, () => delegate(p, delegateRole(p, { role: "reviewer" }), "Read it"));
  assert.equal(readCwd, fs.realpathSync(dir));
  const doc = read(PACKAGE_ROOT, "packages/hermes/README.md");
  assert.match(doc, /no OS-level sandbox/i, "the hermes package's README states the missing sandbox");
  assert.match(doc, /can read what the owner/i);
});

test("quitting the TUI stops key handling, drains the queued writes, and reports one that failed", async () => {
  const dir = newProject();
  let key: (k: string) => void = () => undefined;
  let restored = 0;
  const term: Term = { columns: () => 100, rows: () => 30, draw: () => undefined, onKey: (f) => { key = f; }, onResize: () => undefined, restore: () => { restored++; } };
  const executed: string[] = [];
  let releaseEject!: () => void;
  const ejectGate = new Promise<void>((r) => { releaseEject = r; });
  const reports: string[] = [];
  const deps = {
    execute: async (_root: string, effect: Effect): Promise<Result> => {
      executed.push(effect.kind);
      if (effect.kind === "eject") {
        await ejectGate;
        return { ok: false, message: "disk full" };
      }
      return { ok: true, message: effect.kind === "probe" ? "services probed" : "" };
    },
    report: (line: string) => reports.push(line),
  };
  const run = tuiRun.runTui as (p: Project, t: Term, d?: typeof deps) => Promise<number>;
  let code: number | undefined;
  const finished = run(new Project(dir), term, deps).then((c) => { code = c; });
  await sleep(20);
  key("2"); // roles
  key("e"); // eject the first (preset) role: a write, held until released
  key("q"); // quit while it is in flight
  key("p"); // ignored: no keys once quitting
  await sleep(50);
  assert.equal(code, undefined, "the TUI does not end while a queued write is in flight");
  releaseEject();
  await finished;
  assert.equal(code, 1, "a write that failed while quitting makes the exit code 1");
  assert.deepEqual(executed, ["probe", "tool", "tool", "eject"], "the key after q was not handled");
  assert.equal(restored, 1);
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /not saved while quitting: eject role \S+: disk full/);
});

test("repository-mutating MCP tools run one at a time; temporary names are unique; mw_docs_write re-checks the file under the lock", async () => {
  const mutex = await import("../src/mcpserver/mutex.ts").catch(() => undefined);
  assert.ok(mutex, "src/mcpserver/mutex.ts exists");
  const repoLock = mutex.repoLock;

  // Temporary names: two writes of the same file in one process never share one.
  const names: string[] = [];
  const rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => { names.push(path.basename(String(from))); return rename(from, to); }) as typeof fs.renameSync;
  try {
    const f = path.join(tmpDir(), "f.txt");
    util.writeAtomic(f, "1");
    util.writeAtomic(f, "2");
    util.writeAllAtomic([{ file: f, content: "3" }]);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(new Set(names).size, 3, names.join(", "));
  for (const n of names) assert.match(n, new RegExp(`^\\.f\\.txt\\.${process.pid}\\.\\d+\\.[0-9a-f]{8}\\.tmp$`));

  // Every mutating tool waits for the lock; a reading tool does not.
  const dir = project();
  fs.appendFileSync(path.join(dir, "mergewright.yaml"), "docs:\n  paths: [docs/**]\n");
  write(dir, "docs/guide.md", "# Guide\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "docs");
  let release!: () => void;
  const held = repoLock.run(() => new Promise<void>((r) => { release = r; }));
  const calls: [string, Record<string, unknown>][] = [
    ["mw_card_new", { title: "A card", kind: "chore" }],
    ["mw_card_set_status", { id: "DEMO-1", status: "ready" }],
    ["mw_memory_state", { text: "# State\n\nNow.\n" }],
    ["mw_memory_add", { kind: "decision", title: "Use a queue", body: "Because." }],
    ["mw_spec_propose", { spec: "nope", summary: "x" }],
    ["mw_mcp_add", { id: "locked-srv", command: "npx x" }],
    ["mw_docs_write", { path: "docs/guide.md", content: "# Guide\n\nNew.\n" }],
  ];
  const settled = new Set<string>();
  const pending = calls.map(([name, args]) => call(dir, name, args).then((r) => { settled.add(name); return { name, ...r }; }));
  const status = await call(dir, "mw_status", {});
  assert.equal(status.isError, false, "a reading tool does not wait for the lock");
  await sleep(50);
  assert.deepEqual([...settled], [], "no mutating tool ran while the lock was held");
  // Meanwhile the owner edits the document mw_docs_write validated: it must not be overwritten.
  write(dir, "docs/guide.md", "# Guide\n\nThe owner's edit.\n");
  release();
  await held;
  const results = await Promise.all(pending);
  const docs = results.find((r) => r.name === "mw_docs_write")!;
  assert.equal(docs.isError, true, docs.text);
  assert.match(docs.text, /changed while this write waited/);
  assert.equal(read(dir, "docs/guide.md"), "# Guide\n\nThe owner's edit.\n");
  assert.equal(results.find((r) => r.name === "mw_card_new")!.isError, false);
});

/** A PATH with git and sh but neither hermes nor mw. */
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

test("Hermes config edits take a lock, re-read under it, take over a dead holder's lock, and refuse when the file changes before the rename", async () => {
  const hooks = added<{ beforeLock?: () => void; beforeRename?: () => void }>(hermes, "testHooks") ?? {};
  const lockCfg = added<{ staleMs: number; waitMs: number }>(hermes, "configLock") ?? { staleMs: 0, waitMs: 0 };
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, HERMES_HOME: process.env.HERMES_HOME };
  const home = tmpDir("mw-home-");
  const hermesHome = path.join(home, ".hermes");
  fs.mkdirSync(hermesHome, { recursive: true });
  const configFile = path.join(hermesHome, "config.yaml");
  fs.writeFileSync(configFile, "model:\n  default: m\nmcp_servers:\n  other:\n    url: https://example.test/mcp\n", { mode: 0o600 });
  const bare = barePath();
  Object.assign(process.env, { PATH: bare, HOME: home, HERMES_HOME: hermesHome });
  const lockFile = `${configFile}.mw-lock`;
  const servers = () => Object.keys((YAML.parse(fs.readFileSync(configFile, "utf8")) as { mcp_servers: object }).mcp_servers);
  try {
    const a = await hermesTools(newProject());
    const b = await hermesTools(newProject());
    // Another init commits between this one's first read and its write: both entries survive.
    hooks.beforeLock = () => {
      hooks.beforeLock = undefined;
      b.init({ name: "mergewright-b" });
    };
    a.init({ name: "mergewright-a" });
    assert.deepEqual(servers().sort(), ["mergewright-a", "mergewright-b", "other"]);
    assert.equal(fs.existsSync(lockFile), false, "the lock is released");

    // A lock left by a process that is gone is taken over.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    fs.writeFileSync(lockFile, JSON.stringify({ pid: dead, time: Date.now() }));
    a.init({ name: "mergewright-c" });
    assert.ok(servers().includes("mergewright-c"));
    assert.equal(fs.existsSync(lockFile), false, "the dead holder's lock was taken over and released");

    // A live holder is waited for, then refused.
    lockCfg.waitMs = 200;
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, time: Date.now() }));
    assert.throws(() => a.init({ name: "mergewright-d" }), /being changed by another MergeWright process/);
    fs.rmSync(lockFile);
    lockCfg.waitMs = 10_000;

    // Hermes writes the file between the read under the lock and the rename: refused, backup kept.
    hooks.beforeRename = () => fs.appendFileSync(configFile, "# hermes wrote this\n");
    const backupsBefore = fs.readdirSync(hermesHome).filter((f) => f.startsWith("config.yaml.bak-")).length;
    assert.throws(() => a.init({ name: "mergewright-e" }), /changed while MergeWright was editing it/);
    hooks.beforeRename = undefined;
    assert.ok(fs.readFileSync(configFile, "utf8").includes("# hermes wrote this"), "Hermes's write is kept");
    assert.ok(!servers().includes("mergewright-e"));
    assert.ok(fs.readdirSync(hermesHome).filter((f) => f.startsWith("config.yaml.bak-")).length > backupsBefore, "the backup is kept");
  } finally {
    hooks.beforeLock = undefined;
    hooks.beforeRename = undefined;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  // Several `mw hermes init` processes at once: every entry ends up in the file.
  const names = ["p1", "p2", "p3", "p4"];
  const dirs = names.map(() => newProject());
  for (const d of dirs) addPackage(d, "hermes");
  const env = { ...process.env, PATH: bare, HOME: home, HERMES_HOME: hermesHome, MW_ENV_FILE: "/dev/null" };
  const codes = await Promise.all(names.map((n, i) => new Promise<number>((resolve) => {
    const c = spawn(process.execPath, [MW, "hermes", "init", "--name", `mergewright-${n}`], { cwd: dirs[i], env, stdio: "ignore" });
    c.on("close", (code) => resolve(code ?? 1));
  })));
  assert.deepEqual(codes, [0, 0, 0, 0]);
  for (const n of names) assert.ok(servers().includes(`mergewright-${n}`), `mergewright-${n} registered`);
});

test("a read-mode delegate's cwd is resolved through symlinks, must be a folder, and must stay in the project", async () => {
  const dir = project();
  const outside = tmpDir("mw-outside-");
  fs.writeFileSync(path.join(outside, "secret.txt"), "not the project's\n");
  fs.symlinkSync(outside, path.join(dir, "external"));
  write(dir, "src/app.txt", "x\n");
  useScript(script({ reviewer: [{ output: findings() }] }));
  const p = new Project(dir);
  const role = delegateRole(p, { role: "reviewer" });
  const started: string[] = [];
  await withMock(async (req, real) => { started.push(req.cwd); return real(req); }, async () => {
    await assert.rejects(delegate(p, role, "Look", { cwd: "external" }), /outside the project/);
    await assert.rejects(delegate(p, role, "Look", { cwd: "src/app.txt" }), /not a folder/);
    await assert.rejects(delegate(p, role, "Look", { cwd: "missing" }), /does not exist/);
    const r = await delegate(p, role, "Look", { cwd: "src" });
    assert.equal(r.ok, true);
  });
  assert.deepEqual(started, [path.join(fs.realpathSync(dir), "src")], "no agent started outside the project");
});

test("two simultaneous delegations with the same label get their own run directories and their own replies", async () => {
  const dir = project();
  useScript(script({ delegate: [{ output: "unused", delay: 150 }] }));
  const p = new Project(dir);
  // Like the Codex harness: the reply goes to a file in the run directory and is read back at the end.
  const r = await withMock(async (req, real) => {
    const reply = path.join(req.runDir, `${req.label}.reply`);
    const task = /## Task\n\n(.*)/.exec(req.prompt)?.[1] ?? "?";
    fs.writeFileSync(reply, `answer to ${task}`);
    const res = await real(req);
    return { ...res, text: fs.readFileSync(reply, "utf8") };
  }, () => Promise.all(["task A", "task B"].map((t) => delegate(p, delegateRole(p, { runs: "mock" }), t, { label: "same" }))));
  assert.notEqual(r[0]!.run_dir, r[1]!.run_dir, "each call has its own run directory");
  for (const x of r) assert.match(x.run_dir, /^\.mergewright\/local\/delegate\/\d{8}T\d{6}-same-[A-Za-z0-9]{6}$/);
  assert.equal(r[0]!.output, "answer to task A");
  assert.equal(r[1]!.output, "answer to task B");
});

