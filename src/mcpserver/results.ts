// The structured results of the MCP tools: the `data` a tool returns beside its text (the text is
// the contract with MCP clients and does not change). The GUI (`mw ui`) reads these shapes, so they are
// a contract too: a field is never renamed or removed, or given another meaning, without raising
// RESULTS_VERSION. Optional values are `null`, not absent, so every field is always there.
//
// Types only, apart from RESULTS_VERSION. Every shape is a JSON object (MCP `structuredContent` must
// be one); every value in it survives JSON.stringify unchanged.
import type { AgentUse, HarnessUsage, UsageTotals } from "../engine/run.ts";

export const RESULTS_VERSION = 1;

export type { AgentUse, HarnessUsage, UsageTotals };

// ── Cards and the board ─────────────────────────────────────────────────────────────────────

export type CardKind = "feature" | "fix" | "chore" | "docs" | "spike";
/** What the card file says (`status:` in its front matter). */
export type CardFileStatus = "todo" | "ready" | "in_progress" | "review" | "blocked" | "done";
/** What the run state says (`.mergewright/runs/<ID>/state.json`). */
export type RunStatus = "running" | "waiting" | "blocked" | "done" | "aborted";
export type Risk = "low" | "medium" | "high" | "critical";

/**
 * The board column a card is in, from its run when it has one, else from its file. `running`: a live
 * process drives the run (or the run was last driven on another machine); `queued`: the run state says
 * running but nothing drives it, so `mw work` or `mw run` resumes it (REQ-engine-014); `waiting`: at a
 * stop point (see CardRow.ask) or paused for usage; `aborted`: the run was aborted and the card file
 * is past ready. A card whose file says done is `done` even when its run did not finish.
 */
export type BoardStatus = "todo" | "ready" | "running" | "queued" | "waiting" | "blocked" | "done" | "aborted";

/** One card as the board shows it (mw_status, and the `card` of every card operation). */
export interface CardRow {
  id: string;
  title: string;
  kind: CardKind;
  status: BoardStatus;
  /** The status as `mw status` prints it, e.g. "queued ('mw work' or 'mw run DEMO-1' resumes it at 'gate')". */
  label: string;
  cardStatus: CardFileStatus;
  /** null: the card has no run. */
  runStatus: RunStatus | null;
  /** The flow the run uses, or the card would use. */
  flow: string;
  /** The phase the run is at; null without a run or once it finished. */
  phase: string | null;
  /** The card's own risk, else the project default (`risk.default`). */
  risk: Risk;
  /** Why the run waits (the approval word, or `usage`) or is blocked; null otherwise. */
  reason: string | null;
  /**
   * What the owner is asked for while the run waits at a stop point: the word `mw approve` takes,
   * typically `go`, `conditions` or `merge` (a flow may name others). null otherwise, also while the
   * run is paused for usage.
   */
  ask: string | null;
  /** Agent usage of the run so far; null when nothing was reported. */
  usage: UsageTotals | null;
  /** The harness and model each role of the run last ran with; [] when none ran. */
  agents: AgentUse[];
  depends: string[];
  implements: string[];
}

export interface StatusData {
  cards: CardRow[];
  /** `<key path>: <message>` when mergewright.yaml fails its schema (writing tools then refuse); [] otherwise. */
  configErrors: string[];
}

export interface LintFinding {
  code: string;
  severity: "error" | "warning";
  message: string;
}

/** mw_card_lint, and the `lint` of a refusal to set a card ready (error code `card/not-ready`). */
export interface LintData {
  id: string;
  ok: boolean;
  findings: LintFinding[];
}

export interface RequirementData {
  id: string;
  title: string;
  priority: "must" | "should" | "could" | null;
  rev: number;
  status: "active" | "deprecated";
  spec: string;
  file: string;
  acceptanceCriteria: { id: string; text: string }[];
  cards: { id: string; title: string; status: CardFileStatus }[];
}

/** mw_card_get: one card in full. */
export interface CardData {
  card: CardRow;
  file: string;
  /** The front matter as written (YAML parsed). */
  frontMatter: Record<string, unknown>;
  /** The Markdown after the front matter. */
  body: string;
  /** The body's `## ` sections by heading, lower-cased (`why`, `out of scope`, `acceptance`, ...). */
  sections: Record<string, string>;
  scope: string[];
  depends: string[];
  implements: string[];
  tags: string[];
  /** Documents the card must update (`docs:`). */
  docs: string[];
  allowProtected: string[];
  lint: LintData;
  /** The requirements it implements that a spec defines. */
  requirements: RequirementData[];
  /** Requirement ids it names that no spec defines. */
  missingRequirements: string[];
}

