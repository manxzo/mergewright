// The flow engine: runs a card through its flow, one phase at a time, saving state after each.
// See docs/design/engine.md sections 2 (the loop), 4 (executing a phase) and 9 (commands).
import fs from "node:fs";
import path from "node:path";
import { assertCardReady } from "../cards.ts";
import { evalExpr, RISK_LEVELS, type Risk } from "../expr.ts";
import { hostName, hubFor, offlineRefused, openHub } from "../hub.ts";
import { integrationsFor } from "../integrations.ts";
import { usageGuard } from "../integrations/usage.ts";
import { mcpsForRole, wireMcps, type McpWiring } from "../mcpconfig.ts";
import type { Reflection } from "../memory.ts";
import type { Flow, Outcome, Phase, StopPoint } from "../model/flow.ts";
import type { Card } from "../model/card.ts";
import { renderPrompt, type Role } from "../model/role.ts";
import { localDir, Project } from "../project.ts";
import { loadSchema, validate, type SchemaName } from "../schemas.ts";
import { parseFrontmatter, setFrontmatter } from "../frontmatter.ts";
import { estimateTokens, git, MwError } from "../util.ts";
import { assertLease, branchViolations, docsSync, LeaseLost, memoryUpdate, merge, notifyAction, pendingMergeProblem, PhaseBlocked, pushing, safely, type ActionResult, type Engine, type Evidence } from "./actions.ts";
import { approvalConditions, asExprVars, computeVars, memoryAppendix, promptValues, type Adjudication, type Brief, type Findings, type Handoff, type RunContext } from "./context.ts";
import { adjudicationErrors, findingFor } from "./adjudication.ts";
import { runDrive } from "./driver.ts";
import { extractJson } from "./extract.ts";
import { gateEnv, REQUIRED_MISSING, REQUIRED_SKIPPED, runGate, type GateJson, type GateRun } from "./gate.ts";
import { branchHead, cardWorktreePath, forkPoint, head, cleanDiscarded, commitAll, deleteBranch, dirtyFiles, discardRunDir, ensureWorktree, isAncestor, removeWorktree, requireOnBase, verifiedWorktree, worktrees } from "./gitops.ts";
import { sandboxDecision, sandboxPolicy, type SandboxPolicy } from "./harness/claude.ts";
import { harnessFor } from "./harness/index.ts";
import { activeQuota, recordQuota } from "./quota.ts";
import { takeSurvivors } from "./harness/proc.ts";
import { assertNoOrphans, liveOrphans, settleSurvivors } from "./orphans.ts";
import { writePrivate } from "./private.ts";
import { redactResult, secretsFor } from "./redact.ts";
import { acquireLock, ARTIFACT_KINDS, artifactStore, branchName, loadState, lockFile, lockHolder, newState, privateRunDir, rewritePlainCopies, runDir, saveExchange, saveState, verifyArtifacts } from "./state.ts";
import type { ArtifactKind } from "./state.ts";
import { locksDir, releaseUnlessBusy, withGuardSync } from "./registry.ts";
import type { Harness, HarnessRequest, HistoryEntry, Hub, Integrations, MergeCondition, RunOptions, RunState, RunStatus, Usage } from "./types.ts";

export interface EngineDeps {
  hub?: Hub;
  integrations?: Integrations;
  /**
   * Fires when the owner stops the run at once (a stop signal to `mw run`, a second one to `mw work`):
   * the active phase is aborted through the same signal as a lost lease, its agent's or gate's process
   * group is gone when the phase returns, and the run ends with `Stopped`, saving nothing of the phase.
   */
  stop?: AbortSignal;
}

/** The owner stopped the run at once; the phase that was running was abandoned. */
export class Stopped extends MwError {
  constructor(message: string) {
    super("run/stopped", message);
  }
}

interface PhaseResult {
  outcome: Outcome;
  detail: string;
  roles: string[];
  usage?: Usage;
  /** `usage` per harness (role.runs). */
  usageBy?: Record<string, Usage>;
  /** Set when the run must pause before a role on a paid harness (usage window); `roles` are those that ran before it. */
  pause?: string;
  /** The harness and the model of each role that ran, by role id. */
  harness?: Record<string, string>;
  model?: Record<string, string>;
  /** REQ-gate-004: a failure that goes to the flow's remediation phase whatever `on` says. */
  remediate?: boolean;
}

/**
 * The model a role runs with, as the run records it: `[<provider>/]<model>`, a `local`
 * role's profile (or model), and `default` when the role names none (the harness then picks its own).
 */
export function effectiveModel(role: Pick<Role, "runs" | "model" | "provider" | "profile">): string {
  const model = role.runs === "local" ? (role.profile ?? role.model) : role.model;
  return [role.provider, model ?? "default"].filter(Boolean).join("/");
}

export interface RoleRun {
  ok: boolean;
  /** The validated artifact for structured outputs. */
  value?: unknown;
  text: string;
  error?: string;
  usage?: Usage;
  /**
   * REQ-harness-003: every model tried failed transiently; `error` starts with `harness/transient` and
   * names each model and the last error.
   */
  transient?: boolean;
  /** The harness reported a quota or session limit (never retried); `resetAt` when it stated one. */
  quota?: { resetAt?: string };
  /** The usage guard refused a further attempt (its detail); the run pauses for usage. */
  usagePause?: string;
  /** The model that answered (or the last one tried), as `effectiveModel` writes it. */
  model?: string;
  /** REQ-harness-002: how many transient retries the role took on its own model. */
  retries?: number;
  /** REQ-harness-003: the answer came from the role's `fallback_model`. */
  fallback?: boolean;
  /** No attempt started: a recorded quota limit, the usage guard or a stop refused the first one. */
  notStarted?: boolean;
}

/** The block code of a role that failed transiently on its model and its alternate (REQ-harness-003). */
export const HARNESS_TRANSIENT = "harness/transient";

/**
 * REQ-harness-002: the wait before transient retry `n` (0-based): 5 s, 15 s, 45 s, ... The base is
 * `MW_TRANSIENT_BACKOFF_MS` when set (tests use a few milliseconds), else 5000.
 */
export function transientDelayMs(n: number): number {
  const env = Number(process.env.MW_TRANSIENT_BACKOFF_MS);
  const base = Number.isFinite(env) && env >= 0 && process.env.MW_TRANSIENT_BACKOFF_MS?.trim() ? env : 5000;
  return base * 3 ** n;
}

/** Wait `ms`, or less: the wait ends at once when `signal` fires, and its timer is cleared. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

const USAGE_FIELDS = ["inputTokens", "outputTokens", "costUsd", "freshInputTokens", "cacheWriteTokens", "cacheReadTokens", "turns"] as const satisfies readonly (keyof Usage)[];

function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!b) return a;
  if (!a) return { ...b };
  // Each field is summed over the entries that carry it and stays absent when none does, so a
  // harness that reports only totals never gains a split of zeros.
  const out: Usage = {};
  for (const k of USAGE_FIELDS) {
    const x = a[k], y = b[k];
    if (x !== undefined || y !== undefined) out[k] = (x ?? 0) + (y ?? 0);
  }
  return out;
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/**
 * Where agents and gates work: the card's worktree for a worktree flow (never the main checkout in its
 * place, even when the worktree has gone missing), else the project root.
 */
function cwdOf(e: Engine): string {
  return e.flow.worktree ? cardWorktreePath(e.project, e.card.id) : e.project.root;
}

/**
 * Where a role that cannot change files runs: the card's worktree while it exists, and the main
 * checkout once the card is merged and its worktree is gone (the reflect phase runs then).
 * Write-mode roles never use this: they run in the verified worktree or not at all.
 */
function readCwd(e: Engine): string {
  const wt = cwdOf(e);
  return e.flow.worktree && !fs.existsSync(wt) ? e.project.root : wt;
}

function contextOf(e: Engine, diffBase?: string): RunContext {
  return { project: e.project, card: e.card, state: e.state, runDir: e.runDir, cwd: readCwd(e), base: e.base, branch: e.flow.worktree ? e.branch : e.base, diffBase: diffBase ?? e.base, artifacts: e.artifacts };
}

function flowOf(project: Project, id: string): Flow {
  const flow = project.flows().get(id);
  if (!flow) throw new MwError("run/no-flow", `there is no flow '${id}' (see 'mw flows'); fix the card's 'flow' field or add flows/${id}.flow.yaml`);
  return flow;
}

function save(e: Engine): void {
  saveState(e.runDir, e.state);
}

async function setStatus(e: Engine, status: RunStatus, reason?: string): Promise<void> {
  e.state.status = status;
  e.state.reason = reason;
  if (e.mirrored !== status) {
    e.mirrored = status;
    await safely(e, "mirrorCard", async () => {
      const note = await e.integrations.mirrorCard(e.card.id, e.card.title, status);
      if (note && !e.state.warnings.includes(note)) e.state.warnings.push(note); // once per run
    });
  }
}

function record(e: Engine, entry: Omit<HistoryEntry, "round" | "started" | "seconds"> & { started?: string; seconds?: number }): HistoryEntry {
  const h: HistoryEntry = { round: e.state.round, started: entry.started ?? new Date().toISOString(), seconds: entry.seconds ?? 0, ...entry };
  e.state.history.push(h);
  return h;
}

function progress(e: Engine, phase: string, outcome: string, who: string, seconds: number, detail?: string): void {
  const line = `${phase.padEnd(10)} ${outcome.padEnd(7)} (${who}, ${seconds}s)${detail ? `  ${firstLine(detail)}` : ""}`;
  e.opts.onProgress?.(line);
}

// ── Roles ───────────────────────────────────────────────────────────────────────────────────

/** The output schema of `kind` as a file in `runDir` (for CLIs that take a file). */
function schemaFileIn(runDir: string, kind: string): string {
  const file = path.join(runDir, "schemas", `output.${kind}.schema.json`);
  if (!fs.existsSync(file)) writePrivate(file, JSON.stringify(loadSchema(`output.${kind}` as SchemaName), null, 2) + "\n");
  return file;
}

/**
 * The environment an agent process gets for a role: who it is (MW_ROLE, which makes owner commands
 * refuse), its card when there is one, its mode, and the run directory for read-only roles.
 */
export function roleEnvFor(project: Project, role: Role, mcp: McpWiring | undefined, runDir: string, card?: string): Record<string, string> {
  const env: Record<string, string> = { ...(mcp?.env ?? {}), MW_ROLE: role.id, MW_MODE: role.mode };
  if (card !== undefined) env.MW_CARD = card;
  // A write-mode agent is not told where the run's files are: it has no business writing them.
  if (role.mode !== "write") env.MW_RUN_DIR = runDir;
  if (role.runs === "local") {
    const lm = project.config.localModels;
    if (lm?.endpoint !== undefined) env.MW_LOCAL_ENDPOINT = lm.endpoint;
    if (lm?.fallback !== undefined) env.MW_LOCAL_FALLBACK = lm.fallback;
    const key = lm?.keyEnv ? process.env[lm.keyEnv] : undefined;
    if (key !== undefined) env.MW_LOCAL_KEY = key;
  }
  return env;
}

export async function renderRolePrompt(e: Engine, role: Role, diffBase?: string): Promise<string> {
  return renderPrompt(role.prompt, await promptValues(contextOf(e, diffBase), role.prompt, e.integrations)) + memoryAppendix(e.project, role.prompt);
}

export interface InvokeRole {
  project: Project;
  role: Role;
  /** The rendered prompt. */
  prompt: string;
  cwd: string;
  runDir: string;
  label: string;
  env: Record<string, string>;
  mcp?: McpWiring;
  signal?: AbortSignal;
  /** Called after every attempt with its label, prompt and reply (the engine checks its lease and saves the exchange). */
  afterAttempt?: (label: string, prompt: string, text: string) => void;
  /**
   * REQ-engine-006: the secret values every file the harness writes is redacted with. Default: the
   * project's (`secretsFor` with `mcp`).
   */
  secrets?: readonly string[];
  /** For a write-mode `claude` role: run it in the shell sandbox or not (decided by the sandbox policy). */
  sandbox?: boolean;
  /**
   * Rules beyond the schema, checked only on a reply that satisfies it: their messages count as
   * validation errors and take the same one retry (an adjudication against the findings).
   */
  check?: (value: unknown) => string[];
  /**
   * REQ-usage-004: whose usage guard (`usageGuard(integrations, [role.runs])`, which asks only for a role
   * on a paid harness, `paidHarness`) is asked once before every attempt: the first, a transient retry,
   * the fallback model, the schema retry. A refusal ends the invocation with `usagePause` and starts no
   * attempt. The caller asks nothing itself before invoking, unless it sets `firstGuarded`.
   */
  integrations?: Pick<Integrations, "usageOk">;
  /** The caller has already asked the usage guard for the first attempt (mw_delegate, before it makes its folder). */
  firstGuarded?: boolean;
}

