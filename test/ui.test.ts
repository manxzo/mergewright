// `mw ui` (specification section 16): the GUI's HTTP server, its security rules, the tool API, the
// event stream, and the page's own modules (syntax, and the Markdown renderer's escaping).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { UI_DIR } from "../src/paths.ts";
import { MAX_BODY, startUiServer, type UiServer } from "../src/ui/server.ts";
import { newProject, write } from "./helpers.ts";

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/", headers: { Host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

const servers: UiServer[] = [];
after(async () => { for (const s of servers) await s.close(); });

async function start(dir = newProject()): Promise<{ ui: UiServer; dir: string; auth: Record<string, string> }> {
  const ui = await startUiServer({ root: dir, port: 0, log: () => {} });
  servers.push(ui);
  return { ui, dir, auth: { Cookie: `mw_ui_${ui.port}=${ui.token}` } };
}

const tool = async (port: number, auth: Record<string, string>, name: string, args: object = {}) => {
  const r = await request(port, { method: "POST", path: `/api/tool/${name}`, headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  assert.equal(r.status, 200, r.body);
  return JSON.parse(r.body) as { text: string; data: Record<string, any> | null; isError: boolean };
};

test("ui: no token is a 401 page pointing at the terminal; the printed link sets an HttpOnly SameSite=Strict cookie and redirects to /", async () => {
  const { ui } = await start();
  assert.match(ui.url, new RegExp(`^http://127\\.0\\.0\\.1:${ui.port}/\\?token=[A-Za-z0-9_-]{43}$`), "a 256-bit token in the printed link");
  for (const p of ["/", "/app.js", "/style.css", "/api/tools", "/api/events"]) {
    const r = await request(ui.port, { path: p });
    assert.equal(r.status, 401, p);
  }
  const page = await request(ui.port);
  assert.match(page.body, /printed in the terminal/);
  assert.equal((await request(ui.port, { path: "/?token=wrong" })).status, 401);
  assert.equal((await request(ui.port, { path: `/?token=${ui.token}x` })).status, 401);
  const signIn = await request(ui.port, { path: `/?token=${ui.token}` });
  assert.equal(signIn.status, 303);
  assert.equal(signIn.headers.location, "/");
  const cookie = signIn.headers["set-cookie"]![0]!;
  assert.equal(cookie, `mw_ui_${ui.port}=${ui.token}; HttpOnly; SameSite=Strict; Path=/`);
  const home = await request(ui.port, { headers: { Cookie: cookie.split(";")[0]! } });
  assert.equal(home.status, 200);
  assert.match(home.body, /<script type="module" src="app.js"><\/script>/);
  // A bearer header works as the cookie does; a wrong one does not.
  assert.equal((await request(ui.port, { path: "/api/tools", headers: { Authorization: `Bearer ${ui.token}` } })).status, 200);
  assert.equal((await request(ui.port, { path: "/api/tools", headers: { Authorization: "Bearer nope" } })).status, 401);
  // Another start's token does not open this one.
  const other = await start();
  assert.equal((await request(ui.port, { headers: { Cookie: `mw_ui_${ui.port}=${other.ui.token}` } })).status, 401);
});

test("ui: a Host other than 127.0.0.1:<port> or localhost:<port> is refused (DNS rebinding), even signed in", async () => {
  const { ui, auth } = await start();
  for (const host of ["example.com", `example.com:${ui.port}`, "127.0.0.1", `127.0.0.1:${ui.port + 1}`, `192.0.2.1:${ui.port}`]) {
    const r = await request(ui.port, { path: "/api/tools", headers: { ...auth, Host: host } });
    assert.equal(r.status, 403, host);
  }
  assert.equal((await request(ui.port, { path: "/api/tools", headers: { ...auth, Host: `localhost:${ui.port}` } })).status, 200);
});

test("ui: a POST from another origin, without application/json, or over 1 MB is refused before any tool runs", async () => {
  const { ui, auth } = await start();
  const post = (headers: Record<string, string>, body = "{}") => request(ui.port, { method: "POST", path: "/api/tool/mw_status", headers: { ...auth, ...headers }, body });
  assert.equal((await post({ "Content-Type": "application/json", Origin: "http://example.com" })).status, 403);
  assert.equal((await post({ "Content-Type": "application/json", Origin: `http://localhost:${ui.port + 1}` })).status, 403);
  assert.equal((await post({ "Content-Type": "application/json", Origin: `http://127.0.0.1:${ui.port}` })).status, 200);
  assert.equal((await post({ "Content-Type": "application/json" })).status, 200, "no Origin: a same-origin or non-browser client");
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
    const r = await post(type ? { "Content-Type": type } : {});
    assert.equal(r.status, 415, type);
  }
  assert.equal((await post({ "Content-Type": "application/json; charset=utf-8" })).status, 200);
  assert.equal((await post({ "Content-Type": "application/json" }, "not json")).status, 400);
  assert.equal((await post({ "Content-Type": "application/json" }, "[1]")).status, 400);
  // Only the headers are sent: the server refuses on the declared length, and a client still writing
  // a megabyte into a connection the server has answered gets EPIPE on some systems.
  const big = await new Promise<string>((resolve, reject) => {
    const head = { Host: `127.0.0.1:${ui.port}`, ...auth, "Content-Type": "application/json", "Content-Length": String(MAX_BODY + 1) };
    const s = net.connect(ui.port, "127.0.0.1", () => s.write(`POST /api/tool/mw_status HTTP/1.1\r\n${Object.entries(head).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`));
    s.once("data", (c) => { resolve(c.toString("utf8").split("\r\n")[0]!); s.destroy(); });
    s.once("error", reject);
  });
  assert.match(big, /^HTTP\/1\.1 413 /);
  // Other methods are not accepted at all.
  assert.equal((await request(ui.port, { method: "PUT", path: "/api/tool/mw_status", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" })).status, 405);
});

test("ui: static files come only from the page folder's listing; traversal gets 404; every answer has the security headers", async () => {
  const { ui, auth } = await start();
  const js = await request(ui.port, { path: "/app.js", headers: auth });
  assert.equal(js.status, 200);
  assert.match(js.headers["content-type"]!, /^text\/javascript/);
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2fserver.ts", "/server.ts", "/app.js/../../server.ts", "//etc/passwd", "/index.html%00.js", "/nope.js"]) {
    const r = await request(ui.port, { path: p, headers: auth });
    assert.equal(r.status, 404, p);
  }
  for (const r of [js, await request(ui.port), await request(ui.port, { path: "/nope", headers: auth }), await request(ui.port, { path: "/api/tools", headers: auth })]) {
    const csp = String(r.headers["content-security-policy"]);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal(r.headers["cache-control"], "no-store");
  }
});

test("ui: /api/tools lists the tools; a read tool returns data; a write tool changes a card that status then shows", async () => {
  const { ui, auth } = await start();
  const list = JSON.parse((await request(ui.port, { path: "/api/tools", headers: auth })).body) as { tools: { name: string; write: boolean; result: string | null }[] };
  const byName = new Map(list.tools.map((t) => [t.name, t]));
  assert.equal(byName.get("mw_status")?.write, false);
  assert.equal(byName.get("mw_status")?.result, "StatusData");
  assert.equal(byName.get("mw_card_new")?.write, true);
  const settings = await tool(ui.port, auth, "mw_settings");
  assert.equal(settings.isError, false);
  assert.equal(settings.data!.name, "demo");
  const made = await tool(ui.port, auth, "mw_card_new", { title: "Tidy the readme", kind: "chore", scope: ["README.md"], why: "It is long.", out_of_scope: "None", acceptance: ["the readme is shorter"] });
  assert.equal(made.isError, false, made.text);
  const id = made.data!.card.id as string;
  assert.equal(made.data!.card.status, "todo");
  const ready = await tool(ui.port, auth, "mw_card_set_status", { id, status: "ready" });
  assert.equal(ready.isError, false, ready.text);
  const status = await tool(ui.port, auth, "mw_status");
  assert.equal(status.data!.cards.find((c: { id: string }) => c.id === id).status, "ready");
  const unknown = await tool(ui.port, auth, "mw_nope");
  assert.equal(unknown.isError, true);
});

test("ui: a refused tool call is 200 with isError and its data (lint findings), and write tools are refused inside a card run", async () => {
  const { ui, auth } = await start();
  const made = await tool(ui.port, auth, "mw_card_new", { title: "Bare card", kind: "chore" });
  assert.equal(made.isError, false, made.text);
  const id = made.data!.card.id as string;
  const refused = await tool(ui.port, auth, "mw_card_set_status", { id, status: "ready" });
  assert.equal(refused.isError, true);
  assert.equal(refused.data!.lint.ok, false);
  assert.ok(refused.data!.lint.findings.some((f: { severity: string }) => f.severity === "error"));
  const bad = await tool(ui.port, auth, "mw_card_set_status", { id, status: "done" });
  assert.equal(bad.isError, true, "invalid arguments are a tool refusal too");
  process.env.MW_ROLE = "worker";
  try {
    const r = await tool(ui.port, auth, "mw_card_new", { title: "From a run" });
    assert.equal(r.isError, true);
    assert.match(r.text, /is done by the owner, not from inside a card run/);
  } finally {
    delete process.env.MW_ROLE;
  }
});

test("ui: the event stream says hello, sends 'changed' after a card file changes, and ends when the server stops", async () => {
  const { ui, dir, auth } = await start();
  const events: string[] = [];
  let ended = false;
  let sawChange: () => void = () => {};
  const changed = new Promise<void>((resolve) => { sawChange = resolve; });
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: ui.port, path: "/api/events", headers: { Host: `127.0.0.1:${ui.port}`, ...auth } }, resolve);
    req.on("error", reject);
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"]!, /^text\/event-stream/);
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => { events.push(chunk); if (/event: changed\ndata: \{"count":1\}/.test(events.join(""))) sawChange(); });
  res.on("end", () => { ended = true; });
  res.on("error", () => { ended = true; });
  await new Promise((r) => setTimeout(r, 200));
  assert.match(events.join(""), /event: hello/);
  write(dir, "cards/DEMO-9.card.md", "---\nid: DEMO-9\ntitle: Nine\nstatus: todo\n---\n\n## Why\n\nx\n");
  await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error(`no change event: ${events.join("")}`)), 8000))]);
  await ui.close();
  servers.splice(servers.indexOf(ui), 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ended, true, "the stream ends with the server");
});

