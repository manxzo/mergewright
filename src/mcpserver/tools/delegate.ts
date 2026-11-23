// Tool group "delegate": one-off sub-agents of any model, for an assistant. A delegated role runs through
// the same harnesses, environment and output validation as a card phase (engine/run.ts invokeRole),
// in `advise` mode (an empty temporary folder outside the project, with the harness's no-tools setting)
// or `read` mode (reads the project, changes nothing). There is no OS sandbox: a model that has any
// file tool can read what the owner's account can read (specification, `mw_delegate`). It never gets
// MCP servers or the role's extra harness arguments. Work that changes
// files is a card: "the model advises, the runtime acts" (engine.md section 1).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryAppendix, promptValues as cardPromptValues, usedVariables } from "../../engine/context.ts";
import { HARNESS_TRANSIENT, invokeRole, roleEnvFor } from "../../engine/run.ts";
import { artifactStore, newState, saveExchange } from "../../engine/state.ts";
import type { Integrations } from "../../engine/types.ts";
import { integrationsFor } from "../../integrations.ts";
import { usageGuard } from "../../integrations/usage.ts";
import { searchMemory } from "../../memory.ts";
import { checkRole, renderPrompt, type Harness, type Mode, type OutputKind, type Role } from "../../model/role.ts";
import { localDir, type Project } from "../../project.ts";
import { loadSchema } from "../../schemas.ts";
import { Diagnostics } from "../../diagnostics.ts";
import { clip, git, MwError, slugify } from "../../util.ts";
import { need, num, S, schema, SLUG, str, type Args, type ToolContext, type ToolDef } from "../tool.ts";

const OUTPUTS: OutputKind[] = ["text", "findings", "brief", "adjudication"];
const HARNESSES: Harness[] = ["claude", "codex", "local", "mock"];
/** Set to 1 to let delegation use the mock harness (tests only: with MW_MOCK_SCRIPT it can write anywhere). */
export const ALLOW_MOCK_ENV = "MW_DELEGATE_ALLOW_MOCK";

/** The prompt of an ad-hoc role; the task follows it. */
const AD_HOC_PROMPT = `You are a sub-agent consulted by the assistant of the project {{project.name}}. {{project.description}}

You do not change anything: you answer. Be specific and brief; say what you are unsure of.

## Where the project is now

{{memory.state}}

## Project rules

{{memory.rules}}`;

/** What `{{card}}` and `{{requirements}}` read in a delegation that names no card. */
export const NO_CARD = "(none: not a card; the task text is the whole request)";

/**
 * Values for a delegation about a card (`card` given): rendered exactly as the card's
 * first phase (the brief) would see them: the card, its requirements with their acceptance criteria,
 * memory (state, rules, index, recall) and docs. Run artifacts (brief, findings, ...) are absent.
 */
async function cardValues(project: Project, cardId: string, template: string, runDir: string, cwd: string): Promise<Record<string, string>> {
  const card = project.card(cardId);
  const state = newState(card.id, project.flowFor(card));
  const base = project.config.git.base;
  const ctx = { project, card, state, runDir, cwd, base, branch: base, diffBase: base, artifacts: artifactStore(runDir, state, () => undefined) };
  return cardPromptValues(ctx, template, integrationsFor(project));
}

/** Values for the placeholders a delegated prompt uses: the project's and the task's; card-run values are absent. */
function promptValues(project: Project, template: string, task: string, extra: Record<string, string>): Record<string, string> {
  const lazy: Record<string, () => string> = {
    "project.name": () => project.config.name,
    "project.description": () => project.config.description,
    "memory.state": () => project.readMemory("STATE.md"),
    "memory.rules": () => project.readMemory("RULES.md"),
    "memory.index": () => project.readMemory("INDEX.md"),
    "memory.recall": () => searchMemory(project, task, 5).map((h) => `- ${h.title}: ${h.text.split(/\n\s*\n/)[0]!.trim()}`).join("\n"),
    protected: () => project.config.protected.join(", "),
    card: () => NO_CARD,
    requirements: () => NO_CARD,
    "card.id": () => "(delegated task, no card)",
    "card.title": () => task.split("\n")[0]!.slice(0, 120),
    "card.kind": () => "delegated",
    docs: () => project.config.docs.paths.join(", "),
    base: () => project.config.git.base,
    branch: () => project.config.git.base,
  };
  const values: Record<string, string> = {};
  for (const name of usedVariables(template)) {
    if (name in extra) values[name] = extra[name]!;
    else if (lazy[name]) values[name] = lazy[name]!();
  }
  return values;
}