/** The role as it runs on its alternate model (same harness; a `local` role's profile is the model). */
function onFallback(role: Role, model: string): Role {
  return { ...role, model, ...(role.runs === "local" ? { profile: model } : {}) };
}

/** What the attempts of one invocation share: the prompt, the one schema retry, the summed usage. */
interface Attempts {
  prompt: string;
  schemaRetried: boolean;
  usage?: Usage;
  /** REQ-engine-006: the secret values every attempt's files and result are redacted with. */
  secrets: readonly string[];
}

/**
 * Why the next attempt of `role` may not start, or undefined: the harness is under a recorded quota
 * limit, the usage guard refuses, or the signal fired while the guard was asked. Asked before every
 * attempt, the first (`first`) included.
 */
async function refusedAttempt(o: InvokeRole, role: Role, first: boolean): Promise<Pick<RoleRun, "quota" | "usagePause" | "error" | "notStarted"> | undefined> {
  const limit = activeQuota(o.project, role.runs);
  if (limit) {
    const why = `${role.runs} reported a usage limit that resets at ${limit.until} (${limit.detail})`;
    return first
      ? { quota: { resetAt: limit.until }, notStarted: true, error: `${why}, so '${role.id}' was not started` }
      : { quota: { resetAt: limit.until }, error: `${role.id} (${role.runs}) was not tried again: ${why}` };
  }
  const u = o.integrations && !(first && o.firstGuarded) ? await usageGuard(o.integrations, [role.runs]) : undefined;
  if (u && !u.ok) {
    return first
      ? { usagePause: u.detail, notStarted: true, error: `${role.id} (${role.runs}) was not started: ${u.detail}` }
      : { usagePause: u.detail, error: `${role.id} (${role.runs}) was not tried again: ${u.detail}` };
  }
  // The stop or lost lease may have fired while the guard was asked: no attempt starts after it.
  if (o.signal?.aborted) return { ...(first ? { notStarted: true } : {}), error: `${role.id} (${role.runs}) was stopped before its ${first ? "first" : "next"} attempt` };
  return undefined;
}

/**
 * One attempt of `role`: run, extract and validate, with the invocation's one schema retry (the
 * validation errors appended) if it has not been spent. A transient attempt never spends it.
 */
async function attemptRole(o: InvokeRole, harness: Harness, role: Role, label: string, st: Attempts): Promise<RoleRun> {
  const kind = role.output;
  const cfg = o.project.config;
  for (;;) {
    const req: HarnessRequest = {
      role, prompt: st.prompt, cwd: o.cwd, mode: role.mode, outputKind: kind,
      outputSchema: kind === "text" ? undefined : loadSchema(`output.${kind}`),
      outputSchemaFile: kind === "text" ? undefined : schemaFileIn(o.runDir, kind),
      limits: { turns: role.limits.turns ?? cfg.limits.turns, minutes: role.limits.minutes ?? cfg.limits.minutes },
      mcp: o.mcp, env: o.env, runDir: o.runDir, label: st.schemaRetried ? `${label}-retry` : label, signal: o.signal, sandbox: o.sandbox,
      secrets: st.secrets,
    };
    // REQ-engine-006: the one place a harness result enters the engine (every attempt: the first, a
    // transient retry, the fallback model, the schema retry). Its text, error and parsed reply are
    // redacted here, so no harness can carry a secret into state.json, history, notifications or warnings.
    const res = redactResult(await harness.run(req), st.secrets);
    st.usage = addUsage(st.usage, res.usage);
    o.afterAttempt?.(req.label, st.prompt, res.text);
    if (!res.ok) {
      return {
        ok: false, text: res.text, error: `${role.id} (${role.runs}) failed: ${res.error ?? "no reply"}`,
        ...(res.transient ? { transient: true } : {}), ...(res.quota ? { quota: res.quota } : {}),
      };
    }
    if (kind === "text") return { ok: true, text: res.text };
    const value = res.json ?? extractJson(res.text);
    let errors = value === undefined ? ["the reply contains no JSON object"] : validate(`output.${kind}`, value);
    if (!errors.length && o.check) errors = o.check(value);
    if (!errors.length) return { ok: true, value, text: res.text };
    if (st.schemaRetried) return { ok: false, text: res.text, error: `${role.id} returned an invalid ${kind} twice: ${errors.join("; ")}` };
    if (o.signal?.aborted) return { ok: false, text: res.text, error: `${role.id} (${role.runs}) was stopped before its schema retry` };
    const refused = await refusedAttempt(o, role, false);
    if (refused) return { ok: false, text: res.text, ...refused };
    st.schemaRetried = true;
    st.prompt = `${o.prompt}\n\n## Your previous reply was not valid\n\n${errors.map((x) => `- ${x}`).join("\n")}\n\nReply again with only a JSON object that satisfies the ${kind} schema and fixes every problem above.`;
  }
}

/**
 * Run a rendered prompt through the role's harness, extract and validate its output; one retry with
 * the validation errors appended. Used by card phases and by `mw_delegate` (src/mcpserver).
 *
 * A transient failure (REQ-harness-001) is tried again on the same model after a growing
 * wait, up to `limits.transient_retries` times (REQ-harness-002), then once on the role's
 * `fallback_model` (REQ-harness-003); the result then has `transient` and an error starting with
 * `harness/transient`. A stop or a lost lease (`signal`) ends a wait at once and no attempt follows.
 * A quota or session limit is never retried: its reset time is recorded for the harness (quota.ts) and
 * until then the role is not started at all. Usage sums every attempt.
 */
export async function invokeRole(o: InvokeRole): Promise<RoleRun> {
  const { role, project } = o;
  const harness = await harnessFor(role.runs, project);
  const retries = Math.max(0, project.config.limits.transientRetries);
  const models = [role, ...(role.fallbackModel && role.fallbackModel !== role.model ? [onFallback(role, role.fallbackModel)] : [])];
  const st: Attempts = { prompt: o.prompt, schemaRetried: false, secrets: o.secrets ?? secretsFor(project, o.mcp) };
  const tried: string[] = [];
  let count = 0;
  let last: RoleRun | undefined;
  for (const [i, r] of models.entries()) {
    tried.push(effectiveModel(r));
    for (let a = 0; a < (i === 0 ? retries + 1 : 1); a++) {
      const first = !last;
      if (a > 0) await abortableSleep(transientDelayMs(a - 1), o.signal);
      // Every attempt, the first included: none starts once the stop or lost-lease signal has fired.
      if (o.signal?.aborted) {
        return { ok: false, text: last?.text ?? "", error: `${role.id} (${role.runs}) was stopped before its ${first ? "first" : "next"} attempt${last ? `; the last one failed: ${last.error ?? "(none)"}` : ""}`, usage: st.usage, model: effectiveModel(r), retries: count, ...(first ? { notStarted: true } : {}) };
      }
      const refused = await refusedAttempt(o, r, first);
      if (refused) return { ok: false, text: last?.text ?? "", ...refused, usage: st.usage, model: effectiveModel(r), retries: count };
      if (a > 0) count++;
      last = await attemptRole(o, harness, r, `${o.label}${i > 0 ? "-fallback" : a > 0 ? `-transient${a}` : ""}`, st);
      if (!last.transient) {
        if (last.quota?.resetAt) recordQuota(project, role.runs, last.quota.resetAt, last.error ?? "");
        return { ...last, usage: st.usage, model: effectiveModel(r), retries: count, ...(i > 0 ? { fallback: true } : {}) };
      }
    }
  }
  const which = tried.map((m, i) => `'${m}'${i === 0 && count ? ` (${count + 1} attempts)` : ""}`).join(", then ");
  return {
    ok: false, transient: true, text: last!.text, usage: st.usage, model: tried[tried.length - 1], retries: count,
    error: `${HARNESS_TRANSIENT}: ${role.id} (${role.runs}) failed transiently on ${which}${models.length === 1 ? "; it has no fallback_model" : ""}. Last error: ${last!.error}`,
  };
}

/** Render, run, extract and validate; one retry with the validation errors appended. */
async function runRole(e: Engine, role: Role, label: string, appendix = "", diffBase?: string): Promise<RoleRun> {
  const mcpServers = mcpsForRole(e.project, role);
  const mcp = mcpServers.length ? wireMcps(mcpServers) : undefined;
  const base = (await renderRolePrompt(e, role, diffBase)) + appendix;
  const sandbox = role.runs === "claude" && role.mode === "write" ? claudeSandboxFor(e, role) : undefined;
  const secrets = secretsFor(e.project, mcp);
  return invokeRole({
    project: e.project, role, prompt: base, cwd: role.mode === "write" ? cwdOf(e) : readCwd(e), runDir: e.runDir, label,
    env: roleEnvFor(e.project, role, mcp, e.runDir, e.card.id), mcp, signal: e.signal, sandbox, secrets,
    check: role.output === "adjudication" ? (v) => adjudicationErrors(v as Adjudication, e.artifacts.get<Findings>("findings")) : undefined,
    integrations: e.integrations,
    afterAttempt: (lbl, prompt, text) => {
      assertLease(e); // a machine that lost the lease writes nothing more into the shared run directory
      saveExchange(e.runDir, lbl, prompt, text, secrets);
    },
  });
}

// ── Sandbox policy (spec 8.6) ───────────────────────────────────────────────────────────────

/** What the run state records when the policy is `off`. */
export const SANDBOX_OFF = "off (isolated host)";
/** Every sandbox warning of a run starts with this, so a run records one, not one per phase. */
const SANDBOX_WARNING = "the claude harness ran write-mode role";

function policyOf(e: Engine): { policy: SandboxPolicy; source: string } {
  return sandboxPolicy(e.project.config.agents.sandbox);
}

/**
 * Whether a write-mode Claude role runs in the shell sandbox, by the policy: `off` never probes or
 * warns; `auto` uses the sandbox when the probe says it works, and otherwise records one warning per
 * run. (`required` with a failing probe never gets here: the phase was refused, see `sandboxRefusal`.)
 */
function claudeSandboxFor(e: Engine, role: Role): boolean {
  const { policy } = policyOf(e);
  if (policy === "off") {
    e.state.sandbox = SANDBOX_OFF;
    return false;
  }
  const d = sandboxDecision(policy);
  if (d.use) {
    e.state.sandbox = "on";
    return true;
  }
  e.state.sandbox = `unavailable: ${d.why}`;
  if (!e.state.warnings.some((w) => w.startsWith(SANDBOX_WARNING))) {
    const warning = `${SANDBOX_WARNING} '${role.id}' without its shell sandbox on ${hostName()}, because ${d.why}; its shell commands were not confined to the worktree (recorded once per run; later write-mode Claude roles of this run ran the same way). Make the sandbox work on this machine (bubblewrap, socat and unprivileged user namespaces), or set MW_SANDBOX=off on a host that is isolated already.`;
    e.state.warnings.push(warning);
    e.opts.onProgress?.(`warning: ${warning}`);
  }
  return false;
}

/**
 * Why a phase may not start under the policy `required`, or undefined: one of its writing roles runs
 * on `claude` while the sandbox does not work on this machine, or on `shell`, which has none. Codex
 * brings its own sandbox (workspace-write), and `mock` is for tests.
 */
