// Frozen interfaces between the engine, the harnesses, the hub and the integrations.
// See docs/design/engine.md. Change these only by agreement: several modules are built against them.
import type { Risk } from "../expr.ts";
import type { McpWiring } from "../mcpconfig.ts";
import type { Outcome } from "../model/flow.ts";
import type { Mode, OutputKind, Role } from "../model/role.ts";

// ── Harness ─────────────────────────────────────────────────────────────────────────────────

export interface HarnessRequest {
  role: Role;
  /** The fully rendered prompt. */
  prompt: string;
  /** Directory the agent works in (the card's worktree, or the project root). */
  cwd: string;
  mode: Mode;
  outputKind: OutputKind;
  /** JSON Schema the reply must satisfy; undefined for `text` output. */
  outputSchema?: object;
  /** Path of that schema on disk, for CLIs that take a file. */
  outputSchemaFile?: string;
  limits: { turns?: number; minutes: number };
  /** MCP servers for this role, already resolved; undefined when none apply. */
  mcp?: McpWiring;
  /** Extra environment for the agent process (MW_ROLE, MW_CARD, MW_MODE, MW_RUN_DIR, MCP variables). */
  env: Record<string, string>;
  /** The run directory; a harness may write scratch files here (prefix them with `label`). */
  runDir: string;
  /** Unique within the run, safe as a file name, e.g. `3-review-reviewer`. */
  label: string;
  /**
   * Aborted when the run must stop now (this machine lost the lease, or the owner aborted).
   * A harness must kill its agent process when this fires and return `{ok: false, error}`.
   */
  signal?: AbortSignal;
  /**
   * Whether a write-mode `claude` agent runs in Claude Code's shell sandbox, as the engine decided from
   * the sandbox policy (spec 8.6). Undefined outside a card run: the harness then decides by the policy
   * and the probe itself.
   */
  sandbox?: boolean;
  /**
   * REQ-engine-006: the secret values (configured `key_env` and MCP variables, `secretsFor`) that every
   * file the harness writes into the run directory has replaced by `[redacted]`. Never logged.
   */
  secrets?: readonly string[];
}

export interface Usage {
  /** All input: fresh, cache-write and cache-read together, so older records and readers keep working. */
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /**
   * The split of `inputTokens` and the agent's turns, when the harness reports them (Claude). Absent,
   * never 0, for a harness that reports only a total (Codex).
   */
  freshInputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  turns?: number;
}

export interface HarnessResult {
  /** False when the agent process failed, timed out or produced nothing. */
  ok: boolean;
  /** The agent's final reply as text ("" when none). */
  text: string;
  /** Set when the harness already has the reply as parsed JSON (structured output). */
  json?: unknown;
  /** One line saying what went wrong when `ok` is false. */
  error?: string;
  usage?: Usage;
  seconds: number;
  timedOut?: boolean;
  /**
   * REQ-harness-001: the failure is the provider's and may pass (at capacity, overloaded, HTTP 429 or
   * 5xx, a request timeout, a reset connection), set through `classified()` in harness/transient.ts.
   */
  transient?: boolean;
  /** The failure is a quota or session limit (never transient); `resetAt` when the message states it. */
  quota?: { resetAt?: string };
}

export interface Harness {
  run(req: HarnessRequest): Promise<HarnessResult>;
}

// ── Run state ───────────────────────────────────────────────────────────────────────────────

export type RunStatus = "running" | "waiting" | "blocked" | "done" | "aborted";

export interface HistoryEntry {
  phase: string;
  /** Roles that ran in the phase, if any. */
  roles: string[];
  outcome: Outcome | "skipped" | "waiting";
  /** One line: why it failed or was blocked, or what it produced. */
  detail: string;
  round: number;
  started: string;
  seconds: number;
  usage?: Usage;
  /** The same usage per harness (`claude`, `codex`, ...): Claude reports a price, Codex only tokens. */
  usageBy?: Record<string, Usage>;
  /** The harness each role of the phase ran on, by role id (`{"planner": "claude"}`). */
  harness?: Record<string, string>;
  /**
   * The model each role ran with, by role id: `[<provider>/]<model>` (a `local` role's
   * profile or model), or `default` when the role names none and the harness picks its own.
   */
  model?: Record<string, string>;
}

