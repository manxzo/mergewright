// Commands that run cards: run, approve, abort, status. See docs/design/engine.md section 9.
import { MwError } from "./util.ts";
import { hostName, hubFor, openHub } from "./hub.ts";
import { releaseUnlessBusy } from "./engine/registry.ts";
import { list, need, refuseOffline, str, type Handler, type Out } from "./cli.ts";
import { abort, approve, cardStatuses, describeRun, runCard, Stopped, usageTotals } from "./engine/run.ts";
import type { RunState } from "./engine/types.ts";
import { Project } from "./project.ts";
import { flushQueue } from "./integrations.ts";

/**
 * After `mw run` or `mw approve` has handed the project over: retry what earlier runs on this machine
 * could not deliver (notifications, lessons, docs), bounded by the flush budget (REQ-engine-009). The
 * queue is this machine's own, so the other machine never delivers the same item. Only once the lease
 * was released (REQ-engine-008): while this machine keeps it, nothing is sent.
 */
async function retryQueue(project: Project, released: boolean, out: Out): Promise<void> {
  if (!released) {
    out("the integration queue was not retried because this machine keeps the lease; the next queue flush after the lease is released retries it");
    return;
  }
  try {
    await flushQueue(project);
  } catch (err) {
    out(`could not retry the integration queue: ${(err as Error).message}`);
  }
}

/** Exit 0 when the run is done, waiting or stopped on purpose; 1 when it is blocked. */
const exitCode = (s: RunState) => (s.status === "blocked" ? 1 : 0);

/**
 * Run `f` with SIGINT and SIGTERM stopping the card at once. The first signal
 * aborts the active phase through the engine's stop signal; the engine returns (throwing `Stopped`)
 * only once the phase's agent or gate process group is gone, so the command never exits while one is
 * alive. A further signal only repeats that it is stopping. Returns 130 when the run was stopped.
 */
