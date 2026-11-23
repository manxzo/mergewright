// Agent CLI harnesses (claude, codex, local, and the hermes package's, run as the engine runs it). Hermetic tests use fake CLIs on PATH and a
// local HTTP server; live smoke tests against the real CLIs run only with MW_LIVE=1.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractJson } from "../src/engine/extract.ts";
import claude, { CLAUDE_SANDBOX_SETTINGS, claudeSandbox } from "../src/engine/harness/claude.ts";
import codex from "../src/engine/harness/codex.ts";
import { codexReplyFile } from "../src/engine/harness/codex.ts";
import local from "../src/engine/harness/local.ts";
import { capture, runCli, timing } from "../src/engine/harness/proc.ts";
import shell from "../src/engine/harness/shell.ts";
import { spawnAsync } from "../src/engine/gate.ts";
import type { HarnessRequest } from "../src/engine/types.ts";
import type { McpWiring } from "../src/mcpconfig.ts";
import type { Role } from "../src/model/role.ts";
import { packageHarness, tmpDir } from "./helpers.ts";

const hermes = await packageHarness("hermes");

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "harness", "fake-cli.mjs");
const MW_DENIED = [
  "init", "card", "config", "eject", "roles", "flows", "gates", "mcps", "mcp", "upgrade", "help", "version",
  "run", "approve", "abort", "status", "work", "sync", "lease", "queue", "integrations", "doctor",
  "memory index", "memory show", "memory add", "memory state", "memory list", "memory push",
  "spec list", "spec accept", "spec reject",
];
const DISALLOWED = [
  "Bash(sudo:*)", "Bash(ssh:*)", "Bash(scp:*)", "Bash(git push:*)", "Bash(git merge:*)",
  "Bash(git commit:*)", "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(git switch:*)", "Bash(git stash:*)",
  "Bash(git rebase:*)", "Bash(git config:*)", "Bash(git worktree:*)", "Bash(git branch:*)", "Bash(git remote:*)",
  "Bash(git update-ref:*)",
  "Bash(claude:*)", "Bash(codex:*)", "Bash(hermes:*)",
  "Bash(mw)", "Bash(mw memory)", "Bash(mw spec)",
  ...MW_DENIED.map((c) => `Bash(mw ${c}:*)`),
];
const SCHEMA = { type: "object", properties: { pong: { type: "boolean" } }, required: ["pong"], additionalProperties: false };
const MCP: McpWiring = {
  json: { mcpServers: { docs: { command: "docs-mcp", args: [], env: { DOCS_TOKEN: "s3cret" } } } },
  codexArgs: ["-c", 'mcp_servers.docs.command="docs-mcp"', "-c", 'mcp_servers.docs.env={DOCS_TOKEN = "s3cret"}'],
  codexEnv: {},
  env: { DOCS_TOKEN: "s3cret" },
  ids: ["docs"],
};
/** Variables baseEnv may pass from the parent process. */
const BASE_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HERMES_HOME", "GIT_TERMINAL_PROMPT"];

function role(over: Partial<Role> = {}): Role {
  return {
    id: "reviewer", description: "", runs: "claude", mode: "advise", output: "text",
    limits: {}, mcps: [], args: [], prompt: "", file: "roles/reviewer.role.md", origin: "project", ...over,
  };
}

let fakeBin = "";
let emptyBin = "";

interface Record_ {
  name: string;
  pid: number;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  queryFile?: string;
  mcpConfig?: unknown;
  mcpMode?: number;
}

/** A request against the fake CLIs; returns it with the path its fake will record to. */
function fakeReq(over: Partial<HarnessRequest> = {}, fakeEnv: Record<string, string> = {}): { req: HarnessRequest; record: () => Record_ } {
  const dir = tmpDir("mw-harness-");
  const cwd = path.join(dir, "work");
  fs.mkdirSync(cwd);
  const recordFile = path.join(dir, "record.json");
  const req: HarnessRequest = {
    role: role(),
    prompt: "Say \"hi\" and $(do nothing) `please`",
    cwd,
    mode: "advise",
    outputKind: "text",
    limits: { minutes: 1 },
    env: { PATH: `${fakeBin}:/usr/bin:/bin`, MW_ROLE: "reviewer", MW_CARD: "DEMO-1", FAKE_RECORD: recordFile, ...fakeEnv },
    runDir: path.join(dir, "run"),
    label: "3-review-reviewer",
    ...over,
  };
  return { req, record: () => JSON.parse(fs.readFileSync(recordFile, "utf8")) as Record_ };
}

