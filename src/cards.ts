// Creating cards and keeping their managed fields (status, requirement revisions) correct.
import fs from "node:fs";
import path from "node:path";
import { Diagnostics } from "./diagnostics.ts";
import { renderFrontmatter, setFrontmatter } from "./frontmatter.ts";
import { repoTransaction, requireBase, requireIdentity, writeAndCommit } from "./mcpserver/repo.ts";
import { parseCard, type Card, type CardKind, type CardStatus } from "./model/card.ts";
import { cardNumber, Project } from "./project.ts";
import { git, matchesAny, MwError, readText, writeAtomic } from "./util.ts";

export interface NewCard {
  title: string;
  kind?: CardKind;
  implements?: string[];
  scope?: string[];
  risk?: string;
  flow?: string;
  depends?: string[];
  why?: string;
  /** The `## Out of scope` text; without it the section holds OUT_OF_SCOPE_SCAFFOLD (which lint reports). */
  outOfScope?: string;
  /** Acceptance criteria, one per item, written as a `## Acceptance` list (no section when none). */
  acceptance?: string[];
  /** Free labels, written to the frontmatter `tags:`. */
  tags?: string[];
  /** The starting status: todo (default) or ready (picked up by `mw work`). */
  status?: "todo" | "ready";
  /**
   * Add the project's `docs.paths` to a given scope (`mw card new` does unless `--no-docs`), so the
   * card can update the documentation its change makes stale (spec 4.2). A card without a scope gets none.
   */
  withDocs?: boolean;
  /**
   * For `mw card new`: refuse up front, with `mw check`'s message, a feature card that names
   * no requirement while `trace.require_implements` is true, instead of writing a card that fails the check.
   */
  requireImplements?: boolean;
}

/** `mw check`'s message for a feature card that implements nothing (code `card/no-requirement`). */
export const NO_REQUIREMENT_MESSAGE = "a feature card must say which requirement it implements ('implements: [REQ-...]'); use kind: chore, fix, docs or spike for work with no requirement";

/** The `## Why` text `mw card new` writes when no `why` is given; lint reports it as `lint/why-empty`. */
export const WHY_SCAFFOLD = "(say why this work matters)";
/** The `## Out of scope` text `mw card new` writes when none is given; lint reports it as `lint/placeholder`. */
export const OUT_OF_SCOPE_SCAFFOLD = "(what this card must not touch)";

/** A path a glob stands for, to compare globs: each wildcard part becomes a plain name. */
function sample(glob: string): string {
  return glob.replace(/\*\*/g, "x").replace(/[*?]/g, "x").replace(/\[[^\]]*\]/g, "x").replace(/\{([^,}]*)[^}]*\}/g, "$1");
}

/**
 * True when `scope` and `docs` overlap: some documentation path is inside the scope, or some scope
 * glob is inside the documentation paths (a scope of `docs/guides/**` covers part of `docs/**`).
 */
export function scopeCoversDocs(scope: readonly string[], docs: readonly string[]): boolean {
  return docs.some((d) => scope.includes(d) || matchesAny(sample(d), scope)) || scope.some((g) => matchesAny(sample(g), docs));
}

/**
 * True when glob `g` names a protected path: it is one of the `protectedPaths` globs, or a path it
 * stands for matches one (`AGENTS.md` when `AGENTS.md` is protected; not `docs/**` beside `docs/adr/**`).
 */
export function isProtectedGlob(g: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.includes(g) || matchesAny(sample(g), protectedPaths);
}

/**
 * `scope` plus every documentation path it does not already cover, leaving out any
 * documentation path that is itself protected or names a protected path: a card gets a protected
 * path only through `allow_protected`, never by the automatic addition.
 */
export function scopeWithDocs(scope: readonly string[], docs: readonly string[], protectedPaths: readonly string[] = []): string[] {
  const out = [...scope];
  for (const d of docs) if (!out.includes(d) && !matchesAny(sample(d), out) && !isProtectedGlob(d, protectedPaths)) out.push(d);
  return out;
}

