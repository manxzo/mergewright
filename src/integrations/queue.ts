// Undelivered integration items: one JSON file each under .mergewright/local/queue/, retried by
// `mw queue flush`. The queue is this machine's own (never file-synced), so no item is ever seen by
// both machines and delivered twice.
import fs from "node:fs";
import path from "node:path";
import { readStat } from "../engine/procid.ts";
import { listFiles, writeJson } from "../util.ts";
import { BUDGET_RAN_OUT, BudgetCut, deliveryScope, errMessage, randomTag } from "./common.ts";

export interface QueueItem {
  kind: string;
  /** ISO time the item was first queued. */
  created: string;
  /** One line for `mw queue`. Never contains secrets. */
  summary: string;
  payload: unknown;
  attempts: number;
  lastError?: string;
  /**
   * REQ-engine-008: the process that recorded the item under the repository lock (`enqueueMemory`) and
   * delivers it once it has released the lock and the lease. While that process runs (the same process:
   * `holdStart`), no other flush delivers the item, however long that takes; the holder clears the hold
   * once its transaction has released both (`Queue.unhold`), and a hold whose process ended is ignored.
   */
  holdPid?: number;
  /** ISO time the hold was set (for people reading `mw queue`; it never expires a hold). */
  holdSince?: string;
  /** The holder's start time (`/proc/<pid>/stat` field 22), so a reused pid is not taken for it; absent without `/proc`. */
  holdStart?: string;
}

export interface AddOptions {
  /** Hold the item for this process (`holdPid`, `holdSince`, `holdStart`): see QueueItem.holdPid. */
  hold?: boolean;
  /** Throw when the item could not be written (and is not on disk afterwards), instead of reporting it on stderr. */
  strict?: boolean;
}

export interface QueuedFile {
  file: string;
  item: QueueItem;
}

/** Records of one item, for deliverers that send a list of records (package memory stores) one at a time. */
export interface DeliveryCounts {
  /** Records in the item when this delivery started. */
  total: number;
  /** Sent and accepted in this delivery. */
  delivered: number;
  /** Found already in the service (a write that earlier timed out but landed); not sent again. */
  present: number;
}

export interface DeliverContext {
  /**
   * Record that part of the payload is delivered: the claimed item is rewritten at once with
   * `remaining` (and `summary`), so a delivery cut short (timeout, crash, Ctrl-C) never re-sends it.
   */
  progress(remaining: unknown, summary?: string): void;
}

/**
 * Delivers one item; throws to keep it queued. A deliverer that got part of the way throws a
 * `PartialDelivery` carrying what is left, and only that stays queued. A deliverer of
 * records returns (and its PartialDelivery carries) the counts, which `mw queue flush` reports.
 */
export type Deliver = (payload: unknown, ctx: DeliverContext) => Promise<DeliveryCounts | void>;

/** Thrown by a deliverer that delivered part of a payload: `remaining` replaces the queued payload. */
export class PartialDelivery extends Error {
  remaining: unknown;
  summary?: string;
  counts?: DeliveryCounts;
  constructor(message: string, remaining: unknown, summary?: string, counts?: DeliveryCounts) {
    super(message);
    this.remaining = remaining;
    this.summary = summary;
    this.counts = counts;
  }
}

/**
 * Thrown by a deliverer when the item must not be delivered any more (a status the card has since
 * left, a board this machine cannot reach): `flush` removes it and reports the message.
 */
export class Dropped extends Error {}

/** A claim (`<item>.json.claimed-<pid>`) older than this is released: its process died mid-delivery. */
export const CLAIM_TIMEOUT_MS = 10 * 60_000;
const CLAIMED = /^(.+\.json)\.claimed-\d+$/;
/**
 * Is `item` still held by a running process (not this flush's to deliver)? A hold lasts as long as its
 * process: the pid must exist (`kill(pid, 0)`, EPERM counts as alive) and, when the hold recorded the
 * holder's start time (`holdStart`), the pid must still have that start time; otherwise it is a reused
 * pid and the hold is ignored. A hold's age never ends it.
 */