function sandboxRefusal(e: Engine, phase: Phase): string | undefined {
  if (!phase.role) return undefined;
  const { policy, source } = policyOf(e);
  if (policy !== "required") return undefined;
  for (const id of activeRoles(e, phase)) {
    const role = roleOf(e, id);
    if (role.mode !== "write") continue;
    let why: string | undefined;
    if (role.runs === "claude") {
      const d = sandboxDecision(policy);
      if (d.refuse) {
        e.state.sandbox = `unavailable: ${d.refuse}`;
        why = `Claude Code's shell sandbox does not work on ${hostName()}: ${d.refuse}`;
      }
    } else if (role.runs === "shell") {
      why = `the shell harness has no sandbox`;
    }
    if (why) {
      const from = source === "MW_SANDBOX" ? "MW_SANDBOX on this machine" : "agents.sandbox in mergewright.yaml";
      return `the sandbox policy is 'required' (${from}), so phase '${phase.id}' was not started (run/sandbox-required): its writing role '${role.id}' would run unconfined, because ${why}. Make the sandbox work on this machine, or set MW_SANDBOX=off on a host that is isolated already, then run 'mw run ${e.card.id}' again.`;
    }
  }
  return undefined;
}

function activeRoles(e: Engine, phase: Phase): string[] {
  const vars = asExprVars(computeVars(contextOf(e)));
  return [phase.role!, ...phase.also.filter((a) => !a.when || evalExpr(a.when, vars)).map((a) => a.role)];
}

function roleOf(e: Engine, id: string): Role {
  const role = e.project.roles().get(id);
  if (!role) throw new MwError("run/no-role", `the flow names role '${id}', which does not exist (see 'mw roles')`);
  return role;
}

async function rolePhase(e: Engine, phase: Phase, seq: string): Promise<PhaseResult> {
  const ids = activeRoles(e, phase);
  const judged = judgedHead(e);
  const ran: string[] = [];
  let usage: Usage | undefined;
  const usageBy: Record<string, Usage> = {};
  const harnessBy: Record<string, string> = {};
  const modelBy: Record<string, string> = {};
  let merged: Findings | undefined;
  /** REQ-harness-002, 003: how a role got its answer, when it took transient retries or its alternate. */
  const notes: string[] = [];
  const result = (outcome: Outcome, detail: string): PhaseResult => ({
    outcome, detail: notes.length ? `${detail} (${notes.join("; ")})` : detail, roles: ran, usage, usageBy: Object.keys(usageBy).length ? usageBy : undefined,
    ...(ran.length ? { harness: { ...harnessBy }, model: { ...modelBy } } : {}),
  });
  /** A quota or session limit pauses the run for usage, spending no round. */
  const quotaPause = (run: RoleRun): PhaseResult => {
    const detail = run.usagePause
      ? (run.error ?? run.usagePause)
      : `${run.error ?? "usage limit"}${run.quota?.resetAt ? `; paused until ${run.quota.resetAt}` : "; the limit stated no reset time"}`;
    return { ...result("ok", detail), pause: detail };
  };

  for (const id of ids) {
    const role = roleOf(e, id);
    // REQ-usage-004: no guard here; invokeRole asks usageGuard(integrations, [role.runs]) once before every
    // attempt, the first included, so a role on a paid harness waits while usage is too high, whatever its mode.
    const label = `${seq}-${phase.id}-${role.id}`;
    const cwd = cwdOf(e);
    if (role.mode === "write" && !e.flow.worktree) {
      // A writing role would work in the main checkout among the owner's own edits, and
      // what it changed could not be told apart from them. 'mw check' reports this as flow/write.
      return result("block", `flow '${e.flow.id}' has 'worktree: false', so its writing role '${role.id}' would work in the main checkout; that is not supported. Run 'mw check' (it reports flow/write), give the flow 'worktree: true' or a read-only role, then run 'mw run ${e.card.id}' again.`);
    }
    const diffBase = e.flow.worktree ? e.base : undefined;
    let run: RoleRun;
    harnessBy[role.id] = role.runs;
    modelBy[role.id] = effectiveModel(role);
    try {
      run = await runRole(e, role, label, "", diffBase);
    } catch (err) {
      if (err instanceof MwError && err.code.startsWith("mcp/")) { ran.push(role.id); return result("block", err.message); }
      throw err;
    }
    // The usage guard or a recorded quota limit refused the first attempt (invokeRole asks before every
    // attempt): the run pauses for usage before this role ran.
    if (run.notStarted && run.usagePause) return { ...result("ok", run.usagePause), pause: run.usagePause };
    if (run.notStarted && run.quota) return quotaPause(run);
    if (run.notStarted) return result("fail", run.error!); // stopped: the engine ends the run after the phase
    ran.push(role.id);
    usage = addUsage(usage, run.usage);
    const by = addUsage(usageBy[role.runs], run.usage);
    if (by) usageBy[role.runs] = by;
    if (run.model) modelBy[role.id] = run.model; // the model that answered (REQ-harness-003)
    if (run.retries || run.fallback) {
      notes.push(`${role.id}: ${run.retries ?? 0} transient ${run.retries === 1 ? "retry" : "retries"}${run.fallback ? `, answered by its fallback_model '${run.model}'` : ""}`);
    }

    if (role.mode === "write") {
      const h = run.ok && role.output === "handoff" ? (run.value as Handoff) : undefined;
      const summary = h ? firstLine(h.summary).slice(0, 72) : "";
      assertLease(e);
      // Never commit through a directory that is not exactly the card's worktree: git would find
      // the main repository and commit there.
      const v = verifiedWorktree(e.project, e.card.id);
      if (!v.ok) return result("block", `${v.why}. The agent's changes were not committed; the next 'mw run ${e.card.id}' moves what is there aside to .mergewright/local/discarded/ and starts from the branch again.`);
      commitAll(cwd, `${e.card.id}: ${summary || `work in progress (${phase.id})`}`);
      if (run.quota || run.usagePause) return quotaPause(run);
      if (run.transient) return result("block", run.error!); // harness/transient: no remediation round
      if (!run.ok) return result("fail", run.error!);
      if (h) {
        e.artifacts.put("handoff", h);
        if (h.status === "blocked") return result("block", `the worker stopped: ${[h.summary, ...h.not_done, h.notes].filter((x) => x?.trim()).join("; ")}`);
      }
      const outside = branchViolations(e, cwd);
      if (outside) return result("fail", outside);
      if (!h) continue;
      if (ids.length === 1) return result("ok", firstLine(h.summary) || "work committed");
      continue;
    }
    if (run.quota || run.usagePause) return quotaPause(run);
    if (run.transient) return result("block", run.error!); // harness/transient: no remediation round
    if (!run.ok) return result("fail", run.error!);

    switch (role.output) {
      case "brief": {
        const b = run.value as Brief;
        e.artifacts.put("brief", b);
        if (!b.ready) return result("block", `the planner says the card is not ready: ${b.blockers.join("; ") || "(no reason given)"}`);
        break;
      }
      case "findings": {
        const f = run.value as Findings;
        const prefixed = f.findings.map((x) => ({ ...x, id: `${role.id}:${x.id}` }));
        merged = merged
          ? { summary: `${merged.summary}\n${role.id}: ${f.summary}`, findings: [...merged.findings, ...prefixed] }
          : { summary: `${role.id}: ${f.summary}`, findings: prefixed };
        e.artifacts.put("findings", { ...merged, head: judged } satisfies Findings);
        break;
      }
      case "adjudication": {
        const a = run.value as Adjudication;
        e.artifacts.put("adjudication", a);
        if (a.verdict === "block") return result("block", `the adjudicator blocked the card: ${a.summary}${a.instructions ? ` ${a.instructions}` : ""}`);
        if (a.verdict === "reject") {
          const findings = e.artifacts.get<Findings>("findings")?.findings ?? [];
          const accepted = a.accepted.map((id) => findingFor(findings, id)).filter((f) => f !== undefined && f !== "ambiguous");
          const texts = accepted.map((f) => `- ${f.id} ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}${f.title}: ${f.detail}`);
          return result("reject", `${a.instructions.trim()}${texts.length ? `\n\nAccepted findings:\n${texts.join("\n")}` : ""}`);
        }
        break;
      }
      case "reflection":
        e.artifacts.put("reflection", run.value);
        break;
      default:
        break;
    }
  }
  if (merged) {
    const blocking = merged.findings.filter((f) => f.blocking).length;
    return result("ok", `${merged.findings.length} finding(s), ${blocking} blocking`);
  }
  if (ran.some((r) => roleOf(e, r).output === "adjudication")) {
    const a = e.artifacts.get<Adjudication>("adjudication");
    const conditions = approvalConditions(a);
    const extra = [conditions.length ? `${conditions.length} condition(s) before merge: ${conditions.map((c) => c.what).join("; ")}` : "", a?.follow_ups?.length ? `${a.follow_ups.length} follow-up(s)` : ""].filter(Boolean);
    return result("ok", `approved: ${a?.summary ?? ""}${extra.length ? ` (${extra.join("; ")})` : ""}`.trim());
  }
  return result("ok", ran.length ? `${ran.join(", ")} finished` : "nothing ran");
}

async function action(e: Engine, phase: Phase, seq: string): Promise<ActionResult> {
  switch (phase.action) {
    case "merge": return merge(e, (head, onto) => mergeEvidence(e, head, onto), (gate, cwd) => {
      const file = e.project.gates().get(gate);
      if (!file) return Promise.resolve({ ok: false, code: "gate/missing", detail: `the flow names gate '${gate}', but there is no gates/${gate}.gate.sh`, seconds: 0, json: { ok: false, steps: [] } });
      // The re-gate's logs go under regate/, so the gate phase's own logs are kept.
      return gateIn(e, gate, file, cwd, path.join(e.runDir, "regate"), branchHead(e.project.root, e.base));
    });
    case "memory.update": {
      const role = phase.role ? roleOf(e, phase.role) : undefined;
      return memoryUpdate(e, computeVars(contextOf(e)).risk, async (error) => {
        if (!role) return undefined;
        // REQ-usage-004: the retry starts a role too, so it passes the same guard (asked once, by invokeRole);
        // when usage is too high it is not started and the update goes on as when the reflection is refused twice.
        const r = await runRole(e, role, `${seq}-${phase.id}-${role.id}-memory`, `\n\n## Your state was refused\n\n${error}\n\nReturn the whole reflection again with a shorter state.`);
        if (r.notStarted && r.usagePause) {
          e.state.warnings.push(`memory.update: the reflection was not run again because agent usage is too high (${r.usagePause})`);
          return undefined;
        }
        if (!r.ok) return undefined;
        e.artifacts.put("reflection", r.value);
        return r.value as Reflection;
      });
    }
    case "docs.sync": return docsSync(e);
    case "notify": return notifyAction(e, phase);
    default: return { outcome: "fail", detail: `unknown action '${String(phase.action)}'` };
  }
}

async function executePhase(e: Engine, phase: Phase, seq: string): Promise<PhaseResult> {
  if (phase.gate) {
    const file = e.project.gates().get(phase.gate);
    if (!file) return { outcome: "block", detail: `the flow names gate '${phase.gate}', but there is no gates/${phase.gate}.gate.sh`, roles: [] };
    const judged = judgedHead(e);
    // REQ-gate-004: the base commit the judged tree builds on is recorded with the result.
    const g = await gateIn(e, phase.gate, file, cwdOf(e), e.runDir, e.flow.worktree ? forkPoint(e.project.root, e.base, judged) : judged);
    assertLease(e);
    e.artifacts.put("gate", { ...g.json, head: judged } satisfies GateJson);
    // A required step that did not run is the owner's to fix (the machine lacks what it
    // needs), not the worker's: the phase blocks instead of spending remediation rounds.
    // so is a required step the gate's summary does not show exactly once (the gate script is the owner's).
    return { outcome: g.ok ? "ok" : g.code === REQUIRED_SKIPPED || g.code === REQUIRED_MISSING ? "block" : "fail", detail: g.detail, roles: [] };
  }
  let r: PhaseResult = { outcome: "ok", detail: "", roles: [] };
  if (phase.role) {
    r = await rolePhase(e, phase, seq);
    if (r.pause || r.outcome !== "ok") return r;
  }
  if (phase.action) {
    const a = await action(e, phase, seq);
    return { ...r, outcome: a.outcome, detail: r.detail ? `${r.detail}; ${a.detail}` : a.detail, ...(a.remediate ? { remediate: true } : {}) };
  }
  return r;
}

