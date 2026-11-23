// `mw ui`: the GUI's HTTP server (docs/specification.md section 16). It serves the page in
// src/ui/web/ and exposes the MCP tool layer (callToolStructured, listTools) over HTTP, on the
// loopback interface only, to a browser holding this start's access token.
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { callToolStructured, listTools } from "../mcpserver/server.ts";
import type { ToolContext } from "../mcpserver/tool.ts";
import { UI_DIR } from "../paths.ts";
import { Project } from "../project.ts";
import { MwError } from "../util.ts";

/** The port `mw ui` asks for first; when it is taken, the system picks a free one. */
export const DEFAULT_PORT = 7341;
/** The most a request body may hold. */
export const MAX_BODY = 1024 * 1024;
const HEARTBEAT_MS = 20_000;
const POLL_MS = 3_000;
const DEBOUNCE_MS = 150;

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  // Every answer depends on the project as it is now, and the token: nothing is cached.
  "Cache-Control": "no-store",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

export interface UiServerOptions {
  /** The project root. */
  root: string;
  /** Absent: DEFAULT_PORT; 0: a free one. */
  port?: number;
  /** Only 127.0.0.1 is accepted; anything else is refused before binding. */
  host?: string;
  /** When the port is taken, take a free one instead of failing (the default port only). */
  fallback?: boolean;
  /** The folder of the page (default UI_DIR); tests only. */
  webDir?: string;
  log?(line: string): void;
}

export interface UiServer {
  port: number;
  token: string;
  /** The link that signs the browser in: http://127.0.0.1:<port>/?token=... */
  url: string;
  close(): Promise<void>;
}

/** Every file of the page folder, by its URL path (`/app.js`), read once at start: the static allowlist. */
function staticFiles(dir: string): Map<string, { file: string; type: string }> {
  const out = new Map<string, { file: string; type: string }>();
  const walk = (d: string, prefix: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs, `${prefix}${e.name}/`);
      else if (e.isFile() && TYPES[path.extname(e.name)]) out.set(`/${prefix}${e.name}`, { file: abs, type: TYPES[path.extname(e.name)]! });
    }
  };
  walk(dir, "");
  const index = out.get("/index.html");
  if (!index) throw new MwError("ui/no-page", `the GUI's page is missing: no index.html in ${dir}`);
  out.set("/", index);
  return out;
}

