// mem0 for MergeWright (package API v1). Self-hosted mem0's REST API:
//   POST /memories {messages:[{role,content}], user_id, metadata, infer}  -> {results:[{id, memory, event}]}
//   POST /search   {query, filters:{user_id}, top_k}                      -> {results:[{id, memory, metadata, score, ...}]}
//   GET  /memories?user_id=U&top_k=N                                      -> {results:[...]}
//   DELETE /memories/{id}
// Authentication: header X-API-Key, from the variable `key_env` names.
//
// Duplicates: every lesson carries a stable id (metadata.lesson_id, host.lessonId). The server offers no
// cheap lookup by metadata, so a store session lists the namespace once (top_k MEM0_LIST_MAX) and decides
// from that listing; only a listing the server cut short makes it search for what it lacks.
//
// Timeouts: reads (probe, list, search) get MEM0_TIMEOUT_MS; writes get `write_timeout_ms` (default
// MEM0_WRITE_TIMEOUT_MS), because the server embeds (and with infer, runs a model over) every write.

export const MEM0_TIMEOUT_MS = 10_000;
export const MEM0_WRITE_TIMEOUT_MS = 180_000;
/** How many memories one listing asks for (mem0 refuses more than 1000, HTTP 422). */
export const MEM0_LIST_MAX = 1000;

/** Results array from a mem0 reply (`{results: [...]}` or a bare array). */
export function mem0Results(reply) {
  const arr = Array.isArray(reply) ? reply : reply?.results;
  return Array.isArray(arr) ? arr.filter((x) => !!x && typeof x === "object") : [];
}

/** The URL without userinfo or query string, for messages. */
const shown = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return url.split("?")[0]; } };
const oneLine = (t) => t.replace(/\s+/g, " ").trim();
const sameText = (a, b) => typeof a === "string" && oneLine(a) === oneLine(b);

