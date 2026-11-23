// JSON-RPC 2.0 over stdio for the MergeWright MCP server: one JSON message per line (MCP stdio
// transport, protocol version 2025-06-18). Requests are handled concurrently and answered as they
// finish; notifications get no reply; a line that is not JSON gets a -32700 error and the server
// keeps reading. stdout carries only protocol messages: every log line goes to stderr.
import readline from "node:readline";

export const PROTOCOL_VERSION = "2025-06-18";
/** Versions a client may ask for; any other request is answered with PROTOCOL_VERSION. */
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];
/** Versions whose tool results may carry `structuredContent` (it came with 2025-06-18). */
export const STRUCTURED_VERSIONS = [PROTOCOL_VERSION];

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type Id = string | number;

/** Thrown by a method handler to answer with a JSON-RPC error. */
export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface Io {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Diagnostics (default: stderr). */
  log?: (line: string) => void;
}

export interface CallContext {
  /** Fires when the client cancels the request (notifications/cancelled). */
  signal: AbortSignal;
}

export type Method = (params: Record<string, unknown>, ctx: CallContext) => unknown | Promise<unknown>;

const isId = (v: unknown): v is Id => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/**
 * Serve `methods` until the input ends and every request in flight has been answered.
 * `notifications/cancelled` aborts the named request, which then gets no reply (as the MCP spec says).
 */
export function serveRpc(io: Io, methods: Record<string, Method>): Promise<void> {
  const log = io.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const pending = new Map<Id, AbortController>();
  const inFlight = new Set<Promise<void>>();
  const send = (msg: object) => io.output.write(`${JSON.stringify(msg)}\n`);
  const fail = (id: Id | null, code: number, message: string, data?: unknown) => send({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });

  const handle = (line: string): void => {
    const text = line.trim();
    if (!text) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      fail(null, PARSE_ERROR, `parse error: ${(e as Error).message}`);
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      fail(null, INVALID_REQUEST, Array.isArray(msg) ? "batches are not supported (protocol 2025-06-18)" : "a message must be a JSON object");
      return;
    }
    const m = msg as Record<string, unknown>;
    const id = isId(m.id) ? m.id : undefined;
    if (m.method === undefined && ("result" in m || "error" in m)) return; // a reply to a request we never send
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      fail(id ?? null, INVALID_REQUEST, "not a JSON-RPC 2.0 request (needs jsonrpc: \"2.0\" and a method)");
      return;
    }
    const params = (m.params && typeof m.params === "object" && !Array.isArray(m.params) ? m.params : {}) as Record<string, unknown>;
    if (m.id === undefined) {
      // A notification: never answered.
      if (m.method === "notifications/cancelled" && isId(params.requestId)) pending.get(params.requestId)?.abort();
      return;
    }
    if (id === undefined) {
      fail(null, INVALID_REQUEST, "the id must be a string or a number");
      return;
    }
    const method = methods[m.method];
    if (!method) {
      fail(id, METHOD_NOT_FOUND, `method not found: ${m.method}`);
      return;
    }
    const ctl = new AbortController();
    pending.set(id, ctl);
    const p = (async () => {
      try {
        const result = await method(params, { signal: ctl.signal });
        if (!ctl.signal.aborted) send({ jsonrpc: "2.0", id, result: result ?? {} });
      } catch (e) {
        if (ctl.signal.aborted) return;
        if (e instanceof RpcError) fail(id, e.code, e.message, e.data);
        else {
          log(`mw mcp serve: ${m.method} failed: ${(e as Error)?.stack ?? String(e)}`);
          fail(id, INTERNAL_ERROR, "internal error; the server's log (standard error) has the details");
        }
      } finally {
        pending.delete(id);
      }
    })();
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: io.input, crlfDelay: Infinity, terminal: false });
    rl.on("line", (line) => {
      try {
        handle(line);
      } catch (e) {
        log(`mw mcp serve: ${(e as Error).stack ?? String(e)}`);
      }
    });
    rl.on("close", () => {
      void Promise.allSettled([...inFlight]).then(() => resolve());
    });
  });
}
