// Letta for MergeWright (package API v1). A self-hosted Letta server (letta/letta:0.16.8; routes from
// the server's /openapi.json):
//   GET    /v1/health/                                   -> {version, status}           (no password)
//   GET    /v1/agents/?name=N&limit=1                    -> [{id, name, ...}]
//   POST   /v1/agents/  {name, model, embedding | embedding_config, memory_blocks, tags, metadata} -> {id, ...}
//   POST   /v1/agents/{id}/archival-memory {text, tags}  -> [{id, text, tags, ...}]       (no trailing slash: 307)
//   GET    /v1/agents/{id}/archival-memory?limit=&ascending=&after= -> [{id, text, tags}]
//   GET    /v1/agents/{id}/archival-memory/search?query=Q&top_k=K -> {results:[{id, content, tags, timestamp}], count}
//   DELETE /v1/agents/{id}/archival-memory/{passage}, DELETE /v1/agents/{id}
// Authentication: `Authorization: Bearer <password>`, from the variable `key_env` names.
//
// One Letta agent per project, named `<agent>-<project name>`, created on first use with the configured
// models; its id is cached in this machine's folder for the package (host.localDir, letta-agent.json).
// Letta 0.16.8 has no handle for an OpenAI-compatible embedding model, so with `embedding_endpoint` (the
// default) the agent is created with an explicit `embedding_config`; without one, `embedding` is sent as a
// handle (`ollama/<model>`). An archival passage holds only text and tags, so a lesson is stored as
// `<title>\n\n<body>` and its metadata as tags: `lesson`, `topic:<topic>`, `project:<name>`,
// `lesson_id:<sha256>` and `card:<id>`.
//
// Timeouts: reads get LETTA_TIMEOUT_MS; writes (archival inserts, agent creation) get `write_timeout_ms`
// (default LETTA_WRITE_TIMEOUT_MS): an insert embeds its text, which can stall while a shared GPU is busy.
import fs from "node:fs";
import path from "node:path";

/** Timeout of a read: health, agent lookup, search, listing. */
export const LETTA_TIMEOUT_MS = 30_000;
/** Default timeout of a write (archival insert, agent creation). */
export const LETTA_WRITE_TIMEOUT_MS = 60_000;
/** Dimensions sent with an embedding endpoint when `embedding_dim` is not set. */
export const LETTA_DEFAULT_EMBEDDING_DIM = 1024;
/** Page size of the archive listing. */
export const LETTA_LIST_PAGE = 500;
/** At most this many pages are read (500 000 passages); a longer archive counts as not listed. */
const LETTA_LIST_PAGES = 1000;
const CACHE = "letta-agent.json";

const oneLine = (t) => String(t).replace(/\s+/g, " ").trim();
const trimSlash = (u) => String(u).replace(/\/+$/, "");
/** The URL without userinfo or query string, for messages. */
const shown = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return String(url).split("?")[0]; } };

/** The embedding part of an agent-creation body: an explicit config with an endpoint, else a handle. */
export function embeddingFields(s) {
  if (!s.embeddingEndpoint) return { embedding: s.embedding };
  return {
    embedding_config: {
      embedding_endpoint_type: "openai",
      embedding_endpoint: s.embeddingEndpoint,
      embedding_model: s.embedding,
      embedding_dim: s.embeddingDim ?? LETTA_DEFAULT_EMBEDDING_DIM,
      embedding_chunk_size: 300,
    },
  };
}

/** The project's agent name. */
export const agentName = (s) => `${s.agent}-${s.project}`;

/** The archival text of a lesson: its title, a blank line, its body. */
export const lessonText = (l) => `${l.title}\n\n${l.body}`;

/** Tags carrying a lesson's metadata; `id` is its lesson id (host.lessonId). */
export function lessonTags(project, l, id) {
  return ["mergewright", "lesson", `topic:${l.topic}`, `project:${project}`, `lesson_id:${id}`, ...(l.card ? [`card:${l.card}`] : [])];
}

