// The engine's requirements (specs/engine.spec.md).
//
// Bounded delivery outbox (specs/engine.spec.md): locked MCP tools only record deliveries
// in this machine's queue and deliver them after the repository lock and the lease; `mw work` dispatches
// its card before it flushes; a flush has a time budget and a per-kind breaker that survive a restart.
// Every endpoint is local: a "blackhole" on 127.0.0.1 accepts connections and never answers.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { runGate } from "../../src/engine/gate.ts";
import claude from "../../src/engine/harness/claude.ts";
import codex, { codexReplyFile } from "../../src/engine/harness/codex.ts";
import { reapTestHooks, runCli, streamFile, takeSurvivors, timing } from "../../src/engine/harness/proc.ts";
import { secretsFor } from "../../src/engine/redact.ts";
import { pruneRawStreams } from "../../src/engine/rawstreams.ts";
import { acquireLock, lockFile, mergingHere, saveExchange } from "../../src/engine/state.ts";
import type { HarnessRequest } from "../../src/engine/types.ts";
import { wireMcps } from "../../src/mcpconfig.ts";
import { localDir, Project } from "../../src/project.ts";
import type { Mcp } from "../../src/model/mcp.ts";
import type { Role } from "../../src/model/role.ts";
import { work } from "../../src/work.ts";
import { as, brief, fakeHub, fakeIntegrations, handoff, hubPair, project, run, runPath, script, setRoles, useScript } from "../engine-helpers.ts";
import { git, kanbanConfig, mem0Config, mw, MW, newProject, patchConfig, read, tmpDir, write } from "../helpers.ts";
import { processIdentity } from "../../src/engine/procid.ts";
import net from "node:net";
import os from "node:os";
import YAML from "yaml";
import { deliveriesInFlight, enqueueMemory, flushQueue, integrationsFor, queueTiming, settleDeliveries, storeMemory } from "../../src/integrations.ts";
import { BudgetCut, COMMAND_FLOOR_MS, commandTimeout, deliveryScope, HttpError, httpJson } from "../../src/integrations/common.ts";
import { BREAKER_SKIP_MS, FLUSH_BUDGET_MS, Queue } from "../../src/integrations/queue.ts";
import { callTool, TOOLS } from "../../src/mcpserver/server.ts";
import { repoLockFile, repoTransaction, withRepoLock } from "../../src/mcpserver/repo.ts";
import type { ToolContext } from "../../src/mcpserver/tool.ts";
import { openHub } from "../../src/hub.ts";
import { pathToFileURL } from "node:url";
import { PACKAGE_ROOT } from "../../src/paths.ts";
import { mockServer, projectWith, queueFiles, queueItems } from "../fixtures/integrations/support.ts";
import { spawn, spawnSync } from "node:child_process";
import { main } from "../../src/cli.ts";
import { mergeWait } from "../../src/commands-integrations.ts";
import http from "node:http";

/** True while `pid` exists and is not a zombie. */
function alive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

function killAll(pids: number[]): void {
  for (const pid of pids) if (pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}

function pidIn(file: string): number {
  return fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8").trim()) || 0 : 0;
}

/** A request for a fake agent CLI run in `dir`. */
function request(dir: string): HarnessRequest {
  return { role: { id: "worker" }, prompt: "", cwd: dir, mode: "write", outputKind: "text", limits: { minutes: 1 }, env: {}, runDir: dir, label: "t" } as unknown as HarnessRequest;
}

const env = { PATH: process.env.PATH ?? "" };

// @req REQ-engine-004
test("REQ-engine-004 AC-1: a gate that leaves 'sleep 300 &' behind and exits 0 passes, and the sleep is gone when runGate() returns", { timeout: 30_000 }, async () => {
  const dir = tmpDir("mw-reap-");
  const file = path.join(dir, "default.gate.sh");
  const pidFile = path.join(dir, "child.pid");
  fs.writeFileSync(file, `#!/usr/bin/env bash\nsleep 300 >/dev/null 2>&1 &\necho $! > '${pidFile}'\necho "checks ran"\nexit 0\n`);
  fs.chmodSync(file, 0o755);
  try {
    const r = await runGate({ id: "default", file, cwd: dir, runDir: path.join(dir, "run"), base: "main", minutes: 1, env });
    const child = pidIn(pidFile);
    assert.ok(child > 0, "the gate recorded its background child");
    assert.equal(alive(child), false, `the gate's background child ${child} is gone when runGate() returns`);
    assert.equal(r.ok, true, `the outcome is the exit code's: ${r.detail}`);
  } finally {
    killAll([pidIn(pidFile)]);
  }
});

// @req REQ-engine-004
test("REQ-engine-004 AC-1: a gate that fails keeps its failure; reaping never changes the outcome", { timeout: 30_000 }, async () => {
  const dir = tmpDir("mw-reap-");
  const file = path.join(dir, "default.gate.sh");
  const pidFile = path.join(dir, "child.pid");
  fs.writeFileSync(file, `#!/usr/bin/env bash\nsleep 300 &\necho $! > '${pidFile}'\nexit 3\n`);
  fs.chmodSync(file, 0o755);
  try {
    const r = await runGate({ id: "default", file, cwd: dir, runDir: path.join(dir, "run"), base: "main", minutes: 1, env });
    assert.equal(alive(pidIn(pidFile)), false, "the background child, which held the gate's stdout, is gone");
    assert.equal(r.ok, false);
  } finally {
    killAll([pidIn(pidFile)]);
  }
});

// @req REQ-engine-004
test("REQ-engine-004 AC-2: a fake agent CLI that exits 0 and leaves a child holding its stdout: runCli() returns with the child gone and its result unchanged", { timeout: 30_000 }, async () => {
  const dir = tmpDir("mw-reap-");
  const pidFile = path.join(dir, "child.pid");
  try {
    const r = await runCli({ harness: "t", cmd: "bash", args: ["-c", `sleep 300 & echo $! > '${pidFile}'; echo done`], req: request(dir), env });
    const child = pidIn(pidFile);
    assert.ok(child > 0);
    assert.equal(alive(child), false, `the agent's background child ${child} is gone when runCli() returns`);
    assert.equal(r.code, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.aborted, false);
    assert.equal(r.stdout.trim(), "done", "the captured output is complete");
    assert.equal(r.survivor, undefined);
  } finally {
    killAll([pidIn(pidFile)]);
  }
});

// @req REQ-engine-004
test("REQ-engine-004 AC-2: a child that ignores SIGTERM is killed after the grace period", { timeout: 30_000 }, async () => {
  const dir = tmpDir("mw-reap-");
  const pidFile = path.join(dir, "child.pid");
  const grace = timing.abortGraceMs;
  timing.abortGraceMs = 300;
  try {
    const t0 = Date.now();
    const r = await runCli({ harness: "t", cmd: "bash", args: ["-c", `trap '' TERM; sleep 300 >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0`], req: request(dir), env });
    const elapsed = Date.now() - t0;
    assert.equal(alive(pidIn(pidFile)), false, "SIGKILL followed SIGTERM");
    assert.ok(elapsed >= 300, `it waited the grace period after SIGTERM (${elapsed} ms)`);
    assert.equal(r.code, 0);
    assert.equal(r.survivor, undefined);
  } finally {
    timing.abortGraceMs = grace;
    killAll([pidIn(pidFile)]);
  }
});

// @req REQ-engine-004
test("REQ-engine-004 AC-2: a group that survives SIGTERM and SIGKILL after a normal exit is recorded through reapOrRecord()", { timeout: 30_000 }, async () => {
  const dir = tmpDir("mw-reap-");
  const pidFile = path.join(dir, "leader.pid");
  const childFile = path.join(dir, "child.pid");
  takeSurvivors();
  reapTestHooks.reapGroup = async () => false; // as if the group were stuck where no signal reaches it
  try {
    const r = await runCli({ harness: "t", cmd: "bash", args: ["-c", `echo $$ > '${pidFile}'; sleep 300 & echo $! > '${childFile}'; exit 0`], req: request(dir), env });
    const leader = pidIn(pidFile);
    assert.ok(leader > 0);
    assert.equal(r.code, 0, "the exit code is unchanged");
    assert.equal(r.survivor, leader, "the surviving group is in the result");
    assert.deepEqual(takeSurvivors(), [leader], "and recorded for the engine");
  } finally {
    delete reapTestHooks.reapGroup;
    takeSurvivors();
    killAll([pidIn(childFile)]);
  }
});

// @req REQ-engine-004
test("REQ-engine-004 AC-3: a command that leaves no child returns without waiting for the grace period", { timeout: 30_000 }, async () => {
  const dir = tmpDir("mw-reap-");
  const grace = timing.abortGraceMs;
  timing.abortGraceMs = 10_000;
  try {
    const t0 = Date.now();
    const r = await runCli({ harness: "t", cmd: "bash", args: ["-c", "echo hi"], req: request(dir), env });
    assert.equal(r.code, 0);
    assert.ok(Date.now() - t0 < 5_000, `runCli() returned in ${Date.now() - t0} ms, well under the 10 s grace period`);
    const file = path.join(dir, "default.gate.sh");
    fs.writeFileSync(file, "#!/usr/bin/env bash\nexit 0\n");
    fs.chmodSync(file, 0o755);
    const t1 = Date.now();
    const g = await runGate({ id: "default", file, cwd: dir, runDir: path.join(dir, "run"), base: "main", minutes: 1, env });
    assert.equal(g.ok, true);
    assert.ok(Date.now() - t1 < 5_000, `runGate() returned in ${Date.now() - t1} ms, well under the 10 s grace period`);
  } finally {
    timing.abortGraceMs = grace;
  }
});

// ── Private, redacted transcripts (REQ-engine-005..007) ─────────────────────────────────────────


/**
 * Obviously fake secret values, read from the environment (a fresh random one when unset). They are
 * shaped like nothing `redactSecrets()` already recognises, so only the configured-value redaction
 * can catch them. Never printed by a test.
 */
const fakeSecret = (name: string, prefix: string): string => (process.env[name] ??= `${prefix}${randomBytes(12).toString("hex")}`);
const KEY = fakeSecret("MW_TEST_LOCAL_KEY", "fakekey");
const MCP_TOKEN = fakeSecret("MW_TEST_MCP_TOKEN", "fakemcp");
const LITERAL_TOKEN = fakeSecret("MW_TEST_MCP_LITERAL", "fakelit");
const LITERAL_HEADER = fakeSecret("MW_TEST_MCP_HEADER", "fakehdr");

/** Every regular file under `root` (not `.git`), relative. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(root, p));
    }
  };
  walk(root);
  return out;
}

/** The files under `root` holding any of `values` (names only: the values are never shown). */
function leaks(root: string, values: string[]): string[] {
  return filesUnder(root).filter((f) => {
    const text = fs.readFileSync(path.join(root, f), "latin1");
    return values.some((v) => text.includes(v));
  });
}

const mode = (file: string) => fs.statSync(file).mode & 0o777;

/** Run `f` with process umask `mask`. */
async function withUmask<T>(mask: number, f: () => Promise<T>): Promise<T> {
  const old = process.umask(mask);
  try {
    return await f();
  } finally {
    process.umask(old);
  }
}

/** A directory with executables `name` → `#!/bin/sh` exec of a node script, first on PATH while `f` runs. */
async function withFakes<T>(fakes: Record<string, string>, f: () => Promise<T>): Promise<T> {
  const bin = tmpDir("mw-fakes-");
  for (const [name, js] of Object.entries(fakes)) {
    fs.writeFileSync(path.join(bin, `${name}.mjs`), js);
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, `${name}.mjs`)}" "$@"\n`, { mode: 0o755 });
  }
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old ?? ""}`;
  try {
    return await f();
  } finally {
    process.env.PATH = old;
  }
}

/**
 * A fake `claude`: records where its --mcp-config is and its mode (never a value) to `record`, prints
 * the MCP token it gets through its environment split across two stderr chunks and two stdout chunks,
 * and replies. The first call of a run replies with text holding the token (no JSON), so the saved
 * exchange of that attempt has it; the retry replies with a valid brief.
 */
function fakeClaude(record: string): string {
  return `import fs from "node:fs";
const argv = process.argv.slice(2);
const v = process.env.MW_TEST_MCP_TOKEN ?? "";
const i = argv.indexOf("--mcp-config");
const cfg = i >= 0 ? argv[i + 1] : undefined;
const calls = fs.existsSync(${JSON.stringify(record)}) ? fs.readFileSync(${JSON.stringify(record)}, "utf8").split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ cfg, mode: cfg ? fs.statSync(cfg).mode & 0o777 : null, argvHas: v !== "" && argv.some((a) => a.includes(v)), hasToken: v !== "" }) + "\\n");
try { fs.readFileSync(0); } catch {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h = Math.floor(v.length / 2);
process.stderr.write("starting with " + v.slice(0, h));
await sleep(150);
process.stderr.write(v.slice(h) + " as the token\\n");
process.stdout.write("value " + v.slice(0, h + 3));
await sleep(150);
process.stdout.write(v.slice(h + 3) + " seen\\n");
const result = calls === 0
  ? { type: "result", subtype: "success", is_error: false, result: "I used " + v + " to look", usage: { input_tokens: 1, output_tokens: 1 } }
  : { type: "result", subtype: "success", is_error: false, result: "", structured_output: ${JSON.stringify(brief())}, usage: { input_tokens: 1, output_tokens: 1 } };
process.stdout.write(JSON.stringify(result) + "\\n");
`;
}

/** Prints the configured key split across two chunks, to its own log and into a step log. */
const SECRET_GATE = `#!/usr/bin/env bash
set -u
mkdir -p "$MERGEWRIGHT_GATE_LOGS"
log="$MERGEWRIGHT_GATE_LOGS/check.log"
v="$MW_TEST_LOCAL_KEY"; h=$(( \${#v} / 2 ))
printf 'checking with %s' "\${v:0:$h}"; sleep 0.2; printf '%s done\\n' "\${v:$h}"
printf 'log %s' "\${v:0:$h}" > "$log"; printf '%s end\\n' "\${v:$h}" >> "$log"
printf '{"ok":true,"steps":[{"name":"check","kind":"test","ok":true,"seconds":0,"log":"%s"}]}\\n' "$log" > "$MERGEWRIGHT_GATE_JSON"
exit 0
`;

/**
 * A project whose planner runs on (fake) `claude` with an MCP server whose env references
 * MW_TEST_MCP_TOKEN, a configured key_env (MW_TEST_LOCAL_KEY) the gate may see and prints, run to the
 * end with process umask 000. Shared by the tests below.
 */
let secretRun: Promise<{ dir: string; record: string }> | undefined;
function runWithSecrets(): Promise<{ dir: string; record: string }> {
  secretRun ??= (async () => {
    const dir = project({ roles: { planner: { runs: "claude" } } });
    write(dir, "mcps/vault.mcp.yaml", 'id: vault\ntransport: stdio\ncommand: vault-mcp\nenv:\n  VAULT_TOKEN: "${MW_TEST_MCP_TOKEN}"\nroles: [planner]\n');
    write(dir, "gates/default.gate.sh", SECRET_GATE);
    fs.appendFileSync(path.join(dir, "mergewright.yaml"), "gate:\n  env: [MW_TEST_LOCAL_KEY]\nlocal_models:\n  key_env: MW_TEST_LOCAL_KEY\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "secrets");
    const record = path.join(tmpDir("mw-record-"), "claude.jsonl");
    useScript(script());
    await withFakes({ claude: fakeClaude(record) }, () => withUmask(0o000, () => run(dir)));
    return { dir, record };
  })();
  return secretRun;
}

// @req REQ-engine-006
test("REQ-engine-006 AC-1: a key_env value and an MCP env value printed by a fake agent and a fake gate, split across chunks, reach no file; [redacted] stands in", { timeout: 120_000 }, async () => {
  const { dir, record } = await runWithSecrets();
  const calls = fs.readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { hasToken: boolean });
  assert.ok(calls.length >= 2 && calls.every((c) => c.hasToken), "the fake agent got the MCP token and printed it, twice");
  assert.deepEqual(leaks(dir, [KEY, MCP_TOKEN]), [], "no file under the project holds a secret value");
  const runFiles = filesUnder(runPath(dir));
  const redacted = (f: string) => fs.readFileSync(runPath(dir, f), "utf8").includes("[redacted]");
  const claudeStreams = runFiles.filter((f) => /\.claude\.(stdout|stderr)$/.test(f));
  assert.ok(claudeStreams.length >= 4, `the agent's streams were written (${claudeStreams.join(", ")})`);
  for (const f of claudeStreams) assert.ok(redacted(f), `${f} has [redacted] where the value was`);
  assert.ok(runFiles.some((f) => f.startsWith("phases/") && f.endsWith(".output.txt") && redacted(f)), "the saved exchange of the first attempt has [redacted]");
  const gateLogs = runFiles.filter((f) => f.startsWith("gate-logs/") && f.endsWith(".log"));
  assert.ok(gateLogs.some((f) => f.endsWith(".out.log")) && gateLogs.some((f) => f.endsWith("check.log")), `the gate's logs were written (${gateLogs.join(", ")})`);
  for (const f of gateLogs) assert.ok(redacted(f), `${f} has [redacted] where the value was`);
  // The text around the value survives: the redactor held the tail back and flushed it at close.
  assert.ok(runFiles.filter((f) => f.endsWith(".claude.stderr")).every((f) => fs.readFileSync(runPath(dir, f), "utf8").includes("starting with [redacted] as the token")));
});

// @req REQ-engine-005
test("REQ-engine-005 AC-1: with umask 000 the run folder is 0700 and its stream, exchange, prompt and gate log files 0600", { timeout: 120_000 }, async () => {
  const { dir } = await runWithSecrets();
  const rd = runPath(dir);
  assert.equal(mode(rd), 0o700, "the run folder");
  const files = filesUnder(rd).filter((f) => /\.(stdout|stderr)$/.test(f) || f.startsWith("phases/") || f.startsWith("gate-logs/") || /prompt/.test(f));
  assert.ok(files.some((f) => f.endsWith(".stdout")) && files.some((f) => f.startsWith("phases/") && f.endsWith(".prompt.md")) && files.some((f) => f.startsWith("gate-logs/")), files.join(", "));
  assert.deepEqual(files.filter((f) => mode(path.join(rd, f)) !== 0o600).map((f) => `${f} ${mode(path.join(rd, f)).toString(8)}`), [], "every such file is 0600");
  for (const sub of ["phases", "gate-logs"]) assert.equal(mode(path.join(rd, sub)), 0o700, sub);
  // `state.json`, the artifacts, their plain copies and the schema files are 0600 too.
  const all = filesUnder(rd);
  assert.ok(["state.json", "brief.json"].every((f) => all.includes(f)) && all.some((f) => f.startsWith("artifacts/")) && all.some((f) => f.startsWith("schemas/")), all.join(", "));
  assert.deepEqual(all.filter((f) => mode(path.join(rd, f)) !== 0o600).map((f) => `${f} ${mode(path.join(rd, f)).toString(8)}`), [], "every file of the run folder is 0600");
});

// @req REQ-engine-006
test("REQ-engine-006 AC-2: the Claude harness's --mcp-config is under .mergewright/local/ (0600), not in the run folder, and is gone after the phase", { timeout: 120_000 }, async () => {
  const { dir, record } = await runWithSecrets();
  const calls = fs.readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cfg: string | null; mode: number | null; argvHas: boolean });
  assert.ok(calls.length >= 2);
  const local = path.join(dir, ".mergewright", "local") + path.sep;
  for (const c of calls) {
    assert.ok(c.cfg, "an MCP config was passed");
    assert.ok(path.resolve(c.cfg!).startsWith(local), `it is in this machine's local folder: ${c.cfg}`);
    assert.ok(!path.resolve(c.cfg!).startsWith(path.join(dir, ".mergewright", "runs")), "not in the synced runs folder");
    assert.equal(c.mode, 0o600, "private while the agent ran (umask 000)");
    assert.equal(c.argvHas, false, "no secret on claude's command line");
    assert.equal(fs.existsSync(c.cfg!), false, "removed when the phase ended");
  }
  assert.deepEqual(filesUnder(runPath(dir)).filter((f) => f.endsWith("mcp.json")), [], "no MCP config in the run folder");
});