test("ui: the server binds to 127.0.0.1 only, and takes a free port when the default one is taken", async () => {
  const dir = newProject();
  for (const host of ["0.0.0.0", "::", "192.0.2.1", "localhost"]) {
    await assert.rejects(startUiServer({ root: dir, port: 0, host, log: () => {} }), /listens on 127\.0\.0\.1 only/);
  }
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
  const taken = (blocker.address() as net.AddressInfo).port;
  try {
    await assert.rejects(startUiServer({ root: dir, port: taken, log: () => {} }), /cannot listen on 127\.0\.0\.1:/);
    const ui = await startUiServer({ root: dir, port: taken, fallback: true, log: () => {} });
    servers.push(ui);
    assert.notEqual(ui.port, taken);
  } finally {
    blocker.close();
  }
});

test("ui: every module of the page passes node --check, and the page names only its own files", () => {
  const files = fs.readdirSync(UI_DIR);
  const modules = files.filter((f) => f.endsWith(".js"));
  assert.ok(modules.includes("app.js") && modules.includes("markdown.js"));
  for (const f of modules) {
    const r = spawnSync(process.execPath, ["--check", path.join(UI_DIR, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  // No request leaves the machine: no absolute URLs in the page's files, and no innerHTML anywhere.
  for (const f of files) {
    const text = fs.readFileSync(path.join(UI_DIR, f), "utf8");
    assert.doesNotMatch(text.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ""), /(src|href)=["']?(https?:)?\/\//, f);
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
  }
});

// A minimal DOM for the renderer's DOM layer: elements, text nodes, fragments and attributes.
class FakeNode {
  tag: string;
  text: string;
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  appendChild(c: FakeNode) { if (c.tag === "#fragment") this.children.push(...c.children); else this.children.push(c); return c; }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
}
const fakeDoc = {
  createElement: (t: string) => new FakeNode(t),
  createTextNode: (t: string) => new FakeNode("#text", t),
  createDocumentFragment: () => new FakeNode("#fragment"),
};
const walk = (n: FakeNode): FakeNode[] => [n, ...n.children.flatMap(walk)];

test("ui: the Markdown renderer keeps HTML, event handlers, javascript: links and entities inert", async () => {
  const md = await import(pathToFileURL(path.join(UI_DIR, "markdown.js")).href);
  const evil = [
    "# Title <script>alert(1)</script>",
    "<img src=x onerror=alert(1)> and <b onclick=\"x()\">bold</b> &lt;script&gt; &amp;",
    "[click](javascript:alert(1)) [data](data:text/html,<script>x</script>) [ok](https://example.com/a) [frag](#/card/DEMO-1) [spaced]( JaVaScRiPt:alert(1))",
    "- **strong <i>x</i>** and `code <script>`",
    "```",
    "<script>fence()</script>",
    "```",
  ].join("\n\n");
  const tree = md.parseMarkdown(evil, 3);
  const root = new FakeNode("div");
  root.appendChild(md.toDom(tree, fakeDoc));
  const nodes = walk(root);
  const tags = new Set(nodes.map((n) => n.tag));
  for (const t of tags) assert.ok(t === "div" || t === "#text" || md.TAGS.has(t), `unexpected element <${t}>`);
  assert.ok(!tags.has("script") && !tags.has("img") && !tags.has("b") && !tags.has("i"));
  const attrs = nodes.flatMap((n) => [...n.attrs.keys()]);
  for (const a of attrs) assert.ok(["href", "rel", "target"].includes(a), `unexpected attribute ${a}`);
  const hrefs = nodes.filter((n) => n.attrs.has("href")).map((n) => n.attrs.get("href"));
  assert.deepEqual(hrefs, ["https://example.com/a", "#/card/DEMO-1"]);
  const text = nodes.filter((n) => n.tag === "#text").map((n) => n.text).join("");
  assert.match(text, /<script>alert\(1\)<\/script>/, "markup stays as text");
  assert.match(text, /<img src=x onerror=alert\(1\)>/);
  assert.match(text, /&lt;script&gt; &amp;/, "entities are not decoded");
  assert.match(text, /<script>fence\(\)<\/script>/);
  assert.equal(nodes.find((n) => n.tag === "h3")?.children[0]?.text, "Title <script>alert(1)</script>", "a # heading becomes the level asked for");
  for (const u of ["javascript:alert(1)", " javascript:x", "JAVASCRIPT:x", "java\nscript:x", "vbscript:x", "data:text/html,x", "/relative", "//example.com"]) assert.equal(md.safeHref(u), null, u);
  assert.equal(md.toDom([{ tag: "script", children: ["x"] }, { tag: "a", href: "javascript:x", children: ["y"] }], fakeDoc).children.map((n: FakeNode) => n.tag).join(","), "#text,a");
  assert.equal(walk(md.toDom([{ tag: "a", href: "javascript:x", children: ["y"] }], fakeDoc)).some((n) => n.attrs.has("href")), false, "toDom checks links again");
});

test("ui: the page folder is embedded in the binary and shipped in the npm package", () => {
  const root = path.resolve(UI_DIR, "..", "..", "..");
  const build = fs.readFileSync(path.join(root, "scripts", "build-binary.sh"), "utf8");
  const embedded = /for \(const d of (\[[^\]]*\])\)/.exec(build);
  assert.ok(embedded, "the build script lists the folders it embeds");
  assert.ok((JSON.parse(embedded[1]!) as string[]).includes(path.relative(root, UI_DIR)), "the build embeds src/ui/web");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { files: string[] };
  assert.ok(pkg.files.includes("src/ui/web"));
});
