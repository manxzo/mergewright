// The official notebook-opennotelm package (packages/notebook-opennotelm), installed with `mw add
// notebook-opennotelm --yes` and run against a fake OpenNoteLM on loopback (shapes from the upstream
// source, see the package's header): the multipart upload (host.http.json's `form`), replacing only
// changed files, removing deleted ones, the duplicate answer, refused files, the queue,
// `mw notebook-opennotelm sync --all` and the doctor check. A live test runs with MW_LIVE=1.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { flushQueue, integrationsFor } from "../src/integrations.ts";
import { activeExports, runChecks } from "../src/packages/loader.ts";
import { Project } from "../src/project.ts";
import { git, MW, mw, newProject, read, write } from "./helpers.ts";
import { deadUrl, mockServer, queueItems, type Recorded } from "./fixtures/integrations/support.ts";

interface Source { id: string; original_filename: string; content: string; checksum_sha256: string; notebooks: string[] }

/** A fake OpenNoteLM: health, notebooks, a notebook's sources, multipart upload (with its duplicate rule), attach, delete. */
async function onlmMock(opts: { maxBytes?: number } = {}) {
  const notebooks: { id: string; title: string }[] = [];
  const sources: Source[] = [];
  let next = 1;
  const state = { down: false };
  const mock = await mockServer((r: Recorded) => {
    if (state.down) return { status: 503, body: { error: { code: "DOWN", message: "down" } } };
    const u = new URL(r.url, "http://x");
    if (u.pathname === "/api/health") return { body: { status: "ok", version: "0.9.0" } };
    if (u.pathname === "/api/notebooks" && r.method === "GET") return { body: notebooks.map((n) => ({ ...n, description: "", source_count: 0 })) };
    if (u.pathname === "/api/notebooks" && r.method === "POST") {
      const n = { id: `nb${next++}`, title: (r.body as { title: string }).title };
      notebooks.push(n);
      return { status: 201, body: n };
    }
    const list = /^\/api\/notebooks\/([^/]+)\/sources$/.exec(u.pathname);
    if (list && r.method === "GET") return { body: sources.filter((s) => s.notebooks.includes(list[1]!)).map(({ content: _c, notebooks: _n, ...s }) => ({ ...s, title: s.original_filename.replace(/\.[^.]+$/, ""), enabled: true })) };
    const up = /^\/api\/notebooks\/([^/]+)\/sources\/upload$/.exec(u.pathname);
    if (up && r.method === "POST") {
      const boundary = /boundary=(.+)$/.exec(String(r.headers["content-type"]))?.[1];
      assert.ok(boundary, "sent as multipart/form-data");
      const raw = String(r.body);
      const filename = /name="file"; filename="([^"]+)"/.exec(raw)?.[1] ?? "";
      const content = raw.slice(raw.indexOf("\r\n\r\n") + 4, raw.lastIndexOf(`\r\n--${boundary}`));
      if (!/\.(md|markdown|txt|pdf|epub|docx)$/.test(filename)) return { status: 400, body: { error: { code: "SOURCE_TYPE_UNSUPPORTED" } } };
      if (opts.maxBytes && Buffer.byteLength(content) > opts.maxBytes) return { status: 413, body: { error: { code: "SOURCE_TOO_LARGE", message: "The source exceeds the configured file size limit." } } };
      const checksum = createHash("sha256").update(content).digest("hex");
      const dup = sources.find((s) => s.checksum_sha256 === checksum);
      if (dup) return { status: 202, body: { duplicate: true, source: { id: dup.id, original_filename: dup.original_filename } } };
      const s = { id: `src${next++}`, original_filename: filename, content, checksum_sha256: checksum, notebooks: [up[1]!] };
      sources.push(s);
      return { status: 202, body: { duplicate: false, source: { id: s.id, original_filename: filename }, job: { id: `job${next++}`, status: "queued" } } };
    }
    const attach = /^\/api\/notebooks\/([^/]+)\/sources\/([^/]+)$/.exec(u.pathname);
    if (attach && r.method === "POST") {
      const s = sources.find((x) => x.id === attach[2]);
      if (!s) return { status: 404, body: { error: { code: "SOURCE_NOT_FOUND" } } };
      if (!s.notebooks.includes(attach[1]!)) s.notebooks.push(attach[1]!);
      return { body: { id: s.id } };
    }
    const del = /^\/api\/sources\/([^/]+)$/.exec(u.pathname);
    if (del && r.method === "DELETE") {
      const k = sources.findIndex((s) => s.id === del[1]);
      if (k < 0) return { status: 404, body: { error: { code: "SOURCE_NOT_FOUND" } } };
      sources.splice(k, 1);
      return { status: 204 };
    }
    return undefined;
  });
  after(() => mock.close());
  const shownIn = (nb: string) => sources.filter((s) => s.notebooks.includes(nb)).map((s) => [s.original_filename, s.content]);
  return Object.assign(state, mock, { notebooks, sources, shownIn });
}