before(() => {
  fakeBin = tmpDir("mw-fakebin-");
  emptyBin = tmpDir("mw-emptybin-");
  for (const name of ["claude", "codex", "hermes"]) {
    const f = path.join(fakeBin, name);
    fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${name} "$@"\n`, { mode: 0o755 });
  }
  process.env.SUPER_SECRET = "x";
});
after(() => {
  delete process.env.SUPER_SECRET;
});

function assertMinimalEnv(rec: Record_, req: HarnessRequest, extra: string[] = []): void {
  assert.equal(rec.env.SUPER_SECRET, undefined, "a parent variable leaked into the agent's environment");
  // PWD, SHLVL and _ are set by the fake's /bin/sh wrapper, not passed by the harness.
  const allowed = new Set([...BASE_KEYS, ...Object.keys(req.env), ...extra, "PWD", "SHLVL", "_"]);
  // macOS adds __CF_USER_TEXT_ENCODING to the environment of every process it starts.
  if (process.platform === "darwin") allowed.add("__CF_USER_TEXT_ENCODING");
  const unexpected = Object.keys(rec.env).filter((k) => !allowed.has(k));
  assert.deepEqual(unexpected, []);
  assert.equal(rec.env.MW_ROLE, "reviewer");
  assert.equal(rec.env.GIT_TERMINAL_PROMPT, "0");
}

// ── claude ──────────────────────────────────────────────────────────────────────────────────

describe("claude harness", () => {
  test("advise without model, schema, turns or MCP: no tools, prompt on stdin, plain result", async () => {
    const { req, record } = fakeReq();
    const r = await claude.run(req);
    const rec = record();
    assert.deepEqual(rec.argv, ["-p", "--output-format", "json", "--setting-sources", "project,local", "--tools", "", "--disallowedTools", ...DISALLOWED, "--strict-mcp-config", "--permission-mode", "dontAsk"]);
    assert.equal(rec.stdin, req.prompt);
    assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(req.cwd));
    assertMinimalEnv(rec, req);
    assert.equal(r.ok, true);
    assert.equal(r.text, "plain answer");
    assert.equal(r.json, undefined);
    assert.deepEqual(r.usage, { inputTokens: 115, outputTokens: 7, costUsd: 0.0123, freshInputTokens: 10, cacheWriteTokens: 5, cacheReadTokens: 100, turns: 2 });
    assert.ok(fs.readFileSync(path.join(req.runDir, "3-review-reviewer.claude.stdout"), "utf8").includes('"result"'));
    assert.ok(fs.existsSync(path.join(req.runDir, "3-review-reviewer.claude.stderr")));
  });

  test("read with model, schema, turns, MCP and role args", async () => {
    const { req, record } = fakeReq({
      role: role({ model: "sonnet", args: ["--effort", "low"] }),
      mode: "read",
      outputKind: "findings",
      outputSchema: SCHEMA,
      limits: { minutes: 1, turns: 5 },
      mcp: MCP,
    });
    const r = await claude.run(req);
    const rec = record();
    // Outside a project's runs folder the scratch folder is inside the run directory (REQ-engine-006).
    const mcpFile = path.join(req.runDir, ".scratch", "3-review-reviewer.mcp.json");
    assert.deepEqual(rec.argv, [
      "-p", "--output-format", "json", "--setting-sources", "project,local", "--model", "sonnet", "--json-schema", JSON.stringify(SCHEMA),
      "--tools", "Read,Grep,Glob", "--allowedTools", "Read", "Grep", "Glob", "LS", "mcp__docs",
      "--disallowedTools", ...DISALLOWED, "--mcp-config", mcpFile, "--strict-mcp-config",
      "--permission-mode", "dontAsk", "--max-turns", "5", "--effort", "low",
    ]);
    assert.deepEqual(rec.mcpConfig, MCP.json);
    assert.equal(rec.mcpMode, 0o600);
    assert.equal(fs.existsSync(mcpFile), false, "the MCP config is removed when the phase ends");
    assert.equal(rec.env.DOCS_TOKEN, "s3cret"); // MCP variables reach the agent
    assertMinimalEnv(rec, req, ["DOCS_TOKEN"]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.json, { pong: true });
    assert.deepEqual(JSON.parse(r.text), { pong: true });
  });

  test("write without a usable sandbox (no bubblewrap or socat): full tool set, no sandbox settings", async () => {
    const { req, record } = fakeReq({ mode: "write", outputKind: "handoff" }, { PATH: fakeBin });
    await claude.run(req);
    const argv = record().argv;
    if (process.platform === "darwin") {
      // On macOS Claude Code's sandbox is Seatbelt, part of the system: no bubblewrap is needed, so it is on.
      assert.equal(claudeSandbox(fakeBin).ok, true);
      const at = argv.indexOf("--settings");
      assert.ok(at > 0, "write mode on macOS runs with the sandbox settings");
      argv.splice(at, 2);
    }
    assert.deepEqual(argv, [
      "-p", "--output-format", "json", "--setting-sources", "project,local",
      "--allowedTools", "Read", "Edit", "Write", "MultiEdit", "Grep", "Glob", "LS", "TodoWrite", "Bash",
      "--disallowedTools", ...DISALLOWED, "--strict-mcp-config", "--permission-mode", "dontAsk",
    ]);
    if (process.platform === "linux") assert.match((claudeSandbox(fakeBin) as { why: string }).why, /bwrap and socat are not installed/);
  });

  test("write where the sandbox is installed but cannot work: no sandbox settings, and the reason says why", { skip: process.platform !== "linux" }, async () => {
    // bubblewrap is present but refuses the nested user namespace, as on Ubuntu with AppArmor's default.
    const tools = tmpDir("mw-sandboxbin-");
    fs.writeFileSync(path.join(tools, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(tools, "socat"), "#!/bin/sh\n", { mode: 0o755 });
    const pathEnv = `${fakeBin}:${tools}`;
    const state = claudeSandbox(pathEnv, undefined);
    assert.equal(state.ok, false);
    assert.match((state as { why: string }).why, /nested user namespace/);
    const { req, record } = fakeReq({ mode: "write", outputKind: "handoff" }, { PATH: pathEnv });
    await claude.run(req);
    assert.equal(record().argv.includes("--settings"), false);
    // The owner can force either way.
    assert.equal(claudeSandbox(pathEnv, "on").ok, true);
    assert.equal(claudeSandbox(`${fakeBin}:${tmpDir()}`, "on").ok, false, "forcing it on still needs the binaries");
    assert.match((claudeSandbox(pathEnv, "off") as { why: string }).why, /MW_CLAUDE_SANDBOX=off/);
  });

  test("write with bubblewrap and socat: the shell sandbox is on, confined to the working directory, never bypassed", { skip: process.platform !== "linux" }, async () => {
    const tools = tmpDir("mw-sandboxbin-");
    for (const t of ["bwrap", "socat"]) fs.writeFileSync(path.join(tools, t), "#!/bin/sh\n", { mode: 0o755 });
    const { req, record } = fakeReq({ mode: "write", outputKind: "handoff" }, { PATH: `${fakeBin}:${tools}` });
    await claude.run(req);
    const argv = record().argv;
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
    assert.deepEqual(settings, CLAUDE_SANDBOX_SETTINGS);
    assert.deepEqual(
      { enabled: settings.sandbox.enabled, failIfUnavailable: settings.sandbox.failIfUnavailable, allowUnsandboxedCommands: settings.sandbox.allowUnsandboxedCommands, autoAllowBashIfSandboxed: settings.sandbox.autoAllowBashIfSandboxed },
      { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true },
    );
    assert.equal((settings.sandbox as Record<string, unknown>).filesystem, undefined, "no extra writable paths: only the working directory (and the temporary directory)");
    assert.ok(argv.indexOf("--settings") < argv.indexOf("--permission-mode"));
    // Read and advise modes have no shell, so no sandbox settings.
    const read = fakeReq({ mode: "read" }, { PATH: `${fakeBin}:${tools}` });
    await claude.run(read.req);
    assert.equal(read.record().argv.includes("--settings"), false);
  });

  test("non-zero exit without JSON, an error result, text output and an empty reply all fail", async () => {
    const fail = await claude.run(fakeReq({}, { FAKE_MODE: "fail" }).req);
    assert.equal(fail.ok, false);
    assert.match(fail.error!, /claude exited with code 2: Error: something broke/);
    const err = await claude.run(fakeReq({}, { FAKE_MODE: "error" }).req);
    assert.equal(err.ok, false);
    assert.match(err.error!, /error_max_turns/);
    assert.ok(err.usage);
    const text = await claude.run(fakeReq({}, { FAKE_MODE: "text" }).req);
    assert.equal(text.ok, false);
    assert.match(text.error!, /no JSON/);
    const empty = await claude.run(fakeReq({}, { FAKE_MODE: "empty" }).req);
    assert.equal(empty.ok, false);
    assert.match(empty.error!, /empty/);
  });
});

// ── codex ───────────────────────────────────────────────────────────────────────────────────

describe("codex harness", () => {
  test("advise without model or schema: read-only sandbox, prompt on stdin, reply from -o", async () => {
    const { req, record } = fakeReq({ role: role({ runs: "codex" }) });
    const r = await codex.run(req);
    const rec = record();
    const reply = codexReplyFile(req);
    assert.deepEqual(rec.argv, ["exec", "--json", "-s", "read-only", "-C", req.cwd, "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "-o", reply, "-"]);
    assert.equal(rec.stdin, req.prompt);
    assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(req.cwd));
    assertMinimalEnv(rec, req);
    assert.equal(r.ok, true);
    assert.equal(r.text, "plain answer");
    assert.equal(r.json, undefined);
    assert.deepEqual(r.usage, { inputTokens: 20, outputTokens: 9 });
    assert.ok(fs.readFileSync(path.join(req.runDir, "3-review-reviewer.codex.stdout"), "utf8").includes("turn.completed"));
  });

  test("read with model, schema object, MCP and role args", async () => {
    const { req, record } = fakeReq({
      role: role({ runs: "codex", model: "gpt-5.5", args: ["-c", "model_reasoning_effort=\"low\""] }),
      mode: "read", outputKind: "findings", outputSchema: SCHEMA, mcp: MCP,
    });
    const r = await codex.run(req);
    const rec = record();
    const schemaFile = path.join(req.runDir, "3-review-reviewer.schema.json");
    assert.deepEqual(rec.argv, [
      "exec", "--json", "-s", "read-only", "-C", req.cwd, "--ephemeral", "--skip-git-repo-check", "--ignore-user-config",
      "--output-schema", schemaFile, "-m", "gpt-5.5", "-o", codexReplyFile(req),
      ...MCP.codexArgs, "-c", "model_reasoning_effort=\"low\"", "-",
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(schemaFile, "utf8")), SCHEMA);
    assert.equal(rec.env.DOCS_TOKEN, "s3cret");
    assertMinimalEnv(rec, req, ["DOCS_TOKEN"]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.json, { pong: true });
  });

  test("write uses workspace-write and an existing schema file", async () => {
    const { req, record } = fakeReq({ role: role({ runs: "codex" }), mode: "write", outputKind: "handoff", outputSchema: SCHEMA, outputSchemaFile: "/schemas/handoff.json" });
    await codex.run(req);
    const argv = record().argv;
    assert.deepEqual(argv.slice(0, 4), ["exec", "--json", "-s", "workspace-write"]);
    assert.equal(argv[argv.indexOf("--output-schema") + 1], "/schemas/handoff.json");
  });

  test("a failed turn and an empty reply fail", async () => {
    const fail = await codex.run(fakeReq({ role: role({ runs: "codex" }) }, { FAKE_MODE: "fail" }).req);
    assert.equal(fail.ok, false);
    assert.equal(fail.error, "codex exited with code 1: model refused");
    const empty = await codex.run(fakeReq({ role: role({ runs: "codex" }) }, { FAKE_MODE: "empty" }).req);
    assert.equal(empty.ok, false);
    assert.match(empty.error!, /no final message/);
  });
});

// ── hermes ──────────────────────────────────────────────────────────────────────────────────

describe("hermes harness", () => {
  test("advise without model or provider: prompt via file, session line stripped, no MCP", async () => {
    const { req, record } = fakeReq({ role: role({ runs: "hermes" }), mcp: MCP });
    const r = await hermes.run(req);
    const rec = record();
    const promptFile = path.join(req.runDir, "3-review-reviewer.hermes.prompt.md");
    assert.deepEqual(rec.argv, ["chat", "-Q", "--oneshot", "--ignore-rules", "-t", "todo", "--query-file", promptFile, "--source", "tool"]);
    assert.equal(rec.queryFile, req.prompt);
    assert.equal(rec.env.DOCS_TOKEN, undefined); // hermes uses its own MCP servers; a package harness gets none
    assertMinimalEnv(rec, req);
    assert.equal(r.ok, true);
    assert.equal(r.text, 'Here you go:\n```json\n{"pong": true}\n```');
    assert.deepEqual(extractJson(r.text), { pong: true });
  });

  test("model, provider, turns and role args", async () => {
    const { req, record } = fakeReq({ role: role({ runs: "hermes", model: "qwen3", provider: "openrouter", args: ["--reasoning", "low"] }), mode: "read", limits: { minutes: 1, turns: 4 } });
    await hermes.run(req);
    assert.deepEqual(record().argv, [
      "chat", "-Q", "--oneshot", "--ignore-rules", "-t", "todo", "--query-file", path.join(req.runDir, "3-review-reviewer.hermes.prompt.md"),
      "-m", "qwen3", "--provider", "openrouter", "--max-turns", "4", "--source", "tool", "--reasoning", "low",
    ]);
  });

  test("non-zero exit, empty reply and write mode fail", async () => {
    const fail = await hermes.run(fakeReq({ role: role({ runs: "hermes" }) }, { FAKE_MODE: "fail" }).req);
    assert.equal(fail.ok, false);
    assert.equal(fail.error, "hermes exited with code 3: hermes: provider error");
    const empty = await hermes.run(fakeReq({ role: role({ runs: "hermes" }) }, { FAKE_MODE: "empty" }).req);
    assert.equal(empty.ok, false);
    const write = await hermes.run(fakeReq({ role: role({ runs: "hermes" }), mode: "write" }).req);
    assert.equal(write.ok, false);
    assert.match(write.error!, /advisory only/);
  });
});

// ── shared process handling ─────────────────────────────────────────────────────────────────

describe("process handling", () => {
  test("a missing CLI is reported, not thrown", async () => {
    for (const [name, h] of [["claude", claude], ["codex", codex], ["hermes", hermes]] as const) {
      const { req } = fakeReq();
      req.env.PATH = emptyBin;
      const r = await h.run(req);
      assert.equal(r.ok, false);
      assert.equal(r.error, `${name} is not installed or not on PATH`);
    }
  });

  test("timeout: SIGTERM stops the agent and the result says timedOut", async () => {
    for (const h of [claude, codex, hermes]) {
      const { req } = fakeReq({ limits: { minutes: 0.005 } }, { FAKE_MODE: "sleep" });
      const r = await h.run(req);
      assert.equal(r.ok, false);
      assert.equal(r.timedOut, true);
      assert.match(r.error!, /timed out after 0.005 minute/);
      assert.ok(r.seconds < 10);
    }
  });

  test("timeout: an agent ignoring SIGTERM is killed after the grace period", async () => {
    const saved = timing.killGraceMs;
    timing.killGraceMs = 300;
    try {
      const { req } = fakeReq({ limits: { minutes: 0.005 } }, { FAKE_MODE: "stubborn" });
      const started = Date.now();
      const r = await claude.run(req);
      assert.equal(r.timedOut, true);
      assert.ok(Date.now() - started < 5000);
    } finally {
      timing.killGraceMs = saved;
    }
  });

  /** Wait until the fake has recorded itself (it is running), then return its pid. */
  async function started(file: () => Record_): Promise<number> {
    for (let i = 0; i < 200; i++) {
      try {
        return file().pid;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    throw new Error("the fake never started");
  }
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  for (const [name, h] of [["claude", claude], ["codex", codex], ["hermes", hermes]] as const) {
    test(`abort: ${name} stops the running agent and reports "aborted"`, async () => {
      const ac = new AbortController();
      const { req, record } = fakeReq({ signal: ac.signal, limits: { minutes: 1 } }, { FAKE_MODE: "sleep" });
      const pending = h.run(req);
      const pid = await started(record);
      assert.equal(alive(pid), true);
      ac.abort();
      const r = await pending;
      assert.equal(r.ok, false);
      assert.equal(r.error, "aborted");
      assert.equal(r.timedOut, undefined);
      assert.equal(alive(pid), false);
    });
  }

  test("abort: an agent ignoring SIGTERM is killed after the abort grace period", async () => {
    const saved = timing.abortGraceMs;
    timing.abortGraceMs = 300;
    try {
      const ac = new AbortController();
      const { req, record } = fakeReq({ signal: ac.signal }, { FAKE_MODE: "stubborn" });
      const pending = claude.run(req);
      const pid = await started(record);
      ac.abort();
      const r = await pending;
      assert.equal(r.error, "aborted");
      assert.equal(alive(pid), false);
    } finally {
      timing.abortGraceMs = saved;
    }
  });

  test("abort: an already aborted signal starts nothing", async () => {
    const { req } = fakeReq({ signal: AbortSignal.abort() });
    const r = await codex.run(req);
    assert.deepEqual([r.ok, r.error], [false, "aborted"]);
    assert.equal(fs.existsSync(String(req.env.FAKE_RECORD)), false);
  });

  test("a missing working directory fails cleanly", async () => {
    const { req } = fakeReq();
    req.cwd = path.join(req.cwd, "nope");
    const r = await claude.run(req);
    assert.equal(r.ok, false);
    assert.match(r.error!, /does not exist/);
  });
});

// ── local ───────────────────────────────────────────────────────────────────────────────────

describe("local harness", () => {
  let server: http.Server;
  let port = 0;
  const seen: { url: string; auth?: string; body: Record<string, unknown> }[] = [];
  let status = 200;
  let huge = false;

  before(async () => {
    server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c: Buffer) => (data += c));
      req.on("end", () => {
        const body = JSON.parse(data) as Record<string, unknown>;
        seen.push({ url: req.url ?? "", auth: req.headers.authorization, body });
        if (huge) {
          // 21 MB of streamed body without a length header: only reading it can tell it is too big.
          res.writeHead(200, { "content-type": "application/json" });
          const chunk = Buffer.alloc(1024 * 1024, 32);
          let sent = 0;
          const pump = () => {
            while (sent < 21) {
              sent++;
              if (!res.write(chunk)) { res.once("drain", pump); return; }
            }
            res.end();
          };
          res.on("error", () => {});
          pump();
          return;
        }
        if (status !== 200) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "model not loaded" } }));
          return;
        }
        const content = body.response_format ? '{"pong": true}' : "plain answer";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-1", object: "chat.completion", model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  /** A port nothing listens on. */
  async function closedPort(): Promise<number> {
    const s = http.createServer();
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const p = (s.address() as AddressInfo).port;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    return p;
  }

  function localReq(env: Record<string, string>, over: Partial<HarnessRequest> = {}): HarnessRequest {
    return fakeReq({ role: role({ runs: "local", profile: "qwen2.5:7b" }), env, ...over }).req;
  }

  test("posts an OpenAI chat completion with the profile as model and the schema as response_format", async () => {
    seen.length = 0;
    status = 200;
    const r = await local.run(localReq({ MW_LOCAL_ENDPOINT: `http://127.0.0.1:${port}/v1/`, MW_LOCAL_KEY: "k-1" }, { outputSchema: SCHEMA, outputKind: "findings" }));
    assert.equal(r.ok, true);
    assert.deepEqual(extractJson(r.text), { pong: true });
    assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 5 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, "/v1/chat/completions");
    assert.equal(seen[0]!.auth, "Bearer k-1");
    assert.deepEqual(seen[0]!.body, {
      model: "qwen2.5:7b",
      messages: [{ role: "user", content: 'Say "hi" and $(do nothing) `please`' }],
      stream: false,
      response_format: { type: "json_schema", json_schema: { name: "findings", schema: SCHEMA } },
    });
  });

  test("model when no profile; no response_format or auth for text", async () => {
    seen.length = 0;
    status = 200;
    const r = await local.run(fakeReq({ role: role({ runs: "local", model: "llama3" }), env: { MW_LOCAL_ENDPOINT: `http://127.0.0.1:${port}/v1` } }).req);
    assert.equal(r.ok, true);
    assert.equal(r.text, "plain answer");
    assert.equal(seen[0]!.body.model, "llama3");
    assert.equal(seen[0]!.body.response_format, undefined);
    assert.equal(seen[0]!.auth, undefined);
  });

  test("a reply body over 20 MB is refused, not held in memory", async () => {
    huge = true;
    try {
      const r = await local.run(localReq({ MW_LOCAL_ENDPOINT: `http://127.0.0.1:${port}/v1` }));
      assert.equal(r.ok, false);
      assert.match(r.error!, /^local: .*the response is larger than 20 MB, so it was refused/);
    } finally {
      huge = false;
    }
  });

  test("falls back when the primary is unreachable or answers 5xx", async () => {
    status = 200;
    const dead = await closedPort();
    const r = await local.run(localReq({ MW_LOCAL_ENDPOINT: `http://127.0.0.1:${dead}/v1`, MW_LOCAL_FALLBACK: `http://127.0.0.1:${port}/v1` }));
    assert.equal(r.ok, true);
    assert.equal(r.text, "plain answer");

    // 5xx on the primary: the same live server answers 503 for the primary, so point the
    // fallback at a second server that answers 200.
    const ok = http.createServer((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "from fallback" } }] }));
    });
    await new Promise<void>((resolve) => ok.listen(0, "127.0.0.1", resolve));
    try {
      status = 503;
      const r2 = await local.run(localReq({ MW_LOCAL_ENDPOINT: `http://127.0.0.1:${port}/v1`, MW_LOCAL_FALLBACK: `http://127.0.0.1:${(ok.address() as AddressInfo).port}/v1` }));
      assert.equal(r2.ok, true);
      assert.equal(r2.text, "from fallback");
      assert.equal(r2.usage, undefined);
    } finally {
      status = 200;
      await new Promise<void>((resolve) => ok.close(() => resolve()));
    }
  });

  test("errors: nothing reachable, 4xx, no endpoint, no model", async () => {
    const dead = await closedPort();
    const none = await local.run(localReq({ MW_LOCAL_ENDPOINT: `http://127.0.0.1:${dead}/v1` }));
    assert.equal(none.ok, false);
    assert.match(none.error!, /unreachable \(ECONNREFUSED\)/);
    status = 404;
    try {
      const nf = await local.run(localReq({ MW_LOCAL_ENDPOINT: `http://127.0.0.1:${port}/v1`, MW_LOCAL_FALLBACK: `http://127.0.0.1:${dead}/v1` }));
      assert.equal(nf.ok, false);
      assert.match(nf.error!, /HTTP 404: model not loaded/);
    } finally {
      status = 200;
    }
    const noEndpoint = await local.run(localReq({}));
    assert.match(noEndpoint.error!, /no endpoint/);
    const noModel = await local.run(fakeReq({ role: role({ runs: "local" }), env: { MW_LOCAL_ENDPOINT: "http://127.0.0.1:1/v1" } }).req);
    assert.match(noModel.error!, /no profile or model/);
  });

  test("abort cancels the request", async () => {
    const slow = http.createServer(() => {
      /* never answers */
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    try {
      const ac = new AbortController();
      const pending = local.run(localReq({ MW_LOCAL_ENDPOINT: `http://127.0.0.1:${(slow.address() as AddressInfo).port}/v1` }, { signal: ac.signal }));
      setTimeout(() => ac.abort(), 100);
      const r = await pending;
      assert.deepEqual([r.ok, r.error, r.timedOut], [false, "aborted", undefined]);
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });

  test("timeout", async () => {
    const slow = http.createServer(() => {
      /* never answers */
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    try {
      const r = await local.run(localReq({ MW_LOCAL_ENDPOINT: `http://127.0.0.1:${(slow.address() as AddressInfo).port}/v1` }, { limits: { minutes: 0.005 } }));
      assert.equal(r.ok, false);
      assert.equal(r.timedOut, true);
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });
});

// ── live smoke tests (MW_LIVE=1; they spend real quota) ─────────────────────────────────────

const LIVE = process.env.MW_LIVE === "1";
const PONG = 'Reply with the JSON object {"pong": true} and nothing else.';

function liveReq(runs: Role["runs"], over: Partial<HarnessRequest> = {}): HarnessRequest {
  const dir = tmpDir("mw-live-");
  const cwd = path.join(dir, "work");
  fs.mkdirSync(cwd);
  return {
    role: role({ runs }),
    prompt: PONG,
    cwd,
    mode: "advise",
    outputKind: "text",
    limits: { minutes: 5 },
    env: { MW_ROLE: "reviewer", MW_CARD: "LIVE-1", MW_MODE: "advise", MW_RUN_DIR: path.join(dir, "run") },
    runDir: path.join(dir, "run"),
    label: "live",
    ...over,
  };
}

describe("live smoke tests", { skip: !LIVE && "set MW_LIVE=1 to run against the real CLIs" }, () => {
  for (const [name, h, over] of [
    ["claude", claude, { role: role({ runs: "claude", model: "sonnet" }), outputSchema: SCHEMA, outputKind: "findings", limits: { minutes: 5, turns: 3 } }],
    ["codex", codex, { outputSchema: SCHEMA, outputKind: "findings" }],
    ["hermes", hermes, {}],
  ] as const) {
    test(`${name} answers a tiny advisory prompt with JSON`, async (t) => {
      const req = liveReq(name, over as Partial<HarnessRequest>);
      const r = await h.run(req);
      t.diagnostic(`${name}: ${JSON.stringify({ ...r, text: r.text.slice(0, 200) })}`);
      t.diagnostic(`${name} stdout: ${fs.readFileSync(path.join(req.runDir, `live.${name}.stdout`), "utf8").slice(0, 1500)}`);
      assert.equal(r.ok, true, r.error);
      assert.deepEqual(extractJson(r.text), { pong: true });
    });
  }

  test("codex accepts the project's strict findings schema", async (t) => {
    const schemaFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas", "output.findings.schema.json");
    const req = liveReq("codex", {
      prompt: "You are reviewing an empty directory. Return a findings report whose summary is \"nothing to review\" and whose findings list is empty.",
      outputSchema: JSON.parse(fs.readFileSync(schemaFile, "utf8")) as object,
      outputSchemaFile: schemaFile,
      outputKind: "findings",
    });
    const r = await codex.run(req);
    t.diagnostic(`codex findings: ${JSON.stringify(r)}`);
    assert.equal(r.ok, true, r.error);
    assert.ok(Array.isArray((r.json as { findings?: unknown[] }).findings));
  });

  test("local answers via the LAN Ollama server", async (t) => {
    const endpoint = "http://192.0.2.147:11434/v1";
    try {
      await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(3000) });
    } catch {
      t.skip(`${endpoint} is unreachable`);
      return;
    }
    const req = liveReq("local", { role: role({ runs: "local", model: "qwen2.5:7b" }), outputSchema: SCHEMA, outputKind: "findings", env: { MW_LOCAL_ENDPOINT: endpoint } });
    const r = await local.run(req);
    t.diagnostic(`local: ${JSON.stringify(r)}`);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(extractJson(r.text), { pong: true });
  });
});

// ── shell harness and bounded output ────────────────────────────────────────────────────────

describe("shell harness MCP file and bounded output", () => {
  test("the shell harness creates its MCP file with mode 0600 even under umask 022", async () => {
    const old = process.umask(0o022);
    try {
      const { req } = fakeReq({ role: role({ runs: "shell", command: `stat -c %a "$MW_MCP_CONFIG" 2>/dev/null || stat -f %Lp "$MW_MCP_CONFIG"; cat > /dev/null` }), mcp: MCP });
      const r = await shell.run(req);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.text, "600", "the file was private while the command ran");
      // REQ-engine-006: written to the scratch folder, not the run folder, and removed afterwards.
      assert.equal(fs.existsSync(path.join(req.runDir, "3-review-reviewer.mcp.json")), false);
      assert.equal(fs.existsSync(path.join(req.runDir, ".scratch", "3-review-reviewer.mcp.json")), false);
      assert.deepEqual(fs.readdirSync(req.runDir).filter((f) => f.endsWith(".tmp")), [], "no temporary file left behind");
    } finally {
      process.umask(old);
    }
  });

  test("an agent's output is kept bounded in memory and streamed in full to disk", async () => {
    assert.equal(capture.maxBytes, 8 * 1024 * 1024);
    const saved = capture.maxBytes;
    capture.maxBytes = 64 * 1024;
    try {
      const { req } = fakeReq();
      const big = `head -c 1000000 /dev/zero | tr '\\0' a; printf END; head -c 300000 /dev/zero | tr '\\0' b >&2`;
      const r = await runCli({ harness: "big", cmd: "sh", args: ["-c", big], req, env: { PATH: "/usr/bin:/bin" } });
      assert.equal(r.code, 0);
      assert.equal(r.stdout.length, 64 * 1024, "only the last 64 KiB stayed in memory");
      assert.ok(r.stdout.endsWith("aaaEND"));
      assert.equal(r.stderr.length, 64 * 1024);
      assert.equal(fs.statSync(path.join(req.runDir, "3-review-reviewer.big.stdout")).size, 1_000_003, "the file has everything");
      assert.equal(fs.statSync(path.join(req.runDir, "3-review-reviewer.big.stderr")).size, 300_000);

      const dir = tmpDir("mw-spawn-");
      const log = path.join(dir, "gate.log");
      const g = await spawnAsync("sh", ["-c", big], { cwd: dir, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 60_000, logFile: log });
      assert.equal(g.code, 0);
      assert.equal(g.stdout.length, 64 * 1024);
      assert.ok(g.stdout.endsWith("END"));
      assert.equal(g.stderr.length, 64 * 1024);
      assert.equal(fs.statSync(log).size, 1_300_003, "the log has both streams in full");
    } finally {
      capture.maxBytes = saved;
    }
  });
});

test("local: roleEnvFor passes local_models' endpoint, fallback and the key from key_env (llama.cpp's --api-key) to a local role only", async () => {
  const { projectWith } = await import("./fixtures/integrations/support.ts");
  const { roleEnvFor } = await import("../src/engine/run.ts");
  const { project } = projectWith({ local_models: { endpoint: "http://192.0.2.7:8081/v1", fallback: "http://192.0.2.7:11434/v1", key_env: "MW_TEST_LLAMACPP_KEY" } });
  process.env.MW_TEST_LLAMACPP_KEY = "llama-key-1";
  try {
    const env = roleEnvFor(project, role({ runs: "local", model: "qwen3.5-9b", mode: "advise" }), undefined, "/tmp/run");
    assert.equal(env.MW_LOCAL_ENDPOINT, "http://192.0.2.7:8081/v1");
    assert.equal(env.MW_LOCAL_FALLBACK, "http://192.0.2.7:11434/v1");
    assert.equal(env.MW_LOCAL_KEY, "llama-key-1");
    const other = roleEnvFor(project, role({ runs: "claude", model: "opus", mode: "advise" }), undefined, "/tmp/run");
    assert.equal(other.MW_LOCAL_KEY, undefined, "only a local role gets the key");
    delete process.env.MW_TEST_LLAMACPP_KEY;
    assert.equal(roleEnvFor(project, role({ runs: "local", model: "qwen3.5-9b", mode: "advise" }), undefined, "/tmp/run").MW_LOCAL_KEY, undefined, "an unset variable sends no key");
  } finally {
    delete process.env.MW_TEST_LLAMACPP_KEY;
  }
});
