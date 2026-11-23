// OpenNoteLM (https://github.com/daozen/opennotelm) as the documentation mirror, for MergeWright
// (package API v1). Written from the upstream source at commit c709bfa0c31641f3aecca468c8be16ebee01a353
// (backend/opennotelm/main.py, source_routes.py, source_service.py, notebooks.py) and NOT run against a
// live OpenNoteLM.
//
// What the API offers (read from that source; no authentication, a local single-user app):
// - GET /api/health -> {status, version}. GET /api/notebooks -> [{id, title, ...}];
//   POST /api/notebooks {title, description} -> the notebook (201).
// - GET /api/notebooks/{id}/sources -> [{id, title, original_filename, checksum_sha256, ...}].
// - POST /api/notebooks/{id}/sources/upload, multipart `file` (.md, .markdown, .txt, .pdf, .epub, .docx)
//   -> 202 {duplicate: false, source, job}, ingested in the background. The source's title is the file
//   name without its extension and without any folder; only the base name is kept.
//   A file whose bytes equal any existing source's (SHA-256) is not stored again: the answer is
//   {duplicate: true, source: <that one>}, NOT attached to this notebook, so it is attached with
//   POST /api/notebooks/{id}/sources/{source_id}.
// - DELETE /api/sources/{id} deletes a source permanently (from every notebook).
// - There is no search endpoint, and chat (POST /api/notebooks/{id}/chat) writes into the notebook's one
//   stored conversation and answers through a background job; so this package has no search or ask.
//
// So a documentation file is one uploaded source whose file name is its repository path with `%` and
// `/` escaped (`docs%2Fguide.md`), which keeps the path in the one field the server keeps whole. A file
// is replaced only when its bytes changed (the source's checksum differs): the new one is uploaded
// first, then the old one deleted. A file without a supported extension is sent as text (`.txt` added).

import { createHash } from "node:crypto";

const TIMEOUT_MS = 60_000;
const TEXT_EXT = /\.(md|markdown|txt)$/i;

const trimSlash = (u) => String(u).replace(/\/+$/, "");
const shown = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return String(url).split("?")[0]; } };
const errText = (e) => e?.message ?? String(e);

/** The upload file name of a repository path: reversible, without `/` (the server keeps only the base name). */
export function fileNameOf(rel) {
  const name = rel.replaceAll("%", "%25").replaceAll("/", "%2F");
  return TEXT_EXT.test(name) ? name : `${name}.txt`;
}

