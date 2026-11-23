// Git operations of a run: the card's branch and worktree, commits after write roles, diffs, and
// the squash merge built without touching any checkout. See docs/design/engine.md section 5.
import fs from "node:fs";
import path from "node:path";
import { setFrontmatter } from "../frontmatter.ts";
import { nowMs } from "../hub.ts";
import { localDir, type Project } from "../project.ts";
import { git, isSyncTemp, MwError, readText, type ShResult } from "../util.ts";
import type { Hub } from "./types.ts";

export function head(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]).stdout.trim();
}

export function currentBranch(cwd: string): string {
  return git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true }).stdout.trim();
}

export function branchExists(cwd: string, branch: string): boolean {
  return git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).code === 0;
}

/** The commit a local branch points at, or "" when it does not exist. */
export function branchHead(cwd: string, branch: string): string {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : "";
}

/** `mw run` works only from the main checkout with the base branch checked out. */
export function requireOnBase(root: string, base: string): void {
  if (git(root, ["rev-parse", "--git-dir"], { allowFail: true }).code !== 0) {
    throw new MwError("run/no-git", `${root} is not a git repository; run 'git init' and commit the project first`);
  }
  if (!branchExists(root, base)) {
    throw new MwError("run/no-base", `the base branch '${base}' does not exist yet; commit the project to it first`);
  }
  const cur = currentBranch(root);
  if (cur !== base) {
    throw new MwError("run/not-on-base", `the main checkout is on '${cur || "a detached HEAD"}', but runs start from the base branch '${base}'; run 'git switch ${base}' first`);
  }
}

interface WorktreeEntry {
  path: string;
  branch?: string;
}

export function worktrees(root: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | undefined;
  for (const line of git(root, ["worktree", "list", "--porcelain"]).stdout.split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9) }; out.push(cur); }
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return out;
}

const real = (p: string) => {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
};

/** True when `p` exists, symbolic links included (without following them). */
function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isRegistered(root: string, dir: string): boolean {
  return worktrees(root).some((w) => real(w.path) === real(dir));
}

/** Where a card's worktree lives: `<root>/.mergewright/worktrees/<CARD>`. */
export function cardWorktreePath(project: Project, cardId: string): string {
  return path.join(project.workDir, "worktrees", cardId);
}

export type Verified = { ok: true; path: string } | { ok: false; why: string };

/**
 * The gate in front of reusing a card worktree and committing in it. Nothing
 * destructive is run in place after it: a worktree that must go is moved aside by
 * `discardWorktree`, because a check and a later command on the same path can be raced. Passes only
 * when the path is a real directory (not a symbolic link), its canonical path is
 * `<root>/.mergewright/worktrees/<CARD>`, git reports that same directory as its top level (so git
 * run there cannot reach the main checkout), its git directory lies inside the main repository's
 * `.git/worktrees/`, and it has `card/<CARD>` checked out. `why` names the check that failed.
 */
export function verifiedWorktree(project: Project, cardId: string): Verified {
  const dir = cardWorktreePath(project, cardId);
  const fail = (why: string): Verified => ({ ok: false, why: `the worktree ${dir} failed a safety check: ${why}` });
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return fail("it does not exist");
  }
  if (st.isSymbolicLink()) return fail("it is a symbolic link, not a directory");
  if (!st.isDirectory()) return fail("it is not a directory");
  const expected = path.join(real(project.root), path.relative(project.root, project.workDir), "worktrees", cardId);
  const canonical = real(dir);
  if (canonical !== expected) return fail(`its real path is ${canonical}, not ${expected}`);
  const top = git(dir, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code !== 0) return fail("git does not recognise it as a working tree");
  if (real(top.stdout.trim()) !== expected) return fail(`git treats it as part of ${top.stdout.trim()} (its .git file is missing or wrong), not as its own working tree`);
  const gitDir = git(dir, ["rev-parse", "--absolute-git-dir"], { allowFail: true }).stdout.trim();
  const common = git(project.root, ["rev-parse", "--git-common-dir"], { allowFail: true }).stdout.trim();
  const admin = real(path.join(path.resolve(project.root, common), "worktrees")) + path.sep;
  if (!gitDir || !real(gitDir).startsWith(admin)) return fail(`its git directory ${gitDir || "(none)"} is not inside ${admin}`);
  const branch = currentBranch(dir);
  if (branch !== `card/${cardId}`) return fail(`it has ${branch ? `'${branch}'` : "a detached HEAD"} checked out, not 'card/${cardId}'`);
  return { ok: true, path: dir };
}