/**
 * The next free card id: one past the highest number among the card files on disk and the card files
 * the base branch's last commit holds. The second matters on a hub-backed project: after adopting the
 * hub's history, a card the other machine created is in HEAD before the file-sync tool delivers its file, and
 * its id must not be minted again.
 */
export function nextCardId(project: Project): string {
  const prefix = project.config.cards.prefix;
  let max = project.cards().reduce((m, c) => Math.max(m, cardNumber(c.id)), 0);
  const tree = git(project.root, ["ls-tree", "--name-only", "HEAD", "--", "cards/"], { allowFail: true });
  if (tree.code === 0) {
    for (const line of tree.stdout.split("\n")) {
      const m = /^cards\/([A-Z][A-Z0-9]{0,9})-([0-9]+)\.card\.md$/.exec(line.trim());
      if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
    }
  }
  return `${prefix}-${max + 1}`;
}

/** A card as newCard() would write it: its id, file and text. Validates the input; writes nothing. */
function prepareNewCard(project: Project, c: NewCard): { id: string; rel: string; text: string; status: "todo" | "ready" } {
  if (!c.title.trim()) throw new MwError("card/title", "a card needs a title");
  const reqs = project.requirements();
  const revs: Record<string, number> = {};
  for (const id of c.implements ?? []) {
    const r = reqs.get(id);
    if (!r) throw new MwError("card/unknown-requirement", `${id} is not defined by any spec`);
    revs[id] = r.rev;
  }
  const status = c.status ?? "todo";
  if (status !== "todo" && status !== "ready") throw new MwError("card/status", `a new card is todo or ready, not '${String(status)}'`);
  if (c.requireImplements && project.config.trace.requireImplements && (c.kind ?? "feature") === "feature" && !c.implements?.length) {
    throw new MwError("card/no-requirement", `not written: ${NO_REQUIREMENT_MESSAGE} (--implements REQ-..., or --kind chore|fix|docs|spike)`);
  }
  const tags = [...new Set((c.tags ?? []).map((t) => t.trim()).filter(Boolean))];
  const id = nextCardId(project);
  const data: Record<string, unknown> = { id, title: c.title.trim(), kind: c.kind ?? "feature", status };
  if (c.implements?.length) { data.implements = c.implements; data.revs = revs; }
  if (c.risk) data.risk = c.risk;
  if (c.flow) data.flow = c.flow;
  if (c.scope?.length) data.scope = c.withDocs ? scopeWithDocs(c.scope, project.config.docs.paths, project.config.protected) : c.scope;
  if (c.depends?.length) data.depends = c.depends;
  if (tags.length) data.tags = tags;
  const criteria = (c.acceptance ?? []).map((x) => x.trim()).filter(Boolean).map((x) => (/^[-*] /.test(x) ? x : `- ${x}`));
  const body = `## Why\n\n${c.why?.trim() || WHY_SCAFFOLD}\n\n## Out of scope\n\n${c.outOfScope?.trim() || OUT_OF_SCOPE_SCAFFOLD}\n`
    + (criteria.length ? `\n## Acceptance\n\n${criteria.join("\n")}\n` : "");
  const rel = path.join("cards", `${id}.card.md`);
  return { id, rel, text: renderFrontmatter(data, body), status };
}

/**
 * Refuse, writing nothing, a new card that newCard() would refuse: bad input, or (REQ-cards-003) a
 * card created ready that fails lint, linted as it would be written. The MCP server calls it before
 * its repository transaction; newCard() calls it again before it writes.
 */
export function assertNewCardReady(project: Project, c: NewCard): void {
  checkNewCard(project, prepareNewCard(project, c));
}

function checkNewCard(project: Project, p: { id: string; rel: string; text: string; status: string }): void {
  if (p.status !== "ready") return;
  const parsed = parseCard(p.rel, p.text, new Diagnostics());
  if (parsed) assertCardReady(project, parsed, `${p.id} was not created ready`);
}

