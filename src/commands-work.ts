// `mw work`: run ready cards unattended (src/work.ts).
import { list, refuseOffline, str, type Handler } from "./cli.ts";
import { Project } from "./project.ts";
import { MwError } from "./util.ts";
import { dryRun, work } from "./work.ts";

function positive(value: string | undefined, flag: string, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new MwError("usage", `--${flag} needs a positive ${integer ? "whole number" : "number of seconds"}, not '${value}'`);
  }
  return n;
}

export const commands: Record<string, Handler> = {
  work: async (a, out) => {
    refuseOffline(a, "work");
    const root = Project.loadRunnable().root;
    const max = positive(str(a, "max"), "max", true);
    const interval = positive(str(a, "interval"), "interval", false);
    if (a.flags["dry-run"] === true) {
      dryRun(root, out);
      return 0;
    }
    // First signal: take no new card, let the current one finish, release the lease, exit 0.
    // A second signal aborts the current card's active phase through the
    // engine's stop signal; the run returns only once that phase's agent or gate process group is gone,
    // and the command then exits with 130. process.exit() is never called: no child group outlives it.
    const stop = new AbortController();
    const now = new AbortController();
    const onSignal = (sig: NodeJS.Signals) => {
      if (now.signal.aborted) {
        out(`mw work: ${sig} received again; still waiting for the current phase's processes to end.`);
        return;
      }
      if (stop.signal.aborted) {
        out(`mw work: second ${sig}; stopping the current phase now and waiting for its processes to end. The card continues from its last finished phase on the next run.`);
        now.abort();
        return;
      }
      out(`mw work: ${sig} received; no new card will start. Waiting for the current card to finish (press Ctrl-C again to stop at once).`);
      stop.abort();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      const r = await work(root, {
        approve: list(a, "approve"), max, interval, watch: a.flags.watch === true,
        out: (l) => out(l), signal: stop.signal, stopNow: now.signal,
      });
      if (now.signal.aborted) return 130;
      return stop.signal.aborted ? 0 : r.code;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  },
};
