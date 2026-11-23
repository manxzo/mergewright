// Requirement tests for specs/harness.spec.md: transient harness errors are recognised by
// one table, retried on the same model with a growing wait, then tried once on the role's alternate
// model before the phase blocks with harness/transient. Quota and session limits are not transient:
// they pause the run for usage (REQ-usage-003).
// Fake CLIs (shell scripts on PATH) print the real provider messages; a local HTTP server stands in
// for an OpenAI-compatible endpoint. No network, and the backoff base is a few milliseconds.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import claude from "../../src/engine/harness/claude.ts";
import codex from "../../src/engine/harness/codex.ts";
import local from "../../src/engine/harness/local.ts";
import { timeoutResult, type CliRun } from "../../src/engine/harness/proc.ts";
import { classifyFailure, classified, isTransient, quotaResetAt } from "../../src/engine/harness/transient.ts";
import { activeQuota, activeQuotas, quotaDir, quotaRecords, recordQuota } from "../../src/engine/quota.ts";
import { invokeRole, transientDelayMs } from "../../src/engine/run.ts";
import type { HarnessRequest } from "../../src/engine/types.ts";
import { callTool, TOOLS } from "../../src/mcpserver/server.ts";
import { delegate, delegateRole, finish } from "../../src/mcpserver/tools/delegate.ts";
import type { Role } from "../../src/model/role.ts";
import { Project } from "../../src/project.ts";
import { newProject, packageHarness, tmpDir, write } from "../helpers.ts";
import { fakeIntegrations, project, run, script, state, useScript } from "../engine-helpers.ts";

const hermes = await packageHarness("hermes");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "..", "src");

// ── The real messages ────────────────────────────────────────────────────────────────────────

const CAPACITY = "Selected model is at capacity. Please try a different model.";
/** Messages that are transient, as the providers print them. */
const TRANSIENT_FIXTURES: Record<string, string> = {
  "codex capacity": `codex exited with code 1: ${CAPACITY}`,
  "claude overloaded": 'claude reported an error: API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  "claude 500": 'claude reported an error: API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
  "anthropic 429": 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
  "codex 429 retries": "exceeded retry limit, last status: 429 Too Many Requests",
  "codex 503": "unexpected status 503 Service Unavailable: upstream connect error",
  "codex stream": "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
  "hermes 502": "hermes exited with code 1: openai.InternalServerError: Error code: 502 - Bad Gateway",
  "provider request timeout": "API Error: Request timed out.",
  "reset connection": "local: http://127.0.0.1:9/v1 unreachable (ECONNRESET)",
  "socket": "request to https://api.anthropic.com/v1/messages failed, reason: socket hang up",
  "local 503": "local: http://127.0.0.1:8081/v1 answered HTTP 503: Service Unavailable",
  // A 429 that states no reset time is a transient, however it says "again".
  "429 try again later": "HTTP 429 Too Many Requests; please try again later",
  "429 try again": "API Error: 429 rate limited, try again",
  "429 retry shortly": "HTTP 429 Too Many Requests: retry shortly",
};
/** Failures of any other kind: never transient. */
const OTHER_FIXTURES: Record<string, string> = {
  "invalid output": "reviewer returned an invalid findings twice: the reply contains no JSON object",
  "missing output": "codex wrote no final message",
  "empty reply": "claude returned an empty reply",
  "auth": "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
  "claude auth": "claude reported an error: Invalid API key · Please run /login",
  "auth 401 overloaded": "API Error: 401 authentication_error: overloaded credentials",
  "missing CLI": "codex is not installed or not on PATH",
  "scope": "the agent changed files outside the card's scope: README.md (scope: src/**)",
  "limits.minutes kill": "codex timed out after 30 minute(s)",
  "aborted": "aborted",
};
/** Quota and session limits: checked before the transient table, never transient. */
const QUOTA_FIXTURES: Record<string, string> = {
  "claude session": "claude reported an error: You've hit your session limit · resets 3pm (Europe/Berlin)",
  "claude session 24h": "You've hit your session limit, resets 15:30",
  "codex usage": "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.",
  "codex 429 reset": "unexpected status 429 Too Many Requests: rate limit reached, try again in 2 hours 5 minutes",
  "429 try again at": "HTTP 429 Too Many Requests: try again at 3:05 PM",
};

