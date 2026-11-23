// cards/*.card.md: one unit of work.
import { Diagnostics } from "../diagnostics.ts";
import type { Risk } from "../expr.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { validate } from "../schemas.ts";
import { CARD_ID } from "../util.ts";

export type CardStatus = "todo" | "ready" | "in_progress" | "review" | "blocked" | "done";
export type CardKind = "feature" | "fix" | "chore" | "docs" | "spike";

export interface Card {
  id: string;
  title: string;
  kind: CardKind;
  status: CardStatus;
  implements: string[];
  revs: Record<string, number>;
  flow?: string;
  risk?: Risk;
  deepReview: boolean;
  scope: string[];
  depends: string[];
  docs: string[];
  /** Protected paths the owner lets this card write. */
  allowProtected: string[];
  tags: string[];
  file: string;
  /** The markdown body after the front matter. */
  body: string;
  sections: Record<string, string>;
}

/** Split a markdown body into its `## Heading` sections (heading text lower-cased). */
export function sections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let name: string | undefined;
  let buf: string[] = [];
  let inFence = false;
  const flush = () => { if (name !== undefined) out[name] = buf.join("\n").trim(); };
  for (const line of body.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence;
    const m = !inFence && /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (m) { flush(); name = m[1]!.toLowerCase(); buf = []; } else buf.push(line);
  }
  flush();
  return out;
}

export function parseCard(file: string, text: string, diag: Diagnostics): Card | undefined {
  const fm = parseFrontmatter(text);
  if (fm.error) {
    diag.error("card/front-matter", file, fm.error, 1);
    return undefined;
  }
  const problems = validate("card", fm.data);
  for (const m of problems) diag.error("card/schema", file, m, 1);
  const d = fm.data;
  const id = typeof d.id === "string" ? d.id : "";
  if (!CARD_ID.test(id)) return undefined; // the schema error is already reported; an id is used in paths, so nothing else is trusted
  const base = file.split("/").pop()!;
  if (base !== `${id}.card.md`) diag.error("card/file-name", file, `card ${id} must be in a file named ${id}.card.md`, 1);
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const secs = sections(fm.body);
  if (!secs["why"]) diag.error("card/why", file, "a card needs a non-empty '## Why' section", fm.bodyLine);
  return {
    id,
    title: String(d.title ?? ""),
    kind: (d.kind as CardKind | undefined) ?? "feature",
    status: (d.status as CardStatus | undefined) ?? "todo",
    implements: arr(d.implements),
    revs: (d.revs && typeof d.revs === "object" ? d.revs : {}) as Record<string, number>,
    flow: typeof d.flow === "string" ? d.flow : undefined,
    risk: d.risk as Risk | undefined,
    deepReview: d.deep_review === true,
    scope: arr(d.scope),
    depends: arr(d.depends),
    docs: arr(d.docs),
    allowProtected: arr(d.allow_protected),
    tags: arr(d.tags),
    file,
    body: fm.body,
    sections: secs,
  };
}