function onlmProject(url: string, extra = ""): { dir: string; project: () => Project } {
  const dir = newProject();
  const r = mw(dir, ["add", "notebook-opennotelm", "--yes"]);
  assert.equal(r.code, 0, r.err);
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace("  notebook-opennotelm: {}", `  notebook-opennotelm: { url: ${JSON.stringify(url)}${extra} }`));
  const project = () => new Project(dir);
  assert.deepEqual(project().diag.errors.map((e) => e.message), []);
  return { dir, project };
}

function commitDocs(dir: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "docs");
  return git(dir, "rev-parse", "HEAD");
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

test("notebook-opennotelm: docsSync creates the notebook once, uploads each file under its escaped path, replaces only changed ones and removes deleted ones", async () => {
  const m = await onlmMock();
  const { dir, project } = onlmProject(m.url);
  write(dir, "docs/a.md", "# A v1\n");
  write(dir, "docs/sub/notes", "plain notes\n");
  commitDocs(dir);
  const i = integrationsFor(project());
  await i.docsSync(["docs/a.md", "docs/sub/notes"], []);
  assert.deepEqual(m.notebooks.map((n) => n.title), ["demo"]);
  assert.deepEqual(m.shownIn("nb1"), [["docs%2Fa.md", "# A v1\n"], ["docs%2Fsub%2Fnotes.txt", "plain notes\n"]]);

  write(dir, "docs/a.md", "# A v2\n");
  fs.rmSync(path.join(dir, "docs/sub/notes"));
  commitDocs(dir);
  const before = m.requests.length;
  await i.docsSync(["docs/a.md"], ["docs/sub/notes"]);
  assert.equal(m.notebooks.length, 1, "notebook reused");
  assert.deepEqual(m.shownIn("nb1"), [["docs%2Fa.md", "# A v2\n"]]);
  const calls = m.requests.slice(before).map((r) => `${r.method} ${r.url}`);
  assert.ok(calls.indexOf("POST /api/notebooks/nb1/sources/upload") < calls.findIndex((c) => c.startsWith("DELETE ")), "the new version is uploaded before the old one is deleted");

  // Unchanged content is not sent again.
  const again = m.requests.length;
  await i.docsSync(["docs/a.md"], []);
  assert.ok(!m.requests.slice(again).some((r) => r.method !== "GET"), "nothing uploaded or deleted for an unchanged file");
  assert.deepEqual(queueItems(dir), []);
});

