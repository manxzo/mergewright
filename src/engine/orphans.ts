// Process groups that outlived the run that started them. When an agent's or a
// gate's process group is still alive after SIGTERM and SIGKILL, the runtime keeps trying to kill it
// for up to two minutes; if it still exists then, the command exits with an error naming it, and the
// group is recorded in `.mergewright/local/locks/<CARD>.orphans`. A later run of that card refuses to
// start while any process of that group is alive.
import fs from "node:fs";
import path from "node:path";
import { hostName } from "../hub.ts";
import { MwError, readIfExists, writeJson } from "../util.ts";
import { reapGroup } from "./harness/proc.ts";
import { groupAlive, groupMembers, isAlive, type ProcessIdentity } from "./procid.ts";
import { locksDir } from "./registry.ts";

/** A card's run left processes behind that could not be stopped. */
export class Orphaned extends MwError {
  constructor(message: string) {
    super("run/orphans", message);
  }
}

export interface OrphanGroup {
  pgid: number;
  /** The processes of the group when it was recorded (pid and start time). */
  members: ProcessIdentity[];
}

export interface OrphansRecord {
  card: string;
  host: string;
  written: string;
  groups: OrphanGroup[];
}

/** How long the runtime keeps trying to kill a surviving group: two minutes, or `MW_REAP_MS` (tests). */
export function reapBudgetMs(): number {
  const env = Number(process.env.MW_REAP_MS);
  return env > 0 ? env : 120_000;
}

export function orphansFile(project: { readonly root: string }, cardId: string): string {
  return path.join(locksDir(project), `${cardId}.orphans`);
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

function describe(groups: OrphanGroup[]): string {
  return groups.map((g) => `process group ${g.pgid}${g.members.length ? ` (pids ${g.members.map((m) => m.pid).join(", ")})` : ""}`).join(" and ");
}

/**
 * Keep killing the surviving groups `pgids` (SIGTERM, then SIGKILL, again and again) for up to
 * `reapBudgetMs()`. Returns when all are gone. Otherwise records them in the card's orphans file and
 * throws `Orphaned` naming them: the command must not claim a clean stop or go on to other work.
 */
export async function settleSurvivors(project: { readonly root: string }, cardId: string, pgids: number[], say?: (line: string) => void): Promise<void> {
  if (!pgids.length) return;
  const budget = reapBudgetMs();
  const deadline = Date.now() + budget;
  say?.(`process group ${pgids.join(", ")} is still running after SIGTERM and SIGKILL; trying to kill it for up to ${seconds(budget)}`);
  let left = [...new Set(pgids)];
  for (;;) {
    const next: number[] = [];
    for (const g of left) {
      const grace = Math.max(50, Math.min(1000, deadline - Date.now()));
      if (!(await reapGroup(g, grace))) next.push(g);
    }
    left = next;
    if (!left.length) return;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
  const groups: OrphanGroup[] = left.map((pgid) => ({ pgid, members: groupMembers(pgid) ?? [] }));
  const file = orphansFile(project, cardId);
  const record: OrphansRecord = { card: cardId, host: hostName(), written: new Date().toISOString(), groups };
  let wrote = true;
  try {
    writeJson(file, record);
  } catch {
    wrote = false;
  }
  const first = left[0]!;
  throw new Orphaned(`${cardId}: ${describe(groups)} started by this run is still running after SIGTERM, SIGKILL and ${seconds(budget)} of further attempts, so 'mw' stops here and leaves it running. Stop it yourself (for example 'kill -KILL -- -${first}'; a process that survives that is usually stuck on a hung disk or network mount). ${wrote ? `It is recorded in ${file}, and ${cardId} will not run again on this machine while any process of it is alive.` : `It could not be recorded in ${file}, so make sure it is gone before running ${cardId} again.`}`);
}

/** True while a recorded group still has a live process (by identity; by group id where none was recorded). */
function groupStillAlive(g: OrphanGroup): boolean {
  if (g.members.length) return g.members.some((m) => isAlive(m));
  return groupAlive(g.pgid);
}

/** The processes of a card's orphans record that are still alive, as `mw run` and `mw abort` see them. */
export interface LiveOrphans {
  file: string;
  /** When the record was written. */
  written: string;
  groups: OrphanGroup[];
  /** "process group 123 (pids 123, 124)" and so on. */
  described: string;
}

/**
 * The live part of a card's orphans record, or undefined when there is none. A record whose groups are
 * all gone is removed.
 */
export function liveOrphans(project: { readonly root: string }, cardId: string): LiveOrphans | undefined {
  const file = orphansFile(project, cardId);
  const text = readIfExists(file);
  if (text === undefined) return undefined;
  let record: OrphansRecord | undefined;
  try {
    record = JSON.parse(text) as OrphansRecord;
  } catch {
    record = undefined;
  }
  const groups = Array.isArray(record?.groups) ? record.groups.filter((g) => typeof g?.pgid === "number") : [];
  const alive = groups.map((g) => ({ pgid: g.pgid, members: (Array.isArray(g.members) ? g.members : []).filter((m) => isAlive(m)) })).filter((g, i) => groupStillAlive(groups[i]!));
  if (!alive.length) {
    fs.rmSync(file, { force: true });
    return undefined;
  }
  return { file, written: record?.written ?? "earlier", groups: alive, described: describe(alive) };
}

/**
 * Refuse to run a card while a process group an earlier run of it left behind is alive. A record
 * whose groups are all gone is removed.
 */
export function assertNoOrphans(project: { readonly root: string }, cardId: string): void {
  const live = liveOrphans(project, cardId);
  if (!live) return;
  // Not `Orphaned`: this run started nothing, so 'mw work' reports it and goes on with other cards.
  throw new MwError("run/orphans-alive", `${cardId} was not started: ${live.described}, left running by an earlier run of this card (recorded ${live.written} in ${live.file}), is still alive and may still change its worktree. Stop it (for example 'kill -KILL -- -${live.groups[0]!.pgid}'), then run the card again.`);
}
