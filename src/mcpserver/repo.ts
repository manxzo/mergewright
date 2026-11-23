// Repository helpers the MCP server's writing tools share: every path a tool reads or writes is
// resolved to its real path and must stay inside the project's real root, and a tool that writes
// commits exactly the files it wrote, alone, on the base branch (spec section 12.5). The whole
// validate, write and commit runs under a cross-process repository lock and, on a hub-backed project,
// under the lease, after adopting the hub and followed by a fenced push.
import fs from "node:fs";
import path from "node:path";
import { lockHolder, locksDir, REPO_LOCK, releaseUnlessBusy } from "../engine/registry.ts";
import { acquireLock } from "../engine/state.ts";
import { hostName, openHub } from "../hub.ts";
import { deliverQueued } from "../integrations.ts";
import { Project } from "../project.ts";
import { git, isSyncTemp, MwError, sh } from "../util.ts";
import { WithData } from "./answer.ts";

/** How long a tool waits for another process's repository lock. Mutable for tests only. */

/** A tool's text answer with `line` added on a line of its own (also inside withData); other values as they are. */
function withLine<T>(value: T, line: string): T | string {
  if (typeof value === "string") return `${value}\n${line}`;
  if (value instanceof WithData && typeof value.text === "string") return new WithData(`${value.text}\n${line}`, value.data) as T;
  return value;
}

export const repoLockTiming = { waitMs: 10_000, pollMs: 50 };

/** `.mergewright/local/locks/repo.lock`: this machine's lock on the project checkout's index and base branch. */
export function repoLockFile(project: { readonly root: string }): string {
  return path.join(locksDir(project), REPO_LOCK);
}

/**
 * Run `f` holding the repository lock: the run-lock format (pid, host, wall-clock and process start
 * time), published with `link()` under the registry's guard, a dead holder's lock replaced (the same
 * rules as a card's run lock, src/engine/state.ts). Another live holder is waited for up to
 * `repoLockTiming.waitMs`, then the call is refused with `repo/locked`. One process takes it once at
 * a time (the MCP server's in-process mutex orders its own calls).
 */
export async function withRepoLock<T>(project: { readonly root: string }, f: () => T | Promise<T>): Promise<T> {
  const file = repoLockFile(project);
  const deadline = Date.now() + repoLockTiming.waitMs;
  let release: () => void;
  for (;;) {
    try {
      release = acquireLock(file, "the repository");
      break;
    } catch (e) {
      if (!(e instanceof MwError) || e.code !== "run/locked") throw e;
    }
    if (Date.now() >= deadline) {
      const h = lockHolder(file);
      throw new MwError("repo/locked", `the project repository is locked by ${h ? `process ${h.pid} on this machine (since ${h.started})` : "another process on this machine"} (${file}) and stayed locked for ${repoLockTiming.waitMs / 1000} s; nothing was written. Try again once it is done.`);
    }
    await new Promise((r) => setTimeout(r, repoLockTiming.pollMs));
  }
  try {
    return await f();
  } finally {
    release();
  }
}

/**
 * The transaction every committing MCP tool runs `f` (its validate, write and commit) in. Always under
 * the repository lock. On a hub-backed project (`git.hub` set), also: this machine must hold the lease
 * (taken when nobody holds it; kept when this machine already does; refused with `lease/held` when
 * another machine does), the base branch adopts the hub first (`mw sync`), and a commit `f` made is
 * pushed fenced by the lease; then the lease is released unless this machine held it before or a run
 * of this machine is registered (`releaseUnlessBusy`). A string result gets a line saying the commit
 * is on the hub. Right before `f` the config is loaded again and must pass its schema (`config/invalid`).
 *
 * REQ-engine-008: nothing in here waits for a delivery. `f` records deliveries in this machine's queue
 * and hands the item files to `tx.deliverAfterRelease`. When this transaction released both the
 * repository lock and the lease (or the project has no hub), they are delivered in the background
 * (`deliverQueued`, which first clears this process's hold on them), not awaited by the caller, whether
 * `f` succeeded or not. When the lease stays with this machine (it held the lease before, a run of it is
 * registered, or the release failed), nothing is sent and the holds stay: `enqueueMemory` holds the items
 * for this process, so no flush delivers them while the lease is still held, and the hold ends with the
 * process; the next flush after that delivers them. A string result gets a line saying which happened.
 */
