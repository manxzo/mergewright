// Regression tests for memory delivery, documentation sync and card creation in an existing project.
//   1. `mw memory add lesson|decision` stores to mem0 and Letta (queued when down) and says where it went.
//   2. `mw memory push` / `mw_memory_push`: every lesson and decision file to the services, idempotently.
//   3. `mw open-notebook sync --all` (was `mw docs sync --all`) and the docs.sync phase skip binary files; `docs.exclude` leaves files out.
//   4. `mw card new --tags a,b --status ready` and `mw_card_new` with `tags` / `status`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { docBlob } from "../src/integrations/docs.ts";
import { settleDeliveries } from "../src/integrations.ts";
import { lessonId } from "../src/integrations/common.ts";
import { callTool, TOOLS } from "../src/mcpserver/server.ts";
import type { ToolContext } from "../src/mcpserver/tool.ts";
import { Project } from "../src/project.ts";
import { git, MW, notebookConfig, read, write } from "./helpers.ts";
import { deadUrl, mockServer, projectWith, queueItems, type Recorded } from "./fixtures/integrations/support.ts";

const MEM0_KEY = "mem0-test-key-not-a-secret";
const LETTA_PASS = "letta-test-password-not-a-secret";
const NB_PASS = "nb-test-password-not-a-secret";
const ENV = { MW_ENV_FILE: "/dev/null", MW_TEST_MEM0_KEY: MEM0_KEY, MW_TEST_LETTA_PASSWORD: LETTA_PASS, MW_TEST_NB_PASSWORD: NB_PASS };
process.env.MW_TEST_MEM0_KEY = MEM0_KEY;
process.env.MW_TEST_LETTA_PASSWORD = LETTA_PASS;
process.env.MW_TEST_NB_PASSWORD = NB_PASS;

/** `mw` as a child process, without blocking this process (the mock servers answer from here). */
function mwAsync(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, ...ENV };
    delete env.MW_ROLE;
    const p = spawn(process.execPath, [MW, ...args], { cwd, env });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

async function tool(dir: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `the MCP server has a tool ${name}`);
  const ctx: ToolContext = { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined };
  const cwd = process.cwd();
  try {
    const r = await callTool(t, args, ctx);
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  } finally {
    process.chdir(cwd);
  }
}

/** mem0: POST /memories, GET /memories?user_id, POST /search (honours a lesson_id filter). */
async function mem0Mock() {
  const store: { id: string; memory: string; user_id: string; metadata: Record<string, unknown> }[] = [];
  const mock = await mockServer((r: Recorded) => {
    if (r.headers["x-api-key"] !== MEM0_KEY) return { status: 401, body: { detail: "bad key" } };
    const u = new URL(r.url, "http://x");
    const b = r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r.method === "POST" && u.pathname === "/memories") {
      const m = { id: `m${store.length + 1}`, memory: b.messages[0].content, user_id: b.user_id, metadata: b.metadata };
      store.push(m);
      return { body: { results: [{ id: m.id, memory: m.memory, event: "ADD" }] } };
    }
    if (r.method === "GET" && u.pathname === "/memories") return { body: { results: store.filter((m) => m.user_id === u.searchParams.get("user_id")) } };
    if (r.method === "POST" && u.pathname === "/search") {
      const f = b.filters as Record<string, unknown>;
      const hits = store.filter((m) => m.user_id === f.user_id && (f.lesson_id === undefined || m.metadata.lesson_id === f.lesson_id));
      return { body: { results: hits.slice(0, b.top_k).map((m) => ({ ...m, score: 0.5 })) } };
    }
    return undefined;
  });
  return Object.assign(mock, { store });
}

