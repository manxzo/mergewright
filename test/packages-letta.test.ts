// The official letta package (packages/letta), installed with `mw add letta --yes`, against a local mock
// of the Letta server's REST API (routes checked against letta/letta 0.16.8): the per-project agent,
// lessons in archival memory, search, the doctor check, queueing when Letta is down, the refusal of the
// old core setting, and the MCP tools mw_letta_add / mw_letta_search.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { flushQueue, integrationsFor } from "../src/integrations.ts";
import { lessonId } from "../src/integrations/common.ts";
import { doctor } from "../src/commands-integrations.ts";
import { allTools, serve } from "../src/mcpserver/server.ts";
import type { PackageExports } from "../src/packages/api.ts";
import { loadPackages } from "../src/packages/loader.ts";
import { Project } from "../src/project.ts";
import { deadUrl, mockServer, projectWith, queueItems, type Recorded } from "./fixtures/integrations/support.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { lettaConfig, mw, newProject, write } from "./helpers.ts";

/** The package module's own helpers (pure functions, no host). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pkg = await import(pathToFileURL(path.join(PACKAGE_ROOT, "packages", "letta", "index.mjs")).href) as Record<string, any>;
const { agentName, embeddingFields, lessonTags, settingsOf } = pkg;

/** The loaded letta package's exports in `project`. */
async function letta(project: Project): Promise<PackageExports> {
  const l = (await loadPackages(project)).find((x) => x.name === "letta");
  assert.ok(l?.exports, l?.error ?? "letta did not load");
  return l.exports;
}
/** The agent cache of this machine (the package's local folder). */
const cachePath = (dir: string) => path.join(dir, ".mergewright", "local", "packages", "letta", "letta-agent.json");

const PASS = "letta-test-password-not-a-secret";
process.env.MW_TEST_LETTA_PASSWORD = PASS;

interface Passage { id: string; text: string; tags: string[] }

/** A Letta server: agents by name, archival passages per agent, word-overlap "semantic" search. */
async function lettaMock() {
  const agents = new Map<string, { name: string; model: string; embedding: string; passages: Passage[] }>();
  let n = 0;
  const mock = await mockServer((r: Recorded) => {
    const u = new URL(r.url, "http://x");
    if (r.method === "GET" && u.pathname === "/v1/health/") return { body: { version: "0.16.8", status: "ok" } };
    if (r.headers.authorization !== `Bearer ${PASS}`) return { status: 401, body: { detail: "Unauthorized" } };
    const b = r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r.method === "GET" && u.pathname === "/v1/agents/") {
      const name = u.searchParams.get("name");
      return { body: [...agents.entries()].filter(([, a]) => !name || a.name === name).slice(0, Number(u.searchParams.get("limit") ?? 50)).map(([id, a]) => ({ id, name: a.name })) };
    }
    if (r.method === "POST" && u.pathname === "/v1/agents/") {
      const id = `agent-${String(++n).padStart(8, "0")}-0000-4000-8000-000000000000`;
      agents.set(id, { name: b.name, model: b.model, embedding: b.embedding, passages: [] });
      return { body: { id, name: b.name } };
    }
    const m = /^\/v1\/agents\/([^/]+)(\/archival-memory(\/search)?)?$/.exec(u.pathname);
    const agent = m ? agents.get(decodeURIComponent(m[1]!)) : undefined;
    if (m && !agent) return { status: 404, body: { detail: "agent not found" } };
    if (r.method === "DELETE" && m && !m[2]) { agents.delete(decodeURIComponent(m[1]!)); return { body: {} }; }
    if (r.method === "POST" && m?.[2] && !m[3]) {
      const p = { id: `passage-${++n}`, text: b.text, tags: b.tags ?? [] };
      agent!.passages.push(p);
      return { body: [{ ...p, metadata: {}, agent_id: m[1] }] };
    }
    if (r.method === "GET" && m?.[3]) {
      const words = (u.searchParams.get("query") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const want = u.searchParams.getAll("tags");
      const hits = agent!.passages.filter((p) => words.some((w) => p.text.toLowerCase().includes(w)) && (!want.length || want.some((t) => p.tags.includes(t))));
      const top = hits.slice(0, Number(u.searchParams.get("top_k") ?? 10));
      return { body: { results: top.map((p) => ({ id: p.id, content: p.text, tags: p.tags, timestamp: "2026-10-06T00:00:00Z" })), count: top.length } };
    }
    return undefined;
  });
  return Object.assign(mock, { agents });
}

