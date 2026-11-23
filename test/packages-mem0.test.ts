// The official mem0 package (packages/mem0), installed with `mw add mem0 --yes` and run against a fake
// mem0 server on loopback: recall, the reflect phase's queue, direct stores, search, prune, tools,
// the doctor check and the redaction of its key.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { flushQueue, integrationsFor, queueFor } from "../src/integrations.ts";
import { lessonId } from "../src/integrations/common.ts";
import { callTool } from "../src/mcpserver/server.ts";
import { loadPackages } from "../src/packages/loader.ts";
import { Project } from "../src/project.ts";
import { spawn } from "node:child_process";
import { MW, mw, newProject, read, write } from "./helpers.ts";
import { deadUrl, mockServer, queueItems, type Recorded } from "./fixtures/integrations/support.ts";

const KEY = "mem0-package-test-key-not-a-secret";
process.env.MW_TEST_MEM0_PKG_KEY = KEY;

/** `mw` as a child process that does not block this one (the fake server answers from here). */
function mwAsync(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, MW_ENV_FILE: "/dev/null" };
    delete env.MW_ROLE;
    const p = spawn(process.execPath, [MW, ...args], { cwd, env });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

interface Memory { id: string; memory: string; user_id: string; metadata: Record<string, unknown> }

/** A fake mem0: POST /memories, GET /memories?user_id, POST /search (honours a lesson_id filter), DELETE /memories/{id}. */
async function mem0Mock(opts: { failWrite?: (n: number) => boolean } = {}) {
  const store: Memory[] = [];
  let writes = 0;
  const mock = await mockServer((r: Recorded) => {
    if (r.headers["x-api-key"] !== KEY) return { status: 401, body: { detail: "bad key" } };
    const b = r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r.method === "POST" && r.url === "/memories") {
      if (opts.failWrite?.(++writes)) return { status: 503, body: { detail: "busy" } };
      if (b.infer) return { body: { results: [] } }; // the model extracted nothing
      const m = { id: `m${store.length + 1}`, memory: b.messages[0].content, user_id: b.user_id, metadata: b.metadata };
      store.push(m);
      return { body: { results: [{ id: m.id, memory: m.memory, event: "ADD" }] } };
    }
    if (r.method === "GET" && r.url.startsWith("/memories?")) return { body: { results: store.filter((m) => m.user_id === new URL(r.url, "http://x").searchParams.get("user_id")) } };
    if (r.method === "POST" && r.url === "/search") {
      const hits = store.filter((m) => m.user_id === b.filters.user_id && (b.filters.lesson_id === undefined || m.metadata.lesson_id === b.filters.lesson_id) && b.query.split(" ").some((w: string) => m.memory.includes(w)));
      return { body: { results: hits.slice(0, b.top_k).map((m) => ({ ...m, score: 0.5 })) } };
    }
    if (r.method === "DELETE" && r.url.startsWith("/memories/")) {
      const id = decodeURIComponent(r.url.slice("/memories/".length));
      store.splice(store.findIndex((m) => m.id === id), 1);
      return { body: { message: "deleted" } };
    }
    return undefined;
  });
  after(() => mock.close());
  return { ...mock, store };
}

