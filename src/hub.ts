// Shared repository state between machines (docs/design/engine.md section 8). Working files travel
// by a file-sync tool of the owner's choice; history travels through a git remote, the hub. `sync` adopts or pushes the base
// branch; a lease ref on the hub makes sure only one machine drives the project at a time.
import os from "node:os";
import path from "node:path";
import type { Hub, Lease, SyncResult } from "./engine/types.ts";
import { readBounded } from "./integrations/common.ts";
import { otherRunsHere, releaseUnlessBusy } from "./engine/registry.ts";
import { isAlive, processIdentity } from "./engine/procid.ts";
import { localDir, type Project } from "./project.ts";
import { MwError, readIfExists, sh, writeJson, type ShResult } from "./util.ts";

export const LEASE_REF = "refs/mergewright/lease";
/** The last lease commit this machine read from (or wrote to) the hub, so its message can be read. */
const SEEN_REF = "refs/mergewright/hub-lease";
const ZERO = "0".repeat(40);
const NET_TIMEOUT_MS = 60_000;

/**
 * Lease commits this process wrote, by repository and hub. Present = this process took the lease, so
 * every push is fenced by it (one atomic push that also moves the lease). A lease written by another
 * `mw` process on the same host also counts as ours (the same machine continues).
 */
const heldLeases = new Map<string, string>();
/**
 * Repositories and hubs whose lease this process writes as `kept` (taken with `mw lease
 * take`, or kept with `--keep-lease`): such a lease is the owner's, never judged stale by its pid.
 */
const keptLeases = new Set<string>();

/** Test-only seams. Nothing in the runtime sets them. */
export const hubTestHooks: {
  beforeAdoptUpdate?: () => void | Promise<void>;
  /** A process that did not hold the lease has just taken it to push, and is about to push. */
  beforeUnheldPush?: () => void | Promise<void>;
} = {};

/**
 * This machine's first sight of another machine's lease commit (`.mergewright/local/lease-seen.json`,
 * never file-synced). An older runtime kept a record keyed by host in `.mergewright/lease-seen.json`;
 * that file is ignored.
 */
export const LEASE_SEEN_FILE = "lease-seen.json";
interface SeenRecord {
  sha: string;
  firstSeen: string;
}

/** The lease as read from the hub, with the commit it sits on (`sha` is "" when nobody holds it). */
export interface ObservedLease {
  sha: string;
  lease?: Lease;
}

/** The `Hub` plus the finer lease controls the `mw lease` command needs. */
export interface HubControl extends Hub {
  readonly remote: string;
  observe(): Promise<ObservedLease>;
  /**
   * How long until this machine may take `observed` over without --force: 0 when it may now (or when
   * nobody, or this host, holds it). See `takeoverInMs` in openHub for the rule.
   */
  takeoverInMs(observed: ObservedLease): number;
  /**
   * Take or refresh the lease. A fresh lease held by another machine is taken over only with
   * `force`. With `observed`, the compare-and-swap is made against that earlier read.
   */
  take(opts?: { force?: boolean; observed?: ObservedLease; keep?: boolean }): Promise<{ previous?: Lease; refreshed: boolean; staleHere?: boolean }>;
  /** True when `lease` is this host's and stale here (see `leaseStaleHere`). */
  staleHere(lease: Lease | undefined): boolean;
  /** Delete the lease if this machine holds it. `holder` is set when another machine does. */
  drop(): Promise<{ released: boolean; holder?: Lease }>;
}

/** The refusal of `--offline` on a project that shares its state through a hub. */
export function offlineRefused(remote: string): MwError {
  return new MwError("hub/offline", `this project shares its state through the hub '${remote}'; connect to it, or set git.hub to none for a single-machine project`);
}

/** This machine's name in the lease: env `MW_HOST`, else the hostname. */
export function hostName(): string {
  return process.env.MW_HOST || os.hostname();
}

/** The current time; env `MW_NOW` (an ISO time) overrides it so lease ages can be tested. */
export function nowMs(): number {
  const t = process.env.MW_NOW ? Date.parse(process.env.MW_NOW) : NaN;
  return Number.isNaN(t) ? Date.now() : t;
}

