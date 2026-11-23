// The official board-4ga package (packages/board-4ga), installed with `mw add board-4ga --yes` and run
// against a fake 4ga Boards API on loopback (shapes from the upstream controllers, see the package's
// header): the mirror (create, move, rename), the queue when the board does not answer, the stale
// drop, the reconcile, `mw board-4ga mirror` and the doctor check. A live test runs with MW_LIVE=1.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { flushQueue } from "../src/integrations.ts";
import { activeExports, runChecks } from "../src/packages/loader.ts";
import { Project } from "../src/project.ts";
import { addPackage, card, MW, mw, newProject, read, write } from "./helpers.ts";
import { deadUrl, mockServer, queueItems, type Recorded } from "./fixtures/integrations/support.ts";

process.env.MW_TEST_4GA_ID = "client-id-for-tests";
process.env.MW_TEST_4GA_SECRET = "client-secret-for-tests-not-real";

interface List { id: string; name: string; position: number; isCompleted: boolean }
interface Card { id: string; listId: string; name: string; position: number }

/** A fake 4ga Boards with board 7: GET board, POST lists, POST cards, PATCH cards; API client headers required. */
async function fourgaMock() {
  const lists: List[] = [{ id: "100", name: "backlog", position: 65536, isCompleted: false }];
  const cards: Card[] = [];
  let ids = 200;
  const state = { down: false };
  const mock = await mockServer((r: Recorded) => {
    if (state.down) return { status: 503, body: { message: "down" } };
    if (r.headers["x-client-id"] !== process.env.MW_TEST_4GA_ID || r.headers["x-client-secret"] !== process.env.MW_TEST_4GA_SECRET) return { status: 401, body: { code: "E_UNAUTHORIZED", message: "Invalid client credentials" } };
    const b = r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r.method === "GET" && r.url === "/api/boards/7") return { body: { item: { id: "7", name: "Work" }, included: { lists, cards } } };
    if (r.method === "POST" && r.url === "/api/boards/7/lists") {
      assert.equal(typeof b.position, "number");
      assert.equal(b.isCollapsed, false);
      const l = { id: String(ids++), name: b.name, position: b.position, isCompleted: b.isCompleted };
      lists.push(l);
      return { body: { item: l } };
    }
    const create = r.url.match(/^\/api\/lists\/(\d+)\/cards$/);
    if (r.method === "POST" && create) {
      assert.equal(typeof b.position, "number", "position is required on create");
      const c = { id: String(ids++), listId: create[1]!, name: b.name, position: b.position };
      cards.push(c);
      return { body: { item: c } };
    }
    const patch = r.url.match(/^\/api\/cards\/(\d+)$/);
    if (r.method === "PATCH" && patch) {
      const c = cards.find((x) => x.id === patch[1]);
      if (!c) return { status: 404, body: { code: "E_NOT_FOUND" } };
      if (b.listId !== undefined) assert.equal(typeof b.position, "number", "position is required with listId");
      Object.assign(c, b);
      return { body: { item: c } };
    }
    return undefined;
  });
  after(() => mock.close());
  const listOf = (cardId: string) => lists.find((l) => l.id === cards.find((c) => c.name.startsWith(`[${cardId}] `))?.listId)?.name;
  return Object.assign(state, mock, { lists, cards, listOf });
}

function fourgaProject(url: string): { dir: string; project: () => Project } {
  const dir = newProject();
  const r = mw(dir, ["add", "board-4ga", "--yes"]);
  assert.equal(r.code, 0, r.err);
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace("  board-4ga: {}", `  board-4ga: { url: ${JSON.stringify(url)}, board: "7", client_id_env: MW_TEST_4GA_ID, client_secret_env: MW_TEST_4GA_SECRET }`));
  write(dir, "cards/DEMO-9.card.md", card("DEMO-9"));
  const project = () => new Project(dir);
  assert.deepEqual(project().diag.errors.map((e) => e.message), []);
  return { dir, project };
}

async function exportsOf(project: Project) {
  const e = (await activeExports(project)).find((x) => x.name === "board-4ga");
  assert.ok(e, "the package loads");
  return e.exports;
}

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

test("board-4ga: a status creates the card in its list, a new status moves it, a new title renames it; missing lists are created", async () => {
  const m = await fourgaMock();
  const { project } = fourgaProject(m.url);
  const ex = await exportsOf(project());
  await ex.mirrorCard!("DEMO-9", "Card DEMO-9", "todo");
  assert.equal(m.listOf("DEMO-9"), "backlog", "an existing list is matched without regard to case");
  assert.equal(m.cards.length, 1);
  await ex.mirrorCard!("DEMO-9", "Card DEMO-9", "running");
  assert.equal(m.listOf("DEMO-9"), "In progress");
  await ex.mirrorCard!("DEMO-9", "Renamed", "done");
  assert.equal(m.listOf("DEMO-9"), "Done");
  assert.equal(m.cards[0]!.name, "[DEMO-9] Renamed");
  assert.equal(m.lists.find((l) => l.name === "Done")?.isCompleted, true, "the Done list marks its cards completed");
  assert.equal(m.cards.length, 1, "the card is found again by its prefix, never duplicated");
  const before = m.requests.length;
  await ex.mirrorCard!("DEMO-9", "Renamed", "aborted");
  assert.deepEqual(m.requests.slice(before).map((r) => r.method), ["GET"], "nothing to change: one read, no write");
});