/** A request for the claude or codex harness in a project's run folder `<root>/.mergewright/runs/DEMO-1`. */
function harnessReq(root: string, runs: "claude" | "codex", over: Partial<HarnessRequest> = {}): HarnessRequest {
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd, { recursive: true });
  const r: Role = { id: "reviewer", description: "", runs, mode: "advise", output: "text", limits: {}, mcps: [], args: [], prompt: "", file: "roles/reviewer.role.md", origin: "project" };
  return { role: r, prompt: "look", cwd, mode: "advise", outputKind: "text", limits: { minutes: 1 }, env: {}, runDir: path.join(root, ".mergewright", "runs", "DEMO-1"), label: "3-review-reviewer", ...over };
}

const VAULT: Mcp = { id: "vault", description: "", transport: "stdio", command: "vault-mcp", args: [], env: { VAULT_TOKEN: "${MW_TEST_MCP_TOKEN}" }, headers: {}, roles: "all", enabled: true, file: "mcps/vault.mcp.yaml", origin: "project" };
const NOTES: Mcp = { id: "notes", description: "", transport: "http", url: "http://notes.invalid/mcp", args: [], env: {}, headers: { Authorization: "Bearer ${MW_TEST_MCP_TOKEN}" }, roles: "all", enabled: true, file: "mcps/notes.mcp.yaml", origin: "project" };

// @req REQ-engine-006
test("REQ-engine-006 AC-2: the Claude harness removes its MCP config when the agent fails and when the phase is stopped", { timeout: 60_000 }, async () => {
  for (const how of ["fail", "abort"] as const) {
    const root = tmpDir("mw-claude-mcp-");
    const seen = path.join(root, "seen.txt");
    const js = `import fs from "node:fs";
const a = process.argv.slice(2); const i = a.indexOf("--mcp-config");
fs.writeFileSync(${JSON.stringify(seen)}, a[i + 1]);
${how === "fail" ? "process.stderr.write('broken\\\\n'); process.exit(3);" : "setInterval(() => {}, 1000);"}
`;
    const ctl = new AbortController();
    const req = harnessReq(root, "claude", { mcp: wireMcps([VAULT]), signal: ctl.signal });
    const r = await withFakes({ claude: js }, async () => {
      const p = claude.run(req);
      if (how === "abort") {
        const deadline = Date.now() + 20_000;
        while (!fs.existsSync(seen) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 25));
        ctl.abort();
      }
      return p;
    });
    assert.equal(r.ok, false, how);
    const cfg = fs.readFileSync(seen, "utf8");
    assert.ok(cfg.startsWith(path.join(root, ".mergewright", "local") + path.sep), `${how}: ${cfg}`);
    assert.equal(fs.existsSync(cfg), false, `${how}: the MCP config is gone`);
  }
});

// @req REQ-engine-006
test("REQ-engine-006 AC-3: Codex gets MCP env and header values, referenced or literal, through its environment, never in its arguments", { timeout: 60_000 }, async () => {
  const root = tmpDir("mw-codex-mcp-");
  const rec = path.join(tmpDir("mw-codex-rec-"), "argv.json");
  // The fake records whether each variable holds the expected value by hash, so no value is written anywhere.
  const sha = (v: string) => createHash("sha256").update(v).digest("hex");
  const js = `import fs from "node:fs";
import { createHash } from "node:crypto";
const a = process.argv.slice(2);
const sha = (v) => v === undefined ? null : createHash("sha256").update(v).digest("hex");
const e = process.env;
fs.writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ argv: a, env: { VAULT_TOKEN: sha(e.VAULT_TOKEN), VAULT_LITERAL: sha(e.VAULT_LITERAL), AUTH: sha(e.MW_MCP_NOTES_AUTHORIZATION), APIKEY: sha(e.MW_MCP_NOTES_X_API_KEY) } }));
const o = a[a.indexOf("-o") + 1];
fs.writeFileSync(o, "fine");
`;
  const home = tmpDir("mw-codex-owner-");
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    // A literal token in `env` and a literal header value are kept off argv too.
    const vault: Mcp = { ...VAULT, env: { ...VAULT.env, VAULT_LITERAL: LITERAL_TOKEN } };
    const notes: Mcp = { ...NOTES, headers: { ...NOTES.headers, "X-Api-Key": LITERAL_HEADER } };
    const mcp = wireMcps([vault, notes]);
    const r = await withFakes({ codex: js }, () => codex.run(harnessReq(root, "codex", { mcp })));
    assert.equal(r.ok, true, r.error);
    const got = JSON.parse(fs.readFileSync(rec, "utf8")) as { argv: string[]; env: Record<string, string | null> };
    for (const [what, v] of [["the referenced MCP token", MCP_TOKEN], ["the literal env token", LITERAL_TOKEN], ["the literal header value", LITERAL_HEADER]] as const) {
      assert.equal(got.argv.some((x) => x.includes(v)), false, `${what} is not in codex's arguments`);
    }
    assert.deepEqual(got.env, { VAULT_TOKEN: sha(MCP_TOKEN), VAULT_LITERAL: sha(LITERAL_TOKEN), AUTH: sha(`Bearer ${MCP_TOKEN}`), APIKEY: sha(LITERAL_HEADER) }, "every value reaches codex through its environment");
    assert.ok(got.argv.includes('mcp_servers.vault.env_vars=["VAULT_TOKEN", "VAULT_LITERAL"]'), "the stdio server's variables are named");
    assert.ok(got.argv.includes('mcp_servers.notes.env_http_headers={"Authorization" = "MW_MCP_NOTES_AUTHORIZATION", "X-Api-Key" = "MW_MCP_NOTES_X_API_KEY"}'), "the headers are named, their values come from the environment");
    assert.equal(got.argv.some((x) => /mcp_servers\.\w+\.(env|http_headers)=/.test(x)), false, "no inline env or header table");
    assert.deepEqual(leaks(root, [MCP_TOKEN, LITERAL_TOKEN, LITERAL_HEADER]), [], "nor in any file the run wrote");
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
  }
});

// @req REQ-engine-006
test("REQ-engine-006 AC-1: secretsFor() lists the literal env and header values of the project's MCP servers (six characters or more)", () => {
  const dir = project();
  write(dir, "mcps/lit.mcp.yaml", `id: lit\ntransport: stdio\ncommand: lit-mcp\nenv:\n  LIT_TOKEN: "${process.env.MW_TEST_MCP_LITERAL}"\n  LIT_MODE: "abc"\n`);
  write(dir, "mcps/hdr.mcp.yaml", `id: hdr\ntransport: http\nurl: http://hdr.invalid/mcp\nheaders:\n  X-Api-Key: "${process.env.MW_TEST_MCP_HEADER}"\n`);
  const got = secretsFor(new Project(dir), undefined, {});
  assert.ok(got.includes(LITERAL_TOKEN), "the literal env value is listed");
  assert.ok(got.includes(LITERAL_HEADER), "the literal header value is listed");
  assert.equal(got.includes("abc"), false, "a value shorter than six characters is not");
});

// @req REQ-engine-005
test("REQ-engine-005 AC-2: a stream writer never writes through a symbolic link left in a run folder", () => {
  const root = tmpDir("mw-symlink-");
  const rd = path.join(root, ".mergewright", "runs", "DEMO-1");
  fs.mkdirSync(rd, { recursive: true });
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "untouched\n", { mode: 0o644 });
  const stream = path.join(rd, "3-review-reviewer.claude.stdout");
  fs.symlinkSync(outside, stream);
  const s = streamFile(stream);
  s.write(Buffer.from("agent output\n"));
  s.close();
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched\n", "the link's target is unchanged");
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644, "and keeps its mode");
  const st = fs.lstatSync(stream);
  assert.ok(st.isFile() && !st.isSymbolicLink(), "the stream is a regular file now");
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(stream, "utf8"), "agent output\n");
});

// @req REQ-engine-006
test("REQ-engine-006 AC-1: a value split across two chunks at every position is redacted by streamFile()", () => {
  const dir = tmpDir("mw-split-");
  for (let i = 1; i < MCP_TOKEN.length; i++) {
    const file = path.join(dir, `split-${i}.stdout`);
    const s = (streamFile as (f: string, secrets?: readonly string[]) => ReturnType<typeof streamFile>)(file, [MCP_TOKEN, KEY]);
    s.write(Buffer.from(`before ${MCP_TOKEN.slice(0, i)}`));
    s.write(Buffer.from(`${MCP_TOKEN.slice(i)} after`));
    s.close();
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes(MCP_TOKEN), false, `split at ${i}: the value is not in the file`);
    assert.ok(text === "before [redacted] after", `split at ${i}: the text around the value is kept`);
  }
});

// @req REQ-engine-006
test("REQ-engine-006 AC-1: an agent stopped after printing a split value: the stream is flushed redacted on the kill path", { timeout: 30_000 }, async () => {
  const root = tmpDir("mw-kill-");
  const req = { ...harnessReq(root, "claude"), secrets: [MCP_TOKEN] } as HarnessRequest;
  const ctl = new AbortController();
  const h = Math.floor(MCP_TOKEN.length / 2);
  const p = runCli({ harness: "t", cmd: "bash", args: ["-c", `printf 'x %s' "${MCP_TOKEN.slice(0, h)}"; sleep 0.2; printf '%s END' "${MCP_TOKEN.slice(h)}"; sleep 60`], req: { ...req, signal: ctl.signal }, env });
  const out = path.join(req.runDir, "3-review-reviewer.t.stdout");
  // Everything printed is shorter than the longest secret, so the redactor holds it all back until close.
  await new Promise((r) => setTimeout(r, 800));
  ctl.abort();
  const r = await p;
  assert.equal(r.aborted, true);
  assert.ok(fs.readFileSync(out, "utf8") === "x [redacted] END", "what was held back was written at close, redacted");
});

// @req REQ-engine-006
test("REQ-engine-006 AC-1: a saved exchange is redacted and private", () => {
  const dir = tmpDir("mw-exchange-");
  (saveExchange as (d: string, l: string, p: string, o?: string, s?: readonly string[]) => void)(dir, "1-brief-planner", `use ${KEY} please`, `I saw ${MCP_TOKEN}`, [KEY, MCP_TOKEN]);
  assert.deepEqual(leaks(dir, [KEY, MCP_TOKEN]), []);
  assert.ok(fs.readFileSync(path.join(dir, "phases", "1-brief-planner.prompt.md"), "utf8") === "use [redacted] please", "the prompt");
  assert.ok(fs.readFileSync(path.join(dir, "phases", "1-brief-planner.output.txt"), "utf8") === "I saw [redacted]", "the reply");
  for (const f of ["prompt.md", "output.txt"]) assert.equal(mode(path.join(dir, "phases", `1-brief-planner.${f}`)), 0o600, f);
});

// @req REQ-engine-005
test("REQ-engine-005 AC-2: a resumed run narrows a run folder an earlier runtime left 0777/0666 before writing", { timeout: 120_000 }, async () => {
  const dir = project();
  useScript(script());
  const first = await run(dir, { until: "gate" });
  assert.equal(first.status, "running", "stopped before the gate, to be resumed");
  const rd = runPath(dir);
  fs.mkdirSync(path.join(rd, "gate-logs"), { recursive: true });
  fs.writeFileSync(path.join(rd, "0-old.claude.stdout"), "old\n");
  fs.writeFileSync(path.join(rd, "gate-logs", "old.out.log"), "old\n");
  const widen = (d: string) => {
    fs.chmodSync(d, 0o777);
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) widen(p);
      else fs.chmodSync(p, 0o666);
    }
  };
  widen(rd);
  const leftovers = filesUnder(rd);
  await withUmask(0o000, () => run(dir));
  assert.equal(mode(rd), 0o700, "the run folder");
  for (const sub of ["phases", "gate-logs", "artifacts"]) assert.equal(mode(path.join(rd, sub)), 0o700, sub);
  for (const f of ["0-old.claude.stdout", "gate-logs/old.out.log", ...leftovers.filter((f) => f.startsWith("phases/"))]) {
    assert.equal(mode(path.join(rd, f)), 0o600, f);
  }
  // Files the resumed run rewrote (state.json, artifacts, plain copies) are 0600 as well.
  const all = filesUnder(rd);
  assert.ok(all.includes("state.json") && all.includes("handoff.json") && all.some((f) => f.startsWith("artifacts/")), all.join(", "));
  assert.deepEqual(all.filter((f) => mode(path.join(rd, f)) !== 0o600).map((f) => `${f} ${mode(path.join(rd, f)).toString(8)}`), [], "every file of the run folder is 0600");
});

// @req REQ-engine-007
test("REQ-engine-007 AC-1, AC-2: 'mw work' prunes old raw streams of finished runs only, keeping state, artifacts and the audit trail", { timeout: 60_000 }, async () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, "mergewright.yaml"), fs.readFileSync(path.join(dir, "mergewright.yaml"), "utf8").replace("\ntrace:\n", "\ntrace:\n  raw_days: 10\n"));
  git(dir, "commit", "-q", "-am", "raw_days");
  const runs = path.join(dir, ".mergewright", "runs");
  const old = (Date.now() - 30 * 86_400_000) / 1000;
  const recent = (Date.now() - 5 * 86_400_000) / 1000;
  const status: Record<string, string | undefined> = { "OLD-1": "done", "OLD-2": "aborted", "OLD-3": "running", "OLD-4": "waiting", "OLD-5": "blocked", "OLD-6": "weird", "OLD-7": undefined };
  const kept = ["state.json", "artifacts/brief-abc.json", "brief.json", "phases/1-brief-planner.prompt.md", "phases/1-brief-planner.output.txt", "gate-logs/default.out.log"];
  for (const [id, st] of Object.entries(status)) {
    const d = path.join(runs, id);
    fs.mkdirSync(path.join(d, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(d, "phases"), { recursive: true });
    fs.mkdirSync(path.join(d, "gate-logs"), { recursive: true });
    for (const f of kept.slice(1)) fs.writeFileSync(path.join(d, f), "x\n");
    fs.writeFileSync(path.join(d, "state.json"), st === undefined ? "{ not json" : JSON.stringify({ card: id, flow: "standard", phase: 0, round: 0, status: st, approvals: [], history: [], warnings: [] }));
    for (const f of ["1-brief-planner.claude.stdout", "1-brief-planner.claude.stderr", "2-implement-worker.codex.stdout", "fresh.claude.stdout"]) fs.writeFileSync(path.join(d, f), "raw\n");
    for (const f of filesUnder(d)) if (!f.startsWith("fresh")) fs.utimesSync(path.join(d, f), old, old);
    fs.utimesSync(path.join(d, "fresh.claude.stdout"), recent, recent);
  }
  const lines: string[] = [];
  const r = await work(dir, { out: (l) => lines.push(l), hub: () => fakeHub(), integrations: () => fakeIntegrations() });
  assert.equal(r.runs.length, 0);
  for (const id of ["OLD-1", "OLD-2"]) {
    const left = filesUnder(path.join(runs, id)).sort();
    assert.deepEqual(left, [...kept, "fresh.claude.stdout"].sort(), `${id}: old raw streams went, the rest stayed`);
  }
  for (const id of ["OLD-3", "OLD-4", "OLD-5", "OLD-6", "OLD-7"]) {
    const left = filesUnder(path.join(runs, id));
    assert.equal(left.filter((f) => /\.(stdout|stderr)$/.test(f)).length, 4, `${id} (${status[id] ?? "unreadable"}): its streams are kept whatever their age`);
  }
  assert.ok(lines.some((l) => /removed 6 raw stream file\(s\) older than 10 day\(s\)/.test(l)), lines.join("\n"));
});

