// Integrations against local mocks: mem0, Open Notebook (the open-notebook package), the usage guard, the kanban mirror, forges.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { flushQueue, integrationsFor } from "../src/integrations.ts";
import { lessonId } from "../src/integrations/common.ts";
import { Queue } from "../src/integrations/queue.ts";
import { localDir } from "../src/project.ts";
import { MwError } from "../src/util.ts";
import { git, kanbanConfig, mem0Config, notebookConfig, tmpDir, write } from "./helpers.ts";
import { deadUrl, installFake, mockServer, projectWith, q, queueItems, type Recorded } from "./fixtures/integrations/support.ts";

const KEY = "test-key-not-a-secret";
process.env.MW_TEST_MEM0_KEY = KEY;

// ── mem0 ────────────────────────────────────────────────────────────────────────────────────

function mem0Mock() {
  const store: { id: string; memory: string; user_id: string; metadata: Record<string, unknown> }[] = [];
  return mockServer((r: Recorded) => {
    if (r.headers["x-api-key"] !== KEY) return { status: 401, body: { detail: "bad key" } };
    const b = r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r.method === "POST" && r.url === "/memories") {
      if (b.infer !== false) return { status: 400, body: { detail: "test expects infer:false" } };
      const m = { id: `m${store.length + 1}`, memory: b.messages[0].content, user_id: b.user_id, metadata: b.metadata };
      store.push(m);
      return { body: { results: [{ id: m.id, memory: m.memory, event: "ADD", actor_id: null, role: "user" }] } };
    }
    // Listing (queue replay checks each lesson first): GET /memories?user_id=U
    if (r.method === "GET" && r.url.startsWith("/memories?")) return { body: { results: store.filter((m) => m.user_id === new URL(r.url, "http://x").searchParams.get("user_id")) } };
    if (r.method === "POST" && r.url === "/search") {
      const hits = store.filter((m) => m.user_id === b.filters.user_id && (b.filters.lesson_id === undefined || m.metadata.lesson_id === b.filters.lesson_id) && b.query.split(" ").some((w: string) => m.memory.includes(w)));
      return { body: { results: hits.slice(0, b.top_k).map((m) => ({ ...m, score: 0.5 })) } };
    }
    return undefined;
  });
}

test("mem0: remember queues the lessons (REQ-engine-008) and the flush stores each as written with metadata; recall returns 'title: text' lines", async () => {
  const mock = await mem0Mock();
  after(() => mock.close());
  const { dir, project } = projectWith(mem0Config({ url: mock.url, key_env: "MW_TEST_MEM0_KEY" }));
  const i = integrationsFor(project);
  await i.remember([
    { topic: "testing", title: "Run the gate first", body: "Always run the gate\nbefore merging.\n\nSecond paragraph.", card: "DEMO-3" },
    { topic: "git", title: "Squash", body: "Squash merges keep history flat." },
  ]);
  assert.equal(mock.requests.length, 0, "remember sends nothing");
  assert.deepEqual(queueItems(dir).map((x) => [x.kind, x.holdPid]), [["mem0", process.pid]], "one mem0 item, held for this process until its flush");
  assert.deepEqual((await flushQueue(project)).map((r) => r.ok), [true]);
  const posts = mock.requests.filter((r) => r.url === "/memories");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0]!.body, {
    messages: [{ role: "user", content: "Always run the gate\nbefore merging.\n\nSecond paragraph." }],
    user_id: "demo", // namespace defaults to the project name
    infer: false,
    metadata: { topic: "testing", title: "Run the gate first", card: "DEMO-3", project: "demo", lesson_id: lessonId("demo", { topic: "testing", title: "Run the gate first" }) },
  });
  assert.deepEqual((posts[1]!.body as { metadata: object }).metadata, { topic: "git", title: "Squash", project: "demo", lesson_id: lessonId("demo", { topic: "git", title: "Squash" }) });
  assert.deepEqual(await i.recall("gate", 5), ["Run the gate first: Always run the gate before merging."]);
  const search = mock.requests.find((r) => r.url === "/search")!;
  assert.deepEqual(search.body, { query: "gate", filters: { user_id: "demo" }, top_k: 5 });
  assert.deepEqual(queueItems(dir), []);
});

