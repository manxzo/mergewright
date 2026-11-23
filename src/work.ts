// `mw work`: run the cards the owner marked `ready`, one after another, unattended. With `--watch` it
// keeps going: it waits while there is nothing to do, while the other machine holds the lease, or while
// agent usage is too high, and releases the lease when it runs out of work so the other machine can
// take over at once. See docs/design/engine.md sections 2 (the loop) and 8 (two machines).
import path from "node:path";
import { Orphaned } from "./engine/orphans.ts";
import { activeQuotas } from "./engine/quota.ts";
import { pruneRawStreams } from "./engine/rawstreams.ts";
import { runDrive } from "./engine/driver.ts";
import { runCard, Stopped, usageTotals } from "./engine/run.ts";
import { otherRunsHere, releaseUnlessBusy } from "./engine/registry.ts";
import { branchName, loadState, lockFile, lockHolder, mergingHere, runDir } from "./engine/state.ts";
import type { Hub, Integrations, RunState, RunStatus } from "./engine/types.ts";
import { formatAge, hostName, hubFor, leaseAgeMs, leaseStatus, offlineRefused } from "./hub.ts";
import { flushQueue, integrationsFor, reconcilePackages } from "./integrations.ts";
import { usageGuard } from "./integrations/usage.ts";
import type { Card } from "./model/card.ts";
import { Project } from "./project.ts";
import { git, MwError } from "./util.ts";

/** A card `mw work` would run now. `continues` = it has a run to continue (interrupted, or paused for usage). */
export interface Candidate {
  card: Card;
  state?: RunState;
  continues: boolean;
}

/** A card that is not done and will not be run now, with the reason in one sentence. */
export interface Ineligible {
  id: string;
  title: string;
  /** The card file's status ("ready" means only its run state or dependencies hold it back). */
  status: string;
  why: string;
  /** The card is merged (its file says `done`) but its run has not finished its flow. */
  unfinished?: boolean;
}

export interface Eligibility {
  /** In the order they would run: runs to continue first, then the rest, each in id order. */
  eligible: Candidate[];
  ineligible: Ineligible[];
}

function readState(project: Project, id: string): RunState | undefined | "unreadable" {
  try {
    return loadState(runDir(project, id));
  } catch {
    return "unreadable";
  }
}

/** The live status of a card: its run's status when it has a run, else the card file's. */
function liveStatus(card: Card, state: RunState | undefined | "unreadable"): string {
  if (card.status === "done") return "done";
  return state && state !== "unreadable" ? state.status : card.status;
}

/**
 * A card whose file says `done` (the merge marked it) but whose run has not
 * finished its flow: the runtime stopped between the merge and the end of the flow (reflection,
 * documentation), or such a phase is blocked or waits for an approval.
 */
export function unfinishedAfterMerge(card: Card, state: RunState | undefined | "unreadable"): boolean {
  return card.status === "done" && !!state && state !== "unreadable" && state.status !== "done" && state.status !== "aborted";
}

/** True when the card file has changes git has not committed (or is not committed at all). */
function uncommitted(project: Project, card: Card): boolean {
  const r = git(project.root, ["status", "--porcelain", "--", card.file], { allowFail: true });
  return r.code === 0 && r.stdout.trim() !== "";
}

/**
 * Which cards may run now. A card whose file says `done` but whose run has not finished its flow is
 * continued first, unless that run is blocked or waits for an approval (then it is listed with the
 * reason). Otherwise a card is eligible when its card file says `ready`, the file is committed
 * (the merge marks it done in a commit, which git refuses over local edits), no run of it is waiting
 * for an approval, blocked, done or aborted, no other process on this machine is running it, and
 * every card it depends on is done. `skip` holds ids this caller does not want again (with the reason).
 */
