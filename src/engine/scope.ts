// Which paths a card may change: the card's scope AND the brief's scope, and the protected paths.
import { isSyncTemp, matchesAny } from "../util.ts";

export interface ScopeRules {
  /** The card's scope globs; empty means the card set no limit. */
  cardScope: string[];
  /** The brief's scope globs; empty means the brief inherits the card's. */
  briefScope: string[];
  protected: string[];
  allowProtected: string[];
}

export interface Violation {
  path: string;
  why: "outside scope" | "protected";
}

/**
 * A changed path must match the card's scope (when it has one) and the brief's scope (when it has
 * one), so a brief can narrow the card's scope but never widen it. Nothing is exempt: the card file
 * too must be inside the scope (the runtime's own status edit is filtered out by the caller).
 * Sync temporary and conflict files are not judged here; the merge refuses a
 * branch that commits them.
 */
export function scopeViolations(changed: string[], rules: ScopeRules): Violation[] {
  const out: Violation[] = [];
  for (const f of changed) {
    if (isSyncTemp(f)) continue;
    const outside = (rules.cardScope.length > 0 && !matchesAny(f, rules.cardScope)) || (rules.briefScope.length > 0 && !matchesAny(f, rules.briefScope));
    if (outside) out.push({ path: f, why: "outside scope" });
    else if (matchesAny(f, rules.protected) && !matchesAny(f, rules.allowProtected)) out.push({ path: f, why: "protected" });
  }
  return out;
}

/** What a change may touch, in words: the scopes that apply. */
export function scopeText(rules: ScopeRules): string {
  const parts: string[] = [];
  if (rules.cardScope.length) parts.push(`the card's scope (${rules.cardScope.join(", ")})`);
  if (rules.briefScope.length) parts.push(`the brief's scope (${rules.briefScope.join(", ")})`);
  return parts.join(" and ");
}

export function describeViolations(v: Violation[], rules: ScopeRules): string {
  const lines = v.map((x) => `- ${x.path} (${x.why === "protected" ? "a protected path this card was not granted" : "outside the scope"})`);
  const where = scopeText(rules);
  return `the change touches paths it may not write:\n${lines.join("\n")}\nRevert these files to their state on the base branch${where ? ` and keep every change inside ${where}` : ""}.`;
}