test("mem0 unreachable: recall returns [] and remember queues the lessons; flush delivers them", async () => {
  const dead = await deadUrl();
  const { dir, project } = projectWith(mem0Config({ url: dead, user: "team", key_env: "MW_TEST_MEM0_KEY" }));
  const i = integrationsFor(project);
  assert.deepEqual(await i.recall("x", 3), []);
  await i.remember([{ topic: "t", title: "One", body: "b1" }, { topic: "t", title: "Two", body: "b2" }]);
  const items = queueItems(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "mem0");
  assert.match(items[0]!.summary, /mem0: 2 lesson\(s\): One; Two/);

  const mock = await mem0Mock();
  after(() => mock.close());
  const cfg = path.join(dir, "mergewright.yaml");
  fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace(dead, mock.url));
  const { Project } = await import("../src/project.ts");
  const results = await flushQueue(new Project(dir));
  assert.deepEqual(results.map((r) => r.ok), [true]);
  assert.equal(mock.requests.filter((r) => r.url === "/memories").length, 2);
  assert.deepEqual(queueItems(dir), []);
});

test("mem0 failing part-way keeps only the lessons not yet stored queued", async () => {
  let n = 0;
  const mock = await mockServer((r) => (r.method === "POST" && r.url === "/memories" && ++n === 2 ? { status: 503, body: { detail: "busy" } } : { body: { results: [] } }));
  after(() => mock.close());
  const { dir, project } = projectWith(mem0Config({ url: mock.url, key_env: "MW_TEST_MEM0_KEY" }));
  await integrationsFor(project).remember([1, 2, 3].map((k) => ({ topic: "t", title: `L${k}`, body: `b${k}` })));
  await flushQueue(project);
  const items = queueItems(dir);
  assert.equal(items.length, 1);
  assert.deepEqual((items[0]!.payload as { lessons: { title: string }[] }).lessons.map((l) => l.title), ["L2", "L3"]);
  assert.match(items[0]!.lastError ?? "", /HTTP 503/);
});

test("lesson ids are SHA-256 of project, topic and title: stable, and different when any of them differs", () => {
  const id = lessonId("demo", { topic: "git", title: "Squash" });
  assert.equal(id, createHash("sha256").update("demo\0git\0Squash").digest("hex"));
  assert.equal(lessonId("demo", { topic: "git", title: "Squash" }), id);
  assert.notEqual(lessonId("other", { topic: "git", title: "Squash" }), id);
  assert.notEqual(lessonId("demo", { topic: "gi", title: "tSquash" }), id);
});

test("queue replay: a partly delivered mem0 item keeps only what remains, so no lesson is stored twice", async () => {
  let failSecond = true;
  const posted: string[] = [];
  const mock = await mockServer((r) => {
    // Queue replay checks each lesson first: an empty listing and no search hits.
    if (r.method === "GET" && r.url.startsWith("/memories?")) return { body: { results: [] } };
    if (r.url === "/search") return { body: { results: [] } };
    if (r.url !== "/memories") return undefined;
    const title = (r.body as { metadata: { title: string } }).metadata.title;
    if (title === "B" && failSecond) return { status: 503, body: { detail: "busy" } };
    posted.push(title);
    return { body: { results: [] } };
  });
  after(() => mock.close());
  const { dir, project } = projectWith(mem0Config({ url: mock.url, key_env: "MW_TEST_MEM0_KEY" }));
  new Queue(localDir(project)).add("mem0", "mem0 (demo): 3 lesson(s): A; B; C", { lessons: ["A", "B", "C"].map((t) => ({ topic: "t", title: t, body: t })) });
  assert.deepEqual((await flushQueue(project)).map((r) => r.ok), [false]);
  const items = queueItems(dir);
  assert.equal(items.length, 1);
  assert.deepEqual((items[0]!.payload as { lessons: { title: string }[] }).lessons.map((l) => l.title), ["B", "C"]);
  assert.match(items[0]!.summary, /2 lesson\(s\): B; C/);
  assert.equal(items[0]!.attempts, 1);
  failSecond = false;
  assert.deepEqual((await flushQueue(project)).map((r) => r.ok), [true]);
  assert.deepEqual(posted, ["A", "B", "C"], "A was stored once");
  assert.deepEqual(queueItems(dir), []);
});