const lettaCfg = (url: string, extra: Record<string, unknown> = {}) => lettaConfig({ url, key_env: "MW_TEST_LETTA_PASSWORD", ...extra });

test("letta: config defaults; remember queues and the flush creates the project's agent once, caches its id and stores each lesson with mem0's metadata as tags", async () => {
  const mock = await lettaMock();
  after(() => mock.close());
  const { dir, project } = projectWith(lettaCfg(mock.url));
  const s = settingsOf(project.config.packages.letta, project.config.name);
  assert.equal(s.agent, "mergewright");
  assert.equal(s.keyEnv, "MW_TEST_LETTA_PASSWORD");
  assert.equal(s.model, "openai-proxy/qwen3.6-35b-a3b");
  assert.equal(s.embedding, "qwen3-embedding-0.6b");
  assert.equal(s.embeddingEndpoint, "http://llamacpp-embed:8080/v1");
  assert.equal(s.embeddingDim, 1024);
  assert.equal(agentName(s), "mergewright-demo");

  const i = integrationsFor(project);
  await i.remember([
    { topic: "testing", title: "Run the gate first", body: "Always run the gate\nbefore merging.\n\nSecond paragraph.", card: "DEMO-3" },
    { topic: "git", title: "Squash", body: "Squash merges keep history flat." },
  ]);
  assert.equal(mock.requests.length, 0, "remember sends nothing (REQ-engine-008)");
  assert.deepEqual(queueItems(dir).map((x) => [x.kind, x.holdPid]), [["letta", process.pid]], "one letta item, held for this process until its flush");
  assert.deepEqual((await flushQueue(project)).map((r) => r.ok), [true]);
  const creates = mock.requests.filter((r) => r.method === "POST" && r.url === "/v1/agents/");
  assert.equal(creates.length, 1, "one agent per project");
  const create = creates[0]!.body as Record<string, unknown>;
  assert.equal(create.name, "mergewright-demo");
  assert.equal(create.model, "openai-proxy/qwen3.6-35b-a3b");
  assert.equal(create.embedding, undefined, "no handle: Letta lists none for an OpenAI-compatible embedding model");
  assert.deepEqual(create.embedding_config, { embedding_endpoint_type: "openai", embedding_endpoint: "http://llamacpp-embed:8080/v1", embedding_model: "qwen3-embedding-0.6b", embedding_dim: 1024, embedding_chunk_size: 300 });
  const [id] = [...mock.agents.keys()];
  const cache = JSON.parse(fs.readFileSync(cachePath(dir), "utf8"));
  assert.deepEqual(cache, { url: mock.url, name: "mergewright-demo", id });

  const inserts = mock.requests.filter((r) => r.method === "POST" && r.url.endsWith("/archival-memory"));
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts[0]!.body, {
    text: "Run the gate first\n\nAlways run the gate\nbefore merging.\n\nSecond paragraph.",
    tags: ["mergewright", "lesson", "topic:testing", "project:demo", `lesson_id:${lessonId("demo", { topic: "testing", title: "Run the gate first" })}`, "card:DEMO-3"],
  });
  assert.deepEqual((inserts[1]!.body as { tags: string[] }).tags, lessonTags("demo", { topic: "git", title: "Squash", body: "" }, lessonId("demo", { topic: "git", title: "Squash" })));
  assert.equal(mock.requests.filter((r) => r.method === "GET" && r.url.startsWith("/v1/agents/?")).length, 1, "the second lesson used the cached id");
  assert.ok(mock.requests.every((r) => r.headers.authorization === `Bearer ${PASS}`));
  assert.deepEqual(queueItems(dir), []);

  // Recall (and searchLessons): 'title: first paragraph of the body' for lessons.
  assert.deepEqual(await i.recall("gate", 5), ["Run the gate first: Always run the gate before merging."]);
  // The last search is recall's (the flush checked presence from one listing of the archive).
  const search = mock.requests.filter((r) => r.url.includes("/archival-memory/search")).at(-1)!;
  assert.equal(new URL(search.url, "http://x").searchParams.get("query"), "gate");
  assert.equal(new URL(search.url, "http://x").searchParams.get("top_k"), "5");
});

