// Pruning raw streams (REQ-engine-007): the stdout and stderr an agent printed are kept in full in the
// run folder (`<label>.<harness>.stdout|stderr`), which is file-synced. Once a run is finished they
// are only needed for a while; `mw work` deletes old ones at the start of each pass. The run state,
// the artifacts, the saved exchanges (`phases/`) and the gate logs are never touched. Each card is
// pruned under its run lock (`.mergewright/local/locks/<CARD>.lock`), taken before its state is read,
// so a run resumed meanwhile never loses the streams it is writing; a card whose lock a live process
// holds is skipped, never waited on.
import fs from "node:fs";
import path from "node:path";
import type { Project } from "../project.ts";
import { MwError } from "../util.ts";
import { acquireLock, loadState, lockFile } from "./state.ts";
import type { RunStatus } from "./types.ts";

/** Run statuses whose streams may go: the run is over. Running, waiting and blocked runs are kept. */
const FINISHED: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "aborted"]);

/** A raw stream file of a run: directly in the run folder, ending in `.stdout` or `.stderr`. */
const RAW = /\.(stdout|stderr)$/;

export interface RawPrune {
  /** Removed files, relative to the project root. */
  removed: string[];
  /** Cards left whole because a live process holds their run lock. */
  skipped: string[];
  /** One sentence per file or run that could not be handled. */
  problems: string[];
}

/**
 * Delete the raw stdout and stderr streams older than `days` (by modification time) from the folders
 * of finished runs. A run counts as finished only by the status in its `state.json`; a run whose state
 * is missing, unreadable or has another status is left whole. The card's run lock is taken before its
 * state is read and held to the last removal, then released in a finally (straight away when the run
 * is not finished); a lock a live process holds (this one included) skips the card without waiting or
 * reading its state, and a lock left by a dead process is taken over, as `acquireLock` does for runs.
 * Never throws.
 */
export function pruneRawStreams(project: Project, days: number = project.config.trace.rawDays, now: number = Date.now()): RawPrune {
  const out: RawPrune = { removed: [], skipped: [], problems: [] };
  const root = path.join(project.workDir, "runs");
  let cards: fs.Dirent[];
  try {
    cards = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // no runs yet
  }
  const limit = now - Math.max(0, days) * 86_400_000;
  for (const c of cards) {
    if (!c.isDirectory()) continue;
    const dir = path.join(root, c.name);
    // The lock comes first, so the state is only ever read under it; for a run that is not finished
    // pruneRun returns at once and the lock is released straight away.
    let release: () => void;
    try {
      release = acquireLock(lockFile(project, c.name), c.name);
    } catch (err) {
      if (err instanceof MwError && err.code === "run/locked") out.skipped.push(c.name);
      else out.problems.push(`could not take the run lock of ${c.name}: ${(err as Error).message}`);
      continue;
    }
    try {
      pruneRun(project, dir, limit, out);
    } catch (err) {
      out.problems.push(`could not prune ${project.rel(dir)}: ${(err as Error).message}`);
    } finally {
      release();
    }
  }
  return out;
}

/** Prune one run folder; the caller holds the card's run lock. */
function pruneRun(project: Project, dir: string, limit: number, out: RawPrune): void {
  if (!finished(dir)) return;
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    out.problems.push(`could not read ${project.rel(dir)}: ${(err as Error).message}`);
    return;
  }
  for (const f of files) {
    if (!f.isFile() || !RAW.test(f.name)) continue;
    const file = path.join(dir, f.name);
    try {
      if (fs.statSync(file).mtimeMs >= limit) continue;
      fs.rmSync(file, { force: true });
      out.removed.push(project.rel(file));
    } catch (err) {
      out.problems.push(`could not remove ${project.rel(file)}: ${(err as Error).message}`);
    }
  }
}

/** True when the run's `state.json` can be read and says the run is over. */
function finished(dir: string): boolean {
  let status: unknown;
  try {
    status = loadState(dir)?.status;
  } catch {
    status = undefined;
  }
  return typeof status === "string" && FINISHED.has(status as RunStatus);
}
