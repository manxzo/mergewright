// Commands for the integrations layer: `mw queue [list|flush|adopt]` and `mw integrations` (alias
// `mw doctor`).
import fs from "node:fs";
import path from "node:path";
import type { Handler, Out } from "./cli.ts";
import { flushQueue, integrationSettings, legacyQueueDir, legacyQueueItems, queueFor } from "./integrations.ts";
import { errMessage, onPath, redactUrl, splitCommand } from "./integrations/common.ts";
import { probeForge } from "./integrations/forge.ts";
import { loadPackages, runChecks } from "./packages/loader.ts";
import { fetchLocalModels } from "./tui/catalog.ts";
import { age, progressOf, type FlushResult } from "./integrations/queue.ts";
import { pausedFlag, readUsage } from "./integrations/usage.ts";
import { claudeSandbox, sandboxPolicy } from "./engine/harness/claude.ts";
import { mergingHere } from "./engine/state.ts";
import { Project } from "./project.ts";
import { gitIdentity, IDENTITY_FIX } from "./mcpserver/repo.ts";
import { git, MwError, readIfExists, sh, sshAuthSock, toPosix } from "./util.ts";

/** The file-synced folder holding `start` (a sync tool's folder marker `.stfolder`): the nearest directory, `start` itself or above, with one. */
export function syncedFolder(start: string): string | undefined {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, ".stfolder"))) return d;
    const up = path.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

