// MCP tools that write commit what they wrote; the Kanban board keeps the history of
// cards that finished elsewhere; cards.kanban_path in `mw config` and the TUI; the MCP server's
// defences (paths, run arguments, Kanban arguments, redaction, lifecycle, internal errors).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { PassThrough } from "node:stream";
import { allTools, callTool, serve, TOOLS } from "../src/mcpserver/server.ts";
import type { ToolContext, ToolDef } from "../src/mcpserver/tool.ts";
import { Project } from "../src/project.ts";
import { validateWith } from "../src/schemas.ts";
import { project } from "./engine-helpers.ts";
import { card, git, kanbanConfig, mem0Config, mw, newProject, patchConfig, read, tmpDir, write } from "./helpers.ts";
import { installFake, projectWith } from "./fixtures/integrations/support.ts";

function ctxFor(dir: string, log: (l: string) => void = () => undefined): ToolContext {
  return { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log };
}

async function call(dir: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const tool = (await allTools(new Project(dir))).find((t) => t.name === name);
  assert.ok(tool, name);
  const cwd = process.cwd();
  try {
    const r = await callTool(tool, args, ctxFor(dir));
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  } finally {
    process.chdir(cwd);
  }
}

const subject = (dir: string) => git(dir, "log", "-1", "--format=%s");
const filesOf = (dir: string, rev = "HEAD") => git(dir, "show", "--name-only", "--format=", rev).split("\n").filter(Boolean).sort();

test("card and memory tools commit exactly the files they wrote, alone, on the base branch", async () => {
  const dir = project();
  // The owner has an unrelated change staged: it must stay staged and out of every commit.
  write(dir, "src/owner.txt", "owner's work\n");
  git(dir, "add", "src/owner.txt");

  const made = await call(dir, "mw_card_new", { title: "Add a greeting", kind: "chore", scope: ["src/**"], why: "Users like it.", out_of_scope: "None", acceptance: ["It greets."] });
  assert.equal(made.isError, false, made.text);
  assert.equal(subject(dir), "card: DEMO-2 Add a greeting");
  assert.deepEqual(filesOf(dir), ["cards/DEMO-2.card.md"]);
  assert.match(made.text, /committed cards\/DEMO-2\.card\.md as [0-9a-f]{10} \('card: DEMO-2 Add a greeting'\)/);
  assert.equal(git(dir, "status", "--porcelain"), "A  src/owner.txt", "the card is committed; the owner's staged file is untouched");

  const ready = await call(dir, "mw_card_set_status", { id: "DEMO-2", status: "ready" });
  assert.equal(ready.isError, false, ready.text);
  assert.equal(subject(dir), "card: DEMO-2 ready");
  assert.equal(git(dir, "log", "-2", "--format=%s"), "card: DEMO-2 ready\ncard: DEMO-2 Add a greeting");
  assert.match(read(dir, "cards/DEMO-2.card.md"), /status: ready/);

  const lesson = await call(dir, "mw_memory_add", { kind: "lesson", topic: "testing", title: "Fake the board", body: "Tests use a fake kanban." });
  assert.equal(lesson.isError, false, lesson.text);
  assert.equal(subject(dir), "memory: Fake the board");
  assert.deepEqual(filesOf(dir), ["memory/INDEX.md", "memory/lessons/testing.md"]);
  const state = await call(dir, "mw_memory_state", { text: "# State\n\nGreeting card ready.\n" });
  assert.equal(state.isError, false, state.text);
  assert.equal(subject(dir), "memory: state");
  assert.deepEqual(filesOf(dir), ["memory/STATE.md"]);
  assert.equal(git(dir, "status", "--porcelain"), "A  src/owner.txt");

  // Off the base branch: refused before anything is written.
  git(dir, "checkout", "-q", "-b", "elsewhere");
  const off = await call(dir, "mw_card_new", { title: "Not here" });
  assert.equal(off.isError, true);
  assert.match(off.text, /not the base branch 'main'.*nothing was written/);
  assert.equal(fs.existsSync(path.join(dir, "cards/DEMO-3.card.md")), false);
  assert.match((await call(dir, "mw_memory_state", { text: "# S\n" })).text, /not the base branch/);
});

test("a done card absent from the board is created and closed, so the board keeps its history", async () => {
  const fake = installFake("kanban", "fake-kanban.mjs");
  after(fake.restore);
  const stateFile = path.join(tmpDir(), "kanban.json");
  process.env.FAKE_KANBAN_STATE = stateFile;
  process.env.FAKE_KANBAN_DOWN = "0";
  const { dir } = projectWith(kanbanConfig());
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1").replace("status: todo", "status: done"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "a card that ran on the laptop");
  const env = { PATH: process.env.PATH!, FAKE_KANBAN_STATE: stateFile, FAKE_KANBAN_DOWN: "0" };
  const first = mw(dir, ["cline-kanban", "mirror"], env);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /ok\s+DEMO-1\s+done\s+DEMO-1 created and closed \(moved to done\)/);
  const board = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { tasks: { prompt: string; column: string }[]; calls: string[][] };
  assert.deepEqual(board.tasks.map((t) => [t.prompt.split("\n")[0], t.column]), [["[DEMO-1] Card DEMO-1", "trash"]]);
  // Idempotent, and `mw cline-kanban mirror` says what it did.
  const again = mw(dir, ["cline-kanban", "mirror"], env);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /ok\s+DEMO-1\s+done\s+DEMO-1 is already done/);
  const after2 = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { tasks: unknown[]; calls: string[][] };
  assert.equal(after2.tasks.length, 1);
  assert.equal(after2.calls.filter((c) => c[1] === "create").length, 1);
});