/** Paths with staged, unstaged or untracked changes (`git status`, renames as delete plus add). */
export function dirtyFiles(cwd: string, pathspec: string[] = []): string[] {
  const r = git(cwd, ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", "--", ...pathspec]);
  // Sync temporary and conflict files are never the work, so they never count.
  return r.stdout.split("\0").filter(Boolean).map((e) => e.slice(3)).filter((f) => !isSyncTemp(f));
}

/** Where replaced worktrees are kept: `.mergewright/local/discarded/` (this machine's own). */
export function discardedDir(project: Project): string {
  return path.join(localDir(project), "discarded");
}

/** How long a discarded worktree is kept before `cleanDiscarded` removes it. */
export const DISCARD_KEEP_MS = 7 * 24 * 60 * 60_000;

/** Test-only seams. Nothing in the runtime sets them. */
export const gitopsTestHooks: {
  beforeDiscard?: (dir: string) => void;
  /** The worktree was moved to `copy`; its `.git` pointer is about to be detached. */
  beforeDetach?: (copy: string) => void;
} = {};

const stampOf = (ms: number) => new Date(ms).toISOString().replace(/:/g, "-").replace(".", "-");
const STAMPED = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-\d+)?$/;

/**
 * The discard folder as the runtime may use it, or a reason why not. Its real path
 * must be exactly `<real root>/.mergewright/local/discarded`: a symbolic link at it or at any folder
 * above it (`.mergewright/local` itself, say) would send moves and the seven-day clean-up elsewhere.
 * With `create`, a missing folder is made (only inside a parent that passes the same check).
 */