export function leaseAgeMs(lease: Lease): number {
  const t = Date.parse(lease.time);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Math.max(0, nowMs() - t);
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return "an unknown time";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function parseLease(message: string): Lease {
  try {
    const v = JSON.parse(message) as Partial<Lease>;
    if (typeof v.host === "string" && typeof v.pid === "number" && typeof v.time === "string") return { host: v.host, pid: v.pid, time: v.time, ...(typeof v.started === "string" ? { started: v.started } : {}), ...(v.kept === true ? { kept: true } : {}) };
  } catch { /* fall through */ }
  // An unreadable lease counts as expired, so it can be taken over.
  return { host: "(unreadable lease)", pid: 0, time: new Date(0).toISOString() };
}

/**
 * What git said, for an error message: its last three non-empty lines (hints left out)
 * joined with " | ", without trailing periods (the message adds its own). One line lost the cause:
 * "Could not read from remote repository. Please make sure ... and the repository exists." ended as
 * "and the repository exists..".
 */
export function gitGist(output: string): string {
  return output.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("hint:")).slice(-3).join(" | ").replace(/\.+$/, "");
}

/**
 * A lease this host holds is stale here when the process that wrote it is gone (pid and,
 * where recorded, its start time: `isAlive`), it is not kept by the owner (`mw lease take`,
 * `--keep-lease`) and no run of this machine is registered (a run keeps the lease it relies on, whichever
 * of this machine's processes wrote it last). A run waiting at a stop point does not
 * hold the lease (its stop point is in the run state; whoever approves takes the lease again).
 * `mw lease show` says so, and `take` (every run, `mw work`, the committing tools) takes it over as a
 * lease of its own instead of continuing another process's.
 */
export function leaseStaleHere(project: { readonly root: string; readonly workDir: string }, lease: Lease | undefined): boolean {
  if (!lease || lease.host !== hostName() || lease.pid === process.pid || lease.kept) return false;
  if (isAlive({ pid: lease.pid, started: lease.started })) return false;
  return !otherRunsHere(project);
}

const DISABLED: SyncResult = { action: "no-hub", detail: "no hub configured (git.hub is none); nothing to sync" };

export function hubFor(project: Project): Hub {
  return openHub(project);
}

/**
 * `warn` receives what a command must tell the owner although the operation succeeded (a
 * push landed, but the lease taken for it could not be released). Default: one `mw:` line on stderr.
 */
