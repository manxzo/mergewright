// `mw docs search`: the project's documentation. It ranks the files of `docs.paths` itself (the memory
// search's ranking) and adds the hits of the enabled packages that search documentation (or memory).
// Syncing to a documentation service and asking it are commands of that service's package.
import fs from "node:fs";
import type { Handler } from "./cli.ts";
import { remoteHits, type RemoteHits } from "./integrations.ts";
import { isDocPath, trackedDocFiles } from "./integrations/docs.ts";
import { keywords, rankByKeywords, type MemoryHit, type SearchCandidate } from "./memory.ts";
import { activeExports } from "./packages/loader.ts";
import { Project } from "./project.ts";
import { MwError } from "./util.ts";

/** The length of a hit's snippet (`mw docs search`, `mw_docs_search`). */
export const SNIPPET_CHARS = 160;

/** Does this repository path count as documentation: under `docs.paths` and not under `docs.exclude`? */
export function isDocFile(project: Project, rel: string): boolean {
  return isDocPath(rel, project.config.docs);
}

/** Tracked files that count as documentation (config `docs.paths`, minus `docs.exclude`). */
export function docFiles(project: Project): string[] {
  return trackedDocFiles(project.root, project.config.docs);
}

/** Documentation files larger than this are left out of the search (a project's docs are prose). */
const SEARCH_MAX_BYTES = 1_000_000;

/** A file's title for a hit: its first `# ` heading, else its first non-empty line. */
function docTitle(text: string): string {
  const h = /^#[ \t]+(.+)$/m.exec(text)?.[1]?.trim();
  return (h ?? text.split("\n").find((l) => l.trim())?.trim() ?? "").slice(0, SNIPPET_CHARS);
}

/**
 * `mw docs search`: the tracked files of `docs.paths` (minus `docs.exclude`) ranked by the memory
 * search's keyword ranking (rankByKeywords). A hit's `text` is the first line holding a query word.
 * Symbolic links, binary files and files over 1 MB are skipped.
 */
export function searchDocFiles(project: Project, query: string, limit = 5): MemoryHit[] {
  const words = keywords(query);
  if (!words.length) return [];
  const candidates: SearchCandidate[] = [];
  for (const rel of docFiles(project)) {
    const abs = project.abs(rel);
    let text: string;
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > SEARCH_MAX_BYTES) continue;
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    if (text.includes("\0")) continue;
    const line = text.split("\n").find((l) => words.some((w) => l.toLowerCase().includes(w)))?.trim() ?? "";
    candidates.push({ file: rel, title: docTitle(text), text: line.slice(0, SNIPPET_CHARS), match: text });
  }
  return rankByKeywords(query, candidates, limit);
}

/**
 * The documentation hits of the enabled packages, each labelled with its name, in the order
 * mergewright.yaml lists them: a package's `searchDocs` when it has one (`text` asks for plain text
 * search instead of search by meaning), else its `search`.
 */
export async function searchRemoteDocs(project: Project, query: string, limit: number, type: "vector" | "text" = "vector"): Promise<RemoteHits[]> {
  const hits: Promise<RemoteHits>[] = [];
  for (const { name, exports: ex } of await activeExports(project)) {
    if (typeof ex.searchDocs === "function") hits.push(remoteHits(name, () => ex.searchDocs!(query, limit, { text: type === "text" })));
    else if (typeof ex.search === "function") hits.push(remoteHits(name, () => ex.search!(query, limit)));
  }
  return Promise.all(hits);
}

export const commands: Record<string, Handler> = {
  docs: async (a, out) => {
    const sub = a._[1];
    const project = Project.load();
    if (sub === "search") {
      const q = a._.slice(2).join(" ");
      if (!q.trim()) throw new MwError("usage", "give the words to search for");
      const limit = Number(a.flags.limit ?? 5);
      if (!Number.isInteger(limit) || limit < 1) throw new MwError("usage", "--limit takes a whole number of at least 1");
      const hits = searchDocFiles(project, q, limit);
      if (!hits.length) out("nothing in the documentation matches");
      for (const h of hits) out(`${h.file}: ${h.title} (score ${h.score})${h.text ? `\n  ${h.text}` : ""}`);
      for (const r of await searchRemoteDocs(project, q, limit, a.flags.text ? "text" : "vector")) {
        if (r.error) out(`${r.name}: did not answer (${r.error})`);
        else if (!r.hits.length) out(`${r.name}: nothing matches`);
        else for (const h of r.hits) out(`${r.name}: ${h}`);
      }
      return 0;
    }
    if (sub === "sync" || sub === "ask") {
      throw new MwError("usage", `'mw docs ${sub}' is a command of the documentation service's package now; see 'mw packages' for the enabled ones and 'mw <package> ${sub}${sub === "sync" ? " --all" : " <question>"}'`);
    }
    throw new MwError("usage", "use 'mw docs search <words>'");
  },
};
