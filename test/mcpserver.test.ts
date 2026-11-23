// The MergeWright MCP server (`mw mcp serve`) over stdio: protocol, every tool group, authority.
import { Ajv } from "ajv";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { PassThrough } from "node:stream";
import { roleEnvFor } from "../src/engine/run.ts";
import { allTools, serve, TOOLS } from "../src/mcpserver/server.ts";
import { delegateRole } from "../src/mcpserver/tools/delegate.ts";
import { Project } from "../src/project.ts";
import { finding, findings, project, script, state, useScript } from "./engine-helpers.ts";
import { git, kanbanConfig, MW, notebookConfig, patchConfig, read, tmpDir, write } from "./helpers.ts";

// Delegation refuses the mock harness unless this is set (it is for tests only); the server inherits it.
process.env.MW_DELEGATE_ALLOW_MOCK = "1";

interface Reply { id?: number | string | null; result?: Record<string, unknown>; error?: { code: number; message: string } }

const clients: Client[] = [];
// A failed assertion leaves its server running; stop them all so the test file can end.
after(() => { for (const c of clients) if (c.proc.exitCode === null) c.proc.kill(); });

class Client {
  proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiting = new Map<number | string | null, (r: Reply) => void>();
  private next = 1;
  stderr = "";
  constructor(dir: string, env: Record<string, string> = {}) {
    this.proc = spawn(process.execPath, [MW, "mcp", "serve", "--project", dir], { env: { ...process.env, MW_ENV_FILE: "/dev/null", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    clients.push(this);
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        const msg = JSON.parse(line) as Reply; // stdout must hold protocol messages only
        const w = this.waiting.get(msg.id ?? null);
        if (w) { this.waiting.delete(msg.id ?? null); w(msg); }
      }
    });
    this.proc.stderr.on("data", (d) => { this.stderr += String(d); });
  }
  raw(line: string, id: number | string | null): Promise<Reply> {
    const p = new Promise<Reply>((resolve) => this.waiting.set(id, resolve));
    this.proc.stdin.write(`${line}\n`);
    return p;
  }
  request(method: string, params: object = {}): Promise<Reply> {
    const id = this.next++;
    return this.raw(JSON.stringify({ jsonrpc: "2.0", id, method, params }), id);
  }
  async call(name: string, args: object = {}): Promise<{ text: string; isError: boolean }> {
    const r = await this.request("tools/call", { name, arguments: args });
    assert.ok(r.result, `tools/call ${name} answered with a protocol error: ${JSON.stringify(r.error)}`);
    const content = r.result.content as { type: string; text: string }[];
    return { text: content.map((c) => c.text).join("\n"), isError: r.result.isError === true };
  }
  async json(name: string, args: object = {}): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await this.call(name, args);
    assert.equal(r.isError, false, `${name} failed: ${r.text}`);
    return JSON.parse(r.text);
  }
  async close(): Promise<number | null> {
    this.proc.stdin.end();
    return new Promise((resolve) => this.proc.on("close", (code) => resolve(code)));
  }
}

async function started(dir: string, env: Record<string, string> = {}): Promise<Client> {
  const c = new Client(dir, env);
  const r = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(r.result?.protocolVersion, "2025-06-18");
  c.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return c;
}

/** A fake `kanban` on PATH: records its arguments, answers JSON (or fails like a runtime that is down). */
function fakeKanban(): { bin: string; log: string } {
  const bin = tmpDir("mw-bin-");
  const log = path.join(bin, "calls.log");
  write(bin, "kanban", `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ -n "$FAKE_KANBAN_DOWN" ]; then echo '{"ok": false, "error": "Task command failed at http://127.0.0.1:3484: fetch failed"}'; exit 1; fi
case "$2" in
  list) echo '{"ok": true, "tasks": [{"id": "t1", "prompt": "first", "column": "backlog"}], "count": 1}' ;;
  *) echo '{"ok": true, "task": {"id": "t2"}}' ;;
esac
`);
  fs.chmodSync(path.join(bin, "kanban"), 0o755);
  return { bin, log };
}

