// Open Notebook (https://github.com/lfnovo/open-notebook) as the documentation mirror, for MergeWright
// (package API v1). Endpoints from its docs/7-DEVELOPMENT/api-reference.md (prefix /api, port 5055,
// auth `Authorization: Bearer <password>`) and, for request and response fields, from
// api/routers/notebooks.py, api/routers/sources.py and api/models.py; search checked
// against a live server's OpenAPI document (version 0.1.0).
//
// Each documentation file is one text source whose title is its repository-relative path. A batch reads
// each file as a git blob of one commit (host.docs.blob), never from the working tree: a symbolic link
// or a binary file is skipped, and a path that is not under docs.paths is refused. A batch replayed from
// the queue (kind `open-notebook`) sends exactly what that commit held.

const TIMEOUT_MS = 30_000;
const PAGE = 100; // GET /api/sources: limit is 1..100
/** The length of a hit's snippet. */
export const SNIPPET_CHARS = 160;

const trimSlash = (u) => String(u).replace(/\/+$/, "");
/** The URL without userinfo or query string, for messages. */
const shown = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return String(url).split("?")[0]; } };
const errText = (e) => e?.message ?? String(e);

/** A number the server sent as a number or a numeric string; undefined otherwise. */
function numeric(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * At most `max` characters of `text` (whitespace collapsed) around the first place a word of `query`
 * occurs (case-insensitive), else its start. Used for text search, whose hits carry no passage.
 */
export function snippet(text, query, max = SNIPPET_CHARS) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  const words = [query.trim(), ...query.split(/\s+/).filter((w) => w.length >= 3)].map((w) => w.toLowerCase()).filter(Boolean);
  let at = -1;
  for (const w of words) {
    at = lower.indexOf(w);
    if (at >= 0) break;
  }
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - Math.floor(max / 4), flat.length - max));
  return flat.slice(start, start + max).trim();
}