// @req REQ-harness-001
test("REQ-harness-001 AC-1, AC-2, AC-3: one table classifies the real messages; quota first, then the exclusions, then the transient patterns", () => {
  for (const [name, text] of Object.entries(TRANSIENT_FIXTURES)) assert.equal(classifyFailure(text), "transient", name);
  for (const [name, text] of Object.entries(OTHER_FIXTURES)) assert.equal(classifyFailure(text), undefined, name);
  for (const [name, text] of Object.entries(QUOTA_FIXTURES)) {
    assert.equal(classifyFailure(text), "quota", name);
    assert.equal(isTransient(text), false, `${name} contains 429 or a limit but is never transient`);
  }
  // The reset time the message states.
  const now = new Date(2026, 9, 10, 9, 0, 0);
  // The real Claude message states its zone: 3pm in Berlin (CEST, UTC+2) is 13:00Z, whatever this host's zone.
  assert.equal(quotaResetAt(QUOTA_FIXTURES["claude session"]!, new Date("2026-10-10T08:00:00Z"))?.toISOString(), "2026-10-10T13:00:00.000Z");
  assert.equal(quotaResetAt(QUOTA_FIXTURES["claude session 24h"]!, now)?.getTime(), new Date(2026, 9, 10, 15, 30).getTime());
  assert.equal(quotaResetAt(QUOTA_FIXTURES["codex usage"]!, now)?.getTime(), new Date(2026, 9, 10, 15, 5).getTime());
  assert.equal(quotaResetAt(QUOTA_FIXTURES["codex 429 reset"]!, now)?.getTime(), now.getTime() + 125 * 60_000);
  assert.equal(quotaResetAt("Claude AI usage limit reached|1791640800", now)?.toISOString(), new Date(1791640800 * 1000).toISOString());
  assert.equal(quotaResetAt("resets 8am", new Date(2026, 9, 10, 9, 0))?.getTime(), new Date(2026, 9, 11, 8, 0).getTime(), "a passed clock time is tomorrow's");

  // The runtime's own limits.minutes kill is never marked, whatever its text.
  const kill = timeoutResult("codex", { code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: true, aborted: false, missing: false, seconds: 1 } as CliRun, 30);
  assert.equal(classified({ ...kill, error: `${kill.error}: ${CAPACITY}` }).transient, undefined);
  assert.equal(classified({ ok: false, text: "", seconds: 0, error: CAPACITY }).transient, true);

  // One table: the patterns live in transient.ts only, and every harness classifies through it.
  // The hermes package's harness classifies through host.agent.exitFailure, the same code.
  for (const file of ["codex.ts", "claude.ts", "local.ts", "proc.ts", "../../../packages/hermes/index.mjs"]) {
    const text = fs.readFileSync(path.join(SRC, "engine", "harness", file), "utf8");
    assert.match(text, /from "\.\/transient\.ts"|exitFailure\(/, `${file} classifies through the shared table`);
    assert.doesNotMatch(text.replace(/^\s*\/\/.*$/gm, ""), /at capacity|overloaded|ECONNRESET|Too Many Requests/i, `${file} keeps no copy of the patterns`);
  }
});

// @req REQ-harness-001
test("REQ-harness-001 AC-3: a reset time is read in the zone the provider states, and this machine's zone is the fallback", async () => {
  const berlin = "You've hit your session limit · resets 3pm (Europe/Berlin)";
  assert.equal(quotaResetAt(berlin, new Date("2026-10-10T08:00:00Z"))?.toISOString(), "2026-10-10T13:00:00.000Z");
  assert.equal(quotaResetAt(berlin, new Date("2026-10-10T14:00:00Z"))?.toISOString(), "2026-10-11T13:00:00.000Z", "a passed time is the next day in Berlin");
  assert.equal(quotaResetAt(berlin, new Date("2026-01-15T08:00:00Z"))?.toISOString(), "2026-01-15T14:00:00.000Z", "winter: CET is UTC+1");
  // Across the DST change (Berlin leaves summer time on 2026-10-25): the next day on Berlin's calendar, not 24 h later.
  assert.equal(quotaResetAt(berlin, new Date("2026-10-24T14:00:00Z"))?.toISOString(), "2026-10-25T14:00:00.000Z");
  assert.equal(quotaResetAt("resets 15:30 (UTC)", new Date("2026-10-10T08:00:00Z"))?.toISOString(), "2026-10-10T15:30:00.000Z");
  assert.equal(quotaResetAt("try again at 3:05 PM UTC", new Date("2026-10-10T08:00:00Z"))?.toISOString(), "2026-10-10T15:05:00.000Z");
  assert.equal(quotaResetAt("resets 9am GMT", new Date("2026-10-10T08:00:00Z"))?.toISOString(), "2026-10-10T09:00:00.000Z");
  assert.equal(quotaResetAt("try again at Oct 12th, 2026 3:05 PM (America/New_York)", new Date("2026-10-10T08:00:00Z"))?.toISOString(), "2026-10-12T19:05:00.000Z");
  // An unknown zone falls back to this machine's zone and does not throw.
  const local = new Date(2026, 9, 10, 9, 0, 0);
  assert.equal(quotaResetAt("resets 3pm (Mars/Olympus_Mons)", local)?.getTime(), new Date(2026, 9, 10, 15, 0).getTime());
  assert.equal(quotaResetAt("resets 3pm", local)?.getTime(), new Date(2026, 9, 10, 15, 0).getTime());

  // The same instant whatever the host's zone.
  const url = new URL("../../src/engine/harness/transient.ts", import.meta.url).href;
  const code = `import { quotaResetAt } from ${JSON.stringify(url)}; console.log(quotaResetAt(${JSON.stringify(berlin)}, new Date("2026-10-10T08:00:00Z"))?.toISOString());`;
  for (const TZ of ["America/Los_Angeles", "Asia/Tokyo"]) {
    const out = await new Promise<string>((resolve, reject) =>
      execFile(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, TZ } }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
    );
    assert.equal(out, "2026-10-10T13:00:00.000Z", `TZ=${TZ}`);
  }
});

// ── Fake CLIs ─────────────────────────────────────────────────────────────────────────────────

let bin = "";
let work = "";
const savedEnv: Record<string, string | undefined> = {};

/**
 * `codex` follows `<work>/plan` (one step per call, the last repeats), counts its calls in
 * `<work>/count` and appends the model it got (`-m`) to `<work>/models`. Steps: capacity, ok, invalid,
 * auth, quota, empty. The reply for `ok` is `<work>/reply`.
 */