async function stoppable(out: Out, f: (stop: AbortSignal) => Promise<number>): Promise<number> {
  const ctl = new AbortController();
  const onSignal = (sig: NodeJS.Signals) => {
    if (ctl.signal.aborted) {
      out(`mw: ${sig} received again; still waiting for the phase's processes to end.`);
      return;
    }
    out(`mw: ${sig} received; stopping the current phase and waiting for its processes to end.`);
    ctl.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await f(ctl.signal);
  } catch (e) {
    if (e instanceof Stopped) {
      out(e.message);
      return 130;
    }
    throw e;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/**
 * The statuses at which `mw run` and `mw approve` hand the project over. A run `waiting`
 * at a stop point too: the stop point is in the run state, and whoever approves takes the lease again.
 */
const HAND_OVER = ["done", "blocked", "aborted", "waiting"];

/**
 * Hand the project over when the command returns (spec 9.3): once the run is `done`, `blocked`,
 * `aborted` or `waiting` at a stop point, `mw run` and `mw approve` release the lease this machine
 * holds, unless `--keep-lease` was given or another run of this machine is registered (checked and
 * released under the registry's guard, as `mw work` does). Never changes the exit code. Returns true
 * when the project has no hub or the lease was released; false when it was kept (`--keep-lease`, a run
 * that did not reach a hand-over status, another run of this machine) or the release failed.
 */
async function handOver(project: Project, state: RunState, keep: boolean, out: Out): Promise<boolean> {
  if (keep && HAND_OVER.includes(state.status)) {
    // Kept on purpose, so it is the owner's hold: never judged stale once this process ends.
    const hub = openHub(project);
    if (!hub.enabled) return true;
    try {
      if ((await hub.lease())?.host === hostName()) await hub.take({ keep: true });
    } catch (err) {
      out(`could not mark the lease as kept: ${(err as Error).message}`);
    }
    return false;
  }
  const hub = hubFor(project);
  if (!hub.enabled) return true;
  if (keep || !HAND_OVER.includes(state.status)) return false;
  try {
    let mine = true;
    const released = await releaseUnlessBusy(project, async () => {
      if ((await hub.lease())?.host !== hostName()) mine = false; // never held, or already lost
      else await hub.release();
    });
    if (!released) out(`kept the lease: another 'mw' process on this machine (${hostName()}) is running a card`);
    else if (mine) out(`released the lease, so the other machine can take over now ('--keep-lease' keeps it)`);
    return released;
  } catch (err) {
    out(`the lease could not be released: ${(err as Error).message}. It expires by itself, or run 'mw lease release'.`);
    return false;
  }
}

export const commands: Record<string, Handler> = {
  run: async (a, out) => {
    refuseOffline(a, "run");
    const project = Project.loadRunnable();
    const id = need(a._[1], "a card id, e.g. 'mw run DEMO-1'");
    return stoppable(out, async (stop) => {
      const state = await runCard(project, id, {
        approve: list(a, "approve"), until: str(a, "until"), from: str(a, "from"), dryRun: a.flags["dry-run"] === true, onProgress: (l) => out(l),
      }, { stop });
      if (a.flags["dry-run"] === true) return 0;
      out(describeRun(project, state));
      const usage = usageTotals(state);
      if (usage) out(`usage so far: ${usage.summary}`);
      const released = await handOver(project, state, a.flags["keep-lease"] === true, out);
      await retryQueue(project, released, out);
      return exitCode(state);
    });
  },

  // After the owner fixes what blocked a card: put it back at a phase without running anything, and
  // hand the project over, so `mw work` on whichever machine is free picks it up.
  retry: async (a, out) => {
    refuseOffline(a, "retry");
    const project = Project.loadRunnable();
    const id = need(a._[1], "a card id, e.g. 'mw retry DEMO-1 --from brief'");
    const card = project.card(id);
    const flow = project.flows().get(project.flowFor(card));
    const from = str(a, "from") ?? flow?.remediate?.phase ?? flow?.phases[0]?.id;
    if (!from) throw new MwError("usage", `card ${id} uses a flow that does not exist; fix its 'flow' field first`);
    const state = await runCard(project, id, { from, until: from });
    out(`${id} is back at '${from}' (round ${state.round}). 'mw run ${id}' continues it here; a machine running 'mw work' continues it by itself.`);
    // Hand the project over, unless another run of this
    // machine relies on the lease.
    const hub = hubFor(project);
    if (!hub.enabled) return 0;
    try {
      if (!(await releaseUnlessBusy(project, () => hub.release()))) {
        out(`kept the lease: another 'mw' process on this machine (${hostName()}) is running a card, so the other machine takes over once it is done`);
      }
    } catch (err) {
      out(`the lease could not be released: ${(err as Error).message}. It expires by itself, or run 'mw lease release'.`);
      return 1;
    }
    return 0;
  },

  approve: async (a, out) => {
    refuseOffline(a, "approve");
    const project = Project.loadRunnable();
    const id = need(a._[1], "a card id");
    const word = need(a._[2], "the approval word the run waits for, e.g. 'go'");
    return stoppable(out, async (stop) => {
      const state = await approve(project, id, word, { onProgress: (l) => out(l) }, { stop });
      out(describeRun(project, state));
      const usage = usageTotals(state);
      if (usage) out(`usage so far: ${usage.summary}`);
      const released = await handOver(project, state, a.flags["keep-lease"] === true, out);
      await retryQueue(project, released, out);
      return exitCode(state);
    });
  },

  abort: async (a, out) => {
    refuseOffline(a, "abort");
    const project = Project.loadRunnable();
    const id = need(a._[1], "a card id");
    const state = await abort(project, id, { force: a.flags.force === true });
    if (state.took) out(`took the lease over from ${state.took} (--force), so that machine stops working on this project at its next lease check`);
    if (state.orphans) {
      out(`${id} aborted, but ${state.orphans}.`);
      return 0;
    }
    const where = state.discarded ? `its worktree was moved to ${state.discarded} (kept there for seven days)` : "it had no worktree on this machine";
    out(`${id} aborted: ${where} and ${state.branch ? `branch ${state.branch} was kept` : "its branch was deleted"}.`);
    return 0;
  },

  status: (a, out) => {
    const project = Project.load();
    const id = a._[1];
    // `mw status <ID>`: that card only (an unknown id is an error, as for every card command).
    const rows = id ? cardStatuses(project).filter((r) => r.id === project.card(id).id) : cardStatuses(project);
    // REQ-config-002: answered from the tolerant load; the config's errors are reported (on standard error with --json).
    const configErrors = project.configErrors();
    if (configErrors.length) {
      const say = a.flags.json ? (l: string) => console.error(l) : out;
      say("mw: mergewright.yaml is invalid (config/invalid): runs and writing commands refuse until it is fixed ('mw check' lists the errors):");
      for (const e of configErrors) say(`  ${e}`);
    }
    if (a.flags.json) { out(JSON.stringify(rows, null, 2)); return 0; }
    if (!rows.length) { out("no cards yet (create one with 'mw card new --title ...')"); return 0; }
    const w = Math.max(...rows.map((r) => r.id.length));
    for (const r of rows) {
      out(`${r.id.padEnd(w)}  ${r.status.padEnd(Math.max(11, ...rows.map((x) => x.status.length + 1)))} ${r.flow.padEnd(9)} ${r.phase.padEnd(11)} ${r.title}`);
      if (r.usage) out(`${" ".repeat(w + 2)}usage: ${r.usage.summary}`);
    }
    return 0;
  },
};