test("queue claims: an item being delivered is invisible to a second flush; a failed one is put back", async () => {
  const { dir, project } = projectWith();
  const qu = new Queue(localDir(project));
  qu.add("x", "one", { n: 1 });
  const qdir = path.join(dir, ".mergewright", "local", "queue");
  let deliveries = 0;
  let during: string[] = [];
  let second: unknown[] = [];
  const results = await qu.flush({
    x: async () => {
      deliveries++;
      during = fs.readdirSync(qdir);
      // A concurrent flush (another process of this machine) finds nothing to deliver.
      second = await new Queue(localDir(project)).flush({ x: async () => { deliveries++; } });
      throw new Error("service down");
    },
  });
  assert.equal(deliveries, 1);
  assert.deepEqual(second, []);
  assert.equal(during.length, 1);
  assert.match(during[0]!, new RegExp(`\\.json\\.claimed-${process.pid}$`));
  assert.deepEqual(results.map((r) => r.ok), [false]);
  const left = fs.readdirSync(qdir);
  assert.equal(left.length, 1);
  assert.match(left[0]!, /\.json$/, "renamed back after the failure");
  assert.equal(queueItems(dir)[0]!.attempts, 1);
});

test("queue claims: a claim older than ten minutes is released and delivered; a recent one is left alone", async () => {
  const { dir, project } = projectWith();
  const qu = new Queue(localDir(project));
  const stale = qu.add("x", "stale", { n: 1 });
  const fresh = qu.add("x", "fresh", { n: 2 });
  fs.renameSync(stale, `${stale}.claimed-999999`);
  const old = new Date(Date.now() - 11 * 60_000);
  fs.utimesSync(`${stale}.claimed-999999`, old, old);
  fs.renameSync(fresh, `${fresh}.claimed-999998`);
  const seen: number[] = [];
  const results = await qu.flush({ x: async (p) => { seen.push((p as { n: number }).n); } });
  assert.deepEqual(seen, [1]);
  assert.deepEqual(results.map((r) => [r.summary, r.ok]), [["stale", true]]);
  assert.deepEqual(fs.readdirSync(path.join(dir, ".mergewright", "local", "queue")), [`${path.basename(fresh)}.claimed-999998`]);
  assert.deepEqual(qu.list(), [], "a claimed item is not listed as waiting");
});

// ── Open Notebook ───────────────────────────────────────────────────────────────────────────

/** Commit everything (documentation is read from commits, never from the working tree). Returns the commit. */
function commitDocs(dir: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "docs");
  return git(dir, "rev-parse", "HEAD");
}

function notebookMock(password: string) {
  const notebooks: { id: string; name: string }[] = [];
  const sources: { id: string; title: string; content: string; notebooks: string[] }[] = [];
  let next = 1;
  const mock = mockServer((r) => {
    if (r.headers.authorization !== `Bearer ${password}`) return { status: 401, body: { detail: "Missing authorization" } };
    const u = new URL(r.url, "http://x");
    if (u.pathname === "/api/notebooks" && r.method === "GET") return { body: notebooks.map((n) => ({ ...n, description: "", archived: false, created: "", updated: "", source_count: 0, note_count: 0 })) };
    if (u.pathname === "/api/notebooks" && r.method === "POST") {
      const n = { id: `notebook:${next++}`, name: (r.body as { name: string }).name };
      notebooks.push(n);
      return { body: n };
    }
    if (u.pathname === "/api/sources" && r.method === "GET") {
      const nb = u.searchParams.get("notebook_id")!;
      const limit = Number(u.searchParams.get("limit"));
      const offset = Number(u.searchParams.get("offset"));
      if (limit > 100) return { status: 422, body: { detail: "limit" } };
      return { body: sources.filter((s) => s.notebooks.includes(nb)).slice(offset, offset + limit).map((s) => ({ id: s.id, title: s.title, embedded: false, embedded_chunks: 0, insights_count: 0, created: "", updated: "" })) };
    }
    if (u.pathname === "/api/sources/json" && r.method === "POST") {
      const b = r.body as { type: string; title: string; content: string; notebooks: string[] };
      if (b.type !== "text") return { status: 400, body: { detail: "type" } };
      const s = { id: `source:${next++}`, title: b.title, content: b.content, notebooks: b.notebooks };
      sources.push(s);
      return { body: { id: s.id, title: s.title } };
    }
    const del = /^\/api\/sources\/(.+)$/.exec(u.pathname);
    if (del && r.method === "DELETE") {
      const id = decodeURIComponent(del[1]!);
      const k = sources.findIndex((s) => s.id === id);
      if (k < 0) return { status: 404, body: { detail: "Source not found" } };
      sources.splice(k, 1);
      return { body: { message: "Source deleted successfully" } };
    }
    return undefined;
  });
  return { mock, notebooks, sources };
}

