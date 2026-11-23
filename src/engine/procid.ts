// Which process instance a pid names. A pid alone is not enough: the
// operating system reuses pids, so a lock, the registry guard and an orphans record carry the process
// start time from `/proc/<pid>/stat` (field 22) next to the pid, and a pid whose start time differs is
// a different process: the one recorded is dead. Where `/proc` is unavailable only the pid is compared.
import fs from "node:fs";

/** A process instance: its pid and, where `/proc` exists, its start time (clock ticks after boot). */
export interface ProcessIdentity {
  pid: number;
  started?: string;
}

export interface ProcStat {
  pid: number;
  /** One letter: R, S, D, Z (zombie), X (dead), T, ... */
  state: string;
  pgrp: number;
  /** Field 22, the start time in clock ticks after boot. */
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

/** Test-only seams. Nothing in the runtime sets them. */
export const procTestHooks: {
  /** Replaces the check for a usable `/proc` (false: behave as on a system without it). */
  procfs?: () => boolean;
} = {};

let procfsCache: boolean | undefined;
function procfs(): boolean {
  if (procTestHooks.procfs) return procTestHooks.procfs();
  procfsCache ??= (() => {
    try {
      return parseStat(fs.readFileSync("/proc/self/stat", "utf8")) !== undefined;
    } catch {
      return false;
    }
  })();
  return procfsCache;
}

/** `/proc/<pid>/stat` parsed, or undefined when there is no such process (or no `/proc`). */
export function readStat(pid: number): ProcStat | undefined {
  if (!procfs()) return undefined;
  try {
    return parseStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

/** A zombie (exited, not yet reaped by its parent) or a dead entry runs nothing and cannot be killed. */
const gone = (state: string) => state === "Z" || state === "X" || state === "x";

/** The identity of process `pid` as it is now: with its start time where `/proc` is available. */
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
 * and (when both are known) started at the recorded time. Without `/proc`, or for a record without a
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
 * `/proc` is unavailable (the caller then falls back to `kill(-pgid, 0)`).
 */
export function groupMembers(pgid: number): ProcessIdentity[] | undefined {
  if (!procfs()) return undefined;
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