export function eligibility(project: Project, skip: Map<string, string> = new Map()): Eligibility {
  const cards = project.cards();
  const byId = new Map(cards.map((c) => [c.id, c]));
  const states = new Map(cards.map((c) => [c.id, readState(project, c.id)]));
  const continuing: Candidate[] = [];
  const starting: Candidate[] = [];
  const ineligible: Ineligible[] = [];

  for (const card of cards) {
    const state = states.get(card.id);
    const unfinished = unfinishedAfterMerge(card, state);
    if (!unfinished && liveStatus(card, state) === "done") continue;
    const no = (why: string) => { ineligible.push({ id: card.id, title: card.title, status: card.status, why, unfinished: unfinished || undefined }); };
    if (unfinished && state && state !== "unreadable") {
      // Merged already: only the rest of its flow is left, whatever the card's dependencies say now.
      if (skip.has(card.id)) { no(skip.get(card.id)!); continue; }
      if (state.status === "blocked") { no(`it is merged, but its run is blocked after the merge: ${firstLine(state.reason ?? "(no reason recorded)")} Fix the cause, then run 'mw run ${card.id}'`); continue; }
      if (state.status === "waiting" && state.reason !== "usage") { no(`it is merged, but its run waits for approval '${state.reason}'; run 'mw approve ${card.id} ${state.reason}'`); continue; }
      const holder = lockHolder(lockFile(project, card.id));
      if (holder) { no(`process ${holder.pid} on this machine is running it now`); continue; }
      continuing.push({ card, state, continues: true });
      continue;
    }
    if (card.status !== "ready") { no(`its status is '${card.status}'; only cards marked 'ready' are picked up`); continue; }
    if (state === "unreadable") { no(`its run state (${path.join(".mergewright", "runs", card.id, "state.json")}) cannot be read; fix or delete it`); continue; }
    if (skip.has(card.id)) { no(skip.get(card.id)!); continue; }
    if (state?.status === "blocked") { no(`its run is blocked: ${firstLine(state.reason ?? "(no reason recorded)")} Fix the cause, then run 'mw run ${card.id}'`); continue; }
    if (state?.status === "waiting" && state.reason !== "usage") { no(`its run waits for approval '${state.reason}'; run 'mw approve ${card.id} ${state.reason}'`); continue; }
    if (state?.status === "aborted") { no(`its run was aborted; 'mw run ${card.id}' starts it again`); continue; }
    const missing = card.depends.filter((dep) => !byId.has(dep));
    const waits = card.depends.filter((dep) => byId.has(dep)).map((dep) => [dep, liveStatus(byId.get(dep)!, states.get(dep))] as const).filter(([, s]) => s !== "done");
    if (missing.length || waits.length) {
      const why: string[] = [];
      if (missing.length) why.push(`it depends on ${missing.join(", ")}, which ${missing.length > 1 ? "do" : "does"} not exist`);
      if (waits.length) why.push(`it waits for ${waits.map(([d, s]) => `${d} (${s})`).join(", ")} to be done`);
      no(why.join("; "));
      continue;
    }
    if (uncommitted(project, card)) { no(`${card.file} has changes that are not committed; commit it so the merge can mark the card done`); continue; }
    const holder = lockHolder(lockFile(project, card.id));
    if (holder) { no(`process ${holder.pid} on this machine is running it now`); continue; }
    const continues = state?.status === "running" || (state?.status === "waiting" && state.reason === "usage");
    (continues ? continuing : starting).push({ card, state, continues });
  }
  return { eligible: [...continuing, ...starting], ineligible };
}

const firstLine = (s: string) => {
  const l = s.trim().split("\n")[0] ?? "";
  return /[.!?]$/.test(l) ? l : `${l}.`;
};

// ── The loop ────────────────────────────────────────────────────────────────────────────────

export interface WorkOptions {
  /** Approval words passed to every run (`--approve go,merge`). */
  approve?: string[];
  /** Stop after this many cards were run. */
  max?: number;
  /** Keep going: wait and look again instead of exiting when there is nothing to do. */
  watch?: boolean;
  /** Seconds between looks in watch mode (default 60). */
  interval?: number;
  /** Refused on a project with a hub (see `offlineRefused`); without one there is nothing to be offline from. */
  offline?: boolean;
  out: (line: string) => void;
  /** Aborted = take no new card; the current one finishes, the lease is released, the loop returns. */
  signal?: AbortSignal;
  /** Aborted = stop the current card's active phase at once (see EngineDeps.stop), then as `signal`. */
  stopNow?: AbortSignal;
  /** How to wait between looks; must return early when `signal` fires. Injected by tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Hub and integrations per pass (default: the project's own). Injected by tests. */
  hub?: (project: Project) => Hub;
  integrations?: (project: Project) => Integrations;
}

