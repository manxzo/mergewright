// What a run knows at a point in time: the condition variables flows test (section 3) and the
// values role prompts interpolate (section 6). Prompt values are computed only when used.
import { RISK_LEVELS, type Risk, type Vars } from "../expr.ts";
import { searchMemory } from "../memory.ts";
import type { Card } from "../model/card.ts";
import type { Project } from "../project.ts";
import { clip, withoutSyncTemp } from "../util.ts";
import { renderGate, skippedSteps, type GateJson } from "./gate.ts";
import { changedFiles, diffText } from "./gitops.ts";
import type { ArtifactStore } from "./state.ts";
import type { EffectiveVars, Integrations, MergeCondition, RunState } from "./types.ts";

export interface Brief {
  summary: string;
  approach: string;
  scope: string[];
  acceptance: string[];
  guards: string[];
  docs: string[];
  risk: Risk;
  deep_review: boolean;
  ready: boolean;
  blockers: string[];
}

export interface Handoff {
  status: "done" | "blocked";
  summary: string;
  changed: string[];
  verified: string[];
  not_done: string[];
  docs_updated: string[];
  notes: string;
}

export interface Finding {
  id: string;
  severity: Risk;
  blocking: boolean;
  file: string | null;
  line: number | null;
  title: string;
  detail: string;
  suggestion: string | null;
}

export interface Findings {
  summary: string;
  findings: Finding[];
  /** The commit the review judged; the engine adds it when it stores the artifact. */
  head?: string;
}

export interface Adjudication {
  verdict: "approve" | "reject" | "block";
  summary: string;
  accepted: string[];
  rejected: { id: string; reason: string }[];
  instructions: string;
  /** With `approve`, what must be done before the merge (the run stops at `conditions`). */
  conditions?: MergeCondition[];
  /** Work that should follow; each becomes a `todo` card after the merge. */
  follow_ups?: FollowUp[];
}

export interface FollowUp {
  title: string;
  why: string;
  scope?: string[];
  kind?: "feature" | "fix" | "chore" | "docs" | "spike";
  /** The follow-up card's risk (default `medium`). */
  risk?: "low" | "medium" | "high" | "critical";
}

/** The conditions of an approving adjudication (none for reject or block). */
export function approvalConditions(a: Adjudication | undefined): MergeCondition[] {
  return a?.verdict === "approve" && Array.isArray(a.conditions) ? a.conditions : [];
}

/** Everything about the run that variables and prompts read from. */
export interface RunContext {
  project: Project;
  card: Card;
  state: RunState;
  runDir: string;
  /** Where agents and gates work: the worktree, or the project root. */
  cwd: string;
  base: string;
  branch: string;
  /** What `changed` and `diff` compare HEAD against. */
  diffBase: string;
  /** The run's artifacts as the runtime wrote them (never re-read from disk). */
  artifacts: ArtifactStore;
}

const maxRisk = (a: Risk, b: Risk): Risk => (RISK_LEVELS.indexOf(a) >= RISK_LEVELS.indexOf(b) ? a : b);

export function computeVars(ctx: RunContext): EffectiveVars {
  const brief = ctx.artifacts.get<Brief>("brief");
  const findings = ctx.artifacts.get<Findings>("findings");
  const gate = ctx.artifacts.get<GateJson>("gate");
  let risk = ctx.project.riskOf(ctx.card);
  if (brief?.risk && (RISK_LEVELS as readonly string[]).includes(brief.risk)) risk = maxRisk(risk, brief.risk);
  const v: EffectiveVars = { risk, kind: ctx.card.kind, deep_review: ctx.project.deepReviewOf(ctx.card) || brief?.deep_review === true, round: ctx.state.round };
  // A malformed stored artifact sets no variables rather than throwing: mergeEvidence() reads these
  // before it checks the artifact, and must refuse the merge, not crash.
  if (findings && Array.isArray(findings.findings)) {
    v["findings.total"] = findings.findings.length;
    v["findings.blocking"] = findings.findings.filter((f) => typeof f === "object" && f !== null && f.blocking).length;
  }
  if (gate) {
    v["gate.ok"] = gate.ok;
    const skipped = skippedSteps(gate);
    v["gate.skipped"] = skipped.length;
    v["gate.skipped_names"] = skipped.map((s) => s.name);
  }
  const adj = ctx.artifacts.get<Adjudication>("adjudication");
  if (adj?.verdict === "approve") {
    v["adjudication.conditions"] = approvalConditions(adj).length;
    v["adjudication.follow_ups"] = Array.isArray(adj.follow_ups) ? adj.follow_ups.length : 0;
  }
  return v;
}