/** The result of a card operation (mw_card_new, mw_card_set_status, mw_retry, mw_abort): the card as it is now. */
export interface CardChangeData {
  card: CardRow;
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────

/**
 * Kinds of files in a run folder: the run state; the artifacts as JSON (`brief`, `handoff`,
 * `findings`, `adjudication`, `reflection`, and `gate`, the gate's summary); `artifact`, a
 * content-addressed copy of one (`artifacts/<kind>-<sha256>.json`); `gate-log`, a gate step's log;
 * `prompt` and `output`, what an agent was sent and answered (`phases/`); `stream`, an agent's raw
 * stdout or stderr; `other`, anything else (the forge check, output schemas).
 */
export type RunFileKind = "state" | "brief" | "handoff" | "findings" | "adjudication" | "reflection" | "gate" | "artifact" | "gate-log" | "prompt" | "output" | "stream" | "other";

export interface RunFile {
  /** Path inside the run folder, with `/`; what mw_run_file takes as `name`. */
  name: string;
  kind: RunFileKind;
  /** Bytes. */
  size: number;
  /** ISO time of the last change. */
  modified: string;
}

export interface PhaseInfo {
  id: string;
  /** What runs in it: a role, a gate or an action (`merge`, `memory.update`, `docs.sync`, `notify`). */
  kind: "role" | "gate" | "action";
  /** The role, gate or action name. */
  runs: string;
  /** Its stop points' approval words, in order. */
  stops: string[];
  /** It ended `ok` (or was skipped) in this run. */
  done: boolean;
  /** The run is at this phase now. */
  current: boolean;
}

export interface HistoryData {
  phase: string;
  outcome: "ok" | "fail" | "reject" | "block" | "skipped" | "waiting";
  roles: string[];
  detail: string;
  round: number;
  started: string;
  seconds: number;
  /** Harness by role id ({} when no role ran). */
  harness: Record<string, string>;
  /** Model by role id ({} when no role ran). */
  model: Record<string, string>;
  /** Usage per harness ({} when none was reported). */
  usage: Record<string, HarnessUsage>;
}

/** mw_run_status: a card's run. When the card has no run, `exists` is false and the run fields are empty. */
export interface RunData {
  id: string;
  exists: boolean;
  card: CardRow;
  /** One or two sentences: where the run is and what to do next; null without a run. */
  summary: string | null;
  /** The phases of the run's flow, in order. */
  phases: PhaseInfo[];
  /** Ids of the phases that ended ok or were skipped, in order. */
  phasesDone: string[];
  currentPhase: string | null;
  /** Remediation rounds so far, and the most the project allows (`limits.rounds`). */
  round: number;
  maxRounds: number;
  /** Approvals given, as `<phase id>:<word>`. */
  approvals: string[];
  /** The conditions of the adjudicator's approval, when it approved on conditions. */
  conditions: { what: string; how: string }[];
  followUps: string[];
  /** Commit the card was merged as. */
  merged: string | null;
  started: string | null;
  updated: string | null;
  host: string | null;
  history: HistoryData[];
  warnings: string[];
  files: RunFile[];
  /** The end of the run's background log (`.mergewright/local/runs/<ID>.log`), redacted. */
  log: string;
}

/** mw_run_file: one file of a run folder, redacted. */
export interface RunFileData {
  id: string;
  name: string;
  kind: RunFileKind;
  size: number;
  /** The text, at most 1 MB of it. */
  text: string;
  truncated: boolean;
  /** The parsed value of a `.json` file that parses; null otherwise. */
  json: unknown;
}

/** What a tool started in the background (mw_run_start, mw_approve, mw_retry with `run`). */
export interface StartedData {
  /** The command, e.g. "mw approve DEMO-1 go". */
  started: string;
  pid: number;
  /** The log file, relative to the project root. */
  log: string;
  /** The process had already finished when the tool answered. */
  finished: boolean;
  /** The card as it was when the tool answered (the run goes on in the background unless finished). */
  card: CardRow;
}

/** mw_retry: the card put back at a phase, and the run started when `run` was asked for. */
export interface RetryData {
  card: CardRow;
  from: string | null;
  started: StartedData | null;
}

// ── Specs and trace ─────────────────────────────────────────────────────────────────────────

export interface SpecListData {
  specs: { id: string; title: string; status: string; file: string; requirements: { id: string; title: string; priority: "must" | "should" | "could" | null; rev: number; status: "active" | "deprecated" }[] }[];
  changes: { id: string; status: string; spec: string; summary: string }[];
}

/** mw_spec_get. mw_req_get returns a RequirementData. */
export interface SpecData {
  id: string;
  title: string;
  status: string;
  file: string;
  requirements: RequirementData[];
}

export type Coverage = "unplanned" | "planned" | "built" | "verified" | "deprecated";

export interface TraceData {
  requirements: {
    id: string;
    title: string;
    priority: "must" | "should" | "could" | null;
    rev: number;
    status: "active" | "deprecated";
    spec: string;
    coverage: Coverage;
    cards: { id: string; title: string; status: CardFileStatus }[];
    /** `file:line` of each test that names it. */
    tests: string[];
  }[];
  /** `@req` comments naming no requirement. */
  dangling: { req: string; file: string; line: number }[];
}

// ── Search ──────────────────────────────────────────────────────────────────────────────────

export interface SearchHit {
  /** Path relative to the project root. */
  file: string;
  title: string;
  /** Keyword score: 3 per query word in the title, 1 per word in the text. */
  score: number;
  /** Memory: the entry's text. Docs: the first line holding a query word. */
  text: string;
}

/** Hits of one outside source: a package that searches (memory or documentation). */
export interface SourceHits {
  name: string;
  hits: string[];
  /** Why it gave none: it did not answer. */
  error: string | null;
}

/** mw_memory_search and mw_docs_search. */
export interface SearchData {
  query: string;
  hits: SearchHit[];
  sources: SourceHits[];
}

// ── Packages and settings ───────────────────────────────────────────────────────────────────

export interface PackageData {
  name: string;
  version: string | null;
  description: string | null;
  /** Its files are in `.mergewright/packages/<name>/`. */
  installed: boolean;
  /** `packages.<name>` is in mergewright.yaml. */
  enabled: boolean;
  loaded: boolean;
  /** Why it is not usable or did not load; null when it loaded (or is installed and not enabled). */
  error: string | null;
  /** What it provides once loaded (`deliverers`, `search`, `tools`, ...); its manifest's `exports` otherwise. */
  provides: string[];
  /** Settings its manifest requires that `packages.<name>` does not give. */
  missingSettings: string[];
  /** Names of the environment variables it reads as secrets (never their values). */
  secrets: string[];
  /** Parts it returned that were left out, and why. */
  notes: string[];
  /** Its health checks as `mw doctor` reports them; null unless mw_packages was asked to run them (`checks`), [] when it provides none or did not load. */
  checks: { name: string; ok: boolean; detail: string }[] | null;
}

/** An official package embedded in this runtime that is not installed in the project: `mw add <name>` installs it. */
export interface AvailablePackage {
  name: string;
  version: string;
  description: string;
  /** What its manifest says it provides. */
  exports: string[];
}

/** mw_packages. */
export interface PackagesData {
  packages: PackageData[];
  available: AvailablePackage[];
}

export interface FlowData {
  id: string;
  description: string;
  /** preset or project. */
  origin: string;
  phases: { id: string; kind: "role" | "gate" | "action"; runs: string; stops: string[] }[];
  /** The phase a rejected card goes back to; null when the flow has none. */
  remediate: string | null;
}

export interface RoleData {
  id: string;
  origin: string;
  /** The harness that runs it (`claude`, `codex`, `local`, `shell`, `mock`, or one a package declares). */
  harness: string;
  /** null: the harness picks its own. */
  model: string | null;
  fallbackModel: string | null;
  provider: string | null;
  mode: "advise" | "read" | "write";
  output: string;
  description: string;
}

/** mw_settings: the project settings a UI shows. */
export interface SettingsData {
  name: string;
  description: string;
  /** Card id prefix, e.g. DEMO. */
  prefix: string;
  base: string;
  defaultFlow: string;
  defaultRisk: Risk;
  flows: FlowData[];
  roles: RoleData[];
  gate: { required: string[] };
  docsPaths: string[];
  /** Names under `packages:` in mergewright.yaml. */
  packages: string[];
  configErrors: string[];
}

/** mw_roles. */
export interface RolesData {
  roles: RoleData[];
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────────

/** The `data` of a refusal to set a card ready, or to create one ready (`card/not-ready`). */
export interface NotReadyData {
  lint: LintData;
}

/** Every data type, by the name `listTools` reports as a tool's `result`. */
export interface ResultTypes {
  StatusData: StatusData;
  CardData: CardData;
  CardChangeData: CardChangeData;
  LintData: LintData;
  RunData: RunData;
  RunFileData: RunFileData;
  StartedData: StartedData;
  RetryData: RetryData;
  SpecListData: SpecListData;
  SpecData: SpecData;
  RequirementData: RequirementData;
  TraceData: TraceData;
  SearchData: SearchData;
  PackagesData: PackagesData;
  SettingsData: SettingsData;
  RolesData: RolesData;
}

export type ResultName = keyof ResultTypes;