const CODEX = (dir: string) => `#!/bin/sh
d='${dir}'
n=$(cat "$d/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$d/count"
model=""; out=""
while [ $# -gt 0 ]; do case "$1" in -m) model="$2"; shift;; -o) out="$2"; shift;; esac; shift; done
echo "$model" >> "$d/models"
cat > /dev/null
step=$(sed -n "\${n}p" "$d/plan"); [ -z "$step" ] && step=$(tail -n 1 "$d/plan")
echo '{"type":"thread.started","thread_id":"t-1"}'
case "$step" in
  capacity)
    echo '{"type":"turn.completed","usage":{"input_tokens":7,"cached_input_tokens":0,"output_tokens":0}}'
    echo '{"type":"error","message":"${CAPACITY}"}'
    echo '{"type":"turn.failed","error":{"message":"${CAPACITY}"}}'
    exit 1;;
  quota)
    echo '{"type":"error","message":"You'"'"'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 3:05 PM."}'
    echo '{"type":"turn.failed","error":{"message":"You'"'"'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 3:05 PM."}}'
    exit 1;;
  auth)
    echo '{"type":"error","message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"}'
    exit 1;;
  empty)
    echo '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":0,"output_tokens":0}}'
    exit 0;;
  invalid)
    echo 'this is not JSON' > "$out"
    echo '{"type":"turn.completed","usage":{"input_tokens":20,"cached_input_tokens":0,"output_tokens":2}}'
    exit 0;;
  *)
    cat "$d/reply" > "$out"
    echo '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}'
    exit 0;;
esac
`;

/** `claude` prints `<work>/claude.json` as its result and exits with `<work>/claude.code`. */
const CLAUDE = (dir: string) => `#!/bin/sh
cat > /dev/null
cat '${dir}/claude.json'
exit $(cat '${dir}/claude.code' 2>/dev/null || echo 1)
`;

/** `hermes` prints `<work>/hermes.err` on stderr and exits 1. */
const HERMES = (dir: string) => `#!/bin/sh
cat '${dir}/hermes.err' >&2
exit 1
`;

before(() => {
  for (const k of ["PATH", "CODEX_HOME", "MW_TRANSIENT_BACKOFF_MS", "MW_MOCK_SCRIPT"]) savedEnv[k] = process.env[k];
  process.env.MW_TRANSIENT_BACKOFF_MS = "5";
  process.env.CODEX_HOME = tmpDir("mw-codex-home-"); // never the owner's login
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  work = tmpDir("mw-fake-");
  bin = path.join(work, "bin");
  fs.mkdirSync(bin);
  for (const [name, body] of [["codex", CODEX(work)], ["claude", CLAUDE(work)], ["hermes", HERMES(work)]] as const) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  process.env.PATH = `${bin}:${savedEnv.PATH ?? "/usr/bin:/bin"}`;
  process.env.MW_TRANSIENT_BACKOFF_MS = "5";
});

const plan = (...steps: string[]) => fs.writeFileSync(path.join(work, "plan"), steps.join("\n") + "\n");
const reply = (value: unknown) => fs.writeFileSync(path.join(work, "reply"), typeof value === "string" ? value : JSON.stringify(value));
const calls = () => Number(fs.existsSync(path.join(work, "count")) ? fs.readFileSync(path.join(work, "count"), "utf8").trim() : 0);
const models = () => (fs.existsSync(path.join(work, "models")) ? fs.readFileSync(path.join(work, "models"), "utf8").trim().split("\n") : []);

function role(over: Partial<Role> = {}): Role {
  return {
    id: "reviewer", description: "", runs: "codex", model: "gpt-5.6-terra", mode: "read", output: "text",
    limits: { minutes: 1 }, mcps: [], args: [], prompt: "Review.", file: "roles/reviewer.role.md", origin: "project", ...over,
  };
}

function req(r: Role, runDir = path.join(work, "run")): HarnessRequest {
  return { role: r, prompt: "Review.", cwd: work, mode: r.mode, outputKind: "text", limits: { minutes: 1 }, env: {}, runDir, label: "t" };
}