/** A condition the adjudicator set on its approval: something to do before the merge. */
export interface MergeCondition {
  what: string;
  how: string;
}

export interface RunState {
  card: string;
  flow: string;
  /** Index into the flow's phases of the next phase to execute. */
  phase: number;
  round: number;
  status: RunStatus;
  /** For `waiting`: the approval word needed; for `blocked`: the reason. */
  reason?: string;
  /** Approvals given, as `<phase id>:<word>`. */
  approvals: string[];
  /** Why the run was sent back, for the next implement pass. */
  remediation?: string;
  /** REQ-usage-005: entries into each phase in this run, by phase id (`limits.phase_visits`). */
  visits?: Record<string, number>;
  branch?: string;
  worktree?: string;
  /**
   * Squash commit about to be installed on the base branch. Saved BEFORE the base is moved or
   * anything is pushed or deleted, so a crash mid-merge is recognised on resume instead of
   * merging twice.
   */
  pendingMerge?: string;
  /**
   * The card branch head `pendingMerge` was built from. On resume the pending
   * commit is trusted only when its tree is the merge of its parent and this head, and the merge
   * evidence holds for this head.
   */
  pendingMergeHead?: string;
  /** Base-branch commit the work was merged as. */
  merged?: string;
  /**
   * Saved together with `merged`: the clean-up after the merge (push the base, remove the worktree,
   * delete the branch locally and on the hub) has not finished yet. Cleared when it has.
   */
  cleanupPending?: boolean;
  /** SHA-256 (hex) of each artifact file (`brief`, `handoff`, ...) as the runtime wrote it. */
  artifacts?: Record<string, string>;
  host: string;
  started: string;
  updated: string;
  history: HistoryEntry[];
  warnings: string[];
  /**
   * The conditions of the adjudicator's approval the run waited on at the stop point
   * `conditions` before the merge (set when it stopped there; kept for the record once approved).
   */
  conditions?: MergeCondition[];
  /** The follow-up cards created from the adjudication after the merge (their ids). */
  followUps?: string[];
  /**
   * How write-mode Claude agents of this run were confined (spec 8.6): "off (isolated host)" when the
   * sandbox policy is `off`, "on" when the sandbox works, "unavailable: <why>" when it does not.
   */
  sandbox?: string;
}

export interface RunOptions {
  /** Approval words granted up front (applies to any phase asking for that word). */
  approve?: string[];
  /** Stop before this phase. */
  until?: string;
  /**
   * Go back to this phase before continuing: the owner fixed what blocked the card (for example
   * widened its scope) and wants the work redone from there. Refused once the card is merged.
   */
  from?: string;
  dryRun?: boolean;
  /** Accepted only without a hub (`git.hub: none`), where there is nothing to be offline from. */
  offline?: boolean;
  /** Called with one line per phase as the run progresses. */
  onProgress?: (line: string) => void;
}

export interface EffectiveVars {
  risk: Risk;
  kind: string;
  deep_review: boolean;
  round: number;
  "findings.total"?: number;
  "findings.blocking"?: number;
  "gate.ok"?: boolean;
  /** Gate steps that did not run (`skipped` in the gate result), and their names. */
  "gate.skipped"?: number;
  "gate.skipped_names"?: string[];
  /** Conditions and follow-ups of an approving adjudication. */
  "adjudication.conditions"?: number;
  "adjudication.follow_ups"?: number;
}

// ── Hub (shared repository state between machines) ──────────────────────────────────────────

export interface SyncResult {
  action: "none" | "adopted" | "pushed" | "no-hub";
  /** Human-readable one-liner, e.g. "adopted 3 commit(s) from hub". */
  detail: string;
}