export async function repoTransaction<T>(project: Project, f: (tx: Transaction) => T | Promise<T>): Promise<T | string> {
  const outbox: string[] = [];
  const tx: Transaction = { deliverAfterRelease: (files) => { outbox.push(...files); } };
  const lease = { released: false };
  let value: T | string;
  try {
    value = await lockedTransaction(project, () => f(tx), lease);
  } finally {
    // The items are held for this process: released and delivered only when the lock and the lease
    // both were; a lease this machine keeps keeps the holds too (until this process ends).
    if (lease.released) deliverQueued(project, outbox);
  }
  if (!outbox.length) return value;
  return withLine(value, lease.released
    ? "the delivery starts now, in the background, after the repository lock and the lease were released ('mw queue' lists what still waits)"
    : "this machine keeps the lease (it held it before, or a run of this machine is active), so nothing is sent now; the items stay held for this process, and the next queue flush after it ends (mw work, mw run, mw approve or mw queue flush) delivers them ('mw queue' lists them)");
}

/** What a transaction's body may ask for. */
export interface Transaction {
  /** Deliver these queue items (`enqueueMemory`) once the repository lock and the lease are released. */
  deliverAfterRelease(files: string[]): void;
}

/**
 * `released` is set when the transaction gave back everything it held: on a project without a hub
 * once the repository lock is released, on a hub-backed one only when it also released the lease.
 */
async function lockedTransaction<T>(project: Project, f: () => T | Promise<T>, lease: { released: boolean }): Promise<T | string> {
  let releasedLease = false;
  const value = await withRepoLock(project, async () => {
    const notes: string[] = [];
    const hub = openHub(project, { warn: (line) => notes.push(line) });
    // REQ-config-001: the config is checked again as it is now, under the lock (and on a hub-backed
    // project after adopting the hub), so a change made meanwhile is refused before anything is written.
    const recheck = () => new Project(project.root).assertRunnable();
    if (!hub.enabled) {
      releasedLease = true;
      recheck();
      return f();
    }
    const observed = await hub.observe();
    const holder = observed.lease;
    if (holder && holder.host !== hostName()) {
      throw new MwError("lease/held", `${holder.host} (pid ${holder.pid}) holds the lease on hub '${hub.remote}': another machine is driving this project, so nothing was written here. Wait for it to finish (or, if it has stopped, take the lease with 'mw lease take'), then try again.`);
    }
    const { refreshed } = await hub.take({ observed });
    let value: T;
    try {
      const synced = await hub.sync();
      if (synced.action !== "none") notes.push(synced.detail);
      recheck();
      const before = headOf(project);
      value = await f();
      const after = headOf(project);
      if (after && after !== before) {
        await hub.pushBase();
        notes.push(`the commit is on the hub '${hub.remote}' ('${project.config.git.base}' at ${after.slice(0, 10)})`);
      }
    } finally {
      if (!refreshed) {
        try {
          releasedLease = await releaseUnlessBusy(project, () => hub.release());
        } catch (err) {
          notes.push(`the lease taken for this change could not be released: ${(err as Error).message}; it expires by itself, or run 'mw lease release'`);
        }
      }
    }
    return notes.length ? withLine(value, notes.join("\n")) : value;
  }).finally(() => {
    // Reached once withRepoLock has released the repository lock (or failed to take it).
    lease.released = releasedLease;
  });
  return value;
}

function headOf(project: Project): string {
  return git(project.root, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true }).stdout.trim();
}

const outside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
};

/**
 * The absolute path of `rel` (repository-relative) after every symbolic link on the way is resolved;
 * throws `code` when it leads outside the project's real root. A path that does not exist yet is
 * judged by its deepest existing folder.
 */
export function insideProject(project: Project, rel: string, code: string): string {
  const root = fs.realpathSync(project.root);
  const abs = path.resolve(project.root, rel);
  if (outside(path.resolve(project.root), abs)) throw new MwError(code, `'${rel}' is outside the project`);
  let existing = abs;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  let real: string;
  try {
    real = path.join(fs.realpathSync(existing), path.relative(existing, abs));
  } catch {
    throw new MwError(code, `'${rel}' cannot be resolved`);
  }
  if (outside(root, real)) throw new MwError(code, `'${rel}' leads outside the project (to ${real}); not following it`);
  return real;
}