// @req REQ-harness-001
test("REQ-harness-001 AC-1: the Codex, Claude, Hermes and local harnesses mark the real transient messages; other failures are not marked", async () => {
  plan("capacity");
  const c = await codex.run(req(role()));
  assert.equal(c.ok, false);
  assert.equal(c.transient, true, c.error);
  assert.match(c.error!, /Selected model is at capacity/);

  plan("auth");
  const auth = await codex.run(req(role()));
  assert.equal(auth.ok, false);
  assert.equal(auth.transient, undefined, `an authentication error is not transient: ${auth.error}`);

  plan("empty");
  const empty = await codex.run(req(role()));
  assert.equal(empty.error, "codex wrote no final message");
  assert.equal(empty.transient, undefined, "missing output is not transient");

  plan("quota");
  const quota = await codex.run(req(role()));
  assert.equal(quota.transient, undefined, "a usage limit is not transient");
  assert.ok(quota.quota?.resetAt, `the reset time is read: ${JSON.stringify(quota)}`);

  fs.writeFileSync(path.join(work, "claude.json"), JSON.stringify({ type: "result", subtype: "success", is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }));
  const cl = await claude.run(req(role({ runs: "claude", model: "opus" })));
  assert.equal(cl.transient, true, cl.error);

  fs.writeFileSync(path.join(work, "claude.json"), JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your session limit · resets 3pm" }));
  const session = await claude.run(req(role({ runs: "claude", model: "opus" })));
  assert.equal(session.transient, undefined);
  assert.ok(session.quota?.resetAt, `Claude's session limit is a quota with its reset time: ${JSON.stringify(session)}`);

  fs.writeFileSync(path.join(work, "claude.json"), JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" }));
  assert.equal((await claude.run(req(role({ runs: "claude", model: "opus" })))).transient, undefined, "Claude's login error is not transient");

  fs.writeFileSync(path.join(work, "hermes.err"), "Traceback (most recent call last):\nopenai.RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit exceeded'}}\n");
  const h = await hermes.run(req(role({ runs: "hermes", model: "qwen3" })));
  assert.equal(h.transient, true, h.error);

  const missing = await codex.run({ ...req(role()), env: { PATH: tmpDir("mw-empty-bin-") } });
  assert.match(missing.error!, /not installed/);
  assert.equal(missing.transient, undefined, "a missing CLI is not transient");

  let status = 503;
  const server = http.createServer((_q, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: status === 401 ? "invalid api key" : "upstream overloaded" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const lreq = { ...req(role({ runs: "local", model: "qwen3", profile: "fast" })), env: { MW_LOCAL_ENDPOINT: endpoint } };
    assert.equal((await local.run(lreq)).transient, true, "HTTP 503 from a local endpoint");
    status = 429;
    assert.equal((await local.run(lreq)).transient, true, "HTTP 429 from a local endpoint");
    status = 401;
    assert.equal((await local.run(lreq)).transient, undefined, "HTTP 401 is an authentication error");
  } finally {
    server.close();
  }
});

// ── invokeRole: retries on the same model ─────────────────────────────────────────────────────

function invoke(r: Role, over: Partial<Parameters<typeof invokeRole>[0]> = {}) {
  const dir = newProject();
  return invokeRole({ project: new Project(dir), role: r, prompt: "Review.", cwd: dir, runDir: path.join(work, "run"), label: "01-review-reviewer", env: {}, ...over });
}

// @req REQ-harness-002
test("REQ-harness-002 AC-1, AC-2: capacity then success retries the same model; usage sums every attempt and the retry count is reported", async () => {
  plan("capacity", "ok");
  reply("looks fine");
  const r = await invoke(role());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, "looks fine");
  assert.equal(r.retries, 1);
  assert.equal(r.model, "gpt-5.6-terra");
  assert.deepEqual(models(), ["gpt-5.6-terra", "gpt-5.6-terra"], "the same model is tried again");
  assert.deepEqual(r.usage, { inputTokens: 107, outputTokens: 10 }, "usage of the failed attempt is counted too");
});

// @req REQ-harness-002
test("REQ-harness-002 AC-1: transient attempts spend no schema retry; invalid output keeps its single retry", async () => {
  plan("invalid", "capacity", "ok");
  reply({ summary: "fine", findings: [] });
  const r = await invoke(role({ output: "findings" }));
  assert.equal(r.ok, true, r.error);
  assert.equal(calls(), 3);
  assert.equal(r.retries, 1);

  fs.rmSync(path.join(work, "count"));
  plan("invalid", "capacity", "invalid", "ok");
  const twice = await invoke(role({ output: "findings" }));
  assert.equal(twice.ok, false);
  assert.match(twice.error!, /returned an invalid findings twice/, "the schema retry was used once and not given back by the transient attempt");
  assert.equal(calls(), 3);
});

// @req REQ-harness-002
test("REQ-harness-002 AC-1: limits.transient_retries bounds the retries and the wait grows", async () => {
  plan("capacity");
  const dir = newProject();
  write(dir, "mergewright.yaml", fs.readFileSync(path.join(dir, "mergewright.yaml"), "utf8").replace(/^limits:\n/m, "limits:\n  transient_retries: 4\n"));
  const p = new Project(dir);
  assert.deepEqual(p.diag.errors, []);
  assert.equal(p.config.limits.transientRetries, 4);
  assert.equal(new Project(newProject()).config.limits.transientRetries, 2, "default 2");
  const r = await invokeRole({ project: p, role: role(), prompt: "x", cwd: dir, runDir: path.join(work, "run"), label: "l", env: {} });
  assert.equal(r.transient, true);
  assert.equal(calls(), 5, "one attempt and four retries");
  process.env.MW_TRANSIENT_BACKOFF_MS = "1000";
  assert.deepEqual([0, 1, 2].map(transientDelayMs), [1000, 3000, 9000]);
  delete process.env.MW_TRANSIENT_BACKOFF_MS;
  assert.equal(transientDelayMs(0), 5000, "5 s by default");
});

// @req REQ-harness-002
test("REQ-harness-002 AC-3: an abort during the backoff wait ends it at once and no further attempt starts", async () => {
  plan("capacity");
  process.env.MW_TRANSIENT_BACKOFF_MS = "60000";
  const ctl = new AbortController();
  const timersBefore = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  const t0 = Date.now();
  const r = await invoke(role({ fallbackModel: "gpt-5.6-sol" }), { signal: ctl.signal, afterAttempt: () => { setTimeout(() => ctl.abort(), 30); } });
  assert.ok(Date.now() - t0 < 5000, `the wait ended at once (${Date.now() - t0} ms)`);
  assert.equal(r.ok, false);
  assert.equal(r.transient, undefined, "a stopped run is not blocked as transient");
  assert.match(r.error!, /stopped before its next attempt/);
  assert.equal(calls(), 1, "no attempt after the signal, not even the fallback");
  await new Promise((res) => setImmediate(res));
  assert.ok(process.getActiveResourcesInfo().filter((x) => x === "Timeout").length <= timersBefore, "the wait's timer was cleared");
});

// @req REQ-harness-002
test("REQ-harness-002 AC-1: the usage guard is asked before a transient retry and before the schema retry; a refusal starts no attempt and pauses the run", async () => {
  const dir = project({ roles: { reviewer: { runs: "codex", model: "gpt-5.6-terra", fallback_model: "gpt-5.6-sol" } } });
  useScript(script());
  plan("capacity", "ok");
  reply({ summary: "fine", findings: [] });
  // Usage turns high once the reviewer's first (capacity) attempt has run; the writing phases before it pass.
  const integrations = fakeIntegrations({ usage: () => (calls() ? { ok: false, detail: "usage at 97% (pause at 90%): paused until below 70%" } : { ok: true, detail: "usage at 10%" }) });
  const s = await run(dir, {}, { integrations });
  assert.equal(s.status, "waiting", s.reason);
  assert.equal(s.reason, "usage");
  assert.equal(s.round, 0, "no remediation round");
  assert.equal(calls(), 1, "no retry started while usage is paused");
  assert.match(s.history.at(-1)!.detail, /was not tried again: usage at 97%/);

  fs.rmSync(path.join(work, "count"));
  plan("invalid", "ok");
  let asked = 0;
  const r = await invoke(role({ output: "findings" }), { integrations: { usageOk: async () => (++asked === 1 ? { ok: true, detail: "usage at 10%" } : { ok: false, detail: "usage at 97%" }) } });
  assert.equal(r.ok, false);
  assert.equal(r.usagePause, "usage at 97%");
  assert.equal(asked, 2, "asked before the first attempt and before the schema retry");
  assert.equal(calls(), 1, "the schema retry was not started");
});

// @req REQ-harness-002
test("REQ-harness-002 AC-3: an invocation whose signal has already fired starts no attempt, not even the first", async () => {
  plan("ok");
  reply("looks fine");
  const ctl = new AbortController();
  ctl.abort();
  let asked = 0;
  const r = await invoke(role({ fallbackModel: "gpt-5.6-sol" }), { signal: ctl.signal, integrations: { usageOk: async () => { asked++; return { ok: true, detail: "fine" }; } } });
  assert.equal(r.ok, false);
  assert.equal(r.notStarted, true);
  assert.equal(r.transient, undefined);
  assert.match(r.error!, /stopped before its first attempt/);
  assert.equal(calls(), 0, "no attempt started");
  assert.equal(asked, 0, "not even the usage guard was asked");
});

// @req REQ-harness-002
test("REQ-harness-002 AC-3: a stop that fires while the usage guard is asked starts no attempt after it", async () => {
  // Before the first attempt.
  plan("ok");
  reply("looks fine");
  const first = new AbortController();
  const r0 = await invoke(role(), { signal: first.signal, integrations: { usageOk: async () => { first.abort(); return { ok: true, detail: "fine" }; } } });
  assert.equal(r0.ok, false);
  assert.match(r0.error!, /stopped before its first attempt/);
  assert.equal(calls(), 0);

  // Before a transient retry, with an alternate model waiting.
  plan("capacity");
  const ctl = new AbortController();
  let asked = 0;
  const r = await invoke(role({ fallbackModel: "gpt-5.6-sol" }), {
    signal: ctl.signal,
    integrations: { usageOk: async () => {
      if (++asked === 2) ctl.abort();
      return { ok: true, detail: "fine" };
    } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.transient, undefined, "a stopped invocation is not blocked as transient");
  assert.match(r.error!, /stopped before its next attempt/);
  assert.equal(asked, 2);
  assert.equal(calls(), 1, "neither the retry nor the fallback started");
});

// @req REQ-harness-002
// @req REQ-usage-004
test("the usage guard is asked before a read role's first attempt on a paid harness; a refusal starts no agent and pauses the run", async () => {
  const dir = project({ roles: { reviewer: { runs: "codex", model: "gpt-5.6-terra", fallback_model: "gpt-5.6-sol" } } });
  useScript(script());
  plan("ok");
  reply({ summary: "fine", findings: [] });
  // Asked once, for the codex reviewer; the mock planner and worker are never asked.
  const integrations = fakeIntegrations({ usage: () => ({ ok: false, detail: "usage at 97% (pause at 90%): paused until below 70%" }) });
  const s = await run(dir, {}, { integrations });
  assert.equal(s.status, "waiting", s.reason);
  assert.equal(s.reason, "usage");
  assert.equal(s.round, 0, "no remediation round");
  assert.equal(calls(), 0, "the codex reviewer never started");
  assert.equal(integrations.of("usageOk").length, 1, "asked once, for the codex reviewer; the mock planner and worker are never asked");
  const last = s.history.at(-1)!;
  assert.equal(last.phase, "review");
  assert.match(last.detail, /usage at 97%/);
});

// @req REQ-harness-003
// @req REQ-usage-004
test("mw_delegate asks the usage guard before its first attempt; a refusal starts no agent and fails with code delegate/usage", async () => {
  const dir = newProject();
  const p = new Project(dir);
  plan("ok");
  reply({ summary: "fine", findings: [] });
  let asked = 0;
  const r = await delegate(p, delegateRole(p, { role: "reviewer" }), "Review the change.", { integrations: { usageOk: async () => { asked++; return { ok: false, detail: "usage at 97%" }; } } });
  assert.equal(r.ok, false);
  assert.equal(asked, 1);
  assert.equal(calls(), 0, "no agent started");
  assert.match(r.error!, /was refused \(reason: usage\): agent usage is too high \(usage at 97%\)/);
  assert.throws(() => finish(r), (err: unknown) => (err as { code?: string }).code === "delegate/usage");
});

// @req REQ-usage-004
test("mw_delegate whose usage guard refuses the schema retry starts no second agent and fails with code delegate/usage, as a refusal before the first attempt does", async () => {
  const dir = newProject();
  const p = new Project(dir);
  plan("invalid", "ok");
  reply({ summary: "fine", findings: [] });
  // Usage turns high only once the first (invalid) attempt has run.
  let asked = 0;
  const integrations = { usageOk: async () => { asked++; return calls() ? { ok: false, detail: "usage at 97%" } : { ok: true, detail: "usage at 10%" }; } };
  const r = await delegate(p, delegateRole(p, { role: "reviewer" }), "Review the change.", { integrations });
  assert.equal(r.ok, false);
  assert.equal(asked, 2, "asked before the first attempt and before the schema retry");
  assert.equal(calls(), 1, "the first attempt ran; no second harness process started");
  assert.match(r.error!, /was refused \(reason: usage\): agent usage is too high \(usage at 97%\)/, "the same message as a refusal before the first attempt");
  assert.throws(() => finish(r), (err: unknown) => (err as { code?: string }).code === "delegate/usage");
});

// ── The alternate model, card phases and mw_delegate ─────────────────────────────────────────

// @req REQ-harness-003
test("REQ-harness-003 AC-1: capacity three times, then the alternate answers; the phase record names it and the history counts the retries", async () => {
  const dir = project({ roles: { reviewer: { runs: "codex", model: "gpt-5.6-terra", fallback_model: "gpt-5.6-sol" } } });
  useScript(script());
  plan("capacity", "capacity", "capacity", "ok");
  reply({ summary: "fine", findings: [] });
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.equal(s.round, 0);
  const review = s.history.find((h) => h.phase === "review")!;
  assert.equal(review.outcome, "ok");
  assert.deepEqual(models(), ["gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-sol"]);
  assert.equal(review.model?.reviewer, "gpt-5.6-sol", "the model that answered");
  assert.match(review.detail, /reviewer: 2 transient retries, answered by its fallback_model 'gpt-5.6-sol'/);
  assert.equal(review.usage?.inputTokens, 121, "three failed attempts (7 each) and the answer (100)");
});

// @req REQ-harness-003
test("REQ-harness-003 AC-2: with no alternate model the phase blocks with harness/transient, naming the model and the last error, spending no round", async () => {
  // The preset reviewer has an alternate; an empty fallback_model in roles.<id> removes it.
  const dir = project({ roles: { reviewer: { runs: "codex", model: "gpt-5.6-terra", fallback_model: "" } } });
  useScript(script());
  plan("capacity");
  const s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.equal(s.round, 0, "no remediation round");
  assert.match(s.reason!, /^harness\/transient: reviewer \(codex\) failed transiently on 'gpt-5\.6-terra' \(3 attempts\); it has no fallback_model\. Last error: .*Selected model is at capacity/);
  assert.equal(calls(), 3);
  assert.equal(s.history.at(-1)!.outcome, "block");
});

// @req REQ-harness-003
test("REQ-harness-003 AC-2: an alternate that also fails transiently blocks naming both models; a writing role spends no round either", async () => {
  const dir = project({ roles: { reviewer: { runs: "codex", model: "gpt-5.6-terra", fallback_model: "gpt-5.6-sol" } } });
  useScript(script());
  plan("capacity");
  const s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.match(s.reason!, /^harness\/transient: .*'gpt-5\.6-terra' \(3 attempts\), then 'gpt-5\.6-sol'\. Last error: .*at capacity/);
  assert.deepEqual(models(), ["gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-sol"]);

  // The worker (implement routes fail to remediate) blocks instead of spending its rounds.
  const w = project({ roles: { worker: { runs: "codex", model: "gpt-5.6-sol" } } });
  fs.rmSync(path.join(work, "count"));
  const s2 = await run(w);
  assert.equal(s2.status, "blocked", s2.reason);
  assert.equal(s2.round, 0);
  assert.deepEqual(s2.history.map((h) => `${h.phase}:${h.outcome}`), ["brief:ok", "implement:block"]);
  assert.match(s2.reason!, /^harness\/transient: worker \(codex\)/);
});

// @req REQ-harness-003
test("REQ-harness-003 AC-3: mw_delegate retries and falls back the same way and surfaces harness/transient", async () => {
  const dir = newProject();
  const p = new Project(dir);
  plan("capacity", "capacity", "capacity", "ok");
  reply({ summary: "fine", findings: [] });
  const r = await delegate(p, delegateRole(p, { role: "reviewer" }), "Review the change.");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.model, "gpt-5.6-sol", "the alternate answered");
  assert.equal(r.transient_retries, 2);
  assert.deepEqual(models(), ["gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-sol"]);

  fs.rmSync(path.join(work, "count"));
  plan("capacity");
  const tool = TOOLS.find((t) => t.name === "mw_delegate")!;
  const out = await callTool(tool, { role: "reviewer", task: "Review the change." }, { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined });
  assert.equal(out.isError, true);
  assert.match(out.content.map((c) => c.text).join("\n"), /harness\/transient: reviewer \(codex\) failed transiently on 'gpt-5\.6-terra' \(3 attempts\), then 'gpt-5\.6-sol'/);
});

// @req REQ-harness-003
test("REQ-harness-003 AC-4: the shipped reviewer names an alternate model on the same harness; roles.<id>.fallback_model overrides it", () => {
  const preset = fs.readFileSync(path.join(HERE, "..", "..", "presets", "standard", "roles", "reviewer.role.md"), "utf8");
  assert.match(preset, /^fallback_model: gpt-5\.6-sol$/m);
  const dir = newProject();
  const reviewer = new Project(dir).roles().get("reviewer")!;
  assert.equal(reviewer.runs, "codex");
  assert.equal(reviewer.model, "gpt-5.6-terra");
  assert.equal(reviewer.fallbackModel, "gpt-5.6-sol");
  assert.equal(new Project(dir).roles().get("reviewer-deep")!.runs, "codex", "gpt-5.6-sol is a model the codex harness runs");

  write(dir, "mergewright.yaml", `${fs.readFileSync(path.join(dir, "mergewright.yaml"), "utf8").trimEnd()}\nroles:\n  reviewer: {fallback_model: gpt-5.6-luna}\n`);
  const p = new Project(dir);
  assert.deepEqual(p.diag.errors, []);
  assert.equal(p.roles().get("reviewer")!.fallbackModel, "gpt-5.6-luna");
});

// ── Quota and session limits: the usage pause ───────────────────────────────────────────────

// @req REQ-harness-001
// @req REQ-usage-003
test("a usage limit with a reset time is not retried; the run pauses for usage until then, spending no round, and later runs start no agent", async () => {
  const dir = project({ roles: { reviewer: { runs: "codex", model: "gpt-5.6-terra", fallback_model: "gpt-5.6-sol" } } });
  useScript(script());
  plan("quota");
  const integrations = fakeIntegrations();
  const s = await run(dir, {}, { integrations });
  assert.equal(s.status, "waiting");
  assert.equal(s.reason, "usage");
  assert.equal(s.round, 0, "no remediation round");
  assert.equal(calls(), 1, "neither retried nor sent to the alternate");
  const last = s.history.at(-1)!;
  assert.equal(last.phase, "review");
  assert.equal(last.outcome, "waiting");
  assert.match(last.detail, /^usage: .*hit your usage limit.*; paused until \d{4}-\d\d-\d\dT/);
  const limit = activeQuota(new Project(dir), "codex");
  assert.equal(fs.readdirSync(path.join(dir, ".mergewright", "local", "usage-limits", "codex")).length, 1, "one record in the harness's own folder");
  assert.ok(limit, "the reset time is kept for the harness on this machine");
  assert.ok(Date.parse(limit.until) > Date.now());
  assert.ok(integrations.of("notify").some((c) => /paused for usage/.test(String(c.args[0]))));

  // Until the reset time, continuing the run starts no codex agent at all; it pauses again at once.
  const again = await run(dir);
  assert.equal(again.status, "waiting");
  assert.equal(again.reason, "usage");
  assert.equal(calls(), 1);
  assert.match(state(dir).history.at(-1)!.detail, /codex reported a usage limit that resets at .*was not started/);
});

// @req REQ-usage-003
test("limits recorded for two harnesses back to back are both kept; a later reset wins within one harness", () => {
  const p = new Project(newProject());
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const later = new Date(Date.now() + 7_200_000).toISOString();
  recordQuota(p, "codex", soon, "You've hit your usage limit");
  recordQuota(p, "claude", later, "You've hit your session limit");
  assert.deepEqual(Object.keys(activeQuotas(p)).sort(), ["claude", "codex"], "neither write lost the other's limit");
  recordQuota(p, "codex", new Date(Date.now() + 60_000).toISOString(), "an earlier reset");
  assert.equal(activeQuota(p, "codex")!.until, soon, "the later reset time already recorded wins");
  recordQuota(p, "codex", later, "a later reset");
  assert.equal(activeQuota(p, "codex")!.until, later);
  assert.equal(activeQuota(p, "claude")!.until, later);
});

/**
 * Run `recordQuota(root, "codex", <until>)` in one node process per reset time, all at once: every
 * process waits for the same start instant, then records. Resolves when all have exited.
 */
async function recordConcurrently(root: string, untils: string[]): Promise<void> {
  const quota = path.join(SRC, "engine", "quota.ts");
  const start = Date.now() + 1_500;
  const code = [
    `import { recordQuota } from ${JSON.stringify(quota)};`,
    `const [root, until, start] = process.argv.slice(1);`,
    `const wait = Number(start) - Date.now();`,
    `if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);`,
    `for (let i = 0; i < 20; i++) recordQuota({ root }, "codex", until, "You've hit your usage limit");`,
  ].join("\n");
  await Promise.all(
    untils.map(
      (until) =>
        new Promise<void>((resolve, reject) => {
          execFile(process.execPath, ["--input-type=module", "-e", code, root, until, String(start)], { timeout: 30_000 }, (err, _out, stderr) =>
            err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(),
          );
        }),
    ),
  );
}

// @req REQ-usage-003
test("limits recorded by concurrent processes for one harness keep the later reset time", async () => {
  // The later reset is neither started first nor last: it sits in the middle of the list.
  const base = Date.now() + 3_600_000;
  const untils = [3, 1, 6, 0, 7, 2, 5, 4].map((k) => new Date(base + k * 60_000).toISOString());
  const latest = new Date(base + 7 * 60_000).toISOString();
  for (let round = 0; round < 3; round++) {
    const root = tmpDir();
    await recordConcurrently(root, untils);
    assert.equal(activeQuota({ root }, "codex")?.until, latest, `round ${round}: the later reset time won`);
    assert.deepEqual(fs.readdirSync(quotaDir({ root })), ["codex"], "one folder per harness, nothing else");
    const left = fs.readdirSync(quotaRecords({ root }, "codex"));
    assert.ok(left.length >= 1 && left.every((f) => /^\d+-\d+-[0-9a-f]+\.json$/.test(f)), `only record files are left behind, no temp file: ${left.join(", ")}`);
    recordQuota({ root }, "codex", untils[0]!, "an earlier reset reported afterwards");
    assert.equal(fs.readdirSync(quotaRecords({ root }, "codex")).length, 1, "the next report compacts to the latest record");
    assert.equal(activeQuota({ root }, "codex")?.until, latest);
    assert.deepEqual(Object.keys(activeQuotas({ root })), ["codex"]);
  }
});

// @req REQ-usage-003
test("a lock or temp file left in the limit folder is never read as a limit, and records are private", () => {
  const root = tmpDir();
  fs.mkdirSync(quotaRecords({ root }, "codex"), { recursive: true });
  fs.writeFileSync(path.join(quotaDir({ root }), "codex.json.lock"), "");
  fs.writeFileSync(path.join(quotaRecords({ root }, "codex"), ".x.json.1.1.ab.tmp"), JSON.stringify({ until: new Date(Date.now() + 3_600_000).toISOString(), detail: "half" }));
  assert.deepEqual(activeQuotas({ root }), {}, "a lock or temp file alone is no limit and no harness name");
  const until = new Date(Date.now() + 3_600_000).toISOString();
  recordQuota({ root }, "codex", until, "You've hit your usage limit");
  assert.equal(activeQuota({ root }, "codex")?.until, until);
  assert.deepEqual(Object.keys(activeQuotas({ root })), ["codex"]);
  for (const f of fs.readdirSync(quotaRecords({ root }, "codex")).filter((n) => n.endsWith(".json"))) {
    assert.equal(fs.statSync(path.join(quotaRecords({ root }, "codex"), f)).mode & 0o077, 0, "the record is private");
  }
});

/**
 * Start a node process that records `until` for "codex" through recordQuota() while a slow disk holds
 * it inside its write: `fs.renameSync` into the limit folder prints `held` and then waits `holdMs`.
 * `statDelay`, when set, makes every `stat` of a `.lock` path wait until the file `statDelay` exists
 * (a contender that saw a stale lock and is descheduled before it acts on what it saw).
 */
function slowRecorder(root: string, until: string, o: { holdMs?: number; statDelay?: string } = {}): { held: Promise<void>; done: Promise<void> } {
  const quota = path.join(SRC, "engine", "quota.ts");
  const code = [
    `import fs from "node:fs";`,
    `const [root, until, holdMs, statDelay] = process.argv.slice(1);`,
    `const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);`,
    `const rename = fs.renameSync;`,
    `fs.renameSync = (from, to) => {`,
    `  if (Number(holdMs) > 0 && String(to).includes("usage-limits")) { process.stdout.write("held\\n"); pause(Number(holdMs)); }`,
    `  return rename(from, to);`,
    `};`,
    `const stat = fs.statSync;`,
    `fs.statSync = (p, ...rest) => {`,
    `  const s = stat(p, ...rest);`,
    `  if (statDelay && String(p).endsWith(".lock")) { const end = Date.now() + 8000; while (!fs.existsSync(statDelay) && Date.now() < end) pause(5); }`,
    `  return s;`,
    `};`,
    `const { recordQuota } = await import(${JSON.stringify(quota)});`,
    `recordQuota({ root }, "codex", until, "You've hit your usage limit");`,
  ].join("\n");
  let heldResolve!: () => void;
  const held = new Promise<void>((r) => (heldResolve = r));
  const done = new Promise<void>((resolve, reject) => {
    const child = execFile(process.execPath, ["--input-type=module", "-e", code, root, until, String(o.holdMs ?? 0), o.statDelay ?? ""], { timeout: 30_000 }, (err, _out, stderr) =>
      err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(),
    );
    // A writer that finds a later reset already recorded writes nothing, so it never holds: done is held too.
    child.on("exit", () => heldResolve());
    child.stdout!.on("data", (d: Buffer) => {
      if (String(d).includes("held")) heldResolve();
    });
  });
  return { held, done };
}

// @req REQ-usage-003
test("a writer held inside its write longer than any lock wait never lets its earlier reset overwrite a later one", async () => {
  const root = tmpDir();
  const base = Date.now() + 3_600_000;
  const earlier = new Date(base).toISOString();
  const later = new Date(base + 60 * 60_000).toISOString();
  // The slow writer read the (empty) state and is stuck in its rename for 4 s, past any 2 s lock wait.
  const slow = slowRecorder(root, earlier, { holdMs: 4_000 });
  await slow.held;
  recordQuota({ root }, "codex", later, "You've hit your usage limit");
  await slow.done;
  assert.equal(activeQuota({ root }, "codex")?.until, later, "the later reset time won over the slow earlier write");
  assert.equal(activeQuotas({ root }).codex?.until, later);
});

// @req REQ-usage-003
test("contenders reclaiming one stale lock never enter the write together; the later reset always wins", async () => {
  const root = tmpDir();
  const go = path.join(root, "go");
  // A lock left by a crashed writer, as the old lock-file design would have left it.
  const lock = path.join(quotaDir({ root }), "codex.json.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const base = Date.now() + 3_600_000;
  const at = (k: number) => new Date(base + k * 60_000).toISOString();
  // Three contenders see the stale lock and stall before acting on it.
  const contenders = [5, 9, 7].map((k) => slowRecorder(root, at(k), { statDelay: go }));
  await new Promise((r) => setTimeout(r, 1_000));
  // Meanwhile a writer with an earlier reset takes the lock and is held inside its write for 4 s.
  const holder = slowRecorder(root, at(1), { holdMs: 4_000 });
  await holder.held;
  fs.writeFileSync(go, "");
  await Promise.all([holder.done, ...contenders.map((c) => c.done)]);
  assert.equal(activeQuota({ root }, "codex")?.until, at(9), "the later reset time won");
  assert.equal(activeQuotas({ root }).codex?.until, at(9));
});