/** A finished run of `id` whose state, artifact, exchange, gate log and raw streams are 30 days old. */
function oldFinishedRun(dir: string, id: string): { run: string; streams: string[]; kept: string[] } {
  const run = path.join(dir, ".mergewright", "runs", id);
  const kept = ["state.json", "artifacts/brief-abc.json", "phases/1-brief-planner.prompt.md", "gate-logs/default.out.log"];
  const streams = ["1-brief-planner.claude.stdout", "1-brief-planner.claude.stderr"];
  for (const f of [...kept.slice(1), ...streams]) write(run, f, `${f} content\n`);
  write(run, "state.json", JSON.stringify({ card: id, flow: "standard", phase: 0, round: 0, status: "done", approvals: [], history: [], warnings: [] }));
  const old = (Date.now() - 30 * 86_400_000) / 1000;
  for (const f of [...kept, ...streams]) fs.utimesSync(path.join(run, f), old, old);
  return { run, streams, kept };
}

// @req REQ-engine-007
test("REQ-engine-007 AC-1: the pruner skips a finished run whose run lock a live process holds and deletes none of its streams", () => {
  const dir = project();
  const { run, streams, kept } = oldFinishedRun(dir, "LOCK-1");
  const p = new Project(dir);
  const release = acquireLock(lockFile(p, "LOCK-1"), "LOCK-1"); // held by this (live) process
  let r: ReturnType<typeof pruneRawStreams>;
  try {
    r = pruneRawStreams(p, 14);
  } finally {
    release();
  }
  assert.deepEqual(r.removed, [], "nothing was removed while the lock was held");
  assert.deepEqual(r.skipped, ["LOCK-1"]);
  for (const f of [...streams, ...kept.slice(1)]) assert.equal(fs.readFileSync(path.join(run, f), "utf8"), `${f} content\n`, `${f} is still there, unchanged`);
  assert.equal(fs.existsSync(lockFile(p, "LOCK-1")), false, "the holder's release removed the lock");
});

// @req REQ-engine-007
test("REQ-engine-007 AC-1: without a live holder (no lock, or one left by a dead process) the pruner removes the old streams, keeps the rest and releases the lock", () => {
  const dir = project();
  const free = oldFinishedRun(dir, "FREE-1");
  const stale = oldFinishedRun(dir, "STALE-1");
  const p = new Project(dir);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.ok(dead && !alive(dead), "the child that names the stale lock has exited");
  write(path.dirname(lockFile(p, "STALE-1")), path.basename(lockFile(p, "STALE-1")), JSON.stringify({ pid: dead, host: "here", started: new Date().toISOString() }) + "\n");
  const running = oldFinishedRun(dir, "RUN-1"); // a running card with no lock: kept whole, its lock not left behind
  const runState = path.join(running.run, "state.json");
  fs.writeFileSync(runState, fs.readFileSync(runState, "utf8").replace('"status":"done"', '"status":"running"'));
  const r = pruneRawStreams(p, 14);
  for (const f of [...running.streams, ...running.kept]) assert.ok(fs.existsSync(path.join(running.run, f)), `RUN-1: ${f} is kept`);
  assert.equal(fs.existsSync(lockFile(p, "RUN-1")), false, "RUN-1: the lock taken to read its state was released");
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.problems, []);
  for (const { run, streams, kept } of [free, stale]) {
    for (const f of streams) assert.equal(fs.existsSync(path.join(run, f)), false, `${f} was removed`);
    for (const f of kept) assert.ok(fs.existsSync(path.join(run, f)), `${f} is kept`);
  }
  assert.equal(r.removed.length, 4);
  for (const id of ["FREE-1", "STALE-1"]) assert.equal(fs.existsSync(lockFile(p, id)), false, `${id}: the pruner released the lock it took`);
});

// @req REQ-engine-006
test("REQ-engine-006 AC-1: Codex writes its reply (-o) outside the run folder; while it runs no file under .mergewright/runs holds the secret, and only a redacted copy stays", { timeout: 60_000 }, async () => {
  const root = tmpDir("mw-codex-reply-");
  const runs = path.join(root, ".mergewright", "runs");
  const rec = path.join(root, "seen.json");
  // The fake writes the secret it gets through its environment into -o, then looks for it under runs/.
  const js = `import fs from "node:fs"; import path from "node:path";
const a = process.argv.slice(2);
const o = a[a.indexOf("-o") + 1];
const v = process.env.VAULT_TOKEN ?? "";
fs.writeFileSync(o, "the token is " + v + "\\n");
const hits = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && v && fs.readFileSync(p, "latin1").includes(v)) hits.push(path.relative(${JSON.stringify(runs)}, p)); } };
walk(${JSON.stringify(runs)});
fs.writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ hasToken: v !== "", hits, replyMode: fs.statSync(o).mode & 0o777 }));
`;
  const home = tmpDir("mw-codex-owner-");
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const req = harnessReq(root, "codex", { mcp: wireMcps([VAULT]), secrets: [MCP_TOKEN] });
    const r = await withUmask(0o000, () => withFakes({ codex: js }, () => codex.run(req)));
    assert.equal(r.ok, true, r.error);
    const seen = JSON.parse(fs.readFileSync(rec, "utf8")) as { hasToken: boolean; hits: string[]; replyMode: number };
    assert.equal(seen.hasToken, true, "the fake wrote the secret into its reply file");
    assert.deepEqual(seen.hits, [], "while codex ran, no file under .mergewright/runs held the secret");
    assert.equal(seen.replyMode, 0o600, "the reply file codex wrote into was private (umask 000)");
    assert.ok(!path.resolve(codexReplyFile(req)).startsWith(runs + path.sep), "-o is outside the runs folder");
    assert.equal(fs.existsSync(codexReplyFile(req)), false, "the scratch reply file is gone after the phase");
    assert.deepEqual(leaks(root, [MCP_TOKEN]), [], "afterwards no file under the project holds the secret");
    const copy = path.join(req.runDir, "3-review-reviewer.codex.reply");
    assert.ok(fs.readFileSync(copy, "utf8").includes("the token is [redacted]"), "the run folder keeps a redacted copy");
    assert.equal(mode(copy), 0o600);
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
  }
});

// @req REQ-engine-006
test("REQ-engine-006 AC-1: an agent that prints a configured key_env value on its last stderr line and fails leaves it in no file (state.json included) and no notification", { timeout: 120_000 }, async () => {
  const dir = project({ roles: { planner: { runs: "claude" } } });
  fs.appendFileSync(path.join(dir, "mergewright.yaml"), "local_models:\n  key_env: MW_TEST_LOCAL_KEY\n");
  git(dir, "commit", "-q", "-am", "key_env");
  // The fake lives outside the project; it reads the value from the test's environment through its own file.
  const valueFile = path.join(tmpDir("mw-fail-value-"), "v");
  fs.writeFileSync(valueFile, KEY);
  const js = `import fs from "node:fs";
try { fs.readFileSync(0); } catch {}
process.stderr.write("could not log in with " + fs.readFileSync(${JSON.stringify(valueFile)}, "utf8") + "\\n");
process.exit(2);
`;
  useScript(script());
  const integrations = fakeIntegrations();
  const st = await withFakes({ claude: js }, () => run(dir, {}, { integrations }));
  assert.notEqual(st.status, "done", "the planner failed");
  const stateText = fs.readFileSync(runPath(dir, "state.json"), "utf8");
  assert.ok(stateText.includes("[redacted]"), "the failure was recorded, with [redacted] where the value was");
  assert.deepEqual(leaks(dir, [KEY]), [], "no file under the project holds the value");
  assert.equal(JSON.stringify(integrations.calls).includes(KEY), false, "no notification or other integration call carries it");
  assert.equal(JSON.stringify(st).includes(KEY), false, "nor the returned state");
});

// @req REQ-engine-006
test("REQ-engine-006 AC-1: the forge's default token variables (GITHUB_TOKEN, GITEA_TOKEN) are redacted when git.forge.token_env is unset", { timeout: 120_000 }, async () => {
  const dir = project({ roles: { planner: { runs: "claude" } } });
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GITEA_TOKEN: process.env.GITEA_TOKEN };
  // Always fake values (never a real token of the machine running the tests), read from the environment.
  const gh = (process.env.GITHUB_TOKEN = `fakegh${randomBytes(12).toString("hex")}`);
  const gt = (process.env.GITEA_TOKEN = `fakegt${randomBytes(12).toString("hex")}`);
  try {
    const valueFile = path.join(tmpDir("mw-forge-value-"), "v");
    fs.writeFileSync(valueFile, `${process.env.GITHUB_TOKEN} and ${process.env.GITEA_TOKEN}`);
    const js = `import fs from "node:fs";
try { fs.readFileSync(0); } catch {}
const v = fs.readFileSync(${JSON.stringify(valueFile)}, "utf8");
process.stdout.write("token " + v + "\\n");
process.stderr.write("could not push with " + v + "\\n");
process.exit(2);
`;
    useScript(script());
    const st = await withFakes({ claude: js }, () => run(dir));
    assert.notEqual(st.status, "done", "the planner failed");
    const streams = filesUnder(runPath(dir)).filter((f) => /\.claude\.(stdout|stderr)$/.test(f));
    assert.ok(streams.length >= 2 && streams.every((f) => fs.readFileSync(runPath(dir, f), "utf8").includes("[redacted] and [redacted]")), `the streams were written, redacted (${streams.join(", ")})`);
    assert.deepEqual(leaks(dir, [gh, gt]), [], "no file under the project holds a default forge token value");
    assert.equal(JSON.stringify(st).includes(gh) || JSON.stringify(st).includes(gt), false, "nor the returned state");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// @req REQ-engine-005
test("REQ-engine-005 AC-2: a run folder that is a symbolic link is refused on resume; the directory it points to is not narrowed", { timeout: 120_000 }, async () => {
  const dir = project();
  useScript(script());
  const first = await run(dir, { until: "gate" });
  assert.equal(first.status, "running", "stopped before the gate, to be resumed");
  const rd = runPath(dir);
  const ext = path.join(tmpDir("mw-ext-run-"), "run");
  fs.cpSync(rd, ext, { recursive: true });
  fs.rmSync(rd, { recursive: true, force: true });
  fs.symlinkSync(ext, rd);
  const widen = (d: string) => {
    fs.chmodSync(d, 0o777);
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) widen(p);
      else fs.chmodSync(p, 0o666);
    }
  };
  widen(ext);
  const before = new Map([".", ...filesUnder(ext)].map((f) => [f, mode(path.join(ext, f))]));
  await assert.rejects(withUmask(0o000, () => run(dir)), (e: Error & { code?: string }) => e.code === "run/unsafe-path" && /symbolic link/.test(e.message));
  assert.equal(mode(ext), 0o777, "the external folder kept its mode");
  for (const [f, m] of before) assert.equal(mode(path.join(ext, f)), m, `${f} kept its mode`);
  assert.deepEqual(filesUnder(ext).sort(), [...before.keys()].filter((f) => f !== ".").sort(), "nothing was written into the external folder");
});

// @req REQ-engine-006
// @req REQ-engine-005
test("REQ-engine-006 AC-1: a gate writes its summary and step logs outside the run folder; while it runs nothing under .mergewright/runs holds the secret or is wider than 0600", { timeout: 60_000 }, async () => {
  const root = tmpDir("mw-gate-scratch-");
  const runs = path.join(root, ".mergewright", "runs");
  const runDir = path.join(runs, "GATE-1");
  const marks = tmpDir("mw-gate-marks-");
  const ready = path.join(marks, "ready");
  const go = path.join(marks, "go");
  const file = path.join(root, "secret.gate.sh");
  fs.writeFileSync(file, `#!/usr/bin/env bash
set -u
mkdir -p "$MERGEWRIGHT_GATE_LOGS"
log="$MERGEWRIGHT_GATE_LOGS/check.log"
printf 'log %s end\\n' "$MW_TEST_LOCAL_KEY" > "$log"
printf '{"ok":true,"steps":[{"name":"check","kind":"test","ok":true,"seconds":0,"log":"%s","note":"%s"}]}\\n' "$log" "$MW_TEST_LOCAL_KEY" > "$MERGEWRIGHT_GATE_JSON"
echo running
touch ${JSON.stringify(ready)}
for i in $(seq 1 200); do [ -e ${JSON.stringify(go)} ] && break; sleep 0.05; done
exit 0
`, { mode: 0o755 });
  const scratch = path.join(root, ".mergewright", "local", "scratch", "GATE-1");
  const pending = withUmask(0o000, () => runGate({ id: "default", file, cwd: root, runDir, base: "main", minutes: 1, env: { ...env, MW_TEST_LOCAL_KEY: KEY }, required: ["check"], secrets: [KEY] }));
  try {
    for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(ready), "the gate wrote its files and is waiting");
    assert.deepEqual(leaks(runs, [KEY]), [], "while the gate runs, no file under .mergewright/runs holds the secret");
    const wide = filesUnder(runs).filter((f) => (mode(path.join(runs, f)) & 0o077) !== 0);
    assert.deepEqual(wide, [], "while the gate runs, no run-folder file is wider than 0600");
    assert.ok(leaks(scratch, [KEY]).length > 0, "the gate wrote the secret into its own (scratch) files");
  } finally {
    fs.writeFileSync(go, "");
  }
  const g = await pending;
  assert.equal(g.ok, true, g.detail);
  const copy = path.join(runDir, "gate-logs", "check.log");
  const summary = path.join(runDir, "gate-logs", "default.gate.json");
  for (const f of [copy, summary]) {
    assert.ok(fs.readFileSync(f, "utf8").includes("[redacted]"), `${path.basename(f)}: a redacted copy`);
    assert.equal(mode(f), 0o600, path.basename(f));
  }
  assert.equal(g.json?.steps[0]?.log, copy, "the step's log is the run-folder copy");
  assert.ok(g.json?.steps[0]?.tail?.includes("log [redacted] end"), "its tail was read from the copy");
  assert.equal(fs.existsSync(scratch), false, "the scratch folder is gone");
  assert.deepEqual(leaks(root, [KEY]), [], "no file under the project holds the secret");
});

// ── Bounded delivery outbox (REQ-engine-008, REQ-engine-009) ──────────────────────────

const MEM0_KEY = "mem0-test-key-not-a-secret";
process.env.MW_TEST_MEM0_KEY = MEM0_KEY;

afterEach(() => {
  queueTiming.budgetMs = undefined;
});

/** Connections that arrived, each with what `probe` said at that moment. */
interface Blackhole {
  url: string;
  hits: { at: number; probe: unknown }[];
  close(): Promise<void>;
}

/**
 * A TCP server on 127.0.0.1 that accepts every connection and never answers. A hit is a connection
 * that sent a request (the HTTP client may open a spare connection it never uses).
 */
