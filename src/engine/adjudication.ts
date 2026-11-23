// The rules an adjudication must keep beyond its schema (REQ-adjudication-001..003): it
// decides only findings that exist, it decides every blocking finding, and an approval never accepts
// a blocker. One function, used after schema validation in a role phase and again before the merge.
import type { Adjudication, Finding, Findings } from "./context.ts";

/**
 * The finding an adjudication's id names: the finding with exactly that id, else the one whose id ends
 * in `:<id>` (findings are stored prefixed with their reviewer's role id, `reviewer:R-01`). `ambiguous`
 * when the short form fits more than one finding.
 */
export function findingFor(findings: readonly Finding[], id: string): Finding | "ambiguous" | undefined {
  const exact = findings.find((f) => f.id === id);
  if (exact) return exact;
  const matches = findings.filter((f) => f.id.endsWith(`:${id}`));
  return matches.length > 1 ? "ambiguous" : matches[0];
}

/**
 * Why `a` is not a consistent decision on `findings` (an empty list when it is). Call it only on an
 * adjudication that satisfies the schema; a missing findings artifact counts as no findings.
 */
export function adjudicationErrors(a: Adjudication, findings: Findings | undefined): string[] {
  const all = findings?.findings ?? [];
  const errors: string[] = [];
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  const decided = new Set<string>();
  const acceptedBlockers: string[] = [];
  const named = [...a.accepted.map((id) => ({ id, accepted: true })), ...a.rejected.map((r) => ({ id: r.id, accepted: false }))];
  for (const { id, accepted } of named) {
    const f = findingFor(all, id);
    if (f === undefined) unknown.push(id);
    else if (f === "ambiguous") ambiguous.push(id);
    else {
      decided.add(f.id);
      if (accepted && f.blocking) acceptedBlockers.push(f.id);
    }
  }
  const list = (ids: string[]) => [...new Set(ids)].map((x) => `'${x}'`).join(", ");
  if (unknown.length) {
    const known = all.map((f) => f.id);
    errors.push(`the findings artifact has no finding with the id ${list(unknown)}; use only these ids: ${known.length ? known.join(", ") : "(there are no findings)"}`);
  }
  // Two findings with one full id cannot be told apart by an adjudication (one might block, the other
  // not), so a findings artifact that repeats an id can never be adjudicated: fail closed.
  const seen = new Set<string>();
  const duplicated = all.map((f) => f.id).filter((id) => seen.has(id) || !seen.add(id));
  if (duplicated.length) errors.push(`the findings artifact holds more than one finding with the id ${list(duplicated)}, so no decision on that id is unambiguous; the findings must be reviewed again`);
  if (ambiguous.length) errors.push(`the id ${list(ambiguous)} fits more than one finding; use the full id as the findings list shows it`);
  const undecided = all.filter((f) => f.blocking && !decided.has(f.id)).map((f) => f.id);
  if (undecided.length) errors.push(`the blocking finding ${list(undecided)} is in neither 'accepted' nor 'rejected'; decide every blocking finding`);
  if (a.verdict === "approve" && acceptedBlockers.length) {
    errors.push(`the verdict is 'approve' but 'accepted' holds the blocking finding ${list(acceptedBlockers)}; an approval cannot accept a blocker: reject it with a reason, or give the verdict 'reject' or 'block'`);
  }
  return errors;
}
