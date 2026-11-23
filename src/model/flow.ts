// flows/*.flow.yaml: a pipeline as data.
import YAML from "yaml";
import { Diagnostics } from "../diagnostics.ts";
import { checkExpr } from "../expr.ts";
import { validate } from "../schemas.ts";
import { SLUG } from "../util.ts";

export type Action = "merge" | "memory.update" | "docs.sync" | "notify";
/** How a phase ended. `ok` moves on; the others are routed by the phase's `on:` map. */
export type Outcome = "ok" | "fail" | "reject" | "block";

export interface Phase {
  id: string;
  role?: string;
  gate?: string;
  action?: Action;
  also: { role: string; when?: string }[];
  needs: string[];
  when?: string;
  /**
   * The phase's stop points, in order (`stop:` is one `{when, ask}` or a list of them).
   * Empty when the phase has none.
   */
  stops: StopPoint[];
  on: Partial<Record<Exclude<Outcome, "ok">, string>>;
}

export interface StopPoint {
  when: string;
  ask: string;
}

export interface Flow {
  id: string;
  description: string;
  worktree: boolean;
  phases: Phase[];
  remediate?: { phase: string; maxRounds?: number };
  file: string;
  origin: string;
}

/** Targets an `on:` entry may name besides a phase id. */
export const ON_TARGETS = ["remediate", "stop", "continue"] as const;

export function parseFlow(file: string, text: string, origin: string, diag: Diagnostics): Flow | undefined {
  let data: unknown;
  try {
    data = YAML.parse(text);
  } catch (e) {
    diag.error("flow/yaml", file, `not valid YAML: ${(e as Error).message.split("\n")[0]}`, 1);
    return undefined;
  }
  const problems = validate("flow", data);
  for (const m of problems) diag.error("flow/schema", file, m, 1);
  if (data === null || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  const id = typeof d.id === "string" ? d.id : "";
  if (!SLUG.test(id) || !Array.isArray(d.phases)) return undefined;
  const base = file.split("/").pop()!;
  if (base !== `${id}.flow.yaml`) diag.error("flow/file-name", file, `flow ${id} must be in a file named ${id}.flow.yaml`, 1);

  const phases: Phase[] = [];
  const seen = new Set<string>();
  for (const raw of d.phases as Record<string, unknown>[]) {
    if (raw === null || typeof raw !== "object" || typeof raw.id !== "string" || !SLUG.test(raw.id)) continue;
    const p: Phase = {
      id: raw.id,
      role: raw.role as string | undefined,
      gate: raw.gate as string | undefined,
      action: raw.action as Action | undefined,
      also: Array.isArray(raw.also) ? (raw.also as Phase["also"]) : [],
      needs: Array.isArray(raw.needs) ? (raw.needs as string[]) : [],
      when: raw.when as string | undefined,
      stops: Array.isArray(raw.stop) ? (raw.stop as StopPoint[]) : raw.stop && typeof raw.stop === "object" ? [raw.stop as StopPoint] : [],
      on: (raw.on ?? {}) as Phase["on"],
    };
    const where = `phase '${p.id}'`;
    if (seen.has(p.id)) diag.error("flow/duplicate-phase", file, `${where} is defined twice`);
    if (!p.role && !p.gate && !p.action) diag.error("flow/empty-phase", file, `${where} does nothing: give it a role, a gate or an action`);
    if (p.gate && (p.role || p.action)) diag.error("flow/gate-phase", file, `${where}: a gate phase cannot also have a role or an action`);
    if (p.also.length && !p.role) diag.error("flow/also", file, `${where}: 'also' adds roles to a role phase, but this phase has no role`);
    for (const n of p.needs) {
      if (!seen.has(n)) diag.error("flow/needs", file, `${where} needs '${n}', which is not an earlier phase`);
    }
    for (const [label, src] of [["when", p.when], ...p.stops.map((x) => ["stop.when", x?.when] as const), ...p.also.map((a) => ["also.when", a.when] as const)] as const) {
      if (typeof src !== "string") continue;
      const err = checkExpr(src);
      if (err) diag.error("flow/condition", file, `${where}: ${label} '${src}': ${err}`);
    }
    seen.add(p.id);
    phases.push(p);
  }

  const rem = d.remediate as { phase?: string; max_rounds?: number } | undefined;
  const ids = new Set(phases.map((p) => p.id));
  if (rem?.phase && !ids.has(rem.phase)) diag.error("flow/remediate", file, `remediate.phase '${rem.phase}' is not a phase of this flow`);
  for (const p of phases) {
    for (const [outcome, target] of Object.entries(p.on)) {
      if (target === "remediate") {
        if (!rem?.phase) diag.error("flow/remediate", file, `phase '${p.id}' sends '${outcome}' to remediate, but the flow has no 'remediate:' block`);
      } else if (!(ON_TARGETS as readonly string[]).includes(target!) && !ids.has(target!)) {
        diag.error("flow/on-target", file, `phase '${p.id}': on.${outcome} points at '${target}', which is not a phase or one of ${ON_TARGETS.join(", ")}`);
      }
    }
  }
  return {
    id,
    description: String(d.description ?? ""),
    worktree: d.worktree !== false,
    phases,
    remediate: rem?.phase ? { phase: rem.phase, maxRounds: rem.max_rounds } : undefined,
    file,
    origin,
  };
}