test("docsSync creates the notebook once, replaces changed files' sources and removes deleted ones", async () => {
  process.env.MW_TEST_NB_PASSWORD = "pw";
  const nb = notebookMock("pw");
  const mock = await nb.mock;
  after(() => mock.close());
  const { dir, project } = projectWith(notebookConfig({ url: mock.url, key_env: "MW_TEST_NB_PASSWORD" }));
  write(dir, "docs/a.md", "A v1");
  write(dir, "docs/b.md", "B v1");
  commitDocs(dir);
  const i = integrationsFor(project);
  await i.docsSync(["docs/a.md", "docs/b.md"], []);
  assert.deepEqual(nb.notebooks.map((n) => n.name), ["demo"]);
  assert.deepEqual(nb.sources.map((s) => [s.title, s.content]), [["docs/a.md", "A v1"], ["docs/b.md", "B v1"]]);
  const add = mock.requests.find((r) => r.url === "/api/sources/json")!;
  assert.deepEqual(add.body, { type: "text", notebooks: ["notebook:1"], title: "docs/a.md", content: "A v1", embed: true, async_processing: true });

  write(dir, "docs/a.md", "A v2");
  fs.rmSync(path.join(dir, "docs/b.md"));
  commitDocs(dir);
  await i.docsSync(["docs/a.md"], ["docs/b.md"]);
  assert.equal(nb.notebooks.length, 1, "notebook reused");
  assert.deepEqual(nb.sources.map((s) => [s.title, s.content]), [["docs/a.md", "A v2"]]);
  assert.deepEqual(queueItems(dir), []);
});

test("docsSync with the service down queues the batch with its commit; the flush sends what that commit held", async () => {
  const dead = await deadUrl();
  process.env.MW_TEST_NB_PASSWORD = "pw";
  const { dir, project } = projectWith(notebookConfig({ url: dead, name: "Handbook", key_env: "MW_TEST_NB_PASSWORD" }));
  write(dir, "docs/a.md", "old");
  const commit = commitDocs(dir);
  await integrationsFor(project).docsSync(["docs/a.md"], ["docs/gone.md"]);
  const items = queueItems(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "open-notebook");
  assert.deepEqual(items[0]!.payload, { changed: ["docs/a.md"], deleted: ["docs/gone.md"], commit });
  write(dir, "docs/a.md", "newer, not committed");

  const nb = notebookMock("pw");
  const mock = await nb.mock;
  after(() => mock.close());
  const cfg = path.join(dir, "mergewright.yaml");
  fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace(dead, mock.url));
  const { Project } = await import("../src/project.ts");
  assert.deepEqual((await flushQueue(new Project(dir))).map((r) => r.ok), [true]);
  assert.deepEqual(nb.notebooks.map((n) => n.name), ["Handbook"]);
  assert.deepEqual(nb.sources.map((s) => [s.title, s.content]), [["docs/a.md", "old"]]);
});

test("docsSync with a wrong password queues instead of throwing", async () => {
  process.env.MW_TEST_NB_PASSWORD = "wrong";
  const nb = notebookMock("pw");
  const mock = await nb.mock;
  after(() => mock.close());
  const { dir, project } = projectWith(notebookConfig({ url: `${mock.url}/api/`, key_env: "MW_TEST_NB_PASSWORD" }));
  await integrationsFor(project).docsSync(["README.md"], []);
  assert.match(queueItems(dir)[0]!.lastError ?? "", /HTTP 401/);
  assert.ok(mock.requests.every((r) => r.url.startsWith("/api/notebooks")), "a /api suffix in the url is not doubled");
});

// ── usage guard ─────────────────────────────────────────────────────────────────────────────