/** Letta: one agent per name, archival passages, search filtered by tags. */
async function lettaMock() {
  const agents = new Map<string, { name: string; passages: { id: string; text: string; tags: string[] }[] }>();
  let n = 0;
  const mock = await mockServer((r: Recorded) => {
    if (r.headers.authorization !== `Bearer ${LETTA_PASS}`) return { status: 401, body: { detail: "Unauthorized" } };
    const u = new URL(r.url, "http://x");
    const b = r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r.method === "GET" && u.pathname === "/v1/agents/") return { body: [...agents.entries()].filter(([, a]) => a.name === u.searchParams.get("name")).map(([id, a]) => ({ id, name: a.name })) };
    if (r.method === "POST" && u.pathname === "/v1/agents/") {
      const id = `agent-${++n}`;
      agents.set(id, { name: b.name, passages: [] });
      return { body: { id, name: b.name } };
    }
    const m = /^\/v1\/agents\/([^/]+)\/archival-memory(\/search)?$/.exec(u.pathname);
    const agent = m ? agents.get(decodeURIComponent(m[1]!)) : undefined;
    if (m && !agent) return { status: 404, body: { detail: "agent not found" } };
    if (r.method === "POST" && m && !m[2]) {
      const p = { id: `passage-${++n}`, text: b.text, tags: b.tags ?? [] };
      agent!.passages.push(p);
      return { body: [p] };
    }
    if (r.method === "GET" && m?.[2]) {
      const want = u.searchParams.getAll("tags");
      const hits = agent!.passages.filter((p) => !want.length || want.some((t) => p.tags.includes(t)));
      return { body: { results: hits.slice(0, Number(u.searchParams.get("top_k") ?? 10)).map((p) => ({ id: p.id, content: p.text, tags: p.tags })), count: hits.length } };
    }
    return undefined;
  });
  return Object.assign(mock, { passages: () => [...agents.values()].flatMap((a) => a.passages) });
}

const memCfg = (mem0: string, letta: string) => ({
  packages: { mem0: { url: mem0, key_env: "MW_TEST_MEM0_KEY" }, letta: { url: letta, key_env: "MW_TEST_LETTA_PASSWORD" } },
});

test("mw memory add lesson|decision stores in mem0, queues for Letta when it is down, says so, and is idempotent; mw_memory_add shares it", async () => {
  const mem0 = await mem0Mock();
  after(() => mem0.close());
  const dead = await deadUrl();
  const { dir } = projectWith(memCfg(mem0.url, dead));

  const add = ["memory", "add", "lesson", "--topic", "testing", "--title", "Run the gate first", "--body", "Always run the gate before merging."];
  const r = await mwAsync(dir, add);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /lesson added/);
  assert.match(r.out, /stored in mem0, queued for letta \(down/);
  assert.equal(mem0.store.length, 1);
  assert.equal(mem0.store[0]!.metadata.lesson_id, lessonId("demo", { topic: "testing", title: "Run the gate first" }));
  assert.equal(mem0.store[0]!.memory, "Always run the gate before merging.");
  const queued = queueItems(dir);
  assert.deepEqual(queued.map((q) => q.kind), ["letta"], "Letta's copy waits in this machine's queue, for the same deliverer as the reflect phase");
  assert.deepEqual((queued[0]!.payload as { lessons: unknown[] }).lessons, [{ topic: "testing", title: "Run the gate first", body: "Always run the gate before merging." }]);

  // The same lesson again: mem0 already holds it, and Letta's queue does not get a second copy.
  const again = await mwAsync(dir, add);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /already in mem0, queued for letta/);
  assert.equal(mem0.store.length, 1, "not stored twice");
  assert.equal(queueItems(dir).length, 1, "not queued twice");

  const dec = await mwAsync(dir, ["memory", "add", "decision", "--title", "Use a queue", "--body", "Because services go down."]);
  assert.equal(dec.code, 0, dec.err);
  assert.match(dec.out, /created memory\/decisions\/.*use-a-queue\.md\nstored in mem0, queued for letta/);
  assert.equal(mem0.store.length, 2);
  assert.equal(mem0.store[1]!.metadata.topic, "decision");

  // The MCP tool (locked) records the delivery in the queue and says so (REQ-engine-008); the delivery
  // after the lock goes through the same deliverer: idempotent, and Letta's queue gets no second copy.
  const m = await tool(dir, "mw_memory_add", { kind: "lesson", topic: "testing", title: "Run the gate first", body: "Always run the gate before merging." });
  assert.equal(m.isError, false, m.text);
  assert.match(m.text, /queued for mem0, queued for letta\n.*the delivery starts now, in the background, after the repository lock and the lease were released/);
  await settleDeliveries();
  assert.equal(mem0.store.length, 2, "mem0 already holds it: not stored twice");
  assert.deepEqual(queueItems(dir).map((q) => q.kind), ["letta", "letta"], "delivered to mem0; Letta's two items (lesson, decision) still wait, no third");
});

