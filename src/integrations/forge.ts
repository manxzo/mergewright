// Merge through a forge: open (or find) a pull request for the card branch and squash-merge it.
// NOT verified against a live Gitea or GitHub: written from their public REST documentation and
// tested against local mock servers only.
//
// Gitea (API v1): GET/POST /api/v1/repos/{owner}/{repo}/pulls, GET .../pulls/{index},
//   POST .../pulls/{index}/merge {"Do": "squash"}; the merge commit is the PR's merge_commit_sha.
// GitHub (REST 2022-11-28): GET/POST /repos/{owner}/{repo}/pulls, GET .../pulls/{n},
//   PUT .../pulls/{n}/merge {"merge_method": "squash"} -> {sha, merged}.
import path from "node:path";
import type { MergeRequest } from "../engine/types.ts";
import { MwError, readJson, writeJson } from "../util.ts";
import { errMessage, HttpError, httpJson, trimSlash } from "./common.ts";

export interface ForgeSettings {
  kind: "gitea" | "github";
  url?: string;
  repo?: string;
  tokenEnv?: string;
}

interface Pull {
  number: number;
  head?: { ref?: string; label?: string };
  base?: { ref?: string };
  mergeable?: boolean | null;
  mergeable_state?: string;
  state?: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
}

const TIMEOUT_MS = 30_000;

function conflict(req: MergeRequest, n: number, why: string): MwError {
  return new MwError("merge/conflict", `pull request #${n} for ${req.branch} cannot be merged into ${req.base}: ${why}`);
}

function failed(why: string): MwError {
  return new MwError("merge/failed", `forge merge failed: ${why}`);
}

/**
 * The forge reports the pull request as merged but names no merge commit, so what landed
 * cannot be checked against the gated tree. The engine blocks the run on this code (never success).
 */
export const NO_MERGE_COMMIT = "merge/no-commit";

function noCommit(n: number): MwError {
  return new MwError(NO_MERGE_COMMIT, `the forge reports pull request #${n} as merged but names no merge commit, so what landed cannot be checked`);
}

function settings(s: ForgeSettings): { base: string; owner: string; name: string; headers: Record<string, string> } {
  const [owner, name, extra] = (s.repo ?? "").split("/");
  if (!owner || !name || extra !== undefined) throw failed(`git.forge.repo must be 'owner/name' (got '${s.repo ?? ""}')`);
  const tokenEnv = s.tokenEnv ?? (s.kind === "github" ? "GITHUB_TOKEN" : "GITEA_TOKEN");
  const token = process.env[tokenEnv];
  if (!token) throw failed(`the token variable ${tokenEnv} is not set`);
  if (s.kind === "gitea") {
    if (!s.url) throw failed("git.forge.url is required for gitea");
    const root = trimSlash(s.url).replace(/\/api\/v1$/, "");
    return { base: `${root}/api/v1/repos/${owner}/${name}`, owner, name, headers: { authorization: `token ${token}` } };
  }
  const root = !s.url || /^https?:\/\/(www\.)?github\.com\/?$/.test(s.url) ? "https://api.github.com" : trimSlash(s.url);
  return {
    base: `${root}/repos/${owner}/${name}`,
    owner,
    name,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  };
}

/** What is kept in `.mergewright/runs/<CARD>/forge.json` before the merge is requested. */
export interface ForgeRecord {
  pr: number;
  branch: string;
}

export const FORGE_RECORD = "forge.json";

/**
 * Merge `req.branch` into `req.base` through the forge and return the merge commit:
 * - the pull request's number is saved in `<runDir>/forge.json` before the merge is requested;
 * - a retry looks that pull request up by number (open or closed): already merged = success;
 * - success needs the forge to report the pull request as merged, with a merge commit; merged without
 *   one throws `merge/no-commit` (the engine checks that commit's parent and tree).
 * `req.signal` (this machine lost the lease) cancels every request, and is checked
 * immediately before `forge.json` is written and before the merge is requested; it then throws
 * `merge/failed` and records and merges nothing more. The next holder reconciles a recorded pull request.
 */
