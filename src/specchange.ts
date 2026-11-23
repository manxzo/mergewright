// Spec changes: specs are protected, so they change through a proposal file that the owner accepts.
//
//   specs/changes/CHG-3-account-lockout.change.md
//   ---
//   id: CHG-3
//   spec: auth
//   status: proposed            # proposed | accepted | rejected
//   summary: Lock accounts after five failed sign-ins
//   ---
//   ## Why
//   ...
//   ## modify REQ-auth-001
//   ### REQ-auth-001 Sign in with email and password
//   - priority: must
//   - AC-1: Given ..., when ..., then ...
//   ## add
//   ### REQ-auth-004 Account lockout
//   ...
//   ## deprecate REQ-auth-002
//   Replaced by REQ-auth-004.
import path from "node:path";
import { Diagnostics } from "./diagnostics.ts";
import { parseFrontmatter, renderFrontmatter, setFrontmatter } from "./frontmatter.ts";
import { parseSpec, REQ_ID, type Requirement } from "./model/spec.ts";
import type { Project } from "./project.ts";
import { validate } from "./schemas.ts";
import { listFiles, MwError, readText, slugify, today, writeAllAtomic, writeAtomic } from "./util.ts";

export type Op =
  | { kind: "modify"; target: string; req: Requirement; raw: string; line: number }
  | { kind: "add"; req: Requirement; raw: string; line: number }
  | { kind: "deprecate"; target: string; reason: string; line: number };

export interface Change {
  id: string;
  spec: string;
  status: "proposed" | "accepted" | "rejected";
  summary: string;
  ops: Op[];
  file: string;
}

const CHANGES_DIR = path.join("specs", "changes");
const OP_HEADING = /^##[ \t]+(modify|add|deprecate)(?:[ \t]+(\S+))?[ \t]*$/;

export function changeFiles(project: Project): string[] {
  return listFiles(project.abs(CHANGES_DIR), ".change.md");
}