/**
 * The role to run: a project or preset role by id, or an ad-hoc one; overrides applied; never write
 * mode. Only the role's prompt, harness, model, provider, profile, mode, output and limits are kept:
 * its MCP servers, extra harness arguments (`args`, which can widen what the agent may do, e.g.
 * a toolset flag or Codex sandbox flags) and `command` are for card phases the owner configured.
 */
export function delegateRole(project: Project, a: Args): Role {
  const id = str(a, "role");
  let role: Role;
  if (id) {
    const found = project.roles().get(id);
    if (!found) throw new MwError("delegate/no-role", `there is no role '${id}' (roles: ${[...project.roles().keys()].join(", ")})`);
    role = {
      id: found.id, description: found.description, runs: found.runs, model: found.model, provider: found.provider, profile: found.profile,
      fallbackModel: found.fallbackModel, mode: found.mode, output: found.output, limits: { ...found.limits }, mcps: [], args: [], prompt: found.prompt, file: found.file, origin: found.origin,
    };
  } else {
    const runs = str(a, "runs") as Harness | undefined;
    if (!runs) throw new MwError("usage", `give a 'role' id, or 'runs' (${[...HARNESSES.filter((h) => h !== "mock"), ...project.packageHarnesses.keys()].join(", ")}) with an optional model`);
    role = { id: "delegate", description: "ad-hoc delegated role", runs, mode: "advise", output: "text", limits: {}, mcps: [], args: [], prompt: AD_HOC_PROMPT, file: "(mw_delegate)", origin: "delegate" };
  }
  // An explicit harness or model replaces the role's choice, and with it the role's alternate model.
  if (str(a, "runs") || str(a, "model")) role.fallbackModel = undefined;
  if (str(a, "runs")) role.runs = str(a, "runs") as Harness;
  if (str(a, "model")) role.model = str(a, "model");
  if (str(a, "provider")) role.provider = str(a, "provider");
  if (str(a, "mode")) role.mode = str(a, "mode") as Mode;
  if (num(a, "minutes")) role.limits.minutes = num(a, "minutes");
  if (str(a, "output")) role.output = str(a, "output") as OutputKind;
  else if (!OUTPUTS.includes(role.output)) role.output = "text";
  if (role.mode === "write") {
    throw new MwError("delegate/write", `role '${role.id}' has mode 'write': delegated agents only advise or read. Work that changes files is a card (mw_card_new, then mw_run_start), or pass mode 'read' to consult it read-only.`);
  }
  if (!HARNESSES.includes(role.runs) && !project.packageHarnesses.has(role.runs)) {
    throw new MwError("delegate/harness", `role '${role.id}' runs on '${role.runs}', which mw_delegate does not use (use ${[...HARNESSES.filter((h) => h !== "mock"), ...project.packageHarnesses.keys()].join(", ")})`);
  }
  // The mock harness follows MW_MOCK_SCRIPT, which can write files whatever the mode: tests only.
  if (role.runs === "mock" && process.env[ALLOW_MOCK_ENV] !== "1") {
    throw new MwError("delegate/harness", `role '${role.id}' runs on 'mock', the test harness, which delegation refuses unless ${ALLOW_MOCK_ENV}=1 is set (tests only)`);
  }
  const diag = new Diagnostics();
  checkRole(role, role.file, diag, project.packageHarnesses);
  if (diag.errors.length) throw new MwError("delegate/role", diag.errors.map((e) => e.message).join("; "));
  return role;
}

export interface DelegateResult {
  ok: boolean;
  role: string;
  runs: string;
  /**
   * The effective model: the role's model, else its provider/profile, else "(harness default)"; the
   * role's `fallback_model` when that one answered (REQ-harness-003).
   */
  model: string;
  mode: string;
  output_kind: string;
  output: unknown;
  /** Token usage when the harness reports it; null when it does not (some harnesses report none). */
  usage: unknown;
  seconds: number;
  run_dir: string;
  error?: string;
  /** REQ-harness-002: transient retries the role took on its own model (absent when none). */
  transient_retries?: number;
  /** The role failed transiently on every model it may use (`harness/transient`). */
  transient?: boolean;
  /** The harness reported a quota or session limit (never retried), with its reset time when stated. */
  usage_limit?: { reset_at?: string };
}

