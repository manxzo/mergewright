// Usage-window guard: `config.usage.command` prints JSON `{"max_used": <0-100 | 0-1 | null>, ...}`
// (for example a script that reads the agent CLI's usage window). Hysteresis via a flag file.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sh } from "../util.ts";
import { splitCommand } from "./common.ts";

export interface UsageSettings {
  command?: string;
  pauseAtPct: number;
  resumeBelowPct: number;
  /** This machine's folder (`.mergewright/local`), where the pause flag lives. */
  localDir: string;
  cwd: string;
}

export interface UsageReading {
  /** Percentage 0-100, or undefined when it could not be read. */
  pct?: number;
  /** Why there is no reading. */
  problem?: string;
}

const TIMEOUT_MS = 30_000;

export function pausedFlag(localDir: string): string {
  return path.join(localDir, "usage-paused");
}

/** Run the command and read `max_used`. Never throws. */
export function readUsage(command: string, cwd: string): UsageReading {
  let args: string[];
  try {
    args = splitCommand(command);
  } catch (e) {
    return { problem: (e as Error).message };
  }
  if (!args.length) return { problem: "usage.command is empty" };
  const [cmd, ...rest] = args;
  const r = sh(cmd!, rest, { cwd, timeoutMs: TIMEOUT_MS });
  if (r.timedOut) return { problem: `${cmd} timed out` };
  if (r.code !== 0) return { problem: `${cmd} exited ${r.code}: ${(r.stderr || r.stdout).trim().split("\n").slice(-1)[0] ?? ""}` };
  const text = r.stdout.trim();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    const last = text.split("\n").reverse().find((l) => l.trim().startsWith("{"));
    try {
      doc = last ? JSON.parse(last) : undefined;
    } catch {
      doc = undefined;
    }
  }
  if (!doc || typeof doc !== "object") return { problem: `${cmd} did not print a JSON object` };
  const d = doc as { max_used?: unknown; error?: unknown; unavailable?: unknown };
  const v = d.max_used;
  if (v === null || v === undefined) {
    const why = typeof d.error === "string" ? d.error : typeof d.unavailable === "string" ? d.unavailable : "max_used is null";
    return { problem: `no usage reading (${why})` };
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return { problem: `max_used is not a number: ${JSON.stringify(v)}` };
  // Values up to 1 are fractions (0.42 = 42%); above 1 they are percentages.
  return { pct: v <= 1 ? v * 100 : v };
}

/**
 * REQ-usage-003: the pause flag is read first. While it is set, a failed reading (the command fails,
 * prints no JSON or `max_used: null`) keeps the pause and says the reading failed: only a successful
 * reading below `resumeBelowPct` clears it. Without a pause, a failed reading lets work continue.
 * A reading at or above `pauseAtPct` writes the flag anew (`publishFlag`, always a new inode); the
 * clear is a compare-and-remove (`clearPauseFlag`). Both hold the pause lock (`underFlagLock`), so a
 * clear and a high reading never interleave, and a pause another process wrote or renewed after this
 * one read the flag stands. A flag that exists but cannot be read is a pause this process cannot clear.
 * `<flag>.clearing.*` files left by an older version are adopted first (`adoptLeftovers`).
 * `hooks.beforeClear` runs between the decision to clear and the clear, `hooks.beforePublish` between
 * writing a high reading and putting it in place, `hooks.beforeUnlink` between the clear's comparison
 * and its removal, `hooks.beforeRecover` between judging the lock stale and taking the recovery file,
 * `hooks.beforeDropStale` between a recoverer's last check and its move of the lock aside,
 * `hooks.afterCreate` between creating the lock and writing its owner (tests use them to interleave);
 * `hooks.sleep` is the pause between tries of a busy lock; the other hooks are file operations.
 */