/** Refuse unless the project checkout is on the base branch, where the tools commit. */
export function requireBase(project: Project, code: string, what: string): void {
  const branch = git(project.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true }).stdout.trim();
  const base = project.config.git.base;
  if (branch !== base) throw new MwError(code, `the project checkout is on '${branch || "a detached HEAD"}', not the base branch '${base}'; ${what} is committed on '${base}', so nothing was written`);
}

/**
 * Whether git can name who commits in `root`: `git var GIT_COMMITTER_IDENT` and `GIT_AUTHOR_IDENT`
 * both succeed (user.name/user.email, or the GIT_* / EMAIL environment). Without it every commit
 * fails ("unable to auto-detect email address"), so the committing tools refuse before writing.
 */
export function gitIdentity(root: string): { ok: true } | { ok: false; why: string } {
  for (const v of ["GIT_COMMITTER_IDENT", "GIT_AUTHOR_IDENT"]) {
    const r = git(root, ["var", v], { allowFail: true });
    if (r.code !== 0) {
      const why = (r.stderr || r.stdout).trim().split("\n").filter((l) => /^fatal:/.test(l)).pop()?.replace(/^fatal:\s*/, "") ?? "git cannot name the committer";
      return { ok: false, why };
    }
  }
  return { ok: true };
}

/** The line that tells the owner how to set the identity git needs. */
export const IDENTITY_FIX = "set it with 'git config user.name \"Your Name\"' and 'git config user.email you@example.com' (add --global for every repository)";

/** Refuse (`git/identity`) unless git can name the committer in the project checkout. */
export function requireIdentity(project: Project, what: string): void {
  const id = gitIdentity(project.root);
  if (!id.ok) throw new MwError("git/identity", `git has no identity to commit ${what} with (${id.why}); ${IDENTITY_FIX}. Nothing was written.`);
}

/** True when this process holds the repository lock (`withRepoLock`, which every committing tool runs under). */
export function holdsRepoLock(project: { readonly root: string }): boolean {
  try {
    const info = JSON.parse(fs.readFileSync(repoLockFile(project), "utf8")) as { pid?: unknown };
    return info.pid === process.pid;
  } catch {
    return false;
  }
}

/**
 * The preconditions of a committing write, checked before anything is written (spec section 12.5):
 * the checkout is on the base branch (`branchCode`), git has an identity (`git/identity`) and this
 * process holds the repository lock (`repo/unlocked`).
 */
export function commitPreconditions(project: Project, branchCode: string, what: string): void {
  requireBase(project, branchCode, what);
  requireIdentity(project, what);
  if (!holdsRepoLock(project)) throw new MwError("repo/unlocked", `${what} is written only under the repository lock (${repoLockFile(project)}), which this process does not hold; nothing was written`);
}

interface Saved {
  /** The file's bytes before the write, or undefined when it did not exist. */
  content: Buffer | undefined;
  /** Its index entry before the write (`git ls-files -s` line), or "" when it was not in the index. */
  stage: string;
}

function saveOne(project: Project, rel: string): Saved {
  let content: Buffer | undefined;
  try {
    content = fs.readFileSync(path.join(project.root, rel));
  } catch {
    content = undefined;
  }
  const stage = git(project.root, ["ls-files", "-s", "--", rel], { allowFail: true }).stdout.split("\n")[0]?.trim() ?? "";
  return { content, stage };
}

/** Put `rel` back as `saved` says: its bytes (or no file) and its index entry (or none). Best effort per file. */
function restoreOne(project: Project, rel: string, saved: Saved): void {
  const abs = path.join(project.root, rel);
  try {
    if (saved.content === undefined) fs.rmSync(abs, { force: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, saved.content);
    }
  } catch {
    // reported by the caller's message: it names the files
  }
  const m = /^(\d+) ([0-9a-f]+) \d+\t/.exec(saved.stage);
  if (m) git(project.root, ["update-index", "--add", "--cacheinfo", `${m[1]},${m[2]},${rel}`], { allowFail: true });
  else git(project.root, ["rm", "--cached", "-q", "--ignore-unmatch", "--", rel], { allowFail: true });
}

/** What a file not saved before the write was: its content and index entry in HEAD, or nothing. */
function headState(project: Project, rel: string): Saved {
  const ls = git(project.root, ["ls-tree", "HEAD", "--", rel], { allowFail: true }).stdout.trim();
  const m = /^(\d+) blob ([0-9a-f]+)\t/.exec(ls);
  if (!m) return { content: undefined, stage: "" };
  const blob = sh("git", ["cat-file", "blob", m[2]!], { cwd: project.root });
  return { content: Buffer.from(blob.stdout, "utf8"), stage: `${m[1]} ${m[2]} 0\t${rel}` };
}