test("the board path is packages.cline-kanban.path, an absolute path; the old cards.kanban_path and cards.mirror: kanban are refused, saying to run 'mw add cline-kanban'", () => {
  const dir = newProject();
  let r = mw(dir, ["config", "set", "cards.kanban_path", "/home/alice/workspace/demo"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /'cards\.kanban_path' is no longer read: the Kanban mirror is now the cline-kanban package\. Run 'mw add cline-kanban'/);
  patchConfig(dir, { cards: { mirror: "kanban" } });
  r = mw(dir, ["check"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out + r.err, /'cards\.mirror' is 'kanban', which is no longer read: the Kanban mirror is now the cline-kanban package/);

  const fresh = newProject();
  patchConfig(fresh, kanbanConfig());
  r = mw(fresh, ["config", "set", "packages.cline-kanban.path", "/home/alice/workspace/demo"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(mw(fresh, ["config", "get", "packages.cline-kanban.path"]).out.trim(), "/home/alice/workspace/demo");
  r = mw(fresh, ["config", "set", "packages.cline-kanban.path", "workspace/demo"]);
  assert.notEqual(r.code, 0, "a relative path is refused");
});

test("card and memory paths are resolved to real paths and refused outside the project", async () => {
  const dir = project();
  const outside = tmpDir("mw-outside-");
  fs.writeFileSync(path.join(outside, "DEMO-7.card.md"), "---\nid: DEMO-7\ntitle: Outside\nkind: chore\nstatus: todo\n---\n\nprivate text outside the project\n");
  fs.symlinkSync(path.join(outside, "DEMO-7.card.md"), path.join(dir, "cards", "DEMO-7.card.md"));
  const got = await call(dir, "mw_card_get", { id: "DEMO-7" });
  assert.equal(got.isError, true, got.text);
  assert.match(got.text, /leads outside the project/);
  assert.doesNotMatch(got.text, /private text/);
  assert.equal((await call(dir, "mw_card_set_status", { id: "DEMO-7", status: "ready" })).isError, true);
  assert.match(fs.readFileSync(path.join(outside, "DEMO-7.card.md"), "utf8"), /status: todo/, "the file outside was not written");

  // memory/lessons is a link to a folder outside the project: the lesson is not written there.
  fs.mkdirSync(path.join(outside, "lessons"));
  fs.rmSync(path.join(dir, "memory", "lessons"), { recursive: true, force: true });
  fs.symlinkSync(path.join(outside, "lessons"), path.join(dir, "memory", "lessons"));
  const lesson = await call(dir, "mw_memory_add", { kind: "lesson", topic: "escape", title: "x", body: "y" });
  assert.equal(lesson.isError, true, lesson.text);
  assert.match(lesson.text, /leads outside the project/);
  assert.deepEqual(fs.readdirSync(path.join(outside, "lessons")), []);
  assert.equal((await call(dir, "mw_memory_add", { kind: "lesson", topic: "t", title: "x", body: "y", card: "DEMO-1\n## injected" })).isError, true, "card is an id");
});

test("run, card and project tools take ids and phase names only, never text that could read as an option", () => {
  const schemaOf = (name: string) => TOOLS.find((t) => t.name === name)!.inputSchema;
  const refused: [string, Record<string, unknown>][] = [
    ["mw_run_start", { id: "DEMO-1", until: "--dry-run" }],
    ["mw_run_start", { id: "DEMO-1", from: "--approve=merge" }],
    ["mw_run_start", { id: "DEMO-1", approve: ["go", "--force"] }],
    ["mw_run_start", { id: "--help" }],
    ["mw_run_status", { id: "DEMO-1", log_lines: 10_000_000 }],
    ["mw_approve", { id: "DEMO-1", word: "-x" }],
    ["mw_retry", { id: "DEMO-1", from: "--force" }],
    ["mw_abort", { id: "../DEMO-1" }],
    ["mw_card_get", { id: "../../etc/passwd" }],
    ["mw_card_new", { title: "x", flow: "--x" }],
    ["mw_card_new", { title: "x", depends: ["; rm -rf /"] }],
    ["mw_mcp_add", { id: "--force", url: "http://x" }],
    ["mw_spec_propose", { spec: "../x", summary: "y" }],
  ];
  for (const [name, args] of refused) assert.ok(validateWith(schemaOf(name), args).length > 0, `${name} ${JSON.stringify(args)} is refused`);
  assert.deepEqual(validateWith(schemaOf("mw_run_start"), { id: "DEMO-1", approve: ["go", "merge"], from: "implement", until: "review" }), []);
});

test("Kanban tools ask about cards.kanban_path, and each argument reaches the CLI as one argument", async () => {
  const bin = tmpDir("mw-bin-");
  const log = path.join(bin, "calls.json");
  // Records each call's argument list exactly (no shell joins or splits it).
  write(bin, "kanban", `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(JSON.stringify({ ok: true, tasks: [], task: { id: "t9" } }) + "\\n");
`);
  fs.chmodSync(path.join(bin, "kanban"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  try {
    const { dir } = projectWith({ ...kanbanConfig({ path: "/srv/board/demo" }) });
    const title = "--project-path=/etc; echo $(id) `id` | x";
    const r = await call(dir, "mw_kanban_create", { title });
    assert.equal(r.isError, false, r.text);
    const argv = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    assert.deepEqual(argv[0], ["task", "create", "--title", title, "--prompt", title, "--project-path", "/srv/board/demo"]);
    assert.equal((await call(dir, "mw_kanban_create", { title: "x", project_path: "/etc" })).isError, true, "unknown arguments are refused");
  } finally {
    process.env.PATH = before;
  }
});

test("tool replies are scrubbed: credential values and credential-shaped text never leave the server", async () => {
  const dir = project();
  const token = `ghp_${"a1B2".repeat(9)}`;
  write(dir, "cards/DEMO-1.card.md", `${read(dir, "cards/DEMO-1.card.md")}\nleaked ${token}\n`);
  // The mem0 package declares MEM0_API_KEY as its secret: enabled, its value is blanked too.
  patchConfig(dir, mem0Config({ url: "http://127.0.0.1:9" }));
  process.env.MEM0_API_KEY = "mem0-key-value-123456";
  try {
    const got = await call(dir, "mw_card_get", { id: "DEMO-1" });
    assert.ok(!got.text.includes(token));
    assert.match(got.text, /leaked \[redacted\]/);
    const tool: ToolDef = { name: "mw_test_echo", description: "test", inputSchema: { type: "object" }, handler: () => "key is mem0-key-value-123456" };
    const r = await callTool(tool, {}, ctxFor(dir));
    assert.equal(r.content[0]!.text, "key is [redacted]");
  } finally {
    delete process.env.MEM0_API_KEY;
  }
});

/** Serve `dir` over in-memory streams; send the lines, then collect every reply. */
async function session(dir: string, lines: object[]): Promise<{ replies: { id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } }[]; logs: string[] }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const logs: string[] = [];
  const done = serve(new Project(dir), { input, output, log: (l) => logs.push(l) });
  for (const l of lines) input.write(`${JSON.stringify(l)}\n`);
  input.end();
  await done;
  const text = String(output.read() ?? "").trim();
  return { replies: text ? text.split("\n").map((l) => JSON.parse(l)) : [], logs };
}

test("initialize comes first and once: requests before it are refused without running; a second initialize is refused", async () => {
  const dir = project();
  const init = (id: number) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const { replies } = await session(dir, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mw_card_new", arguments: { title: "Too early" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "ping" },
    init(4),
    init(5),
  ]);
  const byId = new Map(replies.map((r) => [r.id, r]));
  assert.match(byId.get(1)!.error?.message ?? "", /not initialized/);
  assert.match(byId.get(2)!.error?.message ?? "", /not initialized/);
  assert.deepEqual(byId.get(3)!.result, {}, "ping is answered before initialize");
  assert.equal(byId.get(4)!.result?.protocolVersion, "2025-06-18");
  assert.match(byId.get(5)!.error?.message ?? "", /already initialized/);
  assert.equal(fs.existsSync(path.join(dir, "cards", "DEMO-2.card.md")), false, "the early call did not run");
});

test("a tool that throws an unexpected error answers with a generic isError result; the stack goes to the log", async () => {
  const dir = project();
  const logs: string[] = [];
  const tool: ToolDef = { name: "mw_test_boom", description: "test", inputSchema: { type: "object" }, handler: () => { throw new TypeError("internal detail at /home/alice/secret-place"); } };
  const r = await callTool(tool, {}, ctxFor(dir, (l) => logs.push(l)));
  assert.equal(r.isError, true);
  assert.equal(r.content[0]!.text, "mw_test_boom failed with an internal error; the MergeWright server's log (standard error) has the details");
  assert.match(logs.join("\n"), /TypeError: internal detail at \/home\/alice\/secret-place\n\s+at /);
});

test("the hermes package's README says what the assistant can and cannot do", () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, "..", "packages", "hermes", "README.md"), "utf8");
  const section = text.slice(text.indexOf("## What the assistant can and cannot do"));
  assert.ok(text.includes("## What the assistant can and cannot do"));
  for (const word of ["mw_card_new", "mw_memory_add", "mw_docs_write", "mw_run_start", "merge", "push", "lease"]) assert.ok(section.includes(word), word);
});