test("usageOk pauses at the threshold, stays paused until below the resume level, and accepts fractions", async () => {
  const cmd = `${q(process.execPath)} -e "process.stdout.write(process.env.FAKE_USAGE)"`;
  const { dir, project } = projectWith({ usage: { command: cmd } });
  const i = integrationsFor(project);
  const flag = path.join(dir, ".mergewright", "local", "usage-paused");
  const at = async (json: string) => { process.env.FAKE_USAGE = json; return i.usageOk(); };

  assert.equal((await at(`{"max_used": 50, "windows": []}`)).ok, true);
  const paused = await at(`{"max_used": 85, "windows": [{"label": "5h", "used": 85}]}`);
  assert.equal(paused.ok, false);
  assert.match(paused.detail, /85%/);
  assert.ok(fs.existsSync(flag));
  assert.equal((await at(`{"max_used": 82}`)).ok, false, "hysteresis: still paused at 82");
  const resumed = await at(`{"max_used": 79.5}`);
  assert.equal(resumed.ok, true);
  assert.match(resumed.detail, /resumed/);
  assert.ok(!fs.existsSync(flag));
  assert.equal((await at(`{"max_used": 82}`)).ok, true, "82 is fine when not paused");
  assert.equal((await at(`{"max_used": 0.9}`)).ok, false, "0.9 is a fraction: 90%");
  // Paused by the 0.9 reading: a failed reading keeps the pause (REQ-usage-003).
  const unknown = await at(`{"max_used": null, "windows": [], "error": "hermes venv not found"}`);
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /usage reading failed.*hermes venv not found/);
  assert.equal((await at(`not json`)).ok, false);
  assert.ok(fs.existsSync(flag));
});

test("usageOk with custom thresholds, and a missing command, never blocks", async () => {
  const cmd = `${q(process.execPath)} -e "process.stdout.write(process.env.FAKE_USAGE)"`;
  const { project } = projectWith({ usage: { command: cmd, pause_at_pct: 60, resume_below_pct: 40 } });
  process.env.FAKE_USAGE = `{"max_used": 61}`;
  assert.equal((await integrationsFor(project).usageOk()).ok, false);
  process.env.FAKE_USAGE = `{"max_used": 45}`;
  assert.equal((await integrationsFor(project).usageOk()).ok, false);
  process.env.FAKE_USAGE = `{"max_used": 39}`;
  assert.equal((await integrationsFor(project).usageOk()).ok, true);

  const missing = projectWith({ usage: { command: "no-such-usage-command-xyz --json" } }).project;
  const r = await integrationsFor(missing).usageOk();
  assert.equal(r.ok, true);
  assert.match(r.detail, /usage guard could not run: .*exited 127/);
});

// ── kanban mirror ───────────────────────────────────────────────────────────────────────────

test("mirrorCard creates the card once, does not queue moves the CLI cannot make, and trashes it when done", async () => {
  const fake = installFake("kanban", "fake-kanban.mjs");
  after(fake.restore);
  const state = path.join(tmpDir(), "kanban.json");
  process.env.FAKE_KANBAN_STATE = state;
  process.env.FAKE_KANBAN_DOWN = "0";
  const read = () => JSON.parse(fs.readFileSync(state, "utf8")) as { tasks: { id: string; title: string; prompt: string; column: string }[]; calls: string[][] };
  const { dir, project } = projectWith(kanbanConfig());
  const i = integrationsFor(project);

  await i.mirrorCard("DEMO-1", "Sign in", "todo");
  await i.mirrorCard("DEMO-1", "Sign in", "ready");
  assert.deepEqual(read().tasks.map((t) => [t.title, t.column]), [["[DEMO-1] Sign in", "backlog"]]);
  assert.ok(read().tasks[0]!.prompt.startsWith("[DEMO-1] "), "the prompt carries the prefix: list output has no title");
  assert.ok(read().calls.every((c) => c.includes("--project-path") && c[c.indexOf("--project-path") + 1] === dir));
  assert.deepEqual(queueItems(dir), []);

  // A column only an agent session reaches is not queued (it would be retried forever).
  const n1 = await i.mirrorCard("DEMO-1", "Sign in", "in_progress");
  const n2 = await i.mirrorCard("DEMO-1", "Sign in", "review");
  assert.match(String(n1), /only a Kanban agent session/);
  assert.equal(n1, n2, "one note per run, whatever the column");
  assert.deepEqual(queueItems(dir), []);
  assert.ok(!read().calls.some((c) => c[1] === "start"), "never launches an agent session");

  // Once a session moved it, a later status that the CLI can show is shown as usual.
  const s = read();
  s.tasks[0]!.column = "review";
  fs.writeFileSync(state, JSON.stringify(s));
  assert.equal(await i.mirrorCard("DEMO-1", "Sign in", "review"), undefined);
  assert.deepEqual(queueItems(dir), []);

  await i.mirrorCard("DEMO-1", "Sign in", "done");
  assert.deepEqual(read().tasks.map((t) => t.column), ["trash"]);
  await i.mirrorCard("DEMO-1", "Sign in", "done");
  assert.equal(read().calls.filter((c) => c[1] === "trash").length, 1, "idempotent");
  assert.equal(read().tasks.length, 1);
  assert.deepEqual(queueItems(dir), []);
});