async function blackhole(probe: () => unknown = () => undefined): Promise<Blackhole> {
  const sockets = new Set<net.Socket>();
  const hits: Blackhole["hits"] = [];
  const server = net.createServer((s) => {
    s.once("data", () => hits.push({ at: Date.now(), probe: probe() }));
    sockets.add(s);
    s.on("error", () => undefined);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  const close = () => new Promise<void>((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  });
  after(close);
  return { url: `http://127.0.0.1:${port}`, hits, close };
}

/** Merge `patch` into the project's mergewright.yaml (top-level keys replaced or merged one level). */
const mem0At = (url: string) => mem0Config({ url, key_env: "MW_TEST_MEM0_KEY" });
const lesson = (title: string) => ({ topic: "testing", title, body: `${title}, because.` });
const qdir = (dir: string) => path.join(dir, ".mergewright", "local", "queue");
const bytesOf = (dir: string) => Object.fromEntries(queueFiles(dir).map((f) => [f, fs.readFileSync(path.join(qdir(dir), f), "utf8")]));

async function tool(dir: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, name);
  const ctx: ToolContext = { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined };
  const cwd = process.cwd();
  try {
    const r = await callTool(t, args, ctx);
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  } finally {
    process.chdir(cwd);
  }
}

/** `mw` as a child process, without blocking this process (the servers answer from here). */
function mwAsync(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, MW_ENV_FILE: "/dev/null" };
    delete env.MW_ROLE;
    delete env.MW_CARD;
    delete env.MW_MODE;
    const p = spawn(process.execPath, [MW, ...args], { cwd, env });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

// ── REQ-engine-009: mw work dispatches first, the flush is bounded ─────────────────────────────

const WORKER = `cat > /dev/null; mkdir -p src; echo "$MW_CARD" > "src/$MW_CARD.txt"; printf '%s' '${JSON.stringify(handoff({ summary: "Added the card file", changed: [] }))}'`;

test("mw work dispatches the ready card before it flushes; the flush stops at its budget and the rest stays queued, untouched", async () => {
  // @req REQ-engine-009
  assert.equal(FLUSH_BUDGET_MS, 20_000, "the default budget is 20 s");
  const dir = project({ roles: { worker: { runs: "shell", command: WORKER } } });
  // At each connection: was the card's work already merged into the checkout?
  const hole = await blackhole(() => fs.existsSync(path.join(dir, "src", "DEMO-1.txt")));
  patchConfig(dir, mem0At(hole.url));
  write(dir, "cards/DEMO-1.card.md", read(dir, "cards/DEMO-1.card.md").replace("status: todo", "status: ready"));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "ready, mem0 down");
  useScript(script());
  const q = new Queue(localDir(new Project(dir)));
  const first = q.add("mem0", "mem0 (demo): 1 lesson(s): First", { lessons: [lesson("First")] });
  const second = q.add("mem0", "mem0 (demo): 1 lesson(s): Second", { lessons: [lesson("Second")] });
  const secondBytes = fs.readFileSync(second, "utf8");

  queueTiming.budgetMs = 400; // the 20 s budget, shortened; mem0's own read timeout is 10 s
  const lines: string[] = [];
  const t0 = Date.now();
  const r = await work(dir, { out: (l) => lines.push(l), integrations: () => fakeIntegrations() });
  const t1 = Date.now();
  assert.equal(r.code, 0, lines.join("\n"));
  assert.deepEqual(r.runs.map((x) => `${x.id}:${x.status}`), ["DEMO-1:done"]);
  // Two passes: the card's (flushed after the card), then the idle one that ends the command (flushed
  // too). Each flush sent one request, for the first item, and ran out of budget on it.
  assert.equal(hole.hits.length, 2, "one request per flush: the second item was never tried");
  assert.deepEqual(hole.hits.map((h) => h.probe), [true, true], "the card was dispatched (and merged) before the queue was flushed");
  assert.ok(t1 - hole.hits[1]!.at < 3_000, `the flush ended at its budget, not at mem0's timeout (${t1 - hole.hits[1]!.at} ms)`);
  assert.ok(t1 - t0 < 9_000, `the passes took ${t1 - t0} ms`);
  const items = new Queue(localDir(new Project(dir))).list();
  assert.deepEqual(items.map((i) => i.file), [first, second], "both still queued");
  assert.equal(items[0]!.item.attempts, 2, "the item in flight when the budget ran out counts an attempt each time");
  assert.match(items[0]!.item.lastError ?? "", /stopped \(the flush's time budget ran out\)/);
  assert.equal(fs.readFileSync(second, "utf8"), secondBytes, "the item the budget skipped is byte-for-byte unchanged");
  assert.deepEqual(new Queue(localDir(new Project(dir))).breakers(), {}, "a cut by the budget is not a timeout of the service");
});

test("a flush whose budget is already spent sends nothing and leaves every item byte-for-byte as it was", async () => {
  // @req REQ-engine-009
  const hole = await blackhole();
  const { dir, project: p } = projectWith(mem0At(hole.url));
  const q = new Queue(localDir(p));
  q.add("mem0", "one", { lessons: [lesson("One")] });
  q.add("notify", "two", { subject: "s", body: "b" });
  const before = bytesOf(dir);
  const r = await flushQueue(p, { budgetMs: 0 });
  assert.deepEqual(r.map((x) => x.skipped), ["budget", "budget"]);
  assert.equal(hole.hits.length, 0);
  assert.deepEqual(bytesOf(dir), before);
});

// ── REQ-engine-009: the per-kind breaker ───────────────────────────────────────────────────

/** Deliverers that send one request to `url` with a short timeout (a blackhole times out). */
const viaHttp = (url: string) => async () => { await httpJson(url, { method: "POST", body: {}, timeoutMs: 100 }); };

test("two timeouts in a row skip the kind for 10 minutes without a request, other kinds go on, then it is tried again", async () => {
  // @req REQ-engine-009
  const hole = await blackhole();
  const ok = await mockServer(() => ({ body: {} }));
  after(() => ok.close());
  const { dir, project: p } = projectWith();
  const q = new Queue(localDir(p));
  const item = q.add("mem0", "mem0 lesson", { lessons: [lesson("A")] });
  const deliverers = { mem0: viaHttp(hole.url), letta: viaHttp(ok.url) };
  let clock = Date.parse("2026-10-09T10:00:00Z");
  const now = () => clock;

  const r1 = await q.flush(deliverers, { now });
  assert.match(r1[0]!.error ?? "", /timed out/);
  assert.equal(hole.hits.length, 1);
  assert.deepEqual(q.breakers(), { mem0: { timeouts: 1 } }, "one timeout does not open the breaker");
  clock += 1_000;
  await q.flush(deliverers, { now });
  assert.equal(hole.hits.length, 2);
  const tripped = clock;
  assert.deepEqual(q.breakers(), { mem0: { timeouts: 2, skipUntil: tripped + BREAKER_SKIP_MS } });
  assert.equal(BREAKER_SKIP_MS, 10 * 60_000);

  // Within the 10 minutes: mem0 is skipped without a request; a letta item is delivered as usual.
  const before = fs.readFileSync(item, "utf8");
  q.add("letta", "letta lesson", { lessons: [lesson("B")] });
  clock = tripped + 9 * 60_000;
  const r3 = await q.flush(deliverers, { now });
  assert.equal(hole.hits.length, 2, "no request to the open kind");
  assert.deepEqual(r3.map((x) => [x.kind, x.ok, x.skipped]), [["mem0", false, "breaker"], ["letta", true, undefined]]);
  assert.equal(fs.readFileSync(item, "utf8"), before, "the skipped item is untouched");
  assert.equal(JSON.parse(before).attempts, 2);

  // After the window it is tried again.
  clock = tripped + BREAKER_SKIP_MS;
  const r4 = await q.flush(deliverers, { now });
  assert.equal(hole.hits.length, 3, "tried again after 10 minutes");
  assert.equal(r4[0]!.skipped, undefined);
  assert.equal(new Queue(localDir(p)).list()[0]!.item.attempts, 3);
  assert.equal(queueItems(dir).length, 1);
});

test("only timeouts count: a refused connection or a success resets the count, and one kind never opens another's breaker", async () => {
  // @req REQ-engine-009
  const hole = await blackhole();
  const { project: p } = projectWith();
  const q = new Queue(localDir(p));
  q.add("mem0", "m", { lessons: [lesson("A")] });
  q.add("letta", "l", { lessons: [lesson("B")] });
  let mem0 = viaHttp(hole.url);
  const refused = async () => { throw new HttpError(0, "POST http://127.0.0.1:1/: ECONNREFUSED"); };
  await q.flush({ mem0, letta: refused });
  assert.deepEqual(q.breakers(), { mem0: { timeouts: 1 } }, "letta's refusal is not a timeout");
  await q.flush({ mem0: refused, letta: refused });
  assert.deepEqual(q.breakers(), {}, "mem0's refusal reset its count");
  await q.flush({ mem0, letta: refused });
  mem0 = async () => undefined;
  await q.flush({ mem0, letta: refused });
  assert.deepEqual(q.breakers(), {}, "a success reset it too");
  assert.equal(fs.existsSync(path.join(q.dir, ".breaker")), false, "no state left behind when no kind counts");
});

test("after a restart a new Queue lists every item the budget or the breaker skipped, with its attempt count, and the breaker still holds", async () => {
  // @req REQ-engine-009
  const hole = await blackhole();
  const { dir, project: p } = projectWith();
  let clock = Date.parse("2026-10-09T12:00:00Z");
  const now = () => clock;
  const q = new Queue(localDir(p));
  const a = q.add("mem0", "a", { lessons: [lesson("A")] });
  await q.flush({ mem0: viaHttp(hole.url) }, { now });
  await q.flush({ mem0: viaHttp(hole.url) }, { now });
  const b = q.add("notify", "b", { subject: "s", body: "b" });
  const c = q.add("notify", "c", { subject: "s", body: "c" });
  const r = await q.flush({ mem0: viaHttp(hole.url), notify: async () => { throw new Error("down"); } }, { now, budgetMs: 0 });
  assert.deepEqual(r.map((x) => x.skipped), ["budget", "budget", "budget"]);

  // "Restart": nothing of this Queue object is used again.
  const fresh = new Queue(localDir(new Project(dir)));
  assert.deepEqual(fresh.list().map((x) => [x.file, x.item.attempts]), [[a, 2], [b, 0], [c, 0]]);
  assert.equal(fresh.breakers().mem0?.timeouts, 2);
  clock += 60_000;
  const again = await fresh.flush({ mem0: viaHttp(hole.url), notify: async () => undefined }, { now });
  assert.equal(hole.hits.length, 2, "the breaker opened before the restart still skips mem0");
  assert.deepEqual(again.map((x) => [x.kind, x.ok, x.skipped]), [["mem0", false, "breaker"], ["notify", true, undefined], ["notify", true, undefined]]);
  assert.deepEqual(fresh.list().map((x) => [x.file, x.item.attempts]), [[a, 2]]);
});

// ── REQ-engine-008: locked tools queue under the lock and deliver after it ─────────────────────

test("mw_memory_add replies at once that the delivery is queued; the delivery starts only after the lock is released and leaves the item queued", async () => {
  // @req REQ-engine-008
  let dir = "";
  const hole = await blackhole(() => fs.existsSync(repoLockFile({ root: dir })));
  dir = projectWith({ packages: { ...mem0At(hole.url).packages, letta: { url: hole.url } } }).dir;
  queueTiming.budgetMs = 300;
  const t0 = Date.now();
  const r = await tool(dir, "mw_memory_add", { kind: "lesson", topic: "testing", title: "Queue it", body: "Deliver after the lock." });
  const took = Date.now() - t0;
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /lesson added in memory\/lessons/);
  assert.match(r.text, /queued for mem0, queued for letta\n.*the delivery starts now, in the background, after the repository lock and the lease were released/);
  assert.ok(took < 3_000, `the reply came after ${took} ms, without waiting for mem0 or Letta`);
  assert.match(git(dir, "log", "-1", "--format=%s"), /^memory: Queue it$/);
  assert.equal(fs.existsSync(repoLockFile({ root: dir })), false);
  const names = fs.readdirSync(qdir(dir));
  assert.equal(names.filter((n) => /\.json(\.claimed-\d+)?$/.test(n)).length, 2, `one item per service: ${names.join(", ")}`);

  await settleDeliveries();
  assert.ok(hole.hits.length >= 1, "the delivery was attempted");
  assert.deepEqual(hole.hits.map((h) => h.probe), hole.hits.map(() => false), "no connection arrived while the repository lock existed");
  // The delivery is bounded too: mem0's item was tried and cut at the budget, Letta's was not reached.
  assert.equal(hole.hits.length, 1);
  assert.deepEqual(queueItems(dir).map((i) => [i.kind, i.attempts]), [["mem0", 1], ["letta", 0]], "both still queued, with their attempt counts");
});

test("every route that stores a lesson through storeMemory sends nothing while the repository lock is held", async () => {
  // @req REQ-engine-008
  // Routes (grep storeMemory|pushMemory|enqueueMemory in src/): mw_memory_add (locked: enqueueMemory),
  // mw_memory_push, 'mw memory add', 'mw memory push' (no lock: storeMemory). storeMemory itself only
  // queues when called under the lock.
  let dir = "";
  const seen: boolean[] = [];
  const store: unknown[] = [];
  const mem0 = await mockServer((req) => {
    seen.push(fs.existsSync(repoLockFile({ root: dir })));
    if (req.method === "GET") return { body: { results: [] } };
    store.push(req.body);
    return { body: { results: [{ id: `m${store.length}` }] } };
  });
  after(() => mem0.close());
  dir = projectWith(mem0At(mem0.url)).dir;

  const viaTool = await tool(dir, "mw_memory_add", { kind: "lesson", topic: "testing", title: "One", body: "First." });
  assert.equal(viaTool.isError, false, viaTool.text);
  await settleDeliveries();
  assert.equal(store.length, 1, "mw_memory_add delivered after the lock");
  const push = await tool(dir, "mw_memory_push", { service: "mem0" });
  assert.equal(push.isError, false, push.text);
  const add = await mwAsync(dir, ["memory", "add", "lesson", "--topic", "testing", "--title", "Two", "--body", "Second."]);
  assert.equal(add.code, 0, add.err);
  const cliPush = await mwAsync(dir, ["memory", "push"]);
  assert.equal(cliPush.code, 0, cliPush.err);
  assert.ok(seen.length >= 4, `requests: ${seen.length}`);
  assert.ok(seen.every((locked) => !locked), "no request while the repository lock existed");

  // Under the lock, storeMemory records and sends nothing.
  const p = new Project(dir);
  const sent = seen.length;
  const d = await withRepoLock(p, () => storeMemory(p, [lesson("Under the lock")]));
  assert.equal(seen.length, sent, "no request under the lock");
  assert.deepEqual(d.map((x) => [x.service, x.queued, x.stored]), [["mem0", 1, 0]]);
  assert.equal(queueItems(dir).filter((i) => i.kind === "mem0").length, 1);
});

test("a delivery recorded under the lock survives a stop before it is delivered, and the next flush delivers it", async () => {
  // @req REQ-engine-008
  const store: unknown[] = [];
  const mem0 = await mockServer((req) => {
    if (req.method === "GET") return { body: { results: [] } };
    store.push(req.body);
    return { body: { results: [{ id: "m1" }] } };
  });
  after(() => mem0.close());
  const { dir, project: p } = projectWith(mem0At(mem0.url));
  // What the locked tool does under the lock; the process then stops before delivering it (and before
  // its transaction clears the hold): here the hold is handed to a process that has exited.
  const { files } = await withRepoLock(p, () => enqueueMemory(p, [lesson("Kept")]));
  assert.equal(files.length, 1);
  assert.equal(store.length, 0);
  const held = JSON.parse(fs.readFileSync(files[0]!, "utf8"));
  assert.equal(held.holdPid, process.pid, "recorded with a hold for the transaction's process");
  fs.writeFileSync(files[0]!, JSON.stringify({ ...held, holdPid: deadPid() }, null, 2) + "\n");

  // A new process: the item is in this machine's queue, and its flush delivers it.
  const fresh = new Project(dir);
  assert.deepEqual(new Queue(localDir(fresh)).list().map((x) => x.file), files);
  assert.ok(files[0]!.startsWith(qdir(dir)));
  const r = await flushQueue(fresh);
  assert.deepEqual(r.map((x) => x.ok), [true]);
  assert.equal(store.length, 1);
  assert.deepEqual(queueItems(dir), []);
});

/** The pid of a process that has already exited. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.ok(pid);
  return pid;
}

test("a flush in another process while a transaction holds the lock sends nothing for its items and leaves them byte-for-byte; they are delivered after the release", async () => {
  // @req REQ-engine-008
  let dir = "";
  const hole = await blackhole(() => fs.existsSync(repoLockFile({ root: dir })));
  dir = projectWith(mem0At(hole.url)).dir;
  const p = new Project(dir);
  queueTiming.budgetMs = 300;
  let files: string[] = [];
  let during = { code: -1, out: "", err: "" };
  let bytes: Record<string, string> = {};
  await repoTransaction(p, async (tx) => {
    files = enqueueMemory(p, [lesson("Held")]).files;
    tx.deliverAfterRelease(files);
    bytes = bytesOf(dir);
    // Another process flushes now, as 'mw queue flush' (no budget, breaker ignored) or 'mw work' would.
    during = await mwAsync(dir, ["queue", "flush"]);
    assert.equal(fs.existsSync(repoLockFile({ root: dir })), true, "still under the lock");
    assert.deepEqual(bytesOf(dir), bytes, "the held item is byte-for-byte unchanged");
    return "done";
  });
  assert.equal(files.length, 1);
  assert.match(during.out, /kept\s+mem0 .*not tried: process \d+ recorded it under the repository lock/, during.out + during.err);
  assert.equal(hole.hits.length, 0, "no connection while the transaction held the item");
  assert.equal(JSON.parse(Object.values(bytes)[0]!).holdPid, process.pid);

  await settleDeliveries();
  assert.equal(hole.hits.length, 1, "attempted once the lock was released");
  assert.equal(hole.hits[0]!.probe, false, "after the repository lock was gone");
  const left = queueItems(dir);
  assert.deepEqual(left.map((i) => [i.kind, i.attempts]), [["mem0", 1]]);
  assert.equal((left[0] as { holdPid?: number }).holdPid, undefined, "the hold was cleared when the transaction ended");
});

test("Queue.flush skips an item a running process holds, however old the hold, and delivers one whose holder is dead or whose pid was reused", async () => {
  // @req REQ-engine-008
  const { dir, project: p } = projectWith();
  const q = new Queue(localDir(p));
  const sent: string[] = [];
  const deliverers = { notify: async (payload: unknown) => { sent.push((payload as { subject: string }).subject); } };
  const live = q.add("notify", "live", { subject: "live", body: "b" }, undefined, { hold: true });
  const old = q.add("notify", "old", { subject: "old", body: "b" }, undefined, { hold: true });
  const dead = q.add("notify", "dead", { subject: "dead", body: "b" }, undefined, { hold: true });
  const reused = q.add("notify", "reused", { subject: "reused", body: "b" }, undefined, { hold: true });
  const edit = (file: string, patch: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...patch }, null, 2) + "\n");
  const own = JSON.parse(fs.readFileSync(live, "utf8"));
  assert.equal(own.holdPid, process.pid);
  if (fs.existsSync("/proc/self/stat")) assert.match(own.holdStart ?? "", /^\d+$/, "the holder's start time is recorded where /proc exists");
  // A live holder whose hold is a day old still holds it: a hold ends with its process, not with its age.
  edit(old, { holdSince: new Date(Date.now() - 24 * 3600_000).toISOString() });
  edit(dead, { holdPid: deadPid() });
  // A live pid whose start time differs from the recorded one is another process (the pid was reused).
  edit(reused, { holdStart: "1" });
  const liveBytes = fs.readFileSync(live, "utf8");
  const oldBytes = fs.readFileSync(old, "utf8");

  const r = await q.flush(deliverers, { budgetMs: Infinity, breaker: false });
  assert.deepEqual(r.map((x) => [x.summary, x.ok, x.skipped]), [["live", false, "held"], ["old", false, "held"], ["dead", true, undefined], ["reused", true, undefined]]);
  assert.deepEqual(sent, ["dead", "reused"]);
  assert.equal(fs.readFileSync(live, "utf8"), liveBytes, "the held item is untouched, attempts included");
  assert.equal(fs.readFileSync(old, "utf8"), oldBytes, "the old hold of a live process is untouched");
  q.unhold([old]);

  // `only` (the holder, after its release) overrides the hold; `unhold` clears it.
  q.unhold([live]);
  assert.equal(JSON.parse(fs.readFileSync(live, "utf8")).holdPid, undefined);
  const r2 = await q.flush(deliverers, { only: [live, old] });
  assert.deepEqual(r2.map((x) => x.ok), [true, true]);
  assert.deepEqual(queueItems(dir), []);
});

test("when the queue item cannot be written, mw_memory_add keeps the commit, does not say queued, and starts no delivery", async () => {
  // @req REQ-engine-008
  const hole = await blackhole();
  const { dir } = projectWith(mem0At(hole.url));
  // A regular file where the queue folder belongs: no item can be written (also when running as root).
  fs.mkdirSync(path.join(dir, ".mergewright", "local"), { recursive: true });
  fs.writeFileSync(qdir(dir), "not a folder\n");
  const r = await tool(dir, "mw_memory_add", { kind: "lesson", topic: "testing", title: "Write failed", body: "The outbox write failed." });
  assert.equal(r.isError, false, r.text);
  assert.doesNotMatch(r.text, /queued|starts now/, r.text);
  assert.match(r.text, /the lesson is committed to memory\/, but it could not be put in this machine's delivery queue for mem0 \(.+\); run 'mw memory push' to send it to mem0/);
  assert.equal(deliveriesInFlight(), 0, "no background delivery was started");
  assert.match(git(dir, "log", "-1", "--format=%s"), /^memory: Write failed$/);
  assert.match(read(dir, "memory/lessons/testing.md"), /Write failed/);
  await settleDeliveries();
  assert.equal(hole.hits.length, 0);
});

// ── REQ-engine-008: on a hub, delivery waits for the lease too ──────────────────────────────────

/** A hub-backed project (checkout `a` of a pair) whose mem0 is `url`, the change pushed to the hub. */
function hubProjectAt(url: string): { dir: string; hubDir: string } {
  const p = hubPair();
  patchConfig(p.a, mem0At(url));
  git(p.a, "commit", "-qam", "mem0 down");
  git(p.a, "push", "-q", "hub", "main");
  return { dir: p.a, hubDir: p.hubDir };
}
const leaseOn = (hubDir: string) => git(hubDir, "for-each-ref", "refs/mergewright/lease") !== "";

test("on a hub, mw_memory_add delivers only after the transaction released both the repository lock and the lease", async () => {
  // @req REQ-engine-008
  let at = { dir: "", hubDir: "" };
  const hole = await blackhole(() => ({ lock: fs.existsSync(repoLockFile({ root: at.dir })), lease: leaseOn(at.hubDir) }));
  at = hubProjectAt(hole.url);
  queueTiming.budgetMs = 300;
  const r = await as("alpha", undefined, () => tool(at.dir, "mw_memory_add", { kind: "lesson", topic: "testing", title: "After the lease", body: "Deliver after the lease." }));
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /on the hub/);
  assert.match(r.text, /queued for mem0\n(.*\n)*the delivery starts now, in the background, after the repository lock and the lease were released/);
  assert.equal(leaseOn(at.hubDir), false, "the lease taken for the change was released");
  await settleDeliveries();
  assert.equal(hole.hits.length, 1, "the delivery was attempted");
  assert.deepEqual(hole.hits[0]!.probe, { lock: false, lease: false }, "the connection arrived after the lock and the lease were gone");
  assert.deepEqual(queueItems(at.dir).map((i) => [i.kind, i.attempts]), [["mem0", 1]], "cut at the budget, still queued");
});