/**
 * Run gate `id` in `cwd` with the project's gate settings (`gate.required` among them). The gate phase
 * and the merge's re-gate (REQ-gate-004) both run gates through here, so both fail closed alike.
 */
function gateIn(e: Engine, id: string, file: string, cwd: string, runDir: string, baseCommit: string): Promise<GateRun> {
  return runGate({ id, file, cwd, runDir, base: e.base, baseCommit, minutes: e.project.config.limits.minutes, env: gateEnv(e.project, {}), signal: e.signal, required: e.project.config.gate.required, secrets: secretsFor(e.project) });
}

// ── Merge evidence ──────────────────────────────────────────────────

/** The commit a gate or review judges: the card branch's head (the base's in a flow without a worktree). */
function judgedHead(e: Engine): string {
  return e.flow.worktree ? branchHead(e.project.root, e.branch) : head(e.project.root);
}

/**
 * Why the merge must not happen, or undefined when it may: for each kind of check the flow has before
 * its merge phase (a gate phase, a review phase: one whose roles return findings), the run must hold
 * that check's artifact for `tip`, the head about to be merged, and the gate must have passed. The
 * runtime's own commit marking the card done (left by an earlier merge attempt) on top of the judged
 * head does not count as a change. This holds whatever the state file says about the run's position or
 * approvals.
 *
 * Which of those phases apply is read from the run history, never from a `when` evaluated
 * against the stored artifacts (whoever rewrites findings.json would decide it). A phase is exempt only
 * when the runtime recorded skipping it and no phase that can change the branch (one with a write-mode
 * role) has run since; a phase with no recorded run, or one that ran, needs its evidence.
 *
 * REQ-gate-004: given `onto`, the base commit the squash is built on, a passing gate
 * result recorded against another base commit (or none, from an older runtime) asks for the gate to run
 * again (`regate`); the merge then compares the trees and runs it on the squash tree when they differ.
 */
function mergeEvidence(e: Engine, tip: string, onto?: string): Evidence {
  const at = e.flow.phases.findIndex((p) => p.action === "merge");
  const before = e.flow.phases.slice(0, at < 0 ? e.state.phase : at);
  const roles = e.project.roles();
  const roleIds = (p: Phase) => [p.role, ...p.also.map((x) => x.role)];
  const writers = new Set(before.filter((p) => roleIds(p).some((r) => r && roles.get(r)?.mode === "write")).map((p) => p.id));
  const changed = e.state.history.findLastIndex((x) => writers.has(x.phase) && x.outcome !== "skipped");
  const ran = before.filter((p) => !skippedSince(e, p.id, changed));
  const gatePhase = ran.find((p) => p.gate);
  const reviewPhase = ran.find((p) => roleIds(p).some((r) => r && roles.get(r)?.output === "findings"));
  const judges = (h: string | undefined) => !!h && (h === tip || markDoneOnly(e, h, tip));
  const problems: string[] = [];
  if (gatePhase) {
    const g = e.artifacts.get<GateJson>("gate");
    if (!g) problems.push(`no gate result is recorded`);
    else if (!judges(g.head)) problems.push(`the recorded gate result is for ${g.head ? g.head.slice(0, 10) : "an unknown commit"}`);
    else if (!g.ok) problems.push(`the gate failed on it`);
  }
  if (reviewPhase) {
    const f = e.artifacts.get<Findings>("findings");
    if (!f) problems.push(`no review is recorded`);
    else if (!judges(f.head)) problems.push(`the recorded review is of ${f.head ? f.head.slice(0, 10) : "an unknown commit"}`);
  }
  if (problems.length) {
    const from = gatePhase ?? reviewPhase!;
    return { refuse: `${e.card.id} was not merged: the merge needs a passing gate and a review of the commit it merges (${tip.slice(0, 10)} on ${e.branch}), but ${problems.join(", and ")}. Run 'mw run ${e.card.id} --from ${from.id}' to check and review that commit.` };
  }
  const recorded = e.artifacts.get<GateJson>("gate")?.base;
  const ok: Evidence = gatePhase?.gate && onto && recorded !== onto ? { regate: gatePhase.gate } : {};
  // REQ-adjudication-003: an adjudication phase before the merge needs a recorded approval
  // that keeps the adjudication rules against the recorded findings; so does any recorded adjudication
  // in a flow without one. Whether the phase applies is not judged from the stored artifacts (whoever
  // rewrites findings.json would decide it): only the runtime's own record that it skipped the phase
  // after the latest review exempts it, and then a recorded adjudication is from an earlier round.
  const adjudicatePhase = before.find((p) => roleIds(p).some((r) => r && roles.get(r)?.output === "adjudication"));
  if (adjudicatePhase ? skippedAfterReview(e, adjudicatePhase.id, reviewPhase?.id) : !e.artifacts.has("adjudication")) return ok;
  const why = storedAdjudicationProblem(e);
  if (!why) return ok;
  const again = adjudicatePhase ? `Run 'mw run ${e.card.id} --from ${adjudicatePhase.id}' to adjudicate the findings again.` : `Run 'mw run ${e.card.id}' again after fixing the cause.`;
  return { refuse: `${e.card.id} was not merged: ${why}. ${again}` };
}

/**
 * Whether the run history says the runtime skipped phase `id` (its condition was false) after the
 * latest passing run of the review phase `review`, and has not run it since. False without a review
 * phase, or when the history holds no such entry: the caller then fails closed.
 */
function skippedAfterReview(e: Engine, id: string, review: string | undefined): boolean {
  if (!review) return false;
  const reviewed = e.state.history.findLastIndex((x) => x.phase === review && x.outcome === "ok");
  return reviewed >= 0 && skippedSince(e, id, reviewed);
}

/**
 * Whether the latest history entry of phase `id` is the runtime's record that it skipped the phase,
 * written after history entry `since` (-1: any). False when the phase has no entry at all.
 */
function skippedSince(e: Engine, id: string, since: number): boolean {
  const h = e.state.history;
  const last = h.findLastIndex((x) => x.phase === id);
  return last >= 0 && last > since && h[last]!.outcome === "skipped";
}

/**
 * Why the recorded adjudication does not allow the merge, or undefined when it does. Fails closed: a
 * missing or malformed adjudication or findings artifact refuses, as does anything but an approval
 * that passes `adjudicationErrors` (the same rules the adjudicator's reply was held to).
 */