export function newCard(project: Project, c: NewCard): string {
  const prepared = prepareNewCard(project, c);
  checkNewCard(project, prepared);
  writeAtomic(project.abs(prepared.rel), prepared.text);
  return prepared.id;
}

export type LintSeverity = "error" | "warning";
export interface LintFinding {
  code: string;
  severity: LintSeverity;
  message: string;
}
/** What `mw card lint --json` prints and `mw_card_lint` returns: the same object, from cardLintReport(). */
export interface LintReport {
  id: string;
  ok: boolean;
  findings: LintFinding[];
}

/** A file path in a backtick span (`README.md`, `src/a.ts`, `docs/**`): a name with an extension, or a directory glob. */
const PATH_TOKEN = /^(?:[\w.*-]+\/)*(?:[\w*-][\w.*-]*\.[A-Za-z][A-Za-z0-9]{0,7}|\*\*?)$/;
/**
 * A path in a backtick span with a directory part and no extension: `bin/mw`, `docs/guide`, `src/engine/`.
 * It counts when it ends in `/` or its first directory is at the project root, so codes such as
 * `lint/placeholder` or `card/no-requirement` are not taken for paths.
 */
const DIR_PATH_TOKEN = /^(?:[\w.*-]+\/)+[\w.*-]*$/;
/** A name without a directory or extension (`Dockerfile`): a path only when it is a root file. */
const BARE_NAME = /^[\w-][\w.-]*$/;

/**
 * The file paths a card's `## Acceptance` names: backtick spans that look like a path, and bare words
 * with a directory part and an extension (`src/cards.ts`). In a backtick span a path with a directory
 * part needs no extension (`bin/mw`). A name without a directory (`README.md`, `Dockerfile`) counts
 * only when a file of that name is at the project root, so a script named by its base name is not
 * mistaken for a root file and a word is not mistaken for a path.
 */