/** Parse a change file. Problems with its form are reported to `diag`. */
export function parseChange(file: string, text: string, diag: Diagnostics): Change | undefined {
  const fm = parseFrontmatter(text);
  if (fm.error) {
    diag.error("change/front-matter", file, fm.error, 1);
    return undefined;
  }
  for (const m of validate("change", fm.data)) diag.error("change/schema", file, m, 1);
  const id = typeof fm.data.id === "string" ? fm.data.id : "";
  const specId = typeof fm.data.spec === "string" ? fm.data.spec : "";
  if (!id || !specId) return undefined;
  if (!path.basename(file).startsWith(`${id}-`) && path.basename(file) !== `${id}.change.md`) {
    diag.error("change/file-name", file, `change ${id} must be in a file named ${id}-<slug>.change.md`, 1);
  }

  // HTML comments (the skeleton's examples) are not part of the change: blank them, keeping line numbers.
  const lines = fm.body.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, "")).split(/\r?\n/);
  const ops: Op[] = [];
  // Split the body into "## ..." sections; only modify/add/deprecate sections are operations.
  const starts: { idx: number; kind?: string; arg?: string }[] = [];
  lines.forEach((l, idx) => {
    if (!/^##[ \t]+\S/.test(l)) return;
    const m = OP_HEADING.exec(l);
    starts.push({ idx, kind: m?.[1], arg: m?.[2] });
  });
  starts.forEach((s, n) => {
    if (!s.kind) return;
    const lineNo = fm.bodyLine + s.idx;
    const block = lines.slice(s.idx + 1, starts[n + 1]?.idx ?? lines.length).join("\n").trim();
    if (s.kind === "deprecate") {
      if (!s.arg || !REQ_ID.test(s.arg)) diag.error("change/op", file, "'## deprecate' must name a requirement, e.g. '## deprecate REQ-auth-002'", lineNo);
      else ops.push({ kind: "deprecate", target: s.arg, reason: block, line: lineNo });
      return;
    }
    // modify/add carry one requirement block, parsed with the spec grammar.
    const sub = new Diagnostics();
    const parsed = parseSpec(`${specId}.spec.md`, `---\nid: ${specId}\ntitle: x\nstatus: draft\n---\n${block}\n`, sub);
    for (const d of sub.items) diag.items.push({ ...d, file, line: lineNo + Math.max(1, (d.line ?? 6) - 5), code: d.code.replace(/^spec\//, "change/") });
    const req = parsed?.requirements[0];
    if (!req || (parsed?.requirements.length ?? 0) !== 1) {
      diag.error("change/op", file, `'## ${s.kind}' must contain exactly one requirement block ('### REQ-${specId}-nnn Title' with its lines)`, lineNo);
      return;
    }
    if (s.kind === "modify") {
      if (!s.arg) diag.error("change/op", file, "'## modify' must name the requirement it changes", lineNo);
      else if (s.arg !== req.id) diag.error("change/op", file, `'## modify ${s.arg}' contains ${req.id}; they must be the same requirement`, lineNo);
      else ops.push({ kind: "modify", target: s.arg, req, raw: block, line: lineNo });
    } else ops.push({ kind: "add", req, raw: block, line: lineNo });
  });
  if (ops.length === 0 && fm.data.status === "proposed" && !diag.errors.some((e) => e.file === file)) diag.error("change/empty", file, "the change has no operations ('## modify REQ-…', '## add' or '## deprecate REQ-…')", fm.bodyLine);
  return { id, spec: specId, status: fm.data.status as Change["status"], summary: String(fm.data.summary ?? ""), ops, file };
}

/** Check a proposed change against the specs as they are now. */
export function checkChange(project: Project, change: Change, diag: Diagnostics): void {
  const spec = project.specs().find((s) => s.id === change.spec);
  if (!spec) {
    diag.error("change/unknown-spec", change.file, `spec '${change.spec}' does not exist`, 1);
    return;
  }
  const reqs = project.requirements();
  const touched = new Set<string>();
  for (const op of change.ops) {
    const target = op.kind === "add" ? op.req.id : op.target;
    if (touched.has(target)) {
      diag.error("change/op", change.file, `${target} appears in more than one operation; a change may touch each requirement once`, op.line);
      continue;
    }
    touched.add(target);
    if (op.kind === "add") {
      if (reqs.has(op.req.id)) {
        const used = spec.requirements.map((r) => Number(REQ_ID.exec(r.id)![2]));
        const next = String(Math.max(0, ...used) + 1).padStart(3, "0");
        diag.error("change/op", change.file, `${op.req.id} already exists; the next free id is REQ-${spec.id}-${next}`, op.line);
      }
    } else if (reqs.get(op.target)?.specId !== spec.id) {
      diag.error("change/op", change.file, `${op.target} is not a requirement of spec '${spec.id}'`, op.line);
    }
  }
}

export function loadChanges(project: Project, diag: Diagnostics): Change[] {
  const out: Change[] = [];
  for (const f of changeFiles(project)) {
    const c = parseChange(project.rel(f), readText(f), diag);
    if (c) out.push(c);
  }
  return out;
}

export function nextChangeId(project: Project): string {
  const max = changeFiles(project).reduce((m, f) => Math.max(m, Number(/^CHG-([0-9]+)/.exec(path.basename(f))?.[1] ?? 0)), 0);
  return `CHG-${max + 1}`;
}

/** Create a proposal file. `body` holds the operations; without it a commented skeleton is written. */
export function proposeChange(project: Project, specId: string, summary: string, body?: string, by?: string): string {
  if (!project.specs().some((s) => s.id === specId)) throw new MwError("change/unknown-spec", `spec '${specId}' does not exist`);
  if (!summary.trim()) throw new MwError("change/summary", "a change needs a one-line summary (--summary)");
  const id = nextChangeId(project);
  const rel = path.join(CHANGES_DIR, `${id}-${slugify(summary)}.change.md`);
  const data: Record<string, unknown> = { id, spec: specId, status: "proposed", summary: summary.trim(), date: today() };
  if (by) data.by = by;
  const skeleton = `## Why\n\n(why the spec should change)\n\n<!-- One section per operation. Delete what you do not need.\n\n## modify REQ-${specId}-001\n### REQ-${specId}-001 Title\n- priority: must\n- AC-1: Given ..., when ..., then ...\n\n## add\n### REQ-${specId}-00N Title\n- priority: should\n- AC-1: Given ..., when ..., then ...\n\n## deprecate REQ-${specId}-002\nReason.\n-->\n`;
  const text = renderFrontmatter(data, body?.trim() ? `${body.trim()}\n` : skeleton);
  if (body?.trim()) {
    const diag = new Diagnostics();
    const change = parseChange(rel, text, diag);
    if (change) checkChange(project, change, diag);
    if (diag.errors.length) throw new MwError("change/invalid", `the proposal is not valid: ${diag.errors.map((e) => e.message).join("; ")}`);
  }
  writeAtomic(project.abs(rel), text);
  return rel;
}

export interface AcceptResult {
  specFile: string;
  changed: { req: string; rev: number; op: Op["kind"] }[];
  /** Cards written against an older revision of a changed requirement. */
  stale: string[];
}

/** Apply a proposed change to its spec, bump revisions, and mark the proposal accepted. */
export function acceptChange(project: Project, changeId: string): AcceptResult {
  if (project.isWorktree || process.env.MW_ROLE) {
    throw new MwError("change/owner-only", "spec changes are accepted by the owner from the main checkout, not from inside a card run");
  }
  const diag = new Diagnostics();
  const change = loadChanges(project, diag).find((c) => c.id === changeId);
  if (!change) throw new MwError("change/unknown", `there is no change ${changeId} in ${CHANGES_DIR}/`);
  if (change.status !== "proposed") throw new MwError("change/status", `${changeId} is already ${change.status}`);
  checkChange(project, change, diag);
  const mine = diag.errors.filter((e) => e.file === change.file);
  if (mine.length) throw new MwError("change/invalid", `${changeId} cannot be applied: ${mine.map((e) => e.message).join("; ")}`);

  const spec = project.specs().find((s) => s.id === change.spec)!;
  const specPath = project.abs(spec.file);
  let lines = readText(specPath).replace(/\n+$/, "").split("\n");
  const changed: AcceptResult["changed"] = [];
  // Apply bottom-up so earlier line numbers stay valid; additions go last.
  const located = change.ops.filter((o): o is Exclude<Op, { kind: "add" }> => o.kind !== "add")
    .map((op) => ({ op, cur: spec.requirements.find((r) => r.id === op.target)! }))
    .sort((a, b) => b.cur.line - a.cur.line);
  for (const { op, cur } of located) {
    const rev = cur.rev + 1;
    let end = cur.endLine;
    while (end > cur.line && (lines[end - 1] ?? "").trim() === "") end--; // keep the blank lines that follow the block
    let block: string[];
    if (op.kind === "modify") block = withMeta(op.raw.split("\n"), rev, cur.status === "deprecated");
    else {
      block = withMeta(lines.slice(cur.line - 1, end), rev, true);
      if (op.reason) block.push("", `Deprecated by ${change.id}: ${op.reason.split("\n")[0]}`);
    }
    lines = [...lines.slice(0, cur.line - 1), ...block, ...lines.slice(end)];
    changed.push({ req: cur.id, rev, op: op.kind });
  }
  for (const op of change.ops) {
    if (op.kind !== "add") continue;
    lines.push("", ...withMeta(op.raw.split("\n"), 1, false));
    changed.push({ req: op.req.id, rev: 1, op: "add" });
  }
  // Both files are staged before either is replaced, so a failed write cannot leave the spec
  // changed while the proposal still reads "proposed" (which would let it be applied twice).
  const changePath = project.abs(change.file);
  writeAllAtomic([
    { file: specPath, content: lines.join("\n") + "\n" },
    { file: changePath, content: setFrontmatter(readText(changePath), { status: "accepted", accepted: today() }) },
  ]);

  const bumped = new Map(changed.filter((c) => c.op !== "add").map((c) => [c.req, c.rev]));
  const stale = project.cards().filter((c) => c.implements.some((r) => (bumped.get(r) ?? 0) > (c.revs[r] ?? 1))).map((c) => c.id);
  return { specFile: spec.file, changed: changed.reverse(), stale };
}

/**
 * A requirement block with its managed lines set: any `rev`/`status` lines the author wrote are
 * dropped and the real ones are placed right after the priority line (or the heading).
 */
function withMeta(block: string[], rev: number, deprecated: boolean): string[] {
  const kept = block.filter((l) => !/^[-*][ \t]+(rev|status):/.test(l));
  const meta: string[] = [];
  if (rev > 1) meta.push(`- rev: ${rev}`);
  if (deprecated) meta.push("- status: deprecated");
  const at = kept.findIndex((l) => /^[-*][ \t]+priority:/.test(l));
  kept.splice(at >= 0 ? at + 1 : 1, 0, ...meta);
  return kept;
}

export function rejectChange(project: Project, changeId: string, reason: string): void {
  const diag = new Diagnostics();
  const change = loadChanges(project, diag).find((c) => c.id === changeId);
  if (!change) throw new MwError("change/unknown", `there is no change ${changeId} in ${CHANGES_DIR}/`);
  if (change.status !== "proposed") throw new MwError("change/status", `${changeId} is already ${change.status}`);
  const p = project.abs(change.file);
  writeAtomic(p, setFrontmatter(readText(p), { status: "rejected", rejected: today(), reason: reason || undefined }));
}