test("board-4ga: a board that does not answer queues the status; the flush delivers it, and drops a stale one", async () => {
  const m = await fourgaMock();
  // The card file says review: the queued 'review' is current and is delivered once the board answers.
  const { dir, project } = fourgaProject(m.url);
  write(dir, "cards/DEMO-9.card.md", read(dir, "cards/DEMO-9.card.md").replace("status: todo", "status: review"));
  m.down = true;
  await (await exportsOf(project())).mirrorCard!("DEMO-9", "Card DEMO-9", "review");
  const q = queueItems(dir);
  assert.equal(q.length, 1);
  assert.equal(q[0]!.kind, "board-4ga");
  assert.match(q[0]!.lastError ?? "", /HTTP 503/);
  assert.ok(!JSON.stringify(q).includes(process.env.MW_TEST_4GA_SECRET!), "the secret is never queued");
  m.down = false;
  const fr = await flushQueue(project());
  assert.deepEqual(fr.map((r) => r.ok), [true], JSON.stringify(fr));
  assert.equal(m.listOf("DEMO-9"), "Review");
  // A status the card has left (the card file says todo) is dropped, not delivered.
  const other = fourgaProject(m.url);
  m.down = true;
  await (await exportsOf(other.project())).mirrorCard!("DEMO-9", "Card DEMO-9", "running");
  m.down = false;
  const stale = await flushQueue(other.project());
  assert.equal(stale[0]!.dropped, true);
  assert.match(stale[0]!.error ?? "", /^stale: DEMO-9 is now todo, not running/);
  assert.equal(queueItems(other.dir).length, 0);
  assert.equal(m.listOf("DEMO-9"), "Review", "the dropped move was never sent");
});

test("board-4ga: without credentials the mirror says so once and queues nothing", async () => {
  const m = await fourgaMock();
  const { dir, project } = fourgaProject(m.url);
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace("MW_TEST_4GA_SECRET", "MW_TEST_4GA_UNSET"));
  const note = await (await exportsOf(project()))!.mirrorCard!("DEMO-9", "Card DEMO-9", "todo");
  assert.match(String(note), /4ga: mirror skipped \(MW_TEST_4GA_ID or MW_TEST_4GA_UNSET is not set/);
  assert.equal(queueItems(dir).length, 0);
  assert.equal(m.requests.length, 0);
});

test("board-4ga: reconcile and 'mw board-4ga mirror' bring every card level; the doctor check reports the board", async () => {
  const m = await fourgaMock();
  const { dir, project } = fourgaProject(m.url);
  const ex = await exportsOf(project());
  assert.match(String(await ex.reconcile!("before work")), /^4ga: board reconciled before work \(\d+ card\(s\) updated\)$/);
  assert.equal(m.listOf("DEMO-9"), "backlog");
  assert.equal(await ex.reconcile!("after work"), undefined, "nothing changed: no line");
  write(dir, "cards/DEMO-9.card.md", read(dir, "cards/DEMO-9.card.md").replace("status: todo", "status: done"));
  const r = await mwAsync(dir, ["board-4ga", "mirror"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ok +DEMO-9 +done +DEMO-9 moved to Done$/m);
  assert.match(r.out, /card\(s\) shown right on the board$/m);
  assert.equal(m.listOf("DEMO-9"), "Done");
  const usage = await mwAsync(dir, ["board-4ga"]);
  assert.equal(usage.code, 2);
  const [check] = await runChecks(ex);
  assert.equal(check!.ok, true);
  assert.match(check!.detail, /^reachable, board 'Work' with \d+ list\(s\) and \d+ card\(s\); http:\/\/127\.0\.0\.1:\d+\/ board 7, MW_TEST_4GA_ID set, MW_TEST_4GA_SECRET set$/);
  const bad = await runChecks(await exportsOf(fourgaProject(await deadUrl()).project()));
  assert.equal(bad[0]!.ok, false);
  assert.match(bad[0]!.detail, /^NOT reachable/);
});

test("board-4ga: its two required settings can be given one 'mw config set' at a time, and a wrong value is still refused", () => {
  const dir = newProject();
  addPackage(dir, "board-4ga");
  assert.equal(mw(dir, ["config", "set", "packages.board-4ga.url", "http://127.0.0.1:9"]).code, 0);
  assert.notEqual(mw(dir, ["config", "set", "packages.board-4ga.board", "seven"]).code, 0);
  assert.equal(mw(dir, ["config", "set", "packages.board-4ga.board", "7"]).code, 0);
  assert.equal(mw(dir, ["check"]).code, 0);
});

test("board-4ga: live, against a real 4ga Boards (MW_LIVE=1, MW_4GA_URL, MW_4GA_BOARD, MW_4GA_CLIENT_ID, MW_4GA_CLIENT_SECRET)", { skip: process.env.MW_LIVE !== "1" || !process.env.MW_4GA_URL ? "needs MW_LIVE=1 and a 4ga Boards instance in MW_4GA_URL" : false }, async () => {
  const dir = newProject();
  assert.equal(mw(dir, ["add", "board-4ga", "--yes"]).code, 0);
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace("  board-4ga: {}", `  board-4ga: { url: ${JSON.stringify(process.env.MW_4GA_URL)}, board: ${JSON.stringify(process.env.MW_4GA_BOARD ?? "")}, client_id_env: MW_4GA_CLIENT_ID, client_secret_env: MW_4GA_CLIENT_SECRET }`));
  write(dir, "cards/LIVE-1.card.md", card("LIVE-1"));
  const ex = await exportsOf(new Project(dir));
  const [check] = await runChecks(ex);
  assert.equal(check!.ok, true, check!.detail);
  for (const status of ["todo", "running", "review", "done"]) {
    await ex.mirrorCard!("LIVE-1", "Card LIVE-1", status);
    assert.equal(queueItems(dir).length, 0, `${status} was delivered, not queued`);
  }
});