export interface Lease {
  host: string;
  pid: number;
  /** ISO time the lease was taken or last refreshed. */
  time: string;
  /** The start time of process `pid` (from /proc), so a reused pid is not taken for it. */
  started?: string;
  /** Taken by the owner (`mw lease take`, `--keep-lease`): never stale because its process is gone. */
  kept?: boolean;
}

export interface Hub {
  /** False when the project has `git.hub: none`. Every other method is then a successful no-op. */
  readonly enabled: boolean;
  /**
   * Take or refresh the lease, then sync the base branch. Throws MwError when another machine holds a
   * fresh lease or histories diverged, and (`hub/offline`) when asked to work offline: a project with
   * a hub never runs offline.
   */
  prepare(opts?: { offline?: boolean }): Promise<SyncResult>;
  /** `offline` (`mw sync --offline`) contacts nothing and changes nothing. */
  sync(opts?: { offline?: boolean }): Promise<SyncResult>;
  /** Refresh the lease this machine holds (called at phase boundaries). Throws if it was lost. */
  refresh(): Promise<void>;
  release(): Promise<void>;
  lease(): Promise<Lease | undefined>;
  /** Fetch a branch from the hub into the local branch of the same name. Returns false when the hub has no such branch. */
  fetchBranch(branch: string): Promise<boolean>;
  pushBranch(branch: string): Promise<void>;
  /** Push the base branch. */
  pushBase(): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
}

// ── Integrations (external services; all optional) ──────────────────────────────────────────

export interface LessonRecord {
  topic: string;
  title: string;
  body: string;
  card?: string;
}

export interface MergeRequest {
  card: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  /** Fires when this machine lost the lease: the merge stops before recording or requesting anything more. */
  signal?: AbortSignal;
}

/**
 * What `Integrations.docsSync` did: no documentation service is configured ("none"), the files were
 * sent, they were queued for a later `mw queue flush`, or nothing could be sent ("failed").
 */
export type DocsSyncOutcome = "none" | "sent" | "queued" | "failed";

/** What the core always provides itself: owner notifications, the usage guard and the forge merge. */
export interface CoreIntegrations {
  /** Tell the owner something happened (stage boundary, waiting, blocked, done). */
  notify(subject: string, body: string): Promise<void>;
  /** May work be dispatched now? `ok: false` pauses the run before a role on a paid harness (usage windows; `usageGuard`). */
  usageOk(): Promise<{ ok: boolean; detail: string }>;
  /**
   * Merge through a forge (pull request + squash) when one is configured. Returns the merged
   * commit, or undefined when no forge is configured (the engine then merges locally).
   * Throws MwError with code "merge/conflict" or "merge/failed".
   */
  forgeMerge(req: MergeRequest): Promise<string | undefined>;
}

/**
 * What removable services provide (semantic memory, documentation mirror, card board): composed from
 * the services still in the core and the installed packages (`integrationsFor`).
 */
export interface ServiceIntegrations {
  /** Extra memory hits from a semantic store, as `title: text` lines. [] when not configured. */
  recall(query: string, limit: number): Promise<string[]>;
  /** Store lessons in the semantic store. */
  remember(lessons: LessonRecord[]): Promise<void>;
  /**
   * Mirror changed and deleted documentation files to the documentation service, reading each file as
   * a blob of `commit` (the merged commit; HEAD when absent), never from the working tree.
   */
  docsSync(changed: string[], deleted: string[], commit?: string): Promise<DocsSyncOutcome | void>;
  /**
   * Reflect a card's live status on an external board. Returns a one-line note when the status was
   * not mirrored from this machine (the board does not answer here); the run records it once.
   */
  mirrorCard(cardId: string, title: string, status: string): Promise<string | void>;
}

/** The one object the engine calls. */
export interface Integrations extends CoreIntegrations, ServiceIntegrations {}
