// Quota and session limits a harness reported: "You've hit your
// session limit, resets 3pm" from Claude, a Codex HTTP 429 with a reset time. Such a failure is never a
// transient to retry: the run pauses for usage (status `waiting`, reason `usage`, REQ-usage-003) and
// spends no remediation round. The reset time is kept per harness in this machine's
// `.mergewright/local/usage-limits/<harness>/`, so until then no role on that harness starts here,
// from any card or from `mw_delegate`; each one pauses (or is refused) at once instead of spending its
// rounds. One folder per harness and one record file per report: no report ever rewrites another, so
// neither a limit for another harness nor a later reset for the same one can be lost.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { localDir } from "../project.ts";
import { readJson, writeAtomic } from "../util.ts";

export interface QuotaLimit {
  /** ISO time the provider said the limit resets. */
  until: string;
  /** The provider's message, one line. */
  detail: string;
}

interface QuotaRecord extends QuotaLimit {
  file: string;
}

/** The folder holding one folder of reports per harness. */
export function quotaDir(project: { readonly root: string }): string {
  return path.join(localDir(project), "usage-limits");
}

/** The folder holding `harness`'s reports, one record file per report. */
export function quotaRecords(project: { readonly root: string }, harness: string): string {
  return path.join(quotaDir(project), harness.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/** Owner-only, like the rest of `.mergewright/local`. */
const PRIVATE = 0o600;
/** A record file: never a writer's `.<name>.tmp` file. */
const RECORD = /^[A-Za-z0-9_-]+\.json$/;

/** Every readable record of `harness`; a damaged or vanished one is skipped, it never stops a run by itself. */
function records(project: { readonly root: string }, harness: string): QuotaRecord[] {
  const dir = quotaRecords(project, harness);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => RECORD.test(f));
  } catch {
    return [];
  }
  const out: QuotaRecord[] = [];
  for (const f of names) {
    const file = path.join(dir, f);
    try {
      const q = readJson<QuotaLimit>(file);
      if (q && typeof q.until === "string" && !Number.isNaN(Date.parse(q.until))) out.push({ until: q.until, detail: String(q.detail ?? ""), file });
    } catch {
      // damaged, or removed by another report's compaction between the listing and the read
    }
  }
  return out;
}

/** The record with the latest reset time, or undefined. */
function latest(rs: QuotaRecord[]): QuotaRecord | undefined {
  let best: QuotaRecord | undefined;
  for (const r of rs) if (!best || Date.parse(r.until) > Date.parse(best.until)) best = r;
  return best;
}

/**
 * Record that `harness` is out of usage until `until`. Every report is an atomic write of its own
 * record file and readers take the latest reset across them, so there is no read,
 * compare and write to serialize and no lock to wait for, time out on or reclaim: reports made at once,
 * however slow, never let an earlier reset hide a later one. A report whose reset is not later than one
 * already recorded writes nothing.
 */
export function recordQuota(project: { readonly root: string }, harness: string, until: string, detail: string): void {
  const t = Date.parse(until);
  if (Number.isNaN(t)) return;
  const have = latest(records(project, harness));
  if (!have || Date.parse(have.until) < t) {
    const name = `${t}-${process.pid}-${randomBytes(6).toString("hex")}.json`;
    writeAtomic(path.join(quotaRecords(project, harness), name), JSON.stringify({ until, detail: detail.split(/\r?\n/)[0]!.slice(0, 300) } satisfies QuotaLimit, null, 2) + "\n", PRIVATE);
  }
  compact(project, harness);
}

/**
 * Remove the records whose reset has passed and those strictly earlier than another record read. The
 * latest record is never removed: only a strictly later record makes one removable, and a passed reset
 * no longer counts anyway.
 */
function compact(project: { readonly root: string }, harness: string): void {
  const rs = records(project, harness);
  const top = latest(rs);
  if (!top) return;
  const max = Date.parse(top.until);
  const now = Date.now();
  for (const r of rs) {
    const u = Date.parse(r.until);
    if (u > now && u >= max) continue;
    try {
      fs.unlinkSync(r.file);
    } catch {
      // already removed by another report
    }
  }
}

/** The limit `harness` is under now on this machine, or undefined (a passed reset time no longer counts). */
export function activeQuota(project: { readonly root: string }, harness: string, now: Date = new Date()): QuotaLimit | undefined {
  const q = latest(records(project, harness));
  return q && Date.parse(q.until) > now.getTime() ? { until: q.until, detail: q.detail } : undefined;
}

/** Every harness under a limit now, by harness (for a caller deciding whether to take new work). */
export function activeQuotas(project: { readonly root: string }, now: Date = new Date()): Record<string, QuotaLimit> {
  let names: string[];
  try {
    // Only `<harness>` folders: never a file such as a writer's temp file.
    names = fs
      .readdirSync(quotaDir(project), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[A-Za-z0-9_-]+$/.test(d.name))
      .map((d) => d.name);
  } catch {
    return {};
  }
  const out: Record<string, QuotaLimit> = {};
  for (const harness of names) {
    const q = activeQuota(project, harness, now);
    if (q) out[harness] = q;
  }
  return out;
}