export function asExprVars(v: EffectiveVars): Vars {
  const out: Vars = {};
  for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = val as string | number | boolean | string[];
  return out;
}

const bullets = (items: string[]) => items.map((x) => `- ${x}`).join("\n");

export function renderBrief(b: Brief | undefined): string {
  if (!b) return "";
  const out = [`**Summary:** ${b.summary}`, "", "**Approach:**", b.approach, "", `**Scope:** ${b.scope.join(", ") || "(none)"}`];
  if (b.acceptance.length) out.push("", "**Acceptance:**", bullets(b.acceptance));
  if (b.guards.length) out.push("", "**Guards:**", bullets(b.guards));
  out.push("", `**Docs to update:** ${b.docs.join(", ") || "(none)"}`);
  return out.join("\n");
}

export function renderHandoff(h: Handoff | undefined): string {
  if (!h) return "";
  const out = [`**Status:** ${h.status}`, `**Summary:** ${h.summary}`];
  if (h.changed.length) out.push("**Changed:**", bullets(h.changed));
  if (h.verified.length) out.push("**Verified:**", bullets(h.verified));
  if (h.not_done.length) out.push("**Not done:**", bullets(h.not_done));
  if (h.docs_updated.length) out.push(`**Docs updated:** ${h.docs_updated.join(", ")}`);
  if (h.notes.trim()) out.push(`**Notes:** ${h.notes.trim()}`);
  return out.join("\n");
}

export function renderFindings(f: Findings | undefined): string {
  if (!f) return "";
  if (!f.findings.length) return `No findings. ${f.summary}`.trim();
  return f.findings
    .map((x) => {
      const where = x.file ? `${x.file}${x.line ? `:${x.line}` : ""}` : "(no file)";
      return `- ${x.id} [${x.severity}${x.blocking ? ", blocking" : ""}] ${where}: ${x.title}\n  ${x.detail.replace(/\n/g, "\n  ")}`;
    })
    .join("\n");
}

export function renderAdjudication(a: Adjudication | undefined): string {
  if (!a) return "";
  const out = [`**Verdict:** ${a.verdict}`, `**Summary:** ${a.summary}`, `**Instructions:** ${a.instructions || "(none)"}`];
  const conditions = approvalConditions(a);
  if (conditions.length) out.push("**Conditions before merge:**", bullets(conditions.map((c) => `${c.what} (how: ${c.how})`)));
  if (a.follow_ups?.length) out.push("**Follow-ups:**", bullets(a.follow_ups.map((f) => `${f.title}: ${f.why}`)));
  return out.join("\n");
}

export function renderCard(card: Card, risk: Risk): string {
  const head = [
    `- id: ${card.id}`, `- title: ${card.title}`, `- kind: ${card.kind}`, `- risk: ${risk}`,
    `- scope: ${card.scope.join(", ") || "(not limited)"}`, `- depends: ${card.depends.join(", ") || "(none)"}`,
  ];
  // Optional lists appear only when set, so the planner sees an owner's grant and the docs to update.
  if (card.allowProtected.length) head.push(`- allow_protected: ${card.allowProtected.join(", ")}`);
  if (card.docs.length) head.push(`- docs: ${card.docs.join(", ")}`);
  if (card.implements.length) head.push(`- implements: ${card.implements.join(", ")}`);
  return `${head.join("\n")}\n\n${card.body.trim()}`;
}

