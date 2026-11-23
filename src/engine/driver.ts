// Whether a process drives a run (REQ-engine-014). A run's state says `running` from the moment a
// process takes it until the flow ends, stops or blocks; a process that dies, or a run set back by
// `mw retry`, leaves `running` in state.json with no process behind it. Such a run is `queued`: it
// waits for `mw work` or `mw run <ID>`, which continue it at the phase it records. `mw status`
// (cardStatuses), `mw work --dry-run` and describeRun all decide it here, from this machine's run lock.
import { hostName } from "../hub.ts";
import type { Project } from "../project.ts";
import type { LockInfo } from "./registry.ts";
import { lockDriver, lockFile } from "./state.ts";
import type { RunState } from "./types.ts";

export interface RunDrive {
  /**
   * "running": a live process of this machine holds the run's lock, or the run was last driven on
   * another machine (whose processes this one cannot see). "queued": nothing drives it.
   */
  status: "running" | "queued";
  /** The phase the run is at, and resumes at when queued ("the end" past the last phase). */
  phase: string;
  /** The process that drives it, when it is one of this machine's. */
  holder?: LockInfo;
  /** The status as `mw status` and `mw work --dry-run` print it, with how to drive a queued run. */
  label: string;
}

/**
 * Whether a run whose state says `running` is driven by a process (undefined for any other status).
 * The run lock's holder is judged with the lock's own liveness test (pid and process start time, so a
 * reused pid is a dead driver; an unreadable lock is a dead driver). Reads only: neither the state, the
 * lock nor the lease is written.
 */
export function runDrive(project: Project, state: RunState): RunDrive | undefined {
  if (state.status !== "running") return undefined;
  const phase = project.flows().get(state.flow)?.phases[state.phase]?.id ?? "the end";
  if (state.host && state.host !== hostName()) return { status: "running", phase, label: "running" };
  const holder = lockDriver(lockFile(project, state.card));
  if (holder) return { status: "running", phase, holder, label: "running" };
  return { status: "queued", phase, label: `queued ('mw work' or 'mw run ${state.card}' resumes it at '${phase}')` };
}