test("letta: an existing agent is found by name; a cached agent that was deleted is found or created again", async () => {
  const mock = await lettaMock();
  after(() => mock.close());
  const { dir, project } = projectWith(lettaCfg(mock.url, { agent: "team" }));
  const ex = await letta(project);
  await ex.search!("anything", 1); // the first use creates the agent
  const [first] = [...mock.agents.keys()];
  // Another machine's cache is empty: the agent is found by name, not created twice.
  fs.rmSync(cachePath(dir));
  await ex.search!("anything", 1);
  assert.equal(mock.agents.size, 1);
  assert.equal([...mock.agents.values()][0]!.name, "team-demo");
  // The agent is deleted on the server: the stale cached id answers 404 and a new agent is made.
  mock.agents.clear();
  await integrationsFor(project).remember([{ topic: "t", title: "After delete", body: "b" }]);
  await flushQueue(project);
  assert.equal(mock.agents.size, 1);
  const [again] = [...mock.agents.keys()];
  assert.notEqual(again, first);
  assert.deepEqual(await ex.search!("delete", 3), ["After delete: b"]);
});

test("letta unreachable: recall returns [], remember queues the lessons as kind letta; flush delivers them", async () => {
  const dead = await deadUrl();
  const { dir, project } = projectWith(lettaCfg(dead));
  const i = integrationsFor(project);
  assert.deepEqual(await i.recall("x", 3), []);
  await i.remember([{ topic: "t", title: "One", body: "b1" }, { topic: "t", title: "Two", body: "b2" }]);
  const items = queueItems(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "letta");
  assert.match(items[0]!.summary, /^letta: 2 lesson\(s\): One; Two/);

  const mock = await lettaMock();
  after(() => mock.close());
  const cfg = path.join(dir, "mergewright.yaml");
  fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace(dead, mock.url));
  const results = await flushQueue(new Project(dir));
  assert.deepEqual(results.map((r) => r.ok), [true]);
  assert.deepEqual(queueItems(dir), []);
  assert.deepEqual([...mock.agents.values()][0]!.passages.map((p) => p.text), ["One\n\nb1", "Two\n\nb2"]);
});

test("letta with a wrong password stays queued; with mem0 also configured, each store is delivered or kept on its own", async () => {
  const mock = await lettaMock();
  after(() => mock.close());
  const mem0 = await mockServer((r) => (r.method === "POST" && r.url === "/memories" ? { body: { results: [{ id: "m1", memory: "x", event: "ADD" }] } } : r.method === "GET" && r.url.startsWith("/memories?") ? { body: { results: [] } } : undefined));
  after(() => mem0.close());
  process.env.MW_TEST_MEM0_KEY_L = "k";
  const { dir, project } = projectWith({ packages: { mem0: { url: mem0.url, key_env: "MW_TEST_MEM0_KEY_L" }, letta: { url: mock.url, key_env: "MW_TEST_LETTA_WRONG" } } });
  process.env.MW_TEST_LETTA_WRONG = "wrong";
  await integrationsFor(project).remember([{ topic: "t", title: "Both", body: "b" }]);
  assert.deepEqual(queueItems(dir).map((x) => x.kind), ["mem0", "letta"], "remember queues one item per store");
  await flushQueue(project);
  assert.equal(mem0.requests.filter((r) => r.url === "/memories").length, 1, "mem0 got the lesson");
  const items = queueItems(dir);
  assert.deepEqual(items.map((x) => x.kind), ["letta"]);
  assert.match(items[0]!.lastError ?? "", /HTTP 401/);
  assert.ok(!JSON.stringify(items).includes("wrong"), "the queue holds no password");
});