/** The patterns of an `.stignore`, following `#include` lines (relative to the including file). */
function stignorePatterns(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const out: string[] = [];
  for (const raw of (readIfExists(file) ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const inc = /^#include\s+(.+)$/.exec(line);
    if (inc) out.push(...stignorePatterns(path.resolve(path.dirname(file), inc[1]!.trim()), seen));
    else out.push(line);
  }
  return out;
}

/**
 * Paths that belong to one machine and must never be file-synced: git metadata, card worktrees, and
 * `.mergewright/local` (run locks, the lease observation, the queue, temporary files, the usage flag,
 * discarded worktrees). `.mergewright/runs/` is the only shared part of `.mergewright/`.
 */
export const SYNC_EXCLUSIONS = [".git", ".mergewright/worktrees", ".mergewright/local"];

/**
 * The lines a synced project with a hub needs in its synced folder's `.stignore`, and those
 * missing. A line also counts with the sync tool's (?d) or (?i) prefix, with a leading double-star
 * directory, or as a path rooted at the folder that leads to this project.
 */
export function missingSyncExclusions(folder: string, projectRoot: string): string[] {
  const rel = toPosix(path.relative(folder, projectRoot));
  const have = new Set(stignorePatterns(path.join(folder, ".stignore")).filter((l) => !l.startsWith("!")).map((l) => l.replace(/^(\(\?[di]\))+/, "").replace(/^\*\*\//, "")));
  return SYNC_EXCLUSIONS.filter((want) => !have.has(want) && !have.has(`/${rel ? `${rel}/` : ""}${want}`));
}

/** " (5 delivered, 1 already present)" for a delivered item of records; " (3 of 5 delivered, 2 remaining)" for one kept part-way. */
function flushCounts(r: FlushResult): string {
  const c = r.counts;
  if (!c) return "";
  const present = c.present ? `, ${c.present} already present` : "";
  if (r.ok) return ` (${c.delivered} delivered${present})`;
  return ` (${c.delivered} of ${c.total} delivered${present}, ${c.total - c.delivered - c.present} remaining)`;
}

/** How often `mw queue flush` looks again while a run of this machine is inside its merge phase. Mutable for tests only. */
export const mergeWait = { pollMs: 2_000 };

/**
 * REQ-engine-012: wait until no run of this machine is inside its merge phase (`mergingHere`), saying
 * once which card it waits for. The lease is never asked: a lease this machine keeps does not delay a
 * flush. Returns at once when no run is merging.
 */
async function waitForMerges(project: Project, out: Out): Promise<void> {
  let said = "";
  for (;;) {
    const merging = mergingHere(project);
    if (!merging.length) return;
    const now = merging.join(", ");
    if (now !== said) out(`waiting for ${now} to leave ${merging.length > 1 ? "their" : "its"} merge phase on this machine before the queue is flushed`);
    said = now;
    await new Promise((r) => setTimeout(r, mergeWait.pollMs));
  }
}

const queue: Handler = async (a, out) => {
  const sub = a._[1] ?? "list";
  const project = sub === "list" ? Project.load() : Project.loadRunnable();
  if (sub === "list") {
    const items = queueFor(project).list();
    if (!items.length) { out("the queue is empty"); return 0; }
    const w = Math.max(...items.map((i) => i.item.kind.length));
    for (const { item } of items) {
      out(`${item.kind.padEnd(w)}  ${age(item.created).padStart(4)}  ${item.summary}${item.attempts ? `  (${item.attempts} retr${item.attempts > 1 ? "ies" : "y"}; last: ${item.lastError ?? "?"})` : item.lastError ? `  (${item.lastError})` : ""}`);
    }
    out(`${items.length} item(s) queued; 'mw queue flush' retries them`);
    return 0;
  }
  if (sub === "adopt") {
    // The owner moves the old shared queue in, on ONE machine.
    const n = queueFor(project).adopt(legacyQueueDir(project));
    const left = legacyQueueItems(project).length;
    out(n ? `moved ${n} item(s) from ${project.rel(legacyQueueDir(project))}/ into this machine's queue; 'mw queue flush' delivers them. Do not run 'mw queue adopt' on the other machine: the file sync removes the moved items there.` : `nothing to adopt: ${project.rel(legacyQueueDir(project))}/ holds no queued items`);
    if (left) out(`${left} item(s) could not be moved (the same name is already queued here); compare them with 'mw queue' and remove the duplicates by hand`);
    return left ? 1 : 0;
  }
  if (sub === "flush") {
    // The owner asked for every item now: no time budget, and kinds whose breaker is open are tried too.
    // Only a run of this machine inside its merge phase delays it (REQ-engine-012), never the lease.
    await waitForMerges(project, out);
    const results = await flushQueue(project, { budgetMs: Infinity, breaker: false });
    if (!results.length) { out("the queue is empty"); return 0; }
    for (const r of results) out(`${r.ok ? "delivered" : r.dropped ? "dropped  " : "kept     "}  ${r.kind}  ${r.summary}${flushCounts(r)}${r.ok ? "" : `: ${r.error}`}`);
    const kept = results.filter((r) => !r.ok && !r.dropped).length;
    const dropped = results.filter((r) => r.dropped).length;
    const counted = results.filter((r) => r.counts);
    const recs = counted.length
      ? `; records: ${counted.reduce((n, r) => n + r.counts!.delivered, 0)} delivered${counted.some((r) => r.counts!.present) ? `, ${counted.reduce((n, r) => n + r.counts!.present, 0)} already present` : ""}`
      : "";
    out(`${results.length - kept - dropped} delivered, ${dropped ? `${dropped} dropped, ` : ""}${kept} still queued${recs}`);
    // Exit 1 only when items remain and nothing at all could be delivered in this run.
    return kept && !results.some((r) => progressOf(r) > 0) ? 1 : 0;
  }
  throw new MwError("usage", "use 'mw queue', 'mw queue flush' or 'mw queue adopt'");
};

/** `mw cards mirror` moved to the package of the board it mirrored to. */
const cards: Handler = () => {
  throw new MwError("usage", "'mw cards mirror' is a command of the board's package now; see 'mw packages' for the enabled ones and run 'mw <package> mirror'");
};

/** The shared unit file `scripts/install-service.sh` writes for `mw work` services. Mutable for tests only. */
export const workUnitFile = { path: "/etc/systemd/system/mw-work@.service" };

/**
 * Whether `mw-work@<folder name>` runs this project, when the shared unit file exists and systemctl
 * is on PATH: `systemctl is-active` for the project folder's name. Undefined otherwise (silently).
 */
export function workUnits(root: string): { state: string; detail: string } | undefined {
  if (!fs.existsSync(workUnitFile.path) || !onPath("systemctl")) return undefined;
  const name = path.basename(path.resolve(root));
  const unit = `mw-work@${name}`;
  try {
    const r = sh("systemctl", ["is-active", unit]);
    const state = (r.stdout || "unknown").trim().split("\n")[0] || "unknown";
    return { state: `${unit} ${state}`, detail: state === "active" ? "this project is worked by that unit ('journalctl -u " + unit + "' for its log)" : `no running unit for this project (${workUnitFile.path} exists; start it with 'sudo systemctl enable --now ${unit}')` };
  } catch {
    return undefined;
  }
}

/**
 * The SSH agent git would use (`sshAuthSock`) and how many keys it holds (`ssh-add -l`,
 * counted, never printed). "none found" when there is no agent socket.
 */
export function sshAgentLine(): string {
  const sock = sshAuthSock();
  if (!sock) return "none found (SSH_AUTH_SOCK is unset and no agent socket is in the runtime directory): a hub reached over SSH needs one";
  const via = sock.from === "SSH_AUTH_SOCK" ? "from SSH_AUTH_SOCK" : "found in the runtime directory";
  if (!onPath("ssh-add")) return `${sock.path} (${via}; ssh-add is not on PATH, so its keys were not counted)`;
  const r = sh("ssh-add", ["-l"], { env: { ...process.env, SSH_AUTH_SOCK: sock.path }, timeoutMs: 3000 });
  if (r.code === 0) {
    const n = r.stdout.split("\n").filter((l) => l.trim()).length;
    return `${sock.path} (${n} key${n === 1 ? "" : "s"}; ${via})`;
  }
  if (r.code === 1) return `${sock.path} (0 keys: the agent holds no identity, add one with 'ssh-add'; ${via})`;
  return `${sock.path} (NOT reachable: no agent answers on it; ${via})`;
}

/** `name  configured/not  reachable/not  detail`. Never prints a secret: only variable names and whether they are set. */
export async function doctor(out: Out, project: Project = Project.load()): Promise<number> {
  const s = integrationSettings(project);
  const line = (name: string, state: string, detail = "") => out(`${name.padEnd(8)} ${state}${detail ? `  ${detail}` : ""}`);
  const isSet = (env: string) => (process.env[env] ? `${env} set` : `${env} NOT set`);
  const probe = async (f: () => Promise<string>): Promise<string> => {
    try {
      return `reachable${await f()}`;
    } catch (e) {
      return `NOT reachable (${errMessage(e)})`;
    }
  };

  if (!s.notify) line("notify", "not configured", "(report.command)");
  else {
    let cmd = "";
    try { cmd = splitCommand(s.notify)[0] ?? ""; } catch { cmd = ""; }
    line("notify", "configured", onPath(cmd) ? `command '${cmd}' found` : `command '${cmd}' NOT found on PATH`);
  }

  // The local models endpoint (roles with runs: local): GET <endpoint>/models with the key.
  const lm = project.config.localModels;
  if (!lm?.endpoint) line("local", "not configured", "(local_models.endpoint)");
  else {
    const live = await fetchLocalModels(lm.endpoint, lm.keyEnv ? process.env[lm.keyEnv] : undefined, 10_000);
    const served = live.models ? (live.models.length ? `serving ${live.models.join(", ")}` : "serving no model") : "";
    line("local", live.models ? `configured, reachable, ${served}` : `configured, NOT reachable (${live.error})`,
      `${redactUrl(lm.endpoint)}${lm.fallback ? `, fallback ${redactUrl(lm.fallback)}` : ""}${lm.keyEnv ? `, ${isSet(lm.keyEnv)}` : ", no key (local_models.key_env)"}`);
  }

  if (!s.usage.command) line("usage", "not configured", "(usage.command)");
  else {
    const r = readUsage(s.usage.command, s.usage.cwd);
    const paused = fs.existsSync(pausedFlag(s.usage.localDir));
    line("usage", `configured, ${r.pct === undefined ? `guard cannot run (${r.problem})` : `reading ${Math.round(r.pct * 10) / 10}%`}`, `pause at ${s.usage.pauseAtPct}%, resume below ${s.usage.resumeBelowPct}%${paused ? ", currently PAUSED" : ""}`);
  }

  if (!s.forge) line("forge", "not configured", "(git.forge.kind none: merges are local)");
  else {
    const f = s.forge;
    const tokenEnv = f.tokenEnv ?? (f.kind === "github" ? "GITHUB_TOKEN" : "GITEA_TOKEN");
    line("forge", `configured, ${await probe(async () => { await probeForge(f); return ""; })}`, `${f.kind} ${f.repo ?? "(no repo)"}, ${isSet(tokenEnv)}; experimental: not verified against a live forge`);
  }

  // Packages: each enabled one that did not load, then the checks the loaded ones provide.
  for (const l of await loadPackages(project)) {
    if (l.error) { line(l.name, "package NOT loaded", l.error); continue; }
    for (const r of await runChecks(l.exports)) line(r.name, r.ok ? "ok" : "NOT ok", `${r.detail} (package ${l.name})`);
  }

  let problems = 0;
  // REQ-config-002: a config that fails its schema is reported, not refused; every setting below is then its default.
  const configErrors = project.configErrors();
  if (configErrors.length) {
    problems++;
    line("config", "PROBLEM", `mergewright.yaml is invalid, so the settings shown here are the defaults and runs and writing commands refuse (config/invalid) until it is fixed: ${configErrors.join("; ")}`);
  }
  // The sandbox policy for write-mode Claude agents (spec 8.6) and what the probe says on this machine.
  try {
    const { policy, source } = sandboxPolicy(project.config.agents.sandbox);
    const from = source === "MW_SANDBOX" ? "from MW_SANDBOX" : source === "agents.sandbox" ? "from agents.sandbox" : "the default";
    const p = claudeSandbox();
    const probeText = p.ok ? "the sandbox works on this machine" : `the sandbox does not work on this machine: ${p.why}`;
    const effect = policy === "off" ? "write-mode Claude agents run unconfined, with no warning (runs never probe)"
      : policy === "required" ? (p.ok ? "write-mode Claude agents run in it" : "write phases on claude or shell are refused (run/sandbox-required)")
      : p.ok ? "write-mode Claude agents run in it" : "write-mode Claude agents run unconfined, with one warning per run";
    line("sandbox", `${policy} (${from})`, `${probeText}; ${effect}`);
  } catch (e) {
    problems++;
    line("sandbox", "PROBLEM", errMessage(e));
  }
  // The git setup the runtime and the committing MCP tools need (spec section 11): an identity to
  // commit with, the base branch, and the hub's remote when git.hub names one.
  const hub = project.config.git.hub;
  if (!onPath("git")) line("git", "NOT found on PATH", "runs and the committing MCP tools need it");
  else {
    const id = gitIdentity(project.root);
    const base = project.config.git.base;
    const branch = git(project.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true }).stdout.trim();
    const hasBase = git(project.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`], { allowFail: true }).code === 0;
    const baseText = branch === base ? `on the base branch '${base}'` : `on '${branch || "a detached HEAD"}', base branch '${base}'${hasBase ? "" : " does not exist yet"}`;
    // A missing hub remote is reported here; the commands that need it refuse with hub/no-remote.
    const hubText = !hub || hub === "none" ? "no hub (git.hub is none)"
      : git(project.root, ["remote", "get-url", hub], { allowFail: true }).code === 0 ? `hub remote '${hub}' present` : `hub remote '${hub}' MISSING (git remote add ${hub} <url>)`;
    // No identity: every commit fails, so it counts as a problem (exit 1).
    if (!id.ok) problems++;
    line("git", id.ok ? "identity set" : "PROBLEM, identity NOT set",
      `${id.ok ? "" : `${id.why}; commits (and every committing MCP tool) fail until it is set: ${IDENTITY_FIX}; `}${baseText}; ${hubText}`);
  }
  line("ssh", `agent: ${sshAgentLine()}`);
  // Which systemd units run this project (best effort; nothing when systemd or the unit is absent).
  const units = workUnits(project.root);
  if (units) line("systemd", units.state, units.detail);

  const folder = syncedFolder(project.root);
  if (!folder) line("sync", "not inside a synced folder");
  else if (!hub || hub === "none") line("sync", "inside a synced folder", `${folder}; no hub configured (git.hub is none), so the exclusions are not needed`);
  else {
    const missing = missingSyncExclusions(folder, project.root);
    const file = path.join(folder, ".stignore");
    if (!missing.length) line("sync", "exclusions in place", `${file} excludes ${SYNC_EXCLUSIONS.join(", ")}`);
    else {
      problems++;
      line("sync", "PROBLEM", `${file} is missing ${missing.map((m) => `the line '${m}'`).join(" and ")}. Add ${missing.length > 1 ? "them" : "it"} to that file on both machines; until then the file sync copies per-machine files (${missing.join(", ")}) between the machines.`);
    }
  }

  const n = queueFor(project).list().length;
  line("queue", n ? `${n} item(s) waiting` : "empty", n ? "('mw queue' to see them)" : "");
  const legacy = legacyQueueItems(project).length;
  if (legacy) {
    line("queue", `${legacy} item(s) left by an older runtime in ${project.rel(legacyQueueDir(project))}/`, "they are not delivered from there. Run 'mw queue adopt' on ONE of the two machines to move them into its queue; the file sync then removes them on the other.");
  }
  return problems ? 1 : 0;
}

const integrations: Handler = (_a, out) => doctor(out);

export const commands: Record<string, Handler> = {
  queue,
  cards,
  integrations,
  doctor: integrations,
};