export function activate(host) {
  const c = host.config;
  const s = {
    url: String(c.url),
    name: typeof c.name === "string" && c.name ? c.name : host.project.name,
    keyEnv: typeof c.key_env === "string" && c.key_env ? c.key_env : "OPEN_NOTEBOOK_PASSWORD",
  };
  const api = (rel) => {
    const base = trimSlash(s.url);
    return `${base.endsWith("/api") ? base : `${base}/api`}${rel}`;
  };
  const headers = () => {
    const key = host.env(s.keyEnv);
    return key ? { authorization: `Bearer ${key}` } : {};
  };
  const call = (rel, opts = {}) => host.http.json(api(rel), { headers: headers(), timeoutMs: TIMEOUT_MS, ...opts });

  /** GET /api/notebooks -> NotebookResponse[]. */
  const listNotebooks = async () => {
    const r = await call("/notebooks");
    return Array.isArray(r) ? r : [];
  };
  const findNotebook = async () => (await listNotebooks()).find((n) => n.name === s.name);

  /** The project's notebook, created (POST /api/notebooks {name, description}) when there is none. */
  async function ensureNotebook() {
    const found = await findNotebook();
    if (found) return found.id;
    const made = await call("/notebooks", { method: "POST", body: { name: s.name, description: `Documentation of ${host.project.name}, mirrored by MergeWright` } });
    return made.id;
  }

  /** GET /api/sources?notebook_id=ID&limit=100&offset=N, every page. */
  async function listSources(notebookId) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const q = new URLSearchParams({ notebook_id: notebookId, limit: String(PAGE), offset: String(offset), sort_by: "created", sort_order: "asc" });
      const r = await call(`/sources?${q}`);
      const page = Array.isArray(r) ? r : [];
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }

  /**
   * Apply a batch: replace each changed file's source with its blob in `batch.commit` (HEAD when absent),
   * remove each deleted file's source. Refused paths and skipped files (links, binaries) are warnings,
   * reported without contacting the service; `sent` counts the files changed or removed in the notebook.
   * Throws on any service error.
   */
  async function syncDocs(batch) {
    const warnings = [];
    const paths = [...new Set([...(batch.changed ?? []), ...(batch.deleted ?? [])])];
    if (!paths.length) return { warnings, sent: 0 };
    const commit = batch.commit ?? host.docs.head();
    const blobs = new Map();
    for (const rel of paths) {
      const blob = host.docs.blob(commit, rel);
      if (blob.kind === "skipped") warnings.push(blob.why);
      else blobs.set(rel, blob);
    }
    if (!blobs.size) return { warnings, sent: 0 };
    const notebookId = await ensureNotebook();
    const byTitle = new Map();
    for (const src of await listSources(notebookId)) if (src.title) byTitle.set(src.title, [...(byTitle.get(src.title) ?? []), src.id]);
    let sent = 0;
    for (const [rel, blob] of blobs) {
      for (const id of byTitle.get(rel) ?? []) await call(`/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
      // POST /api/sources/json (the JSON form of POST /api/sources). UNVERIFIED: that `embed` with
      // `async_processing` returns at once and embeds on the worker without failing when no embedding
      // model is configured (a worker failure then shows on the source, not here).
      if (blob.kind === "file") await call("/sources/json", { method: "POST", body: { type: "text", notebooks: [notebookId], title: rel, content: blob.content, embed: true, async_processing: true } });
      sent++;
    }
    return { warnings, sent };
  }

  /**
   * POST /api/search {query, type, limit, notebook_id, search_sources, search_notes}. A vector hit is
   * `{id, parent_id, title, matches: [passage, ...], similarity}`; a text hit `{id, parent_id, title,
   * relevance}` with no passage and an unbounded, unsorted rank. So text hits are sorted by relevance,
   * and their snippet is taken from the source's `full_text` (GET /api/sources/{id}) around the query.
   */
  async function searchDocs(query, limit = 5, type = "vector") {
    const notebook = await findNotebook();
    if (!notebook) return [];
    const r = await call("/search", { method: "POST", body: { query, type, limit, notebook_id: notebook.id, search_sources: true, search_notes: false } });
    const hits = (r?.results ?? []).map((x) => {
      const passage = Array.isArray(x.matches) ? x.matches.find((m) => typeof m === "string" && m.trim()) : x.matches ?? x.content ?? x.text ?? x.snippet;
      return {
        id: String(x.parent_id ?? x.id ?? ""),
        title: String(x.title ?? x.parent_title ?? x.source_title ?? x.id ?? ""),
        text: typeof passage === "string" ? passage : "",
        score: numeric(x.similarity) ?? numeric(x.relevance) ?? numeric(x.score),
      };
    });
    if (type === "text") hits.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    await Promise.all(hits.map(async (h) => {
      if (h.text.trim() || !h.id.startsWith("source:")) return;
      try {
        const src = await call(`/sources/${encodeURIComponent(h.id)}`);
        if (typeof src?.full_text === "string") h.text = src.full_text;
      } catch {
        // no passage then: the title still says where to look
      }
    }));
    return hits.slice(0, limit).map((h) => ({ title: h.title, text: snippet(h.text, query), ...(h.score !== undefined ? { score: h.score } : {}) }));
  }

  /** POST /api/search/ask/simple: an answer written from the notebook's sources, with the server's default chat model. */
  async function askDocs(question) {
    const notebook = await findNotebook();
    if (!notebook) throw new Error(`Open Notebook has no notebook named '${s.name}' yet (run 'mw open-notebook sync --all')`);
    const defaults = await call("/models/defaults");
    const model = defaults?.default_chat_model;
    if (!model) throw new Error("Open Notebook has no default chat model; set one in its Models page");
    const r = await call("/search/ask/simple", { method: "POST", timeoutMs: 180_000, body: { question, notebook_id: notebook.id, strategy_model: model, answer_model: model, final_answer_model: model } });
    return r?.answer ?? "";
  }

  const failed = (e) => { throw new Error(`the documentation service did not answer: ${errText(e)}`); };
  const summary = (b) => `docs -> notebook '${s.name}': ${b.changed.length} changed, ${b.deleted.length} deleted`;

  return {
    async docsSync(changed, deleted, commit) {
      if (!changed.length && !deleted.length) return "sent";
      // The batch names its commit, so a retry from the queue sends what that commit held.
      const batch = { changed, deleted, commit };
      try {
        const { warnings } = await syncDocs(batch);
        for (const w of warnings) host.log(w);
        return "sent";
      } catch (e) {
        host.queue.enqueue("open-notebook", summary(batch), batch, errText(e));
        return "queued";
      }
    },
    deliverers: {
      async "open-notebook"(payload) {
        const { warnings } = await syncDocs(payload ?? {});
        for (const w of warnings) host.log(w);
      },
    },
    async searchDocs(query, limit, opts) {
      return (await searchDocs(query, limit, opts?.text ? "text" : "vector")).map((h) => `${h.title}${h.score !== undefined ? ` (${h.score.toFixed(2)})` : ""}${h.text ? `: ${h.text}` : ""}`);
    },
    commands: {
      /** `mw open-notebook sync --all` (rebuild the notebook from the last commit) and `mw open-notebook ask <question>`. */
      async "open-notebook"(args, out) {
        const sub = args._[1];
        try {
          if (sub === "sync") {
            if (args.flags.all !== true) { host.log("use 'mw open-notebook sync --all' to rebuild the notebook from the repository (cards sync their own changes when they merge)"); return 2; }
            const { warnings, sent } = await syncDocs({ changed: host.docs.files(), deleted: [] }).catch(failed);
            for (const w of warnings) out(`skipped: ${w}`);
            out(`${sent} document(s) of the last commit synced to notebook '${s.name}'${warnings.length ? `, ${warnings.length} skipped` : ""}`);
            return 0;
          }
          if (sub === "ask") {
            const q = args._.slice(2).join(" ");
            if (!q) { host.log("give the question to ask"); return 2; }
            out(await askDocs(q).catch(failed));
            return 0;
          }
        } catch (e) {
          host.log(errText(e));
          return 1;
        }
        host.log("use 'mw open-notebook sync --all' or 'mw open-notebook ask <question>'");
        return 2;
      },
    },
    tools: [
      {
        name: "mw_docs_ask",
        description: "Ask a question; Open Notebook answers from the project's documentation.",
        inputSchema: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string", description: "the question" } } },
        handler: (a) => askDocs(String(a.question)).catch(failed),
      },
      {
        name: "mw_docs_sync",
        description: "Send documentation files as of the last commit to Open Notebook: the given paths, or every documentation file with all=true.",
        write: true,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            paths: { type: "array", items: { type: "string" }, description: "repository-relative paths under docs.paths" },
            all: { type: "boolean", description: "every tracked documentation file" },
          },
        },
        async handler(a) {
          const tracked = host.docs.files();
          const files = a.all === true ? tracked : Array.isArray(a.paths) ? a.paths.filter((p) => typeof p === "string") : [];
          if (!files.length) throw new Error("give 'paths' or all=true");
          const known = new Set(tracked);
          const changed = files.filter((f) => known.has(f));
          const deleted = files.filter((f) => !known.has(f));
          const { warnings, sent } = await syncDocs({ changed, deleted }).catch(failed);
          return { synced: sent, skipped: warnings.length, removed: deleted, warnings };
        },
      },
    ],
    checks: [
      {
        name: "docs",
        async run() {
          const where = `${shown(s.url)} notebook '${s.name}', ${host.env(s.keyEnv) ? `${s.keyEnv} set` : `${s.keyEnv} NOT set`}`;
          try {
            const all = await listNotebooks();
            // A project whose documentation was never synced has no notebook yet; that is no fault.
            const exists = all.some((n) => n.name === s.name);
            return { ok: true, detail: `reachable, ${all.length} notebook(s)${exists ? "" : `; notebook '${s.name}' not created yet (the first docs sync creates it)`}; ${where}` };
          } catch (e) {
            return { ok: false, detail: `NOT reachable (${errText(e)}); ${where}` };
          }
        },
      },
    ],
  };
}