test("on a hub, when this machine keeps the lease, mw_memory_add sends nothing, the item stays held against every flush, and is delivered once its process ends", async () => {
  // @req REQ-engine-008
  const hole = await blackhole();
  const { dir, hubDir } = hubProjectAt(hole.url);
  // This machine already holds the lease (as during its own run): the transaction keeps it.
  await as("alpha", undefined, () => openHub(new Project(dir)).take());
  assert.equal(leaseOn(hubDir), true);
  const r = await as("alpha", undefined, () => tool(dir, "mw_memory_add", { kind: "lesson", topic: "testing", title: "Kept lease", body: "Wait for the flush." }));
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /queued for mem0/);
  assert.match(r.text, /this machine keeps the lease .*so nothing is sent now; the items stay held for this process, and the next queue flush after it ends \(mw work, mw run, mw approve or mw queue flush\) delivers them/);
  assert.doesNotMatch(r.text, /starts now|once the lease is released/);
  assert.equal(leaseOn(hubDir), true, "the lease stays with this machine");
  const before = bytesOf(dir);
  assert.equal(Object.keys(before).length, 1);
  const file = path.join(qdir(dir), Object.keys(before)[0]!);
  assert.equal(JSON.parse(before[Object.keys(before)[0]!]!).holdPid, process.pid, "the hold stays while the lease is kept");
  await settleDeliveries();
  assert.equal(hole.hits.length, 0, "no connection from mw_memory_add");

  // While the lease is still held, a flush in another process ('mw queue flush': no budget, no breaker)
  // and one in this process ('mw work' after its card) both leave the held item alone.
  const other = await mwAsync(dir, ["queue", "flush"]);
  assert.match(other.out, /kept\s+mem0 .*not tried: process \d+ recorded it under the repository lock/, other.out + other.err);
  const here = await flushQueue(new Project(dir), { budgetMs: 200 });
  assert.deepEqual(here.map((x) => x.skipped), ["held"]);
  assert.equal(leaseOn(hubDir), true);
  assert.equal(hole.hits.length, 0, "nothing sent while the lease is held");
  assert.deepEqual(bytesOf(dir), before, "the item file is byte-for-byte unchanged, hold included");

  // The holder ends (as the MCP server stopping): the hold is handed to a process that has exited. The
  // next flush delivers the item (mem0 now answers).
  const store: unknown[] = [];
  const mem0 = await mockServer((req) => {
    if (req.method === "GET") return { body: { results: [] } };
    store.push(req.body);
    return { body: { results: [{ id: "m1" }] } };
  });
  after(() => mem0.close());
  patchConfig(dir, mem0At(mem0.url));
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), holdPid: deadPid() }, null, 2) + "\n");
  const done = await flushQueue(new Project(dir));
  assert.deepEqual(done.map((x) => [x.kind, x.ok]), [["mem0", true]]);
  assert.equal(store.length, 1, "delivered once");
  assert.deepEqual(queueItems(dir), []);
  assert.equal(hole.hits.length, 0);
});

// ── REQ-engine-009: on a hub, mw work flushes after its card; mw run and mw approve once the lease is released ──

/**
 * A blackhole for deliveries that answers mem0 searches at once with no hits, so the recall a card's
 * prompt makes (a read during the run, not a queue delivery) neither waits nor counts as a hit.
 */
async function deliveryBlackhole(probe: () => unknown): Promise<Blackhole> {
  const hits: Blackhole["hits"] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/search") {
      req.resume();
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results: [] })));
      return;
    }
    hits.push({ at: Date.now(), probe: probe() });
    req.resume(); // and never answer
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  const close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  after(close);
  return { url: `http://127.0.0.1:${port}`, hits, close };
}

/** `mw ARGS` in this process (so `queueTiming` applies and the blackhole answers from here), in `dir`. */
async function mwIn(dir: string, args: string[]): Promise<{ code: number; out: string }> {
  const cwd = process.cwd();
  const lines: string[] = [];
  process.chdir(dir);
  try {
    const code = await main(args, (l = "") => lines.push(l));
    return { code, out: lines.join("\n") };
  } finally {
    process.chdir(cwd);
  }
}

test("on a hub, mw work dispatches the card, flushes the queue after it with the lease kept, and again after it released the lease", async () => {
  // @req REQ-engine-009
  let hubDir = "";
  const hole = await blackhole(() => leaseOn(hubDir));
  const p = hubPair({ roles: { worker: { runs: "shell", command: WORKER } } });
  hubDir = p.hubDir;
  patchConfig(p.a, mem0At(hole.url));
  write(p.a, "cards/DEMO-1.card.md", read(p.a, "cards/DEMO-1.card.md").replace("status: todo", "status: ready"));
  git(p.a, "add", "-A");
  git(p.a, "commit", "-qm", "ready, mem0 down");
  git(p.a, "push", "-q", "hub", "main");
  useScript(script());
  new Queue(localDir(new Project(p.a))).add("mem0", "mem0 (demo): 1 lesson(s): First", { lessons: [lesson("First")] });
  queueTiming.budgetMs = 300;
  const lines: string[] = [];
  const r = await as("alpha", undefined, () => work(p.a, { out: (l) => lines.push(l), integrations: () => fakeIntegrations() }));
  assert.equal(r.code, 0, lines.join("\n"));
  assert.deepEqual(r.runs.map((x) => `${x.id}:${x.status}`), ["DEMO-1:done"]);
  assert.equal(git(p.hubDir, "show", "main:src/DEMO-1.txt"), "DEMO-1", "the card was dispatched and merged to the hub");
  // REQ-engine-012: the card's pass flushes with the lease kept (no run here is inside its merge phase),
  // the idle pass flushes again after the release.
  assert.equal(hole.hits.length, 2, "one flush after the card, one after the release");
  assert.deepEqual(hole.hits.map((h) => h.probe), [true, false], "the lease was on the hub at the first connection, gone at the second");
  assert.ok(lines.some((l) => /released the lease/.test(l)), lines.join("\n"));
  assert.deepEqual(queueItems(p.a).map((i) => [i.kind, i.attempts]), [["mem0", 2]], "cut at the budget each time, still queued");
});

test("on a hub, mw run --keep-lease and mw approve --keep-lease send nothing and leave the queue untouched", async () => {
  // @req REQ-engine-009
  let hubDir = "";
  const hole = await deliveryBlackhole(() => leaseOn(hubDir));
  const p = hubPair({ cardExtra: "risk: high\n" });
  hubDir = p.hubDir;
  patchConfig(p.a, mem0At(hole.url));
  git(p.a, "commit", "-qam", "mem0 down");
  git(p.a, "push", "-q", "hub", "main");
  useScript(script());
  new Queue(localDir(new Project(p.a))).add("mem0", "mem0 (demo): 1 lesson(s): Kept", { lessons: [lesson("Kept")] });
  const before = bytesOf(p.a);
  queueTiming.budgetMs = 300;

  let r = await as("alpha", undefined, () => mwIn(p.a, ["run", "DEMO-1", "--keep-lease"]));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /waiting before 'implement' for approval 'go'/);
  assert.match(r.out, /the integration queue was not retried because this machine keeps the lease/);
  assert.equal(leaseOn(p.hubDir), true);
  assert.equal(hole.hits.length, 0, "mw run --keep-lease made no connection");
  assert.deepEqual(bytesOf(p.a), before, "the item is byte-for-byte unchanged");

  r = await as("alpha", undefined, () => mwIn(p.a, ["approve", "DEMO-1", "go", "--keep-lease"]));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /waiting before 'merge' for approval 'merge'/);
  assert.equal(leaseOn(p.hubDir), true);
  assert.equal(hole.hits.length, 0, "mw approve --keep-lease made no connection");
  assert.deepEqual(bytesOf(p.a), before, "the item is still byte-for-byte unchanged");
});

// ── REQ-engine-008: the reflect phase only queues lessons ─────────────────────────────

/**
 * A blackhole for mem0 and Letta writes. Reads that are not deliveries answer at once with nothing:
 * mem0's search and listing, Letta's archive search and listing (the recall a card's prompt makes, and
 * the presence checks a flush makes before each write). Every other request is a hit: recorded with what `probe` said
 * when it arrived, and never answered.
 */
async function storeBlackhole(probe: () => unknown): Promise<Blackhole> {
  const hits: Blackhole["hits"] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const read = (req.method === "POST" && url === "/search") || (req.method === "GET" && (url.startsWith("/memories?") || url.includes("/archival-memory/search?") || url.includes("/archival-memory?")));
    req.resume();
    if (read) {
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results: [], count: 0 })));
      return;
    }
    hits.push({ at: Date.now(), probe: { ...(probe() as object), request: `${req.method} ${url}` } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  const close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  after(close);
  return { url: `http://127.0.0.1:${port}`, hits, close };
}

test("on a hub, the reflect phase of mw run queues the lessons for mem0 and Letta and sends nothing under the run lock or the lease; mw run's flush after the release delivers them", async () => {
  // @req REQ-engine-008
  process.env.MW_TEST_LETTA_KEY = "letta-test-key-not-a-secret";
  let at = { dir: "", hubDir: "" };
  // At each connection: does this card's run lock or the hub lease exist?
  const hole = await storeBlackhole(() => ({ lock: fs.existsSync(lockFile(new Project(at.dir), "DEMO-1")), lease: leaseOn(at.hubDir) }));
  const p = hubPair();
  at = { dir: p.a, hubDir: p.hubDir };
  // Short write timeouts: code that wrote inline would make its connections during the run and go on.
  patchConfig(p.a, { packages: { mem0: { url: hole.url, key_env: "MW_TEST_MEM0_KEY", write_timeout_ms: 300 }, letta: { url: hole.url, key_env: "MW_TEST_LETTA_KEY", write_timeout_ms: 300 } } });
  git(p.a, "commit", "-qam", "mem0 and letta down");
  git(p.a, "push", "-q", "hub", "main");
  // The project's Letta agent is known (as after its first use), so a recall makes no agent write.
  write(p.a, ".mergewright/local/packages/letta/letta-agent.json", JSON.stringify({ url: hole.url, name: "mergewright-demo", id: "agent-1" }));
  useScript(script());
  queueTiming.budgetMs = 5_000;

  const r = await as("alpha", undefined, () => mwIn(p.a, ["run", "DEMO-1"]));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /released the lease/);
  assert.equal(leaseOn(p.hubDir), false);

  // The lesson file was written and committed (and pushed) as before.
  assert.match(git(p.hubDir, "show", "main:memory/lessons/testing.md"), /## Keep tests hermetic/);
  assert.match(git(p.hubDir, "log", "-1", "--format=%s", "main", "--", "memory/lessons/testing.md"), /^DEMO-1: update project memory/);

  // Nothing connected while the run lock or the lease was held; mw run's flush, after the release,
  // tried each store once (each write timed out, so the items stay queued).
  assert.deepEqual(hole.hits.filter((h) => (h.probe as { lock: boolean; lease: boolean }).lock || (h.probe as { lease: boolean }).lease), [], "no connection under the lock or the lease");
  assert.deepEqual(hole.hits.map((h) => (h.probe as { request: string }).request), ["POST /memories", "POST /v1/agents/agent-1/archival-memory"], "one delivery per store, after the release");
  const items = queueItems(p.a);
  // The holds the reflect phase wrote (`Queue.unhold` deletes holdPid) were cleared by the flush after the release.
  assert.deepEqual(items.map((i) => [i.kind, i.attempts, i.holdPid]), [["mem0", 1, undefined], ["letta", 1, undefined]], "one item per store, hold cleared, tried once");
  for (const i of items) {
    assert.deepEqual((i.payload as { lessons: { title: string; card?: string }[] }).lessons.map((l) => [l.title, l.card]), [["Keep tests hermetic", "DEMO-1"]]);
    assert.match(i.lastError ?? "", /timed out/);
  }
});

test("the reflect phase's items are held for its process: another flush skips them, and this process's flushQueue releases only those holds and delivers them", async () => {
  // @req REQ-engine-008
  const writes: unknown[] = [];
  const mem0 = await mockServer((req) => {
    if (req.method === "POST" && req.url === "/memories") {
      writes.push(req.body);
      return { body: { results: [{ id: "m1" }] } };
    }
    return { body: { results: [] } };
  });
  after(() => mem0.close());
  const { project: p } = projectWith(mem0At(mem0.url));
  await integrationsFor(p).remember([lesson("Reflected")]);
  // A locked MCP tool's item, whose transaction keeps the lease: its hold is not the reflect phase's.
  const { files: locked } = await withRepoLock(p, () => enqueueMemory(p, [lesson("Locked")]));
  const items = new Queue(localDir(p)).list();
  assert.deepEqual(items.map((x) => [x.item.kind, x.item.holdPid]), [["mem0", process.pid], ["mem0", process.pid]], "both held for this process");

  // A flush that is not this process's own release (as `mw queue flush` in another process): nothing is tried.
  const other = await new Queue(localDir(p)).flush({});
  assert.deepEqual(other.map((r) => r.skipped), ["held", "held"]);
  assert.equal(writes.length, 0, "no request while the items are held");

  // This process's flush (reached only after the lease is released) releases the reflected item and delivers it.
  await flushQueue(p);
  assert.equal(writes.length, 1, "the reflected lesson was delivered");
  assert.match(JSON.stringify(writes[0]), /Reflected/);
  const left = new Queue(localDir(p)).list();
  assert.deepEqual(left.map((x) => [x.file, x.item.holdPid]), [[locked[0]!, process.pid]], "the MCP item keeps its hold");
});

test("the reflect phase's holds are kept per project: flushQueue for project B leaves project A's reflected item held, and A's own flush delivers it", async () => {
  // @req REQ-engine-008
  const writes: string[] = [];
  const mem0 = await mockServer((req) => {
    if (req.method === "POST" && req.url === "/memories") {
      writes.push(JSON.stringify(req.body));
      return { body: { results: [{ id: "m1" }] } };
    }
    return { body: { results: [] } };
  });
  after(() => mem0.close());
  const { project: a } = projectWith(mem0At(mem0.url));
  const { project: b } = projectWith(mem0At(mem0.url));
  await integrationsFor(a).remember([lesson("From A")]);
  await integrationsFor(b).remember([lesson("From B")]);

  // B's flush (B's lease released, A's still held) delivers B's lesson only.
  await flushQueue(b);
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /From B/);
  assert.deepEqual(new Queue(localDir(b)).list(), [], "B's item was delivered");
  const held = new Queue(localDir(a)).list();
  assert.deepEqual(held.map((x) => [x.item.kind, x.item.holdPid]), [["mem0", process.pid]], "A's item keeps its hold");
  const other = await new Queue(localDir(a)).flush({});
  assert.deepEqual(other.map((r) => r.skipped), ["held"], "another flush skips A's item");
  assert.equal(writes.length, 1, "nothing of A's was sent");

  // A's own flush, after A's release, releases and delivers it.
  await flushQueue(a);
  assert.equal(writes.length, 2);
  assert.match(writes[1]!, /From A/);
  assert.deepEqual(new Queue(localDir(a)).list(), [], "A's item was delivered");
});