export function renderRequirements(project: Project, card: Card): string {
  const reqs = project.requirements();
  const out: string[] = [];
  for (const id of card.implements) {
    const r = reqs.get(id);
    if (!r) { out.push(`### ${id} (not defined by any spec)`); continue; }
    out.push(`### ${r.id} ${r.title}`, `- priority: ${r.priority ?? "should"}`, `- rev: ${r.rev}`, ...r.criteria.map((c) => `- ${c.id}: ${c.text}`), "");
  }
  return out.join("\n").trim();
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

/** The names a template uses, so nothing else is computed (token and time discipline). */
export function usedVariables(template: string): Set<string> {
  return new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!));
}

/**
 * The project's state and rules are in every prompt, card phase or delegation. A role
 * whose prompt does not place `{{memory.state}}` or `{{memory.rules}}` itself gets them appended here
 * (each only when the file has text), so what an agent says about the project's state is grounded in
 * `memory/STATE.md`, not made up.
 */
export function memoryAppendix(project: Project, template: string): string {
  const used = usedVariables(template);
  const parts: string[] = [];
  const state = used.has("memory.state") ? "" : project.readMemory("STATE.md").trim();
  if (state) parts.push(`## Where the project is now (memory/STATE.md)\n\n${state}`);
  const rules = used.has("memory.rules") ? "" : project.readMemory("RULES.md").trim();
  if (rules) parts.push(`## Project rules (memory/RULES.md)\n\n${rules}`);
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

/** Values for the placeholders `template` uses. Absent values are left out (they render empty). */
export async function promptValues(ctx: RunContext, template: string, integrations: Integrations): Promise<Record<string, string>> {
  const used = usedVariables(template);
  const { project, card, state } = ctx;
  const cfg = project.config;
  const brief = ctx.artifacts.get<Brief>("brief");
  const vars = computeVars(ctx);
  const values: Record<string, string> = {};
  const lazy: Record<string, () => string | Promise<string>> = {
    "project.name": () => cfg.name,
    "project.description": () => cfg.description,
    card: () => renderCard(card, vars.risk),
    "card.id": () => card.id,
    "card.title": () => card.title,
    "card.kind": () => card.kind,
    "card.risk": () => vars.risk,
    "card.scope": () => card.scope.join(", "),
    requirements: () => renderRequirements(project, card),
    brief: () => renderBrief(brief),
    handoff: () => renderHandoff(ctx.artifacts.get<Handoff>("handoff")),
    findings: () => renderFindings(ctx.artifacts.get<Findings>("findings")),
    gate: () => renderGate(ctx.artifacts.get<GateJson>("gate")),
    adjudication: () => renderAdjudication(ctx.artifacts.get<Adjudication>("adjudication")),
    diff: () => clip(diffText(ctx.cwd, ctx.diffBase), cfg.limits.diffChars),
    changed: () => withoutSyncTemp(changedFiles(ctx.cwd, ctx.diffBase)).join("\n"),
    "memory.state": () => project.readMemory("STATE.md"),
    "memory.rules": () => project.readMemory("RULES.md"),
    "memory.index": () => project.readMemory("INDEX.md"),
    "memory.recall": async () => {
      const reqs = project.requirements();
      const query = [card.title, ...card.implements.map((id) => reqs.get(id)?.title ?? ""), ...card.scope].join(" ");
      const local = searchMemory(project, query, 5).map((h) => `- ${h.title}: ${h.text.split(/\n\s*\n/)[0]!.trim()}`);
      let remote: string[] = [];
      try {
        remote = (await integrations.recall(query, 5)).map((l) => `- ${l}`);
      } catch {
        // a semantic store being down never stops a run
      }
      return [...local, ...remote].join("\n");
    },
    round: () => String(state.round),
    remediation: () => (state.round === 0 ? "(first pass)" : state.remediation ?? ""),
    protected: () => cfg.protected.join(", "),
    branch: () => ctx.branch,
    base: () => ctx.base,
    docs: () => [...new Set([...card.docs, ...(brief?.docs ?? [])])].join(", ") || "(none listed)",
  };
  for (const name of used) {
    const f = lazy[name];
    if (f) values[name] = await f();
  }
  return values;
}
