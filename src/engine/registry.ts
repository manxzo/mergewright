// This machine's registry of active runs: the run locks in `.mergewright/local/locks/` (one file per
// card, naming a live process), and the short-lived guard that serialises everything that reads or
// changes that registry together with the lease: taking a card lock,
// reclaiming a dead process's lock, and releasing the lease automatically.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { localDir } from "../project.ts";
import { MwError, readJson } from "../util.ts";
import { isAlive, processIdentity, type ProcessIdentity } from "./procid.ts";

/** The folder holding this machine's run locks. */
export function locksDir(project: { readonly root: string }): string {
  return path.join(localDir(project), "locks");
}

/**
 * A guard whose mtime is older than this may be removed even while its owner process is alive (it
 * stopped making progress). A holder refreshes the mtime every `refreshMs`.
 * Mutable for tests only.
 */
export const guardTiming = { staleMs: 30_000, refreshMs: 10_000 };
/** How long a process waits for the guard before giving up: long enough for a stale guard to expire. */
const guardWaitMs = () => guardTiming.staleMs + 5_000;
const GUARD_POLL_MS = 20;

/** Test-only seams. Nothing in the runtime sets them. */
export const registryTestHooks: {
  /** Called while the guard is held, with what it is held for ("lock" or "release"). */
  whileGuarded?: (what: string) => void;
} = {};

function guardPath(dir: string): string {
  return path.join(dir, ".guard");
}

/** Who holds a guard: the process instance and a nonce naming this one holding. */
interface GuardOwner extends ProcessIdentity {
  nonce: string;
}

function readOwner(guard: string): GuardOwner | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(guard, "owner"), "utf8")) as GuardOwner;
    return typeof o?.pid === "number" && typeof o.nonce === "string" ? o : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove a guard judged stale, but only the one judged: it is first renamed aside, and put back when
 * what was renamed turns out to be a newer guard (another process reclaimed and re-took it meanwhile).
 */
function reclaim(dir: string, judged: string | undefined): void {
  const guard = guardPath(dir);
  const aside = path.join(dir, `.guard.stale.${process.pid}.${randomUUID()}`);
  try {
    fs.renameSync(guard, aside);
  } catch {
    return; // released or reclaimed meanwhile
  }
  if (readOwner(aside)?.nonce !== judged) {
    try {
      fs.renameSync(aside, guard);
      return;
    } catch {
      // a newer guard exists now; the one renamed aside is removed below
    }
  }
  fs.rmSync(aside, { recursive: true, force: true });
}

/**
 * One attempt at the guard: `mkdir` is atomic and fails when the directory exists. The holder's
 * identity goes into the guard (`owner`). An existing guard is reclaimed (and the attempt fails, so
 * the caller tries again) when its owner process is gone, or when its mtime is older than
 * `guardTiming.staleMs` (a live holder refreshes it; one that does not has stopped making progress).
 * A guard without an owner record (being created, or made by an older runtime) is judged by mtime only.
 * Returns the nonce of this holding when taken.
 */
function tryGuard(dir: string): string | undefined {
  const guard = guardPath(dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(guard);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    try {
      const owner = readOwner(guard);
      const st = fs.statSync(guard);
      const old = Date.now() - st.mtimeMs > guardTiming.staleMs;
      if (old || (owner && owner.pid !== process.pid && !isAlive(owner))) reclaim(dir, owner?.nonce);
    } catch {
      // released meanwhile
    }
    return undefined;
  }
  const nonce = randomUUID();
  const owner: GuardOwner = { ...processIdentity(process.pid), nonce };
  fs.writeFileSync(path.join(guard, "owner"), JSON.stringify(owner) + "\n");
  return nonce;
}

/** Remove the guard, but only the one this process holds (a stale one may have been replaced). */
function dropGuard(dir: string, nonce: string): void {
  const guard = guardPath(dir);
  if (readOwner(guard)?.nonce !== nonce) return;
  fs.rmSync(guard, { recursive: true, force: true });
}