test("letta check and mw doctor: version and agent state, the variable name only", async () => {
  const mock = await lettaMock();
  after(() => mock.close());
  const { project } = projectWith(lettaCfg(mock.url));
  const lines: string[] = [];
  await doctor((l = "") => lines.push(l), project);
  const line = lines.find((l) => l.startsWith("letta"))!;
  assert.match(line, /^letta\s+ok\s+reachable, version 0\.16\.8, agent 'mergewright-demo' not created yet/);
  assert.match(line, /MW_TEST_LETTA_PASSWORD set/);
  assert.match(line, /\(package letta\)$/);
  assert.ok(!lines.join("\n").includes(PASS));
  assert.equal(mock.requests.filter((r) => r.method === "POST").length, 0, "the check never creates an agent");
  const ex = await letta(project);
  await ex.search!("x", 1);
  const [id] = [...mock.agents.keys()];
  const again: string[] = [];
  await doctor((l = "") => again.push(l), project);
  assert.match(again.find((l) => l.startsWith("letta"))!, new RegExp(`agent 'mergewright-demo' exists \\(${id}\\)`));
  assert.equal(mock.requests.filter((r) => r.method === "POST").length, 1, "the check never creates an agent");

  const dead = await deadUrl();
  const off = projectWith(lettaCfg(dead)).project;
  const out: string[] = [];
  await doctor((l = "") => out.push(l), off);
  assert.match(out.find((l) => l.startsWith("letta"))!, /^letta\s+NOT ok\s+NOT reachable/);
  const none: string[] = [];
  await doctor((l = "") => none.push(l), projectWith().project);
  assert.equal(none.find((l) => l.startsWith("letta")), undefined, "no package, no line");
});

test("letta: the old core setting memory.letta is refused by mw check, saying to run 'mw add letta'", () => {
  const dir = newProject();
  write(dir, "mergewright.yaml", `${fs.readFileSync(path.join(dir, "mergewright.yaml"), "utf8").trimEnd()}\nmemory:\n  letta:\n    url: http://127.0.0.1:1\n`);
  const r = mw(dir, ["check"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out + r.err, /'memory\.letta' is no longer read: Letta is now a package\. Run 'mw add letta'/);
});

/** Call MCP tools in process; returns each call's text and error flag. */
async function mcp(project: Project, calls: [string, object][]): Promise<{ text: string; isError: boolean }[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serve(project, { input, output, log: () => undefined });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  calls.forEach(([name, args], i) => input.write(`${JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } })}\n`));
  input.end();
  await done;
  const replies = String(output.read()).trim().split("\n").map((l) => JSON.parse(l) as { id: number; result?: { content: { text: string }[]; isError?: boolean } });
  return calls.map((_, i) => {
    const r = replies.find((x) => x.id === i + 1)!.result!;
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  });
}

test("MCP: mw_letta_add stores free text in the project agent's archive, mw_letta_search finds it, mw_memory_search labels letta's lessons", async () => {
  const mock = await lettaMock();
  after(() => mock.close());
  const { project } = projectWith(lettaCfg(mock.url));
  // One server per call: the server runs calls concurrently, and the search must follow the add.
  const [add] = await mcp(project, [["mw_letta_add", { text: "The test server runs Letta on port 8283.", tags: ["infra"] }]]);
  const [search, tagged, mem] = await mcp(project, [
    ["mw_letta_search", { query: "letta port", limit: 3 }],
    ["mw_letta_search", { query: "letta", tags: ["nothing-has-this"] }],
    ["mw_memory_search", { query: "letta" }],
  ]);
  assert.equal(add!.isError, false, add!.text);
  const added = JSON.parse(add!.text) as { id: string; text: string; tags: string[] }[];
  assert.equal(added[0]!.text, "The test server runs Letta on port 8283.");
  assert.deepEqual(added[0]!.tags, ["mergewright", "project:demo", "infra"]);
  assert.equal(search!.isError, false, search!.text);
  const hits = JSON.parse(search!.text) as { id: string; content: string; tags: string[] }[];
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.content, "The test server runs Letta on port 8283.");
  assert.deepEqual(JSON.parse(tagged!.text), []);
  const found = JSON.parse(mem!.text) as { mem0?: unknown; letta: unknown };
  assert.equal(found.mem0, undefined, "no mem0 package: no mem0 hits");
  assert.deepEqual(found.letta, ["The test server runs Letta on port 8283."]);
  assert.ok(![add, search, tagged, mem].some((r) => r!.text.includes(PASS)));
});

test("MCP: without the letta package there are no Letta tools; with Letta down they are clean errors", async () => {
  assert.deepEqual((await allTools(projectWith().project)).filter((t) => t.name.startsWith("mw_letta_")), []);
  const dead = await deadUrl();
  const [c, d] = await mcp(projectWith(lettaCfg(dead)).project, [["mw_letta_search", { query: "x" }], ["mw_memory_search", { query: "x" }]]);
  assert.equal(c!.isError, true);
  assert.match(c!.text, /Letta did not answer/);
  assert.match(JSON.parse(d!.text).letta, /^letta did not answer/);
});