const NAMES = [
  "mw_delegate", "mw_review",
  "mw_cards_list", "mw_card_get", "mw_card_new", "mw_card_lint", "mw_card_set_status", "mw_status",
  "mw_run_start", "mw_run_status", "mw_approve", "mw_retry", "mw_abort",
  "mw_docs_write", "mw_docs_search",
  "mw_memory_add", "mw_memory_push", "mw_memory_search", "mw_memory_state",
  "mw_check", "mw_trace", "mw_doctor", "mw_spec_list", "mw_spec_get", "mw_req_get", "mw_spec_propose", "mw_roles", "mw_mcp_add",
  "mw_run_file", "mw_packages", "mw_settings",
];

test("initialize, tools/list: every tool of the design with a valid input schema", async () => {
  const dir = project();
  const c = await started(dir);
  const r = await c.request("tools/list");
  const tools = r.result!.tools as { name: string; description: string; inputSchema: { type: string } }[];
  assert.deepEqual(tools.map((t) => t.name).sort(), [...NAMES].sort());
  const ajv = new Ajv({ strict: false });
  for (const t of tools) {
    assert.ok(t.description.length > 20, `${t.name} has a description`);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.doesNotThrow(() => ajv.compile(t.inputSchema), t.name);
  }
  assert.deepEqual((await c.request("ping")).result, {});
  assert.equal(await c.close(), 0);
  assert.equal(TOOLS.length, NAMES.length);
});

test("protocol errors: bad JSON, unknown method, unknown tool and bad arguments; the server stays up", async () => {
  const c = await started(project());
  assert.equal((await c.raw("{this is not json", null)).error?.code, -32700);
  assert.equal((await c.raw("[1,2]", null)).error?.code, -32600);
  assert.equal((await c.request("no/such/method")).error?.code, -32601);
  assert.equal((await c.request("tools/call", { name: "mw_nothing", arguments: {} })).error?.code, -32602);
  const bad = await c.call("mw_card_new", { title: 3 });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /invalid arguments for mw_card_new: 'title' must be string/);
  const missing = await c.call("mw_card_get", { id: "DEMO-99" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /there is no card DEMO-99/);
  assert.deepEqual((await c.request("ping")).result, {}, "still answering");
  await c.close();
});

test("cards: new, list, get, set status, status", async () => {
  const dir = project();
  const c = await started(dir);
  assert.match((await c.call("mw_card_new", { title: "Add a greeting", kind: "chore", scope: ["src/**"], why: "Users like it.", out_of_scope: "None", acceptance: ["It greets."] })).text, /created cards\/DEMO-2\.card\.md/);
  const cards = await c.json("mw_cards_list");
  assert.deepEqual(cards.map((x: { id: string }) => x.id), ["DEMO-1", "DEMO-2"]);
  assert.equal(cards[1].title, "Add a greeting");
  const one = await c.json("mw_card_get", { id: "DEMO-2" });
  assert.match(one.text, /Users like it\./);
  assert.match((await c.call("mw_card_set_status", { id: "DEMO-2", status: "ready" })).text, /todo -> ready/);
  assert.equal(git(dir, "log", "-2", "--format=%s"), "card: DEMO-2 ready\ncard: DEMO-2 Add a greeting", "both changes are committed");
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.match(read(dir, "cards/DEMO-2.card.md"), /status: ready/);
  assert.deepEqual((await c.json("mw_cards_list", { status: "ready" })).map((x: { id: string }) => x.id), ["DEMO-2"]);
  const rows = await c.json("mw_status");
  assert.equal(rows.find((r: { id: string }) => r.id === "DEMO-2").status, "ready");
  await c.close();
});

