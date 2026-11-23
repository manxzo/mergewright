// The model catalogue behind the TUI's picker and its Models screen. A free-text entry is always
// allowed: these lists are suggestions, not limits.
import { httpJson, trimSlash } from "../integrations/common.ts";

/** Harness ids a role can run on (src/model/role.ts). */
export const HARNESSES = ["claude", "codex", "local", "shell", "mock"] as const;

/** Model ids per harness. `local` is the fallback list when the endpoint cannot be asked. */
export const MODELS: Record<string, readonly string[]> = {
  claude: ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"],
  codex: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-astra-900k"],
  // Common llama.cpp aliases (the first is Letta's default chat model), then an Ollama tag.
  local: ["qwen3.6-35b-a3b", "qwen3.5-9b", "qwen3.5:9b"],
  shell: [],
  mock: [],
};

export interface LiveModels {
  endpoint: string;
  /** Present when the endpoint answered. */
  models?: string[];
  error?: string;
}

/** Parse `GET <endpoint>/models`: the OpenAI shape `{data: [{id}]}` or Ollama's `{models: [{name}]}`. */
export function parseModelList(body: unknown): string[] {
  const b = (body ?? {}) as { data?: { id?: unknown }[]; models?: { name?: unknown; model?: unknown }[] };
  const ids = Array.isArray(b.data) ? b.data.map((m) => m?.id) : Array.isArray(b.models) ? b.models.map((m) => m?.name ?? m?.model) : [];
  return [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))].sort();
}

/** Ask a local endpoint (OpenAI-compatible, e.g. Ollama's `/v1`) which models it serves. Never throws. */
export async function fetchLocalModels(endpoint: string, key?: string, timeoutMs = 3000): Promise<LiveModels> {
  try {
    const body = await httpJson(`${trimSlash(endpoint)}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, timeoutMs });
    return { endpoint, models: parseModelList(body) };
  } catch (e) {
    return { endpoint, error: e instanceof Error ? e.message : String(e) };
  }
}

/** What the picker offers for a role field. `live` replaces the local fallback list when the endpoint answered. */
export function optionsFor(field: string, harness: string | undefined, live?: LiveModels): string[] {
  if (field === "runs") return [...HARNESSES];
  if (field === "model" || field === "profile") {
    if (harness === "local") return live?.models?.length ? live.models : [...MODELS.local!];
    if (field === "profile") return [];
    return [...(MODELS[harness ?? ""] ?? [])];
  }
  return [];
}
