// Tool group "docs": the documentation lives in the repository; a documentation service (a package
// such as open-notebook) may index it. `mw_docs_write` writes a file under docs.paths, commits it with a
// `docs:` message (owner authority) and syncs it to every package that mirrors documentation (queued
// on this machine when one is down, as the engine does).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { searchDocFiles, searchRemoteDocs } from "../../commands-docs.ts";
import { integrationsFor } from "../../integrations.ts";
import { badDocPath } from "../../integrations/docs.ts";
import { activeExports } from "../../packages/loader.ts";
import type { Project } from "../../project.ts";
import { git, matchesAny, MwError, readIfExists, writeAtomic } from "../../util.ts";
import { repoLock } from "../mutex.ts";
import { insideProject, repoTransaction, writeAndCommit } from "../repo.ts";
import { searchData } from "../data.ts";
import { need, num, S, schema, str, withData, type ToolDef } from "../tool.ts";

/** Refuse a path that is not a plain documentation path the owner may write through this tool. */
function checkDocPath(project: Project, rel: string): void {
  const bad = badDocPath(rel, project.config.docs.paths);
  if (bad) throw new MwError("docs/path", `${bad} (docs.paths: ${project.config.docs.paths.join(", ")})`);
  if (matchesAny(rel, project.config.protected)) throw new MwError("docs/protected", `'${rel}' is protected (config 'protected'); change it by hand or through a card`);
  // Never write through a symbolic link, at the file or in a folder above it.
  let dir = project.root;
  for (const part of rel.split("/")) {
    dir = path.join(dir, part);
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new MwError("docs/path", `'${project.rel(dir)}' is a symbolic link; not writing through it`);
    } catch (e) {
      if (e instanceof MwError) throw e;
      break; // does not exist yet
    }
  }
}

/** The state a documentation write checks: branch and path refused as before; the file's hash (or "absent"). */
function validateDocWrite(project: Project, rel: string): string {
  checkDocPath(project, rel);
  insideProject(project, rel, "docs/path");
  const branch = git(project.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true }).stdout.trim();
  const base = project.config.git.base;
  if (branch !== base) throw new MwError("docs/branch", `the project checkout is on '${branch || "a detached HEAD"}', not the base branch '${base}'; documentation is committed on '${base}'`);
  const text = readIfExists(project.abs(rel));
  return text === undefined ? "absent" : createHash("sha256").update(text).digest("hex");
}

/**
 * Write, commit alone with a `docs:` subject, and sync. Runs under the repository lock. Branch, git
 * identity and lock are checked before the file is written, and a failed commit restores it
 * (writeAndCommit, spec section 12.5).
 */
async function writeDoc(project: Project, rel: string, content: string, title: string | undefined): Promise<string> {
  const subject = (title?.trim() || rel).replace(/\s+/g, " ").slice(0, 72);
  const head0 = git(project.root, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true }).stdout.trim();
  writeAndCommit(project, { branchCode: "docs/branch", what: "documentation", files: [rel], subject: `docs: ${subject}` }, () => {
    writeAtomic(project.abs(rel), content.endsWith("\n") ? content : `${content}\n`);
    return [rel];
  });
  const sha = git(project.root, ["rev-parse", "HEAD"]).stdout.trim();
  if (sha === head0) return `${rel} is unchanged; nothing committed`;
  const lines = [`committed ${rel} as ${sha.slice(0, 10)} ('docs: ${subject}')`];
  const mirrors = (await activeExports(project)).filter((p) => typeof p.exports.docsSync === "function").map((p) => p.name);
  if (!mirrors.length) {
    lines.push("no documentation service is configured, so nothing was synced");
  } else {
    const outcome = await integrationsFor(project).docsSync([rel], [], sha);
    lines.push(outcome === "queued" ? `the documentation service did not answer: the sync is queued on this machine ('mw queue flush' retries it)`
      : outcome === "failed" ? "the documentation was not synced (the reason is on the server's standard error)"
      : `synced to ${mirrors.join(", ")}`);
  }
  return lines.join("\n");
}

export const tools: ToolDef[] = [
  {
    name: "mw_docs_write",
    description: "Write a documentation file (a path under docs.paths, e.g. docs/guides/x.md), commit it alone with the message 'docs: <title>', and sync it to every documentation service an enabled package provides (queued if one is unreachable). The repository is the source of truth; never write documentation into a documentation service directly.",
    write: true,
    inputSchema: schema({
      path: S.str("repository-relative path under docs.paths"),
      content: S.str("the whole new content of the file"),
      title: S.str("short subject for the commit message (default: the path)"),
    }, ["path", "content"]),
    handler: async (a, ctx) => {
      const project = ctx.project();
      const rel = need(a, "path");
      // Validate, then again under the repository lock: the branch, the path, and that the file is
      // still what it was at validation (another call or the owner may have changed it meanwhile).
      const seen = validateDocWrite(project, rel);
      // Under the in-process mutex, the cross-process repository lock and (hub-backed) the lease.
      return repoLock.run(() => repoTransaction(project, async () => {
        if (validateDocWrite(project, rel) !== seen) {
          throw new MwError("docs/changed", `${rel} changed while this write waited for the repository lock; nothing written. Read it again and retry.`);
        }
        return writeDoc(project, rel, String(a.content), str(a, "title"));
      }));
    },
  },
  {
    name: "mw_docs_search",
    result: "SearchData",
    description: "Search the project's documentation (the files of docs.paths) by keyword, ranked as mw_memory_search ranks memory: path, heading (or first line), score and the first matching line under 'project'; then the hits of each enabled package that searches documentation or memory (labelled by its name, e.g. 'open-notebook'). A source that does not answer gives a line saying so.",
    inputSchema: schema({ query: S.str("words to search for"), limit: S.int("at most this many hits from each (default 5)"), text: S.bool("plain text search instead of search by meaning in a documentation service") }, ["query"]),
    handler: async (a, ctx) => {
      const project = ctx.project();
      const query = need(a, "query");
      const limit = num(a, "limit") ?? 5;
      const hits = searchDocFiles(project, query, limit);
      const local = hits.map((h) => ({ file: h.file, title: h.title, score: h.score, text: h.text }));
      const remote = await searchRemoteDocs(project, query, limit, a.text === true ? "text" : "vector");
      const text = { project: local, ...Object.fromEntries(remote.map((r) => [r.name, r.error ? `${r.name} did not answer: ${r.error}` : r.hits])) };
      return withData("SearchData", text, searchData(query, hits, remote));
    },
  },
];