test("notebook-opennotelm: a file with the bytes of an existing source is attached, a refused file is a warning, an empty one is left out", async () => {
  const m = await onlmMock({ maxBytes: 100 });
  const { dir, project } = onlmProject(m.url, ", name: Handbook");
  write(dir, "docs/a.md", "same\n");
  write(dir, "docs/b.md", "same\n");
  write(dir, "docs/big.md", "x".repeat(200));
  write(dir, "docs/empty.md", "\n");
  commitDocs(dir);
  const r = await mwAsync(dir, ["notebook-opennotelm", "sync", "--all"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /skipped: docs\/b\.md has the same content as the source 'docs%2Fa\.md', which the notebook shows instead/);
  assert.match(r.out, /skipped: docs\/big\.md was refused by OpenNoteLM \(.*HTTP 413/);
  assert.match(r.out, /skipped: docs\/empty\.md is empty/);
  assert.match(r.out, /^\d+ document\(s\) of the last commit uploaded to OpenNoteLM notebook 'Handbook' \(unchanged ones are kept\), \d+ skipped$/m);
  const shown = m.shownIn("nb1").map((x) => x[0]);
  assert.ok(shown.includes("docs%2Fa.md"));
  for (const f of ["docs%2Fb.md", "docs%2Fbig.md", "docs%2Fempty.md"]) assert.ok(!shown.includes(f), f);
  assert.deepEqual(queueItems(dir), [], "a refused file is not retried");
  assert.equal((await mwAsync(dir, ["notebook-opennotelm", "sync"])).code, 2);
});

test("notebook-opennotelm: a server that does not answer queues the batch with its commit; the flush sends what that commit held", async () => {
  const m = await onlmMock();
  const { dir, project } = onlmProject(m.url);
  write(dir, "docs/a.md", "old\n");
  const commit = commitDocs(dir);
  m.down = true;
  await integrationsFor(project()).docsSync(["docs/a.md"], ["docs/gone.md"]);
  const items = queueItems(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "notebook-opennotelm");
  assert.deepEqual(items[0]!.payload, { changed: ["docs/a.md"], deleted: ["docs/gone.md"], commit });
  write(dir, "docs/a.md", "newer, not committed\n");
  m.down = false;
  assert.deepEqual((await flushQueue(project())).map((r) => r.ok), [true]);
  assert.deepEqual(m.shownIn("nb1"), [["docs%2Fa.md", "old\n"]]);
});

test("notebook-opennotelm: the doctor check reports the server and whether the notebook exists", async () => {
  const m = await onlmMock();
  const ex = (await activeExports(onlmProject(m.url).project())).find((x) => x.name === "notebook-opennotelm")!.exports;
  const [ok] = await runChecks(ex);
  assert.equal(ok!.ok, true);
  assert.match(ok!.detail, /^reachable, OpenNoteLM 0\.9\.0; notebook 'demo' not created yet \(the first docs sync creates it\); http:\/\/127\.0\.0\.1:\d+\/ notebook 'demo'$/);
  const bad = await runChecks((await activeExports(onlmProject(await deadUrl()).project())).find((x) => x.name === "notebook-opennotelm")!.exports);
  assert.equal(bad[0]!.ok, false);
  assert.match(bad[0]!.detail, /^NOT reachable/);
});

test("notebook-opennotelm: live, against a real OpenNoteLM (MW_LIVE=1, MW_OPENNOTELM_URL)", { skip: process.env.MW_LIVE !== "1" || !process.env.MW_OPENNOTELM_URL ? "needs MW_LIVE=1 and an OpenNoteLM in MW_OPENNOTELM_URL" : false }, async () => {
  const name = `mw-live-${Date.now()}`;
  const { dir, project } = onlmProject(process.env.MW_OPENNOTELM_URL!, `, name: ${name}`);
  write(dir, "docs/live.md", `# Live\n\n${name}\n`);
  commitDocs(dir);
  const ex = (await activeExports(project())).find((x) => x.name === "notebook-opennotelm")!.exports;
  assert.equal((await runChecks(ex))[0]!.ok, true);
  assert.equal(await ex.docsSync!(["docs/live.md"], [], git(dir, "rev-parse", "HEAD")), "sent");
  write(dir, "docs/live.md", `# Live v2\n\n${name}\n`);
  assert.equal(await ex.docsSync!(["docs/live.md"], [], commitDocs(dir)), "sent");
  assert.deepEqual(queueItems(dir), []);
});
