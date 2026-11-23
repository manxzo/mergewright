// Commands for the hub layer: `mw sync` and `mw lease` (docs/design/engine.md sections 8 and 9).
import type { Lease } from "./engine/types.ts";
import type { Handler } from "./cli.ts";
import { formatAge, hostName, leaseAgeMs, openHub } from "./hub.ts";
import { Project } from "./project.ts";
import { MwError } from "./util.ts";

/**
 * Decision C: after a successful sync, remove this machine's worktrees of cards that are done. The
 * engine provides `pruneFinished(project)`; it is looked up at run time so `mw sync` works whether or
 * not that export exists yet. Returns the module it came from, or undefined when there is none.
 */
type Prune = (project: Project) => unknown;
export const PRUNE_MODULES = ["./engine/run.ts", "./engine/gitops.ts"];
async function findPrune(): Promise<{ from: string; prune: Prune } | undefined> {
  for (const from of PRUNE_MODULES) {
    try {
      const m = (await import(from)) as { pruneFinished?: unknown };
      if (typeof m.pruneFinished === "function") return { from, prune: m.pruneFinished as Prune };
    } catch {
      // module missing or failing to load: try the next one
    }
  }
  return undefined;
}

/** The engine's report (`{removed, kept}` in src/engine/run.ts), tolerating a bare list or nothing. */
function pruneReport(r: unknown): { removed: string[]; kept: string[] } {
  const strings = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : []);
  if (Array.isArray(r)) return { removed: strings(r), kept: [] };
  const o = (r && typeof r === "object" ? r : {}) as { removed?: unknown; kept?: unknown };
  return { removed: strings(o.removed), kept: strings(o.kept) };
}

const NO_HUB = "no hub is configured (git.hub is none), so there is no lease: this project runs on one machine";

function who(lease: Lease): string {
  return `${lease.host} (pid ${lease.pid}${lease.host === hostName() ? ", this machine" : ""})`;
}

export const commands: Record<string, Handler> = {
  sync: async (a, out) => {
    const project = Project.loadRunnable();
    const r = await openHub(project, { warn: (l) => out(l) }).sync({ offline: a.flags.offline === true });
    out(r.detail);
    if (r.action === "no-hub") return 0;
    const found = await findPrune();
    if (!found) return 0;
    try {
      const { removed, kept } = pruneReport(await found.prune(project));
      if (removed.length) out(`removed the worktrees of finished cards on this machine: ${removed.join(", ")}`);
      for (const k of kept) out(`kept a finished card's worktree: ${k}`);
    } catch (e) {
      out(`the sync succeeded, but removing the worktrees of finished cards failed: ${(e as Error).message}. Check them with 'git worktree list'.`);
      return 1;
    }
    return 0;
  },

  lease: async (a, out) => {
    const sub = a._[1] ?? "show";
    if (!["show", "take", "release"].includes(sub)) throw new MwError("usage", "use 'mw lease show', 'mw lease take [--force]' or 'mw lease release'");
    // Taking or releasing the lease acts on git.hub, so it needs the config as written (REQ-config-001).
    const project = sub === "show" ? Project.load() : Project.loadRunnable();
    const hub = openHub(project);
    if (!hub.enabled) { out(NO_HUB); return 0; }
    const limitMs = project.config.limits.leaseMinutes * 60_000;

    if (sub === "show") {
      const observed = await hub.observe();
      const { lease } = observed;
      if (!lease) { out(`no machine holds the lease on hub '${hub.remote}'`); return 0; }
      out(`lease held by ${who(lease)}, taken or refreshed ${formatAge(leaseAgeMs(lease))} ago by its own clock`);
      if (lease.host === hostName()) {
        if (hub.staleHere(lease)) {
          out(`the lease is stale: process ${lease.pid} that took it is gone and no run of this machine is registered. 'mw lease release' releases it, and the next 'mw run' or 'mw work' here takes it over.`);
          return 0;
        }
        out(`another machine may take it over once it has seen it unchanged for ${formatAge(limitMs)}, so keep refreshing it (any 'mw run' does) or release it with 'mw lease release'`);
        return 0;
      }
      const wait = hub.takeoverInMs(observed);
      out(wait > 0
        ? `this machine may take it over in ${formatAge(wait)} unless it is refreshed by then ('mw lease take --force' takes it now)`
        : "it has gone stale: this machine may take it over now ('mw lease take', or the next run takes it)");
      return 0;
    }
    if (sub === "take") {
      // The owner's hold is kept until 'mw lease release' (or a run hands it over).
      const r = await hub.take({ force: a.flags.force === true, keep: true });
      if (r.staleHere && r.previous) out(`lease taken over by ${hostName()} from this machine's stale lease (process ${r.previous.pid} is gone)`);
      else if (r.refreshed) out(`lease refreshed by ${hostName()}`);
      else if (r.previous) out(`lease taken over by ${hostName()} from ${r.previous.host} (last refreshed ${formatAge(leaseAgeMs(r.previous))} before)`);
      else out(`lease taken by ${hostName()}`);
      return 0;
    }
    const before = (await hub.observe()).lease;
    const stale = hub.staleHere(before);
    const r = await hub.drop();
    if (r.released) { out(`lease released by ${hostName()}${stale && before ? ` (it was stale: process ${before.pid} that took it is gone)` : ""}`); return 0; }
    if (r.holder) { out(`this machine (${hostName()}) does not hold the lease; ${who(r.holder)} does, so it was left in place`); return 1; }
    out("no machine holds the lease; nothing to release");
    return 0;
  },
};