export interface CardRun {
  id: string;
  status: RunStatus | "error";
  /** The one-line summary that was printed. */
  line: string;
}

export interface WorkResult {
  runs: CardRun[];
  /** 0 when no card ended blocked or failed and the hub did not stop the work, else 1. */
  code: number;
}

export function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The one-line summary of how a card's run ended. */
export function summarize(project: Project, state: RunState): string {
  const id = state.card.padEnd(8);
  const phase = project.flows().get(state.flow)?.phases[state.phase]?.id ?? "the end";
  switch (state.status) {
    case "done":
      return `${id} done     ${state.merged ? `merged into ${project.config.git.base} as ${state.merged.slice(0, 10)}` : `finished without a merge; branch ${branchName(state.card)} is kept`}`;
    case "waiting":
      return state.reason === "usage"
        ? `${id} waiting  paused before '${phase}' because agent usage is too high; it continues on a later pass`
        : `${id} waiting  before '${phase}' for approval '${state.reason}'; run 'mw approve ${state.card} ${state.reason}'`;
    case "blocked":
      return `${id} blocked  at '${phase}': ${firstLine(state.reason ?? "(no reason recorded)")}`;
    default:
      return `${id} ${state.status.padEnd(8)} before '${phase}'`;
  }
}

/** Why this machine cannot work right now, or undefined when it can. `key` stays the same while the reason does. */
interface Pause {
  key: string;
  message: string;
}

/**
 * Run ready cards until none is eligible (or `max` were run, or `signal` fires); with `watch`, wait
 * `interval` seconds and look again, forever. Each pass reloads the project from disk and syncs the
 * base branch with the hub, so cards and specs that arrived from the other machine are seen; it
 * retries the integration queue (bounded) only after its card was dispatched, or when it has none.
 */
