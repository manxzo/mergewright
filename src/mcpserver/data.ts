// Builders of the tools' structured data (the shapes are in results.ts). Read-only: nothing here
// writes a file, takes a lock or contacts a service.
import fs from "node:fs";
import path from "node:path";
import { cardLintReport } from "../cards.ts";
import { runDrive } from "../engine/driver.ts";
import { agentsOf, describeRun, safeState, statusRow, usageTotals } from "../engine/run.ts";
import { ARTIFACT_KINDS, runDir } from "../engine/state.ts";
import type { RunState } from "../engine/types.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import type { RemoteHits } from "../integrations.ts";
import type { MemoryHit } from "../memory.ts";
import type { Card } from "../model/card.ts";
import type { Flow, Phase } from "../model/flow.ts";
import type { Role } from "../model/role.ts";
import type { Requirement } from "../model/spec.ts";
import { localDir, type Project } from "../project.ts";
import { MwError, readText, toPosix } from "../util.ts";
import type { BoardStatus, CardData, CardRow, FlowData, HistoryData, PhaseInfo, RequirementData, RoleData, RunData, RunFile, RunFileData, RunFileKind, SearchData, SettingsData } from "./results.ts";

/** The board column of a card (results.ts BoardStatus). */
function boardStatus(project: Project, card: Card, state: RunState | undefined): BoardStatus {
  if (card.status === "done") return "done";
  if (state) {
    if (state.status === "running") return runDrive(project, state)?.status ?? "running";
    if (state.status !== "aborted") return state.status;
    if (card.status !== "todo" && card.status !== "ready") return "aborted";
  }
  if (card.status === "in_progress" || card.status === "review") return "running";
  return card.status;
}

/** One card as the board shows it. `state` defaults to the card's run state as it is on disk. */
export function cardRow(project: Project, card: Card, state: RunState | undefined = safeState(project, card.id)): CardRow {
  const row = statusRow(project, card, state);
  const waiting = state?.status === "waiting";
  return {
    id: card.id, title: card.title, kind: card.kind,
    status: boardStatus(project, card, state), label: row.status,
    cardStatus: card.status, runStatus: state?.status ?? null,
    flow: row.flow, phase: row.phase === "-" ? null : row.phase,
    risk: card.risk ?? project.config.risk.default,
    reason: state && (state.status === "waiting" || state.status === "blocked") ? state.reason ?? null : null,
    ask: waiting && state.reason && state.reason !== "usage" ? state.reason : null,
    usage: state ? usageTotals(state) ?? null : null,
    agents: state ? agentsOf(state) : [],
    depends: card.depends, implements: card.implements,
  };
}

/** The row of the card `id` as it is now (loaded afresh). */
export function cardRowOf(project: Project, id: string): CardRow {
  return cardRow(project, project.card(id));
}

export function requirementData(project: Project, r: Requirement): RequirementData {
  return {
    id: r.id, title: r.title, priority: r.priority ?? null, rev: r.rev, status: r.status, spec: r.specId, file: r.file,
    acceptanceCriteria: r.criteria.map((c) => ({ id: c.id, text: c.text })),
    cards: project.cards().filter((c) => c.implements.includes(r.id)).map((c) => ({ id: c.id, title: c.title, status: c.status })),
  };
}

/** mw_card_get's data. */
export function cardData(project: Project, id: string): CardData {
  const card = project.card(id);
  const reqs = project.requirements();
  return {
    card: cardRow(project, card), file: card.file,
    frontMatter: parseFrontmatter(readText(project.abs(card.file))).data,
    body: card.body, sections: card.sections,
    scope: card.scope, depends: card.depends, implements: card.implements, tags: card.tags, docs: card.docs, allowProtected: card.allowProtected,
    lint: cardLintReport(project, card.id),
    requirements: card.implements.flatMap((rid) => { const r = reqs.get(rid); return r ? [requirementData(project, r)] : []; }),
    missingRequirements: card.implements.filter((rid) => !reqs.has(rid)),
  };
}

function phaseKind(p: Phase): { kind: "role" | "gate" | "action"; runs: string } {
  if (p.role) return { kind: "role", runs: p.role };
  if (p.gate) return { kind: "gate", runs: p.gate };
  return { kind: "action", runs: p.action ?? "" };
}

export function flowData(f: Flow): FlowData {
  return {
    id: f.id, description: f.description, origin: f.origin,
    phases: f.phases.map((p) => ({ id: p.id, ...phaseKind(p), stops: p.stops.map((s) => s.ask) })),
    remediate: f.remediate?.phase ?? null,
  };
}

// ── Run folders ─────────────────────────────────────────────────────────────────────────────

const ARTIFACT_FILES = new Set<string>(ARTIFACT_KINDS.map((k) => `${k}.json`));

/** The kind of a file in a run folder, by its path there (results.ts RunFileKind). */
export function runFileKind(name: string): RunFileKind {
  if (name === "state.json") return "state";
  if (ARTIFACT_FILES.has(name)) return name.slice(0, -".json".length) as RunFileKind;
  if (name.startsWith("artifacts/")) return "artifact";
  if (name.startsWith("gate-logs/")) return "gate-log";
  if (name.startsWith("phases/") && name.endsWith(".prompt.md")) return "prompt";
  if (name.startsWith("phases/") && name.endsWith(".output.txt")) return "output";
  if (/\.(stdout|stderr)$/.test(name)) return "stream";
  return "other";
}