function discardRoot(project: Project, create: boolean): { dir: string; why?: string } {
  const dir = discardedDir(project);
  const expected = path.join(real(project.root), path.relative(project.root, dir));
  const check = (p: string, want: string): string | undefined => {
    const got = real(p);
    return got === want ? undefined : `its real path is ${got}, not ${want}`;
  };
  if (!lexists(dir)) {
    if (!create) return { dir };
    const parent = path.dirname(dir);
    fs.mkdirSync(parent, { recursive: true });
    const why = check(parent, path.dirname(expected));
    if (why) return { dir, why: `${parent} ${why}` };
    try {
      fs.mkdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  const why = check(dir, expected);
  return why ? { dir, why: `${dir} ${why}` } : { dir };
}

/**
 * Cut the moved copy's link to git, so git run inside it can never act on a live
 * worktree. A `.git` pointer file is renamed to a name no other file has; a `.git` symbolic link is
 * unlinked. Only a real directory copy is touched (a moved-aside link is never followed). Returns false
 * when the pointer is still in place.
 */
function detach(copy: string): boolean {
  gitopsTestHooks.beforeDetach?.(copy);
  const ptr = path.join(copy, ".git");
  try {
    if (!fs.lstatSync(copy).isDirectory()) return true;
    const st = fs.lstatSync(ptr);
    if (st.isSymbolicLink()) fs.unlinkSync(ptr);
    else if (st.isFile()) {
      let to = path.join(copy, `.git.discarded-${stampOf(nowMs())}`);
      for (let n = 2; lexists(to); n++) to = path.join(copy, `.git.discarded-${stampOf(nowMs())}-${n}`);
      fs.renameSync(ptr, to);
    }
    // A `.git` directory is a repository of its own, not a link to one of this repository's worktrees.
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" && !lexists(ptr);
  }
}

/**
 * When the copy's pointer could not be detached: keep its git administrative entry from ever being
 * reused by a fresh worktree. The entry is re-pointed at the copy (`git worktree repair`), so it is no
 * longer registered at the card's worktree path and is not pruned, and its HEAD is detached, so the card
 * branch is free. A fresh worktree at the card's path then gets a new administrative name. Throws when
 * that cannot be done (the caller then stops rather than recreate the worktree).
 */
function retireAdmin(project: Project, copy: string): void {
  const fail = (why: string) => new MwError("worktree/move-failed", `${copy} was moved aside, but its git pointer (.git) could not be removed and its git entry could not be retired (${why}). Delete ${path.join(copy, ".git")} by hand, then try again.`);
  let pointer: string;
  try {
    pointer = fs.readFileSync(path.join(copy, ".git"), "utf8");
  } catch (e) {
    throw fail(`the pointer cannot be read: ${(e as Error).message}`);
  }
  const m = /^gitdir:\s*(.+)\s*$/m.exec(pointer);
  if (!m) throw fail("the pointer names no git directory");
  const admin = real(path.resolve(copy, m[1]!.trim()));
  const common = git(project.root, ["rev-parse", "--git-common-dir"]).stdout.trim();
  if (path.dirname(admin) !== real(path.join(path.resolve(project.root, common), "worktrees"))) throw fail(`${admin} is not one of this repository's worktree entries`);
  const r = git(project.root, ["worktree", "repair", copy], { allowFail: true });
  if (r.code !== 0) throw fail((r.stderr || r.stdout).trim());
  const at = git(project.root, ["--git-dir", admin, "rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true }).stdout.trim();
  if (!at) throw fail("its HEAD cannot be read");
  git(project.root, ["--git-dir", admin, "update-ref", "--no-deref", "HEAD", at]);
}

/**
 * Set aside whatever is at the card's worktree path: rename it to
 * `.mergewright/local/discarded/<CARD>-<UTC time>`, detach the copy from git, then `git worktree prune`.
 * A rename moves a symbolic link itself and never empties what it points to, and nothing is reset,
 * cleaned or deleted, so this is safe whatever replaced the worktree after it was checked. Uncommitted
 * and ignored files are kept there (for DISCARD_KEEP_MS). Returns the new path, or undefined when
 * nothing was at the path. Throws `worktree/move-failed` when it cannot be done safely.
 */
export function discardWorktree(project: Project, cardId: string): string | undefined {
  const dir = cardWorktreePath(project, cardId);
  gitopsTestHooks.beforeDiscard?.(dir);
  if (!lexists(dir)) return undefined;
  const root = discardRoot(project, true);
  if (root.why) {
    throw new MwError("worktree/move-failed", `could not move ${dir} aside: the discard folder failed a safety check (${root.why}), so nothing was moved there. Make ${discardedDir(project)} an ordinary folder inside the project again, then try again.`);
  }
  const parent = root.dir;
  const stamp = stampOf(nowMs());
  let to = path.join(parent, `${cardId}-${stamp}`);
  for (let n = 2; lexists(to); n++) to = path.join(parent, `${cardId}-${stamp}-${n}`);
  try {
    fs.renameSync(dir, to);
  } catch (e) {
    throw new MwError("worktree/move-failed", `could not move ${dir} aside to ${to}: ${(e as Error).message}. Nothing was deleted; move it out of the way by hand, then try again.`);
  }
  // The copy still carries the worktree's `.git` pointer. Left as it is, git commands run inside the
  // copy would act on whichever worktree later reuses that administrative name.
  if (!detach(to)) {
    retireAdmin(project, to);
    return to; // no prune: the retired entry now belongs to the copy
  }
  git(project.root, ["worktree", "prune"], { allowFail: true });
  return to;
}

/**
 * Move a card's run record (`.mergewright/runs/<CARD>/`) aside to
 * `.mergewright/local/discarded/<CARD>-run-<UTC time>`, where `cleanDiscarded` removes it after
 * DISCARD_KEEP_MS. The caller holds the card's run lock. Returns the new path, or undefined when there
 * was no record. Throws `worktree/move-failed` when the discard folder fails its check or the rename fails.
 */
export function discardRunDir(project: Project, cardId: string): string | undefined {
  const dir = path.join(project.workDir, "runs", cardId);
  if (!lexists(dir)) return undefined;
  const root = discardRoot(project, true);
  if (root.why) throw new MwError("worktree/move-failed", `could not move the run record ${dir} aside: the discard folder failed a safety check (${root.why}). Make ${discardedDir(project)} an ordinary folder inside the project again, then try again.`);
  const stamp = stampOf(nowMs());
  let to = path.join(root.dir, `${cardId}-run-${stamp}`);
  for (let n = 2; lexists(to); n++) to = path.join(root.dir, `${cardId}-run-${stamp}-${n}`);
  try {
    fs.renameSync(dir, to);
  } catch (e) {
    throw new MwError("worktree/move-failed", `could not move the run record ${dir} aside to ${to}: ${(e as Error).message}. Nothing was deleted.`);
  }
  return to;
}

/**
 * Remove the entries of `.mergewright/local/discarded/` set aside more than DISCARD_KEEP_MS ago (by the
 * time in their name). `fs.rmSync` unlinks a symbolic link rather than following it. Returns the names
 * removed. Called at the start of every run. Throws (removing nothing) when the folder fails the check
 * of `discardRoot`.
 */
export function cleanDiscarded(project: Project): string[] {
  const root = discardRoot(project, false);
  if (root.why) throw new MwError("worktree/discard-unsafe", `nothing was removed from the discard folder, because it failed a safety check (${root.why}). Make ${discardedDir(project)} an ordinary folder inside the project again.`);
  const dir = root.dir;
  let names: string[];
  try {
    if (!fs.lstatSync(dir).isDirectory()) return []; // a link in its place is not followed
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const m = STAMPED.exec(name);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
    if (Number.isNaN(t) || nowMs() - t < DISCARD_KEEP_MS) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export interface EnsureResult {
  /** Set when the run must stop with this reason (what was in the way could not be moved aside). */
  blocked?: string;
  /** Where what stood at the worktree path was moved (`.mergewright/local/discarded/...`), when it was. */
  discarded?: string;
}

/**
 * Make sure the card's worktree exists on its branch, level with the hub's copy of that branch. The hub
 * is asked first, every time: after the other machine worked on the card, this machine's branch is
 * behind, and continuing from it would redo or lose that work. A registered worktree is reused only
 * after `verifiedWorktree`. Anything else at the path (an old synced copy, a symbolic link, a directory
 * git does not list, a worktree that fails a check), and a worktree whose branch moved on under
 * uncommitted leftovers of an interrupted phase, is moved aside by `discardWorktree` and a fresh
 * worktree is made from the branch. Nothing is ever reset, cleaned or deleted in place.
 */
export async function ensureWorktree(project: Project, cardId: string, base: string, hub: Hub): Promise<EnsureResult> {
  const root = project.root;
  const dir = cardWorktreePath(project, cardId);
  const branch = `card/${cardId}`;
  git(root, ["worktree", "prune"], { allowFail: true });
  let discarded: string | undefined;
  const aside = () => { discarded = discardWorktree(project, cardId) ?? discarded; };
  try {
    let registered = false;
    if (lexists(dir)) {
      if (!fs.lstatSync(dir).isSymbolicLink() && isRegistered(root, dir) && verifiedWorktree(project, cardId).ok) registered = true;
      else aside();
    }
    const before = registered ? head(dir) : "";
    try {
      await hub.fetchBranch(branch);
    } catch (err) {
      if (!(registered && err instanceof MwError && err.code === "hub/branch-busy")) throw err;
      // The hub's branch is ahead and leftovers of an unfinished phase are in the way: that phase is
      // redone from the hub's commit, so the worktree is replaced.
      aside();
      registered = false;
      await hub.fetchBranch(branch);
    }
    if (registered) {
      if (head(dir) === before || !dirtyFiles(dir).length) return {};
      aside(); // the branch moved on: the leftovers belong to a phase that is redone
    }
  } catch (err) {
    if (err instanceof MwError && err.code === "worktree/move-failed") return { blocked: `${err.message} Then run 'mw run ${cardId}' again.`, discarded };
    throw err;
  }
  if (!branchExists(root, branch)) git(root, ["branch", branch, base]);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(root, ["worktree", "add", "--quiet", dir, branch]);
  return { discarded };
}

/**
 * Remove the card's worktree: it is always moved aside with `discardWorktree`
 * (kept for seven days with every file in it, ignored ones included), never deleted with
 * `git worktree remove`. Returns where it was moved, or undefined when nothing was at the path.
 */
export function removeWorktree(project: Project, cardId: string): string | undefined {
  git(project.root, ["worktree", "prune"], { allowFail: true });
  return discardWorktree(project, cardId);
}

export function deleteBranch(root: string, branch: string): void {
  if (branchExists(root, branch)) git(root, ["branch", "-D", branch]);
}

/**
 * Stage everything (never sync temporary or conflict files) and commit when
 * anything changed. Returns true when a commit was made.
 */
export function commitAll(cwd: string, message: string): boolean {
  git(cwd, ["add", "-A"]);
  unstageSyncTemp(cwd);
  if (git(cwd, ["diff", "--cached", "--quiet"], { allowFail: true }).code === 0) return false;
  git(cwd, ["commit", "--quiet", "--no-verify", "-m", message]);
  return true;
}

/** Take sync temporary and conflict files back out of the index (they stay on disk). */
export function unstageSyncTemp(cwd: string): void {
  const staged = git(cwd, ["diff", "--cached", "--name-only", "--no-renames", "-z"], { allowFail: true }).stdout.split("\0").filter((f) => f && isSyncTemp(f));
  if (!staged.length) return;
  if (git(cwd, ["reset", "-q", "--", ...staged], { allowFail: true }).code !== 0) git(cwd, ["rm", "-q", "--cached", "--", ...staged]);
}

/** Files changed on the branch since it left `base`; a rename counts as a delete plus an add. */
export function changedFiles(cwd: string, base: string, tip = "HEAD"): string[] {
  return git(cwd, ["diff", "--no-renames", "--name-only", "-z", `${base}...${tip}`]).stdout.split("\0").filter(Boolean);
}

/**
 * True when the branch's only change to the card file is the runtime's own: the file at HEAD is the
 * file at the fork point with `status: done` set (the merge phase's commit, kept when a merge failed
 * and the card went back to work). REQ-engine-010: when the fork point has no card file, the merge
 * phase took it from the base, so the file at HEAD is compared with the base's.
 */
export function runtimeCardEdit(cwd: string, base: string, cardFile: string): boolean {
  const mb = git(cwd, ["merge-base", base, "HEAD"], { allowFail: true }).stdout.trim();
  if (!mb) return false;
  let before = git(cwd, ["show", `${mb}:${cardFile}`], { allowFail: true });
  if (before.code !== 0) before = showOnBase(cwd, base, cardFile);
  const after = git(cwd, ["show", `HEAD:${cardFile}`], { allowFail: true });
  if (before.code !== 0 || after.code !== 0) return false;
  return after.stdout === setFrontmatter(before.stdout, { status: "done" });
}

/** File `rel` (relative to the repository root) as it is on branch `base` (`git show`); never throws. */
export function showOnBase(cwd: string, base: string, rel: string): ShResult {
  return git(cwd, ["show", `refs/heads/${base}:${rel.split(path.sep).join("/")}`], { allowFail: true });
}

/**
 * REQ-engine-010: the text of card file `rel` for the merge phase, read in checkout `cwd`. When that
 * checkout has no such file (ENOENT only, as on a branch made before the project used MergeWright), the
 * file is taken from branch `base` (`showOnBase`), where the cards are the source of truth. Any other
 * failure, and a base without the card, throws.
 */
export function mergeCardText(cwd: string, rel: string, base: string): string {
  try {
    return readText(path.join(cwd, rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const r = showOnBase(cwd, base, rel);
  if (r.code !== 0) throw new MwError("git", `${rel} is missing here and on ${base} (${(r.stderr || r.stdout).trim().split("\n").slice(-1)[0] ?? ""})`);
  return r.stdout;
}

export function diffText(cwd: string, base: string): string {
  const stat = git(cwd, ["diff", "--stat", `${base}...HEAD`]).stdout;
  const diff = git(cwd, ["diff", `${base}...HEAD`]).stdout;
  return `${stat}\n${diff}`.trim();
}

export interface SquashResult {
  ok: boolean;
  commit?: string;
  /** The base commit the squash was built on (its parent). */
  base?: string;
  /** Why it failed: conflicted paths, or git refusing to overwrite local edits. */
  detail: string;
}

/**
 * The tree of `tip` merged onto `onto` (`git merge-tree --write-tree`), or why there is none: `conflicts`
 * lists the conflicted paths, `failed` says why git could not merge at all. REQ-engine-010:
 * when `cardFile` is given and the only conflict is an add/add on that file, where the branch's version
 * is the base's version with `status: done` (the merge phase took the card from the base after the
 * branch forked, and the base added it too), the branch's version is taken and the tree is returned.
 * Any other conflict, or any other conflict type on the card file, stays a conflict.
 */
export function squashTree(root: string, onto: string, tip: string, cardFile?: string): { tree?: string; conflicts?: string[]; failed?: string } {
  const mt = git(root, ["merge-tree", "--write-tree", onto, tip], { allowFail: true });
  const [head = "", ...rest] = mt.stdout.split("\n");
  if (mt.code === 0 && head.trim()) return { tree: head.trim() };
  if (mt.code !== 1) return { failed: `git merge-tree failed: ${(mt.stderr || mt.stdout).trim().split("\n").slice(-3).join(" | ")}` };
  const blank = rest.indexOf("");
  const entries = (blank < 0 ? rest : rest.slice(0, blank)).map((l) => /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/.exec(l)).filter((m) => m !== null);
  const messages = blank < 0 ? [] : rest.slice(blank + 1);
  const conflicts = [...new Set(entries.map((m) => m[4]!))];
  const resolved = cardFile ? cardAddAdd(root, cardFile, entries, messages) : undefined;
  if (cardFile && resolved && conflicts.length === 1 && conflicts[0] === cardFile) {
    return { tree: replaceInTree(root, head.trim(), cardFile.split("/"), resolved.mode, resolved.oid) };
  }
  return { conflicts };
}

/**
 * The branch's blob for an add/add conflict on `cardFile` alone, when it is the base's version with
 * `status: done`; undefined for anything else.
 */
function cardAddAdd(root: string, cardFile: string, entries: RegExpExecArray[], messages: string[]): { mode: string; oid: string } | undefined {
  const conflictLines = messages.filter((l) => l.startsWith("CONFLICT"));
  if (conflictLines.length !== 1 || conflictLines[0] !== `CONFLICT (add/add): Merge conflict in ${cardFile}`) return undefined;
  if (entries.some((m) => m[4] !== cardFile)) return undefined;
  const stages = new Map(entries.map((m) => [m[3]!, { mode: m[1]!, oid: m[2]! }]));
  const ours = stages.get("2");
  const theirs = stages.get("3");
  if (stages.has("1") || stages.size !== 2 || !ours || !theirs) return undefined;
  const blob = (oid: string) => git(root, ["cat-file", "blob", oid], { allowFail: true });
  const base = blob(ours.oid);
  const branch = blob(theirs.oid);
  if (base.code !== 0 || branch.code !== 0) return undefined;
  return branch.stdout === setFrontmatter(base.stdout, { status: "done" }) ? theirs : undefined;
}

/** `tree` with the blob at `parts` (a path split on "/") set to `oid`, written with `git mktree`. */
function replaceInTree(root: string, tree: string, parts: string[], mode: string, oid: string): string {
  const [name, ...below] = parts;
  const entries = git(root, ["ls-tree", "-z", tree]).stdout.split("\0").filter(Boolean);
  const out: string[] = [];
  let found = false;
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const [eMode, eType, eOid] = entry.slice(0, tab).split(" ");
    if (entry.slice(tab + 1) !== name) {
      out.push(entry);
      continue;
    }
    found = true;
    if (below.length) out.push(`${eMode} ${eType} ${replaceInTree(root, eOid!, below, mode, oid)}\t${name}`);
    else out.push(`${mode} blob ${oid}\t${name}`);
  }
  if (!found) throw new MwError("git", `${parts.join("/")} is not in tree ${tree.slice(0, 10)}`);
  return git(root, ["mktree", "-z"], { input: out.join("\0") + "\0" }).stdout.trim();
}

/**
 * Build the squash commit of `branch` onto `base` without touching any checkout. `cardFile` is the
 * card's file, whose add/add conflict alone `squashTree` resolves in favour of the branch.
 */
export function buildSquash(root: string, base: string, branch: string, message: string, cardFile?: string): SquashResult {
  const baseCommit = git(root, ["rev-parse", `refs/heads/${base}`]).stdout.trim();
  const st = squashTree(root, base, branch, cardFile);
  if (st.conflicts) {
    return { ok: false, detail: `the branch conflicts with ${base} in: ${st.conflicts.join(", ")}. Rebuild the change on top of the current ${base} so these files merge cleanly.` };
  }
  if (!st.tree) return { ok: false, detail: st.failed ?? "git merge-tree failed" };
  const commit = git(root, ["commit-tree", st.tree, "-p", baseCommit], { input: message }).stdout.trim();
  return { ok: true, commit, base: baseCommit, detail: "" };
}

/**
 * REQ-gate-004: the base commit a tree checked at `tip` builds on: where `tip` left `base` (their merge
 * base), or "" when they share no history.
 */
export function forkPoint(root: string, base: string, tip: string): string {
  const r = git(root, ["merge-base", `refs/heads/${base}`, tip], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : "";
}

/** The tree of a commit (`git rev-parse <commit>^{tree}`). */
export function treeOf(root: string, commit: string): string {
  return git(root, ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`]).stdout.trim();
}

/**
 * REQ-gate-004: run `fn` in a temporary worktree with `commit` checked out on a detached HEAD, under
 * `.mergewright/local/regate/` (this machine's own, never synced). The worktree holds no work of
 * anyone's, so it is removed outright (`git worktree remove --force`, then the folder) in a finally
 * path, whether `fn` passes, fails or throws; no branch is made.
 */
export async function withTempWorktree<T>(project: Project, cardId: string, commit: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const parent = path.join(localDir(project), "regate");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, `${cardId}-`));
  try {
    git(project.root, ["worktree", "add", "--quiet", "--detach", dir, commit]);
    return await fn(dir);
  } finally {
    git(project.root, ["worktree", "remove", "--force", "--force", dir], { allowFail: true });
    fs.rmSync(dir, { recursive: true, force: true });
    git(project.root, ["worktree", "prune"], { allowFail: true });
  }
}

/**
 * Move `base` to `commit` (a descendant): by `merge --ff-only` in the worktree that has `base`
 * checked out (git refuses rather than overwrite local edits), else by `update-ref`.
 */
export function moveBase(root: string, base: string, commit: string): SquashResult {
  const checkout = worktrees(root).find((w) => w.branch === base);
  if (checkout) {
    const r = git(checkout.path, ["merge", "--ff-only", "--quiet", commit], { allowFail: true });
    if (r.code !== 0) {
      const why = (r.stderr || r.stdout).trim().split("\n").filter((l) => l.trim()).slice(0, 8).join(" | ");
      return { ok: false, detail: `git refused to update ${base} in ${checkout.path} (local edits there would be overwritten; nothing was changed): ${why}. Commit or move those edits, then run the card again.` };
    }
  } else {
    const old = git(root, ["rev-parse", `refs/heads/${base}`]).stdout.trim();
    git(root, ["update-ref", `refs/heads/${base}`, commit, old]);
  }
  return { ok: true, commit, detail: `merged into ${base} as ${commit.slice(0, 10)}` };
}

/** True when `commit` exists and is an ancestor of (or equal to) `ref`. */
export function isAncestor(root: string, commit: string, ref: string): boolean {
  return git(root, ["merge-base", "--is-ancestor", commit, ref], { allowFail: true }).code === 0;
}

/** Files a commit changed, split into changed (added, modified, renamed to) and deleted. */
export function commitFiles(root: string, commit: string): { changed: string[]; deleted: string[] } {
  const out = { changed: [] as string[], deleted: [] as string[] };
  const r = git(root, ["diff", "--name-status", "--no-renames", "-z", `${commit}^`, commit], { allowFail: true });
  const parts = r.stdout.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!;
    const file = parts[i + 1]!;
    if (!status || !file) continue;
    if (status === "D") out.deleted.push(file);
    else out.changed.push(file);
  }
  return out;
}