export async function work(root: string, opts: WorkOptions): Promise<WorkResult> {
  // REQ-config-001: refused before the board, the queue, the lease or any card is touched.
  new Project(root).assertRunnable();
  const out = opts.out;
  const sleep = opts.sleep ?? sleepFor;
  const intervalMs = Math.max(0, (opts.interval ?? 60) * 1000);
  const runs: CardRun[] = [];
  /** Cards not to take again: run already in this drain, or failed with an error in this session. */
  let tried = new Map<string, string>();
  const failed = new Map<string, string>();
  let holding = false; // this process ran a card since it last released the lease
  let kept = false; // its last release did not go through, so the lease may still be this machine's
  let lastKey = "";
  let lastProject: Project | undefined;
  let hubBlock: Error | undefined;
  let halted = false;
  let orphaned: Orphaned | undefined;

  const stopped = () => opts.signal?.aborted === true || opts.stopNow?.aborted === true;
  const maxed = () => opts.max !== undefined && runs.length >= opts.max;
  const hubOf = (p: Project) => opts.hub?.(p) ?? hubFor(p);
  const integrationsOf = (p: Project) => opts.integrations?.(p) ?? integrationsFor(p);
  const say = (p: Pause) => {
    if (p.key !== lastKey) out(p.message);
    lastKey = p.key;
  };
  /**
   * Release the lease this process took for its cards. True when this process no longer holds it (it
   * held none, the project has no hub, or the release went through); false when it was kept (another
   * run of this machine is registered) or the release failed.
   */
  const release = async (project: Project, why: string): Promise<boolean> => {
    if (!holding) return !kept;
    holding = false;
    const hub = hubOf(project);
    if (!hub.enabled) return true;
    try {
      // Checked and released under the registry's guard, so a run starting meanwhile keeps it.
      let mine = true;
      const released = await releaseUnlessBusy(project, async () => {
        if ((await hub.lease())?.host !== hostName()) mine = false; // never got it, or already lost it
        else await hub.release();
      });
      if (!released) out(`kept the lease: another 'mw' process on this machine (${hostName()}) is running a card`);
      else if (mine) out(`released the lease ${why}, so the other machine can take over now`);
      kept = !released;
      return released;
    } catch (err) {
      out(`could not release the lease: ${(err as Error).message}. It expires by itself, or run 'mw lease release'.`);
      kept = true;
      return false;
    }
  };

  /** Everything that must be true before a card is taken: lease free or ours, usage fine, base synced. */
  const checkPass = async (project: Project): Promise<Pause | undefined> => {
    const hub = hubOf(project);
    if (hub.enabled) {
      try {
        // The hub's takeover rule decides (the lease observed unchanged by this machine for a lease
        // time, or older than three by its own clock), so this pass waits exactly when 'mw run' would
        // be refused. An injected hub (tests) has no such rule: there the lease's age decides.
        let lease = undefined as Awaited<ReturnType<Hub["lease"]>>;
        let waitMs = 0;
        if (opts.hub) {
          lease = await hub.lease();
          const limitMs = project.config.limits.leaseMinutes * 60_000;
          if (lease && lease.host !== hostName()) waitMs = Math.max(0, limitMs - leaseAgeMs(lease));
        } else {
          const st = await leaseStatus(project);
          lease = st.lease;
          waitMs = st.takeoverInMs;
        }
        if (lease && lease.host !== hostName() && waitMs > 0) {
          return {
            key: `lease:${lease.host}`,
            message: `${lease.host} holds the lease (refreshed ${formatAge(leaseAgeMs(lease))} ago by its clock), so this machine waits for it to finish; it may take the lease over in ${formatAge(waitMs)} if the lease is not refreshed by then`,
          };
        }
      } catch (err) {
        return { key: "hub", message: `cannot check the lease: ${(err as Error).message}` };
      }
    }
    // REQ-usage-004: the shared guard, before any role of a card; asked only when the project has a role
    // on a paid harness (a project of local, mock and shell roles is never paused).
    const usage = await usageGuard(integrationsOf(project), [...project.roles().values()].map((r) => r.runs));
    if (!usage.ok) return { key: "usage", message: `agent usage is too high (${usage.detail}), so no new work starts until it drops` };
    // A harness that reported a quota or session limit takes no new card until its reset time.
    const limits = Object.entries(activeQuotas(project));
    if (limits.length) {
      const which = limits.map(([h, q]) => `${h} until ${q.until}`).join(", ");
      return { key: "usage", message: `an agent reported a usage limit (${which}), so no new work starts until it resets` };
    }
    try {
      await hub.sync();
    } catch (err) {
      return { key: `sync:${(err as MwError).code ?? ""}`, message: `could not sync with the hub: ${(err as Error).message}` };
    }
    return undefined;
  };

  /**
   * REQ-config-001: why `project` must not be acted on (its config fails its schema, so every setting
   * would be a default), or undefined. Checked at each pass before the board, the queue, the lease,
   * the usage guard or the hub are touched, and again after the hub sync, before a card is taken.
   */
  const invalidConfig = (project: Project): Pause | undefined => {
    try {
      project.assertRunnable();
      return undefined;
    } catch (err) {
      if (!(err instanceof MwError) || err.code !== "config/invalid") throw err;
      return { key: `config:${err.message}`, message: err.message };
    }
  };
  /**
   * An invalid config found during a pass: that pass does nothing more. Without --watch the command
   * stops (and reports it in the exit code); with it, it says so once and looks again after the
   * interval. Returns true when the loop ends.
   */
  const skipPass = async (p: Pause): Promise<boolean> => {
    if (!opts.watch) {
      out(`${p.message}
'mw work' stopped; nothing more was run.`);
      halted = true;
      return true;
    }
    say({ key: p.key, message: `${p.message}
'mw work --watch' does nothing until it is fixed and looks again every ${opts.interval ?? 60} s.` });
    await sleep(intervalMs, opts.signal);
    return false;
  };

  /**
   * REQ-engine-009: retry this machine's integration queue after the pass's card was dispatched (or
   * when the pass has none), bounded by the flush budget and the per-kind breaker, so a service that
   * does not answer never holds up a card. REQ-engine-012: called only at safe points (between cards,
   * on an idle or paused pass, at the end of the command), never inside a run; it waits only for a run
   * of this machine inside its merge phase (`mergingHere`), never for the lease, so cards run back to
   * back with the lease kept still deliver. Items another process holds (REQ-engine-008) stay skipped.
   * It also waits while another 'mw' process of this machine has a run registered
   * (`otherRunsHere`, the signal that makes `releaseUnlessBusy` keep the lease for that process), so
   * neither ordinary items nor this process's reflection items are delivered under a lease another
   * process keeps. A lease kept only because its release failed (the hub did not answer) is this
   * process's own and does not hold the flush back.
   */
  let unflushed = false; // a card ran since the last flush
  const flush = async (project: Project) => {
    const merging = mergingHere(project);
    if (merging.length) {
      out(`the integration queue was not retried because ${merging.join(", ")} ${merging.length > 1 ? "are" : "is"} inside ${merging.length > 1 ? "their" : "its"} merge phase on this machine; a later pass retries it`);
      return;
    }
    if (otherRunsHere(project)) {
      out(`the integration queue was not retried because another 'mw' process on this machine (${hostName()}) is running a card and keeps the lease; a later pass retries it`);
      return;
    }
    unflushed = false;
    try {
      await flushQueue(project);
    } catch (err) {
      out(`could not retry the integration queue: ${(err as Error).message}`);
    }
  };

  /**
   * Let each enabled package that keeps an outside view of the cards (a board) bring it level with every
   * card, for statuses another machine set; each prints a line only when it has something new to say.
   */
  const reconcile = async (project: Project, when: string) => {
    try {
      for (const line of await reconcilePackages(project, when)) out(line);
    } catch (err) {
      out(`could not reconcile: ${(err as Error).message}`);
    }
  };

  // A project with a hub never works offline: the other machine could be running the same card.
  if (opts.offline) {
    const first = new Project(root);
    const hub = hubOf(first);
    if (hub.enabled) throw offlineRefused(first.config.git.hub);
  }

  let reconciled = false;
  for (;;) {
    if (stopped() || maxed()) break;
    let project = new Project(root);
    const invalid = invalidConfig(project);
    if (invalid) {
      if (await skipPass(invalid)) break;
      continue;
    }
    lastProject = project;
    // REQ-engine-007: raw streams of finished runs older than trace.raw_days go at the start of each pass.
    const pruned = pruneRawStreams(project);
    if (pruned.removed.length) out(`removed ${pruned.removed.length} raw stream file(s) older than ${project.config.trace.rawDays} day(s) from finished runs (trace.raw_days); their state, artifacts and audit trail are kept`);
    for (const p of pruned.problems) out(`pruning raw streams: ${p}`);
    if (!reconciled) {
      reconciled = true;
      await reconcile(project, "before taking cards");
    }

    const pause = hubBlock ? { key: `run:${hubBlock.message}`, message: hubBlock.message } : await checkPass(project);
    hubBlock = undefined;
    if (pause) {
      await flush(project);
      if (!opts.watch) {
        out(`${pause.message}. Nothing more was run; 'mw work --watch' waits and continues by itself.`);
        if (pause.key !== "usage") halted = true; // the hub stopped this machine: report it in the exit code
        break;
      }
      say(pause);
      await sleep(intervalMs, opts.signal);
      continue;
    }

    project = new Project(root); // sync may have brought commits for files the file-sync tool delivered
    const adopted = invalidConfig(project);
    if (adopted) {
      if (await skipPass(adopted)) break;
      continue;
    }
    lastProject = project;
    const skip = new Map([...tried, ...failed]);
    const { eligible } = eligibility(project, skip);
    const next = eligible[0];
    if (!next) {
      await release(project, "after finishing the eligible work");
      await flush(project);
      if (!opts.watch) break;
      tried = new Map(); // a later pass may take them again (a card paused for usage, say)
      say({ key: "idle", message: `nothing to do: no card is ready and eligible; looking again every ${opts.interval ?? 60} s` });
      await sleep(intervalMs, opts.signal);
      continue;
    }

    lastKey = "";
    const id = next.card.id;
    tried.set(id, "it was already run in this pass");
    const hub = hubOf(project);
    if (hub.enabled) {
      holding = true;
      kept = false; // released (or kept) again after this card
    }
    let state: RunState;
    try {
      state = await runCard(project, id, {
        approve: opts.approve,
        onProgress: (l) => out(`  ${id}  ${l}`),
      }, { hub, integrations: integrationsOf(project), stop: opts.stopNow });
    } catch (err) {
      if (err instanceof Stopped) {
        out(`${id.padEnd(8)} stopped  ${err.message}`);
        break;
      }
      if (err instanceof Orphaned) {
        // Processes of the card's run could not be stopped; no further card
        // starts, and the command ends with this error once the lease is dealt with.
        out(`${id.padEnd(8)} error    ${err.message}`);
        runs.push({ id, status: "error", line: err.message });
        orphaned = err;
        break;
      }
      if (err instanceof MwError && (err.code.startsWith("hub/") || err.code.startsWith("lease/"))) {
        // The hub refused the whole machine (another machine took the lease, histories diverged), or this
        // machine lost the lease while the card ran (its run state was left to the new holder): not this card's fault.
        tried.delete(id);
        hubBlock = err;
        await flush(project);
        continue;
      }
      const line = `${id.padEnd(8)} error    ${(err as Error).message}`;
      failed.set(id, `it failed with an error earlier in this session; fix it and run 'mw run ${id}', or restart 'mw work'`);
      runs.push({ id, status: "error", line });
      out(line);
      await flush(project);
      continue;
    }
    const line = summarize(project, state);
    runs.push({ id, status: state.status, line });
    out(line);
    const usage = usageTotals(state);
    if (usage) out(`${" ".repeat(9)}usage: ${usage.summary}`);
    // The pass's card is dispatched first; the queue is retried after it (REQ-engine-009), between
    // cards, with the lease kept (REQ-engine-012).
    unflushed = true;
    await flush(project);
  }

  if (lastProject) {
    await release(lastProject, stopped() || orphaned ? "on the way out" : "before exiting");
    // A drain whose last flush was skipped (a run of this machine was inside its merge phase) retries
    // the queue once more on the way out.
    if (unflushed && !stopped() && !orphaned) await flush(lastProject);
  }
  // The lease is released with the last configuration that passed its schema (the one it was taken
  // with); the board is brought level only while the configuration still passes.
  if (lastProject && runs.length) {
    const end = new Project(root);
    if (!invalidConfig(end)) await reconcile(end, "after finishing");
  }
  if (orphaned) throw orphaned;
  const count = (s: CardRun["status"]) => runs.filter((r) => r.status === s).length;
  const bad = count("blocked") + count("error");
  const parts = [`${count("done")} done`, `${count("waiting")} waiting`, `${count("blocked")} blocked`];
  if (count("error")) parts.push(`${count("error")} failed with an error`);
  const why = stopped() ? " (stopped on request)" : maxed() ? ` (stopped at --max ${opts.max})` : "";
  out(`mw work: ran ${runs.length} card(s)${why}: ${parts.join(", ")}.`);
  if (lastProject) {
    // Ready cards that were left behind, so the owner sees why.
    const left = eligibility(new Project(root)).ineligible.filter((c) => c.status === "ready" || c.unfinished);
    for (const c of left) out(`  not run: ${c.id}: ${c.why}`);
  }
  return { runs, code: bad || halted ? 1 : 0 };
}

