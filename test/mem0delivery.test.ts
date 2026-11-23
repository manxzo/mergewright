// Queued mem0/Letta delivery under a slow server (a large item could time out as a whole
// when every call had mem0's 10 s timeout, while one write can take 6 s idle and far more under load).
//   1. Writes have their own timeout (`packages.mem0.write_timeout_ms`, `packages.letta.write_timeout_ms`);
//      probe and search keep the short one.
//   2. A queued item is delivered one record at a time: the claimed item is rewritten after each, a
//      record already present is skipped, and `mw queue flush` says "N of M delivered, K remaining".
//   3. `mw queue flush` goes on after a failed item and exits 0 when anything was delivered.
// mem0 is the official package (packages/mem0), installed
// with `mw add mem0 --yes` in each project (`mem0Config`).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { lessonId } from "../src/integrations/common.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { Queue } from "../src/integrations/queue.ts";
import { localDir, Project } from "../src/project.ts";
import { lettaConfig, mem0Config, MW } from "./helpers.ts";
import { deadUrl, projectWith, queueItems } from "./fixtures/integrations/support.ts";

const MEM0_KEY = "mem0-test-key-not-a-secret";
const LETTA_PASS = "letta-test-password-not-a-secret";
process.env.MW_TEST_MEM0_KEY = MEM0_KEY;
process.env.MW_TEST_LETTA_PASSWORD = LETTA_PASS;