export function usageGate(s: UsageSettings, hooks: { beforeClear?: () => void } & ClearOps & PublishOps = {}): { ok: boolean; detail: string } {
  if (!s.command) return { ok: true, detail: "no usage guard configured" };
  const flag = pausedFlag(s.localDir);
  const stuck = adoptLeftovers(flag, hooks);
  // Only a missing flag means "no pause": a flag that exists but cannot be read (a directory at the
  // path, no permission) is a pause that this process cannot clear.
  const seen = observeFlag(flag);
  const unreadable = seen && "error" in seen ? seen.error : undefined;
  const paused = seen !== undefined || stuck !== undefined;
  const r = readUsage(s.command, s.cwd);
  if (r.pct === undefined) {
    if (paused) return { ok: false, detail: `usage reading failed (${r.problem}): still paused until a reading below ${s.resumeBelowPct}%` };
    return { ok: true, detail: `usage guard could not run: ${r.problem}` };
  }
  const pct = Math.round(r.pct * 10) / 10;
  if (pct >= s.pauseAtPct) {
    // Written even when the flag exists, so a concurrent reading that would clear the pause sees that
    // the flag changed and keeps it.
    const failed = publishFlag(flag, `${new Date().toISOString()} ${pct}\n`, hooks);
    const why = failed ? ` (the pause flag could not be written: ${failed})` : "";
    return { ok: false, detail: `usage at ${pct}% (pause at ${s.pauseAtPct}%)${why}: paused until below ${s.resumeBelowPct}%` };
  }
  if (paused && pct >= s.resumeBelowPct) return { ok: false, detail: `usage at ${pct}%: still paused until below ${s.resumeBelowPct}%` };
  if (paused) {
    const notCleared = (why: string) => ({ ok: false, detail: `usage at ${pct}%, but the pause flag could not be cleared (${why}): still paused until below ${s.resumeBelowPct}%` });
    if (stuck !== undefined) return notCleared(stuck);
    if (unreadable !== undefined) return notCleared(`the pause flag could not be read (${unreadable})`);
    try {
      hooks.beforeClear?.();
    } catch (e) {
      return notCleared(errText(e));
    }
    const cleared = clearPauseFlag(flag, seen as FlagSeen, hooks);
    if (cleared === "changed") {
      return { ok: false, detail: `usage at ${pct}%, but another reading kept the pause while this one ran: still paused until below ${s.resumeBelowPct}%` };
    }
    if (cleared !== "cleared") return notCleared(cleared.error);
  }
  return { ok: true, detail: `usage at ${pct}%${paused ? " (resumed)" : ""}` };
}

/** What a process saw of the pause flag: content, modification time and inode. */
export interface FlagSeen {
  content: string;
  mtimeMs: number;
  ino: number;
}

/**
 * Content and stat of one open file, so both describe the same inode. Undefined only when it is
 * missing (ENOENT); any other error (a directory, no permission) is returned, so the caller stays paused.
 */
function observeFlag(file: string): FlagSeen | { error: string } | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { error: errText(e) };
  }
  try {
    const st = fs.fstatSync(fd);
    return { content: fs.readFileSync(fd, "utf8"), mtimeMs: st.mtimeMs, ino: st.ino };
  } catch (e) {
    return { error: errText(e) };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Nothing to do: the content and stat were read or were not.
    }
  }
}

/** How often a busy pause lock is tried, and the pause between tries: about 50 ms in all. */
const LOCK_TRIES = 6;
const LOCK_WAIT_MS = 10;
/** A lock whose owner is gone is taken over only once it is older than this. */
const LOCK_GRACE_MS = 2_000;
/** A lock with no readable owner (a crash between create and write) is taken over only once it is older than this. */
const UNOWNED_LOCK_MS = 60_000;

/**
 * Test seams for the pause lock: hooks after a lock is judged stale, between the recoverer's last
 * check and its move of the lock aside, and between creating the lock and writing its owner; the
 * pause between tries of a busy lock; the rename that moves a stale lock aside; and the unlink of the
 * moved name after a live lock was put back.
 */
export interface LockOps {
  beforeRecover?: () => void;
  beforeDropStale?: () => void;
  afterCreate?: () => void;
  sleep?: (ms: number) => void;
  renameLock?: (from: string, to: string) => void;
  unlinkLock?: (file: string) => void;
}

/**
 * Run `body` holding the pause lock `<flag>.lock`, which the clear and the writer of a high reading
 * both take, so they never interleave. The lock is created with `wx` and holds `{pid, time, nonce}`;
 * it is released in `finally` on every path, and only while it is still this holder's own
 * (`releaseLock`). A busy lock is tried `LOCK_TRIES` times with a short pause, then `refused` is
 * returned with the reason, and `body` does not run. A lock is stale only when its owner pid is gone
 * (`process.kill(pid, 0)` gives ESRCH) and it is older than `LOCK_GRACE_MS`, never by age alone; a
 * lock with no readable owner is stale only after `UNOWNED_LOCK_MS`. A stale lock is recovered at most
 * once per call (`dropStaleLock`): it is never unlinked by its path but renamed aside to a unique name,
 * compared again (inode and content) with the lock judged stale, and discarded only on a match; a
 * lock that turns out to be a live holder's is put back without replacing any lock taken meanwhile.
 * When that recovery cannot finish safely (the rename fails, a live lock cannot be put back, or its
 * moved name cannot be removed after it was put back),
 * `refused` is returned and `body` does not run. After writing its owner and right before `body`, the holder reads
 * the lock again: a holder stalled for long between creating the lock and writing its owner may have
 * had it taken over as stale meanwhile. Unless the lock still has this holder's inode and content,
 * `body` does not run, the other holder's lock stays, and `refused` is returned (the pause lock was
 * lost). Never throws on its own account; `body` may.
 */
