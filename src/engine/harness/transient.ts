// Which harness failures are transient (REQ-harness-001): the provider is at capacity,
// rate-limits, answers with a server error, times out a request or drops the connection. The one table
// of patterns serves every harness (codex, claude, local, and a package's through host.agent); none keeps a copy of its own.
// A quota or session limit is checked first and is never transient: it pauses the run for usage
// (REQ-usage-003) until the reset time its message states.
import type { HarnessResult } from "../types.ts";

/** A quota or session limit: the account is out of usage until a stated time (never retried). */
export const QUOTA_PATTERNS: readonly RegExp[] = [
  /\bhit your (?:session|usage|weekly|daily|monthly) limit\b/i,
  /\b(?:session|usage|weekly) limit (?:reached|exceeded)\b/i,
  /\bClaude AI usage limit reached\b/i,
  /\binsufficient_quota\b/i,
  /\bquota (?:exceeded|exhausted)\b/i,
];

const HTTP_429 = /(?:\bHTTP\s*|\bstatus(?: code)?:?\s*|\bAPI Error:?\s*|\berror code:?\s*)429\b|\b429 Too Many Requests\b/i;

/**
 * Failures that are the account's or the request's and would fail the same way again: checked
 * before the transient table so that, say, "401 ... overloaded" is never retried.
 */
export const NEVER_TRANSIENT: readonly RegExp[] = [
  /\b(?:HTTP\s*|status(?: code)?:?\s*|API Error:?\s*)40[13]\b/i,
  /\bunauthori[sz]ed\b/i,
  /\b(?:invalid|incorrect|missing) (?:api[ _-]?key|x-api-key|token|credentials)\b/i,
  /\bauthentication(?:_error| failed| required)\b/i,
  /\bnot logged in\b|\bplease (?:log|sign) ?in\b|\/login\b/i,
  /\bis not installed or not on PATH\b/i,
];

/** The transient table: capacity and overload, 429, 5xx, a provider request timeout, a reset connection. */
export const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\bmodel is at capacity\b/i,
  /\bat capacity\b/i,
  /\boverloaded(?:_error)?\b/i,
  HTTP_429,
  /\btoo many requests\b/i,
  /\brate[ _-]?limit(?:ed|_error)?\b/i,
  /(?:\bHTTP\s*|\bstatus(?: code)?:?\s*|\bAPI Error:?\s*|\berror code:?\s*|\banswered HTTP\s*|\blast status:?\s*)5\d\d\b/i,
  /\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
  /\b(?:internal server error|bad gateway|service unavailable|gateway timeout|server_error|api_error)\b/i,
  /\brequest (?:timed out|timeout)\b/i,
  /\b(?:upstream|gateway|provider) timed? ?out\b/i,
  /\bETIMEDOUT\b|\bdeadline exceeded\b/i,
  /\bECONNRESET\b|\bconnection reset\b|\bsocket hang up\b/i,
  /\bconnection (?:was )?(?:closed|terminated|reset) (?:by (?:the )?peer|unexpectedly)\b/i,
  /\bstream disconnected before completion\b/i,
];

export type FailureKind = "quota" | "transient";

/** How a failure's text classifies: `quota` (checked first), `transient`, or undefined. */
export function classifyFailure(text: string | undefined): FailureKind | undefined {
  if (!text) return undefined;
  if (QUOTA_PATTERNS.some((p) => p.test(text))) return "quota";
  // A 429 is a quota only when it states a real reset time; "try again later" stays transient.
  if (HTTP_429.test(text) && quotaResetAt(text) !== undefined) return "quota";
  if (NEVER_TRANSIENT.some((p) => p.test(text))) return undefined;
  return TRANSIENT_PATTERNS.some((p) => p.test(text)) ? "transient" : undefined;
}

/** True when the failure text is transient (and not a quota or session limit). */
export function isTransient(text: string | undefined): boolean {
  return classifyFailure(text) === "transient";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The IANA zone name if `zone` is one this runtime knows, else undefined. */
function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The wall-clock fields of the instant `ms` in `zone` (month 0-based). */
function zoneParts(zone: string, ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get("year"), mo: get("month") - 1, d: get("day"), h: get("hour") % 24, mi: get("minute"), s: get("second") };
}