export function isHeld(item: QueueItem): boolean {
  const pid = item.holdPid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false; // alive only when owned by another user
  }
  return item.holdStart === undefined || readStat(pid)?.started === item.holdStart;
}

/** How long one flush may deliver before the rest stays queued (REQ-engine-009). */
export const FLUSH_BUDGET_MS = 20_000;
/** Timeouts in a row after which a kind is skipped (the per-kind breaker). */
export const BREAKER_TIMEOUTS = 2;
/** How long a kind whose breaker tripped is skipped without a request. */
export const BREAKER_SKIP_MS = 10 * 60_000;
/** The breaker's state (JSON), in this machine's queue folder: a dot file without `.json`, so never taken for an item. */
const BREAKER_FILE = ".breaker";
/** Held while the breaker state is read, changed and written (`recordOutcome`); holds its owner's token. */
const BREAKER_LOCK = ".breaker.lock";
/** How often `recordOutcome` takes the lock again after finding it lost before its write. */
const BREAKER_LOCK_TRIES = 3;
/** A `.breaker.lock` older than this is left by a process that stopped, and removed. */
const BREAKER_LOCK_STALE_MS = 5_000;
/** How long `recordOutcome` waits for another holder before it gives up (and records nothing). */
const BREAKER_LOCK_WAIT_MS = 8_000;
/** Within a flush the wait ends at the flush's deadline, but an outcome may always try for this long. */
const BREAKER_LOCK_FLOOR_MS = 50;

/** One kind's breaker: timeouts in a row, and until when (ms since the epoch) the kind is skipped. */
export interface BreakerState {
  timeouts: number;
  skipUntil?: number;
}

export interface FlushOptions {
  /** Stop starting items after this many ms, and cut the one in flight (default FLUSH_BUDGET_MS; Infinity = none). */
  budgetMs?: number;
  /** Skip kinds whose breaker tripped (default true). Outcomes update the breaker either way. */
  breaker?: boolean;
  /**
   * Only these item files (as `add` returned them); default every item. Their holds are overridden: pass
   * held files only once their holder has released the repository lock and the lease (`deliverQueued`).
   */
  only?: string[];
  /** The clock, injected by tests. */
  now?: () => number;
}

/** A delivery that ran out of time (a request that timed out, or a notify command that did). */
export function isTimeout(e: unknown): boolean {
  return /\btimed out\b/i.test(errMessage(e));
}

export interface FlushResult {
  file: string;
  kind: string;
  summary: string;
  ok: boolean;
  /**
   * Not attempted in this flush (no request, the item file untouched): the budget ran out, the kind's
   * breaker is open, or a running process still holds the item (REQ-engine-008).
   */
  skipped?: "budget" | "breaker" | "held";
  /** The deliverer dropped the item (see `Dropped`): it is gone, `error` says why. */
  dropped?: boolean;
  error?: string;
  /** Per-record counts, from deliverers of records (package memory stores). */
  counts?: DeliveryCounts;
}

/** Records this result delivered (or found already present) in this flush: an item without counts counts 1 when delivered. */
export function progressOf(r: FlushResult): number {
  if (r.counts) return r.counts.delivered + r.counts.present;
  return r.ok ? 1 : 0;
}

/** A held `.breaker.lock` (`Queue.lockBreaker`). */
export interface BreakerLock {
  token: string;
  /** Is the lock file still this holder's (not removed or replaced by another process)? */
  owned(): boolean;
  /** Remove the lock if it is still this holder's; a lock another process holds now stays. */
  release(): void;
}