export interface GuardedWrite {
  /** Refusal code when the checkout is not on the base branch (`card/branch`, `memory/branch`, `docs/branch`). */
  branchCode: string;
  /** What is written, for messages ("a card", "memory"). */
  what: string;
  /** Files (repository-relative) the write may change, saved before it. */
  files: string[];
  /** Folders whose every file is saved before the write (a write that picks a file name there). */
  dirs?: string[];
  /** The commit subject, or a function giving it after the write. */
  subject: string | (() => string);
}

/**
 * Check the preconditions (commitPreconditions), save the files the write may change, run `write`
 * (it returns the files it wrote), and commit them alone (commitAlone). When the write or the commit
 * fails, every file is put back as it was (content and index entry; a file the write created is
 * removed), so nothing is kept, and the error says so (`mcp/commit` for a failed commit).
 */
export function writeAndCommit(project: Project, g: GuardedWrite, write: () => string[]): string {
  commitPreconditions(project, g.branchCode, g.what);
  const saved = new Map<string, Saved>();
  for (const f of g.files) saved.set(f, saveOne(project, f));
  for (const d of g.dirs ?? []) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(project.root, d));
    } catch {
      // not there yet
    }
    for (const n of names) {
      const rel = `${d}/${n}`;
      if (!saved.has(rel) && fs.statSync(path.join(project.root, rel)).isFile()) saved.set(rel, saveOne(project, rel));
    }
  }
  let written: string[] = [];
  const rollback = () => {
    for (const f of new Set([...saved.keys(), ...written])) restoreOne(project, f, saved.get(f) ?? headState(project, f));
  };
  try {
    written = write();
  } catch (e) {
    rollback();
    throw e;
  }
  try {
    return commitAlone(project, written, typeof g.subject === "string" ? g.subject : g.subject());
  } catch (e) {
    rollback();
    if (e instanceof MwError && e.code === "mcp/commit") {
      throw new MwError("mcp/commit", `${e.message.replace(/; commit it by hand or restore it$/, "")}; nothing was kept: ${[...new Set(written)].join(", ")} restored to what it was and unstaged`);
    }
    throw e;
  }
}

/**
 * Commit `files` (repository-relative) alone with `subject`: `git add` then `git commit --only`, so
 * changes the owner staged for other files stay staged and out of the commit. Returns the reply
 * line naming the commit, or a line saying nothing changed. Refuses (`git/identity`) before staging
 * when git has no identity. The committing tools call it through writeAndCommit, which checks the
 * preconditions before writing and restores the files when the commit fails.
 */
export function commitAlone(project: Project, files: string[], subject: string): string {
  // A file the operation did not create (say, an index left as it was and never written) is not named.
  // A file-sync tool's temporary or conflict file is never committed.
  const rels = [...new Set(files)].filter((f) => !isSyncTemp(f) && fs.existsSync(path.join(project.root, f)));
  if (!rels.length) return "nothing written; nothing committed";
  const msg = subject.replace(/\s+/g, " ").trim().slice(0, 72);
  const id = gitIdentity(project.root);
  if (!id.ok) throw new MwError("mcp/commit", `wrote ${rels.join(", ")} but could not commit it (git has no identity: ${id.why}; ${IDENTITY_FIX}); commit it by hand or restore it`);
  try {
    git(project.root, ["add", "--", ...rels]);
    if (git(project.root, ["diff", "--cached", "--quiet", "--", ...rels], { allowFail: true }).code === 0) return `${rels.join(", ")} unchanged; nothing committed`;
    git(project.root, ["commit", "-q", "--only", "-m", msg, "--", ...rels]);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new MwError("mcp/commit", `wrote ${rels.join(", ")} but could not commit it (${why}); commit it by hand or restore it`);
  }
  const sha = git(project.root, ["rev-parse", "HEAD"]).stdout.trim();
  // On a hub-backed project the transaction (repoTransaction) pushes it and says so.
  const share = project.config.git.hub !== "none" ? "" : "; git.hub is none, so the commit stays in this checkout";
  return `committed ${rels.join(", ")} as ${sha.slice(0, 10)} ('${msg}')${share}`;
}