/** How far `zone` is ahead of UTC at the instant `ms`, in milliseconds. */
function zoneOffset(zone: string, ms: number): number {
  const p = zoneParts(zone, ms);
  return Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `zone` reads the given date and time: the fields taken as
 * UTC, less the zone's offset there, with the offset applied once more to settle a DST boundary.
 */
function zoneInstant(zone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo, d, h, mi, 0, 0);
  const first = wall - zoneOffset(zone, wall);
  return wall - zoneOffset(zone, first);
}

/**
 * The reset time a quota message states, or undefined: an epoch after `|` (Claude's older "usage
 * limit reached|<seconds>"), a duration ("try again in 2 hours 5 minutes"), or a clock time with an
 * optional date ("resets 3pm", "resets 15:30", "try again at Oct 10th, 2026 3:05 PM"). A clock time is
 * taken as its next occurrence after `now`. A zone the provider states after it, in parentheses
 * ("resets 3pm (Europe/Berlin)") or as a bare `UTC` or `GMT`, is honoured: the time and date are read
 * on that zone's wall clock and "the next day" is the next date there. With no zone, or a name this
 * runtime does not know, the clock time is read in this machine's time zone.
 */
export function quotaResetAt(text: string, now: Date = new Date()): Date | undefined {
  const epoch = /\|\s*(\d{10})\b/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const span = /\b(?:resets?|try again)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (span) {
    let ms = 0;
    for (const m of span[1]!.matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const n = Number(m[1]);
      const u = m[2]!.toLowerCase();
      ms += n * (u.startsWith("d") ? 86_400_000 : u.startsWith("h") ? 3_600_000 : u.startsWith("m") ? 60_000 : 1000);
    }
    return ms > 0 ? new Date(now.getTime() + ms) : undefined;
  }
  const clock = /\b(?:resets?|try again)\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?(?![\d:])(?:\s*\(([A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*)\)|\s*\b(UTC|GMT)\b)?/i.exec(text);
  if (!clock) return undefined;
  let hour = Number(clock[4]);
  const minute = clock[5] ? Number(clock[5]) : 0;
  const ampm = clock[6]?.toLowerCase().replace(/[^ap]/g, "");
  if (!clock[5] && !ampm) return undefined; // a bare number is not a clock time
  if (ampm === "p" && hour < 12) hour += 12;
  if (ampm === "a" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const month = clock[1] ? MONTHS.indexOf(clock[1].slice(0, 3).toLowerCase()) : -1;
  const zone = validZone(clock[7] ?? clock[8]?.toUpperCase());
  if (zone) {
    const today = zoneParts(zone, now.getTime());
    if (clock[1] && month >= 0) {
      const year = clock[3] ? Number(clock[3]) : today.y;
      let at = zoneInstant(zone, year, month, Number(clock[2]), hour, minute);
      if (!clock[3] && at < now.getTime() - 86_400_000) at = zoneInstant(zone, year + 1, month, Number(clock[2]), hour, minute);
      return new Date(at);
    }
    let at = zoneInstant(zone, today.y, today.mo, today.d, hour, minute);
    if (at <= now.getTime()) {
      // The next date on that zone's calendar, not 24 hours later (a DST change lies between).
      const next = new Date(Date.UTC(today.y, today.mo, today.d + 1));
      at = zoneInstant(zone, next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), hour, minute);
    }
    return new Date(at);
  }
  if (clock[1] && month >= 0) {
    const d = new Date(clock[3] ? Number(clock[3]) : now.getFullYear(), month, Number(clock[2]), hour, minute, 0, 0);
    if (!clock[3] && d.getTime() < now.getTime() - 86_400_000) d.setFullYear(d.getFullYear() + 1);
    return d;
  }
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Mark a failed harness result through the shared table: `transient`, or `quota` with the reset time
 * its message states. `evidence` is the text to classify (the provider's message), default the result's
 * error. A success, a run the runtime timed out (`limits.minutes`) and an empty evidence are left as they are.
 */
export function classified(res: HarnessResult, ...evidence: (string | undefined)[]): HarnessResult {
  if (res.ok || res.timedOut) return res;
  const text = [res.error, ...evidence].filter((x): x is string => !!x).join("\n");
  const kind = classifyFailure(text);
  if (kind === "transient") return { ...res, transient: true };
  if (kind === "quota") {
    const at = quotaResetAt(text);
    return { ...res, quota: at ? { resetAt: at.toISOString() } : {} };
  }
  return res;
}