test("delegate: a project role and an ad-hoc role run on the mock harness; write mode is refused", async () => {
  const dir = project();
  const file = useScript(script({ reviewer: [{ output: findings([finding("R-01", true)]) }], delegate: [{ output: "Use a queue." }] }));
  write(dir, "src/app.txt", "changed\n");
  git(dir, "add", "src/app.txt");
  const c = await started(dir, { MW_MOCK_SCRIPT: file });
  const adhoc = await c.json("mw_delegate", { task: "How should retries work?", runs: "mock", label: "retries" });
  assert.equal(adhoc.output, "Use a queue.");
  assert.equal(adhoc.mode, "advise");
  assert.ok(adhoc.usage.inputTokens > 0);
  const runDir = path.join(dir, adhoc.run_dir);
  assert.match(adhoc.run_dir, /^\.mergewright\/local\/delegate\/\d{8}T\d{6}-retries-[A-Za-z0-9]{6}$/);
  const prompt = fs.readFileSync(path.join(runDir, "phases", "delegate.prompt.md"), "utf8");
  assert.match(prompt, /## Task\n\nHow should retries work\?/);
  assert.match(prompt, /empty folder outside the project, with your harness's no-tools setting/);
  assert.equal(adhoc.model, "(harness default)");

  const role = await c.json("mw_delegate", { task: "Check the app file", role: "reviewer" });
  assert.equal(role.output_kind, "findings");
  assert.equal(role.output.findings[0].id, "R-01");

  const review = await c.json("mw_review", {});
  assert.equal(review.role, "reviewer");
  assert.equal(review.output.findings[0].blocking, true);
  const reviewPrompt = fs.readFileSync(path.join(dir, review.run_dir, "phases", "delegate.prompt.md"), "utf8");
  assert.match(reviewPrompt, /\+changed/, "the diff is in the prompt");

  const write_ = await c.call("mw_delegate", { task: "Implement it", role: "worker" });
  assert.equal(write_.isError, true);
  assert.match(write_.text, /mode 'write': delegated agents only advise or read\. Work that changes files is a card/);
  assert.equal((await c.call("mw_review", { range: "HEAD", diff: "" })).isError, true, "an empty diff is refused");
  await c.close();
});

test("docs: mw_docs_write commits with a docs: subject and queues the sync when the notebook is down; bad paths are refused", async () => {
  const dir = project();
  patchConfig(dir, { docs: { paths: ["docs/**", "README.md"] }, ...notebookConfig({ url: "http://127.0.0.1:9", name: "demo" }) });
  git(dir, "commit", "-qam", "notebook");
  const c = await started(dir);
  const r = await c.call("mw_docs_write", { path: "docs/guides/retry.md", content: "# Retry\n\nHow retries work.\n", title: "Retry guide" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /committed docs\/guides\/retry\.md as [0-9a-f]{10} \('docs: Retry guide'\)/);
  assert.match(r.text, /the sync is queued/);
  assert.equal(git(dir, "log", "-1", "--format=%s"), "docs: Retry guide");
  assert.equal(git(dir, "status", "--porcelain"), "", "only the document was committed, and the tree is clean");
  const queued = fs.readdirSync(path.join(dir, ".mergewright", "local", "queue")).filter((f) => f.endsWith(".json"));
  assert.equal(queued.length, 1);
  assert.match((await c.call("mw_docs_write", { path: "docs/guides/retry.md", content: "# Retry\n\nHow retries work.\n" })).text, /unchanged/);
  for (const [p, why] of [["src/x.md", /not under docs\.paths/], ["../x.md", /not a plain path/], ["docs/adr/0001-x.md", /protected/]] as const) {
    const bad = await c.call("mw_docs_write", { path: p, content: "x" });
    assert.equal(bad.isError, true, p);
    assert.match(bad.text, why);
  }
  // The repository's own files are searched; a notebook that does not answer is one labelled line.
  const search = await c.json("mw_docs_search", { query: "retry" });
  assert.equal(search.project[0].file, "docs/guides/retry.md");
  assert.match(search["open-notebook"], /^open-notebook did not answer: /);
  await c.close();
});

test("memory: a lesson lands in memory/lessons, state is replaced, search finds it; without the mem0 package there is no mem0 tool", async () => {
  const dir = project();
  const c = await started(dir);
  assert.match((await c.call("mw_memory_add", { kind: "lesson", topic: "testing", title: "Fake the board", body: "Tests use a fake kanban on PATH." })).text, /lesson added in memory\/lessons/);
  assert.match(read(dir, "memory/lessons/testing.md"), /## Fake the board\n\nTests use a fake kanban on PATH\./);
  assert.match((await c.call("mw_memory_add", { kind: "decision", title: "Use mem0", body: "Because it is self-hosted." })).text, /created memory\/decisions\/.*use-mem0\.md/);
  await c.call("mw_memory_state", { text: "# State\n\nAll good.\n" });
  assert.equal(read(dir, "memory/STATE.md"), "# State\n\nAll good.\n");
  const found = await c.json("mw_memory_search", { query: "fake kanban board" });
  assert.equal(found.project[0].title, "Fake the board");
  assert.equal(found.mem0, undefined);
  assert.equal(found.letta, undefined, "no letta package: no letta hits");
  const m = await c.request("tools/call", { name: "mw_mem0_add", arguments: { text: "x" } });
  assert.match(JSON.stringify(m.error ?? m.result), /mw_mem0_add/, "an unknown tool without the mem0 package");
  await c.close();
});

test("kanban: the cline-kanban package's tools pass their arguments to the kanban CLI with the project path; a runtime that is down is a clean error", async () => {
  const dir = project();
  patchConfig(dir, kanbanConfig());
  git(dir, "commit", "-qam", "kanban");
  const k = fakeKanban();
  const env = { PATH: `${k.bin}${path.delimiter}${process.env.PATH}` };
  let c = await started(dir, env);
  const list = await c.json("mw_kanban_list", { column: "backlog" });
  assert.equal(list.tasks[0].id, "t1");
  assert.equal((await c.json("mw_kanban_get", { task_id: "t1" })).prompt, "first");
  await c.json("mw_kanban_create", { title: "Renew the certificate", agent_id: "codex" });
  await c.json("mw_kanban_link", { task_id: "t2", linked_task_id: "t1" });
  await c.json("mw_kanban_done", { task_id: "t1" });
  const calls = fs.readFileSync(k.log, "utf8").trim().split("\n");
  assert.equal(calls[0], `task list --column backlog --project-path ${dir}`);
  assert.ok(calls.includes(`task create --title Renew the certificate --prompt Renew the certificate --agent-id codex --project-path ${dir}`), calls.join("\n"));
  assert.ok(calls.includes(`task link --task-id t2 --linked-task-id t1 --project-path ${dir}`));
  assert.ok(calls.includes(`task trash --task-id t1 --project-path ${dir}`));
  await c.close();
  c = await started(dir, { ...env, FAKE_KANBAN_DOWN: "1" });
  const down = await c.call("mw_kanban_list");
  assert.equal(down.isError, true);
  assert.match(down.text, /kanban task list: Task command failed at .*fetch failed \(no Kanban runtime is reachable/);
  await c.close();
});

test("MW_ROLE set: every write tool, a package's too, refuses with the owner-only message; reading still works", async () => {
  const dir = project();
  patchConfig(dir, kanbanConfig());
  git(dir, "commit", "-qam", "kanban");
  const k = fakeKanban();
  const c = await started(dir, { MW_ROLE: "worker", PATH: `${k.bin}${path.delimiter}${process.env.PATH}` });
  const writes = (await allTools(new Project(dir))).filter((t) => t.write).map((t) => t.name);
  assert.ok(writes.includes("mw_card_new") && writes.includes("mw_docs_write") && writes.includes("mw_memory_add") && writes.includes("mw_kanban_create") && writes.includes("mw_run_start"));
  const argsFor: Record<string, object> = {
    mw_card_new: { title: "x" }, mw_card_set_status: { id: "DEMO-1", status: "ready" }, mw_run_start: { id: "DEMO-1" }, mw_approve: { id: "DEMO-1", word: "go" },
    mw_retry: { id: "DEMO-1" }, mw_abort: { id: "DEMO-1" }, mw_docs_write: { path: "docs/x.md", content: "x" },
    mw_memory_add: { kind: "lesson", topic: "t", title: "t", body: "b" }, mw_memory_state: { text: "# S\n" },
    mw_kanban_create: { title: "x" }, mw_kanban_update: { task_id: "t1" }, mw_kanban_done: { task_id: "t1" }, mw_kanban_delete: { task_id: "t1" },
    mw_kanban_link: { task_id: "a", linked_task_id: "b" }, mw_kanban_start: { task_id: "t1" }, mw_spec_propose: { spec: "x", summary: "y" }, mw_mcp_add: { id: "x", url: "http://x" },
  };
  for (const name of writes) {
    const r = await c.call(name, argsFor[name] ?? {});
    assert.equal(r.isError, true, name);
    assert.match(r.text, /is done by the owner, not from inside a card run \(role 'worker'\)/, name);
  }
  assert.equal(fs.existsSync(k.log), false, "the kanban CLI was never called");
  assert.equal((await c.call("mw_cards_list")).isError, false);
  assert.equal((await c.call("mw_roles")).isError, false);
  await c.close();
});

test("runs: mw_run_start returns at once and the run finishes in the background; mw_run_status follows it", async () => {
  const dir = project();
  const file = useScript(script());
  const c = await started(dir, { MW_MOCK_SCRIPT: file });
  const r = await c.json("mw_run_start", { id: "DEMO-1", approve: ["go", "merge"] });
  assert.ok(r.pid > 0);
  assert.equal(r.log, ".mergewright/local/runs/DEMO-1.log");
  const deadline = Date.now() + 90_000;
  let s: { status: string; log: string } = { status: "", log: "" };
  while (Date.now() < deadline) {
    s = await c.json("mw_run_status", { id: "DEMO-1" });
    if (s.status === "done" || s.status === "blocked") break;
    await new Promise((res) => setTimeout(res, 300));
  }
  assert.equal(s.status, "done", JSON.stringify(s));
  assert.equal(state(dir).status, "done");
  assert.match(s.log, /mw run DEMO-1 --approve go,merge/);
  const notWaiting = await c.call("mw_approve", { id: "DEMO-1", word: "go" });
  assert.equal(notWaiting.isError, true);
  assert.match(notWaiting.text, /not waiting for an approval \(done\)/);
  await c.close();
});

test("project tools: check, trace, roles, spec list, mcp add", async () => {
  const dir = project();
  const c = await started(dir);
  const checked = await c.json("mw_check");
  assert.equal(checked.ok, false, "the fixture's feature card names no requirement");
  assert.equal(checked.diagnostics[0].code, "card/no-requirement");
  assert.deepEqual((await c.json("mw_trace")).dangling, []);
  const roles = await c.json("mw_roles");
  assert.ok(roles.some((r: { id: string; mode: string }) => r.id === "reviewer-deep" && r.mode === "read"));
  assert.deepEqual((await c.json("mw_spec_list")).changes, []);
  const added = await c.call("mw_mcp_add", { id: "docs-search", command: "npx", args: ["-y", "some-server"], env: { TOKEN: "${SOME_TOKEN}" } });
  assert.equal(added.isError, false, added.text);
  assert.match(read(dir, "mcps/docs-search.mcp.yaml"), /command: npx[\s\S]*args: \[ -y, some-server \]|command: npx[\s\S]*- -y/);
  const doctor = (await c.call("mw_doctor")).text;
  assert.doesNotMatch(doctor, /^mem0|^letta/m, "mem0 and letta are packages: no line unless they are enabled");
  await c.close();
});

test("in process: serve() over injected streams; a delegated agent gets MW_ROLE, so it cannot run owner commands", async () => {
  const dir = project();
  const input = new PassThrough();
  const output = new PassThrough();
  const logs: string[] = [];
  const done = serve(new Project(dir), { input, output, log: (l) => logs.push(l) });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "i", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "mw_roles", arguments: {} } })}\n`);
  input.end();
  await done;
  const lines = String(output.read()).trim().split("\n").map((l) => JSON.parse(l) as Reply);
  assert.equal(lines.length, 2, "the notification got no reply");
  assert.deepEqual(lines.map((l) => l.id), ["i", "a"]);
  assert.ok(lines[1]!.result, "the tool call ran after initialize");
  assert.match(logs[0]!, /31 tools for project 'demo'/);

  const p = new Project(dir);
  const role = delegateRole(p, { role: "reviewer-deep", model: "gpt-5.6-sol" });
  const env = roleEnvFor(p, role, undefined, "/tmp/x");
  assert.equal(env.MW_ROLE, "reviewer-deep");
  assert.equal(env.MW_MODE, "read");
  assert.equal(env.MW_CARD, undefined);
  const adhoc = delegateRole(p, { runs: "codex", model: "gpt-5.6-sol" });
  assert.deepEqual([adhoc.id, adhoc.mode, adhoc.output, adhoc.model], ["delegate", "advise", "text", "gpt-5.6-sol"]);
  assert.throws(() => delegateRole(p, { role: "worker" }), /delegated agents only advise or read/);
  assert.equal(delegateRole(p, { role: "worker", mode: "read" }).mode, "read");
});