function underFlagLock<T>(flag: string, refused: (why: string) => T, body: () => T, ops: LockOps = {}): T {
  const lock = `${flag}.lock`;
  let recovered = false;
  let why = "the pause lock is held by another process";
  for (let i = 0; i < LOCK_TRIES; i++) {
    let fd: number;
    try {
      fs.mkdirSync(path.dirname(flag), { recursive: true });
      fd = fs.openSync(lock, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return refused(`the pause lock could not be taken (${errText(e)})`);
      const held = observeFlag(lock);
      // Released meanwhile: try again at once.
      if (held === undefined) continue;
      if ("error" in held) return refused(`the pause lock could not be read (${held.error})`);
      const owner = lockOwner(held.content);
      why = `the pause lock is held by ${owner ? `pid ${owner.pid}` : "an unknown process"}`;
      if (!recovered && staleLock(held, owner)) {
        recovered = true;
        const stop = dropStaleLock(lock, held, ops);
        if (stop !== undefined) return refused(stop);
        continue;
      }
      if (i < LOCK_TRIES - 1) (ops.sleep ?? sleepSync)(LOCK_WAIT_MS);
      continue;
    }
    const mine: { ino?: number; content?: string } = {};
    try {
      try {
        mine.ino = fs.fstatSync(fd).ino;
        ops.afterCreate?.();
        const content = JSON.stringify({ pid: process.pid, time: Date.now(), nonce: randomHex() });
        fs.writeSync(fd, content);
        mine.content = content;
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      releaseLock(lock, mine);
      return refused(`the pause lock could not be written (${errText(e)})`);
    }
    try {
      if (!ownLock(lock, mine)) return refused("the pause lock was lost to another process while it was being taken");
      return body();
    } finally {
      releaseLock(lock, mine);
    }
  }
  return refused(why);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether the lock at the path is still the one this holder made: the same inode and, once written, the same `{pid, time, nonce}`. */
function ownLock(lock: string, mine: { ino?: number; content?: string }): boolean {
  return sameLock(observeFlag(lock), mine);
}

/** Whether a lock file as read is the lock `mine` describes: the same inode and, when given, the same content. */
function sameLock(now: FlagSeen | { error: string } | undefined, mine: { ino?: number; content?: string }): now is FlagSeen {
  if (!now || "error" in now || mine.ino === undefined || now.ino !== mine.ino) return false;
  return mine.content === undefined || now.content === mine.content;
}

/**
 * Remove the lock only while it is still the one this holder made (`ownLock`). Another holder's lock
 * is never removed. While this holder lives its lock is never stale, so nobody else removes or
 * replaces it between this check and the unlink.
 */
function releaseLock(lock: string, mine: { ino?: number; content?: string }): void {
  if (!ownLock(lock, mine)) return;
  try {
    fs.unlinkSync(lock);
  } catch {
    // Left behind with this pid: once this process is gone, the next taker finds it stale.
  }
}

/** The `{pid, time}` a lock holds, or undefined when it is empty, half-written or not a lock. */
function lockOwner(content: string): { pid: number; time: number } | undefined {
  try {
    const o = JSON.parse(content) as { pid?: unknown; time?: unknown };
    if (Number.isInteger(o.pid) && (o.pid as number) > 0 && Number.isFinite(o.time)) return { pid: o.pid as number, time: o.time as number };
  } catch {
    // Not JSON: no owner.
  }
  return undefined;
}

/** Owner gone and older than the grace period; without a readable owner, only very old. Age is the younger of `time` and mtime. */
function staleLock(held: FlagSeen, owner: { pid: number; time: number } | undefined): boolean {
  const now = Date.now();
  if (!owner) return now - held.mtimeMs > UNOWNED_LOCK_MS;
  return now - Math.max(owner.time, held.mtimeMs) > LOCK_GRACE_MS && !pidAlive(owner.pid);
}

/** Whether `pid` is a live process. Only ESRCH means gone; any other answer (EPERM: another user's) counts as alive. */
function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Remove a stale lock. Recoverers are serialised by a second exclusive file, `<lock>.recover`, taken
 * only with `wx` and never taken over. Holding it, the recoverer reads the lock again and goes on only
 * if it is still the one judged stale (same inode and content, `sameLock`) and still stale. It never
 * unlinks `<lock>` itself: a holder stalled between creating the lock and writing its owner may resume
 * after this last check, write its owner and pass its own re-check. So the lock is moved aside with one
 * atomic rename to a unique `<lock>.stale.<pid>.<random>` in the same folder, and the moved file is
 * compared again with the lock judged stale. Only on a match is the moved file unlinked. Otherwise it
 * is a live holder's lock and is put back with `link` (which never replaces a lock already at the path)
 * and its moved name is unlinked; it is never deleted. The recovery file is always removed in `finally`.
 * Returns undefined when the caller may try the lock again (a busy recovery file, a changed lock, a lock
 * already gone, a stale lock discarded or a live one put back; the caller then finds the lock busy or
 * free), or why the caller must refuse: the rename failed, the stale file could not be removed, a
 * live lock could not be put back (its moved file is left where it is), or a live lock was put back
 * but its moved name could not be removed (the restored lock stays). Nothing more is removed then.
 */
function dropStaleLock(lock: string, held: FlagSeen, ops: LockOps): string | undefined {
  const recover = `${lock}.recover`;
  let fd: number;
  try {
    ops.beforeRecover?.();
    fd = fs.openSync(recover, "wx");
  } catch {
    return undefined;
  }
  try {
    fs.closeSync(fd);
    const now = observeFlag(lock);
    if (!sameLock(now, held) || !staleLock(now, lockOwner(now.content))) return undefined;
    ops.beforeDropStale?.();
    const moved = `${lock}.stale.${process.pid}.${randomHex()}`;
    try {
      (ops.renameLock ?? fs.renameSync)(lock, moved);
    } catch (e) {
      // Gone already (released or recovered by another process): try the lock again.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return `the stale pause lock could not be moved aside (${errText(e)})`;
    }
    if (sameLock(observeFlag(moved), held)) {
      try {
        fs.unlinkSync(moved);
        return undefined;
      } catch (e) {
        return `the stale pause lock was moved aside but could not be removed (${errText(e)})`;
      }
    }
    // Not the lock judged stale: a live holder's. Put it back without replacing a lock taken meanwhile.
    try {
      fs.linkSync(moved, lock);
    } catch (e) {
      return `a live pause lock was moved aside and could not be put back (${errText(e)}); it is kept as ${path.basename(moved)}`;
    }
    try {
      (ops.unlinkLock ?? fs.unlinkSync)(moved);
    } catch (e) {
      // The restored lock stays in place; a moved file left behind is not a finished recovery.
      return `the live pause lock was put back but its moved-aside name could not be removed (${errText(e)}); it is kept as ${path.basename(moved)}`;
    }
    return undefined;
  } catch {
    // Nothing more is removed; the caller finds the lock busy.
    return undefined;
  } finally {
    try {
      fs.unlinkSync(recover);
    } catch {
      // Only this recoverer removes it; a failure here keeps later recoveries paused, never unsafe.
    }
  }
}

/** Test seams for writing a high reading: a hook before the new flag is put in place, and its rename (plus `LockOps`). */
export interface PublishOps extends LockOps {
  beforePublish?: () => void;
  renameSync?: typeof fs.renameSync;
  randomHex?: () => string;
}

/**
 * Write the pause flag as a new file, holding the pause lock: the text goes to a unique
 * `<flag>.writing.<pid>.<random>` in the same folder, which is renamed over the flag path. When the
 * lock cannot be taken, nothing is written and any flag already there stays as it is; the caller is
 * paused either way. The temporary file is removed on any error. Returns the error, or undefined.
 */
function publishFlag(flag: string, text: string, ops: PublishOps = {}): string | undefined {
  return underFlagLock(
    flag,
    (why) => why,
    () => {
      let tmp: string | undefined;
      try {
        tmp = `${flag}.writing.${process.pid}.${(ops.randomHex ?? randomHex)()}`;
        fs.writeFileSync(tmp, text, { flag: "wx" });
        ops.beforePublish?.();
        (ops.renameSync ?? fs.renameSync)(tmp, flag);
        return undefined;
      } catch (e) {
        if (tmp) {
          try {
            fs.rmSync(tmp, { force: true });
          } catch {
            // The error below is what matters; the run stays paused either way.
          }
        }
        return errText(e);
      }
    },
    ops,
  );
}

/** Test seams for `clearPauseFlag` and `adoptLeftovers`: a hook right before the removal, and the removal (plus `LockOps`). */
export interface ClearOps extends LockOps {
  beforeUnlink?: () => void;
  unlinkSync?: typeof fs.unlinkSync;
}

function randomHex(): string {
  return randomBytes(6).toString("hex");
}

/**
 * Remove the pause flag only if it is still the one `seen` describes, holding the pause lock so no
 * high reading is written between the comparison and the removal. Under the lock the flag is read
 * again and compared (content, mtime, inode) with `seen`: the same flag is unlinked ("cleared"); a
 * different one was written or renewed by another process and stays ("changed"); a missing one was
 * cleared by another process ("cleared"). A lock that cannot be taken, a flag that cannot be read, a
 * failing hook or a failed unlink leave the flag in place and return the error, so the run stays
 * paused. Nothing is renamed, so no `.clearing.*` file is ever made, and nothing throws.
 */
export function clearPauseFlag(flag: string, seen: FlagSeen, ops: ClearOps = {}): "cleared" | "changed" | { error: string } {
  return underFlagLock<"cleared" | "changed" | { error: string }>(
    flag,
    (why) => ({ error: why }),
    () => {
      const now = observeFlag(flag);
      if (now === undefined) return "cleared";
      if ("error" in now) return { error: `the pause flag could not be read (${now.error})` };
      if (now.content !== seen.content || now.mtimeMs !== seen.mtimeMs || now.ino !== seen.ino) return "changed";
      try {
        ops.beforeUnlink?.();
        (ops.unlinkSync ?? fs.unlinkSync)(flag);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return "cleared";
        return { error: errText(e) };
      }
      return "cleared";
    },
    ops,
  );
}

const CLEARING = ".clearing.";

/**
 * Adopt `<flag>.clearing.*` files left by a clear of an older version, which renamed the flag
 * away to compare it and could leave one behind. Each is the record of a pause, so, holding the pause
 * lock, the newest is renamed to the flag path when no flag is live and the rest are removed.
 * Returns undefined when nothing is left over, otherwise why: the run then counts as paused and the
 * pause is not cleared this time. Never throws.
 */
function adoptLeftovers(flag: string, ops: ClearOps): string | undefined {
  const dir = path.dirname(flag);
  const prefix = `${path.basename(flag)}${CLEARING}`;
  let left: string[];
  try {
    left = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).map((f) => path.join(dir, f));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return `the pause folder could not be read (${errText(e)})`;
  }
  if (!left.length) return undefined;
  return underFlagLock(
    flag,
    (why) => `a leftover ${CLEARING}* file was not adopted: ${why}`,
    () => {
      try {
        const mtime = (f: string) => fs.lstatSync(f, { throwIfNoEntry: false })?.mtimeMs ?? -1;
        for (const f of left.sort((a, b) => mtime(b) - mtime(a))) {
          try {
            if (fs.lstatSync(flag, { throwIfNoEntry: false }) === undefined) fs.renameSync(f, flag);
            else (ops.unlinkSync ?? fs.unlinkSync)(f);
          } catch (e) {
            // Adopted by another process already.
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
        }
        return undefined;
      } catch (e) {
        return `a leftover ${CLEARING}* file could not be adopted (${errText(e)})`;
      }
    },
    ops,
  );
}

function errText(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  return err.code ?? err.message ?? String(e);
}

/** Harnesses that spend no paid usage window. Every other one does: claude, codex, and any a package provides. */
export const FREE_HARNESSES: readonly string[] = ["local", "mock", "shell"];

export function paidHarness(runs: string): boolean {
  return !FREE_HARNESSES.includes(runs);
}

/**
 * REQ-usage-004: the one usage check before agent work starts. `harnesses` are the harnesses that may
 * run (a role, a delegation, or for a pass of `mw work` every role the project has): when none is paid
 * nothing is checked.
 */
export async function usageGuard(integrations: { usageOk(): Promise<{ ok: boolean; detail: string }> }, harnesses: readonly string[]): Promise<{ ok: boolean; detail: string }> {
  if (!harnesses.some(paidHarness)) return { ok: true, detail: `no paid harness (${harnesses.join(", ")})` };
  return integrations.usageOk();
}