test("mirrorCard with no Kanban runtime queues nothing and returns the skip note; without the CLI it is a no-op", async () => {
  const fake = installFake("kanban", "fake-kanban.mjs");
  process.env.FAKE_KANBAN_STATE = path.join(tmpDir(), "kanban.json");
  process.env.FAKE_KANBAN_DOWN = "1";
  const { dir, project } = projectWith(kanbanConfig());
  const note = await integrationsFor(project).mirrorCard("DEMO-2", "Thing", "todo");
  assert.match(String(note), /^kanban: mirror skipped on \S+ \(board not reachable here\); the board machine reconciles$/);
  assert.deepEqual(queueItems(dir), []);
  process.env.FAKE_KANBAN_DOWN = "0";
  assert.equal(await integrationsFor(project).mirrorCard("DEMO-2", "Thing", "todo"), undefined);
  assert.deepEqual(queueItems(dir), []);
  fake.restore();

  const other = projectWith(kanbanConfig());
  const before = process.env.PATH;
  process.env.PATH = tmpDir("mw-empty-path-");
  try {
    await integrationsFor(other.project).mirrorCard("DEMO-3", "x", "todo");
    assert.deepEqual(queueItems(other.dir), []);
  } finally {
    process.env.PATH = before;
  }
});

// ── forges ──────────────────────────────────────────────────────────────────────────────────

const REQ = { card: "DEMO-4", branch: "card/DEMO-4", base: "main", title: "DEMO-4: Sign in", body: "Summary" };
process.env.MW_TEST_FORGE_TOKEN = "tok";

interface GiteaOpts {
  existing?: boolean;
  mergeable?: boolean;
  mergeStatus?: number;
  /** The merge happens, but the answer is this status (a lost or garbled answer). */
  mergeThenFail?: number;
  /** The forge answers the merge with 200 but never reports the pull request as merged. */
  neverMerged?: boolean;
  /** Called when the merge is requested. */
  onMerge?: () => void;
}

function giteaMock(opts: GiteaOpts = {}) {
  let merged = false;
  let created = !!opts.existing;
  // Like Gitea: the list of open pull requests no longer shows a merged one.
  const pr = () => ({ number: 7, head: { ref: "card/DEMO-4" }, base: { ref: "main" }, mergeable: opts.mergeable ?? true, state: merged ? "closed" : "open", merged, merge_commit_sha: merged || opts.neverMerged ? "abc123" : null });
  return mockServer((r) => {
    if (r.headers.authorization !== "token tok") return { status: 401, body: { message: "token" } };
    const p = "/api/v1/repos/me/demo";
    if (r.method === "GET" && r.url.startsWith(`${p}/pulls?`)) return { body: created && !merged ? [{ number: 3, head: { ref: "other" }, base: { ref: "main" } }, pr()] : [] };
    if (r.method === "POST" && r.url === `${p}/pulls`) { created = true; return { status: 201, body: pr() }; }
    if (r.method === "GET" && r.url === `${p}/pulls/7`) return { body: pr() };
    if (r.method === "POST" && r.url === `${p}/pulls/7/merge`) {
      opts.onMerge?.();
      if (opts.mergeStatus) return { status: opts.mergeStatus, body: { message: "nope" } };
      if (!opts.neverMerged) merged = true;
      if (opts.mergeThenFail) return { status: opts.mergeThenFail, body: { message: "proxy error" } };
      return { status: 200 };
    }
    return undefined;
  });
}

test("forgeMerge (gitea) opens a pull request, squash-merges it and returns the merge commit", async () => {
  const mock = await giteaMock();
  after(() => mock.close());
  const { project } = projectWith({ git: { forge: { kind: "gitea", url: mock.url, repo: "me/demo", token_env: "MW_TEST_FORGE_TOKEN" } } });
  assert.equal(await integrationsFor(project).forgeMerge(REQ), "abc123");
  const create = mock.requests.find((r) => r.method === "POST" && r.url.endsWith("/pulls"))!;
  assert.deepEqual(create.body, { title: REQ.title, body: REQ.body, head: REQ.branch, base: "main" });
  const merge = mock.requests.find((r) => r.url.endsWith("/merge"))!;
  assert.deepEqual(merge.body, { Do: "squash", MergeTitleField: REQ.title, MergeMessageField: REQ.body });
});

