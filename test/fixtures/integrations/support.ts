// Test support for the integration tests: projects with a patched config, local HTTP mocks, fake executables.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Project } from "../../../src/project.ts";
import { newProject, patchConfig, tmpDir } from "../../helpers.ts";

export const FIXTURES = path.dirname(new URL(import.meta.url).pathname);

/** A fresh project whose mergewright.yaml is merged with `patch` (`patchConfig`: packages it names are installed). */
export function projectWith(patch: Record<string, unknown> = {}): { dir: string; project: Project } {
  const dir = newProject();
  patchConfig(dir, patch);
  const project = new Project(dir);
  if (project.diag.errors.length) throw new Error(`test config invalid: ${project.diag.errors.map((e) => e.message).join("; ")}`);
  return { dir, project };
}

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export type Route = (req: Recorded) => { status?: number; body?: unknown } | undefined;

export interface Mock {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

/** An HTTP server on 127.0.0.1 answering JSON through `route` (undefined = 404). */
export async function mockServer(route: Route): Promise<Mock> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      let body: unknown = undefined;
      try { body = data ? JSON.parse(data) : undefined; } catch { body = data; }
      const rec: Recorded = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body };
      requests.push(rec);
      let r: { status?: number; body?: unknown } | undefined;
      try { r = route(rec); } catch (e) { r = { status: 500, body: { detail: String(e) } }; }
      const status = r ? r.status ?? 200 : 404;
      const payload = r?.body === undefined ? (r ? "" : JSON.stringify({ detail: "not found" })) : JSON.stringify(r.body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** A URL on 127.0.0.1 where nothing listens. */
export async function deadUrl(): Promise<string> {
  const m = await mockServer(() => undefined);
  await m.close();
  return m.url;
}

/** Put a fixture script on PATH under `name` (in a fresh bin directory). Returns a restore function. */
export function installFake(name: string, fixture: string): { bin: string; restore: () => void } {
  const bin = tmpDir("mw-bin-");
  const target = path.join(bin, name);
  fs.copyFileSync(path.join(FIXTURES, fixture), target);
  fs.chmodSync(target, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before ?? ""}`;
  return { bin, restore: () => { process.env.PATH = before; } };
}

export function queueFiles(dir: string): string[] {
  const q = path.join(dir, ".mergewright", "local", "queue");
  return fs.existsSync(q) ? fs.readdirSync(q).filter((f) => f.endsWith(".json")).sort() : [];
}

export function queueItems(dir: string): { kind: string; summary: string; payload: unknown; attempts: number; lastError?: string; holdPid?: number }[] {
  return queueFiles(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, ".mergewright", "local", "queue", f), "utf8")));
}

/** Quote a path for a command template. */
export function q(p: string): string {
  return `"${p.replace(/(["\\])/g, "\\$1")}"`;
}