// ── Dry run ─────────────────────────────────────────────────────────────────────────────────

/** Print which cards would run, in order, and why each other card that is not done would not. Changes nothing. */
export function dryRun(root: string, out: (line: string) => void): void {
  const project = new Project(root);
  const { eligible, ineligible } = eligibility(project);
  if (eligible.length) {
    out("would run, in this order:");
    for (const c of eligible) {
      const phase = c.state ? project.flows().get(c.state.flow)?.phases[c.state.phase]?.id : undefined;
      // REQ-engine-014: a run nothing drives reads as `mw status` prints it (runDrive decides both).
      const drive = c.state ? runDrive(project, c.state) : undefined;
      const how = drive?.status === "queued" ? drive.label
        : c.continues ? `continue its ${c.state!.status === "waiting" ? "run paused for usage" : "interrupted run"} at '${phase ?? "the end"}'` : `start (flow ${project.flowFor(c.card)})`;
      out(`  ${c.card.id.padEnd(8)} ${how}: ${c.card.title}`);
    }
  } else out("nothing would run: no card is ready and eligible");
  if (ineligible.length) {
    out("not eligible:");
    for (const c of ineligible) {
      // A queued run whose card would not run still reads as `mw status` prints it (REQ-engine-014).
      const state = readState(project, c.id);
      const drive = state && state !== "unreadable" ? runDrive(project, state) : undefined;
      out(`  ${c.id.padEnd(8)} ${c.why}${drive?.status === "queued" ? ` [${drive.label}]` : ""}`);
    }
  }
  out("(dry run: no card was run, and the hub was not contacted)");
}