/** A project with the mem0 package installed by `mw add mem0 --yes` and pointed at `url`. */
function mem0Project(url: string, extra = ""): { dir: string; project: () => Project } {
  const dir = newProject();
  const r = mw(dir, ["add", "mem0", "--yes"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /source: +official package, embedded in this runtime/);
  assert.match(r.out, /next: give its settings \(packages\.mem0: .*'url'/, "the url is required, and mw add says so");
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace("  mem0: {}", `  mem0: { url: ${JSON.stringify(url)}, key_env: MW_TEST_MEM0_PKG_KEY${extra} }`));
  const project = () => new Project(dir);
  assert.deepEqual(project().diag.errors.map((e) => e.message), []);
  return { dir, project };
}

const lesson = (title: string, body = `body of ${title}`) => ({ topic: "t", title, body });

test("mem0 package: remember queues one held item, the flush stores each lesson as written with its metadata, recall gives 'title: text'", async () => {
  const mock = await mem0Mock();
  const { dir, project } = mem0Project(mock.url);
  const i = integrationsFor(project());
  await i.remember([{ topic: "testing", title: "Run the gate first", body: "Always run the gate\nbefore merging.\n\nSecond paragraph.", card: "DEMO-3" }, { topic: "git", title: "Squash", body: "Squash merges keep history flat." }]);
  assert.equal(mock.requests.length, 0, "remember sends nothing");
  assert.deepEqual(queueItems(dir).map((x) => [x.kind, x.holdPid, x.summary]), [["mem0", process.pid, "mem0: 2 lesson(s): Run the gate first; Squash"]]);
  assert.deepEqual((await flushQueue(project())).map((r) => r.ok), [true]);
  const posts = mock.requests.filter((r) => r.method === "POST" && r.url === "/memories");
  assert.deepEqual(posts[0]!.body, {
    messages: [{ role: "user", content: "Always run the gate\nbefore merging.\n\nSecond paragraph." }],
    user_id: "demo",
    infer: false,
    metadata: { topic: "testing", title: "Run the gate first", card: "DEMO-3", project: "demo", lesson_id: lessonId("demo", { topic: "testing", title: "Run the gate first" }) },
  });
  assert.equal(posts.length, 2);
  assert.deepEqual(await i.recall("gate", 5), ["Run the gate first: Always run the gate before merging."]);
  assert.deepEqual(mock.requests.find((r) => r.url === "/search")!.body, { query: "gate", filters: { user_id: "demo" }, top_k: 5 });
  assert.deepEqual(queueItems(dir), []);
});

test("mem0 package: unreachable, recall is [] and the lessons stay queued; once it answers the flush delivers them", async () => {
  const dead = await deadUrl();
  const { dir, project } = mem0Project(dead, ", user: team");
  const i = integrationsFor(project());
  assert.deepEqual(await i.recall("x", 3), []);
  await i.remember([lesson("One"), lesson("Two")]);
  await flushQueue(project());
  assert.equal(queueItems(dir).length, 1, "kept after a failed delivery");
  const mock = await mem0Mock();
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace(dead, mock.url));
  assert.deepEqual((await flushQueue(project())).map((r) => r.ok), [true]);
  assert.deepEqual(mock.store.map((m) => [m.user_id, m.memory]), [["team", "body of One"], ["team", "body of Two"]]);
  assert.deepEqual(queueItems(dir), []);
});

test("mem0 package: a delivery failing part-way keeps only the lessons not yet stored; a record already present is skipped", async () => {
  const mock = await mem0Mock({ failWrite: (n) => n === 2 });
  const { dir, project } = mem0Project(mock.url);
  queueFor(project()).add("mem0", "mem0: 3", { lessons: [lesson("L1"), lesson("L2"), lesson("L3")] });
  await flushQueue(project());
  const items = queueItems(dir);
  assert.deepEqual((items[0]!.payload as { lessons: { title: string }[] }).lessons.map((l) => l.title), ["L2", "L3"]);
  assert.match(items[0]!.lastError ?? "", /HTTP 503/);
  // L1 is in the store; a new item holding it again delivers only the others.
  queueFor(project()).add("mem0", "again", { lessons: [lesson("L1")] });
  const r = await flushQueue(project());
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  assert.deepEqual(mock.store.map((m) => m.memory).sort(), ["body of L1", "body of L2", "body of L3"]);
});

test("mem0 package: mw memory add stores at once and says so; mw memory push is idempotent; mw memory search labels its hits", async () => {
  const mock = await mem0Mock();
  const { dir } = mem0Project(mock.url);
  const add = await mwAsync(dir, ["memory", "add", "lesson", "--topic", "testing", "--title", "Gate first", "--body", "Run the gate before merging."]);
  assert.equal(add.code, 0, add.err);
  assert.match(add.out, /stored in mem0/);
  const push = await mwAsync(dir, ["memory", "push", "--service", "mem0"]);
  assert.equal(push.code, 0, push.err);
  assert.match(push.out, /mem0: 0 stored, 1 already present, 0 queued, 0 failed/);
  assert.equal(mock.store.length, 1);
  const search = await mwAsync(dir, ["memory", "search", "gate"]);
  assert.match(search.out, /^mem0: Gate first: Run the gate before merging\.$/m);
});