interface Lesson { topic: string; title: string; body: string }
const lessons = (...titles: string[]): Lesson[] => titles.map((t) => ({ topic: "t", title: t, body: `body of ${t}` }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `mw` as a child process, without blocking this process (the mock servers answer from here). */
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

type Reply = { status?: number; body?: unknown } | undefined;

/** An HTTP JSON server whose route may be async (to answer slowly). */
async function asyncServer(route: (method: string, url: URL, body: any) => Promise<Reply> | Reply, check: (h: http.IncomingHttpHeaders) => boolean) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", async () => {
      let r: Reply;
      if (!check(req.headers)) r = { status: 401, body: { detail: "unauthorized" } };
      else {
        try { r = await route(req.method ?? "GET", new URL(req.url ?? "/", "http://x"), data ? JSON.parse(data) : undefined); } catch (e) { r = { status: 500, body: { detail: String(e) } }; }
      }
      if (res.destroyed) return; // the client gave up (timed out)
      res.writeHead(r ? r.status ?? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(r?.body ?? { detail: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return url;
}

interface Mem0Opts {
  /** Delay of each add, in ms. */
  addDelay?: number;
  /** Answer the n-th add (1-based) with 503 instead of storing it. */
  failAdd?: number;
  /** Called at the start of each add, with its 1-based number. */
  onAdd?: (n: number) => void;
}

/** mem0: POST /memories (stores even when the client has timed out, as the real server does), GET /memories, POST /search with a lesson_id filter. */
async function mem0Mock(opts: Mem0Opts = {}) {
  const store: { memory: string; user_id: string; metadata: Record<string, unknown> }[] = [];
  const adds: string[] = [];
  let n = 0;
  const url = await asyncServer(async (method, u, b) => {
    if (method === "POST" && u.pathname === "/memories") {
      const k = ++n;
      opts.onAdd?.(k);
      if (opts.addDelay) await sleep(opts.addDelay);
      if (k === opts.failAdd) return { status: 503, body: { detail: "busy" } };
      adds.push(b.metadata.title);
      store.push({ memory: b.messages[0].content, user_id: b.user_id, metadata: b.metadata });
      return { body: { results: [{ id: `m${store.length}`, memory: b.messages[0].content, event: "ADD" }] } };
    }
    if (method === "GET" && u.pathname === "/memories") return { body: { results: store.filter((m) => m.user_id === u.searchParams.get("user_id")) } };
    if (method === "POST" && u.pathname === "/search") {
      const f = b.filters as Record<string, unknown>;
      return { body: { results: store.filter((m) => m.user_id === f.user_id && (f.lesson_id === undefined || m.metadata.lesson_id === f.lesson_id)).slice(0, b.top_k) } };
    }
    return undefined;
  }, (h) => h["x-api-key"] === MEM0_KEY);
  return { url, store, adds };
}

const mem0Cfg = (url: string, extra: Record<string, unknown> = {}) => mem0Config({ url, key_env: "MW_TEST_MEM0_KEY", ...extra });

function queueMem0(dir: string, items: Lesson[][]): void {
  const q = new Queue(localDir(new Project(dir)));
  for (const ls of items) q.add("mem0", `mem0 (demo): ${ls.length} lesson(s): ${ls.map((l) => l.title).join("; ")}`, { lessons: ls });
}

const titlesOf = (item: { payload: unknown } | undefined) => ((item?.payload as { lessons?: Lesson[] } | undefined)?.lessons ?? []).map((l) => l.title);

test("timeouts by call kind: probe and search keep 10 s, writes default to 180 s (mem0) and 60 s (Letta), configurable", async () => {
  // mem0's write timeout is set by packages.mem0.write_timeout_ms; the tests below exercise it.
  const mem0 = await import(pathToFileURL(path.join(PACKAGE_ROOT, "packages", "mem0", "index.mjs")).href) as Record<string, unknown>;
  const letta = await import(pathToFileURL(path.join(PACKAGE_ROOT, "packages", "letta", "index.mjs")).href) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(mem0.MEM0_TIMEOUT_MS, 10_000);
  assert.equal(mem0.MEM0_WRITE_TIMEOUT_MS, 180_000);
  assert.equal(letta.LETTA_WRITE_TIMEOUT_MS, 60_000);
  assert.equal(letta.settingsOf({ url: "http://127.0.0.1:2" }, "demo").writeTimeoutMs, 60_000);
  assert.equal(letta.settingsOf({ url: "http://127.0.0.1:2", write_timeout_ms: 5678 }, "demo").writeTimeoutMs, 5678);
});

test("a write slower than packages.mem0.write_timeout_ms delivers nothing and keeps the item intact; a longer write timeout delivers it, skipping the write that landed late", async () => {
  const mock = await mem0Mock({ addDelay: 300 });
  const { dir } = projectWith(mem0Cfg(mock.url, { write_timeout_ms: 100 }));
  queueMem0(dir, [lessons("A", "B", "C")]);

  const r1 = await mwAsync(dir, ["queue", "flush"]);
  assert.equal(r1.code, 1, r1.out + r1.err);
  assert.match(r1.out, /kept\s+mem0 .*\(0 of 3 delivered, 3 remaining\): POST .*\/memories: timed out/);
  const items = queueItems(dir);
  assert.equal(items.length, 1);
  assert.deepEqual(titlesOf(items[0]), ["A", "B", "C"], "the whole item stays");
  assert.equal(items[0]!.attempts, 1);
  // The searches (10 s) answered: the timeout is the write's only.
  assert.doesNotMatch(r1.out, /\/search: timed out/);

  await sleep(400); // the server finishes the write the client gave up on, as mem0 does
  assert.deepEqual(mock.adds, ["A"]);
  const cfg = path.join(dir, "mergewright.yaml");
  fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace("write_timeout_ms: 100", "write_timeout_ms: 2000"));
  const r2 = await mwAsync(dir, ["queue", "flush"]);
  assert.equal(r2.code, 0, r2.out + r2.err);
  assert.match(r2.out, /^delivered\s+mem0 .*\(2 delivered, 1 already present\)$/m);
  assert.deepEqual(queueItems(dir), []);
  assert.deepEqual(mock.adds, ["A", "B", "C"], "A, which landed late, was not stored again");
});

test("with a 2 s write timeout every slow write is delivered", async () => {
  const mock = await mem0Mock({ addDelay: 300 });
  const { dir } = projectWith(mem0Cfg(mock.url, { write_timeout_ms: 2000 }));
  queueMem0(dir, [lessons("A", "B", "C")]);
  const r = await mwAsync(dir, ["queue", "flush"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^delivered\s+mem0 .*\(3 delivered\)$/m);
  assert.deepEqual(mock.adds, ["A", "B", "C"]);
  assert.deepEqual(queueItems(dir), []);
});

test("one record at a time: the claimed item is rewritten after each; a failure on the fourth of five keeps exactly the two undelivered, says '3 of 5 delivered', exits 0", async () => {
  let dir = "";
  const seen: string[][] = [];
  const mock = await mem0Mock({
    failAdd: 4,
    onAdd: () => {
      // What a crash at this moment would leave: the claimed item, as last written.
      const qd = path.join(dir, ".mergewright", "local", "queue");
      const claimed = fs.readdirSync(qd).filter((f) => /\.claimed-\d+$/.test(f));
      assert.equal(claimed.length, 1);
      seen.push(titlesOf(JSON.parse(fs.readFileSync(path.join(qd, claimed[0]!), "utf8"))));
    },
  });
  ({ dir } = projectWith(mem0Cfg(mock.url)));
  queueMem0(dir, [lessons("L1", "L2", "L3", "L4", "L5")]);

  const r = await mwAsync(dir, ["queue", "flush"]);
  assert.equal(r.code, 0, `something was delivered: ${r.out}${r.err}`);
  assert.match(r.out, /kept\s+mem0\s+mem0 \(demo\): 2 lesson\(s\): L4; L5 \(3 of 5 delivered, 2 remaining\): .*HTTP 503/);
  assert.match(r.out, /^0 delivered, 1 still queued; records: 3 delivered$/m);
  assert.deepEqual(seen, [["L1", "L2", "L3", "L4", "L5"], ["L2", "L3", "L4", "L5"], ["L3", "L4", "L5"], ["L4", "L5"]]);
  const items = queueItems(dir);
  assert.equal(items.length, 1);
  assert.deepEqual(titlesOf(items[0]), ["L4", "L5"]);
  assert.deepEqual(mock.adds, ["L1", "L2", "L3"]);
});

test("a record already present (same lesson_id, same text) is skipped and counted; one with the same id but other text is sent", async () => {
  const mock = await mem0Mock();
  const { dir } = projectWith(mem0Cfg(mock.url));
  const [a, b, c] = lessons("A", "B", "C");
  mock.store.push({ memory: b!.body, user_id: "demo", metadata: { title: "B", lesson_id: lessonId("demo", b!) } });
  mock.store.push({ memory: "an older text of C", user_id: "demo", metadata: { title: "C", lesson_id: lessonId("demo", c!) } });
  queueMem0(dir, [[a!, b!, c!]]);
  const r = await mwAsync(dir, ["queue", "flush"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^delivered\s+mem0 .*\(2 delivered, 1 already present\)$/m);
  assert.deepEqual(mock.adds, ["A", "C"]);
  assert.deepEqual(queueItems(dir), []);
});

test("mw queue flush goes on after a failed item and exits 0 when anything was delivered, 1 when nothing could be", async () => {
  const mock = await mem0Mock({ failAdd: 1 });
  const { dir } = projectWith(mem0Cfg(mock.url));
  queueMem0(dir, [lessons("Bad"), lessons("Good")]);
  const r = await mwAsync(dir, ["queue", "flush"]);
  assert.match(r.out, /kept\s+mem0 .*Bad \(0 of 1 delivered, 1 remaining\)/);
  assert.match(r.out, /^delivered\s+mem0 .*Good \(1 delivered\)$/m);
  assert.match(r.out, /1 delivered, 1 still queued/);
  assert.equal(r.code, 0, "Good was delivered in this run");
  assert.deepEqual(queueItems(dir).map(titlesOf), [["Bad"]]);

  const dead = await deadUrl();
  const down = projectWith(mem0Cfg(dead));
  queueMem0(down.dir, [lessons("X"), lessons("Y")]);
  const r2 = await mwAsync(down.dir, ["queue", "flush"]);
  assert.equal(r2.code, 1, "nothing could be delivered");
  assert.equal(queueItems(down.dir).length, 2);
});

// ── Letta ───────────────────────────────────────────────────────────────────────────────────

interface LettaOpts { insertDelay?: number; failInsert?: number }

async function lettaMock(opts: LettaOpts = {}) {
  const passages: { text: string; tags: string[] }[] = [];
  const inserts: string[] = [];
  let n = 0;
  const url = await asyncServer(async (method, u, b) => {
    if (method === "GET" && u.pathname === "/v1/agents/") return { body: [{ id: "agent-1", name: u.searchParams.get("name") }] };
    if (method === "POST" && u.pathname === "/v1/agents/agent-1/archival-memory") {
      const k = ++n;
      if (opts.insertDelay) await sleep(opts.insertDelay);
      if (k === opts.failInsert) return { status: 503, body: { detail: "busy" } };
      inserts.push(String(b.text).split("\n")[0]!);
      passages.push({ text: b.text, tags: b.tags });
      return { body: [{ id: `p${passages.length}`, text: b.text, tags: b.tags }] };
    }
    if (method === "GET" && u.pathname === "/v1/agents/agent-1/archival-memory/search") {
      const want = u.searchParams.getAll("tags");
      return { body: { results: passages.filter((p) => !want.length || want.some((t) => p.tags.includes(t))).map((p, i) => ({ id: `p${i}`, content: p.text, tags: p.tags })) } };
    }
    return undefined;
  }, (h) => h.authorization === `Bearer ${LETTA_PASS}`);
  return { url, passages, inserts };
}

const lettaCfg = (url: string, extra: Record<string, unknown> = {}) => lettaConfig({ url, key_env: "MW_TEST_LETTA_PASSWORD", ...extra });

function queueLetta(dir: string, ls: Lesson[]): void {
  new Queue(localDir(new Project(dir))).add("letta", `letta (mergewright-demo): ${ls.length} lesson(s)`, { lessons: ls });
}

test("Letta: an insert slower than packages.letta.write_timeout_ms keeps the item intact", async () => {
  const mock = await lettaMock({ insertDelay: 300 });
  const { dir } = projectWith(lettaCfg(mock.url, { write_timeout_ms: 100 }));
  queueLetta(dir, lessons("A", "B"));
  const r = await mwAsync(dir, ["queue", "flush"]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /kept\s+letta .*\(0 of 2 delivered, 2 remaining\): .*timed out/);
  assert.deepEqual(titlesOf(queueItems(dir)[0]), ["A", "B"]);
});

test("Letta: one record at a time, a record already present skipped, a failure keeps only what remains", async () => {
  const mock = await lettaMock({ failInsert: 3 });
  const { dir } = projectWith(lettaCfg(mock.url));
  const ls = lessons("A", "B", "C", "D");
  // B is already in the archive (an earlier insert that timed out but landed).
  const { lessonTags, lessonText } = await import(pathToFileURL(path.join(PACKAGE_ROOT, "packages", "letta", "index.mjs")).href);
  mock.passages.push({ text: lessonText(ls[1]!), tags: lessonTags("demo", ls[1]!, lessonId("demo", ls[1]!)) });
  queueLetta(dir, ls);
  const r = await mwAsync(dir, ["queue", "flush"]);
  assert.equal(r.code, 0, r.out + r.err);
  // A inserted, B present, C inserted, D refused (the third insert).
  assert.match(r.out, /kept\s+letta .*\(2 of 4 delivered, 1 already present, 1 remaining\): .*HTTP 503/);
  assert.deepEqual(mock.inserts, ["A", "C"]);
  assert.deepEqual(titlesOf(queueItems(dir)[0]), ["D"]);
});