test("forgeMerge (gitea) reuses an open pull request and maps conflicts and failures", async () => {
  const reuse = await giteaMock({ existing: true });
  after(() => reuse.close());
  const cfg = (url: string) => projectWith({ git: { forge: { kind: "gitea", url, repo: "me/demo", token_env: "MW_TEST_FORGE_TOKEN" } } }).project;
  assert.equal(await integrationsFor(cfg(reuse.url)).forgeMerge(REQ), "abc123");
  assert.ok(!reuse.requests.some((r) => r.method === "POST" && r.url.endsWith("/pulls")), "no second pull request");

  const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e) { assert.ok(e instanceof MwError); return e.code; } };
  const dirty = await giteaMock({ mergeable: false });
  after(() => dirty.close());
  assert.equal(await code(integrationsFor(cfg(dirty.url)).forgeMerge(REQ)), "merge/conflict");
  const conflict409 = await giteaMock({ mergeStatus: 409 });
  after(() => conflict409.close());
  assert.equal(await code(integrationsFor(cfg(conflict409.url)).forgeMerge(REQ)), "merge/conflict");
  const broken = await giteaMock({ mergeStatus: 500 });
  after(() => broken.close());
  assert.equal(await code(integrationsFor(cfg(broken.url)).forgeMerge(REQ)), "merge/failed");
  assert.equal(await code(integrationsFor(cfg(await deadUrl())).forgeMerge(REQ)), "merge/failed");
  delete process.env.MW_TEST_FORGE_TOKEN;
  assert.equal(await code(integrationsFor(cfg(reuse.url)).forgeMerge(REQ)), "merge/failed");
  process.env.MW_TEST_FORGE_TOKEN = "tok";
});

const forgeProject = (url: string, kind = "gitea") => projectWith({ git: { forge: { kind, url, repo: "me/demo", token_env: "MW_TEST_FORGE_TOKEN" } } });
const forgeRecord = (dir: string) => path.join(dir, ".mergewright", "runs", REQ.card, "forge.json");

test("forgeMerge: the pull request is recorded before the merge is requested", async () => {
  let atMerge: unknown;
  let dir = "";
  const mock = await giteaMock({ onMerge: () => { atMerge = JSON.parse(fs.readFileSync(forgeRecord(dir), "utf8")); } });
  after(() => mock.close());
  const f = forgeProject(mock.url);
  dir = f.dir;
  assert.equal(await integrationsFor(f.project).forgeMerge(REQ), "abc123");
  assert.deepEqual(atMerge, { pr: 7, branch: REQ.branch });
});

test("forgeMerge: a merge whose answer was lost is recognised on retry by the pull request's number", async () => {
  const mock = await giteaMock({ mergeThenFail: 502 });
  after(() => mock.close());
  const { project } = forgeProject(mock.url);
  const i = integrationsFor(project);
  await assert.rejects(i.forgeMerge(REQ), (e: unknown) => e instanceof MwError && e.code === "merge/failed");
  const before = mock.requests.length;
  assert.equal(await i.forgeMerge(REQ), "abc123", "the retry finds #7 merged (closed, so not in the open list)");
  const retry = mock.requests.slice(before);
  assert.deepEqual(retry.map((r) => `${r.method} ${r.url}`), ["GET /api/v1/repos/me/demo/pulls/7"], "no new pull request, no second merge");
});