function sameToken(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const SIGN_IN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MergeWright: sign in</title></head>
<body><main><h1>Not signed in</h1><p>This page needs the link that <code>mw ui</code> printed in the terminal (it carries this start's access token). Open that link, or run <code>mw ui</code> again for a new one.</p></main></body></html>
`;

/** A fingerprint of what a board shows: the card files and the run states, by name, size and time. */
function boardStamp(dirs: string[]): string {
  const parts: string[] = [];
  const add = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      parts.push(`${d}:none`);
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { if (depth > 0) add(abs, depth - 1); continue; }
      try {
        const s = fs.statSync(abs);
        parts.push(`${abs}:${s.size}:${s.mtimeMs}`);
      } catch {
        // gone between the listing and the stat
      }
    }
  };
  for (const d of dirs) add(d, 1);
  return parts.sort().join("\n");
}

/**
 * Change notices for the event stream: fs.watch on the card folder and the run-state folder, and a
 * slow poll of their fingerprint for what fs.watch misses (a folder made later, network filesystems).
 * Runs only while a client listens.
 */
class BoardWatch {
  private watchers: fs.FSWatcher[] = [];
  private poll: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private stamp = "";
  count = 0;
  private dirs: string[];
  private onChange: (n: number) => void;
  constructor(dirs: string[], onChange: (n: number) => void) {
    this.dirs = dirs;
    this.onChange = onChange;
  }
  get active(): boolean {
    return this.poll !== undefined;
  }
  start(): void {
    if (this.active) return;
    this.stamp = boardStamp(this.dirs);
    for (const d of this.dirs) {
      try {
        const w = fs.watch(d, { recursive: true }, () => this.changed());
        w.on("error", () => {}); // the poll still covers it
        this.watchers.push(w);
      } catch {
        // missing folder or no recursive watch here: the poll covers it
      }
    }
    this.poll = setInterval(() => {
      const now = boardStamp(this.dirs);
      if (now !== this.stamp) this.changed();
    }, POLL_MS);
    this.poll.unref();
  }
  private changed(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.stamp = boardStamp(this.dirs);
      this.count++;
      this.onChange(this.count);
    }, DEBOUNCE_MS);
  }
  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    clearInterval(this.poll);
    clearTimeout(this.debounce);
    this.poll = undefined;
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY) { reject(new HttpError(413, `the request body is larger than ${MAX_BODY} bytes`)); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { req.pause(); reject(new HttpError(413, `the request body is larger than ${MAX_BODY} bytes`)); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Start the GUI's server. Resolves once it listens. */
export async function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const host = opts.host ?? "127.0.0.1";
  // Loopback only, never every interface: the token is the only lock, and it travels in clear HTTP.
  if (host !== "127.0.0.1") throw new MwError("ui/not-loopback", `mw ui listens on 127.0.0.1 only, not on '${host}'`);
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const files = staticFiles(opts.webDir ?? UI_DIR);
  const project = new Project(opts.root);
  const token = randomBytes(32).toString("base64url");
  const server = http.createServer();
  server.headersTimeout = 30_000;
  server.requestTimeout = 0; // the event stream stays open

  const wanted = opts.port ?? DEFAULT_PORT;
  const listen = (port: number) => new Promise<number>((resolve, reject) => {
    const onError = (e: Error) => { server.off("listening", onListening); reject(e); };
    const onListening = () => { server.off("error", onError); resolve((server.address() as AddressInfo).port); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  let port: number;
  try {
    port = await listen(wanted);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || !opts.fallback) {
      throw new MwError("ui/port", `mw ui cannot listen on 127.0.0.1:${wanted}: ${(e as Error).message}${(e as NodeJS.ErrnoException).code === "EADDRINUSE" ? " (pass another --port, or leave --port out to take a free one)" : ""}`);
    }
    port = await listen(0);
  }

  const cookieName = `mw_ui_${port}`;
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const clients = new Set<http.ServerResponse>();
  const watch = new BoardWatch([path.join(opts.root, "cards"), path.join(project.workDir, "runs")], (n) => {
    for (const c of clients) c.write(`event: changed\ndata: ${JSON.stringify({ count: n })}\n\n`);
  });
  const heartbeat = setInterval(() => { for (const c of clients) c.write(": heartbeat\n\n"); }, HEARTBEAT_MS);
  heartbeat.unref();

  const send = (res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...extra });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, value: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
  const fail = (res: http.ServerResponse, status: number, message: string) => json(res, status, { error: message });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // DNS rebinding: a page on another name that resolves here sends its own Host.
    if (!hosts.has(req.headers.host ?? "")) return fail(res, 403, `wrong Host header; open http://127.0.0.1:${port}/`);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const method = req.method ?? "GET";

    // Signing in: the printed link's token becomes a cookie, and leaves the address bar.
    const given = url.searchParams.get("token");
    if (method === "GET" && url.pathname === "/" && given !== null) {
      if (!sameToken(given, token)) return send(res, 401, "text/html; charset=utf-8", SIGN_IN_PAGE);
      return send(res, 303, "text/plain; charset=utf-8", "signed in\n", {
        "Set-Cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        Location: "/",
      });
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!sameToken(cookieValue(req.headers.cookie, cookieName), token) && !sameToken(bearer, token)) {
      return url.pathname.startsWith("/api/") ? fail(res, 401, "not signed in: open the link mw ui printed in the terminal") : send(res, 401, "text/html; charset=utf-8", SIGN_IN_PAGE);
    }

    if (method === "POST") {
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(origin)) return fail(res, 403, "cross-origin request refused");
      const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (type !== "application/json") return fail(res, 415, "state-changing requests must be sent as Content-Type: application/json");
      const m = /^\/api\/tool\/([a-z0-9_]+)$/.exec(url.pathname);
      if (!m) return fail(res, 404, "no such API route");
      const body = await readBody(req);
      let args: unknown;
      try {
        args = body.trim() ? JSON.parse(body) : {};
      } catch {
        return fail(res, 400, "the request body is not valid JSON");
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) return fail(res, 400, "the request body must be a JSON object of the tool's arguments");
      const abort = new AbortController();
      res.on("close", () => { if (!res.writableFinished) abort.abort(); });
      const ctx: ToolContext = { root: opts.root, project: () => new Project(opts.root), signal: abort.signal, log };
      // Every tool answer is 200 with isError telling success from refusal (the data of a refusal, such
      // as lint findings, comes with it); non-2xx is kept for the transport: sign-in, checks, bad requests.
      const r = await callToolStructured(m[1]!, args as Record<string, unknown>, ctx);
      return json(res, 200, { text: r.text, data: r.data ?? null, isError: r.isError });
    }
    if (method !== "GET" && method !== "HEAD") return fail(res, 405, `${method} is not allowed`);

    if (url.pathname === "/api/tools") return json(res, 200, { tools: await listTools(new Project(opts.root)) });
    if (url.pathname === "/api/events") {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
      res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ count: watch.count })}\n\n`);
      clients.add(res);
      watch.start();
      res.on("close", () => {
        clients.delete(res);
        if (!clients.size) watch.stop();
      });
      return;
    }
    if (url.pathname.startsWith("/api/")) return fail(res, 404, "no such API route");
    const f = files.get(url.pathname);
    if (!f) return send(res, 404, "text/plain; charset=utf-8", "not found\n");
    return send(res, 200, f.type, method === "HEAD" ? "" : fs.readFileSync(f.file));
  };

  server.on("request", (req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) {
        // The rest of an oversized body is not read: answer, then drop the connection.
        if (!res.headersSent) { res.setHeader("Connection", "close"); fail(res, e.status, e.message); }
        res.on("finish", () => req.destroy());
        return;
      }
      log(`mw ui: ${req.method} ${req.url?.split("?")[0]} failed: ${(e as Error)?.stack ?? String(e)}`);
      if (!res.headersSent) fail(res, 500, "internal error; the terminal running mw ui has the details");
      else res.end();
    });
  });

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    close: () => new Promise<void>((resolve) => {
      clearInterval(heartbeat);
      watch.stop();
      for (const c of clients) c.end();
      clients.clear();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
