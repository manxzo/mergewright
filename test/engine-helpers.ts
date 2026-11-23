// Fixtures for engine tests: a project whose roles all run on the mock harness, a scripted gate,
// mock scripts, and fake Hub and Integrations objects that record what the engine asked of them.
import fs from "node:fs";
import path from "node:path";
import type { Hub, Integrations, LessonRecord, RunOptions, RunState } from "../src/engine/types.ts";
import { runCard } from "../src/engine/run.ts";
import { Project } from "../src/project.ts";
import { git, newProject, read, tmpDir, write } from "./helpers.ts";

export const ROLES = ["planner", "worker", "reviewer", "reviewer-deep", "redteam", "adjudicator", "reflector", "docs-writer"];

/** Passes unless src/app.txt contains BROKEN; writes gate.json per the contract. */
export const GATE = `#!/usr/bin/env bash
set -u
mkdir -p "$MERGEWRIGHT_GATE_LOGS"
log="$MERGEWRIGHT_GATE_LOGS/check.log"
if [ -f src/app.txt ] && grep -q BROKEN src/app.txt; then
  echo "app is broken: src/app.txt says BROKEN" > "$log"; ok=false; code=1
else
  echo "all fine" > "$log"; ok=true; code=0
fi
printf '{"ok":%s,"steps":[{"name":"check","kind":"test","ok":%s,"seconds":0,"log":"%s"}]}\\n' $ok $ok "$log" > "$MERGEWRIGHT_GATE_JSON"
exit $code
`;

export interface Setup {
  dir: string;
  /** Front matter lines added to the card (e.g. "risk: high\\n"). */
  cardExtra?: string;
}

/** Role overrides in mergewright.yaml: every role on mock unless given otherwise. */
export function setRoles(dir: string, overrides: Record<string, Record<string, string>> = {}): void {
  const cfgFile = path.join(dir, "mergewright.yaml");
  const text = read(dir, "mergewright.yaml").replace(/\nroles:\n(  .*\n)*/g, "\n");
  const lines = ["roles:"];
  for (const r of ROLES) {
    const o = { runs: "mock", ...(overrides[r] ?? {}) };
    lines.push(`  ${r}: {${Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}}`);
  }
  fs.writeFileSync(cfgFile, `${text.trimEnd()}\n${lines.join("\n")}\n`);
}