test("forgeMerge: success needs the forge to report the pull request as merged", async () => {
  const gitea = await giteaMock({ neverMerged: true });
  after(() => gitea.close());
  await assert.rejects(integrationsFor(forgeProject(gitea.url).project).forgeMerge(REQ), (e: unknown) => {
    assert.ok(e instanceof MwError && e.code === "merge/failed");
    assert.match(e.message, /did not report pull request #7 as merged/);
    return true;
  });
  const github = await mockServer((r) => {
    if (r.method === "GET" && r.url.includes("/pulls?")) return { body: [{ number: 12, head: { ref: REQ.branch }, base: { ref: "main" } }] };
    if (r.method === "PUT") return { body: { sha: "def456", merged: false, message: "queued" } };
    return undefined;
  });
  after(() => github.close());
  await assert.rejects(integrationsFor(forgeProject(github.url, "github").project).forgeMerge(REQ), /GitHub did not report pull request #12 as merged/);
});

test("forgeMerge: a pull request reported merged without a merge commit throws merge/no-commit", async () => {
  let merged = false;
  const gitea = await mockServer((r) => {
    const pr = { number: 7, head: { ref: REQ.branch }, base: { ref: "main" }, mergeable: true, state: merged ? "closed" : "open", merged, merge_commit_sha: null };
    if (r.method === "GET" && r.url.includes("/pulls?")) return { body: [] };
    if (r.method === "POST" && r.url.endsWith("/pulls")) return { status: 201, body: pr };
    if (r.method === "GET" && r.url.endsWith("/pulls/7")) return { body: pr };
    if (r.method === "POST" && r.url.endsWith("/pulls/7/merge")) { merged = true; return { status: 200 }; }
    return undefined;
  });
  after(() => gitea.close());
  const noCommit = (e: unknown) => e instanceof MwError && e.code === "merge/no-commit" && /#7 as merged but names no merge commit/.test(e.message);
  const { project } = forgeProject(gitea.url);
  await assert.rejects(integrationsFor(project).forgeMerge(REQ), noCommit);
  // The retry finds #7 by its recorded number, merged, still without a commit: the same answer.
  await assert.rejects(integrationsFor(project).forgeMerge(REQ), noCommit);
  const github = await mockServer((r) => {
    if (r.method === "GET" && r.url.includes("/pulls?")) return { body: [{ number: 12, head: { ref: REQ.branch }, base: { ref: "main" } }] };
    if (r.method === "PUT") return { body: { merged: true, message: "merged" } };
    return undefined;
  });
  after(() => github.close());
  await assert.rejects(integrationsFor(forgeProject(github.url, "github").project).forgeMerge(REQ), (e: unknown) => e instanceof MwError && e.code === "merge/no-commit" && /#12/.test(e.message));
});

test("forgeMerge: a recorded pull request closed without merging stops with what to do", async () => {
  const mock = await mockServer((r) => (r.method === "GET" && r.url.endsWith("/pulls/7") ? { body: { number: 7, state: "closed", merged: false } } : undefined));
  after(() => mock.close());
  const { dir, project } = forgeProject(mock.url);
  write(dir, ".mergewright/runs/DEMO-4/forge.json", JSON.stringify({ pr: 7, branch: REQ.branch }));
  await assert.rejects(integrationsFor(project).forgeMerge(REQ), /#7 for card\/DEMO-4 was closed without being merged.*delete .*forge\.json/s);
  assert.equal(mock.requests.length, 1);
});

test("forgeMerge (github) finds or opens the pull request, squash-merges it, and maps a dirty merge to a conflict", async () => {
  let dirty = false;
  let open: { number: number; head: { ref: string }; base: { ref: string } }[] = [];
  const mock = await mockServer((r) => {
    if (r.headers.authorization !== "Bearer tok" || r.headers["x-github-api-version"] !== "2022-11-28") return { status: 401 };
    const p = "/repos/me/demo";
    if (r.method === "GET" && r.url.startsWith(`${p}/pulls?`)) return { body: open };
    if (r.method === "POST" && r.url === `${p}/pulls`) { open = [{ number: 12, head: { ref: REQ.branch }, base: { ref: "main" } }]; return { status: 201, body: open[0] }; }
    if (r.method === "PUT" && r.url === `${p}/pulls/12/merge`) return dirty ? { status: 405, body: { message: "Pull Request is not mergeable" } } : { body: { sha: "def456", merged: true, message: "merged" } };
    if (r.method === "GET" && r.url === `${p}/pulls/12`) return { body: { number: 12, mergeable: false, mergeable_state: "dirty" } };
    return undefined;
  });
  after(() => mock.close());
  const { project } = projectWith({ git: { forge: { kind: "github", url: mock.url, repo: "me/demo", token_env: "MW_TEST_FORGE_TOKEN" } } });
  assert.equal(await integrationsFor(project).forgeMerge(REQ), "def456");
  const list = mock.requests.find((r) => r.method === "GET")!;
  assert.match(list.url, /head=me%3Acard%2FDEMO-4&base=main/);
  assert.deepEqual(mock.requests.find((r) => r.method === "PUT")!.body, { merge_method: "squash", commit_title: REQ.title, commit_message: REQ.body });
  dirty = true;
  await assert.rejects(integrationsFor(project).forgeMerge(REQ), (e: unknown) => e instanceof MwError && e.code === "merge/conflict");
  assert.equal(mock.requests.filter((r) => r.method === "POST").length, 1, "the open pull request was found the second time");
});
