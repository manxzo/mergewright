// Which process instance a pid names. A pid alone is not enough: the
// operating system reuses pids, so a lock, the registry guard and an orphans record carry the process
// start time next to the pid, and a pid whose start time differs is a different process: the one
// recorded is dead. On Linux the facts come from `/proc/<pid>/stat` (field 22, clock ticks after boot);
// on macOS, which has no `/proc`, from `ps` (the start time to the second). Where neither is
// available only the pid is compared.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** A process instance: its pid and, where known, its start time (Linux: clock ticks after boot; macOS: seconds since the epoch). */
export interface ProcessIdentity {
  pid: number;
  started?: string;
}

export interface ProcStat {
  pid: number;
  /** One letter: R, S, D, Z (zombie), X (dead), T, ... */
  state: string;
  pgrp: number;
  /** The start time: field 22 of `/proc/<pid>/stat` (clock ticks after boot), or from `ps` seconds since the epoch. */
  started: string;
}

/**
 * Parse the text of `/proc/<pid>/stat`. The command name (field 2) is in parentheses and may contain
 * spaces and parentheses itself, so the fields are counted from the last `)`.
 */
export function parseStat(text: string): ProcStat | undefined {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const pid = Number(text.slice(0, open).trim());
  const rest = text.slice(close + 1).trim().split(/\s+/);
  // rest[0] is field 3 (state), rest[2] field 5 (pgrp), rest[19] field 22 (starttime).
  const state = rest[0];
  const pgrp = Number(rest[2]);
  const started = rest[19];
  if (!Number.isInteger(pid) || !state || !Number.isInteger(pgrp) || !started || !/^\d+$/.test(started)) return undefined;
  return { pid, state, pgrp, started };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Parse one line of macOS `ps -o pid=,pgid=,stat=,lstart=` run with LC_ALL=C and TZ=UTC0, for example
 * `  412   412 Ss   Mon Nov 24 09:05:07 2026`. The start time becomes seconds since the epoch: it is
 * fixed for the life of a process, and a pid reused in a later second gets a different one.
 */
export function parsePsLine(line: string): ProcStat | undefined {
  const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(line);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[4]!);
  if (month < 0) return undefined;
  const started = Date.UTC(Number(m[9]), month, Number(m[5]), Number(m[6]), Number(m[7]), Number(m[8])) / 1000;
  return { pid: Number(m[1]), pgrp: Number(m[2]), state: m[3]![0]!, started: String(started) };
}

/** Test-only seams. Nothing in the runtime sets them. */
export const procTestHooks: {
  /** Replaces the check for a usable `/proc` (false: behave as on a system without it). */
  procfs?: () => boolean;
} = {};

const darwin = process.platform === "darwin";

/** `ps` lines for the given arguments; an empty list when there is no such process or no `ps`. */
function ps(args: string[]): string[] {
  try {
    const out = execFileSync("/bin/ps", ["-o", "pid=,pgid=,stat=,lstart=", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC0" } });
    return out.split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

let procfsCache: boolean | undefined;
/** True where the process facts can be read: `/proc` on Linux, `ps` on macOS. */
function procfs(): boolean {
  if (procTestHooks.procfs) return procTestHooks.procfs();
  procfsCache ??= (() => {
    if (darwin) return ps(["-p", String(process.pid)]).some((l) => parsePsLine(l) !== undefined);
    try {
      return parseStat(fs.readFileSync("/proc/self/stat", "utf8")) !== undefined;
    } catch {
      return false;
    }
  })();
  return procfsCache;
}

/** The facts of process `pid`, or undefined when there is no such process (or no way to read them). */
export function readStat(pid: number): ProcStat | undefined {
  if (!procfs()) return undefined;
  if (darwin) return ps(["-p", String(pid)]).map(parsePsLine).find((st) => st?.pid === pid);
  try {
    return parseStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

/** A zombie (exited, not yet reaped by its parent) or a dead entry runs nothing and cannot be killed. */
const gone = (state: string) => state === "Z" || state === "X" || state === "x";

/** The identity of process `pid` as it is now: with its start time where it can be read. */
export function processIdentity(pid: number): ProcessIdentity {
  const st = readStat(pid);
  return st ? { pid, started: st.started } : { pid };
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True while the process instance `id` is running: a process with that pid exists, is not a zombie,
 * and (when both are known) started at the recorded time. Without the process facts, or for a record without a
 * start time (written by an older runtime), the pid alone decides.
 */
export function isAlive(id: ProcessIdentity): boolean {
  if (!Number.isInteger(id.pid) || id.pid <= 0) return false;
  if (!procfs()) return pidExists(id.pid);
  const st = readStat(id.pid);
  if (!st) return false;
  if (gone(st.state)) return false;
  return id.started === undefined || id.started === st.started;
}

/**
 * The live (not zombie) processes of process group `pgid`, with their identities; undefined where
 * the process facts are unavailable (the caller then falls back to `kill(-pgid, 0)`).
 */
export function groupMembers(pgid: number): ProcessIdentity[] | undefined {
  if (!procfs()) return undefined;
  if (darwin) {
    const all = ps(["-ax"]).map(parsePsLine);
    // `ps` always lists itself, so an empty answer means it failed: fall back as without the facts.
    if (all.length === 0) return undefined;
    return all.filter((st) => st && st.pgrp === pgid && !gone(st.state)).map((st) => ({ pid: st!.pid, started: st!.started }));
  }
  let names: string[];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return undefined;
  }
  const out: ProcessIdentity[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const st = readStat(Number(name));
    if (st && st.pgrp === pgid && !gone(st.state)) out.push({ pid: st.pid, started: st.started });
  }
  return out;
}

/** True while any process of group `pgid` exists that is not a zombie. */
export function groupAlive(pgid: number): boolean {
  const members = groupMembers(pgid);
  if (members) return members.length > 0;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