function storedAdjudicationProblem(e: Engine): string | undefined {
  const a = e.artifacts.get<unknown>("adjudication");
  if (a === undefined) return `no adjudication is recorded`;
  const aShape = adjudicationShapeProblem(a);
  if (aShape) return `the recorded adjudication is malformed (${aShape})`;
  const aErrors = validate("output.adjudication", a);
  if (aErrors.length) return `the recorded adjudication is malformed (${aErrors.join("; ")})`;
  const adj = a as Adjudication;
  if (adj.verdict !== "approve") return `the recorded adjudication is not an approval (its verdict is '${adj.verdict}')`;
  const f = e.artifacts.get<unknown>("findings");
  if (f === undefined) return `the recorded adjudication approves, but no findings are recorded to check it against`;
  const fShape = findingsShapeProblem(f);
  if (fShape) return `the recorded findings are malformed (${fShape})`;
  const { head: _head, ...plain } = f as Findings;
  const fErrors = validate("output.findings", plain);
  if (fErrors.length) return `the recorded findings are malformed (${fErrors.join("; ")})`;
  const errors = adjudicationErrors(adj, f as Findings);
  if (errors.length) return `the recorded approval does not keep the adjudication rules: ${errors.join("; ")}`;
  return undefined;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStringArray = (x: unknown): boolean => Array.isArray(x) && x.every((s) => typeof s === "string");

/** Why a stored adjudication cannot even be read (checked before anything destructures it). */
function adjudicationShapeProblem(a: unknown): string | undefined {
  if (!isObject(a)) return `it is not an object`;
  if (typeof a.verdict !== "string") return `it has no verdict`;
  if (!isStringArray(a.accepted)) return `'accepted' is not a list of finding ids`;
  if (!Array.isArray(a.rejected) || !a.rejected.every((r) => isObject(r) && typeof r.id === "string")) return `'rejected' is not a list of findings with ids`;
  return undefined;
}

/** Why a stored findings artifact cannot even be read (checked before anything destructures it). */
function findingsShapeProblem(f: unknown): string | undefined {
  if (!isObject(f)) return `it is not an object`;
  if (!Array.isArray(f.findings)) return `'findings' is not a list`;
  if (!f.findings.every((x) => isObject(x) && typeof x.id === "string")) return `a finding is not an object with a string id`;
  return undefined;
}

/** True when `tip` is the runtime's own commit marking the card done, directly on top of `judged`. */
function markDoneOnly(e: Engine, judged: string, tip: string): boolean {
  const parent = git(e.project.root, ["rev-parse", "--verify", "--quiet", `${tip}^`], { allowFail: true }).stdout.trim();
  if (parent !== judged) return false;
  const files = git(e.project.root, ["diff", "--no-renames", "--name-only", "-z", judged, tip], { allowFail: true }).stdout.split("\0").filter(Boolean);
  if (files.length !== 1 || files[0] !== e.card.file) return false;
  const was = git(e.project.root, ["show", `${judged}:${e.card.file}`], { allowFail: true });
  const now = git(e.project.root, ["show", `${tip}:${e.card.file}`], { allowFail: true });
  return was.code === 0 && now.code === 0 && now.stdout === setFrontmatter(was.stdout, { status: "done" });
}

// ── The loop ────────────────────────────────────────────────────────────────────────────────

/** The artifact a phase produces, to check `needs`. */
function produced(e: Engine, id: string): boolean {
  const p = e.flow.phases.find((x) => x.id === id);
  if (!p) return false;
  if (p.gate) return e.artifacts.has("gate");
  const kind = p.role ? e.project.roles().get(p.role)?.output : undefined;
  if (kind && kind !== "text") return e.artifacts.has(kind);
  return e.state.history.some((h) => h.phase === id && h.outcome === "ok");
}

/** The word of the stop point that holds a merge while the adjudicator's approval has conditions. */
export const CONDITIONS = "conditions";
const CONDITIONS_STOP: StopPoint = { when: "adjudication.conditions > 0", ask: CONDITIONS };

/** The condition of the stops the runtime adds for a high or critical card (REQ-flows-001). */
const RISK_STOP_WHEN = "risk >= high";

/** What the runtime's minimum stops are decided from: the flow definition, the roles and the card's own risk. */
export interface StopContext {
  flow: Flow;
  roles: Map<string, Role>;
  /** The card's risk (`Project.riskOf`), never a stored artifact such as the brief. */
  risk: Risk;
}

/**
 * A phase's stop points, and the words among them the runtime added (or enforced) for the card's risk.
 * A merge phase always has the `conditions` stop first, even when its flow does not name it or lists it
 * later (the phase's other stops keep their order): an approval with conditions never merges before the
 * owner says they are met. With a context, a card of risk `high` or `critical` also waits for `go`
 * before the flow's first phase with a writing role and for `merge` before each merge phase (after
 * `conditions`), in every flow (REQ-flows-001). Only the target phase's own stops count: a word the
 * target phase already declares is not doubled there, its condition is widened to
 * `(<declared>) or risk >= high`; otherwise the runtime adds `{when: "risk >= high", ask}`. Stops on
 * other phases are kept as declared and never stand in for the target's, because routing (`on`,
 * `--from`, a false `when`) can skip them; so a flow can add stops but never remove these.
 */
export function stopPlan(phase: Phase, ctx?: StopContext): { stops: StopPoint[]; added: string[] } {
  let stops = phase.action !== "merge" ? phase.stops : [...phase.stops.filter((s) => s.ask === CONDITIONS), ...phase.stops.filter((s) => s.ask !== CONDITIONS)];
  if (phase.action === "merge" && !stops.some((s) => s.ask === CONDITIONS)) stops = [CONDITIONS_STOP, ...stops];
  const added: string[] = [];
  if (!ctx || RISK_LEVELS.indexOf(ctx.risk) < RISK_LEVELS.indexOf("high")) return { stops, added };
  const writes = (p: Phase) => [p.role, ...p.also.map((a) => a.role)].some((id) => id !== undefined && ctx.roles.get(id)?.mode === "write");
  const due: string[] = [];
  if (ctx.flow.phases.find(writes) === phase) due.push("go");
  if (phase.action === "merge") due.push("merge");
  for (const ask of due) {
    const i = stops.findIndex((s) => s.ask === ask);
    if (i < 0) stops = [...stops, { when: RISK_STOP_WHEN, ask }];
    else if (stops[i]!.when !== RISK_STOP_WHEN) stops = stops.map((s, j) => (j === i ? { when: `(${s.when}) or ${RISK_STOP_WHEN}`, ask } : s));
    else continue;
    added.push(ask);
  }
  return { stops, added };
}

/** A phase's stop points (see `stopPlan`); `loop()` and the dry run both read them from here. */
export function stopsOf(phase: Phase, ctx?: StopContext): StopPoint[] {
  return stopPlan(phase, ctx).stops;
}

function stopContext(e: Engine): StopContext {
  return { flow: e.flow, roles: e.project.roles(), risk: e.project.riskOf(e.card) };
}

/** "- run the DB tests (how: DATABASE_URL=... npm test)" lines. */
export function renderConditions(conditions: MergeCondition[]): string {
  return conditions.map((c) => `- ${c.what}${c.how ? ` (how: ${c.how})` : ""}`).join("\n");
}

async function waitFor(e: Engine, phase: Phase, word: string): Promise<void> {
  await setStatus(e, "waiting", word);
  let extra = "";
  if (word === CONDITIONS) {
    const conditions = approvalConditions(e.artifacts.get<Adjudication>("adjudication"));
    e.state.conditions = conditions;
    extra = `\n\nThe adjudicator approved on conditions, to be met before the merge:\n${renderConditions(conditions)}\n\nMeet them (for example on the card's branch ${e.branch}), then approve.`;
  }
  record(e, { phase: phase.id, roles: [], outcome: "waiting", detail: `waiting for approval '${word}'${word === CONDITIONS ? `: ${(e.state.conditions ?? []).map((c) => c.what).join("; ")}` : ""}` });
  save(e);
  progress(e, phase.id, "waiting", `approve '${word}'`, 0);
  await safely(e, "notify", () => e.integrations.notify(`${e.card.id} is waiting for '${word}'`, `${e.card.title}\n\nThe run stopped before phase '${phase.id}'.${extra}\n\nRun 'mw approve ${e.card.id} ${word}' to continue.`));
  save(e);
}

async function block(e: Engine, phase: Phase, reason: string): Promise<void> {
  await setStatus(e, "blocked", reason);
  save(e);
  await safely(e, "notify", () => e.integrations.notify(`${e.card.id} is blocked at '${phase.id}'`, `${e.card.title}\n\n${reason}\n\nFix the cause, then run 'mw run ${e.card.id}' to retry the phase.`));
  save(e);
}

/** Milliseconds between lease refreshes while a phase runs: a third of the lease time. */
function heartbeatMs(e: Engine): number {
  const env = Number(process.env.MW_HEARTBEAT_MS);
  return env > 0 ? env : (e.project.config.limits.leaseMinutes / 3) * 60_000;
}

/**
 * Execute a phase while refreshing the lease on a timer; a failed refresh aborts the phase, and so does
 * the owner's stop signal (then `Stopped` is thrown once the phase has returned, which a harness or gate
 * does only after its process group is gone).
 */
async function withHeartbeat<T>(e: Engine, f: () => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let lost: string | undefined;
  const timer = setInterval(() => {
    e.hub.refresh().catch((err: unknown) => {
      lost ??= (err as Error).message;
      ctl.abort();
    });
  }, heartbeatMs(e));
  const onStop = () => ctl.abort();
  e.stop?.addEventListener("abort", onStop, { once: true });
  if (e.stop?.aborted) ctl.abort();
  e.signal = ctl.signal;
  try {
    const r = await f();
    if (e.stop?.aborted) throw stopped(e);
    if (lost || ctl.signal.aborted) throw new LeaseLost(lost ?? "the lease heartbeat failed");
    return r;
  } catch (err) {
    if (e.stop?.aborted && !(err instanceof Stopped)) throw stopped(e);
    if (lost && !(err instanceof LeaseLost)) throw new LeaseLost(lost);
    throw err;
  } finally {
    try {
      // A process group the phase's agent or gate left alive after SIGTERM and
      // SIGKILL is killed again for up to two minutes (the lease is still refreshed meanwhile); one that
      // survives that ends the run with `Orphaned`, which replaces whatever the phase returned.
      await settleSurvivors(e.project, e.card.id, takeSurvivors(), (l) => e.opts.onProgress?.(l));
    } finally {
      clearInterval(timer);
      e.stop?.removeEventListener("abort", onStop);
    }
  }
}

function stopped(e: Engine): Stopped {
  const phase = e.flow.phases[e.state.phase]?.id ?? "the end";
  return new Stopped(`${e.card.id} was stopped during phase '${phase}' at the owner's request; its agent and gate processes were ended, and nothing of that phase was committed or saved. Run 'mw run ${e.card.id}' to do that phase again.`);
}

/**
 * The lease is gone: stop now. The agent was already stopped; nothing is committed, pushed or saved
 * (the run directory is shared, and the machine that holds the lease now owns the run state), and
 * nothing is done to the worktree either: what the phase left there is dealt with the
 * next time this machine works on the card. Throws `LeaseLost` with what happened.
 */
async function leaseLost(e: Engine, phase: Phase, why: string): Promise<never> {
  let holder: string | undefined;
  try {
    holder = (await e.hub.lease())?.host;
  } catch {
    holder = undefined;
  }
  const reason = `this machine lost the lease to ${holder ?? "another machine"} (${why}). Phase '${phase.id}' of ${e.card.id} was stopped and its result discarded; nothing was committed, pushed or saved, so the run state written by the machine that holds the lease stays as it is. What the phase left in this machine's worktree was not touched. Run 'mw run ${e.card.id}' once this machine may drive the project again.`;
  progress(e, phase.id, "stopped", "lease", 0, reason);
  throw new LeaseLost(reason);
}

async function loop(e: Engine): Promise<void> {
  const { flow, state } = e;
  while (state.phase < flow.phases.length) {
    const phase = flow.phases[state.phase]!;
    if (e.stop?.aborted) throw stopped(e);
    if (e.opts.until === phase.id) {
      save(e);
      e.opts.onProgress?.(`stopped before '${phase.id}' (--until)`);
      return;
    }
    try {
      await e.hub.refresh();
    } catch (err) {
      return leaseLost(e, phase, (err as Error).message);
    }
    const vars = asExprVars(computeVars(contextOf(e)));
    if (phase.when && !evalExpr(phase.when, vars)) {
      record(e, { phase: phase.id, roles: [], outcome: "skipped", detail: `skipped: '${phase.when}' is false` });
      progress(e, phase.id, "skipped", "condition", 0);
      state.phase++;
      save(e);
      continue;
    }
    let waits: string | undefined;
    for (const stop of stopsOf(phase, stopContext(e))) {
      if (!evalExpr(stop.when, vars)) continue;
      const key = `${phase.id}:${stop.ask}`;
      if (!state.approvals.includes(key) && e.opts.approve?.includes(stop.ask)) state.approvals.push(key);
      if (!state.approvals.includes(key)) { waits = stop.ask; break; }
    }
    if (waits) return waitFor(e, phase, waits);
    const missing = phase.needs.filter((n) => !produced(e, n));
    if (missing.length) {
      const reason = `phase '${phase.id}' needs the output of ${missing.map((m) => `'${m}'`).join(", ")}, which does not exist; run those phases first`;
      record(e, { phase: phase.id, roles: [], outcome: "block", detail: reason });
      return block(e, phase, reason);
    }
    const refused = sandboxRefusal(e, phase);
    if (refused) {
      record(e, { phase: phase.id, roles: [], outcome: "block", detail: refused });
      progress(e, phase.id, "block", "sandbox", 0, refused);
      return block(e, phase, refused);
    }

    // REQ-usage-005: entries into each phase are counted per run, whatever route led here, so a loop
    // of named backward routes cannot spend without bound. The entry over the limit blocks the run.
    const visits = (state.visits ??= {});
    const limit = e.project.config.limits.phaseVisits;
    if ((visits[phase.id] ?? 0) + 1 > limit) {
      const reason = `phase '${phase.id}' was entered ${visits[phase.id]} time(s) in this run, the limit (limits.phase_visits: ${limit}), so entry ${(visits[phase.id] ?? 0) + 1} was not started: the flow is looping. Fix the cause, then run 'mw run ${e.card.id} --from <phase>' (which starts the count again) or raise limits.phase_visits.`;
      record(e, { phase: phase.id, roles: [], outcome: "block", detail: reason });
      progress(e, phase.id, "block", "phase visits", 0, reason);
      return block(e, phase, reason);
    }
    // The entry is counted and saved before the phase starts, so a crash or a kill mid-phase keeps it.
    visits[phase.id] = (visits[phase.id] ?? 0) + 1;
    save(e);

    const started = new Date().toISOString();
    const t0 = Date.now();
    const headBefore = e.flow.worktree ? branchHead(e.project.root, e.branch) : "";
    const seq = String(state.history.length + 1).padStart(2, "0");
    let r: PhaseResult;
    try {
      r = await withHeartbeat(e, () => executePhase(e, phase, seq));
    } catch (err) {
      if (err instanceof Stopped) {
        progress(e, phase.id, "stopped", "owner", Math.round((Date.now() - t0) / 1000), err.message);
        throw err;
      }
      if (err instanceof LeaseLost) return leaseLost(e, phase, err.message);
      if (err instanceof PhaseBlocked) {
        // REQ-engine-010: a block no route of the phase can pass; the run ends blocked here.
        const seconds = Math.round((Date.now() - t0) / 1000);
        record(e, { phase: phase.id, roles: [], outcome: "block", detail: err.message, started, seconds });
        progress(e, phase.id, "block", phase.action ?? "", seconds, err.message);
        return block(e, phase, err.message);
      }
      throw err;
    }
    const seconds = Math.round((Date.now() - t0) / 1000);
    // A phase paused for usage before any of its roles ran did not happen: running it again later is
    // the same entry, so the count taken above is given back. Once a role ran (`r.roles`), the phase
    // was entered and its roles run again on resume, so the entry counts.
    if (r.pause && r.roles.length === 0) {
      visits[phase.id] = Math.max(0, (visits[phase.id] ?? 1) - 1);
      save(e);
    }
    if (r.pause) {
      await setStatus(e, "waiting", "usage");
      record(e, { phase: phase.id, roles: r.roles, outcome: "waiting", detail: `usage: ${r.pause}`, started, seconds, usage: r.usage, usageBy: r.usageBy, ...(r.harness ? { harness: r.harness, model: r.model } : {}) });
      save(e);
      progress(e, phase.id, "waiting", "usage", seconds, r.pause);
      await safely(e, "notify", () => e.integrations.notify(`${e.card.id} paused for usage`, `${e.card.title}\n\n${r.pause}\n\nRun 'mw run ${e.card.id}' to continue when usage allows.`));
      save(e);
      return;
    }
    record(e, { phase: phase.id, roles: r.roles, outcome: r.outcome, detail: r.detail, started, seconds, usage: r.usage, usageBy: r.usageBy, ...(r.harness ? { harness: r.harness, model: r.model } : {}) });
    progress(e, phase.id, r.outcome, r.roles.join(", ") || (phase.gate ? `gate ${phase.gate}` : phase.action ?? ""), seconds, r.outcome === "ok" ? undefined : r.detail);
    const headAfter = e.flow.worktree ? branchHead(e.project.root, e.branch) : "";
    if (headAfter && headAfter !== headBefore) {
      try {
        await pushing(e, () => e.hub.pushBranch(e.branch));
      } catch (err) {
        if (err instanceof LeaseLost) return leaseLost(e, phase, err.message);
        throw err;
      }
    }

    if (r.outcome === "ok") {
      state.phase++;
    } else {
      // REQ-gate-004: a failed re-gate at the merge goes to remediation, as a failed gate does.
      const route = r.remediate && flow.remediate ? "remediate" : phase.on[r.outcome] ?? "stop";
      if (route === "continue") state.phase++;
      else if (route === "stop") return block(e, phase, r.detail);
      else if (route === "remediate") {
        const max = flow.remediate?.maxRounds ?? e.project.config.limits.rounds;
        if (!flow.remediate || state.round >= max) return block(e, phase, `remediation budget spent (${max} round(s)); last failure: ${r.detail}`);
        state.round++;
        state.remediation = r.detail;
        state.phase = flow.phases.findIndex((p) => p.id === flow.remediate!.phase);
      } else {
        const idx = flow.phases.findIndex((p) => p.id === route);
        if (idx < 0) return block(e, phase, `phase '${phase.id}' routes '${r.outcome}' to '${route}', which is not a phase of flow '${flow.id}'`);
        state.phase = idx;
      }
    }
    save(e);
  }
  if (state.merged && state.worktree) {
    try {
      removeWorktree(e.project, e.card.id); // moved to .mergewright/local/discarded/, kept seven days
      state.worktree = undefined;
    } catch (err) {
      if (!(err instanceof MwError)) throw err;
      state.warnings.push(`the worktree was not removed: ${err.message}`);
    }
  }
  await setStatus(e, "done");
  save(e);
  e.opts.onProgress?.(`${e.card.id} done${state.merged ? `: merged as ${state.merged.slice(0, 10)}` : ""}`);
  await safely(e, "notify", () => e.integrations.notify(`${e.card.id} is done`, `${e.card.title}\n\n${state.merged ? `Merged into ${e.base} as ${state.merged}.` : `Finished without a merge; branch ${e.branch} is kept.`}`));
  save(e);
}


// ── Entry points ────────────────────────────────────────────────────────────────────────────

function engineFor(project: Project, cardId: string, state: RunState | undefined, opts: RunOptions, deps: EngineDeps): Engine & { fresh: boolean } {
  const card = project.card(cardId);
  const flow = flowOf(project, state?.flow ?? project.flowFor(card));
  const dir = runDir(project, cardId);
  const st = state ?? newState(card.id, flow.id);
  return {
    project, card, flow, fresh: !state,
    state: st,
    runDir: dir,
    base: project.config.git.base,
    branch: branchName(cardId),
    hub: deps.hub ?? hubFor(project),
    integrations: deps.integrations ?? integrationsFor(project),
    opts,
    stop: deps.stop,
    artifacts: artifactStore(dir, st, () => saveState(dir, st)),
    save() { saveState(this.runDir, this.state); },
  };
}

/**
 * Remove a previous (aborted) run's files so a fresh run starts clean. A `lock` file an older runtime
 * kept here is left alone (locks now live in `.mergewright/local/locks/`).
 */
function clearRunDir(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) if (name !== "lock") fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

/**
 * Going back to phase `at` starts a new generation. Approvals for that phase and
 * every later one are dropped, and so are the artifacts those phases produced (from the state, from
 * `values`, the verified artifacts the run continues with, and their plain copies), so conditions and
 * `needs` see them as absent and a stop point asks again. The history keeps every entry for audit, and
 * the hash-named files stay in artifacts/.
 */
function newGeneration(e: Engine, at: number, values: Map<ArtifactKind, unknown>): void {
  const later = e.flow.phases.slice(at);
  const ids = new Set(later.map((p) => p.id));
  e.state.approvals = e.state.approvals.filter((a) => !ids.has(a.slice(0, a.indexOf(":"))));
  const kinds = new Set<ArtifactKind>();
  const roles = e.project.roles();
  for (const p of later) {
    if (p.gate) kinds.add("gate");
    for (const id of [p.role, ...p.also.map((x) => x.role)]) {
      const out = id ? roles.get(id)?.output : undefined;
      if (out && out !== "text") kinds.add(out);
    }
  }
  for (const kind of ARTIFACT_KINDS) {
    if (!kinds.has(kind)) continue;
    values.delete(kind);
    // The plain copy goes first: a crash before the state is saved leaves a copy the next run rewrites.
    fs.rmSync(path.join(e.runDir, `${kind}.json`), { force: true });
    if (e.state.artifacts) delete e.state.artifacts[kind];
  }
  save(e);
}

/**
 * The run state as the runtime last saved it. Known limitation: without a
 * separate operating-system user or a working sandbox, a worker runs as the same user as the runtime
 * and could edit this file (its phase, its approvals, the artifact hashes), and could read the secrets
 * file too. What it cannot do with such an edit is merge unchecked code: the merge itself requires a
 * passing gate and a review recorded for the branch head it merges (see `mergeEvidence` above), and a
 * recorded `pendingMerge` is accepted as finished only when it is that head's work merged onto the base
 * (`pendingMergeProblem` in actions.ts).
 */
function readRunState(project: Project, cardId: string): RunState | undefined {
  const s = loadState(runDir(project, cardId));
  return s?.status === "aborted" ? undefined : s; // an aborted run starts over
}

/** Whether a run in `s` stops at once: done, or waiting for an approval that was not given. */
function stopsAtOnce(s: RunState, flow: Flow, opts: RunOptions, granted?: string): boolean {
  if (s.status === "done") return true;
  if (s.status !== "waiting" || s.reason === "usage") return false;
  return !flow.phases[s.phase] || !(opts.approve?.includes(s.reason ?? "") || granted === s.reason);
}

/**
 * Remove per-run Codex homes (`.mergewright/local/codex-home/<card>/`, spec 8.6) whose card has no live
 * run on this machine: a run killed hard (SIGKILL, power loss) never ran their clean-up, and each holds
 * a copy of the owner's Codex login. A card whose run lock another live process holds is kept. Called
 * at the start of every run, after its lock is taken (so its own card's leftovers go too: this run has
 * started no Codex agent yet). Returns one line per removal.
 */
export function sweepCodexHomes(project: Project): string[] {
  const root = path.join(localDir(project), "codex-home");
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  // The check of each candidate's run lock and the deletion of its home happen
  // under the registry's guard, which every process takes to register a run (acquireLock): no run can
  // start for that card between the two.
  withGuardSync(locksDir(project), "sweep", () => {
    for (const name of names) {
      if (lockHolder(lockFile(project, name))) continue; // another process here is running that card
      // An empty card folder holds no login; it is removed without a warning.
      try {
        const dir = path.join(root, name);
        if (fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
          continue;
        }
      } catch {
        // judged below like any other entry
      }
      try {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
        out.push(`removed ${project.rel(path.join(root, name))}, a per-run Codex home left behind by an earlier run of ${name} that ended without its clean-up`);
      } catch (err) {
        out.push(`could not remove ${project.rel(path.join(root, name))}, a per-run Codex home left behind by an earlier run of ${name}: ${(err as Error).message}`);
      }
    }
  });
  return out;
}

export interface PruneResult {
  /** Cards whose worktree and local branch were removed. */
  removed: string[];
  /** Cards that are done but whose worktree was kept, with the reason. */
  kept: string[];
}

/**
 * Remove what finished cards left on this machine: for every registered worktree under
 * `.mergewright/worktrees/` whose card file on the base branch says `status: done`, verify it, require
 * it to be clean, then move the worktree to `.mergewright/local/discarded/` (kept seven days) and
 * delete the local `card/<ID>` branch. Called at the start of every run, and by `mw sync` after a
 * successful sync.
 */
export function pruneFinished(project: Project): PruneResult {
  const out: PruneResult = { removed: [], kept: [] };
  const root = project.root;
  const base = project.config.git.base;
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const home = real(path.join(project.workDir, "worktrees"));
  for (const w of worktrees(root)) {
    if (path.dirname(real(w.path)) !== home) continue;
    const id = path.basename(w.path);
    let file: string;
    try {
      file = project.card(id).file;
    } catch {
      file = `cards/${id}.card.md`;
    }
    const shown = git(root, ["show", `refs/heads/${base}:${file}`], { allowFail: true });
    if (shown.code !== 0 || parseFrontmatter(shown.stdout).data.status !== "done") continue;
    const v = verifiedWorktree(project, id);
    if (!v.ok) { out.kept.push(`${id}: ${v.why}`); continue; }
    const dirty = dirtyFiles(v.path);
    if (dirty.length) { out.kept.push(`${id}: ${id} is done, but its worktree ${v.path} has uncommitted changes (${dirty.join(", ")}); keep what you need and commit or delete those changes; the next run or 'mw sync' then moves the worktree to .mergewright/local/discarded/`); continue; }
    try {
      removeWorktree(project, id); // moved to .mergewright/local/discarded/, kept seven days
    } catch (err) {
      if (!(err instanceof MwError)) throw err;
      out.kept.push(`${id}: ${err.message}`);
      continue;
    }
    deleteBranch(root, branchName(id));
    out.removed.push(id);
  }
  return out;
}

/** Start or continue the run of a card. Returns the state it ended in. */
export async function runCard(project: Project, cardId: string, opts: RunOptions = {}, deps: EngineDeps = {}): Promise<RunState> {
  return start(project, cardId, opts, deps);
}

/** `granted`: the approval word `mw approve` gives the stop point the run waits at (only that one). */
async function start(project: Project, cardId: string, opts: RunOptions, deps: EngineDeps, granted?: string): Promise<RunState> {
  // REQ-config-001: never on a config that fell back to its defaults (fresh start and resume alike).
  project.assertRunnable();
  // A first look that writes nothing. The state the run works with is read again once the lock is held.
  const peek = readRunState(project, cardId);
  const first = engineFor(project, cardId, peek, opts, deps);
  let { policy } = sandboxPolicy(project.config.agents.sandbox); // an invalid MW_SANDBOX stops here
  if (opts.until && !first.flow.phases.some((p) => p.id === opts.until)) {
    throw new MwError("usage", `flow '${first.flow.id}' has no phase '${opts.until}' (its phases: ${first.flow.phases.map((p) => p.id).join(", ")})`);
  }
  if (opts.from && !first.flow.phases.some((p) => p.id === opts.from)) {
    throw new MwError("usage", `flow '${first.flow.id}' has no phase '${opts.from}' (its phases: ${first.flow.phases.map((p) => p.id).join(", ")})`);
  }
  if (opts.from && peek?.merged) {
    throw new MwError("run/merged", `${cardId} is already merged into ${first.base}, so it cannot go back to '${opts.from}'. Make a new card for further changes.`);
  }
  // REQ-cards-003: a fresh run (a dry run too) starts only for a lint-clean card, before the lock, the
  // lease or any phase; resuming a run in progress is not linted again.
  if (first.fresh) assertCardReady(project, first.card, `${cardId} was not started`);
  if (opts.dryRun) {
    if (peek) first.artifacts = artifactStore(first.runDir, peek, () => {}, verifyArtifacts(first.runDir, peek).values);
    await dryRun(first);
    return first.state;
  }
  // A project with a hub never runs offline (the other machine could run the same card).
  if (opts.offline && first.hub.enabled) throw offlineRefused(project.config.git.hub);
  if (peek && !opts.from && stopsAtOnce(peek, first.flow, opts, granted)) return peek;
  requireOnBase(project.root, first.base);
  // Lock first, lease second: the lock registers the run in this machine's
  // registry of active runs, so no automatic release of the lease by another 'mw' process here can
  // take the lease away from under it. A machine that is then refused the lease releases its lock and
  // has written nothing under .mergewright/runs/. The lock is this machine's own (.mergewright/local/locks/).
  const lock = lockFile(project, cardId);
  // The hub that takes the lease is kept; the integrations are made from the project as loaded after it.
  const shared = { hub: first.hub, integrations: deps.integrations, stop: deps.stop };
  const release = acquireLock(lock, cardId);
  let refused = false;
  try {
    // Never while processes an earlier run of this card left behind are alive.
    assertNoOrphans(project, cardId);
    await first.hub.prepare({ offline: opts.offline });
    // prepare() may have adopted a newer mergewright.yaml and newer cards from the hub, so the run
    // works with the project as it is now. REQ-config-001: its config must still pass its schema,
    // fresh run or resumed, before anything of the run is written (the sweep below included) and
    // before any phase. REQ-cards-003: a fresh run lints the card again as it is now.
    const now = new Project(project.root);
    try {
      now.assertRunnable();
      if (!readRunState(now, cardId)) assertCardReady(now, now.card(cardId), `${cardId} was not started`);
    } catch (err) {
      refused = true;
      throw err;
    }
    project = now;
    policy = sandboxPolicy(project.config.agents.sandbox).policy;
    const e = engineFor(project, cardId, readRunState(project, cardId), opts, shared);
    // REQ-engine-005: the run folder is private (0700, its files 0600) before anything is written into
    // it, also when an earlier runtime left it wider.
    privateRunDir(e.runDir);
    // Per-run Codex homes a hard-killed run left behind (they hold a copy of the login).
    const swept = sweepCodexHomes(project);
    // REQ-engine-006: MCP configs a hard-killed run of this card left in its scratch folder (this run has
    // started no agent yet).
    fs.rmSync(path.join(localDir(project), "scratch", cardId), { recursive: true, force: true });
    const s = e.state;
    let rewound: number | undefined;
    if (opts.from && !s.merged && s.pendingMerge) {
      // A merge interrupted after its commit reached the base is finished, not
      // undone: going back would redo the work on a branch the clean-up then deletes.
      // Only a recorded merge that is the card's checked work counts as one.
      let why: string | undefined;
      if (isAncestor(project.root, s.pendingMerge, `refs/heads/${e.base}`)) {
        const verified = verifyArtifacts(e.runDir, s);
        const probe: Engine = { ...e, artifacts: artifactStore(e.runDir, s, () => {}, verified.values) };
        why = verified.bad.length ? `run files were changed outside the runtime (${verified.bad.join(", ")})` : pendingMergeProblem(probe, (h) => mergeEvidence(probe, h).refuse);
      } else why = "it never reached the base";
      if (!why) {
        s.merged = s.pendingMerge;
        s.pendingMerge = undefined;
        s.pendingMergeHead = undefined;
        s.cleanupPending = true;
        save(e);
        throw new MwError("run/merged", `${cardId} was already merged into ${e.base} as ${s.merged.slice(0, 10)} (by a merge that was interrupted before it was recorded), so it cannot go back to '${opts.from}'. Run 'mw run ${cardId}' to finish the clean-up after that merge, and make a new card for further changes.`);
      }
      if (why !== "it never reached the base") {
        const w = `the recorded merge ${s.pendingMerge.slice(0, 10)} was set aside when going back to '${opts.from}': it is on ${e.base}, but ${why}`;
        s.warnings.push(w);
        e.opts.onProgress?.(w);
      }
      s.pendingMerge = undefined; // not the card's merge: the merge is built again from the redone work
      s.pendingMergeHead = undefined;
    }
    if (opts.from && !s.merged) {
      const at = e.flow.phases.findIndex((p) => p.id === opts.from);
      const redo = e.flow.remediate ? e.flow.phases.findIndex((p) => p.id === e.flow.remediate!.phase) : -1;
      s.phase = at;
      s.status = "running";
      s.reason = undefined;
      s.remediation = undefined;
      // Going back to (or before) the phase that fix rounds return to gives the card its rounds back.
      if (redo < 0 || at <= redo) s.round = 0;
      s.visits = undefined; // the owner's rewind starts the phase-visit count again (REQ-usage-005)
      rewound = at;
      e.opts.onProgress?.(`going back to '${opts.from}' at the owner's request`);
    } else if (stopsAtOnce(s, e.flow, opts, granted)) return s;
    if (s.status === "waiting" && s.reason !== "usage") s.approvals.push(`${e.flow.phases[s.phase]!.id}:${s.reason}`);
    // REQ-engine-009: the integration queue is not retried here, under the card's lock and the lease:
    // `mw work` retries it after dispatching the card, `mw run` and `mw approve` once they return.
    if (e.fresh) clearRunDir(e.runDir);
    else {
      const { bad, values, stale } = verifyArtifacts(e.runDir, s);
      if (bad.length) {
        await setStatus(e, "blocked", `run files were changed outside the runtime (${bad.join(", ")}), so they cannot be trusted. Restore them, or run 'mw abort ${cardId}' and then 'mw run ${cardId}' to start the card again.`);
        save(e);
        return s;
      }
      rewritePlainCopies(e.runDir, stale); // the plain copies are for people; the hash-named files decide
      if (rewound !== undefined) newGeneration(e, rewound, values);
      e.artifacts = artifactStore(e.runDir, s, () => save(e), values);
    }
    s.host = hostName();
    for (const line of swept) {
      s.warnings.push(line);
      e.opts.onProgress?.(line);
    }
    // The policy 'off' is recorded once, at the start; 'auto' and 'required' record what the probe said.
    s.sandbox = policy === "off" ? SANDBOX_OFF : s.sandbox === SANDBOX_OFF ? undefined : s.sandbox;
    try {
      const pruned = pruneFinished(project);
      for (const k of pruned.kept) {
        const w = `a finished card's worktree was kept: ${k}`;
        if (!s.warnings.includes(w)) s.warnings.push(w);
      }
    } catch (err) {
      s.warnings.push(`removing finished cards' worktrees failed: ${(err as Error).message}`);
    }
    try {
      cleanDiscarded(project);
    } catch (err) {
      s.warnings.push(`removing old discarded worktrees failed: ${(err as Error).message}`);
    }
    await setStatus(e, "running");
    if (e.flow.worktree && !s.merged) {
      const r = await ensureWorktree(project, cardId, e.base, e.hub);
      if (r.discarded) {
        s.warnings.push(`the card's worktree could not be continued (leftovers of an unfinished phase after its branch moved on, or something at its place that is not this card's worktree), so it was moved to ${project.rel(r.discarded)}, where it is kept for seven days, and a fresh worktree was made from branch ${e.branch}`);
      }
      if (r.blocked) {
        await setStatus(e, "blocked", r.blocked);
        save(e);
        e.opts.onProgress?.(`blocked: ${r.blocked}`);
        return s;
      }
      s.branch = e.branch;
      s.worktree = cardWorktreePath(project, cardId);
    }
    save(e);
    await loop(e);
    return s;
  } finally {
    release();
    // A start refused after prepare() (an invalid config, or a fresh card's lint) hands back the lease
    // prepare() took, as the end of a run does (after the lock, so this run no longer counts as busy).
    // A failed release does not hide the error: the lease then expires by itself.
    if (refused) {
      try {
        await releaseUnlessBusy(project, async () => {
          if ((await first.hub.lease())?.host === hostName()) await first.hub.release();
        });
      } catch (err) {
        opts.onProgress?.(`the lease could not be released: ${(err as Error).message}. It expires by itself, or run 'mw lease release'.`);
      }
    }
  }
}

/** Record an approval for the stop point the run waits at, then continue the run. */
export async function approve(project: Project, cardId: string, word: string, opts: RunOptions = {}, deps: EngineDeps = {}): Promise<RunState> {
  project.card(cardId);
  const dir = runDir(project, cardId);
  const state = loadState(dir);
  if (!state) throw new MwError("run/none", `${cardId} has no run yet; start it with 'mw run ${cardId}'`);
  const flow = flowOf(project, state.flow);
  const phase = flow.phases[state.phase];
  if (state.status !== "waiting" || state.reason === "usage" || !phase) {
    throw new MwError("run/not-waiting", `${cardId} is not waiting for an approval (its run is ${state.status}${state.reason === "usage" ? ", paused for usage" : ""}); 'mw run ${cardId}' continues it`);
  }
  if (word !== state.reason) {
    throw new MwError("run/wrong-approval", `${cardId} is waiting before '${phase.id}' for '${state.reason}', not '${word}'; run 'mw approve ${cardId} ${state.reason}' to continue`);
  }
  if (lockHolder(lockFile(project, cardId))) throw new MwError("run/locked", `${cardId} is being run by another process; wait for it to finish`);
  // Nothing is written here: the approval is recorded by the run itself once it holds the lease.
  return start(project, cardId, opts, deps, word);
}

/**
 * Stop a run: status `aborted`, worktree moved to `.mergewright/local/discarded/` (kept there for seven
 * days); the branch is kept unless `force`. Without `force`, uncommitted work in the worktree is first
 * committed to the branch (`<CARD>: work in progress (abort)`), so the branch holds everything. Takes
 * the run lock, then the lease when the project has a hub; with `force`, a lease another machine holds
 * is taken over (`took` then names that machine).
 *
 * While a process group recorded in the card's orphans file (`.mergewright/local/locks/<CARD>.orphans`,
 * spec 8.7) is alive, it may still write into the worktree, so the worktree stays where it is: `force`
 * is refused (`run/orphans-alive`) before anything changes, and a plain abort marks the run aborted,
 * leaves the worktree and the branch alone, and reports the processes (`orphans`).
 */
export async function abort(project: Project, cardId: string, opts: { force?: boolean; offline?: boolean } = {}, deps: EngineDeps = {}): Promise<RunState & { took?: string; discarded?: string; orphans?: string }> {
  const dir = runDir(project, cardId);
  const peek = loadState(dir);
  if (!peek) throw new MwError("run/none", `${cardId} has no run to abort`);
  if (peek.status === "done") throw new MwError("run/done", `${cardId} is already done; there is nothing to abort`);
  const lock = lockFile(project, cardId);
  const holder = lockHolder(lock);
  if (holder) throw new MwError("run/locked", `${cardId} is being run by process ${holder.pid}; stop that process first, then abort`);
  const hub = deps.hub ?? hubFor(project);
  // The lock first, as for a run: this machine's registry shows the card as
  // busy before the lease is taken, so no automatic release by another 'mw' process here removes it.
  const release = acquireLock(lock, cardId);
  try {
    const orphans = liveOrphans(project, cardId);
    const stopFirst = orphans && `stop it first (for example 'kill -KILL -- -${orphans.groups[0]!.pgid}')`;
    if (orphans && opts.force) {
      throw new MwError("run/orphans-alive", `${cardId} was not aborted: ${orphans.described}, left running by an earlier run of this card (recorded ${orphans.written} in ${orphans.file}), is still alive and may still be writing into the worktree, which --force would move aside and whose branch it would delete. Nothing was changed; ${stopFirst}, then run 'mw abort ${cardId} --force' again.`);
    }
    // --force: the owner stops the card whatever another machine is doing, so a lease held elsewhere is
    // taken over (the other machine then stops at its next lease check). Plain abort is refused instead.
    let took: string | undefined;
    if (opts.force && !opts.offline && !deps.hub) {
      const h = openHub(project);
      if (h.enabled) {
        const r = await h.take({ force: true });
        if (r.previous && r.previous.host !== hostName()) took = r.previous.host;
      }
    }
    await hub.prepare({ offline: opts.offline });
    const state = loadState(dir) ?? peek;
    const e = engineFor(project, cardId, state, {}, { hub, integrations: deps.integrations });
    const wt = cardWorktreePath(project, cardId);
    if (orphans) {
      const note = `${orphans.described}, left running by an earlier run of ${cardId} (recorded in ${orphans.file}), is still alive, so the worktree was left where it is and nothing was committed; ${stopFirst}, then run 'mw abort ${cardId}' again to move the worktree aside`;
      await setStatus(e, "aborted", `aborted; branch ${e.branch} kept; worktree left in place while an orphaned process lives`);
      save(e);
      return { ...state, took, orphans: note };
    }
    if (fs.existsSync(wt) && !opts.force) {
      const v = verifiedWorktree(project, cardId);
      if (!v.ok) throw new MwError("worktree/unsafe", `${v.why}. Nothing was aborted; repair it by hand, or run 'mw abort ${cardId} --force', which moves it aside to .mergewright/local/discarded/.`);
      if (dirtyFiles(v.path).length && commitAll(v.path, `${cardId}: work in progress (abort)`)) await e.hub.pushBranch(e.branch);
    }
    const discarded = removeWorktree(project, cardId);
    state.worktree = undefined;
    if (opts.force) {
      deleteBranch(project.root, e.branch);
      await e.hub.deleteBranch(e.branch);
      state.branch = undefined;
    }
    await setStatus(e, "aborted", opts.force ? "aborted; branch deleted" : `aborted; branch ${e.branch} kept`);
    save(e);
    return { ...state, took, discarded: discarded && project.rel(discarded) };
  } finally {
    release();
  }
}

/**
 * Before the owner (or an assistant) moves a card between `todo` and `ready`, a run of it that
 * is `blocked` is aborted as `mw abort` does without `--force` (uncommitted work committed to the
 * branch, the worktree moved aside, the branch kept), and the record of a `blocked` or `aborted` run is
 * moved aside to `.mergewright/local/discarded/<CARD>-run-<time>` (kept seven days), so the card file,
 * `mw status` and the board show one status and `mw work` can pick the card up again. Any other run
 * (running, waiting, done) is left alone. Returns one line saying what was done, or undefined.
 */
export async function setAsideRun(project: Project, cardId: string, deps: EngineDeps = {}): Promise<string | undefined> {
  const dir = runDir(project, cardId);
  const peek = loadState(dir);
  if (!peek || (peek.status !== "blocked" && peek.status !== "aborted")) return undefined;
  const notes: string[] = [];
  if (peek.status === "blocked") {
    const r = await abort(project, cardId, {}, deps);
    if (r.orphans) return `its blocked run was marked aborted, but ${r.orphans}; the run record was kept`;
    notes.push(`its blocked run was aborted (${r.discarded ? `worktree moved to ${r.discarded}` : "no worktree on this machine"}; branch ${r.branch ?? branchName(cardId)} kept)`);
  }
  const release = acquireLock(lockFile(project, cardId), cardId);
  let moved: string | undefined;
  try {
    const now = loadState(dir);
    if (now?.status !== "aborted") return notes.join("; ") || undefined; // someone started it again meanwhile
    moved = discardRunDir(project, cardId);
  } finally {
    release();
  }
  if (moved) notes.push(`the run record was moved to ${project.rel(moved)}`);
  return notes.join("; ");
}

/**
 * Show a card's file status on the board after a status change (best effort: the board catches up at
 * the next `mw cards mirror` or `mw work` on the machine where it answers). Returns a note, if any.
 */
export async function mirrorCardStatus(project: Project, cardId: string, status: string, deps: EngineDeps = {}): Promise<string | undefined> {
  try {
    const card = project.card(cardId);
    return (await (deps.integrations ?? integrationsFor(project)).mirrorCard(card.id, card.title, status)) || undefined;
  } catch (err) {
    return `the board was not updated: ${(err as Error).message}`;
  }
}

export interface CardStatusRow {
  id: string;
  title: string;
  /** The run's status when a run exists, else the card file's. */
  status: string;
  flow: string;
  /** The phase the run is at ("-" when there is no run or it finished). */
  phase: string;
  reason?: string;
  /** Agent usage of the run so far (absent when nothing was reported): see `usageTotals`. */
  usage?: UsageTotals;
  /** The harness and model each role of the run last ran with (absent when none ran). */
  agents?: AgentUse[];
}

export interface AgentUse {
  role: string;
  harness: string;
  model: string;
}

/** The harness and model each role of a run last ran with, in the order they first ran. */
export function agentsOf(state: RunState): AgentUse[] {
  const out = new Map<string, AgentUse>();
  for (const h of state.history) {
    for (const role of h.roles) {
      const harness = h.harness?.[role];
      if (harness) out.set(role, { role, harness, model: h.model?.[role] ?? "default" });
    }
  }
  return [...out.values()];
}

/** A harness's usage in `mw status --json`: Claude reports a price, Codex only tokens. */
export interface HarnessUsage {
  /** All input (fresh + cache-write + cache-read). */
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** The split of the input and the turns, each present only when a phase of the harness reported it. */
  freshInputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  turns?: number;
}

export interface UsageTotals {
  byHarness: Record<string, HarnessUsage>;
  /**
   * One line, e.g. "Claude $0.42; Codex 12,000 in / 800 out tokens", with the input split and turns
   * after a harness that reported them: "Claude $1.52 (input 54 fresh, 1,452,430 cached: 73,426
   * written, 1,379,004 read; 12 turns)".
   */
  summary: string;
}

/** Claude and Codex by name; any other harness (a package's too) by its id. */
const harnessName = (h: string) => (h === "claude" ? "Claude" : h === "codex" ? "Codex" : h);

/**
 * A run's agent usage per harness, summed over its history. A harness that reported a price is shown
 * by its price, one that did not (Codex, or a package harness that reports tokens) by its tokens only. A harness
 * that reported neither is left out. Entries saved before usage was kept per harness count as
 * "unattributed". Undefined when no usage was reported at all.
 */
export function usageTotals(state: RunState): UsageTotals | undefined {
  const sums: Record<string, Usage> = {};
  for (const h of state.history) {
    const by = h.usageBy ?? (h.usage ? { unattributed: h.usage } : {});
    for (const [k, u] of Object.entries(by)) {
      const t = addUsage(sums[k], u);
      if (t) sums[k] = t;
    }
  }
  const keys = Object.keys(sums).sort((a, b) => (a === "claude" ? -1 : b === "claude" ? 1 : a.localeCompare(b)));
  if (!keys.length) return undefined;
  const byHarness: Record<string, HarnessUsage> = {};
  const parts: string[] = [];
  const n = (x: number | undefined) => (x ?? 0).toLocaleString("en-US");
  for (const k of keys) {
    const u = sums[k]!;
    if (u.costUsd !== undefined) {
      byHarness[k] = { ...u };
      parts.push(`${harnessName(k)} $${u.costUsd.toFixed(2)}${splitText(u)}`);
    } else if (u.inputTokens !== undefined || u.outputTokens !== undefined) {
      byHarness[k] = { ...u };
      parts.push(`${harnessName(k)} ${n(u.inputTokens)} in / ${n(u.outputTokens)} out tokens${splitText(u)}`);
    }
  }
  if (!parts.length) return undefined;
  return { byHarness, summary: parts.join("; ") };
}

/**
 * The input split and turns of a harness's totals, for the summary line: cached (cache-write +
 * cache-read) and fresh input separately. Empty when the harness reported no split.
 */
function splitText(u: Usage): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const bits: string[] = [];
  const kinds: string[] = [];
  if (u.freshInputTokens !== undefined) kinds.push(`${n(u.freshInputTokens)} fresh`);
  if (u.cacheWriteTokens !== undefined || u.cacheReadTokens !== undefined) {
    const w = u.cacheWriteTokens ?? 0, r = u.cacheReadTokens ?? 0;
    kinds.push(`${n(w + r)} cached: ${n(w)} written, ${n(r)} read`);
  }
  if (kinds.length) bits.push(`input ${kinds.join(", ")}`);
  if (u.turns !== undefined) bits.push(`${n(u.turns)} turn${u.turns === 1 ? "" : "s"}`);
  return bits.length ? ` (${bits.join("; ")})` : "";
}

