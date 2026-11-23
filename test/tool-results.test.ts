// Structured tool results (lane D): `data` beside the unchanged text, the board's operations, the
// tool layer called concurrently from one process, and structuredContent over MCP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { handlers } from "../src/cli.ts";
import { cardStatuses } from "../src/engine/run.ts";
import { runDir } from "../src/engine/state.ts";
import { callToolStructured, listTools, TOOLS } from "../src/mcpserver/server.ts";
import { RESULTS_VERSION, type CardChangeData, type CardData, type NotReadyData, type PackagesData, type RetryData, type RunData, type RunFileData, type SettingsData, type StatusData } from "../src/mcpserver/results.ts";
import { viaCli, type ToolContext } from "../src/mcpserver/tool.ts";
import { Project } from "../src/project.ts";
import { brief, project, run, script, state, useScript } from "./engine-helpers.ts";
import { git, MW, newProject, write } from "./helpers.ts";

const ctxFor = (dir: string): ToolContext => ({ root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => {} });
const call = (dir: string, name: string, args: Record<string, unknown> = {}) => callToolStructured(name, args, ctxFor(dir));

test("results: mw_status keeps its text and adds board rows: waiting with what the owner is asked for, queued, todo", async () => {
  useScript(script());
  const dir = project({ cardExtra: "risk: high\n" });
  const s = await run(dir);
  assert.equal(s.status, "waiting");
  write(dir, "cards/DEMO-2.card.md", "---\nid: DEMO-2\ntitle: Second\nkind: chore\nstatus: todo\nscope: [src/**]\n---\n\n## Why\n\nx\n");
  // A run that says running with no process behind it is queued (REQ-engine-014).
  const queued = { ...s, card: "DEMO-2", status: "running", reason: undefined };
  fs.mkdirSync(runDir(new Project(dir), "DEMO-2"), { recursive: true });
  fs.writeFileSync(path.join(runDir(new Project(dir), "DEMO-2"), "state.json"), JSON.stringify(queued));
  const r = await call(dir, "mw_status");
  assert.equal(r.isError, false, r.text);
  assert.equal(r.text, JSON.stringify(cardStatuses(new Project(dir)), null, 2), "the text is what it always was");
  const data = r.data as StatusData;
  assert.deepEqual(data.configErrors, []);
  const [one, two] = data.cards;
  assert.equal(one!.status, "waiting");
  assert.equal(one!.ask, s.reason);
  assert.equal(one!.reason, s.reason);
  assert.equal(one!.risk, "high");
  assert.equal(one!.runStatus, "waiting");
  assert.ok(one!.agents.length > 0);
  assert.equal(two!.status, "queued");
  assert.match(two!.label, /^queued \('mw work' or 'mw run DEMO-2' resumes it at/);
  assert.equal(two!.ask, null);
  assert.equal(two!.risk, new Project(dir).config.risk.default);
});

test("results: mw_card_get gives front matter, sections, scope and lint; mw_run_status gives phases and run files; mw_run_file reads one", async () => {
  useScript(script());
  const dir = project({ cardExtra: "risk: high\n" });
  await run(dir);
  const card = await call(dir, "mw_card_get", { id: "DEMO-1" });
  assert.equal(JSON.parse(card.text).id, "DEMO-1", "the text is the old object");
  const c = card.data as CardData;
  assert.equal(c.frontMatter.risk, "high");
  assert.equal(c.sections.why, "Because the demo needs it.");
  assert.deepEqual(c.scope, ["src/**", "docs/**"]);
  assert.equal(c.lint.id, "DEMO-1");
  assert.equal(c.card.status, "waiting");

  const r = (await call(dir, "mw_run_status", { id: "DEMO-1" })).data as RunData;
  assert.equal(r.exists, true);
  assert.equal(r.currentPhase, state(dir).history.length ? r.phases.find((p) => p.current)!.id : null);
  assert.deepEqual(r.phasesDone, r.phases.filter((p) => p.done).map((p) => p.id));
  assert.ok(r.phasesDone.includes("brief"));
  const briefFile = r.files.find((f) => f.name === "brief.json");
  assert.equal(briefFile?.kind, "brief");
  assert.ok(r.files.some((f) => f.kind === "prompt" && f.name.startsWith("phases/")));
  assert.equal(r.files.find((f) => f.name === "state.json")?.kind, "state");

  const f = await call(dir, "mw_run_file", { id: "DEMO-1", name: "brief.json" });
  assert.equal(f.isError, false, f.text);
  const fd = f.data as RunFileData;
  assert.equal(fd.kind, "brief");
  assert.equal((fd.json as { summary: string }).summary, "Add the app file.");
  assert.equal(f.text, fd.text);
});

test("results: mw_run_file refuses names outside the run folder and redacts credentials", async () => {
  useScript(script());
  const dir = project({ cardExtra: "risk: high\n" });
  await run(dir);
  const rd = runDir(new Project(dir), "DEMO-1");
  fs.writeFileSync(path.join(dir, "outside.txt"), "secret outside\n");
  fs.symlinkSync(path.join(dir, "outside.txt"), path.join(rd, "link.txt"));
  for (const name of ["../../../outside.txt", "/etc/passwd", "link.txt", "phases/../state.json", ""]) {
    const r = await call(dir, "mw_run_file", { id: "DEMO-1", name });
    assert.equal(r.isError, true, name);
    assert.match(r.text, /not a plain path|leads outside|no file|'name' is required/, name);
  }
  assert.equal(((await call(dir, "mw_run_status", { id: "DEMO-1" })).data as RunData).files.some((f) => f.name === "link.txt"), false, "links are not listed");
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "tok-0123456789abcdef";
  try {
    fs.writeFileSync(path.join(rd, "gate-logs-note.txt"), "token tok-0123456789abcdef here\n");
    const r = await call(dir, "mw_run_file", { id: "DEMO-1", name: "gate-logs-note.txt" });
    assert.doesNotMatch(r.text, /tok-0123456789abcdef/);
    assert.doesNotMatch(JSON.stringify(r.data), /tok-0123456789abcdef/, "the data is scrubbed too");
    assert.match((r.data as RunFileData).text, /\[redacted\]/);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved;
  }
});

test("results: card operations return the card's new state; setting ready with lint errors is refused with the findings as data", async () => {
  const dir = newProject();
  const made = await call(dir, "mw_card_new", { title: "Add a greeter", kind: "chore", scope: ["src/**"], why: "The demo needs one.", out_of_scope: "None", acceptance: ["it greets"] });
  assert.equal(made.isError, false, made.text);
  assert.match(made.text, /^created cards\/DEMO-1\.card\.md \(status todo\)/);
  assert.deepEqual([(made.data as CardChangeData).card.id, (made.data as CardChangeData).card.status], ["DEMO-1", "todo"]);
  const ready = await call(dir, "mw_card_set_status", { id: "DEMO-1", status: "ready" });
  assert.equal(ready.isError, false, ready.text);
  assert.equal((ready.data as CardChangeData).card.status, "ready");

  write(dir, "cards/DEMO-2.card.md", "---\nid: DEMO-2\ntitle: Empty\nkind: chore\nstatus: todo\nscope: []\n---\n\n## Why\n\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "card");
  const refused = await call(dir, "mw_card_set_status", { id: "DEMO-2", status: "ready" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /card\/not-ready|lint errors/);
  const lint = (refused.data as NotReadyData).lint;
  assert.equal(lint.ok, false);
  assert.ok(lint.findings.some((f) => f.code === "lint/scope-empty"));

  const saved = process.env.MW_ROLE;
  process.env.MW_ROLE = "worker";
  try {
    const r = await call(dir, "mw_card_new", { title: "x" });
    assert.equal(r.isError, true);
    assert.match(r.text, /done by the owner/);
  } finally {
    if (saved === undefined) delete process.env.MW_ROLE; else process.env.MW_ROLE = saved;
  }
});

test("results: mw_retry with run puts a blocked card back and starts its run in the background", async () => {
  useScript(script({ planner: [{ output: brief({ ready: false, blockers: ["needs a decision"] }) }, { output: brief() }] }));
  const dir = project({ cardExtra: "risk: high\n" });
  const s = await run(dir);
  assert.equal(s.status, "blocked", s.reason);
  const r = await call(dir, "mw_retry", { id: "DEMO-1", from: "brief", run: true });
  assert.equal(r.isError, false, r.text);
  const d = r.data as RetryData;
  assert.equal(d.from, "brief");
  assert.ok(d.started && d.started.pid > 0);
  assert.equal(d.started.started, "mw run DEMO-1");
  // The run goes on in the background until it waits for 'go'.
  const deadline = Date.now() + 60_000;
  while (state(dir).status !== "waiting" && Date.now() < deadline) await new Promise((res) => setTimeout(res, 200));
  assert.equal(state(dir).status, "waiting");
  while (fs.existsSync(path.join(dir, ".mergewright", "local", "locks", "DEMO-1.lock")) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
});

test("results: mw_packages and mw_settings; listTools says which tools write and what data each returns", async () => {
  const dir = newProject();
  const pk = await call(dir, "mw_packages");
  assert.equal(pk.text, "no packages installed ('mw add <name | path>' installs one)");
  assert.deepEqual((pk.data as PackagesData).packages, []);
  const st = (await call(dir, "mw_settings")).data as SettingsData;
  assert.equal(st.name, "demo");
  assert.equal(st.prefix, "DEMO");
  assert.ok(st.flows.some((f) => f.id === st.defaultFlow && f.phases.length > 0));
  assert.ok(st.roles.some((r) => r.id === "worker" && r.harness.length > 0));
  assert.ok(Array.isArray(st.gate.required));

  const tools = await listTools(new Project(dir));
  assert.equal(tools.length, TOOLS.length);
  const by = new Map(tools.map((t) => [t.name, t]));
  assert.equal(by.get("mw_card_new")!.write, true);
  assert.equal(by.get("mw_status")!.write, false);
  assert.equal(by.get("mw_status")!.result, "StatusData");
  assert.equal(by.get("mw_memory_state")!.result, null);
  assert.equal((by.get("mw_run_file")!.inputSchema as { required: string[] }).required.join(), "id,name");
  assert.match((await call(dir, "mw_nothing")).text, /unknown tool/);
});

test("concurrency: many tool calls at once, on two projects, each see only their own command's root and output", async () => {
  const a = newProject();
  const b = newProject({ prefix: "OTHER" });
  // A command that waits before it reads the working directory: without the queue, another call's chdir would show.
  handlers.__cwd_probe = async (_args, out) => {
    const before = process.cwd();
    await new Promise((r) => setTimeout(r, Math.random() * 15));
    out(`${before}|${process.cwd()}`);
    return 0;
  };
  try {
    const calls = Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b)).map(async (root) => ({ root, out: await viaCli(root, ["__cwd_probe"]) }));
    for (const { root, out } of await Promise.all(calls)) assert.equal(out, `${root}|${root}`);
    // And through the tools: concurrent status calls on both projects answer for their own.
    const both = await Promise.all(Array.from({ length: 20 }, (_, i) => call(i % 2 ? a : b, "mw_settings")));
    both.forEach((r, i) => assert.equal((r.data as SettingsData).prefix, i % 2 ? "DEMO" : "OTHER"));
  } finally {
    delete handlers.__cwd_probe;
  }
});

test("MCP: structuredContent goes to a client that asked for it on 2025-06-18, never otherwise; the text is the same", async () => {
  const dir = newProject();
  const session = async (protocolVersion: string, capabilities: object) => {
    const proc = spawn(process.execPath, [MW, "mcp", "serve", "--project", dir], { env: { ...process.env, MW_ENV_FILE: "/dev/null" }, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const replies: Record<string, unknown>[] = [];
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => { buf += d; });
    const send = (m: object) => proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion, capabilities, clientInfo: { name: "t", version: "1" } } });
    send({ id: 2, method: "tools/call", params: { name: "mw_settings", arguments: {} } });
    proc.stdin.end();
    await new Promise((r) => proc.on("close", r));
    for (const l of buf.split("\n").filter(Boolean)) replies.push(JSON.parse(l) as Record<string, unknown>);
    return replies.find((x) => x.id === 2)!.result as { content: { text: string }[]; structuredContent?: Record<string, unknown> };
  };
  const asked = await session("2025-06-18", { experimental: { structuredContent: true } });
  assert.equal(asked.structuredContent?.resultsVersion, RESULTS_VERSION);
  assert.equal(asked.structuredContent?.prefix, "DEMO");
  const plain = await session("2025-06-18", {});
  assert.equal(plain.structuredContent, undefined);
  const old = await session("2025-03-26", { experimental: { structuredContent: true } });
  assert.equal(old.structuredContent, undefined);
  assert.equal(asked.content[0]!.text, plain.content[0]!.text);
});
