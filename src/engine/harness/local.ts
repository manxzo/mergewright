// Harness 'local': an OpenAI-compatible chat completions endpoint (Ollama, llama.cpp, vLLM, ...).
// Advisory only. See docs/design/engine.md section 7.
import { HttpError, readBounded } from "../../integrations/common.ts";
import type { Harness, HarnessRequest, HarnessResult, Usage } from "../types.ts";
import { saveText } from "./proc.ts";
import { classified } from "./transient.ts";

interface Completion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

/** The request body sent to `<endpoint>/chat/completions`. */
export function localBody(req: HarnessRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.role.profile ?? req.role.model,
    messages: [{ role: "user", content: req.prompt }],
    stream: false,
  };
  if (req.outputSchema) body.response_format = { type: "json_schema", json_schema: { name: req.outputKind, schema: req.outputSchema } };
  return body;
}

type Attempt =
  | { kind: "response"; status: number; body: string }
  | { kind: "unreachable"; error: string }
  | { kind: "refused"; error: string }
  | { kind: "timeout" }
  | { kind: "aborted" };

async function post(endpoint: string, key: string | undefined, body: string, timeout: AbortSignal, abort?: AbortSignal): Promise<Attempt> {
  const signal = abort ? AbortSignal.any([timeout, abort]) : timeout;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/chat/completions`, { method: "POST", headers, body, signal });
    // Bounded: a body over MAX_RESPONSE_BYTES is refused, not held in memory.
    return { kind: "response", status: res.status, body: await readBounded(res) };
  } catch (e) {
    if (abort?.aborted) return { kind: "aborted" };
    if (timeout.aborted) return { kind: "timeout" };
    if (e instanceof HttpError) return { kind: "refused", error: e.message };
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    return { kind: "unreachable", error: cause?.code ?? cause?.message ?? (e as Error).message };
  }
}

const harness: Harness = {
  async run(req) {
    const started = Date.now();
    const seconds = () => Math.round((Date.now() - started) / 100) / 10;
    const primary = req.env.MW_LOCAL_ENDPOINT;
    const fallback = req.env.MW_LOCAL_FALLBACK;
    const key = req.env.MW_LOCAL_KEY || undefined;
    if (!primary && !fallback) return { ok: false, text: "", seconds: 0, error: "local: no endpoint configured (local_models.endpoint)" };
    const body = localBody(req);
    if (!body.model) return { ok: false, text: "", seconds: 0, error: "local: the role names no profile or model" };
    const payload = JSON.stringify(body);
    const timeoutMs = Math.max(1, req.limits.minutes * 60_000);
    const timeout = AbortSignal.timeout(timeoutMs);
    const endpoints = [primary, fallback].filter((e, i, all): e is string => !!e && all.indexOf(e) === i);
    const notes: string[] = [];
    let last: { endpoint: string; status: number; body: string } | undefined;
    for (const endpoint of endpoints) {
      if (req.signal?.aborted) return { ok: false, text: "", seconds: seconds(), error: "aborted" };
      const a = await post(endpoint, key, payload, timeout, req.signal);
      if (a.kind === "aborted") return { ok: false, text: "", seconds: seconds(), error: "aborted" };
      if (a.kind === "timeout") {
        return { ok: false, text: "", seconds: seconds(), timedOut: true, error: `local: ${endpoint} timed out after ${req.limits.minutes} minute(s)` };
      }
      if (a.kind === "refused") return { ok: false, text: "", seconds: seconds(), error: `local: ${a.error}` };
      if (a.kind === "unreachable") {
        notes.push(`${endpoint} unreachable (${a.error})`);
        continue;
      }
      saveText(req, "local.stdout", a.body);
      last = { endpoint, status: a.status, body: a.body };
      if (a.status >= 500) {
        notes.push(`${endpoint} answered HTTP ${a.status}`);
        continue;
      }
      break;
    }
    saveText(req, "local.stderr", notes.join("\n") + (notes.length ? "\n" : ""));
    // REQ-harness-001: a reset connection on every endpoint is transient (an unreachable one is not).
    if (!last) return classified({ ok: false, text: "", seconds: seconds(), error: `local: ${notes.join("; ")}` });
    return interpret(last, notes, seconds());
  },
};

function interpret(last: { endpoint: string; status: number; body: string }, notes: string[], secs: number): HarnessResult {
  let parsed: Completion | undefined;
  try {
    parsed = JSON.parse(last.body) as Completion;
  } catch {
    parsed = undefined;
  }
  if (last.status < 200 || last.status >= 300) {
    const msg = typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message ?? last.body.trim().split(/\r?\n/)[0]?.slice(0, 200);
    // REQ-harness-001: HTTP 429 and 5xx (and the provider's own words) are classified by the shared table.
    return classified({ ok: false, text: "", seconds: secs, error: `local: ${notes.concat(`${last.endpoint} answered HTTP ${last.status}${msg ? `: ${msg}` : ""}`).join("; ")}` });
  }
  if (!parsed) return { ok: false, text: "", seconds: secs, error: `local: ${last.endpoint} returned a body that is not JSON` };
  const text = (parsed.choices?.[0]?.message?.content ?? "").trim();
  let usage: Usage | undefined;
  if (parsed.usage) {
    usage = {};
    if (parsed.usage.prompt_tokens !== undefined) usage.inputTokens = parsed.usage.prompt_tokens;
    if (parsed.usage.completion_tokens !== undefined) usage.outputTokens = parsed.usage.completion_tokens;
  }
  if (!text) return { ok: false, text: "", usage, seconds: secs, error: `local: ${last.endpoint} returned an empty reply` };
  return { ok: true, text, usage, seconds: secs };
}

export default harness;