export function cardStatuses(project: Project): CardStatusRow[] {
  return project.cards().map((card) => statusRow(project, card, safeState(project, card.id)));
}

/** A card's run state, or undefined when it has none or it cannot be read. */
export function safeState(project: Project, cardId: string): RunState | undefined {
  try {
    return loadState(runDir(project, cardId));
  } catch {
    return undefined;
  }
}

/** One card's row of `mw status --json`, from its run state (undefined: no run). */
export function statusRow(project: Project, card: Card, state: RunState | undefined): CardStatusRow {
  if (!state) return { id: card.id, title: card.title, status: card.status, flow: project.flowFor(card), phase: "-" };
  const phase = state.status === "done" || state.status === "aborted" ? "-" : project.flows().get(state.flow)?.phases[state.phase]?.id ?? "-";
  // Merged (the card file says done) but the flow did not finish.
  // REQ-engine-014: a run that says running but no process drives is queued.
  const status = card.status === "done" && state.status !== "done" && state.status !== "aborted" ? "done (run unfinished)" : runDrive(project, state)?.label ?? state.status;
  const usage = usageTotals(state);
  const agents = agentsOf(state);
  return { id: card.id, title: card.title, status, flow: state.flow, phase, reason: state.reason, ...(usage ? { usage } : {}), ...(agents.length ? { agents } : {}) };
}

