// Private files (REQ-engine-005): run folders are 0700 and what the runtime writes in them 0600, whatever
// the process umask. The mode is given at creation and set again with chmod, because a umask can take
// bits away from a mode but an existing file keeps the mode it had.
import fs from "node:fs";
import path from "node:path";
import { MwError, tmpNameFor } from "../util.ts";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * Make `dir` (and missing parents) and set `dir` itself to 0700. Refuses (`run/unsafe-path`) when `dir`
 * is a symbolic link or not a folder: nothing is created, narrowed or listed through it. Throws.
 */
export function privateDir(dir: string): void {
  assertRealDir(dir);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(dir, DIR_MODE);
}

/** Throws `run/unsafe-path` when `dir` exists and is not a real folder (a symbolic link among them). */
function assertRealDir(dir: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return; // missing: mkdir makes a real folder
  }
  if (st.isDirectory()) return;
  const what = st.isSymbolicLink() ? "is a symbolic link" : "is not a folder";
  throw new MwError("run/unsafe-path", `'${dir}' ${what}, so MergeWright does not create, narrow or write anything through it. Remove it (move anything of this run that it points to back into a real folder there), then run the card again.`);
}

/**
 * Open `file` for writing (truncated) with mode 0600, its folder 0700. Returns the descriptor. Never
 * writes through a symbolic link: one at `file` (left by an earlier run or synced in) is removed and a
 * fresh regular file made in its place; the open itself does not follow links (O_NOFOLLOW). Anything
 * else that is not a regular file is refused (`run/unsafe-path`). Throws.
 */
export function openPrivate(file: string): number {
  privateDir(path.dirname(file));
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  let fd: number | undefined;
  for (let attempt = 0; fd === undefined; attempt++) {
    unlinkIfLink(file);
    try {
      fd = fs.openSync(file, flags, FILE_MODE);
    } catch (e) {
      // A link put back between the check and the open: remove it once more, then give up.
      if ((e as NodeJS.ErrnoException).code !== "ELOOP" || attempt > 0) throw e;
    }
  }
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new MwError("run/unsafe-path", `'${file}' is not a regular file, so MergeWright does not write to it. Remove it, then run the card again.`);
    }
    fs.fchmodSync(fd, FILE_MODE); // an existing file keeps its old mode on open
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  return fd;
}

/** Remove `file` when it is a symbolic link (the link only, never its target). */
function unlinkIfLink(file: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return; // missing: the open creates it
  }
  if (st.isSymbolicLink()) fs.unlinkSync(file);
}

/**
 * Replace `file` with `content` through a temporary file created 0600 (exclusive create) and renamed
 * into place, so a reader never sees a half-written file and the file is never wider than 0600. Throws.
 */
export function writePrivate(file: string, content: string): void {
  privateDir(path.dirname(file));
  const tmp = tmpNameFor(file);
  try {
    fs.writeFileSync(tmp, content, { mode: FILE_MODE, flag: "wx" });
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Narrow `dir` and everything in it: folders to 0700, files to 0600. Symbolic links inside are left
 * alone (never followed); `dir` itself being one is refused (`privateDir`) before anything is changed
 * or listed. A missing folder is created. Throws on a folder it cannot narrow.
 */
export function narrowTree(dir: string): void {
  privateDir(dir);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) narrowTree(p);
    else if (e.isFile()) fs.chmodSync(p, FILE_MODE);
  }
}