export function activate(host) {
  const s = { url: String(host.config.url), name: typeof host.config.name === "string" && host.config.name.trim() ? host.config.name.trim() : host.project.name };
  const api = (rel) => {
    const base = trimSlash(s.url);
    return `${base.endsWith("/api") ? base : `${base}/api`}${rel}`;
  };
  const call = (rel, opts = {}) => host.http.json(api(rel), { timeoutMs: TIMEOUT_MS, ...opts });
  // A 4xx other than 408 and 429 is the server refusing this file (too large, notebook full, ...): retrying cannot help.
  const refused = (e) => e instanceof host.errors.HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;

  const listNotebooks = async () => {
    const r = await call("/notebooks");
    return Array.isArray(r) ? r : [];
  };
  const findNotebook = async () => (await listNotebooks()).find((n) => n.title === s.name);

  async function ensureNotebook() {
    const found = await findNotebook();
    if (found) return found.id;
    const made = await call("/notebooks", { method: "POST", body: { title: s.name, description: `Documentation of ${host.project.name}, mirrored by MergeWright` } });
    if (!made?.id) throw new Error("OpenNoteLM created the notebook without answering its id");
    return made.id;
  }

  /**
   * Apply a batch: upload each changed file whose bytes differ from its source's, then delete its older
   * sources; delete the sources of deleted files. Skipped files and files the server refuses are
   * warnings; `sent` counts the files uploaded or removed. Throws when the server does not answer.
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
    const nb = encodeURIComponent(notebookId);
    const byName = new Map();
    const sources = await call(`/notebooks/${nb}/sources`);
    for (const src of Array.isArray(sources) ? sources : []) {
      if (typeof src.original_filename === "string") byName.set(src.original_filename, [...(byName.get(src.original_filename) ?? []), src]);
    }
    const remove = async (list) => { for (const src of list) await call(`/sources/${encodeURIComponent(src.id)}`, { method: "DELETE" }); };
    let sent = 0;
    for (const [rel, blob] of blobs) {
      const name = fileNameOf(rel);
      const old = byName.get(name) ?? [];
      if (blob.kind !== "file" || !blob.content.trim()) {
        // Deleted in that commit, or empty (the server refuses an empty file): its source goes.
        if (blob.kind === "file") warnings.push(`${rel} is empty, so it is not in the notebook`);
        if (old.length) { await remove(old); sent++; }
        continue;
      }
      const bytes = Buffer.from(blob.content, "utf8");
      const sum = createHash("sha256").update(bytes).digest("hex");
      if (old.some((src) => src.checksum_sha256 === sum)) {
        await remove(old.filter((src) => src.checksum_sha256 !== sum)); // leftovers of an earlier cut-short sync
        continue;
      }
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: /\.(md|markdown)$/i.test(name) ? "text/markdown" : "text/plain" }), name);
      let r;
      try {
        r = await call(`/notebooks/${nb}/sources/upload`, { method: "POST", form });
      } catch (e) {
        if (!refused(e)) throw e;
        warnings.push(`${rel} was refused by OpenNoteLM (${errText(e)}), so it was not sent`);
        continue;
      }
      if (r?.duplicate && r.source?.id) {
        await call(`/notebooks/${nb}/sources/${encodeURIComponent(r.source.id)}`, { method: "POST" });
        if (r.source.original_filename !== name) warnings.push(`${rel} has the same content as the source '${r.source.original_filename ?? r.source.id}', which the notebook shows instead`);
      }
      await remove(old.filter((src) => src.id !== r?.source?.id));
      sent++;
    }
    return { warnings, sent };
  }

  const summary = (b) => `docs -> OpenNoteLM notebook '${s.name}': ${b.changed.length} changed, ${b.deleted.length} deleted`;

  return {
    async docsSync(changed, deleted, commit) {
      if (!changed.length && !deleted.length) return "none";
      const batch = { changed, deleted, commit };
      try {
        const { warnings } = await syncDocs(batch);
        for (const w of warnings) host.log(w);
        return "sent";
      } catch (e) {
        host.queue.enqueue("notebook-opennotelm", summary(batch), batch, errText(e));
        return "queued";
      }
    },
    deliverers: {
      async "notebook-opennotelm"(payload) {
        const { warnings } = await syncDocs(payload ?? {});
        for (const w of warnings) host.log(w);
      },
    },
    commands: {
      /** `mw notebook-opennotelm sync --all`: send every documentation file of the last commit. */
      async "notebook-opennotelm"(args, out) {
        if (args._[1] !== "sync" || args.flags.all !== true) {
          host.log("use 'mw notebook-opennotelm sync --all' to bring the notebook level with the repository (cards sync their own changes when they merge)");
          return 2;
        }
        try {
          const { warnings, sent } = await syncDocs({ changed: host.docs.files(), deleted: [] });
          for (const w of warnings) out(`skipped: ${w}`);
          out(`${sent} document(s) of the last commit uploaded to OpenNoteLM notebook '${s.name}' (unchanged ones are kept)${warnings.length ? `, ${warnings.length} skipped` : ""}`);
          return 0;
        } catch (e) {
          host.log(`OpenNoteLM did not answer: ${errText(e)}`);
          return 1;
        }
      },
    },
    checks: [
      {
        name: "opennotelm",
        async run() {
          const where = `${shown(s.url)} notebook '${s.name}'`;
          try {
            const h = await call("/health", { timeoutMs: 10_000 });
            const exists = (await listNotebooks()).some((n) => n.title === s.name);
            return { ok: true, detail: `reachable${h?.version ? `, OpenNoteLM ${h.version}` : ""}${exists ? "" : `; notebook '${s.name}' not created yet (the first docs sync creates it)`}; ${where}` };
          } catch (e) {
            return { ok: false, detail: `NOT reachable (${errText(e)}); ${where}` };
          }
        },
      },
    ],
  };
}