export async function forgeMerge(s: ForgeSettings, req: MergeRequest, runDir: string): Promise<string> {
  const f = settings(s);
  const stopped = () => failed("stopped: this machine lost the lease");
  const live = () => { if (req.signal?.aborted) throw stopped(); };
  const call = (rel: string, method = "GET", body?: unknown) => {
    live();
    return httpJson(`${f.base}${rel}`, { method, headers: f.headers, body, timeoutMs: TIMEOUT_MS, signal: req.signal });
  };
  const recordFile = path.join(runDir, FORGE_RECORD);
  const mergedSha = (p: Pull | undefined): string | undefined => {
    if (p?.merged !== true) return undefined;
    if (!p.merge_commit_sha) throw noCommit(p.number);
    return p.merge_commit_sha;
  };
  try {
    let pr: Pull | undefined;
    let rec: ForgeRecord | undefined;
    try {
      rec = readJson<ForgeRecord>(recordFile);
    } catch {
      throw failed(`${recordFile} cannot be read. Check the pull request for ${req.branch} on the forge, delete that file, then run the card again`);
    }
    if (rec && rec.branch === req.branch && Number.isInteger(rec.pr)) {
      try {
        pr = (await call(`/pulls/${rec.pr}`)) as Pull;
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
        pr = undefined; // gone (deleted repository, or recreated): open a new one
      }
      if (pr) {
        const done = mergedSha(pr);
        if (done) return done;
        if (pr.state === "closed") {
          throw failed(`pull request #${rec.pr} for ${req.branch} was closed without being merged. Reopen it on the forge, or delete ${recordFile} so the next run opens a new one, then run the card again`);
        }
      }
    }
    if (!pr) {
      const find = async (): Promise<Pull | undefined> => {
        const q = s.kind === "github"
          ? `?state=open&head=${encodeURIComponent(`${f.owner}:${req.branch}`)}&base=${encodeURIComponent(req.base)}&per_page=100`
          : `?state=open&limit=50`;
        const list = (await call(`/pulls${q}`)) as Pull[] | undefined;
        return (list ?? []).find((p) => p.head?.ref === req.branch && p.base?.ref === req.base);
      };
      pr = await find();
      if (!pr) {
        try {
          pr = (await call("/pulls", "POST", { title: req.title, body: req.body, head: req.branch, base: req.base })) as Pull;
        } catch (e) {
          // Created by someone else in the meantime (GitHub 422, Gitea 409): look again.
          if (e instanceof HttpError && (e.status === 422 || e.status === 409)) pr = await find();
          if (!pr) throw e;
        }
      }
    }
    const n = pr.number;
    if (!Number.isInteger(n)) throw failed(`the forge returned a pull request without a number`);
    // Before the merge is requested: a crash or a lost answer after this point is recovered by number.
    live();
    writeJson(recordFile, { pr: n, branch: req.branch } satisfies ForgeRecord);
    const notMerged = (what: string) => failed(`${what} did not report pull request #${n} as merged, so the merge is not trusted. Check #${n} on the forge, then run the card again (a merged #${n} is then recognised)`);
    if (s.kind === "github") {
      try {
        live();
        const r = (await call(`/pulls/${n}/merge`, "PUT", { merge_method: "squash", commit_title: req.title, commit_message: req.body })) as { sha?: string; merged?: boolean } | undefined;
        if (r?.merged !== true) throw notMerged("GitHub");
        if (!r.sha) throw noCommit(n);
        return r.sha;
      } catch (e) {
        if (e instanceof HttpError && e.status === 405) {
          const cur = (await call(`/pulls/${n}`)) as Pull;
          const done = mergedSha(cur);
          if (done) return done;
          if (cur.mergeable === false || cur.mergeable_state === "dirty") throw conflict(req, n, "merge conflicts");
          throw failed(`GitHub refused to merge #${n}: ${e.body.slice(0, 200)}`);
        }
        throw e;
      }
    }
    // Gitea
    const before = (await call(`/pulls/${n}`)) as Pull;
    const already = mergedSha(before);
    if (already) return already;
    if (before.mergeable === false) throw conflict(req, n, "merge conflicts");
    try {
      live();
      await call(`/pulls/${n}/merge`, "POST", { Do: "squash", MergeTitleField: req.title, MergeMessageField: req.body });
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) throw conflict(req, n, "merge conflicts");
      if (e instanceof HttpError && e.status === 405) {
        const cur = (await call(`/pulls/${n}`)) as Pull;
        const done = mergedSha(cur);
        if (done) return done;
        if (cur.mergeable === false) throw conflict(req, n, "merge conflicts");
        throw failed(`Gitea refused to merge #${n}: ${e.body.slice(0, 200)}`);
      }
      throw e;
    }
    const after = (await call(`/pulls/${n}`)) as Pull;
    if (after.merged !== true) throw notMerged("Gitea");
    if (!after.merge_commit_sha) throw noCommit(n);
    return after.merge_commit_sha;
  } catch (e) {
    if (req.signal?.aborted) throw stopped();
    if (e instanceof MwError) throw e;
    throw failed(errMessage(e));
  }
}

/** For `mw integrations`: does the repository answer with this token? */
export async function probeForge(s: ForgeSettings): Promise<void> {
  const f = settings(s);
  await httpJson(f.base, { headers: f.headers, timeoutMs: TIMEOUT_MS });
}