// Live: a self-hosted Letta server. Runs only with MW_LIVE=1 and MW_LETTA_URL set. The password is
// read from ~/.config/mergewright/env (LETTA_SERVER_PASSWORD=...) into the process environment and
// never printed. Everything goes into a throwaway agent that the test deletes.
const LIVE_URL = process.env.MW_LETTA_URL ?? "";

test("live letta: probe, store a lesson, recall it, delete the agent", { skip: process.env.MW_LIVE !== "1" ? "set MW_LIVE=1 to run" : !LIVE_URL && "set MW_LETTA_URL to run", timeout: 300_000 }, async (t) => {
  const line = fs.readFileSync(path.join(os.homedir(), ".config", "mergewright", "env"), "utf8").split("\n").find((l) => l.startsWith("LETTA_SERVER_PASSWORD="));
  assert.ok(line, "LETTA_SERVER_PASSWORD not found in ~/.config/mergewright/env");
  process.env.MW_LIVE_LETTA_PASSWORD = line.slice("LETTA_SERVER_PASSWORD=".length).trim().replace(/^["']|["']$/g, "");
  const prefix = `mw-test-${Math.random().toString(36).slice(2, 10)}`;
  const { dir, project } = projectWith(lettaConfig({ url: LIVE_URL, agent: prefix, key_env: "MW_LIVE_LETTA_PASSWORD" }));
  const s = settingsOf(project.config.packages.letta, project.config.name);
  const headers = { authorization: `Bearer ${process.env.MW_LIVE_LETTA_PASSWORD}` };
  const agentId = async (): Promise<string | undefined> => {
    const r = await fetch(`${LIVE_URL.replace(/\/+$/, "")}/v1/agents/?name=${encodeURIComponent(agentName(s))}&limit=1`, { headers });
    return ((await r.json()) as { id: string; name: string }[]).find((a) => a.name === agentName(s))?.id;
  };
  try {
    const check = (await letta(project)).checks![0]!;
    t.diagnostic(`check: ${(await check.run()).ok ? "ok" : "NOT ok"}`);
    assert.equal(await agentId(), undefined);
    await integrationsFor(project).remember([{ topic: "testing", title: "Gate before merge", body: "Always run the project gate before merging a card branch.", card: "DEMO-1" }]);
    // REQ-engine-008: remember only queues; the flush delivers.
    assert.equal(queueItems(dir).length, 1, "remember queued one item");
    await flushQueue(project, { budgetMs: Infinity });
    assert.deepEqual(queueItems(dir), [], "the flush delivered (nothing left queued)");
    assert.ok(await agentId(), "the agent exists after first use");
    const hits = await integrationsFor(project).recall("run the gate before merging", 1);
    t.diagnostic(`recall returned ${hits.length} line(s)`);
    assert.equal(hits.length, 1);
    assert.match(hits[0]!, /^Gate before merge: Always run the project gate/);
  } finally {
    const id = await agentId();
    if (id) await fetch(`${LIVE_URL.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(id)}`, { method: "DELETE", headers });
    assert.equal(await agentId(), undefined, "the throwaway agent was deleted");
    delete process.env.MW_LIVE_LETTA_PASSWORD;
  }
});

test("letta: a configured embedding handle without an endpoint is sent as a handle; an endpoint makes it an explicit embedding_config", () => {
  const handle = settingsOf({ url: "http://127.0.0.1:1", model: "ollama/qwen3.5:9b", embedding: "ollama/qwen3-embedding:0.6b" }, "demo");
  assert.equal(handle.embeddingEndpoint, undefined, "the default endpoint goes with the default model only");
  assert.deepEqual(embeddingFields(handle), { embedding: "ollama/qwen3-embedding:0.6b" });
  const explicit = settingsOf({ url: "http://127.0.0.1:1", embedding: "bge-m3", embedding_endpoint: "http://embed:8080/v1", embedding_dim: 768 }, "demo");
  assert.deepEqual(embeddingFields(explicit), {
    embedding_config: { embedding_endpoint_type: "openai", embedding_endpoint: "http://embed:8080/v1", embedding_model: "bge-m3", embedding_dim: 768, embedding_chunk_size: 300 },
  });
});