// ── REQ-engine-009: the breaker's state is safe across processes ─────────────────────────────

test("concurrent flush processes never lose each other's breaker outcomes: timeouts add up and kinds are kept", async () => {
  // @req REQ-engine-009
  const { project: p } = projectWith();
  const q = new Queue(localDir(p));
  const url = JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT, "src", "integrations", "queue.ts")).href);
  const N = 30;
  const child = (own: string) => new Promise<string>((resolve) => {
    const code = `const { Queue } = await import(${url});
const q = new Queue(${JSON.stringify(localDir(p))});
for (let i = 0; i < ${N}; i++) { await q.recordOutcome("mem0", true, 0); await q.recordOutcome(${JSON.stringify(own)}, true, 0); }`;
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", () => resolve(out.trim()));
  });
  const outs = await Promise.all([child("letta"), child("notify")]);
  assert.deepEqual(outs, ["", ""], outs.join("\n"));
  const b = q.breakers();
  assert.equal(b.mem0?.timeouts, 2 * N, "every timeout of the shared kind counted");
  assert.equal(b.letta?.timeouts, N, "one kind's updates did not erase another's");
  assert.equal(b.notify?.timeouts, N);
  assert.equal(fs.existsSync(path.join(q.dir, ".breaker.lock")), false, "the lock is released");

  // Two timeouts of one kind, one from each process, persist as 2 and open the breaker.
  const { project: p2 } = projectWith();
  const two = (dir: string) => new Promise<void>((resolve) => {
    spawn(process.execPath, ["--input-type=module", "-e", `const { Queue } = await import(${url}); await new Queue(${JSON.stringify(dir)}).recordOutcome("mem0", true, 1000);`], { stdio: "ignore" }).on("close", () => resolve());
  });
  await Promise.all([two(localDir(p2)), two(localDir(p2))]);
  assert.deepEqual(new Queue(localDir(p2)).breakers(), { mem0: { timeouts: 2, skipUntil: 1000 + BREAKER_SKIP_MS } });
});

test("a breaker lock left by a stopped process is removed after a few seconds; the outcome is still recorded", async () => {
  // @req REQ-engine-009
  const { project: p } = projectWith();
  const q = new Queue(localDir(p));
  fs.mkdirSync(q.dir, { recursive: true });
  const lock = path.join(q.dir, ".breaker.lock");
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  await q.recordOutcome("mem0", true, 0);
  assert.deepEqual(q.breakers(), { mem0: { timeouts: 1 } });
  assert.equal(fs.existsSync(lock), false);
});

test("a breaker lock held by another owner does not stretch a flush past its budget: the outcome is skipped, the item keeps its attempt", async () => {
  // @req REQ-engine-009
  const { dir, project: p } = projectWith();
  const q = new Queue(localDir(p));
  q.add("mem0", "mem0 lesson", { lessons: [lesson("A")] });
  fs.mkdirSync(q.dir, { recursive: true });
  const lock = path.join(q.dir, ".breaker.lock");
  fs.writeFileSync(lock, "4242-other"); // fresh: another owner holds it, not stale
  const budgetMs = 400;
  // Finishes just before the deadline, with an outcome the breaker would record (a timeout).
  const slow = async () => { await new Promise((res) => setTimeout(res, budgetMs - 80)); throw new Error("POST http://127.0.0.1:1/: timed out after 10 s"); };
  const t0 = Date.now();
  const r = await q.flush({ mem0: slow }, { budgetMs });
  const took = Date.now() - t0;
  assert.ok(took < budgetMs + 1_000, `the flush returned after ${took} ms, not after the lock's 8 s wait`);
  assert.deepEqual(r.map((x) => [x.kind, x.ok, x.skipped]), [["mem0", false, undefined]]);
  const items = queueItems(dir);
  assert.equal(items.length, 1, "still queued");
  assert.equal(items[0]!.attempts, 1, "the attempt is counted in the item");
  assert.match(items[0]!.lastError ?? "", /timed out/);
  assert.deepEqual(q.breakers(), {}, "the breaker missed this one outcome");
  assert.equal(fs.readFileSync(lock, "utf8"), "4242-other", "the other owner's lock is left in place");
});

// ── REQ-engine-009: blocking commands are bounded by the flush's budget too ───────────────────