function namedPaths(project: Project, text: string): string[] {
  const out = new Set<string>();
  const isFile = (f: string) => fs.statSync(f, { throwIfNoEntry: false })?.isFile() === true;
  const isDir = (f: string) => fs.statSync(f, { throwIfNoEntry: false })?.isDirectory() === true;
  const consider = (raw: string, quoted: boolean) => {
    const t = raw.replace(/^[("'[]+/, "").replace(/[)"'\],;:.!?]+$/, "");
    if (!t || t.includes("://") || t.startsWith("-")) return;
    if (!PATH_TOKEN.test(t) && !(quoted && (BARE_NAME.test(t) || (DIR_PATH_TOKEN.test(t) && (t.endsWith("/") || isDir(project.abs(t.split("/")[0]!))))))) return;
    if (!t.includes("/") && !(quoted && isFile(project.abs(t)))) return;
    const p = t.replace(/^\.\//, "");
    // A directory named without its trailing slash (`src/engine`) is checked as one (`src/engine/`).
    out.add(quoted && !p.endsWith("/") && !PATH_TOKEN.test(p) && isDir(project.abs(p)) ? `${p}/` : p);
  };
  const parts = text.split("`");
  parts.forEach((part, i) => {
    if (i % 2 === 1) consider(part.trim(), true);
    else for (const word of part.split(/\s+/)) consider(word, false);
  });
  return [...out];
}

/** True when `p` (a path or a glob) lies inside one of the scope globs. */
function inScope(p: string, scope: readonly string[]): boolean {
  return scope.includes(p) || matchesAny(sample(p), scope);
}

/**
 * Is the card ready to run (REQ-cards-001)? Read-only: it writes no file, commit or memory. Errors
 * stop the card from becoming ready and a fresh run from starting; warnings are reported only.
 * `lint/depends-open` is a warning: `mw work` already waits for a card's dependencies.
 */
export function lintCard(project: Project, id: string): LintFinding[] {
  return lintParsedCard(project, project.card(id));
}

function lintParsedCard(project: Project, card: Card): LintFinding[] {
  const out: LintFinding[] = [];
  const error = (code: string, message: string) => out.push({ code, severity: "error", message });
  const outOfScope = card.sections["out of scope"];
  if (outOfScope === OUT_OF_SCOPE_SCAFFOLD) {
    error("lint/placeholder", `The '## Out of scope' section still holds the text 'mw card new' wrote; say what this card must not touch, or write None.`);
  }
  const why = card.sections["why"] ?? "";
  if (!why || why === WHY_SCAFFOLD) error("lint/why-empty", "The '## Why' section is empty or still holds the text 'mw card new' wrote; say why this work matters.");
  const acceptance = card.sections["acceptance"] ?? "";
  if (!acceptance && card.implements.length === 0) {
    error("lint/no-acceptance", "The card has no '## Acceptance' criteria and implements no requirement; add an '## Acceptance' list or an 'implements:' requirement.");
  }
  if (card.scope.length === 0) error("lint/scope-empty", "The card has no 'scope:' globs; list the paths its agents may write.");
  // Both directions: a scope glob inside a protected glob (`roles/a.md` in `roles/**`), and a protected
  // glob inside a broad scope glob (`roles/**` in `**`). Either is fine when `allow_protected:` grants it.
  // A documentation path (`docs.paths`) may stand beside the protected paths beneath it (`docs/**` beside
  // `docs/adr/**`), as the automatic docs scope does, so it is checked in the first direction only.
  const docsPaths = project.config.docs.paths;
  for (const g of card.scope) {
    const hit = project.config.protected.filter((p) =>
      (!docsPaths.includes(g) && inScope(p, [g]) && !isProtectedGlob(p, card.allowProtected))
      || (isProtectedGlob(g, [p]) && !isProtectedGlob(g, card.allowProtected)));
    if (hit.length) {
      error("lint/scope-protected", `The scope glob '${g}' covers the protected path${hit.length > 1 ? "s" : ""} ${hit.map((p) => `'${p}'`).join(", ")}, which 'allow_protected:' does not grant; narrow or remove it in 'scope:', or ask the owner to grant it.`);
    }
  }
  const outputs = [...namedPaths(project, acceptance).map((p) => ["## Acceptance", p] as const), ...card.docs.map((p) => ["docs:", p] as const)];
  const seen = new Set<string>();
  for (const [where, p] of outputs) {
    if (seen.has(p) || card.scope.length === 0 || inScope(p, card.scope)) continue;
    seen.add(p);
    error("lint/output-outside-scope", `The path '${p}' named in '${where}' is covered by no scope glob; add it to 'scope:', or take it out of '${where}'.`);
  }
  const cards = new Map(project.cards().map((c) => [c.id, c]));
  for (const dep of card.depends) {
    const d = cards.get(dep);
    if (d?.status === "done") continue;
    out.push({ code: "lint/depends-open", severity: "warning", message: d ? `The card depends on ${dep}, which is ${d.status}, not done; it runs only after ${dep} is done.` : `The card depends on ${dep}, which does not exist; remove it from 'depends:' or create it.` });
  }
  const reqs = project.requirements();
  for (const rid of card.implements) {
    const r = reqs.get(rid);
    const known = card.revs[rid] ?? 1;
    if (r && r.rev !== known) {
      error("lint/stale", `The card was written against ${rid} rev ${known}, but the requirement is now rev ${r.rev}; review the card, then run 'mw card ack ${card.id}'.`);
    }
  }
  return out;
}

/** `mw card lint <ID> --json` and the MCP tool `mw_card_lint` both return this (REQ-cards-002). */
export function cardLintReport(project: Project, id: string): LintReport {
  const findings = lintCard(project, id);
  return { id, ok: !findings.some((f) => f.severity === "error"), findings };
}

/**
 * Refuse, before anything is written, a card with lint errors (REQ-cards-003). `refused` starts the
 * message ("DEMO-3 was not set ready"); the codes and what to do next follow. Returns the warnings.
 */
export function assertCardReady(project: Project, card: Card, refused: string): LintFinding[] {
  const findings = lintParsedCard(project, card);
  const errors = findings.filter((f) => f.severity === "error");
  if (errors.length) {
    const codes = [...new Set(errors.map((f) => f.code))].join(", ");
    // The data (results.ts NotReadyData) lets a board show the findings beside the refusal.
    throw new MwError("card/not-ready", `${refused}: it has lint errors (${codes}). ${errors.map((f) => f.message).join(" ")} Fix the card, check it with 'mw card lint ${card.id}', then try again; nothing was written.`, { lint: { id: card.id, ok: false, findings } });
  }
  return findings;
}

/** Record that the card has been reviewed against the current revision of its requirements. */
export function ackCard(project: Project, id: string): Record<string, number> {
  const card = project.card(id);
  const reqs = project.requirements();
  const revs: Record<string, number> = {};
  for (const r of card.implements) revs[r] = reqs.get(r)?.rev ?? 1;
  const file = project.abs(card.file);
  writeAtomic(file, setFrontmatter(readText(file), { revs: Object.keys(revs).length ? revs : undefined }));
  return revs;
}

export interface CardCommit {
  /** What is committed, for messages ("a card", "a card status"). */
  what: string;
  /** The card file (repository-relative) when it exists already; none for a new card. */
  file?: string;
  /** The commit subject, or a function giving it after the write. */
  subject: string | (() => string);
  /** Runs in the transaction, after the hub was adopted and before the write (checks again). */
  before?: (now: Project) => void | Promise<void>;
  /** Writes the card file and returns its repository-relative path. */
  write: (now: Project) => string;
  /**
   * Runs in the transaction once the card file is committed, before the push (sets a run aside), so a
   * failed commit has changed nothing else. A failure here is reported after the push, saying the card
   * is already committed.
   */
  after?: (now: Project) => void | Promise<void>;
}

/**
 * REQ-cards-006 (`mw card status <ID> todo|ready --commit`, `mw card new --commit`): write one card
 * file and commit it alone on the base branch, through the transaction the MCP card tools use
 * (repoTransaction and writeAndCommit, spec section 12.5): the repository lock; on a hub-backed
 * project the lease, the hub adopted first and the commit pushed fenced by the lease. Refused before
 * anything is written when the checkout is not on the base branch, git has no identity, or the index
 * holds staged changes to other files. Returns the lines that say what was committed and pushed.
 */
export async function commitCardChange(project: Project, c: CardCommit): Promise<string> {
  requireBase(project, "card/branch", c.what);
  requireIdentity(project, c.what);
  const staged = git(project.root, ["diff", "--cached", "--name-only", "-z"], { allowFail: true }).stdout.split("\0").filter((f) => f && f !== c.file);
  if (staged.length) {
    throw new MwError("card/staged", `the index holds staged changes to ${staged.join(", ")}, and --commit commits the card file alone, so nothing was written. Commit or unstage them first ('git commit', or 'git restore --staged <file>'), then try again.`);
  }
  let failed: unknown;
  const value = await repoTransaction(project, async () => {
    const now = new Project(project.root);
    await c.before?.(now);
    const committed = writeAndCommit(now, { branchCode: "card/branch", what: c.what, files: c.file ? [c.file] : [], subject: c.subject }, () => [c.write(now)]);
    // Caught here, so the transaction still pushes the commit it made and releases the lease.
    try {
      await c.after?.(now);
    } catch (err) {
      failed = err;
    }
    return committed;
  });
  if (failed !== undefined) {
    const why = failed instanceof Error ? failed.message : String(failed);
    throw new MwError(failed instanceof MwError ? failed.code : "card/after", `${String(value).replace(/\n/g, "; ")}. The card is already committed, but the step after the commit failed: ${why}. Fix that, then run the command again: the card file is committed already, so a repeat commits nothing and only retries that step.`);
  }
  return String(value);
}

/** A card file's text with its status set: the one status rewrite every caller uses. */
export function withCardStatus(text: string, status: CardStatus): string {
  return setFrontmatter(text, { status });
}

/** Rewrite a card file's status in place (in whichever checkout `file` belongs to). */
export function setCardStatus(file: string, status: CardStatus): void {
  writeAtomic(file, withCardStatus(readText(file), status));
}