/** The settings, with the defaults filled in. The models have no default: they depend on what the Letta server can reach. */
export function settingsOf(config, project) {
  const c = config;
  return {
    url: String(c.url),
    agent: typeof c.agent === "string" && c.agent ? c.agent : "mergewright",
    keyEnv: typeof c.key_env === "string" && c.key_env ? c.key_env : "LETTA_SERVER_PASSWORD",
    model: String(c.model),
    modelFrom: "packages.letta.model",
    embedding: String(c.embedding),
    embeddingEndpoint: c.embedding_endpoint,
    embeddingDim: c.embedding_dim ?? LETTA_DEFAULT_EMBEDDING_DIM,
    writeTimeoutMs: typeof c.write_timeout_ms === "number" ? c.write_timeout_ms : LETTA_WRITE_TIMEOUT_MS,
    project,
  };
}

export function activate(host) {
  const s = settingsOf(host.config, host.project.name);
  const { HttpError } = host.errors;
  const headers = () => {
    const key = host.env(s.keyEnv);
    return key ? { Authorization: `Bearer ${key}` } : {};
  };
  const api = (p) => `${trimSlash(s.url)}${p}`;
  const get = (p) => host.http.json(api(p), { headers: headers(), timeoutMs: LETTA_TIMEOUT_MS });
  const cacheFile = path.join(host.localDir, CACHE);

  function readCache() {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      return c.url === trimSlash(s.url) && c.name === agentName(s) && typeof c.id === "string" && c.id ? c.id : undefined;
    } catch {
      return undefined;
    }
  }
  function writeCache(id) {
    fs.mkdirSync(host.localDir, { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ url: trimSlash(s.url), name: agentName(s), id }, null, 2)}\n`);
    fs.renameSync(tmp, cacheFile);
  }
  const forgetAgent = () => fs.rmSync(cacheFile, { force: true });

  /** The agent record with exactly this name, if the server has one. */
  async function findAgentRecord() {
    const name = agentName(s);
    const reply = await get(`/v1/agents/?name=${encodeURIComponent(name)}&limit=1`);
    return (Array.isArray(reply) ? reply : []).find((a) => !!a && typeof a === "object" && a.name === name && typeof a.id === "string");
  }

  /** The project's agent id: from the cache, else found by name, else created with the configured models. */
  async function ensureAgent() {
    const cached = readCache();
    if (cached) return cached;
    let id = (await findAgentRecord())?.id;
    if (!id) {
      const reply = await host.http.json(api("/v1/agents/"), {
        method: "POST",
        headers: headers(),
        timeoutMs: s.writeTimeoutMs,
        body: {
          name: agentName(s),
          model: s.model,
          ...embeddingFields(s),
          memory_blocks: [{ label: "persona", value: `Archive of the lessons and notes of the MergeWright project '${s.project}'. Its archival memory is written by MergeWright.` }],
          tags: ["mergewright", `project:${s.project}`],
          metadata: { project: s.project, created_by: "mergewright" },
        },
      });
      if (typeof reply?.id !== "string") throw new Error(`Letta did not return an agent id for '${agentName(s)}'`);
      id = reply.id;
    }
    writeCache(id);
    return id;
  }

  /** Run `f` with the agent id; when the cached agent is gone (404), find or create it again once. */
  async function withAgent(f) {
    const fromCache = readCache() !== undefined;
    const id = await ensureAgent();
    try {
      return await f(id);
    } catch (e) {
      if (!(fromCache && e instanceof HttpError && e.status === 404)) throw e;
      forgetAgent();
      return f(await ensureAgent());
    }
  }

  async function insert(id, text, tags) {
    const reply = await host.http.json(api(`/v1/agents/${encodeURIComponent(id)}/archival-memory`), { method: "POST", headers: headers(), timeoutMs: s.writeTimeoutMs, body: { text, tags } });
    return (Array.isArray(reply) ? reply : [reply]).filter((x) => !!x && typeof x === "object");
  }

  const tagsOf = (l) => lessonTags(s.project, l, host.lessonId(l));
  const storeLesson = (l) => withAgent((id) => insert(id, lessonText(l), tagsOf(l)));

  /** Raw archival search of the project agent: `{id, content, tags, timestamp}` per hit. */
  async function searchMemories(query, opts = {}) {
    const limit = opts.limit ?? 5;
    const qs = new URLSearchParams({ query, top_k: String(limit) });
    for (const t of opts.tags ?? []) qs.append("tags", t);
    const reply = await withAgent((id) => get(`/v1/agents/${encodeURIComponent(id)}/archival-memory/search?${qs}`));
    const results = reply?.results;
    return (Array.isArray(results) ? results : [])
      .filter((r) => !!r && typeof r === "object")
      .slice(0, limit)
      .map((r) => ({ id: r.id, content: String(r.content ?? r.text ?? ""), tags: Array.isArray(r.tags) ? r.tags.map(String) : [], timestamp: r.timestamp }));
  }

  /** `title: text` lines for lessons (text = first paragraph of the body, one line), else the first paragraph. */
  async function searchLessons(query, limit) {
    return (await searchMemories(query, { limit })).map((h) => {
      const parts = h.content.split(/\n\s*\n/);
      if (h.tags.includes("lesson") && parts.length > 1) return `${oneLine(parts[0])}: ${oneLine(parts[1])}`;
      return oneLine(parts[0]);
    }).filter(Boolean);
  }

  /**
   * Every passage of the archive, oldest first, paginated with `after`. Undefined when the server's reply
   * is not a listing (an older server) or the archive is longer than the page cap: callers then search per record.
   */
  function listPassages() {
    return withAgent(async (id) => {
      const all = [];
      let after;
      for (let page = 0; page < LETTA_LIST_PAGES; page++) {
        const qs = new URLSearchParams({ limit: String(LETTA_LIST_PAGE), ascending: "true" });
        if (after) qs.set("after", after);
        const reply = await get(`/v1/agents/${encodeURIComponent(id)}/archival-memory?${qs}`);
        if (!Array.isArray(reply)) return undefined;
        const rows = reply.filter((r) => !!r && typeof r === "object" && typeof r.id === "string");
        for (const r of rows) all.push({ id: r.id, text: String(r.text ?? r.content ?? ""), tags: Array.isArray(r.tags) ? r.tags.map(String) : [] });
        if (reply.length < LETTA_LIST_PAGE) return all;
        const last = rows.at(-1)?.id;
        if (!last || last === after) return undefined;
        after = last;
      }
      return undefined;
    });
  }

  /** `lesson_id` tag -> the texts of the passages carrying it, from a listing. */
  function lessonIndex(passages) {
    const out = new Map();
    for (const p of passages) for (const t of p.tags) if (t.startsWith("lesson_id:")) out.set(t, [...(out.get(t) ?? []), oneLine(p.text)]);
    return out;
  }

  /** Is this lesson, with this text, stored? Searched by its title, restricted to its lesson_id tag; a hit counts only with that tag and the lesson's text. */
  async function lessonStored(l) {
    const tag = `lesson_id:${host.lessonId(l)}`;
    const want = oneLine(lessonText(l));
    const hits = await searchMemories(l.title, { limit: 10, tags: [tag] });
    return hits.some((h) => h.tags.includes(tag) && oneLine(h.content) === want);
  }

  /** From the listing when there is one (one listing per batch instead of a search per record), else by search. */
  async function lessonPresent(l, listed) {
    if (!listed) return lessonStored(l);
    return (listed.get(`lesson_id:${host.lessonId(l)}`) ?? []).includes(oneLine(lessonText(l)));
  }

  /** A service that answered with an error about this request (4xx other than 408/429). */
  const refused = (e) => e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
  const failed = (e) => { throw new Error(`Letta did not answer: ${e?.message ?? String(e)}`); };

  return {
    recall: searchLessons,
    search: searchLessons,
    remember: {
      label: `letta (${agentName(s)})`,
      open() {
        // One paginated listing of the archive, then presence is checked locally per record; a listing the
        // server cannot give falls back to a search per record.
        let listed;
        const index = async () => {
          if (listed === undefined) {
            try {
              const all = await listPassages();
              listed = all ? lessonIndex(all) : null;
            } catch (e) {
              if (refused(e)) listed = null; else throw e;
            }
          }
          return listed ?? undefined;
        };
        return { present: async (l) => lessonPresent(l, await index()), store: storeLesson };
      },
      /** The passages whose text contains `match` (case-sensitive), deleted one by one unless `dryRun`. */
      async prune(match, { dryRun }) {
        const all = await listPassages();
        if (!all) throw new Error("Letta did not list the archive (GET /v1/agents/{id}/archival-memory)");
        const hits = all.filter((p) => p.text.includes(match)).map((p) => ({ id: p.id, text: p.text }));
        if (!dryRun && hits.length) {
          await withAgent(async (id) => {
            for (const h of hits) await host.http.json(api(`/v1/agents/${encodeURIComponent(id)}/archival-memory/${encodeURIComponent(h.id)}`), { method: "DELETE", headers: headers(), timeoutMs: LETTA_TIMEOUT_MS });
          });
        }
        return hits;
      },
    },
    tools: [
      {
        name: "mw_letta_add",
        description: "Store free text in the archival memory of the project's Letta agent (created on first use). Stored as written; tags are added to 'mergewright' and 'project:<name>'.",
        write: true,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: { type: "string", description: "what to remember" },
            tags: { type: "array", items: { type: "string" }, description: "extra tags to attach" },
          },
        },
        async handler(a) {
          const tags = [...new Set(["mergewright", `project:${s.project}`, ...(Array.isArray(a.tags) ? a.tags.filter((t) => typeof t === "string") : [])])];
          const rows = await withAgent((id) => insert(id, host.redact(String(a.text)), tags)).catch(failed);
          return rows.map((r) => ({ id: r.id, text: r.text, tags: r.tags }));
        },
      },
      {
        name: "mw_letta_search",
        description: "Search the archival memory of the project's Letta agent by meaning. Returns id, content, tags and timestamp.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", description: "what to look for" },
            limit: { type: "integer", description: "at most this many (default 5)" },
            tags: { type: "array", items: { type: "string" }, description: "only passages with any of these tags" },
          },
        },
        handler(a) {
          const tags = Array.isArray(a.tags) ? a.tags.filter((t) => typeof t === "string") : undefined;
          return searchMemories(String(a.query), { limit: typeof a.limit === "number" ? a.limit : undefined, tags }).catch(failed);
        },
      },
    ],
    checks: [
      {
        name: "letta",
        // The server's version (open health route) and the project's agent; never creates anything. The
        // chat model handle the existing agent uses is shown, so a mismatch with the setting is visible.
        async run() {
          const where = `${shown(s.url)} chat model handle ${s.model} (${s.modelFrom}), embedding ${s.embedding}${s.embeddingEndpoint ? ` (at ${shown(s.embeddingEndpoint)}, ${s.embeddingDim} dimensions)` : ""}, ${host.env(s.keyEnv) ? `${s.keyEnv} set` : `${s.keyEnv} NOT set`}`;
          try {
            const health = await host.http.json(api("/v1/health/"), { timeoutMs: LETTA_TIMEOUT_MS });
            const rec = await findAgentRecord();
            const h = rec?.llm_config?.handle ?? rec?.model;
            const handle = typeof h === "string" && h ? h : undefined;
            const uses = !rec ? `; it will be created with chat model handle ${s.model}`
              : !handle ? "" : handle === s.model ? `, using chat model handle ${handle}` : `, using chat model handle ${handle}, NOT ${s.model} (${s.modelFrom}): the agent was created with another model; delete it in Letta to have it made again with ${s.model}`;
            const version = typeof health?.version === "string" ? health.version : "?";
            return { ok: true, detail: `reachable, version ${version}, agent '${agentName(s)}' ${rec ? `exists (${rec.id})` : "not created yet (created on first use)"}${uses}; ${where}` };
          } catch (e) {
            return { ok: false, detail: `NOT reachable (${e?.message ?? String(e)}); ${where}` };
          }
        },
      },
    ],
  };
}