test("a queued notify whose command hangs is cut at the flush's budget: one attempt, the item stays queued, the breaker unchanged", async () => {
  // @req REQ-engine-009
  const { dir, project: p } = projectWith({ report: { command: "sleep 30" } });
  const q = new Queue(localDir(p));
  q.add("notify", "notify: hung", { subject: "s", body: "b" });
  const t0 = Date.now();
  const r = await flushQueue(p, { budgetMs: 300 });
  const took = Date.now() - t0;
  assert.ok(took < 2_500, `the flush returned after ${took} ms, not at the command's own 60 s limit`);
  assert.deepEqual(r.map((x) => [x.kind, x.ok, x.skipped, x.dropped]), [["notify", false, undefined, undefined]]);
  assert.match(r[0]!.error ?? "", /stopped \(the flush's time budget ran out\)/);
  const items = queueItems(dir);
  assert.equal(items.length, 1, "still queued");
  assert.equal(items[0]!.attempts, 1, "the cut counts one attempt");
  assert.doesNotMatch(items[0]!.lastError ?? "", /timed out/);
  assert.deepEqual(q.breakers(), {}, "a cut by the budget is not a timeout of the service");

  // Outside a flush, and in `mw queue flush` (no budget), a command keeps its own cap.
  assert.deepEqual(commandTimeout(60_000), { timeoutMs: 60_000, byBudget: false });
  const none = { signal: new AbortController().signal, deadline: Infinity };
  assert.deepEqual(deliveryScope.run(none, () => commandTimeout(60_000)), { timeoutMs: 60_000, byBudget: false });
  const soon = { signal: new AbortController().signal, deadline: Date.now() + 10 };
  assert.deepEqual(deliveryScope.run(soon, () => commandTimeout(60_000)), { timeoutMs: COMMAND_FLOOR_MS, byBudget: true }, "a little budget left still gets the floor");
  const spent = { signal: new AbortController().signal, deadline: Date.now() - 1 };
  assert.throws(() => deliveryScope.run(spent, () => commandTimeout(60_000)), BudgetCut, "a spent budget starts no command");
});

test("a queued kanban item whose CLI hangs is cut at the flush's budget and stays queued, not dropped as unreachable", async () => {
  // @req REQ-engine-009
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mw-kanban-"));
  fs.writeFileSync(path.join(bin, "kanban"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const { dir, project: p } = projectWith(kanbanConfig());
    const q = new Queue(localDir(p));
    q.add("cline-kanban", "kanban: DEMO-9 -> blocked", { cardId: "DEMO-9", title: "Card DEMO-9", status: "blocked" });
    const t0 = Date.now();
    const r = await flushQueue(p, { budgetMs: 300 });
    const took = Date.now() - t0;
    assert.ok(took < 2_500, `the flush returned after ${took} ms, not at the CLI's own 30 s limit`);
    assert.equal(r[0]!.dropped, undefined, r[0]!.error);
    assert.match(r[0]!.error ?? "", /stopped \(the flush's time budget ran out\)/);
    const items = queueItems(dir);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.attempts, 1);
    assert.deepEqual(q.breakers(), {});
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// ── REQ-engine-009: the breaker lock belongs to its owner ─────────────────────────────────────

test("a breaker lock taken over by another owner is neither released nor written through by the old owner", async () => {
  // @req REQ-engine-009
  const { project: p } = projectWith();
  const q = new Queue(localDir(p));
  const lock = path.join(q.dir, ".breaker.lock");
  const held = await q.lockBreaker();
  assert.equal(fs.readFileSync(lock, "utf8"), held.token, "the lock holds its owner's token");
  assert.match(held.token, new RegExp(`^${process.pid}-`));
  assert.equal(held.owned(), true);

  // The old owner paused; another process removed its lock as stale and took it.
  fs.rmSync(lock);
  fs.writeFileSync(lock, "4242-other");
  assert.equal(held.owned(), false, "the old owner sees it lost the lock before any write");
  held.release();
  assert.equal(fs.readFileSync(lock, "utf8"), "4242-other", "the old owner's release left the new owner's lock in place");

  // A stale lock is removed and the outcome recorded; the token decides, not the content's absence.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  await q.recordOutcome("mem0", true, 0);
  assert.deepEqual(q.breakers(), { mem0: { timeouts: 1 } });
  assert.equal(fs.existsSync(lock), false, "released after the write");
  assert.deepEqual(fs.readdirSync(q.dir).filter((n) => n.startsWith(".breaker.lock")), [], "no temporary lock files left");
});

// ── REQ-engine-010: the merge phase and a card branch without the card file ─────────────

const cardEnv = (s: string) => ({ MW_MOCK_SCRIPT: s, MW_HOST: "alpha" });

/**
 * A hub pair whose card branch was made before the card file was on main (as a branch made before the
 * project used MergeWright): main drops the card, the branch forks there, main gets the
 * card back. The card is high risk, so the run stops for 'merge' approval with the branch's work done and
 * gated. `conflict` also adds, on main after the fork, a different src/app.txt than the worker writes.
 */
function branchWithoutCard(opts: { conflict?: boolean; mergeOnBlock?: string } = {}): { a: string; sc: string } {
  const p = hubPair({ cardExtra: "risk: high\n" });
  if (opts.mergeOnBlock) {
    // The project's own copy of the standard flow, whose merge phase routes 'block' onward.
    const flow = fs.readFileSync(new URL("../../presets/standard/flows/standard.flow.yaml", import.meta.url), "utf8");
    write(p.a, "flows/standard.flow.yaml", flow.replace("    action: merge\n", `    action: merge\n    on: {block: ${opts.mergeOnBlock}}\n`));
    git(p.a, "add", "flows/standard.flow.yaml");
    git(p.a, "commit", "-qm", "merge routes block onward");
  }
  const text = read(p.a, "cards/DEMO-1.card.md");
  git(p.a, "rm", "-q", "cards/DEMO-1.card.md");
  git(p.a, "commit", "-qm", "before the migration");
  git(p.a, "branch", "card/DEMO-1");
  write(p.a, "cards/DEMO-1.card.md", text);
  git(p.a, "add", "cards/DEMO-1.card.md");
  git(p.a, "commit", "-qm", "migrate: add the card");
  if (opts.conflict) {
    write(p.a, "src/app.txt", "main's own\n");
    git(p.a, "add", "src/app.txt");
    git(p.a, "commit", "-qm", "main writes src/app.txt");
  }
  git(p.a, "push", "-q", "hub", "main");
  const sc = useScript(script());
  let r = mw(p.a, ["run", "DEMO-1"], cardEnv(sc));
  assert.equal(r.code, 0, r.out + r.err);
  r = mw(p.a, ["approve", "DEMO-1", "go"], cardEnv(sc));
  assert.match(r.out, /waiting before 'merge' for approval 'merge'/, r.out + r.err);
  assert.equal(fs.existsSync(path.join(p.a, ".mergewright/worktrees/DEMO-1/cards/DEMO-1.card.md")), false, "the branch has no card file");
  return { a: p.a, sc };
}

test("REQ-engine-010 AC-1: a card branch made without cards/ before main had the card gets main's card marked done in the runtime commit, and the add/add on the card file merges in favour of the branch", { timeout: 120_000 }, () => {
  // @req REQ-engine-010
  const { a, sc } = branchWithoutCard();
  const main0 = git(a, "rev-parse", "main");
  const mainCard = git(a, "show", "main:cards/DEMO-1.card.md");
  const r = mw(a, ["approve", "DEMO-1", "merge"], cardEnv(sc));
  assert.doesNotMatch(r.err, /ENOENT|\n\s+at /, "nothing was thrown");
  const s = JSON.parse(read(a, ".mergewright/runs/DEMO-1/state.json")) as { status: string; reason?: string; merged?: string };
  assert.equal(s.status, "done", s.reason);
  assert.ok(s.merged, "the merge is recorded");
  // The squash is one commit on main's old head, holding the work and main's card with status done
  // (later phases may add their own commits on top).
  const m = s.merged!;
  assert.equal(git(a, "merge-base", "--is-ancestor", m, "main"), "", "the squash is on main");
  assert.equal(git(a, "rev-parse", `${m}^`), main0);
  assert.equal(git(a, "log", "-1", "--format=%s", m), "DEMO-1: Card DEMO-1");
  const files = git(a, "show", "--name-only", "--format=", m).split("\n");
  assert.ok(files.includes("cards/DEMO-1.card.md") && files.includes("src/app.txt"), files.join(", "));
  const card = git(a, "show", `${m}:cards/DEMO-1.card.md`);
  assert.match(card, /^status: done$/m);
  assert.doesNotMatch(card, /<<<<<<<|>>>>>>>/, "no conflict markers");
  assert.equal(card, mainCard.replace(/^status: todo$/m, "status: done"), "the card is main's, not fabricated");
  assert.equal(git(a, "show", `${m}:src/app.txt`), "hello");
});

test("REQ-engine-010 AC-1: with another conflicting file besides the card file the merge still blocks with the existing conflict message, and a retry is not refused for the card file", { timeout: 120_000 }, () => {
  // @req REQ-engine-010
  const { a, sc } = branchWithoutCard({ conflict: true });
  const main0 = git(a, "rev-parse", "main");
  const r = mw(a, ["approve", "DEMO-1", "merge"], cardEnv(sc));
  assert.doesNotMatch(r.err, /\n\s+at /, "nothing was thrown");
  const s = JSON.parse(read(a, ".mergewright/runs/DEMO-1/state.json")) as { status: string; reason?: string; merged?: string };
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason ?? "", /the branch conflicts with main in: cards\/DEMO-1\.card\.md, src\/app\.txt\. Rebuild the change on top of the current main so these files merge cleanly\./);
  assert.equal(s.merged, undefined);
  assert.equal(git(a, "rev-parse", "main"), main0, "nothing was merged");
  // A retry once main no longer conflicts: the branch's card commit from the first attempt counts as the
  // runtime's own edit (main's card with status done), so the scope check passes; the merge evidence
  // (src/engine/run.ts) does not accept a card file the fork point lacked, so the retry
  // asks for the gate again instead of merging an unjudged head. Nothing is thrown either way.
  assert.equal(git(a, "log", "-1", "--format=%s", "card/DEMO-1"), "DEMO-1: mark done");
  write(a, "src/app.txt", "hello\n");
  git(a, "commit", "-qam", "main agrees on src/app.txt");
  git(a, "push", "-q", "hub", "main");
  let again = mw(a, ["run", "DEMO-1", "--from", "merge"], cardEnv(sc));
  if (/waiting before 'merge' for approval 'merge'/.test(again.out)) again = mw(a, ["approve", "DEMO-1", "merge"], cardEnv(sc));
  assert.doesNotMatch(again.err, /\n\s+at /, "nothing was thrown");
  const s2 = JSON.parse(read(a, ".mergewright/runs/DEMO-1/state.json")) as { status: string; reason?: string };
  assert.equal(s2.status, "blocked", s2.reason);
  assert.doesNotMatch(s2.reason ?? "", /scope|DEMO-1\.card\.md/, s2.reason);
  assert.match(s2.reason ?? "", /mw run DEMO-1 --from gate/);
});

test("REQ-engine-010 AC-2: a card file that cannot be read in the merge phase blocks the run with merge/card-file; the lock and the lease are released", { timeout: 120_000 }, () => {
  // @req REQ-engine-010
  const { a, sc } = branchWithoutCard();
  // A folder where the card file should be: reading it fails with EISDIR, not ENOENT, so there is no
  // fallback to main. An empty folder is invisible to git, so the worktree still counts as clean.
  const wtCard = path.join(a, ".mergewright/worktrees/DEMO-1/cards/DEMO-1.card.md");
  fs.mkdirSync(wtCard, { recursive: true });
  const before = git(a, "rev-parse", "main");
  const r = mw(a, ["approve", "DEMO-1", "merge"], cardEnv(sc));
  assert.ok(r.code === 0 || r.code === 1, `exit code ${r.code}: ${r.out}${r.err}`);
  assert.doesNotMatch(r.err, /EISDIR|\n\s+at /, "no uncaught exception reached the CLI");
  const s = JSON.parse(read(a, ".mergewright/runs/DEMO-1/state.json")) as { status: string; reason?: string; merged?: string };
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason ?? "", /merge\/card-file/);
  assert.ok((s.reason ?? "").includes(wtCard), s.reason);
  assert.ok((s.reason ?? "").includes("mw run DEMO-1 --from merge"), s.reason);
  assert.equal(s.merged, undefined);
  assert.equal(git(a, "rev-parse", "main"), before, "nothing was merged");
  assert.equal(fs.existsSync(path.join(a, ".mergewright/local/locks/DEMO-1.lock")), false, "the run lock is released");
  assert.match(mw(a, ["lease", "show"], cardEnv(sc)).out, /no machine holds the lease/);
});

test("REQ-engine-010 AC-2: a card file that cannot be written in the merge phase blocks the run with merge/card-file; the lock and the lease are released", { timeout: 120_000, skip: process.getuid?.() === 0 ? "root ignores folder permissions" : false }, () => {
  // @req REQ-engine-010
  const { a, sc } = branchWithoutCard();
  // A read-only cards folder without the card: the read finds no file (ENOENT, so main's card is taken),
  // and the write into the folder fails with EACCES.
  const wtCards = path.join(a, ".mergewright/worktrees/DEMO-1/cards");
  fs.mkdirSync(wtCards, { recursive: true });
  fs.chmodSync(wtCards, 0o555);
  const before = git(a, "rev-parse", "main");
  try {
    const r = mw(a, ["approve", "DEMO-1", "merge"], cardEnv(sc));
    assert.ok(r.code === 0 || r.code === 1, `exit code ${r.code}: ${r.out}${r.err}`);
    assert.doesNotMatch(r.err, /EACCES|\n\s+at /, "no uncaught exception reached the CLI");
  } finally {
    fs.chmodSync(wtCards, 0o755);
  }
  const s = JSON.parse(read(a, ".mergewright/runs/DEMO-1/state.json")) as { status: string; reason?: string; merged?: string };
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason ?? "", /merge\/card-file/);
  assert.ok((s.reason ?? "").includes(path.join(wtCards, "DEMO-1.card.md")), s.reason);
  assert.ok((s.reason ?? "").includes("mw run DEMO-1 --from merge"), s.reason);
  assert.equal(s.merged, undefined);
  assert.equal(git(a, "rev-parse", "main"), before, "nothing was merged");
  assert.equal(fs.existsSync(path.join(a, ".mergewright/local/locks/DEMO-1.lock")), false, "the run lock is released");
  assert.match(mw(a, ["lease", "show"], cardEnv(sc)).out, /no machine holds the lease/);
});

test("REQ-engine-010 AC-2: a card-file failure in the merge phase blocks the run even when the flow routes the merge phase's 'block' onward", { timeout: 120_000 }, () => {
  // @req REQ-engine-010
  const { a, sc } = branchWithoutCard({ mergeOnBlock: "continue" });
  const wtCard = path.join(a, ".mergewright/worktrees/DEMO-1/cards/DEMO-1.card.md");
  fs.mkdirSync(wtCard, { recursive: true }); // EISDIR on read, as above
  const before = git(a, "rev-parse", "main");
  const r = mw(a, ["approve", "DEMO-1", "merge"], cardEnv(sc));
  assert.doesNotMatch(r.err, /EISDIR|\n\s+at /, "no stack trace reached the CLI");
  const s = JSON.parse(read(a, ".mergewright/runs/DEMO-1/state.json")) as { status: string; reason?: string; merged?: string };
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason ?? "", /merge\/card-file/);
  assert.ok((s.reason ?? "").includes("mw run DEMO-1 --from merge"), s.reason);
  assert.equal(s.merged, undefined);
  assert.equal(git(a, "rev-parse", "main"), before, "nothing was merged");
  assert.equal(fs.existsSync(path.join(a, ".mergewright/local/locks/DEMO-1.lock")), false, "the run lock is released");
  assert.match(mw(a, ["lease", "show"], cardEnv(sc)).out, /no machine holds the lease/);
});

// ── REQ-engine-011: a stop or restart of the mw-work@ unit lets the current card finish ──────────────
//
// No real systemd: `systemdStop` does what systemd's stop does with the unit's own KillMode and
// KillSignal, so the tests fail with a unit that would signal the whole control group. `mw work` runs
// detached (its own process group), and every signal goes to a pid the test started, never to the
// test runner's group.

const WORK_UNIT = path.join(PACKAGE_ROOT, "ops", "mw-work@.service");
const INSTALL_SERVICE = path.join(PACKAGE_ROOT, "scripts", "install-service.sh");

/** A `[Service]` setting of a unit file's text (the last one wins, as in systemd), or undefined. */
function unitSetting(text: string, key: string): string | undefined {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(`${key}=`));
  return lines.at(-1)?.slice(key.length + 1);
}

/**
 * systemd's stop of a unit whose main process is `main` and whose other processes lead the groups
 * `others`: KillSignal goes to the main process only with KillMode=mixed or process, and to every
 * process of the control group otherwise (control-group, systemd's default).
 */
function systemdStop(unitText: string, main: number, others: number[]): void {
  const mode = unitSetting(unitText, "KillMode") ?? "control-group";
  const signal = (unitSetting(unitText, "KillSignal") ?? "SIGTERM") as NodeJS.Signals;
  process.kill(main, signal);
  if (mode !== "mixed" && mode !== "process") for (const pid of others) try { process.kill(-pid, signal); } catch { /* gone */ }
}

/**
 * Card DEMO-1, ready, whose worker is a shell agent that records its pid, waits until the file
 * `release` exists, records that it finished and prints a valid handoff.
 */
function cardWithWaitingWorker(): { dir: string; pidFile: string; release: string; finished: string } {
  const dir = project();
  const aside = tmpDir("mw-req011-");
  const pidFile = path.join(aside, "agent.pid");
  const release = path.join(aside, "release");
  const finished = path.join(aside, "finished");
  const reply = path.join(aside, "handoff.json");
  fs.writeFileSync(reply, JSON.stringify(handoff()));
  setRoles(dir, { worker: { runs: "shell", command: `mkdir -p src; echo hello > src/app.txt; echo $$ > '${pidFile}'; while [ ! -e '${release}' ]; do sleep 0.1; done; echo yes > '${finished}'; cat '${reply}'` } });
  write(dir, "cards/DEMO-1.card.md", read(dir, "cards/DEMO-1.card.md").replace("status: todo", "status: ready"));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "worker on the shell; DEMO-1 ready");
  return { dir, pidFile, release, finished };
}

/** `mw work` in `dir`, detached in its own process group, with its output collected. */
function startWork(dir: string): { child: ReturnType<typeof spawn>; out: () => string; exited: Promise<number | null> } {
  const env: NodeJS.ProcessEnv = { ...process.env, MW_ENV_FILE: "/dev/null", MW_MOCK_SCRIPT: useScript(script()) };
  for (const k of ["MW_CARD", "MW_ROLE", "MW_MODE"]) delete env[k];
  const child = spawn(process.execPath, [MW, "work"], { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout!.on("data", (d: Buffer) => (text += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (text += d.toString()));
  const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
  return { child, out: () => text, exited };
}

async function until(what: string, f: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!f()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Kill the agents' process groups (a worker started again after the first one ended has a new pid). */
function stopAgents(...pids: number[]): void {
  for (const pid of pids) if (pid > 0) try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
}

const runState = (dir: string) => JSON.parse(read(dir, ".mergewright/runs/DEMO-1/state.json")) as { status: string; reason?: string; history: { phase: string; outcome: string }[] };

test("REQ-engine-011 AC-1: the shipped unit has KillMode=mixed, and its stop signals only mw work: the agent keeps running and the card finishes", { timeout: 120_000 }, async () => {
  // @req REQ-engine-011
  const unit = fs.readFileSync(WORK_UNIT, "utf8");
  assert.equal(unitSetting(unit, "KillMode"), "mixed");
  assert.equal(unitSetting(unit, "KillSignal") ?? "SIGTERM", "SIGTERM");
  assert.ok(Number(unitSetting(unit, "TimeoutStopSec")) >= 2 * 90 * 60, "TimeoutStopSec leaves room for more than one 90-minute phase");

  const { dir, pidFile, release, finished } = cardWithWaitingWorker();
  const w = startWork(dir);
  let agent = 0;
  try {
    await until("the worker to start", () => pidIn(pidFile) > 0);
    agent = pidIn(pidFile);
    systemdStop(unit, w.child.pid!, [agent]);
    await until("mw work to take the stop request", () => /SIGTERM received; no new card will start/.test(w.out()));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(alive(agent), true, `the agent is still running after the stop request\n${w.out()}`);
    assert.equal(w.child.exitCode, null, "mw work waits for the card");
    fs.writeFileSync(release, "");
    const code = await w.exited;
    assert.equal(code, 0, w.out());
    assert.equal(fs.existsSync(finished), true, "the agent ran to its end");
    const s = runState(dir);
    assert.notEqual(s.status, "running", `the card's run ended (${s.status}: ${s.reason ?? ""})`);
    assert.ok(s.history.some((h) => h.phase === "implement" && h.outcome !== "fail"), JSON.stringify(s.history));
    assert.doesNotMatch(w.out(), /stopped during phase/);
  } finally {
    try { process.kill(-w.child.pid!, "SIGKILL"); } catch { /* gone */ }
    stopAgents(agent, pidIn(pidFile));
  }
});

test("REQ-engine-011 AC-2: after SIGTERM mw work exits 0 when the card ends, and the unit's Restart= does not treat that exit (or an immediate stop's 130) as a failure", { timeout: 120_000 }, async () => {
  // @req REQ-engine-011
  const unit = fs.readFileSync(WORK_UNIT, "utf8");
  const restart = unitSetting(unit, "Restart") ?? "no";
  assert.ok(["no", "on-failure", "on-abnormal", "on-abort", "on-watchdog"].includes(restart), `Restart=${restart} would restart a clean exit 0`);
  assert.ok((unitSetting(unit, "SuccessExitStatus") ?? "").split(/\s+/).includes("130"), "an immediate stop (exit 130) is not a failure");

  const { dir, pidFile, release } = cardWithWaitingWorker();
  const w = startWork(dir);
  let agent = 0;
  try {
    await until("the worker to start", () => pidIn(pidFile) > 0);
    agent = pidIn(pidFile);
    process.kill(w.child.pid!, "SIGTERM");
    await until("mw work to take the stop request", () => /SIGTERM received; no new card will start/.test(w.out()));
    fs.writeFileSync(release, "");
    assert.equal(await w.exited, 0, w.out());
    assert.notEqual(runState(dir).status, "running");
  } finally {
    try { process.kill(-w.child.pid!, "SIGKILL"); } catch { /* gone */ }
    stopAgents(agent, pidIn(pidFile));
  }
});

for (const second of ["SIGTERM", "SIGINT"] as const) {
  test(`REQ-engine-011 AC-2: a ${second} after the first SIGTERM stops the current phase at once (exit 130, the agent's group gone, nothing of the phase recorded)`, { timeout: 120_000 }, async () => {
    // @req REQ-engine-011
    const { dir, pidFile, finished } = cardWithWaitingWorker();
    const w = startWork(dir);
    let agent = 0;
    try {
      await until("the worker to start", () => pidIn(pidFile) > 0);
      agent = pidIn(pidFile);
      process.kill(w.child.pid!, "SIGTERM");
      await until("mw work to take the stop request", () => /SIGTERM received; no new card will start/.test(w.out()));
      process.kill(w.child.pid!, second);
      const code = await w.exited;
      assert.equal(code, 130, w.out());
      assert.match(w.out(), new RegExp(`second ${second}; stopping the current phase now`));
      assert.equal(alive(agent), false, "the agent was stopped before mw work exited");
      assert.equal(fs.existsSync(finished), false, "the agent did not run to its end");
      const s = runState(dir);
      assert.equal(s.status, "running", "the card continues from its last finished phase on the next run");
      assert.equal(s.history.some((h) => h.phase === "implement"), false, JSON.stringify(s.history));
    } finally {
      try { process.kill(-w.child.pid!, "SIGKILL"); } catch { /* gone */ }
      stopAgents(agent, pidIn(pidFile));
    }
  });
}

test("REQ-engine-011 AC-3: install.sh brings the installed mw-work@ unit level with ops/ through install-service.sh, which installs that file, reloads systemd and restarts nothing", () => {
  // @req REQ-engine-011
  const installer = fs.readFileSync(path.join(PACKAGE_ROOT, "scripts", "install.sh"), "utf8");
  assert.match(installer, /install-service\.sh" unit --check/, "install.sh checks the installed unit");
  assert.match(installer, /sudo -n "\$dest\/scripts\/install-service\.sh" unit\b/, "install.sh updates it when it may");
  assert.match(installer, /sudo \$dest\/scripts\/install-service\.sh unit"/, "otherwise it prints the command");
  assert.doesNotMatch(installer, /KillMode|\[Service\]/, "no second copy of the unit text");

  const units = tmpDir("mw-units-");
  const bin = tmpDir("mw-fakebin-");
  const calls = path.join(bin, "calls");
  const systemctl = path.join(bin, "systemctl");
  // The fake models systemd: daemon-reload fails while `fail-reload` exists; list-units lists the loaded
  // instance mw-work@proj.service only while `instances` exists; `show` on that instance prints
  // `need-reload`'s content, and `show` on the template (a name ending in @.service) prints nothing and
  // fails, as systemd cannot load an uninstantiated template.
  const failReload = path.join(bin, "fail-reload");
  const needReload = path.join(bin, "need-reload");
  const instances = path.join(bin, "instances");
  fs.writeFileSync(
    systemctl,
    `#!/bin/sh\necho "$*" >> '${calls}'\n` +
      `last=""; for a in "$@"; do last=$a; done\n` +
      `case $1 in\n` +
      `  daemon-reload) [ ! -e '${failReload}' ] ;;\n` +
      `  list-units) [ ! -e '${instances}' ] || echo "mw-work@proj.service loaded active running Unattended mw work for proj" ;;\n` +
      `  show) case $last in\n` +
      `      *@.service) exit 1 ;;\n` +
      `      mw-work@proj.service) [ ! -e '${needReload}' ] || cat '${needReload}' ;;\n` +
      `      *) exit 1 ;;\n` +
      `    esac ;;\n` +
      `esac\n`,
    { mode: 0o755 },
  );
  const reloads = () => fs.readFileSync(calls, "utf8").split("\n").filter((l) => l === "daemon-reload").length;
  const env = { ...process.env, MW_UNIT_DIR: units, MW_SYSTEMCTL: systemctl };
  const runScript = (...args: string[]) => spawnSync("bash", [INSTALL_SERVICE, ...args], { encoding: "utf8", env });
  const installed = path.join(units, "mw-work@.service");

  assert.equal(runScript("unit", "--check").status, 0, "no unit installed: nothing to update");
  const shipped = fs.readFileSync(WORK_UNIT, "utf8");
  fs.writeFileSync(installed, shipped.replace(/^KillMode=.*\n/m, ""));
  const check = runScript("unit", "--check");
  assert.equal(check.status, 1, "an installed unit without the change is out of date");
  assert.match(check.stdout, /differs from/);

  const r = runScript("unit");
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(installed, "utf8");
  assert.equal(unitSetting(text, "KillMode"), "mixed");
  const home = os.userInfo().homedir;
  assert.equal(unitSetting(text, "WorkingDirectory"), `${home}/workspace/%i`, "rendered for this user");
  assert.equal(unitSetting(text, "User"), process.env.SUDO_USER || os.userInfo().username, "the user is filled in");
  assert.doesNotMatch(text, /__USER__|__HOME__/, "no placeholder is left in the installed unit");
  assert.equal(reloads(), 1, "systemd reloaded");
  assert.doesNotMatch(fs.readFileSync(calls, "utf8"), /restart|stop|start/, "no instance restarted");
  assert.match(r.stdout, /use it from their next stop or restart/);
  assert.equal(runScript("unit", "--check").status, 0);
  const again = runScript("unit");
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /up to date/);
  assert.equal(reloads(), 2, "an up-to-date unit is still reloaded, so a rerun repairs a failed reload");

  // A reload that fails after the write: the run fails, --check sees systemd has not loaded the file,
  // and a rerun reloads.
  fs.writeFileSync(installed, shipped.replace(/^KillMode=.*\n/m, ""));
  fs.writeFileSync(failReload, "");
  const failed = runScript("unit");
  assert.notEqual(failed.status, 0, "a failed daemon-reload fails the run");
  assert.match(failed.stderr, /daemon-reload failed/);
  assert.equal(unitSetting(fs.readFileSync(installed, "utf8"), "KillMode"), "mixed", "the file was written before the reload");
  fs.writeFileSync(needReload, "yes\n");
  assert.equal(runScript("unit", "--check").status, 0, "no loaded instance: nothing runs the old unit");
  fs.writeFileSync(instances, "");
  const stale = runScript("unit", "--check");
  assert.equal(stale.status, 1, "a matching file that a loaded instance has not reloaded is out of date");
  assert.match(stale.stdout, /has not reloaded it for mw-work@proj\.service/, "the message names the instance");
  assert.doesNotMatch(fs.readFileSync(calls, "utf8"), /^show .*mw-work@\.service$/m, "the template is not queried");
  fs.rmSync(failReload);
  const before = reloads();
  const repaired = runScript("unit");
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(reloads(), before + 1, "the rerun reloads systemd");
  fs.rmSync(needReload);
  assert.equal(runScript("unit", "--check").status, 0);
  assert.equal(runScript("unit", "bogus").status, 2);
});

test("REQ-engine-011 AC-3: the ops docs say that a restart waits for the card and how to stop at once", () => {
  // @req REQ-engine-011
  const docs = {
    "ops/mw-work@.service": fs.readFileSync(WORK_UNIT, "utf8"),
    "README.md": fs.readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8"),
    "docs/install.md": fs.readFileSync(path.join(PACKAGE_ROOT, "docs", "install.md"), "utf8"),
  };
  for (const [file, text] of Object.entries(docs)) {
    const flat = text.replace(/\s*\n#?\s*/g, " ");
    assert.match(flat, /KillMode=mixed/, `${file} names KillMode=mixed`);
    assert.match(flat, /waits for the (current )?card/, `${file} says a stop or restart waits for the card`);
    assert.match(flat, /systemctl kill --kill-whom=main -s SIGINT mw-work@<name>/, `${file} says how to stop at once`);
  }
  for (const [file, text] of Object.entries(docs)) assert.doesNotMatch(text, /waits up to 30 minutes/, `${file}: the old stop timeout is gone`);
});


// ── REQ-engine-012: queued deliveries flush while this machine keeps the lease ──────────────

/** The `*.lock` run locks in the project's locks folder now (the repository lock left out). */
const runLocks = (dir: string) => {
  try {
    return fs.readdirSync(path.join(localDir(new Project(dir)), "locks")).filter((n) => n.endsWith(".lock") && !n.startsWith(".") && n !== "repo.lock");
  } catch {
    return [];
  }
};

/** A second card like DEMO-1, both marked ready and committed (and pushed when there is a hub). */
function twoReadyCards(dir: string, push: boolean): void {
  const one = read(dir, "cards/DEMO-1.card.md").replace("status: todo", "status: ready");
  write(dir, "cards/DEMO-1.card.md", one);
  write(dir, "cards/DEMO-2.card.md", one.replaceAll("DEMO-1", "DEMO-2"));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "two ready cards");
  if (push) git(dir, "push", "-q", "hub", "main");
}

/**
 * A run of card `card` on this machine inside its merge phase, as another `mw` process leaves it: its
 * state says `running` at the flow's merge phase, and a live process (a `sleep`, killed after the test)
 * holds its run lock. `set` changes the run's status, as the run does when it blocks or ends; `end`
 * ends that process and clears its lock.
 */
function mergingRun(dir: string, card: string): { set(status: "running" | "blocked" | "done", phase?: "merge" | "reflect"): void; end(): void } {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  after(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  assert.ok(child.pid);
  const p = new Project(dir);
  const phases = p.flows().get("standard")!.phases;
  const at = (id: string) => phases.findIndex((x) => x.id === id);
  assert.equal(phases[at("merge")]!.action, "merge");
  write(dir, `.mergewright/local/locks/${card}.lock`, JSON.stringify({ pid: child.pid, host: "alpha", started: new Date().toISOString() }) + "\n");
  const set = (status: "running" | "blocked" | "done", phase: "merge" | "reflect" = "merge") => {
    const now = new Date().toISOString();
    write(dir, `.mergewright/runs/${card}/state.json`, JSON.stringify({ card, flow: "standard", phase: at(phase), round: 0, status, approvals: [], host: "alpha", started: now, updated: now, history: [], warnings: [] }, null, 2) + "\n");
  };
  set("running");
  // The process ends: its sleep is killed and its run lock is cleared, as the run's exit leaves it.
  const end = () => {
    child.kill("SIGKILL");
    fs.rmSync(path.join(dir, `.mergewright/local/locks/${card}.lock`), { force: true });
  };
  return { set, end };
}

test("REQ-engine-012: mergingHere() counts a run from entering its merge phase until it ends or blocks, and only while a live process holds its run lock", () => {
  // @req REQ-engine-012
  const dir = project();
  const p = new Project(dir);
  assert.deepEqual(mergingHere(p), [], "no run, no lock");
  const run9 = mergingRun(dir, "DEMO-9");
  assert.deepEqual(mergingHere(p), ["DEMO-9"], "running at the merge phase with a live lock");
  run9.set("running", "reflect");
  assert.deepEqual(mergingHere(p), [], "past the merge phase");
  run9.set("blocked");
  assert.deepEqual(mergingHere(p), [], "blocked at the merge phase");
  run9.set("done");
  assert.deepEqual(mergingHere(p), [], "ended");
  run9.set("running");
  write(dir, ".mergewright/local/locks/DEMO-9.lock", JSON.stringify({ pid: deadPid(), host: "alpha", started: new Date().toISOString() }) + "\n");
  assert.deepEqual(mergingHere(p), [], "a lock left by a process that is gone: nothing is merging");
});

test("REQ-engine-012 AC-1: on a hub, mw work flushes the queue between two cards with the lease kept, within the flush budget", async () => {
  // @req REQ-engine-012
  let dir = "";
  let hubDir = "";
  const status = (id: string) => (fs.existsSync(path.join(dir, ".mergewright", "runs", id, "state.json")) ? JSON.parse(read(dir, `.mergewright/runs/${id}/state.json`)).status : "none");
  // At each delivery connection: the lease on the hub, the run locks held here, and both cards' runs.
  const hole = await deliveryBlackhole(() => ({ lease: leaseOn(hubDir), locks: runLocks(dir), d1: status("DEMO-1"), d2: status("DEMO-2") }));
  const p = hubPair({ roles: { worker: { runs: "shell", command: WORKER } } });
  dir = p.a;
  hubDir = p.hubDir;
  patchConfig(p.a, mem0At(hole.url));
  twoReadyCards(p.a, true);
  useScript(script());
  new Queue(localDir(new Project(p.a))).add("mem0", "mem0 (demo): 1 lesson(s): Between", { lessons: [lesson("Between")] });
  queueTiming.budgetMs = 300;
  const lines: string[] = [];
  const r = await as("alpha", undefined, () => work(p.a, { out: (l) => lines.push(l), integrations: () => fakeIntegrations() }));
  assert.equal(r.code, 0, lines.join("\n"));
  assert.deepEqual(r.runs.map((x) => `${x.id}:${x.status}`), ["DEMO-1:done", "DEMO-2:done"]);
  assert.deepEqual(hole.hits.map((h) => h.probe), [
    { lease: true, locks: [], d1: "done", d2: "none" },
    { lease: true, locks: [], d1: "done", d2: "done" },
    { lease: false, locks: [], d1: "done", d2: "done" },
  ], "a flush after DEMO-1 and before DEMO-2 started with the lease kept, one after DEMO-2, one after the release");
  assert.ok(!lines.some((l) => /not retried/.test(l)), lines.join("\n"));
  assert.deepEqual(queueItems(p.a).map((i) => [i.kind, i.attempts]), [["mem0", 3]], "each flush was cut at its budget (REQ-engine-009); the item stays queued");
});

test("REQ-engine-012 AC-1: mw queue flush delivers on request while this machine keeps the lease", async () => {
  // @req REQ-engine-012
  let at = { dir: "", hubDir: "" };
  const writes: unknown[] = [];
  const mem0 = await mockServer((req) => {
    if (req.method === "POST" && req.url === "/memories") {
      writes.push({ lease: leaseOn(at.hubDir), locks: runLocks(at.dir) });
      return { body: { results: [{ id: "m1" }] } };
    }
    return { body: { results: [] } };
  });
  after(() => mem0.close());
  at = hubProjectAt(mem0.url);
  await as("alpha", undefined, () => openHub(new Project(at.dir)).take());
  assert.equal(leaseOn(at.hubDir), true);
  new Queue(localDir(new Project(at.dir))).add("mem0", "mem0 (demo): 1 lesson(s): On request", { lessons: [lesson("On request")] });
  const r = await as("alpha", undefined, () => mwIn(at.dir, ["queue", "flush"]));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /delivered\s+mem0 /);
  assert.deepEqual(writes, [{ lease: true, locks: [] }], "delivered once, with the lease on the hub");
  assert.deepEqual(queueItems(at.dir), []);
  assert.equal(leaseOn(at.hubDir), true, "the lease is still this machine's");
});

test("REQ-engine-012 AC-2: mw work does not flush while a run of this machine is inside its merge phase, nor while that run's process keeps the lease after it, and flushes once that process ended", async () => {
  // @req REQ-engine-012
  let dir = "";
  let hubDir = "";
  const hole = await deliveryBlackhole(() => ({ lease: leaseOn(hubDir), locks: runLocks(dir) }));
  const p = hubPair({ roles: { worker: { runs: "shell", command: WORKER } } });
  dir = p.a;
  hubDir = p.hubDir;
  patchConfig(p.a, mem0At(hole.url));
  write(p.a, "cards/DEMO-1.card.md", read(p.a, "cards/DEMO-1.card.md").replace("status: todo", "status: ready"));
  git(p.a, "add", "-A");
  git(p.a, "commit", "-qm", "ready, mem0 down");
  git(p.a, "push", "-q", "hub", "main");
  useScript(script());
  const item = new Queue(localDir(new Project(p.a))).add("mem0", "mem0 (demo): 1 lesson(s): Wait", { lessons: [lesson("Wait")] });
  const bytes = fs.readFileSync(item);
  // Another 'mw' process of this machine is inside DEMO-9's merge phase the whole time.
  const run9 = mergingRun(p.a, "DEMO-9");
  queueTiming.budgetMs = 300;
  const lines: string[] = [];
  const r = await as("alpha", undefined, () => work(p.a, { out: (l) => lines.push(l), integrations: () => fakeIntegrations() }));
  assert.equal(r.code, 0, lines.join("\n"));
  assert.deepEqual(r.runs.map((x) => `${x.id}:${x.status}`), ["DEMO-1:done"]);
  assert.equal(hole.hits.length, 0, "no connection while DEMO-9 was inside its merge phase");
  assert.ok(fs.readFileSync(item).equals(bytes), "the item file is byte-for-byte unchanged");
  assert.ok(lines.includes("the integration queue was not retried because DEMO-9 is inside its merge phase on this machine; a later pass retries it"), lines.join("\n"));
  assert.ok(lines.some((l) => /kept the lease: another 'mw' process on this machine/.test(l)), lines.join("\n"));
  assert.equal(leaseOn(p.hubDir), true, "the lease is kept for DEMO-9's run");

  // DEMO-9 leaves its merge phase (it blocks there), but its process still holds its run lock and the
  // lease stays on the hub for it: the next pass still does not flush.
  run9.set("blocked");
  const held: string[] = [];
  const again = await as("alpha", undefined, () => work(p.a, { out: (l) => held.push(l), integrations: () => fakeIntegrations() }));
  assert.equal(again.code, 0, held.join("\n"));
  assert.equal(hole.hits.length, 0, "no connection while another 'mw' process of this machine keeps the lease");
  assert.ok(fs.readFileSync(item).equals(bytes), "the item file is still byte-for-byte unchanged");
  assert.ok(held.includes("the integration queue was not retried because another 'mw' process on this machine (alpha) is running a card and keeps the lease; a later pass retries it"), held.join("\n"));
  assert.equal(leaseOn(p.hubDir), true, "the lease is still kept for DEMO-9's process");

  // DEMO-9's process ends and clears its lock: the next pass flushes (and the lease is this machine's).
  run9.end();
  const last: string[] = [];
  const done = await as("alpha", undefined, () => work(p.a, { out: (l) => last.push(l), integrations: () => fakeIntegrations() }));
  assert.equal(done.code, 0, last.join("\n"));
  assert.deepEqual(hole.hits.map((h) => h.probe), [{ lease: true, locks: [] }], "one flush once no other process of this machine had a run, the lease still on the hub");
  assert.equal(queueItems(p.a)[0]!.attempts, 1, "cut at the budget, still queued");
});

test("REQ-engine-012 AC-2: mw queue flush waits for a run of this machine to leave its merge phase, not for the lease", async () => {
  // @req REQ-engine-012
  let at = { dir: "", hubDir: "" };
  let left = false;
  const writes: unknown[] = [];
  const mem0 = await mockServer((req) => {
    if (req.method === "POST" && req.url === "/memories") {
      writes.push({ lease: leaseOn(at.hubDir), mergeEnded: left });
      return { body: { results: [{ id: "m1" }] } };
    }
    return { body: { results: [] } };
  });
  after(() => mem0.close());
  at = hubProjectAt(mem0.url);
  await as("alpha", undefined, () => openHub(new Project(at.dir)).take());
  const item = new Queue(localDir(new Project(at.dir))).add("mem0", "mem0 (demo): 1 lesson(s): After the merge", { lessons: [lesson("After the merge")] });
  const bytes = fs.readFileSync(item);
  const run9 = mergingRun(at.dir, "DEMO-9");
  const poll = mergeWait.pollMs;
  mergeWait.pollMs = 50;
  try {
    const flushing = as("alpha", undefined, () => mwIn(at.dir, ["queue", "flush"]));
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(writes, [], "nothing sent while DEMO-9 is inside its merge phase");
    assert.ok(fs.readFileSync(item).equals(bytes), "the item file is byte-for-byte unchanged while it waits");
    left = true;
    run9.set("running", "reflect");
    const r = await flushing;
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^waiting for DEMO-9 to leave its merge phase on this machine before the queue is flushed$/m);
    assert.match(r.out, /delivered\s+mem0 /);
  } finally {
    mergeWait.pollMs = poll;
  }
  assert.deepEqual(writes, [{ lease: true, mergeEnded: true }], "delivered once, after the merge phase, with the lease still on the hub");
  assert.deepEqual(queueItems(at.dir), []);
});


// ── REQ-engine-014: mw status tells a driven run from a queued one ──

/** A project with ready card DEMO-1 committed and a run state that says running at phase 'gate' on host "box". */
function queuedProject(): string {
  const dir = newProject();
  write(dir, "cards/DEMO-1.card.md", "---\nid: DEMO-1\ntitle: Card DEMO-1\nkind: feature\nstatus: ready\nscope: [src/**]\n---\n\n## Why\n\nBecause.\n\n## Acceptance\n\n- It works.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "card");
  const now = new Date().toISOString();
  write(dir, ".mergewright/runs/DEMO-1/state.json", JSON.stringify({ card: "DEMO-1", flow: "standard", phase: 2, round: 0, status: "running", approvals: [], host: "box", started: now, updated: now, history: [], warnings: [] }));
  return dir;
}

const lockOf = (dir: string) => path.join(dir, ".mergewright", "local", "locks", "DEMO-1.lock");
function writeLock(dir: string, info: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(lockOf(dir)), { recursive: true });
  fs.writeFileSync(lockOf(dir), JSON.stringify({ host: "box", started: new Date().toISOString(), ...info }));
}
/** The run state and lock as bytes and mtimes, to prove that reading the status wrote nothing. */
function snapshot(dir: string): string {
  return [path.join(dir, ".mergewright", "runs", "DEMO-1", "state.json"), lockOf(dir)]
    .map((f) => (fs.existsSync(f) && fs.statSync(f).isFile() ? `${fs.readFileSync(f, "utf8")}@${fs.statSync(f).mtimeMs}` : "-")).join("\n");
}
const QUEUED = "queued ('mw work' or 'mw run DEMO-1' resumes it at 'gate')";
const boxEnv = { MW_HOST: "box" };

test("REQ-engine-014 AC-1: a run whose recorded driver process is gone reads queued, with its phase and how to drive it, in mw status and mw work --dry-run", () => {
  // @req REQ-engine-014
  const dir = queuedProject();
  // A real process that has exited (and was reaped): its pid names no process any more.
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  writeLock(dir, { pid: child.pid });
  const before = snapshot(dir);

  const st = mw(dir, ["status"], boxEnv);
  assert.equal(st.code, 0, st.err);
  const row = st.out.split("\n").find((l) => l.startsWith("DEMO-1"))!;
  assert.ok(row.includes(QUEUED), row);
  assert.match(row, /\sgate\s+Card DEMO-1$/, "the phase column names the phase it resumes at");
  assert.doesNotMatch(row, /running/);
  const json = JSON.parse(mw(dir, ["status", "--json"], boxEnv).out) as { status: string; phase: string }[];
  assert.deepEqual(json.map((r) => [r.status, r.phase]), [[QUEUED, "gate"]]);

  const dry = mw(dir, ["work", "--dry-run"], boxEnv);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /would run, in this order:\n {2}DEMO-1 {3}(.*): Card DEMO-1\n/);
  assert.equal(/ {2}DEMO-1 {3}(.*): Card DEMO-1/.exec(dry.out)![1], QUEUED, "the same words as mw status");
  assert.doesNotMatch(dry.out, /running/);

  assert.equal(snapshot(dir), before, "reading the status wrote neither the state nor the lock");
});

test("REQ-engine-014 AC-1: a run whose driver is alive still reads running; a reused pid or an unreadable lock reads queued without failing", () => {
  // @req REQ-engine-014
  const dir = queuedProject();
  // The driver is this test process (alive, and not the 'mw' process that reads the status).
  const self = processIdentity(process.pid);
  writeLock(dir, { pid: process.pid, ...(self.started ? { procStart: self.started } : {}) });
  const before = snapshot(dir);
  let st = mw(dir, ["status"], boxEnv);
  assert.equal(st.code, 0, st.err);
  assert.match(st.out, /^DEMO-1\s+running\s+standard\s+gate\s+Card DEMO-1$/m);
  assert.doesNotMatch(st.out, /queued/);
  const dry = mw(dir, ["work", "--dry-run"], boxEnv);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, new RegExp(`DEMO-1 {3}process ${process.pid} on this machine is running it now`));
  assert.doesNotMatch(dry.out, /queued/);
  assert.equal(snapshot(dir), before);

  // The same pid with another start time: the pid was reused, so the recorded driver is gone.
  if (self.started) {
    writeLock(dir, { pid: process.pid, procStart: "1" });
    st = mw(dir, ["status"], boxEnv);
    assert.equal(st.code, 0, st.err);
    assert.ok(st.out.includes(QUEUED), st.out);
  }
  // A lock that cannot be read as a file (a folder in its place) is no driver, and no crash.
  fs.rmSync(lockOf(dir));
  fs.mkdirSync(lockOf(dir));
  st = mw(dir, ["status"], boxEnv);
  assert.equal(st.code, 0, st.err);
  assert.ok(st.out.includes(QUEUED), st.out);
  assert.ok(fs.statSync(lockOf(dir)).isDirectory(), "the unreadable lock is left as it was");
});

test("REQ-engine-014 AC-1: a queued run whose card would not run reads queued in mw work --dry-run too, next to the reason", () => {
  // @req REQ-engine-014
  const dir = queuedProject();
  // The card is set back to todo, so eligibility() lists it as not eligible.
  const card = path.join(dir, "cards", "DEMO-1.card.md");
  fs.writeFileSync(card, fs.readFileSync(card, "utf8").replace("status: ready", "status: todo"));
  git(dir, "commit", "-q", "-am", "todo");
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  writeLock(dir, { pid: child.pid });
  const before = snapshot(dir);

  const st = mw(dir, ["status"], boxEnv);
  assert.equal(st.code, 0, st.err);
  assert.ok(st.out.split("\n").find((l) => l.startsWith("DEMO-1"))!.includes(QUEUED), st.out);

  const dry = mw(dir, ["work", "--dry-run"], boxEnv);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /not eligible:\n/);
  const line = dry.out.split("\n").find((l) => l.startsWith("  DEMO-1"))!;
  assert.ok(line.includes("its status is 'todo'"), `the reason is kept: ${line}`);
  assert.ok(line.includes(`[${QUEUED}]`), `the queued label is shown: ${line}`);
  assert.equal(snapshot(dir), before, "reading the status wrote neither the state nor the lock");
});
