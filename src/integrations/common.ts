// Helpers shared by the integrations: command templates, PATH lookup, HTTP with timeouts.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MwError } from "../util.ts";

/**
 * Split a command template into arguments without a shell. Whitespace separates arguments;
 * single and double quotes group (no expansion of any kind); a backslash escapes the next character
 * outside single quotes.
 */
export function splitCommand(template: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < template.length) cur += template[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === "\\" && i + 1 < template.length) { cur += template[++i]; has = true; continue; }
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (quote) throw new MwError("usage", `unclosed ${quote} in command '${template}'`);
  if (has) out.push(cur);
  return out;
}

/** Replace `{name}` placeholders in every argument. Values are never re-split. */
export function fillArgs(args: string[], values: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in values ? values[k]! : m)));
}

/** Absolute path of an executable found on PATH (or the path itself when it contains a slash). */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const runnable = (f: string) => {
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes("/")) return runnable(cmd) ? path.resolve(cmd) : undefined;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, cmd);
    if (runnable(f)) return f;
  }
  return undefined;
}

export function randomTag(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** An HTTP failure with its status (0 = no response: refused, timed out, DNS). */
export class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, message: string, body = "") {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** A response body larger than this is refused rather than held in memory. */
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/**
 * The body of `res` as text, refusing (and cancelling the transfer) once it passes `max` bytes,
 * whether or not the server announced its length.
 */
export async function readBounded(res: Response, max = MAX_RESPONSE_BYTES): Promise<string> {
  // Status 0: no usable response, so no caller mistakes it for the status the server sent.
  const tooBig = () => new HttpError(0, `${redactUrl(res.url)}: the response is larger than ${Math.round(max / (1024 * 1024))} MB, so it was refused`);
  const announced = Number(res.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > max) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Sent as multipart/form-data instead of `body` (fetch sets the boundary). */
  form?: FormData;
  timeoutMs?: number;
  /** Cancels the request (and the reading of its body) when it fires. */
  signal?: AbortSignal;
}

/** The queue flush a delivery runs in (`Queue.flush`). */
export interface DeliveryScope {
  /** Fires when the flush's time budget runs out: the request in flight is cut, whatever the deliverer passed as options. */
  signal: AbortSignal;
  /** When the budget runs out (`Date.now()` ms; Infinity for none), for blocking commands the signal cannot cut. */
  deadline: number;
}

export const deliveryScope = new AsyncLocalStorage<DeliveryScope>();

/** Why a flush stopped a delivery: the error of a request or command cut by its budget says this. */
export const BUDGET_RAN_OUT = "the flush's time budget ran out";

/** The least time a blocking command in a flush is given, however little of the budget is left. */
export const COMMAND_FLOOR_MS = 250;

/** A delivery cut by the flush's budget (not by the service): an attempt, never a timeout for the breaker. */
export class BudgetCut extends Error {}

/**
 * The timeout of a blocking command (`sh`) run by a delivery: its own `capMs`, or what is left of the
 * flush's budget when that is less (at least COMMAND_FLOOR_MS). `byBudget` says the budget decided, so
 * a command that then times out was cut by the budget (`BudgetCut`), not by its own limit. Outside a
 * flush, or in one without a budget (`mw queue flush`), the cap applies. Throws `BudgetCut` when the
 * budget is already spent, so the command never starts.
 */
export function commandTimeout(capMs: number): { timeoutMs: number; byBudget: boolean } {
  const scope = deliveryScope.getStore();
  if (!scope) return { timeoutMs: capMs, byBudget: false };
  const left = scope.deadline - Date.now();
  if (scope.signal.aborted || left <= 0) throw new BudgetCut(`stopped (${BUDGET_RAN_OUT})`);
  if (left >= capMs) return { timeoutMs: capMs, byBudget: false };
  return { timeoutMs: Math.max(Math.ceil(left), COMMAND_FLOOR_MS), byBudget: true };
}

/**
 * JSON over HTTP with a timeout. Resolves with the parsed body (or undefined for an empty body);
 * rejects with HttpError for a non-2xx status, no response, or a body over MAX_RESPONSE_BYTES. Error
 * messages never include headers.
 */
export async function httpJson(url: string, opts: HttpOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  if (opts.body !== undefined && !opts.form) headers["content-type"] = "application/json";
  const scope = deliveryScope.getStore()?.signal;
  const signals = [AbortSignal.timeout(opts.timeoutMs ?? 10_000), ...(opts.signal ? [opts.signal] : []), ...(scope ? [scope] : [])];
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    // A flush's budget running out is not the service timing out (it does not count for the breaker).
    const why = scope?.aborted ? `stopped (${errMessage(scope.reason)})` : err.name === "TimeoutError" ? "timed out" : opts.signal?.aborted ? "stopped" : err.cause?.code ?? err.message;
    throw new HttpError(0, `${opts.method ?? "GET"} ${redactUrl(url)}: ${why}`);
  }
  let text: string;
  try {
    text = await readBounded(res);
  } catch (e) {
    if (e instanceof HttpError) throw new HttpError(e.status, `${opts.method ?? "GET"} ${e.message}`);
    const err = e as Error;
    throw new HttpError(0, `${opts.method ?? "GET"} ${redactUrl(url)}: ${scope?.aborted ? `stopped (${errMessage(scope.reason)})` : err.name === "TimeoutError" ? "timed out" : err.message}`);
  }
  if (!res.ok) throw new HttpError(res.status, `${opts.method ?? "GET"} ${redactUrl(url)}: HTTP ${res.status} ${text.slice(0, 200)}`, text);
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Drop the query string and any userinfo from a URL for messages. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0]!;
  }
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Stable id of a lesson: SHA-256 of project, topic and title, so a duplicate delivery can be recognised (every memory store uses it). */
export function lessonId(project: string, l: { topic: string; title: string }): string {
  return createHash("sha256").update(`${project}\0${l.topic}\0${l.title}`).digest("hex");
}