/** A committed project with card DEMO-1 (scope src/** and docs/**) and the scripted gate. */
export function project(opts: { kind?: string; cardExtra?: string; roles?: Record<string, Record<string, string>>; scope?: string[] } = {}): string {
  const dir = newProject();
  setRoles(dir, opts.roles);
  write(dir, "gates/default.gate.sh", GATE);
  fs.chmodSync(path.join(dir, "gates/default.gate.sh"), 0o755);
  const scope = opts.scope ?? ["src/**", "docs/**"];
  write(dir, "cards/DEMO-1.card.md", `---\nid: DEMO-1\ntitle: Card DEMO-1\nkind: ${opts.kind ?? "feature"}\nstatus: todo\nscope: [${scope.map((s) => JSON.stringify(s)).join(", ")}]\n${opts.cardExtra ?? ""}---\n\n## Why\n\nBecause the demo needs it.\n\n## Acceptance\n\n- The demo works.\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "setup");
  return dir;
}

export function brief(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "Add the app file.", approach: "Write src/app.txt.", scope: ["src/**", "docs/**"], acceptance: ["the app file exists"],
    guards: ["no network"], docs: [], risk: "low", deep_review: false, ready: true, blockers: [], ...over,
  };
}

export function handoff(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "done", summary: "Added the app file", changed: ["src/app.txt"], verified: ["gate"], not_done: [], docs_updated: [], notes: "", ...over };
}

export function finding(id: string, blocking: boolean, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, severity: blocking ? "high" : "low", blocking, file: "src/app.txt", line: 1, title: `problem ${id}`, detail: `detail of ${id}`, suggestion: null, ...over };
}

export function findings(list: Record<string, unknown>[] = []): Record<string, unknown> {
  return { summary: list.length ? "some findings" : "looks fine", findings: list };
}

export function adjudication(verdict: "approve" | "reject" | "block", over: Record<string, unknown> = {}): Record<string, unknown> {
  return { verdict, summary: `verdict ${verdict}`, accepted: [], rejected: [], instructions: "", ...over };
}

export function reflection(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "# State\n\n## Now\n- DEMO-1 is finished.\n", outcome: "Delivered the app file in one round.",
    lessons: [{ topic: "testing", title: "Keep tests hermetic", body: "Tests must not touch the network." }], decisions: [], ...over,
  };
}

export type Script = Record<string, unknown[]>;

/** The default happy-path script; pass overrides per role. */
export function script(over: Script = {}): Script {
  return {
    planner: [{ output: brief() }],
    worker: [{ writes: { "src/app.txt": "hello\n", "docs/guide.md": "# Guide\n" }, output: handoff() }],
    reviewer: [{ output: findings([finding("R-01", false)]) }],
    "reviewer-deep": [{ output: findings() }],
    redteam: [{ output: findings() }],
    adjudicator: [{ output: adjudication("approve") }],
    reflector: [{ output: reflection() }],
    "docs-writer": [{ writes: { "docs/guide.md": "# Guide\n" }, output: handoff() }],
    ...over,
  };
}

/** Write the mock script and point MW_MOCK_SCRIPT at it (for in-process runs). Returns the file. */
export function useScript(s: Script): string {
  const file = path.join(tmpDir("mw-script-"), "script.json");
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  process.env.MW_MOCK_SCRIPT = file;
  return file;
}

export interface Call {
  name: string;
  args: unknown[];
}

export function fakeHub(opts: { refresh?: () => void | Promise<void>; holder?: string } = {}): Hub & { calls: Call[]; names: () => string[] } {
  const calls: Call[] = [];
  const rec = (name: string, ...args: unknown[]) => { calls.push({ name, args }); };
  return {
    enabled: true,
    calls,
    names: () => calls.map((c) => c.name),
    async prepare(o) { rec("prepare", o); return { action: "none", detail: "level with hub" }; },
    async sync(o) { rec("sync", o); return { action: "none", detail: "level with hub" }; },
    async refresh() { rec("refresh"); await opts.refresh?.(); },
    async release() { rec("release"); },
    async lease() { rec("lease"); return opts.holder ? { host: opts.holder, pid: 1, time: new Date().toISOString() } : undefined; },
    async fetchBranch(b) { rec("fetchBranch", b); return false; },
    async pushBranch(b) { rec("pushBranch", b); },
    async pushBase() { rec("pushBase"); },
    async deleteBranch(b) { rec("deleteBranch", b); },
  };
}

export function fakeIntegrations(opts: { usage?: () => { ok: boolean; detail: string } } = {}): Integrations & { calls: Call[]; of: (n: string) => Call[] } {
  const calls: Call[] = [];
  const rec = (name: string, ...args: unknown[]) => { calls.push({ name, args }); };
  return {
    calls,
    of: (n) => calls.filter((c) => c.name === n),
    async notify(subject, body) { rec("notify", subject, body); },
    async recall(q, limit) { rec("recall", q, limit); return ["Remote lesson: from the semantic store"]; },
    async remember(lessons: LessonRecord[]) { rec("remember", lessons); },
    async docsSync(changed, deleted) { rec("docsSync", changed, deleted); },
    async usageOk() { rec("usageOk"); return opts.usage?.() ?? { ok: true, detail: "fine" }; },
    async mirrorCard(id, title, status) { rec("mirrorCard", id, title, status); },
    async forgeMerge() { rec("forgeMerge"); return undefined; },
  };
}

export async function run(dir: string, opts: RunOptions = {}, deps: { hub?: Hub; integrations?: Integrations } = {}): Promise<RunState> {
  return runCard(new Project(dir), "DEMO-1", opts, { hub: deps.hub ?? fakeHub(), integrations: deps.integrations ?? fakeIntegrations() });
}

export function runPath(dir: string, ...rel: string[]): string {
  return path.join(dir, ".mergewright", "runs", "DEMO-1", ...rel);
}

/** This machine's run lock of DEMO-1 (`.mergewright/local/locks/DEMO-1.lock`, never file-synced). */
export function lockPath(dir: string): string {
  return path.join(dir, ".mergewright", "local", "locks", "DEMO-1.lock");
}

export function state(dir: string): RunState {
  return JSON.parse(fs.readFileSync(runPath(dir, "state.json"), "utf8")) as RunState;
}

export function counters(dir: string): Record<string, number> {
  const f = runPath(dir, "mock-counters.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, number>) : {};
}

export const phases = (s: RunState) => s.history.map((h) => `${h.phase}:${h.outcome}`);

export function branchExists(dir: string, branch: string): boolean {
  try {
    git(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

export function subjects(dir: string, ref = "main"): string[] {
  return git(dir, "log", "--format=%s", ref).split("\n");
}

export function promptFiles(dir: string, match: RegExp): string[] {
  const d = runPath(dir, "phases");
  return fs.readdirSync(d).filter((f) => match.test(f)).sort().map((f) => fs.readFileSync(path.join(d, f), "utf8"));
}

// ── Two machines: a bare hub and two clones of a project that uses it ───────────────────────

export interface Pair {
  hubDir: string;
  /** The first machine (the laptop): where the project was created. */
  a: string;
  /** The second machine (the server): a clone of the hub. */
  b: string;
}

function identity(dir: string): void {
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
}

/** `project(opts)` on clone `a` with `git.hub: hub`, pushed to a bare hub; clone `b` of the hub. */
export function hubPair(opts: Parameters<typeof project>[0] = {}): Pair {
  const a = project(opts);
  const tmp = tmpDir("mw-pair-");
  const hubDir = path.join(tmp, "hub.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", hubDir);
  write(a, "mergewright.yaml", read(a, "mergewright.yaml").replace(/hub: none\b/, "hub: hub"));
  git(a, "commit", "-qam", "use the hub");
  git(a, "remote", "add", "hub", hubDir);
  git(a, "push", "-q", "hub", "main");
  const b = path.join(tmp, "b");
  git(tmp, "clone", "-q", "-o", "hub", hubDir, b);
  identity(b);
  return { hubDir, a, b };
}

/**
 * What the file-sync tool does: make `to`'s files equal to `from`'s, including `.mergewright/runs/` (run state),
 * but never anything named `.git` (the repository, or a worktree's `.git` file), never
 * `.mergewright/local` (this machine's own files) and never `.mergewright/worktrees` (excluded on both
 * machines: worktrees are per machine). `worktrees: true` copies them too, as the file-sync tool did before that
 * exclusion existed.
 */
export function mirror(from: string, to: string, opts: { worktrees?: boolean } = {}): void {
  const skipped = path.join(".mergewright", "worktrees");
  const local = path.join(".mergewright", "local");
  const walk = (root: string): Map<string, string> => {
    const out = new Map<string, string>();
    const visit = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === ".git") continue;
        const full = path.join(dir, e.name);
        if (!opts.worktrees && path.relative(root, full) === skipped) continue;
        if (path.relative(root, full) === local) continue;
        if (e.isDirectory()) visit(full);
        else out.set(path.relative(root, full), full);
      }
    };
    visit(root);
    return out;
  };
  const src = walk(from);
  for (const [rel, full] of src) {
    const dst = path.join(to, rel);
    const content = fs.readFileSync(full);
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(content)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content);
    fs.chmodSync(dst, fs.statSync(full).mode);
  }
  for (const [rel, full] of walk(to)) if (!src.has(rel)) fs.rmSync(full);
}

/** Run `fn` as machine `host` at time `now` (ISO; omitted = the real clock). */
export async function as<T>(host: string, now: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = { host: process.env.MW_HOST, now: process.env.MW_NOW };
  process.env.MW_HOST = host;
  if (now) process.env.MW_NOW = now;
  else delete process.env.MW_NOW;
  try {
    return await fn();
  } finally {
    if (prev.host === undefined) delete process.env.MW_HOST; else process.env.MW_HOST = prev.host;
    if (prev.now === undefined) delete process.env.MW_NOW; else process.env.MW_NOW = prev.now;
  }
}

export const T0 = "2026-10-05T10:00:00.000Z";
/** T0 plus `minutes`, as an ISO time. */
export const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