/**
 * The folder a read-mode delegate starts in: `cwd` (default the project root) with every symbolic
 * link resolved, which must be a directory inside the project's real root.
 */
export function readCwd(project: Project, cwd: string | undefined): string {
  const root = fs.realpathSync(project.root);
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(project.root, cwd ?? "."));
  } catch {
    throw new MwError("delegate/cwd", `'${cwd}' does not exist in the project`);
  }
  const rel = path.relative(root, real);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new MwError("delegate/cwd", `'${cwd}' is outside the project${real !== path.resolve(project.root, cwd ?? ".") ? ` (it leads to ${real})` : ""}`);
  if (!fs.statSync(real).isDirectory()) throw new MwError("delegate/cwd", `'${cwd}' is not a folder`);
  return real;
}

/**
 * Run a delegated role on a task. Each call gets its own run directory
 * .mergewright/local/delegate/<time>-<label>-XXXXXX (prompt, schema and reply files are never shared).
 * advise: the agent starts in an empty folder made for it in the system temp folder, outside the
 * project, removed afterwards; read: in the project (or a folder of it). There is no OS-level sandbox
 * (specification, `mw_delegate`): a read-mode agent can read what the owner's account can read.
 */
export async function delegate(project: Project, role: Role, task: string, opts: { label?: string; cwd?: string; card?: string; extra?: Record<string, string>; signal?: AbortSignal; integrations?: Pick<Integrations, "usageOk"> } = {}): Promise<DelegateResult> {
  if (opts.card !== undefined) project.card(opts.card); // an unknown card fails before anything is made
  // REQ-usage-004: the same guard as a card's roles, asked once for the first attempt before anything is
  // made; invokeRole asks it once before each later attempt (a transient retry, the fallback, the schema
  // retry). A delegation on a paid harness is refused while paused (`finish`: delegate/usage).
  const u = await usageGuard(opts.integrations ?? integrationsFor(project), [role.runs]);
  if (!u.ok) {
    return { ok: false, role: role.id, runs: role.runs, model: effectiveModel(role), mode: role.mode, output_kind: role.output, output: "", usage: null, seconds: 0, run_dir: "", ...usageRefusal(role, u.detail) };
  }
  const cwdRead = role.mode === "read" ? readCwd(project, opts.cwd) : undefined;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const parent = path.join(localDir(project), "delegate");
  fs.mkdirSync(parent, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(parent, `${stamp}-${slugify(opts.label ?? role.id).slice(0, 40)}-`));
  const cwd = cwdRead ?? fs.mkdtempSync(path.join(os.tmpdir(), "mw-advise-"));
  try {
    return await delegateIn(project, role, task, runDir, cwd, opts);
  } finally {
    if (!cwdRead) fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * The one mapping of a usage-guard refusal (REQ-usage-004), before the first attempt or before a
 * later one (a transient retry, the fallback, the schema retry): `finish` turns it into delegate/usage.
 */
function usageRefusal(role: Role, detail: string): Pick<DelegateResult, "error" | "usage_limit"> {
  return {
    error: `the delegation to role '${role.id}' (${role.runs}) was refused (reason: usage): agent usage is too high (${detail}), so no new agent starts until it drops. Try again later, or use a local role.`,
    usage_limit: {},
  };
}

/** The model a delegated role runs: its model, or its provider/profile, or the harness's default. */
export function effectiveModel(role: Role): string {
  if (role.model) return role.model;
  const via = [role.provider, role.profile].filter(Boolean).join("/");
  return via || "(harness default)";
}

async function delegateIn(project: Project, role: Role, task: string, runDir: string, cwd: string, opts: { card?: string; extra?: Record<string, string>; signal?: AbortSignal; integrations?: Pick<Integrations, "usageOk"> }): Promise<DelegateResult> {
  const values = {
    ...promptValues(project, role.prompt, task, {}),
    ...(opts.card !== undefined ? await cardValues(project, opts.card, role.prompt, runDir, cwd) : {}),
    ...(opts.extra ?? {}),
  };
  let prompt = renderPrompt(role.prompt, values) + memoryAppendix(project, role.prompt);
  // The task is appended unless the prompt already shows it as {{card}} (mw_review passes it so).
  if (!(usedVariables(role.prompt).has("card") && values.card === task)) prompt += `\n\n## Task\n\n${task.trim()}`;
  prompt += role.mode === "advise"
    ? "\n\nYou run in an empty folder outside the project, with your harness's no-tools setting: the project's files are not given to you, so answer from what this prompt contains and do not read files elsewhere."
    : `\n\nYou may read files under ${cwd} to check what you say, but never change anything.`;
  if (role.output !== "text" && role.origin === "delegate") {
    prompt += `\n\nReply with only a JSON object that satisfies this JSON Schema:\n\n\`\`\`json\n${JSON.stringify(loadSchema(`output.${role.output}` as never), null, 2)}\n\`\`\``;
  }
  // No MCP servers, whatever the role lists: a server can do anything, and delegation only advises or reads.
  const t0 = Date.now();
  const r = await invokeRole({
    project, role, prompt, cwd, runDir, label: "delegate", env: roleEnvFor(project, role, undefined, runDir), signal: opts.signal,
    afterAttempt: (label, p, text) => saveExchange(runDir, label, p, text),
    // REQ-usage-004: delegate() asked the guard for the first attempt; invokeRole asks it before each later one.
    integrations: opts.integrations ?? integrationsFor(project), firstGuarded: true,
  });
  return {
    ok: r.ok, role: role.id, runs: role.runs, model: r.fallback && role.fallbackModel ? role.fallbackModel : effectiveModel(role), mode: role.mode, output_kind: role.output,
    output: r.ok && role.output !== "text" ? r.value : r.text, usage: r.usage ?? null, seconds: Math.round((Date.now() - t0) / 1000),
    run_dir: project.rel(runDir), error: r.error, ...(r.retries ? { transient_retries: r.retries } : {}), ...(r.transient ? { transient: true } : {}),
    ...(r.quota ? { usage_limit: r.quota.resetAt ? { reset_at: r.quota.resetAt } : {} } : {}),
    // A refusal by the guard before any attempt invokeRole makes, the schema retry included, is
    // reported exactly as the refusal before the first attempt (delegate/usage); no harness starts after it.
    ...(r.usagePause ? usageRefusal(role, r.usagePause) : {}),
  };
}

/** The delegation's outcome, or the error it ends with: `harness/transient`, `delegate/usage` (a usage limit or a refusal by the guard) or `delegate/failed`. */
export function finish(r: DelegateResult): DelegateResult {
  // REQ-harness-003 AC-3: the role's model and its alternate both failed transiently.
  if (!r.ok && r.transient) throw new MwError(HARNESS_TRANSIENT, `${r.error} (prompt and reply in ${r.run_dir})`);
  // A quota or session limit: refused with reason usage (REQ-usage-004) until the stated reset time.
  if (!r.ok && r.usage_limit) throw new MwError("delegate/usage", `${r.error}${r.usage_limit.reset_at ? `; try again after ${r.usage_limit.reset_at}` : ""}${r.run_dir ? ` (prompt and reply in ${r.run_dir})` : ""}`);
  if (!r.ok) throw new MwError("delegate/failed", `${r.error ?? "the delegated agent failed"} (prompt and reply in ${r.run_dir})`);
  return r;
}

const roleArgs = {
  // A pattern, not a list: a harness an enabled package provides counts too (checked by delegateRole).
  runs: S.matching(SLUG, `harness for an ad-hoc role, or to override the role's: ${HARNESSES.filter((h) => h !== "mock").join(", ")}, or one an enabled package provides (see mw_packages) ('mock' is the test harness: refused unless MW_DELEGATE_ALLOW_MOCK=1)`),
  model: S.str("model for the harness (e.g. gpt-5.6-sol for codex, opus for claude)"),
  provider: S.str("provider (the local harness, and package harnesses that take one)"),
  minutes: S.int("time limit in minutes"),
};

export const tools: ToolDef[] = [
  {
    name: "mw_delegate",
    description: "Ask a sub-agent of another model: a project role by id (see mw_roles) or an ad-hoc one (runs + model). Every delegation's prompt includes the project's memory/STATE.md and memory/RULES.md where the role's prompt asks for them (all shipped roles and ad-hoc ones do). With 'card' (a card id) a card role such as planner sees that card exactly as its brief phase would: the card, the requirements it implements with their acceptance criteria, memory and docs; without it, the role's {{card}} and {{requirements}} read '(none: not a card; the task text is the whole request)'. The task is always appended. mode 'advise' starts it in an empty folder outside the project with the harness's no-tools setting; 'read' lets it read the project (or 'cwd' inside it). There is no OS sandbox: a model with any file tool could read what the owner's account can read. It gets no MCP servers and none of the role's extra harness arguments. Never writes: changes are cards. output text, or a validated JSON object (findings, brief, adjudication). Returns the output, the model, and token usage (null when the harness reports none). runs 'mock' is the test harness, for tests only.",
    needsConfig: true, // writes its run folder and runs an agent (REQ-config-001)
    inputSchema: schema({
      task: S.str("what to do or answer; include everything an agent with no context needs"),
      role: S.str("role id (e.g. reviewer-deep, planner); omit for an ad-hoc role"),
      card: S.str("card id: render the role's prompt with that card's full context (card, requirements and acceptance criteria, memory, docs), as its brief phase would; e.g. role planner, card DEMO-1 to check a card can be done before readying it"),
      ...roleArgs,
      mode: S.oneOf(["advise", "read"], "advise (default for ad-hoc roles): starts in an empty folder outside the project with the harness's no-tools setting (no OS sandbox); read: may read the project"),
      output: S.oneOf(OUTPUTS, "text (default for ad-hoc roles) or a structured kind"),
      cwd: S.str("read mode: folder inside the project to start in"),
      label: S.str("short name for the run folder"),
    }, ["task"]),
    handler: async (a, ctx: ToolContext) => {
      const project = ctx.project();
      const role = delegateRole(project, a);
      return finish(await delegate(project, role, need(a, "task"), { label: str(a, "label") ?? str(a, "card"), cwd: str(a, "cwd"), card: str(a, "card"), signal: ctx.signal }));
    },
  },
  {
    name: "mw_review",
    description: "Independent review of a diff by the 'reviewer' role (Codex GPT-5.6 Terra) or, with deep=true, 'reviewer-deep' (GPT-5.6 Sol); 'model' overrides. Reviews 'git diff <range>' of the project (default: uncommitted changes against HEAD) or the given diff text. Returns findings (id, severity, blocking, file, line, title, detail).",
    needsConfig: true, // writes its run folder and runs an agent (REQ-config-001)
    inputSchema: schema({
      range: S.str("git range, e.g. main..feature, HEAD~3..HEAD, or a commit (default HEAD: uncommitted changes)"),
      diff: S.str("diff text to review instead of a range"),
      deep: S.bool("use reviewer-deep"),
      role: S.str("another findings role to use"),
      ...roleArgs,
      focus: S.str("what to look at in particular"),
    }),
    handler: async (a, ctx: ToolContext) => {
      const project = ctx.project();
      const range = str(a, "range") ?? "HEAD";
      if (range.startsWith("-")) throw new MwError("usage", `'${range}' is not a git range`);
      let diff = str(a, "diff");
      let changed = "";
      if (diff === undefined) {
        diff = git(project.root, ["diff", range, "--"]).stdout;
        changed = git(project.root, ["diff", "--name-only", range, "--"]).stdout.trim();
      }
      if (!diff.trim()) throw new MwError("review/empty", `there is nothing to review: 'git diff ${range}' is empty`);
      const role = delegateRole(project, { ...a, role: str(a, "role") ?? (a.deep === true ? "reviewer-deep" : "reviewer"), output: "findings", mode: "read" });
      const task = `Review this change to ${project.config.name} (${str(a, "diff") !== undefined ? "a diff given by the owner's assistant" : `git diff ${range}`}). It is not a card: there is no brief, gate result or handoff; judge the diff on its own.${str(a, "focus") ? `\n\nFocus: ${str(a, "focus")}` : ""}`;
      const extra = { diff: clip(diff, project.config.limits.diffChars), changed, base: range, card: task, brief: "(none: not a card)", requirements: "(none: not a card)", gate: "(not run)", handoff: "(none)" };
      return finish(await delegate(project, role, task, { label: `review-${range}`, extra, signal: ctx.signal }));
    },
  },
];