/** One or two sentences saying where a run is and what to do next. */
export function describeRun(project: Project, state: RunState): string {
  const id = state.card;
  const phase = project.flows().get(state.flow)?.phases[state.phase]?.id ?? "the end";
  switch (state.status) {
    case "done":
      return state.merged ? `${id} is done: merged into ${project.config.git.base} as ${state.merged.slice(0, 10)}.` : `${id} is done; nothing was merged and branch ${branchName(id)} is kept.`;
    case "waiting":
      if (state.reason === "usage") {
        const last = [...state.history].reverse().find((h) => h.outcome === "waiting");
        return `${id} is paused before '${phase}' because agent usage is too high (${last?.detail.replace(/^usage: /, "") ?? "no detail"}). Run 'mw run ${id}' to continue when usage allows.`;
      }
      if (state.reason === CONDITIONS && state.conditions?.length) {
        return `${id} is waiting before '${phase}': the adjudicator approved on conditions, to be met before the merge:\n${renderConditions(state.conditions)}\nMeet them, then run 'mw approve ${id} ${CONDITIONS}' to continue.`;
      }
      return `${id} is waiting before '${phase}' for approval '${state.reason}'. Run 'mw approve ${id} ${state.reason}' to continue.`;
    case "blocked":
      return `${id} is blocked at '${phase}': ${state.reason ?? "(no reason recorded)"}\nFix the cause, then run 'mw run ${id}' to retry that phase.`;
    case "aborted":
      return `${id} was aborted (${state.reason ?? ""}). 'mw run ${id}' starts it again from the beginning.`;
    case "running": {
      // A run a live process holds is in progress, not "stopped" (a run left with
      // --until, or by a process that died, has no live lock and is described as stopped).
      const drive = runDrive(project, state)!;
      if (drive.holder) return `${id} is running: phase ${phase} (round ${state.round}) since ${state.updated} on ${state.host} (process ${drive.holder.pid}).`;
      if (drive.status === "running") return `${id} is running: phase ${phase} (round ${state.round}) since ${state.updated} on ${state.host}.`;
      return `${id} stopped before '${phase}'. Run 'mw run ${id}' to continue.`;
    }
    default:
      return `${id} stopped before '${phase}'. Run 'mw run ${id}' to continue.`;
  }
}

