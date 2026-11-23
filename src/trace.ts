// Tracing: requirement -> cards that implement it -> tests that reference it.
//
// A test is linked with a plain comment that works in any language:   @req REQ-auth-001
import fs from "node:fs";
import path from "node:path";
import type { Card } from "./model/card.ts";
import type { Requirement } from "./model/spec.ts";
import { Project, RESERVED_DIRS, WORK_DIR } from "./project.ts";
import { matchesAny, sh, toPosix } from "./util.ts";

export interface Reference {
  req: string;
  file: string;
  line: number;
  /** True when the file matches the project's test globs. */
  isTest: boolean;
}

export interface TraceRow {
  req: Requirement;
  specStatus: string;
  cards: Card[];
  tests: Reference[];
  references: Reference[];
}

export interface Trace {
  rows: TraceRow[];
  /** `@req` comments naming a requirement that does not exist. */
  dangling: Reference[];
}

const MARKER = /@req\b[ \t:]*((?:REQ-[a-z][a-z0-9-]*-[0-9]{3,}[ \t,]*)+)/g;
const REQ = /REQ-[a-z][a-z0-9-]*-[0-9]{3,}/g;
const GREP = "@req[ \t:]*REQ-[a-z][a-z0-9-]*-[0-9]{3,}";
const SKIP_DIRS = new Set([".git", "node_modules", WORK_DIR, "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", ".cache"]);

function parseLine(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MARKER)) for (const r of m[1]!.matchAll(REQ)) out.push(r[0]);
  return out;
}

/** Find every `@req` comment outside the framework's own folders. Uses git when available (fast, honours .gitignore). */
export function findReferences(project: Project): Reference[] {
  const out: Reference[] = [];
  const reserved = RESERVED_DIRS.map((d) => `${d}/`);
  const add = (file: string, line: number, text: string) => {
    const f = toPosix(file);
    if (reserved.some((d) => f.startsWith(d)) || f.startsWith(`${WORK_DIR}/`) || matchesAny(f, project.config.trace.ignore)) return;
    const isTest = matchesAny(f, project.config.trace.tests);
    for (const req of parseLine(text)) out.push({ req, file: f, line, isTest });
  };
  const g = sh("git", ["grep", "-n", "-I", "--untracked", "--no-color", "-E", GREP], { cwd: project.root });
  if (g.code === 0 || (g.code === 1 && g.stderr === "")) {
    for (const row of g.stdout.split("\n")) {
      const m = /^([^:]+):([0-9]+):(.*)$/.exec(row);
      if (m) add(m[1]!, Number(m[2]), m[3]!);
    }
    return out;
  }
  // Not a git repository: walk the tree.
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const full = path.join(dir, e.name);
        if (fs.statSync(full).size > 2_000_000) continue;
        const text = fs.readFileSync(full, "utf8");
        if (!text.includes("@req")) continue;
        text.split("\n").forEach((l, i) => { if (l.includes("@req")) add(path.relative(project.root, full), i + 1, l); });
      }
    }
  };
  walk(project.root);
  return out;
}

export function buildTrace(project: Project, refs: Reference[] = findReferences(project)): Trace {
  const reqs = project.requirements();
  const specStatus = new Map(project.specs().map((s) => [s.id, s.status]));
  const rows: TraceRow[] = [];
  for (const req of reqs.values()) {
    const mine = refs.filter((r) => r.req === req.id);
    rows.push({
      req,
      specStatus: specStatus.get(req.specId) ?? "",
      cards: project.cards().filter((c) => c.implements.includes(req.id)),
      tests: mine.filter((r) => r.isTest),
      references: mine.filter((r) => !r.isTest),
    });
  }
  return { rows, dangling: refs.filter((r) => !reqs.has(r.req)) };
}

/** A requirement's place in the chain, in one word. */
export function coverage(row: TraceRow): "deprecated" | "unplanned" | "planned" | "built" | "verified" {
  if (row.req.status === "deprecated") return "deprecated";
  if (row.cards.length === 0) return "unplanned";
  if (!row.cards.some((c) => c.status === "done")) return "planned";
  return row.tests.length > 0 ? "verified" : "built";
}