/** Every regular file of a card's run folder (symbolic links are left out), sorted by name. */
export function runFiles(project: Project, id: string): RunFile[] {
  const root = runDir(project, id);
  const out: RunFile[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        const st = fs.statSync(abs);
        const name = toPosix(path.relative(root, abs));
        out.push({ name, kind: runFileKind(name), size: st.size, modified: st.mtime.toISOString() });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** How much of a run file mw_run_file returns. */
export const RUN_FILE_MAX = 1_000_000;

/**
 * One file of a card's run folder. `name` is a path inside that folder (as runFiles gives it); a name
 * that leaves the folder, through `..`, an absolute path or a symbolic link, is refused, and so is
 * anything that is not a regular file. The caller redacts (the MCP layer scrubs every result).
 */
export function readRunFile(project: Project, id: string, name: string): RunFileData {
  const root = runDir(project, id);
  if (!name || path.isAbsolute(name) || name.includes("\\") || name.split("/").some((p) => p === ".." || p === "." || p === "")) {
    throw new MwError("run/file-path", `'${name}' is not a plain path inside the run folder of ${id}; mw_run_status lists its files`);
  }
  let real: string;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(path.join(root, name));
  } catch {
    throw new MwError("run/no-file", `${id}'s run folder has no file '${name}'; mw_run_status lists its files`);
  }
  if (!real.startsWith(realRoot + path.sep) || toPosix(path.relative(realRoot, real)) !== name) {
    throw new MwError("run/file-path", `'${name}' leads outside the run folder of ${id} (a symbolic link); not reading it`);
  }
  const st = fs.lstatSync(real);
  if (!st.isFile()) throw new MwError("run/no-file", `'${name}' in ${id}'s run folder is not a file`);
  const fd = fs.openSync(real, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(Math.min(st.size, RUN_FILE_MAX));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    text = buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const truncated = st.size > RUN_FILE_MAX;
  let json: unknown = null;
  if (name.endsWith(".json") && !truncated) {
    try { json = JSON.parse(text) as unknown; } catch { json = null; }
  }
  return { id, name, kind: runFileKind(name), size: st.size, text, truncated, json };
}

/** The last `lines` lines of a file, or "" when it cannot be read. */
export function tail(file: string, lines: number): string {
  try {
    return fs.readFileSync(file, "utf8").split("\n").slice(-lines - 1).join("\n").trim();
  } catch {
    return "";
  }
}

export function runLog(project: Project, id: string): string {
  return path.join(localDir(project), "runs", `${id}.log`);
}

function historyData(h: RunState["history"][number]): HistoryData {
  const usage: HistoryData["usage"] = {};
  for (const [k, u] of Object.entries(h.usageBy ?? (h.usage ? { unattributed: h.usage } : {}))) usage[k] = { ...u };
  return { phase: h.phase, outcome: h.outcome, roles: h.roles, detail: h.detail, round: h.round, started: h.started, seconds: h.seconds, harness: h.harness ?? {}, model: h.model ?? {}, usage };
}

/** mw_run_status's data. */
export function runData(project: Project, id: string, logLines: number): RunData {
  const card = project.card(id);
  const state = safeState(project, id);
  const flow = project.flows().get(state?.flow ?? project.flowFor(card));
  const finished = state?.status === "done" || state?.status === "aborted";
  const phases: PhaseInfo[] = (flow?.phases ?? []).map((p, i) => ({
    id: p.id, ...phaseKind(p), stops: p.stops.map((s) => s.ask),
    done: !!state && (state.status === "done" || i < state.phase),
    current: !!state && !finished && i === state.phase,
  }));
  return {
    id, exists: !!state, card: cardRow(project, card, state),
    summary: state ? describeRun(project, state) : null,
    phases, phasesDone: phases.filter((p) => p.done).map((p) => p.id),
    currentPhase: phases.find((p) => p.current)?.id ?? null,
    round: state?.round ?? 0, maxRounds: project.config.limits.rounds,
    approvals: state?.approvals ?? [], conditions: state?.conditions ?? [], followUps: state?.followUps ?? [],
    merged: state?.merged ?? null, started: state?.started ?? null, updated: state?.updated ?? null, host: state?.host ?? null,
    history: (state?.history ?? []).map(historyData), warnings: state?.warnings ?? [],
    files: runFiles(project, id), log: tail(runLog(project, id), logLines),
  };
}

// ── Search, roles, settings ─────────────────────────────────────────────────────────────────

export function searchData(query: string, hits: MemoryHit[], sources: RemoteHits[]): SearchData {
  return {
    query,
    hits: hits.map((h) => ({ file: h.file, title: h.title, score: h.score, text: h.text })),
    sources: sources.map((s) => ({ name: s.name, hits: s.hits, error: s.error ?? null })),
  };
}

export function roleData(r: Role): RoleData {
  return {
    id: r.id, origin: r.origin, harness: r.runs, model: r.model ?? null, fallbackModel: r.fallbackModel ?? null,
    provider: r.provider ?? null, mode: r.mode, output: r.output, description: r.description,
  };
}

/** mw_settings's data. */
export function settingsData(project: Project): SettingsData {
  const c = project.config;
  return {
    name: c.name, description: c.description, prefix: c.cards.prefix, base: c.git.base,
    defaultFlow: c.cards.defaultFlow, defaultRisk: c.risk.default,
    flows: [...project.flows().values()].map(flowData),
    roles: [...project.roles().values()].map(roleData),
    gate: { required: c.gate.required },
    docsPaths: c.docs.paths, packages: Object.keys(c.packages),
    configErrors: project.configErrors(),
  };
}
