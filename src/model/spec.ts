// specs/*.spec.md: requirements with stable ids and fixed-form acceptance criteria.
//
//   ---
//   id: auth
//   title: Authentication
//   status: accepted
//   ---
//   ### REQ-auth-001 Sign in with email and password
//   - priority: must
//   - AC-1: Given a registered user, when they submit valid credentials, then a session starts.
import { Diagnostics } from "../diagnostics.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { validate } from "../schemas.ts";
import { SLUG } from "../util.ts";

export interface Criterion {
  id: string;
  text: string;
  line: number;
}

export interface Requirement {
  id: string;
  title: string;
  priority?: "must" | "should" | "could";
  rev: number;
  status: "active" | "deprecated";
  criteria: Criterion[];
  specId: string;
  file: string;
  /** 1-based line of the heading, and of the last line of the block. */
  line: number;
  endLine: number;
}

export interface Spec {
  id: string;
  title: string;
  status: string;
  file: string;
  requirements: Requirement[];
}

export const REQ_ID = /^REQ-([a-z][a-z0-9-]*)-([0-9]{3,})$/;
const REQ_HEADING = /^###[ \t]+(REQ-[a-z][a-z0-9-]*-[0-9]{3,})[ \t]+(\S.*?)[ \t]*$/;
const LOOSE_REQ_HEADING = /^#{1,6}[ \t]+(REQ-\S*)/;
const HEADING = /^(#{1,6})[ \t]+\S/;
const FIELD = /^[-*][ \t]+(priority|rev|status):[ \t]*(.*?)[ \t]*$/;
const CRITERION = /^[-*][ \t]+(AC-[0-9]+):[ \t]*(.*?)[ \t]*$/;
const LOOSE_CRITERION = /^[-*][ \t]+(AC\b[^:]*):/;
const GIVEN_WHEN_THEN = /^given\b.+\bwhen\b.+\bthen\b.+/i;

/** Parse one spec file. `file` is the project-relative path used in diagnostics. */
export function parseSpec(file: string, text: string, diag: Diagnostics): Spec | undefined {
  const fm = parseFrontmatter(text);
  if (fm.error) {
    diag.error("spec/front-matter", file, fm.error, 1);
    return undefined;
  }
  for (const m of validate("spec", fm.data)) diag.error("spec/schema", file, m, 1);
  const id = typeof fm.data.id === "string" && SLUG.test(fm.data.id) ? fm.data.id : "";
  const spec: Spec = { id, title: String(fm.data.title ?? ""), status: String(fm.data.status ?? ""), file, requirements: [] };
  const expectedName = `${id}.spec.md`;
  if (id && !file.endsWith(`/${expectedName}`) && file !== expectedName) {
    diag.error("spec/file-name", file, `a spec with id '${id}' must be in a file named ${expectedName}`, 1);
  }

  const lines = fm.body.split(/\r?\n/);
  let cur: Requirement | undefined;
  let inFence = false;
  const seenAc = new Set<string>();
  const close = (endIdx: number) => {
    if (!cur) return;
    cur.endLine = fm.bodyLine + endIdx;
    if (!cur.priority) diag.error("spec/priority", file, `${cur.id} has no '- priority: must|should|could' line`, cur.line);
    else if (cur.priority !== "could" && cur.criteria.length === 0 && cur.status === "active") {
      diag.error("spec/no-criteria", file, `${cur.id} is '${cur.priority}' but has no acceptance criteria ('- AC-1: Given ..., when ..., then ...')`, cur.line);
    }
    spec.requirements.push(cur);
    cur = undefined;
    seenAc.clear();
  };

  lines.forEach((raw, idx) => {
    const lineNo = fm.bodyLine + idx;
    if (/^(```|~~~)/.test(raw.trim())) { inFence = !inFence; return; }
    if (inFence) return;
    const heading = REQ_HEADING.exec(raw);
    if (heading) {
      close(idx - 1);
      const rid = heading[1]!;
      const m = REQ_ID.exec(rid)!;
      if (id && m[1] !== id) diag.error("spec/req-prefix", file, `${rid} is in spec '${id}', so its id must start with REQ-${id}-`, lineNo);
      if (spec.requirements.some((r) => r.id === rid)) diag.error("spec/duplicate-req", file, `${rid} is defined twice in this file`, lineNo);
      cur = { id: rid, title: heading[2]!, rev: 1, status: "active", criteria: [], specId: id, file, line: lineNo, endLine: lineNo };
      return;
    }
    const loose = LOOSE_REQ_HEADING.exec(raw);
    if (loose) {
      close(idx - 1);
      diag.error("spec/req-heading", file, `'${raw.trim()}' is not a valid requirement heading; use '### REQ-${id || "<spec>"}-001 Title' (three #, three or more digits, a title)`, lineNo);
      return;
    }
    const h = HEADING.exec(raw);
    if (h && h[1]!.length <= 3) { close(idx - 1); return; }
    if (!cur) return;
    const field = FIELD.exec(raw);
    if (field) {
      const [, key, value] = field as unknown as [string, string, string];
      if (key === "priority") {
        if (value === "must" || value === "should" || value === "could") cur.priority = value;
        else diag.error("spec/priority", file, `${cur.id}: priority must be must, should or could (found '${value}')`, lineNo);
      } else if (key === "rev") {
        if (/^[1-9][0-9]*$/.test(value)) cur.rev = Number(value);
        else diag.error("spec/rev", file, `${cur.id}: rev must be a positive whole number (found '${value}')`, lineNo);
      } else if (value === "active" || value === "deprecated") cur.status = value;
      else diag.error("spec/status", file, `${cur.id}: status must be active or deprecated (found '${value}')`, lineNo);
      return;
    }
    const ac = CRITERION.exec(raw);
    if (ac) {
      const [, acId, acText] = ac as unknown as [string, string, string];
      if (seenAc.has(acId)) diag.error("spec/duplicate-criterion", file, `${cur.id} has two criteria named ${acId}`, lineNo);
      seenAc.add(acId);
      if (!GIVEN_WHEN_THEN.test(acText)) {
        diag.error("spec/criterion-form", file, `${cur.id} ${acId} must read 'Given ..., when ..., then ...'`, lineNo);
      }
      cur.criteria.push({ id: acId, text: acText, line: lineNo });
      return;
    }
    if (LOOSE_CRITERION.test(raw)) {
      diag.error("spec/criterion-id", file, `${cur.id}: acceptance criteria are written '- AC-1: Given ..., when ..., then ...'`, lineNo);
    }
  });
  close(lines.length - 1);
  if (spec.status === "deprecated") for (const r of spec.requirements) r.status = "deprecated";
  if (inFence) diag.warn("spec/unclosed-fence", file, "a code fence is opened and never closed; anything after it is ignored", 1);
  return spec;
}

/** The exact text of a requirement block as it should appear in a spec file. */
export function renderRequirement(r: Pick<Requirement, "id" | "title" | "priority" | "rev" | "status" | "criteria">): string {
  const out = [`### ${r.id} ${r.title}`, `- priority: ${r.priority ?? "should"}`];
  if (r.rev > 1) out.push(`- rev: ${r.rev}`);
  if (r.status === "deprecated") out.push("- status: deprecated");
  for (const c of r.criteria) out.push(`- ${c.id}: ${c.text}`);
  return out.join("\n");
}