async function dryRun(e: Engine): Promise<void> {
  const out = (l: string) => e.opts.onProgress?.(l);
  const quiet: Engine = { ...e, integrations: { ...e.integrations, recall: async () => [] } };
  const vars = asExprVars(computeVars(contextOf(quiet)));
  const ctx = stopContext(e);
  out(`dry run of ${e.card.id} through flow '${e.flow.id}' from phase '${e.flow.phases[e.state.phase]?.id ?? "(end)"}'; nothing is executed`);
  for (const p of e.flow.phases.slice(e.state.phase)) {
    const notes: string[] = [];
    if (p.when) notes.push(`when ${p.when} (now ${evalExpr(p.when, vars)})`);
    const plan = stopPlan(p, ctx);
    for (const stop of plan.stops) notes.push(`stops for '${stop.ask}' when ${stop.when} (now ${evalExpr(stop.when, vars)})`);
    if (plan.added.length) notes.push(`${plan.added.map((w) => `'${w}'`).join(" and ")} added by the runtime because the card's risk is ${ctx.risk}`);
    const note = notes.length ? `  [${notes.join("; ")}]` : "";
    if (p.gate) out(`${p.id.padEnd(10)} gate ${p.gate}${note}`);
    const roles = p.role ? [{ role: p.role, when: undefined as string | undefined }, ...p.also] : [];
    for (const r of roles) {
      const role = roleOf(e, r.role);
      let size: string;
      try {
        size = `~${estimateTokens(await renderRolePrompt(quiet, role))} tokens`;
      } catch (err) {
        size = `prompt not renderable: ${(err as Error).message}`;
      }
      const cond = r.when ? ` (only when ${r.when}: now ${evalExpr(r.when, vars)})` : "";
      out(`${p.id.padEnd(10)} ${role.id.padEnd(14)} ${role.runs}${role.model ? `/${role.model}` : ""} ${role.mode}, ${size}${cond}${note}`);
    }
    if (p.action) out(`${p.id.padEnd(10)} action ${p.action}${p.role ? "" : note}`);
  }
}