test("mw memory push sends every lesson and decision once; a second push stores nothing new; mw_memory_push and --service", async () => {
  const mem0 = await mem0Mock();
  const letta = await lettaMock();
  after(() => Promise.all([mem0.close(), letta.close()]));
  const { dir } = projectWith(memCfg(mem0.url, letta.url));
  // Memory written before the services were configured (as a migrated project has it).
  write(dir, "memory/lessons/testing.md", "# Testing\n\n## Run the gate first\n\nAlways run the gate.\n\n- added: 2026-01-01\n- card: DEMO-3\n\n## Fake the board\n\nTests use a fake kanban.\n\n- added: 2026-01-02\n");
  write(dir, "memory/lessons/git.md", "# Git\n\n## Squash\n\nSquash merges keep history flat.\n\n- added: 2026-01-03\n");
  write(dir, "memory/decisions/2026-01-04-use-mem0.md", "# Use mem0\n\n- date: 2026-01-04\n\nBecause it is self-hosted.\n");

  const first = await mwAsync(dir, ["memory", "push"]);
  assert.equal(first.code, 0, first.err + first.out);
  assert.match(first.out, /4 record\(s\) in memory\//);
  assert.match(first.out, /mem0: 4 stored, 0 already present, 0 queued, 0 failed/);
  assert.match(first.out, /letta: 4 stored, 0 already present, 0 queued, 0 failed/);
  assert.equal(mem0.store.length, 4);
  assert.equal(letta.passages().length, 4);
  const gate = mem0.store.find((m) => m.metadata.title === "Run the gate first")!;
  assert.equal(gate.memory, "Always run the gate.", "the file's own '- added:' lines are not part of the lesson");
  assert.equal(gate.metadata.card, "DEMO-3");
  assert.ok(letta.passages().some((p) => p.tags.includes(`lesson_id:${lessonId("demo", { topic: "decision", title: "Use mem0" })}`)));

  const second = await mwAsync(dir, ["memory", "push"]);
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /mem0: 0 stored, 4 already present/);
  assert.match(second.out, /letta: 0 stored, 4 already present/);
  assert.equal(mem0.store.length, 4, "a second push stores nothing new in mem0");
  assert.equal(letta.passages().length, 4, "nor in Letta");

  // One new lesson, pushed to Letta only through the MCP tool.
  write(dir, "memory/lessons/git.md", read(dir, "memory/lessons/git.md") + "\n## Rebase\n\nNever rebase a shared branch.\n\n- added: 2026-01-05\n");
  const m = await tool(dir, "mw_memory_push", { lessons: true, service: "letta" });
  assert.equal(m.isError, false, m.text);
  assert.match(m.text, /4 record\(s\) in memory\//);
  assert.match(m.text, /letta: 1 stored, 3 already present, 0 queued, 0 failed/);
  assert.doesNotMatch(m.text, /mem0:/);
  assert.equal(letta.passages().length, 5);
  assert.equal(mem0.store.length, 4);

  // --decisions only, mem0 down: queued, counted, and the push goes on.
  const { dir: dir2 } = projectWith(memCfg(await deadUrl(), letta.url));
  write(dir2, "memory/decisions/2026-01-04-use-mem0.md", "# Use mem0\n\n- date: 2026-01-04\n\nBecause it is self-hosted.\n");
  const down = await mwAsync(dir2, ["memory", "push", "--decisions"]);
  assert.equal(down.code, 0, down.err);
  assert.match(down.out, /mem0: 0 stored, 0 already present, 1 queued, 0 failed/);
  assert.match(down.out, /letta: 0 stored, 1 already present/);
  assert.deepEqual(queueItems(dir2).map((q) => q.kind), ["mem0"]);
});

/** Open Notebook: notebooks, text sources. */
async function notebookMock() {
  const sources: { id: string; title: string; content: string; notebooks: string[] }[] = [];
  let next = 1;
  const notebooks: { id: string; name: string }[] = [];
  const mock = await mockServer((r) => {
    if (r.headers.authorization !== `Bearer ${NB_PASS}`) return { status: 401, body: { detail: "Missing authorization" } };
    const u = new URL(r.url, "http://x");
    if (u.pathname === "/api/notebooks" && r.method === "GET") return { body: notebooks };
    if (u.pathname === "/api/notebooks" && r.method === "POST") {
      const n = { id: `notebook:${next++}`, name: (r.body as { name: string }).name };
      notebooks.push(n);
      return { body: n };
    }
    if (u.pathname === "/api/sources" && r.method === "GET") return { body: sources.slice(Number(u.searchParams.get("offset")), Number(u.searchParams.get("offset")) + Number(u.searchParams.get("limit"))).map((s) => ({ id: s.id, title: s.title })) };
    if (u.pathname === "/api/sources/json" && r.method === "POST") {
      const b = r.body as { title: string; content: string; notebooks: string[] };
      sources.push({ id: `source:${next++}`, title: b.title, content: b.content, notebooks: b.notebooks });
      return { body: { id: `source:${next}` } };
    }
    return undefined;
  });
  return Object.assign(mock, { sources });
}

test("docs sync --all and the docs.sync phase skip binary files with a warning; docs.exclude leaves files out silently", async () => {
  const nb = await notebookMock();
  after(() => nb.close());
  const { dir } = projectWith({ docs: { paths: ["docs/**"] }, ...notebookConfig({ url: nb.url, key_env: "MW_TEST_NB_PASSWORD" }) });
  fs.rmSync(path.join(dir, "docs"), { recursive: true, force: true });
  write(dir, "docs/guide.md", "# Guide\n\nText.\n");
  write(dir, "docs/notes.txt", "plain notes\n");
  fs.writeFileSync(path.join(dir, "docs/manual.pdf"), Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\nbinary", "latin1"));
  fs.writeFileSync(path.join(dir, "docs/blob.dat"), Buffer.from([0x41, 0x00, 0x42, 0x00]));
  write(dir, "docs/product/plan.md", "# Plan\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "docs");

  const r = await mwAsync(dir, ["open-notebook", "sync", "--all"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /skipped: docs\/manual\.pdf is a binary file \(\.pdf\)/);
  assert.match(r.out, /skipped: docs\/blob\.dat is a binary file \(it contains NUL bytes\)/);
  assert.match(r.out, /3 document\(s\) of the last commit synced to notebook 'demo', 2 skipped/);
  assert.deepEqual(nb.sources.map((s) => s.title).sort(), ["docs/guide.md", "docs/notes.txt", "docs/product/plan.md"]);

  // The docs.sync phase reads each file through docBlob: a binary file is skipped there too.
  const head = git(dir, "rev-parse", "HEAD");
  assert.equal(docBlob(dir, head, "docs/manual.pdf").kind, "skipped");
  assert.equal(docBlob(dir, head, "docs/blob.dat").kind, "skipped");
  assert.equal(docBlob(dir, head, "docs/guide.md").kind, "file");

  // docs.exclude: left out silently (no warning, not counted as skipped); docs.paths unchanged.
  const cfg = path.join(dir, "mergewright.yaml");
  fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace("  paths:\n    - docs/**\n", "  paths:\n    - docs/**\n  exclude:\n    - docs/product/**\n"));
  assert.match(read(dir, "mergewright.yaml"), /exclude:\n {4}- docs\/product\/\*\*/);
  nb.sources.length = 0;
  const ex = await mwAsync(dir, ["open-notebook", "sync", "--all"]);
  assert.equal(ex.code, 0, ex.err);
  assert.doesNotMatch(ex.out, /product/);
  assert.match(ex.out, /2 document\(s\) of the last commit synced to notebook 'demo', 2 skipped/);
  assert.deepEqual(nb.sources.map((s) => s.title).sort(), ["docs/guide.md", "docs/notes.txt"]);
  const check = await mwAsync(dir, ["check"]);
  assert.doesNotMatch(check.out, /exclude/, "docs.exclude is a known config key");
});

test("mw card new --tags a,b --status ready and mw_card_new tags/status land in the card file, and mw check accepts it", async () => {
  const { dir } = projectWith();
  const r = await mwAsync(dir, ["card", "new", "--title", "Tagged work", "--kind", "chore", "--scope", "src/**", "--why", "The migration needs it.", "--out-of-scope", "None", "--acceptance", "It is tagged.", "--tags", "migration,greeter", "--status", "ready"]);
  assert.equal(r.code, 0, r.err);
  const file = r.out.match(/created (cards\/\S+\.card\.md)/)![1]!;
  const text = read(dir, file);
  assert.match(text, /^status: ready$/m);
  assert.match(text, /^tags:\n {2}- migration\n {2}- greeter$/m);
  const card = new Project(dir).card(file.replace(/^cards\/|\.card\.md$/g, ""));
  assert.equal(card.status, "ready");
  assert.deepEqual(card.tags, ["migration", "greeter"]);
  const bad = await mwAsync(dir, ["card", "new", "--title", "No", "--status", "done"]);
  assert.notEqual(bad.code, 0, "a new card is todo or ready only");

  const m = await tool(dir, "mw_card_new", { title: "From MCP", kind: "chore", scope: ["src/**"], why: "The migration needs it.", out_of_scope: "None", acceptance: ["It is tagged."], tags: ["mcp"], status: "ready" });
  assert.equal(m.isError, false, m.text);
  assert.match(m.text, /\(status ready\)/);
  const made = new Project(dir).cards().find((c) => c.title === "From MCP")!;
  assert.equal(made.status, "ready");
  assert.deepEqual(made.tags, ["mcp"]);

  const check = await mwAsync(dir, ["check"]);
  assert.equal(check.code, 0, check.out + check.err);
  assert.doesNotMatch(check.out, /error/);
});