test("mem0 package: mw memory prune --service mem0 deletes the records that contain the text (or shows them with --dry-run)", async () => {
  const mock = await mem0Mock();
  const { dir, project } = mem0Project(mock.url);
  queueFor(project()).add("mem0", "x", { lessons: [lesson("Keep", "real lesson"), lesson("Junk", "leftover of a test run")] });
  await flushQueue(project());
  const dry = await mwAsync(dir, ["memory", "prune", "--service", "mem0", "--match", "leftover", "--dry-run"]);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /would delete m2: Junk: leftover of a test run/);
  assert.equal(mock.store.length, 2);
  const del = await mwAsync(dir, ["memory", "prune", "--service", "mem0", "--match", "leftover"]);
  assert.match(del.out, /1 record\(s\) containing 'leftover' deleted from mem0 \(demo\)/);
  assert.deepEqual(mock.store.map((m) => m.memory), ["real lesson"]);
});

test("mem0 package: its tools store verbatim by default, say when an inference stored nothing, and search", async () => {
  const mock = await mem0Mock();
  const { project } = mem0Project(mock.url);
  const [l] = await loadPackages(project());
  const tool = (name: string) => l!.exports!.tools!.find((t) => t.name === name)!;
  const stored = (await tool("mw_mem0_add").handler({ text: "The gate runs in CI." }, {})) as { memory: string }[];
  assert.equal(stored[0]!.memory, "The gate runs in CI.");
  assert.equal(await tool("mw_mem0_add").handler({ text: "Something vague.", infer: true }, {}), "mem0 extracted no facts from the text (infer=true); nothing stored");
  const hits = (await tool("mw_mem0_search").handler({ query: "gate" }, {})) as { id: string; memory: string }[];
  assert.deepEqual(hits.map((h) => [h.id, h.memory]), [["m1", "The gate runs in CI."]]);
});

test("mem0 package: mw doctor runs its check without printing the key, and tool output redacts the key's value", async () => {
  const mock = await mem0Mock();
  const { dir } = mem0Project(mock.url);
  const doctor = await mwAsync(dir, ["doctor"]);
  assert.match(doctor.out, /^mem0 +ok  reachable, http:\/\/127\.0\.0\.1:\d+\/ namespace 'demo', MW_TEST_MEM0_PKG_KEY set \(package mem0\)$/m);
  assert.ok(!doctor.out.includes(KEY));
  const echo = { name: "mw_test_echo", description: "test", inputSchema: { type: "object" }, handler: () => `key is ${KEY}` };
  const r = await callTool(echo, {}, { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => {} });
  assert.equal(r.content[0]!.text, "key is [redacted]");
  assert.ok(fs.existsSync(path.join(dir, ".mergewright", "packages", "mem0", "index.mjs")));
});

test("memory.mem0 (mem0 in the core, before the package) is refused by mw check with what to do instead", () => {
  const dir = newProject();
  write(dir, "mergewright.yaml", `${read(dir, "mergewright.yaml")}\nmemory:\n  mem0: { url: "http://127.0.0.1:9", key_env: MEM0_API_KEY }\n`);
  const r = mw(dir, ["check"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /memory\.mem0.*is no longer read: mem0 is now a package\. Run 'mw add mem0', move these settings \(url, user, key_env, write_timeout_ms\) to packages\.mem0/);
  assert.doesNotMatch(r.out, /unknown field 'mem0'/);
});

test("mem0 package: its key variable is among the credentials a run folder redacts (keyEnvNames)", async () => {
  const { keyEnvNames } = await import("../src/engine/redact.ts");
  const { project } = mem0Project("http://127.0.0.1:9");
  assert.ok(keyEnvNames(project()).includes("MW_TEST_MEM0_PKG_KEY"));
  assert.ok(!keyEnvNames(new Project(newProject())).includes("MEM0_API_KEY"), "not without the package");
});