/** Keep the guard's mtime fresh while an asynchronous holder waits (on the network, say). */
function refresher(dir: string, nonce: string): NodeJS.Timeout {
  const t = setInterval(() => {
    const guard = guardPath(dir);
    if (readOwner(guard)?.nonce !== nonce) return;
    const now = new Date();
    try { fs.utimesSync(guard, now, now); } catch { /* gone */ }
  }, guardTiming.refreshMs);
  t.unref();
  return t;
}

const busy = (dir: string) =>
  new MwError("run/registry-busy", `another 'mw' process on this machine kept the run registry (${guardPath(dir)}) busy for ${guardWaitMs() / 1000} s; try again, and if this repeats remove that folder once no 'mw' process is running`);

/** Hold the guard of `dir` while `f` runs (synchronously; waits for another holder). */
export function withGuardSync<T>(dir: string, what: string, f: () => T): T {
  const deadline = Date.now() + guardWaitMs();
  const nap = new Int32Array(new SharedArrayBuffer(4));
  let nonce: string | undefined;
  while ((nonce = tryGuard(dir)) === undefined) {
    if (Date.now() > deadline) throw busy(dir);
    Atomics.wait(nap, 0, 0, GUARD_POLL_MS);
  }
  try {
    registryTestHooks.whileGuarded?.(what);
    return f();
  } finally {
    dropGuard(dir, nonce);
  }
}

/**
 * Hold the guard of `dir` while `f` runs (asynchronously; waits for another holder). The guard's mtime
 * is refreshed every `guardTiming.refreshMs` until `f` has finished, so a holder waiting on the network
 * is never judged stale by another process.
 */
export async function withGuard<T>(dir: string, what: string, f: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + guardWaitMs();
  let nonce: string | undefined;
  while ((nonce = tryGuard(dir)) === undefined) {
    if (Date.now() > deadline) throw busy(dir);
    await new Promise((r) => setTimeout(r, GUARD_POLL_MS));
  }
  const timer = refresher(dir, nonce);
  try {
    registryTestHooks.whileGuarded?.(what);
    return await f();
  } finally {
    clearInterval(timer);
    dropGuard(dir, nonce);
  }
}

export interface LockInfo {
  pid: number;
  host: string;
  /** When the run took the lock (wall clock, ISO), for messages. */
  started: string;
  /** The holder's process start time from /proc; absent without /proc. */
  procStart?: string;
}

/** True while the process instance a lock (or other record) names is running. */
export function lockAlive(info: LockInfo): boolean {
  return isAlive({ pid: info.pid, started: info.procStart });
}

/** True while some process has pid `pid` (no identity check; prefer `isAlive`). */
export function alive(pid: number): boolean {
  return isAlive({ pid });
}

/** The lock's holder when another live process holds it (the lock file is this machine's own). */
export function lockHolder(file: string): LockInfo | undefined {
  let info: LockInfo | undefined;
  try {
    info = readJson<LockInfo>(file);
  } catch {
    return undefined; // a torn lock file is treated as stale
  }
  if (!info || typeof info.pid !== "number" || info.pid === process.pid) return undefined;
  return lockAlive(info) ? info : undefined;
}

/**
 * The cross-process repository lock of the MCP tools that commit. It lives in
 * the locks folder and has a run lock's format and stale rules, but it registers no run: it never keeps
 * the lease for anyone.
 */
export const REPO_LOCK = "repo.lock";

/** True when another live process on this machine has a card's run registered (holds its lock). */
export function otherRunsHere(project: { readonly root: string }): boolean {
  const dir = locksDir(project);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((name) => name.endsWith(".lock") && name !== REPO_LOCK && lockHolder(path.join(dir, name)) !== undefined);
}

/**
 * Release the lease automatically (`mw retry`, a push by a process that took the lease
 * only for that push, `mw work` running out of work) only while no other run of this machine is
 * registered, checked and released under the registry's guard, so a run that registers meanwhile
 * keeps the lease it relies on. Returns false when the lease was kept for such a run. `release`
 * throws when the release failed. (An explicit `mw lease release` by the owner does not come here.)
 */
export async function releaseUnlessBusy(project: { readonly root: string }, release: () => Promise<void>): Promise<boolean> {
  return withGuard(locksDir(project), "release", async () => {
    if (otherRunsHere(project)) return false;
    await release();
    return true;
  });
}