function readToken(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

let lastStamp = 0;

export class Queue {
  readonly dir: string;
  /** `localDir`: this machine's folder, `.mergewright/local` (see `localDir` in src/project.ts). */
  constructor(localDir: string) {
    this.dir = path.join(localDir, "queue");
  }

  /**
   * Move the items an older runtime left in `oldDir` (the shared `.mergewright/queue/`) into this
   * queue. Claimed items move too, keeping their age, so a stale claim is still released later.
   * Returns how many were moved; never throws.
   */
  adopt(oldDir: string): number {
    let names: string[];
    try {
      names = fs.readdirSync(oldDir);
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      if (name.startsWith(".") || !(name.endsWith(".json") || CLAIMED.test(name))) continue;
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const to = path.join(this.dir, name);
        if (fs.existsSync(to)) continue;
        fs.renameSync(path.join(oldDir, name), to);
        n++;
      } catch {
        // moved by another process meanwhile, or not movable: left where it is
      }
    }
    return n;
  }

  /**
   * Write an item atomically; returns the file path. Never throws (a queue that cannot be written is
   * reported on stderr), unless `opts.strict`: then a failed write, or a file not there afterwards, throws.
   */
  add(kind: string, summary: string, payload: unknown, lastError?: string, opts: AddOptions = {}): string {
    // Monotonic within a process, so names sort in the order items were added.
    const t = Math.max(Date.now(), lastStamp + 1);
    lastStamp = t;
    const stamp = new Date(t).toISOString().replace(/[-:.]/g, "").replace("T", "-");
    const safeKind = kind.replace(/[^a-z0-9-]/gi, "_");
    const file = path.join(this.dir, `${stamp}-${safeKind}-${randomTag()}.json`);
    const item: QueueItem = { kind, created: new Date().toISOString(), summary: oneLine(summary), payload, attempts: 0, lastError: lastError && oneLine(lastError) };
    if (opts.hold) {
      const started = readStat(process.pid)?.started;
      Object.assign(item, { holdPid: process.pid, holdSince: new Date().toISOString() }, started ? { holdStart: started } : {});
    }
    try {
      writeJson(file, item);
      if (opts.strict && !fs.existsSync(file)) throw new Error(`${file} is not there after the write`);
    } catch (e) {
      if (opts.strict) throw new Error(`could not queue the ${kind} item: ${errMessage(e)}`);
      process.stderr.write(`mw: could not queue ${kind} item: ${errMessage(e)}\n`);
    }
    return file;
  }

  /**
   * Clear this process's hold on `files` (atomic rewrite), once its transaction has ended: the items are
   * then plainly queued. An item gone meanwhile, or held by another process, is left as it is. Never throws.
   */
  unhold(files: string[]): void {
    for (const file of files) {
      try {
        const item = JSON.parse(fs.readFileSync(file, "utf8")) as QueueItem;
        if (item.holdPid !== process.pid) continue;
        delete item.holdPid;
        delete item.holdSince;
        delete item.holdStart;
        writeJson(file, item);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`mw: could not release the hold on ${file} (${errMessage(e)}); the next flush after this process stops delivers it\n`);
      }
    }
  }

  /**
   * Put back items whose claim is older than CLAIM_TIMEOUT_MS (the claiming process stopped).
   * Returns how many.
   */
  releaseStaleClaims(now = Date.now()): number {
    let n = 0;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const m = CLAIMED.exec(name);
      if (!m) continue;
      const claimed = path.join(this.dir, name);
      try {
        if (now - fs.statSync(claimed).mtimeMs < CLAIM_TIMEOUT_MS) continue;
        fs.renameSync(claimed, path.join(this.dir, m[1]!));
        n++;
      } catch {
        // released or delivered by someone else meanwhile
      }
    }
    return n;
  }

  /** Items oldest first. Unreadable files and claimed items are skipped. */
  list(): QueuedFile[] {
    const out: QueuedFile[] = [];
    for (const file of listFiles(this.dir, ".json")) {
      if (path.basename(file).startsWith(".")) continue;
      try {
        out.push({ file, item: JSON.parse(fs.readFileSync(file, "utf8")) as QueueItem });
      } catch {
        // half-synced or corrupt: leave it for a human, do not crash the run
      }
    }
    return out;
  }

  /** Remove queued items matching `pred` (used when a newer item supersedes an older one). */
  drop(pred: (item: QueueItem) => boolean): number {
    let n = 0;
    for (const q of this.list()) {
      if (pred(q.item)) {
        fs.rmSync(q.file, { force: true });
        n++;
      }
    }
    return n;
  }

  /** The per-kind breaker state this machine recorded (`.mergewright/local/queue/.breaker`). */
  breakers(): Record<string, BreakerState> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, BREAKER_FILE), "utf8")) as Record<string, BreakerState>;
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  /**
   * Record one delivery outcome of `kind`. Read, changed and written (atomically) under `.breaker.lock`,
   * so two flushes of this machine (two processes, or a background delivery beside `mw work`) never
   * lose each other's outcomes. The write happens only while the lock is still this call's own; a lock
   * lost meanwhile (removed as stale by another process) is taken again and the state read again.
   * `deadline` (ms since the epoch, a flush's own deadline) bounds the wait for the lock: when the lock
   * cannot be had by then (at least BREAKER_LOCK_FLOOR_MS is tried), this outcome is not recorded
   * (best effort under contention, REQ-engine-009); the item's own file was already written.
   */
  async recordOutcome(kind: string, timedOut: boolean, now: number, deadline?: number): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let lock: BreakerLock;
      try {
        lock = await this.lockBreaker(deadline);
      } catch (e) {
        process.stderr.write(`mw: could not record the queue's breaker state (${errMessage(e)})\n`);
        return;
      }
      try {
        const all = this.breakers();
        const was = all[kind];
        if (!timedOut) {
          if (!was) return;
          delete all[kind];
        } else {
          const timeouts = (was?.timeouts ?? 0) + 1;
          all[kind] = timeouts >= BREAKER_TIMEOUTS ? { timeouts, skipUntil: now + BREAKER_SKIP_MS } : { timeouts };
        }
        if (!lock.owned()) {
          if (attempt < BREAKER_LOCK_TRIES) continue;
          throw new Error(`${BREAKER_LOCK} was taken over by another process ${BREAKER_LOCK_TRIES} times`);
        }
        const file = path.join(this.dir, BREAKER_FILE);
        if (!Object.keys(all).length) fs.rmSync(file, { force: true });
        else writeJson(file, all);
        return;
      } catch (e) {
        process.stderr.write(`mw: could not record the queue's breaker state (${errMessage(e)})\n`);
        return;
      } finally {
        lock.release();
      }
    }
  }

  /**
   * Take `.breaker.lock`: created whole with this holder's token (pid and a random tag) by a hard link,
   * so one holder at a time across processes, and never seen empty. Waits for another holder. A lock
   * older than BREAKER_LOCK_STALE_MS (its holder stopped) is removed, but only when it is still the
   * same lock (token and mtime) after it is moved aside; a lock that was just replaced is put back.
   * `release` removes the lock only while it holds this token. Throws when it is still held after
   * BREAKER_LOCK_WAIT_MS, or by `until` (ms since the epoch) when that comes first, though never before
   * BREAKER_LOCK_FLOOR_MS. Public for tests.
   */
  async lockBreaker(until?: number): Promise<BreakerLock> {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, BREAKER_LOCK);
    const token = `${process.pid}-${randomTag()}`;
    const owned = () => readToken(lock) === token;
    const start = Date.now();
    const waitMs = until === undefined ? BREAKER_LOCK_WAIT_MS : Math.min(BREAKER_LOCK_WAIT_MS, Math.max(BREAKER_LOCK_FLOOR_MS, until - start));
    const deadline = start + waitMs;
    for (;;) {
      const mine = `${lock}.${token}`;
      try {
        fs.writeFileSync(mine, token);
        fs.linkSync(mine, lock);
        return { token, owned, release: () => { if (owned()) fs.rmSync(lock, { force: true }); } };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      } finally {
        fs.rmSync(mine, { force: true });
      }
      this.removeStaleLock(lock, token);
      if (Date.now() >= deadline) throw new Error(`${lock} stayed locked for ${waitMs / 1000} s`);
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 10)));
    }
  }

  /** Remove `lock` if it is stale, and only that lock: see `lockBreaker`. Never throws. */
  private removeStaleLock(lock: string, token: string): void {
    let seen: { token: string | undefined; mtimeMs: number };
    try {
      seen = { token: readToken(lock), mtimeMs: fs.statSync(lock).mtimeMs };
    } catch {
      return; // released meanwhile
    }
    if (Date.now() - seen.mtimeMs <= BREAKER_LOCK_STALE_MS) return;
    // Moved aside first (atomic), then checked: only the stale lock that was seen is removed.
    const aside = `${lock}.stale-${token}`;
    try {
      fs.renameSync(lock, aside);
    } catch {
      return; // released or removed by another contender meanwhile
    }
    try {
      if (readToken(aside) === seen.token && fs.statSync(aside).mtimeMs === seen.mtimeMs) return;
      // A live lock that replaced the stale one between the look and the move: put it back, unless a
      // new lock was created meanwhile (then its owner finds it lost before writing, see recordOutcome).
      try {
        fs.linkSync(aside, lock);
      } catch {
        // taken meanwhile
      }
    } catch {
      // unreadable: removed below like a stale one
    } finally {
      fs.rmSync(aside, { force: true });
    }
  }

  /**
   * Retry every item in order; delete those delivered. Items of an unknown kind stay. Each item is
   * claimed first by renaming it to `<name>.claimed-<pid>`, so two flushes (two processes of this
   * machine) never deliver the same item; a failed delivery renames it back, keeping only what was
   * not delivered. A deliverer of records rewrites the claimed item after each record it delivers
   * (`DeliverContext.progress`). One item failing never stops the next.
   *
   * Bounded (REQ-engine-009): no item starts once `budgetMs` has passed, and a request still in flight
   * then is cut; a blocking command (notify, or one a package runs through host.exec) is given at most what is left of the budget
   * (`commandTimeout`, at least COMMAND_FLOOR_MS). A cut counts as an attempt, not as a timeout. A kind that timed out BREAKER_TIMEOUTS
   * times in a row is skipped for BREAKER_SKIP_MS, then tried again; a success or any other error
   * resets its count. An item a running process still holds (`isHeld`, REQ-engine-008) is skipped too,
   * unless named in `only`. Skipped items are not touched: their files (and attempt counts) stay as they are.
   */
  async flush(deliverers: Record<string, Deliver>, opts: FlushOptions = {}): Promise<FlushResult[]> {
    const now = opts.now ?? Date.now;
    const budgetMs = opts.budgetMs ?? FLUSH_BUDGET_MS;
    const deadline = now() + budgetMs;
    const only = opts.only ? new Set(opts.only) : undefined;
    this.releaseStaleClaims();
    const results: FlushResult[] = [];
    // Cuts the request in flight when the budget runs out (httpJson joins it to its own timeout); a
    // blocking command, which the timer cannot interrupt, is given what is left (`commandTimeout`).
    const budget = new AbortController();
    const timer = Number.isFinite(budgetMs) ? setTimeout(() => budget.abort(new Error(BUDGET_RAN_OUT)), Math.max(0, budgetMs)) : undefined;
    const scope = { signal: budget.signal, deadline: Date.now() + budgetMs };
    // The breaker write after an item waits for its lock no longer than the budget (wall clock, like `scope`).
    const lockUntil = Number.isFinite(budgetMs) ? scope.deadline : undefined;
    try {
      for (const { file, item: listed } of this.list()) {
        if (only && !only.has(file)) continue;
        const skip = (why: "budget" | "breaker" | "held", error: string) => results.push({ file, kind: listed.kind, summary: listed.summary, ok: false, skipped: why, error });
        if (budget.signal.aborted || now() >= deadline) {
          skip("budget", "not tried: the flush's time budget ran out");
          continue;
        }
        // REQ-engine-008: an item another transaction still holds (under its lock or lease) is not ours yet.
        if (!only?.has(file) && isHeld(listed)) {
          skip("held", `not tried: process ${listed.holdPid} recorded it under the repository lock and delivers it once it has released the lock and the lease`);
          continue;
        }
        const deliver = deliverers[listed.kind];
        if (!deliver) {
          results.push({ file, kind: listed.kind, summary: listed.summary, ok: false, error: `no deliverer for kind '${listed.kind}'` });
          continue;
        }
        const until = this.breakers()[listed.kind]?.skipUntil;
        if (opts.breaker !== false && until !== undefined && now() < until) {
          skip("breaker", `not tried: ${listed.kind} timed out ${BREAKER_TIMEOUTS} times in a row; tried again after ${new Date(until).toISOString()}`);
          continue;
        }
        const r = await this.deliverOne(file, deliver, scope);
        if (!r) continue;
        results.push(r);
        // A cut by the budget says nothing about the service; every other outcome does.
        if (!r.cut) await this.recordOutcome(r.kind, !r.ok && !r.dropped && r.timedOut === true, now(), lockUntil);
        delete r.timedOut;
        delete r.cut;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    return results;
  }

  /** Claim one item and deliver it; undefined when another flush has it (or it is gone). */
  private async deliverOne(file: string, deliver: Deliver, scope: { signal: AbortSignal; deadline: number }): Promise<(FlushResult & { timedOut?: boolean; cut?: boolean }) | undefined> {
    const claimed = `${file}.claimed-${process.pid}`;
    let item: QueueItem;
    try {
      fs.renameSync(file, claimed);
      const now = new Date();
      fs.utimesSync(claimed, now, now); // the claim's age counts from now, not from when the item was queued
      // Read again: the file may have been rewritten since it was listed.
      item = JSON.parse(fs.readFileSync(claimed, "utf8")) as QueueItem;
    } catch {
      return undefined; // claimed by another flush, dropped as superseded, or unreadable after the rename
    }
    // `current` follows the claimed file: a deliverer of records rewrites it after each one.
    let current = item;
    const ctx: DeliverContext = {
      progress: (remaining, summary) => {
        current = { ...current, payload: remaining, summary: summary ? oneLine(summary) : current.summary };
        try {
          writeJson(claimed, current);
        } catch (we) {
          process.stderr.write(`mw: could not record progress of queued ${item.kind} item (${errMessage(we)})\n`);
        }
      },
    };
    try {
      const counts = (await deliveryScope.run(scope, () => deliver(item.payload, ctx))) ?? undefined;
      fs.rmSync(claimed, { force: true });
      return { file, kind: item.kind, summary: item.summary, ok: true, ...(counts ? { counts } : {}) };
    } catch (e) {
      const error = oneLine(errMessage(e));
      if (e instanceof Dropped) {
        fs.rmSync(claimed, { force: true });
        return { file, kind: item.kind, summary: item.summary, ok: false, dropped: true, error };
      }
      const partial = e instanceof PartialDelivery;
      const next: QueueItem = {
        ...current,
        payload: partial ? e.remaining : current.payload,
        summary: partial && e.summary ? oneLine(e.summary) : current.summary,
        attempts: item.attempts + 1,
        lastError: error,
      };
      try {
        writeJson(claimed, next);
        fs.renameSync(claimed, file);
      } catch (we) {
        process.stderr.write(`mw: could not put queued ${item.kind} item back (${errMessage(we)}); it stays at ${claimed}\n`);
      }
      // Cut by the budget: a request the signal stopped, or a command given only what was left of it.
      const cut = e instanceof BudgetCut || scope.signal.aborted;
      return { file, kind: item.kind, summary: next.summary, ok: false, error, timedOut: !cut && isTimeout(e), cut, ...(partial && e.counts ? { counts: e.counts } : {}) };
    }
  }
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 197)}...` : t;
}

/** "3m", "2h", "5d" since an ISO time. */
export function age(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return "?";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