export function openHub(project: Project, opts: { warn?: (line: string) => void } = {}): HubControl {
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`mw: ${line}\n`));
  const remote = project.config.git.hub;
  const base = project.config.git.base;
  const root = project.root;
  const leaseMs = project.config.limits.leaseMinutes * 60_000;

  if (!remote || remote === "none") {
    return {
      enabled: false,
      remote: "none",
      async prepare() { return DISABLED; },
      async sync() { return DISABLED; },
      async refresh() {},
      async release() {},
      async lease() { return undefined; },
      async fetchBranch() { return false; },
      async pushBranch() {},
      async pushBase() {},
      async deleteBranch() {},
      async observe() { return { sha: "" }; },
      takeoverInMs() { return 0; },
      async take() { return { refreshed: false }; },
      async drop() { return { released: false }; },
      staleHere() { return false; },
    };
  }

  let url: string | undefined;
  const heldKey = `${root}\0${remote}`;

  const run = (args: string[], opts: { input?: string; net?: boolean; env?: Record<string, string> } = {}): ShResult =>
    sh("git", args, {
      cwd: root,
      input: opts.input,
      // Never wait on a password or host-key prompt: a hub that needs one is reported as unreachable.
      // Only what is named here reaches git besides its minimal environment.
      env: { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10", GIT_TERMINAL_PROMPT: "0", ...opts.env },
      timeoutMs: opts.net ? NET_TIMEOUT_MS : undefined,
    });
  const lastLine = (r: ShResult) => (r.timedOut ? `no answer within ${NET_TIMEOUT_MS / 1000} s` : gitGist(r.stderr || r.stdout) || `exit ${r.code}`);
  const must = (args: string[], opts: { input?: string; env?: Record<string, string> } = {}): string => {
    const r = run(args, opts);
    if (r.code !== 0) throw new MwError("git", `git ${args.join(" ")} failed in ${root}: ${lastLine(r)}`);
    return r.stdout.trim();
  };
  const revParse = (rev: string): string => {
    const r = run(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : "";
  };
  const isAncestor = (a: string, b: string) => run(["merge-base", "--is-ancestor", a, b]).code === 0;
  const short = (sha: string) => sha.slice(0, 7);
  const subject = (sha: string) => run(["log", "-1", "--format=%s", sha]).stdout.trim();
  const count = (range: string) => Number(must(["rev-list", "--count", range]));

  const ensureRemote = (): void => {
    if (url !== undefined) return;
    const r = run(["remote", "get-url", remote]);
    if (r.code !== 0) {
      throw new MwError("hub/no-remote", `git.hub names the remote '${remote}', but the repository in ${root} has no remote of that name. Add it with 'git remote add ${remote} <url>', or set git.hub to none for a single-machine project.`);
    }
    url = r.stdout.trim();
  };
  const unreachable = (r: ShResult) =>
    new MwError("hub/unreachable", `cannot reach the hub '${remote}' (${url}): ${lastLine(r)}. Check that the machine holding it is on and reachable from here (try 'git ls-remote ${remote}'), then try again.`);

  /** The commit a ref has on the hub, "" when the hub has no such ref. */
  const lsRemote = (ref: string): string => {
    ensureRemote();
    const r = run(["ls-remote", remote, ref], { net: true });
    if (r.code !== 0) throw unreachable(r);
    for (const line of r.stdout.split("\n")) {
      const [sha, name] = line.split("\t");
      if (name === ref && sha) return sha;
    }
    return "";
  };
  const fetchBranchRef = (branch: string) => {
    const r = run(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { net: true });
    if (r.code !== 0) throw unreachable(r);
  };
  /** One ref the hub refused, from `git push --porcelain` (`reason` as git prints it, e.g. "[rejected] (stale info)"). */
  interface Refused { dst: string; reason: string }
  /**
   * Push `refspecs` (`src:dst`, src "" deletes). `leases` adds `--force-with-lease=<ref>:<sha>` for each;
   * `atomic` makes the hub apply all of them or none. Returns the refs the hub refused ([] = all landed);
   * throws when the hub could not be reached at all.
   */
  const pushRaw = (refspecs: string[], opts: { atomic?: boolean; leases?: [string, string][] } = {}): Refused[] => {
    ensureRemote();
    const args = ["push", "--porcelain"];
    if (opts.atomic) args.push("--atomic");
    for (const [ref, sha] of opts.leases ?? []) args.push(`--force-with-lease=${ref}:${sha}`);
    const r = run([...args, remote, ...refspecs], { net: true });
    if (r.code === 0) return [];
    const refused: Refused[] = [];
    for (const line of r.stdout.split("\n")) {
      const m = /^!\t([^\t]*)\t(.*)$/.exec(line);
      if (m) refused.push({ dst: m[1]!.slice(m[1]!.lastIndexOf(":") + 1), reason: m[2]! });
    }
    if (!refused.length) throw unreachable(r);
    return refused;
  };
  /**
   * Compare-and-swap of the lease ref itself: move it from `expected` ("" = must not exist) to `src`
   * ("" = delete). Returns false when the hub refused (the lease changed meanwhile).
   */
  const casLease = (src: string, expected: string): boolean =>
    pushRaw([`${src}:${LEASE_REF}`], { leases: [[LEASE_REF, expected]] }).length === 0;
  const rejectedBranch = (branch: string) =>
    new MwError("hub/push-rejected", `the hub refused '${branch}' because it has commits this machine does not have. Bring them in first (for the base branch: 'mw sync'; for a card branch: 'git fetch ${remote}' and integrate '${remote}/${branch}'), then push again.`);
  const rejectedDelete = (branch: string, why: string) =>
    new MwError("hub/delete-rejected", `the hub refused to delete '${branch}' (${why}). Check the hub's receive settings (receive.denyDeletes), or delete the branch there by hand.`);

  // ── Lease ──

  const seenFile = path.join(localDir(project), LEASE_SEEN_FILE);
  /** When this machine (by its own clock) first saw lease commit `sha` held by another host. */
  const firstSeen = (sha: string): number => {
    let rec: Partial<SeenRecord> | undefined;
    try {
      const v = JSON.parse(readIfExists(seenFile) ?? "null") as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) rec = v as Partial<SeenRecord>;
    } catch { /* unreadable: start a new observation */ }
    const t = rec?.sha === sha && typeof rec.firstSeen === "string" ? Date.parse(rec.firstSeen) : NaN;
    if (!Number.isNaN(t)) return t;
    const now = nowMs();
    try {
      writeJson(seenFile, { sha, firstSeen: new Date(now).toISOString() } satisfies SeenRecord);
    } catch { /* not recorded: the observation starts again next time, which only delays a takeover */ }
    return now;
  };

  const readLease = (): ObservedLease => {
    const sha = lsRemote(LEASE_REF);
    if (!sha) {
      run(["update-ref", "-d", SEEN_REF]);
      return { sha: "" };
    }
    if (run(["cat-file", "-e", `${sha}^{commit}`]).code === 0) must(["update-ref", SEEN_REF, sha]);
    else {
      const r = run(["fetch", "--quiet", "--no-tags", remote, `+${LEASE_REF}:${SEEN_REF}`], { net: true });
      if (r.code !== 0) {
        // The lease may have been released between the two calls.
        if (!lsRemote(LEASE_REF)) return { sha: "" };
        throw unreachable(r);
      }
    }
    // After a fetch the ref may be newer than what ls-remote saw; read sha and message from the same commit.
    const seen = revParse(SEEN_REF);
    const lease = parseLease(must(["log", "-1", "--format=%B", seen]));
    if (lease.host !== hostName()) firstSeen(seen);
    return { sha: seen, lease };
  };
  /**
   * Clock skew: another host's lease may be taken over when this machine has seen the same
   * lease commit unchanged for `lease_minutes` by its own clock, OR the lease's own timestamp is older
   * than three times `lease_minutes`. Returns how long until either holds (0 = now).
   */
  const takeoverInMs = (o: ObservedLease): number => {
    if (!o.lease || !o.sha || o.lease.host === hostName()) return 0;
    const byAge = 3 * leaseMs - leaseAgeMs(o.lease);
    const bySeen = leaseMs - (nowMs() - firstSeen(o.sha));
    return Math.max(0, Math.min(byAge, bySeen));
  };
  /** A new lease commit naming this machine (not yet on the hub). */
  const leaseCommit = (): string => {
    const started = processIdentity(process.pid).started;
    const lease: Lease = { host: hostName(), pid: process.pid, time: new Date(nowMs()).toISOString(), ...(started ? { started } : {}), ...(keptLeases.has(heldKey) ? { kept: true } : {}) };
    const tree = must(["mktree"], { input: "" });
    const ident = { GIT_AUTHOR_NAME: "MergeWright", GIT_AUTHOR_EMAIL: "mergewright@localhost", GIT_COMMITTER_NAME: "MergeWright", GIT_COMMITTER_EMAIL: "mergewright@localhost" };
    return must(["commit-tree", tree, "-m", JSON.stringify(lease)], { env: ident });
  };
  const wrote = (commit: string) => {
    must(["update-ref", SEEN_REF, commit]);
    heldLeases.set(heldKey, commit);
  };
  /** Compare-and-swap the lease from `expected` ("" = must not exist) to a new commit naming this machine. */
  const writeLease = (expected: string): boolean => {
    const commit = leaseCommit();
    if (!casLease(commit, expected)) return false;
    wrote(commit);
    return true;
  };
  const heldError = (o: ObservedLease) => {
    const lease = o.lease!;
    const wait = takeoverInMs(o);
    return new MwError("hub/lease-held", `another machine is driving this project: ${lease.host} (pid ${lease.pid}) holds the lease on hub '${remote}', taken or refreshed ${formatAge(leaseAgeMs(lease))} ago by its own clock, so this machine changed nothing on the hub. Wait for it to finish; this machine may take the lease over in ${formatAge(wait)} if it is not refreshed by then (then 'mw lease take' or the next run takes it over). If that machine has stopped working on this project, run 'mw lease take --force' here to take over now.`);
  };
  const lostError = (holder: Lease | undefined) =>
    new MwError("hub/lease-lost", `this machine (${hostName()}) no longer holds the lease on hub '${remote}': ${holder ? `${holder.host} took it ${formatAge(leaseAgeMs(holder))} ago` : "nobody holds it now (it was released or removed)"}. Stop here so two machines do not change the project at once; check with 'mw lease show', and take it back with 'mw lease take' once the other machine is done.`);

  const take = async (opts: { force?: boolean; observed?: ObservedLease; keep?: boolean } = {}) => {
    const cur = opts.observed ?? readLease();
    const mine = cur.lease?.host === hostName();
    if (cur.lease && !mine && takeoverInMs(cur) > 0 && !opts.force) throw heldError(cur);
    // This host's lease left by a process that is gone is taken over, not "refreshed":
    // the taker then owns it (and releases it when it took it only for one change).
    const stale = mine && leaseStaleHere(project, cur.lease);
    // An owner's hold (`kept`) stays one when this host continues it.
    if (opts.keep || (mine && cur.lease?.kept === true)) keptLeases.add(heldKey);
    else keptLeases.delete(heldKey);
    if (!writeLease(cur.sha)) {
      throw new MwError("hub/lease-race", `the lease on hub '${remote}' changed while this machine (${hostName()}) was taking it: another machine got there first, so this one does not hold it. Run 'mw lease show' to see who holds it now.`);
    }
    if (stale) warn(`took over this machine's stale lease on hub '${remote}' (process ${cur.lease!.pid} that took it is gone)`);
    return { previous: cur.lease, refreshed: mine && !stale, ...(stale ? { staleHere: true } : {}) };
  };
  const drop = async (): Promise<{ released: boolean; holder?: Lease }> => {
    const cur = readLease();
    if (!cur.lease) return { released: false };
    if (cur.lease.host !== hostName()) return { released: false, holder: cur.lease };
    if (!casLease("", cur.sha)) return { released: false, holder: readLease().lease };
    run(["update-ref", "-d", SEEN_REF]);
    heldLeases.delete(heldKey);
    keptLeases.delete(heldKey);
    return { released: true };
  };
  /**
   * Delete this host's lease, failing when that did not happen although this host holds it (the hub
   * refused the deletion). Nobody holding it, or another host holding it, is not a failure here.
   */
  const dropOrThrow = async (): Promise<void> => {
    const r = await drop();
    if (!r.released && r.holder?.host === hostName()) {
      throw new MwError("hub/release-refused", `the hub '${remote}' refused to delete the lease ref ${LEASE_REF} (check its receive settings, such as receive.denyDeletes)`);
    }
  };

  /**
   * The lease as it is now, failing with `hub/lease-lost` unless this host holds it. Cheap when nothing
   * changed: one ls-remote, and the message is read only when the ref moved since this process wrote it.
   */
  const ownLease = (): ObservedLease => {
    const sha = lsRemote(LEASE_REF);
    if (sha && sha === heldLeases.get(heldKey)) return { sha };
    const cur = sha ? readLease() : { sha: "" };
    // The entry stays after a loss, so every later push from this process keeps being refused.
    if (!cur.lease || cur.lease.host !== hostName()) throw lostError(cur.lease);
    return cur;
  };

  /**
   * Fencing: one `git push --atomic` that moves the lease from the commit this process
   * last wrote to a fresh one AND applies `refspec`, guarded by --force-with-lease on the lease ref.
   * If another host took the lease, the hub applies nothing. A lease moved by another `mw` process on
   * this host is still ours: the push is repeated against that commit. Returns the hub's refusal of
   * `refspec` itself (not a fast-forward, say), or undefined when everything landed.
   */
  const fencedPush = (refspec: string): Refused | undefined => {
    let expected = heldLeases.get(heldKey) ?? "";
    let last: Refused[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const commit = leaseCommit();
      const refused = pushRaw([`${commit}:${LEASE_REF}`, refspec], { atomic: true, leases: [[LEASE_REF, expected]] });
      if (!refused.length) {
        wrote(commit);
        return undefined;
      }
      last = refused;
      // "atomic push failed" (git, before sending) and "atomic transaction failed" (the hub, when a ref
      // changed while the push was received) only say that something else was refused.
      const real = refused.filter((x) => !/atomic (push|transaction) failed/.test(x.reason));
      const cause = real.find((x) => x.dst === LEASE_REF) ?? real[0];
      if (cause && cause.dst !== LEASE_REF) return cause;
      const cur = readLease();
      if (!cur.lease || cur.lease.host !== hostName()) throw lostError(cur.lease);
      expected = cur.sha;
    }
    const cur = readLease();
    if (!cur.lease || cur.lease.host !== hostName()) throw lostError(cur.lease);
    throw new MwError("hub/push-refused", `the hub '${remote}' refused to apply '${refspec.slice(refspec.indexOf(":") + 1)}' three times (${last.map((x) => `${x.dst}: ${x.reason}`).join("; ")}), so nothing was changed there. Check the hub's receive settings and hooks, then try again.`);
  };
  /**
   * Every change to a branch on the hub, from any process: a fenced push. A process
   * that does not hold the lease (a plain `mw sync`, `mw abort`) first takes it by compare-and-swap
   * (refused, naming the holder, while another host holds one it may not take over yet), pushes
   * fenced by it, and then releases it, unless this host held it before (another `mw` process here
   * is driving the project: it keeps the lease) or a run of this machine
   * registered meanwhile, checked under the registry's guard. A release that fails is reported through
   * `warn`; the push itself landed. Returns the hub's refusal, or undefined when it landed.
   */
  const pushBranchRef = async (src: string, branch: string): Promise<Refused | undefined> => {
    const refspec = `${src}:refs/heads/${branch}`;
    if (heldLeases.has(heldKey)) return fencedPush(refspec);
    const { refreshed } = await take();
    let refused: Refused | undefined;
    try {
      await hubTestHooks.beforeUnheldPush?.();
      refused = fencedPush(refspec);
    } finally {
      if (!refreshed) {
        try {
          await releaseUnlessBusy(project, dropOrThrow);
        } catch (err) {
          const what = refused ? "nothing was pushed" : "the push landed";
          warn(`${what}, but the lease taken for it could not be released: ${(err as Error).message}; it expires by itself, or run 'mw lease release'.`);
        }
      }
    }
    return refused;
  };
  const pushOrThrow = async (branch: string) => {
    if (await pushBranchRef(`refs/heads/${branch}`, branch)) throw rejectedBranch(branch);
  };

  // ── Sync ──

  const stagedError = () =>
    new MwError("hub/staged", `the index of the checkout in ${root} holds staged changes, so the hub's history was not adopted (adopting would replace the index). Commit or unstage first ('git commit', or 'git restore --staged .'), then run 'mw sync' again.`);
  /**
   * Adopt is a compare-and-swap. The branch moves only from the HEAD read here, with `git update-ref <ref> <hub> <observed>`; then only the index is reset.
   */
  const adopt = async (local: string, hub: string): Promise<SyncResult> => {
    const hasStaged = () => run(["diff", "--cached", "--quiet"]).code !== 0;
    if (hasStaged()) throw stagedError();
    const n = count(local ? `${local}..${hub}` : hub);
    const moved = (now: string) =>
      new MwError("hub/head-moved", `'${base}' moved on this machine (now ${now ? `${short(now)}: ${subject(now)}` : "unborn"}) while 'mw sync' was adopting the hub's ${short(hub)}, so nothing was changed and no commit was lost. Run 'mw sync' again.`);
    const observed = revParse("HEAD");
    if (observed !== local) {
      if (observed === hub) return { action: "none", detail: `'${base}' is level with the hub (${short(hub)})` };
      if (observed && !isAncestor(observed, hub)) throw moved(observed);
    }
    if (hasStaged()) throw stagedError();
    await hubTestHooks.beforeAdoptUpdate?.();
    const r = run(["update-ref", "-m", "mw sync: adopt the hub's history", `refs/heads/${base}`, hub, observed || ZERO]);
    if (r.code !== 0) throw moved(revParse("HEAD"));
    // The index only: working files stay as the file-sync tool (or the owner) left them.
    must(["read-tree", hub]);
    run(["update-index", "-q", "--refresh"]);
    return { action: "adopted", detail: `adopted ${n} commit(s) from the hub; '${base}' is now at ${short(hub)}` };
  };

  /** `offline` (only `mw sync --offline`) contacts nothing and changes nothing. */
  const sync = async (opts: { offline?: boolean } = {}): Promise<SyncResult> => {
    if (opts.offline) return { action: "none", detail: `offline: did not contact the hub '${remote}'; '${base}' left as it is` };
    ensureRemote();
    const branch = run(["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
    if (branch !== base) {
      throw new MwError("hub/not-on-base", `the checkout in ${root} is on ${branch ? `branch '${branch}'` : "a detached HEAD"}, but sync works on the base branch '${base}'. Check out '${base}' there, then run 'mw sync' again.`);
    }
    const local = revParse("HEAD");
    const hub = lsRemote(`refs/heads/${base}`);
    if (!hub) {
      if (!local) return { action: "none", detail: `neither this checkout nor the hub has commits on '${base}' yet` };
      await pushOrThrow(base);
      return { action: "pushed", detail: `the hub had no '${base}'; pushed it (${short(local)})` };
    }
    if (local === hub) return { action: "none", detail: `'${base}' is level with the hub (${short(local)})` };
    fetchBranchRef(base);
    if (!local || isAncestor(local, hub)) return adopt(local, hub);
    if (isAncestor(hub, local)) {
      const n = count(`${hub}..${local}`);
      await pushOrThrow(base);
      return { action: "pushed", detail: `pushed ${n} commit(s) of '${base}' to the hub (now at ${short(local)})` };
    }
    throw new MwError("hub/diverged", `'${base}' has diverged from the hub: this checkout is at ${short(local)} (${subject(local)}) and the hub at ${short(hub)} (${subject(hub)}), and neither contains the other. Nothing was changed. Combine them by hand (for example 'git rebase ${remote}/${base}' or 'git merge ${remote}/${base}'), then run 'mw sync' again, which pushes the result.`);
  };

  /** The worktree that has `branch` checked out, if any. */
  const worktreeOf = (branch: string): string | undefined => {
    let cur: string | undefined;
    for (const line of must(["worktree", "list", "--porcelain"]).split("\n")) {
      if (line.startsWith("worktree ")) cur = line.slice(9);
      else if (line === `branch refs/heads/${branch}`) return cur;
    }
    return undefined;
  };

  return {
    enabled: true,
    remote,
    async prepare(opts = {}) {
      // A project with a hub never works offline: the other machine could be running the same card.
      if (opts.offline) throw offlineRefused(remote);
      await take();
      return sync();
    },
    sync,
    async refresh() {
      const cur = ownLease();
      if (!writeLease(cur.sha)) throw lostError(readLease().lease);
    },
    async release() {
      await dropOrThrow();
    },
    async lease() {
      return readLease().lease;
    },
    async fetchBranch(branch) {
      const hub = lsRemote(`refs/heads/${branch}`);
      if (!hub) return false;
      fetchBranchRef(branch);
      const local = revParse(`refs/heads/${branch}`);
      if (local === hub) return true;
      if (local && !isAncestor(local, hub)) {
        // Local commits the hub lacks are never discarded. Strictly ahead: keep them (they get pushed later).
        if (isAncestor(hub, local)) return true;
        throw new MwError("hub/branch-diverged", `the local branch '${branch}' (${short(local)}) and the hub's (${short(hub)}) each have commits the other lacks, so the local branch was left as it is. Compare them with 'git log ${branch}...${remote}/${branch}', combine the work you want to keep, push it with 'git push ${remote} ${branch}', then try again.`);
      }
      const wt = worktreeOf(branch);
      if (wt) {
        const r = sh("git", ["merge", "--ff-only", "--quiet", hub], { cwd: wt });
        if (r.code !== 0) {
          throw new MwError("hub/branch-busy", `could not bring '${branch}' up to the hub's ${short(hub)} in its worktree ${wt}: ${lastLine(r)}. Commit or set aside the changes there, then try again.`);
        }
      } else must(["update-ref", `refs/heads/${branch}`, hub, local || ZERO]);
      return true;
    },
    async pushBranch(branch) {
      await pushOrThrow(branch);
    },
    async pushBase() {
      await pushOrThrow(base);
    },
    async deleteBranch(branch) {
      // Deleting a branch the hub does not have succeeds (git only warns), which is what we want.
      const refused = await pushBranchRef("", branch);
      if (refused) throw rejectedDelete(branch, refused.reason);
      run(["update-ref", "-d", `refs/remotes/${remote}/${branch}`]);
    },
    observe: async () => readLease(),
    staleHere: (lease) => leaseStaleHere(project, lease),
    takeoverInMs,
    take,
    drop,
  };
}

/**
 * Who holds the lease and how long until this machine may take it over (0 = now, or nobody / this
 * host holds it), by the decision-7 rule. For callers that only have a Project, such as `mw work`.
 */
export async function leaseStatus(project: Project): Promise<{ lease?: Lease; takeoverInMs: number }> {
  const h = openHub(project);
  const o = await h.observe();
  return { lease: o.lease, takeoverInMs: h.takeoverInMs(o) };
}