export function activate(host) {
  const c = host.config;
  const s = {
    url: String(c.url).replace(/\/+$/, ""),
    user: typeof c.user === "string" && c.user ? c.user : host.project.name,
    keyEnv: typeof c.key_env === "string" && c.key_env ? c.key_env : "MEM0_API_KEY",
    writeTimeoutMs: typeof c.write_timeout_ms === "number" ? c.write_timeout_ms : MEM0_WRITE_TIMEOUT_MS,
    project: host.project.name,
  };
  const headers = () => {
    const key = host.env(s.keyEnv);
    return key ? { "X-API-Key": key } : {};
  };
  const http = (path, opts = {}) => host.http.json(`${s.url}${path}`, { headers: headers(), timeoutMs: MEM0_TIMEOUT_MS, ...opts });
  const listing = (user = s.user) => http(`/memories?user_id=${encodeURIComponent(user)}&top_k=${MEM0_LIST_MAX}`);

  /** Search the namespace; `title: text` lines (text = first paragraph, one line). */
  async function searchLessons(query, limit) {
    const reply = await http("/search", { method: "POST", body: { query, filters: { user_id: s.user }, top_k: limit } });
    return mem0Results(reply).slice(0, limit).map((r) => {
      const text = oneLine(String(r.memory ?? r.text ?? "").split(/\n\s*\n/)[0]);
      const title = r.metadata?.title;
      return typeof title === "string" && title ? `${title}: ${text}` : text;
    }).filter(Boolean);
  }

  /** Store one lesson as written (infer false: no model rewrites it). */
  function storeLesson(l) {
    return http("/memories", {
      method: "POST",
      timeoutMs: s.writeTimeoutMs,
      body: {
        messages: [{ role: "user", content: l.body }],
        user_id: s.user,
        infer: false,
        metadata: { topic: l.topic, title: l.title, ...(l.card ? { card: l.card } : {}), project: s.project, lesson_id: host.lessonId(l) },
      },
    });
  }

  /** `lesson_id` -> texts of the namespace, and whether the listing was complete (nothing cut off). */
  async function listedLessons() {
    const rows = mem0Results(await listing());
    const out = new Map();
    for (const r of rows) {
      const id = r.metadata?.lesson_id;
      if (typeof id === "string") out.set(id, [...(out.get(id) ?? []), String(r.memory ?? r.text ?? "")]);
    }
    return { ids: out, complete: rows.length < MEM0_LIST_MAX };
  }

  /** Is this lesson, with this text, in the namespace? From the listing, else by a search filtered on its id. */
  async function lessonStored(l, listed) {
    const id = host.lessonId(l);
    if ((listed.ids.get(id) ?? []).some((t) => sameText(t, l.body))) return true;
    if (listed.complete) return false;
    const reply = await http("/search", { method: "POST", body: { query: l.title, filters: { user_id: s.user, lesson_id: id }, top_k: 5 } });
    return mem0Results(reply).some((r) => r.metadata?.lesson_id === id && sameText(r.memory ?? r.text, l.body));
  }

  const failed = (e) => { throw new Error(`mem0 did not answer: ${e?.message ?? String(e)}`); };

  return {
    recall: searchLessons,
    search: searchLessons,
    remember: {
      label: `mem0 (${s.user})`,
      open() {
        let listed;
        return {
          present: async (l) => lessonStored(l, (listed ??= await listedLessons())),
          store: storeLesson,
        };
      },
      /** The memories whose text (or title) contains `match`, deleted one by one unless `dryRun`. */
      async prune(match, { dryRun }) {
        const hits = mem0Results(await listing())
          .map((r) => {
            const title = r.metadata?.title;
            const body = String(r.memory ?? r.text ?? "");
            return { id: String(r.id ?? ""), text: typeof title === "string" && title ? `${title}: ${body}` : body };
          })
          .filter((r) => r.id && r.text.includes(match));
        if (!dryRun) for (const h of hits) await http(`/memories/${encodeURIComponent(h.id)}`, { method: "DELETE" });
        return hits;
      },
    },
    tools: [
      {
        name: "mw_mem0_add",
        description: "Store free text in mem0 (the project's namespace unless 'user' is given). By default it is stored verbatim (infer false); infer=true lets mem0's model extract facts from it instead, which may store nothing (the reply then says so).",
        write: true,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: { type: "string", description: "what to remember" },
            user: { type: "string", description: "mem0 user_id (namespace); default packages.mem0.user or the project name" },
            infer: { type: "boolean", description: "let mem0 extract facts instead of storing the text verbatim (default false)" },
            metadata: { type: "object", additionalProperties: { type: "string" }, description: "string metadata to attach" },
          },
        },
        async handler(a) {
          const infer = a.infer === true;
          const reply = await http("/memories", {
            method: "POST",
            timeoutMs: s.writeTimeoutMs,
            body: { messages: [{ role: "user", content: host.redact(String(a.text)) }], user_id: a.user ?? s.user, infer, metadata: { project: s.project, ...(a.metadata ?? {}) } },
          }).catch(failed);
          const stored = mem0Results(reply);
          return infer && stored.length === 0 ? "mem0 extracted no facts from the text (infer=true); nothing stored" : stored;
        },
      },
      {
        name: "mw_mem0_search",
        description: "Search mem0 memories (the project's namespace unless 'user' is given). Returns id, memory, score and metadata.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", description: "what to look for" },
            user: { type: "string", description: "mem0 user_id (namespace)" },
            limit: { type: "integer", description: "at most this many (default 5)" },
          },
        },
        async handler(a) {
          const limit = typeof a.limit === "number" ? a.limit : 5;
          const reply = await http("/search", { method: "POST", body: { query: a.query, filters: { user_id: a.user ?? s.user }, top_k: limit } }).catch(failed);
          return mem0Results(reply).slice(0, limit).map((r) => ({ id: r.id, memory: r.memory ?? r.text, score: r.score, metadata: r.metadata }));
        },
      },
    ],
    checks: [
      {
        name: "mem0",
        async run() {
          const where = `${shown(s.url)} namespace '${s.user}', ${host.env(s.keyEnv) ? `${s.keyEnv} set` : `${s.keyEnv} NOT set`}`;
          try {
            await http(`/memories?user_id=${encodeURIComponent(s.user)}&top_k=1`);
            return { ok: true, detail: `reachable, ${where}` };
          } catch (e) {
            return { ok: false, detail: `NOT reachable (${e?.message ?? String(e)}), ${where}` };
          }
        },
      },
    ],
  };
}
