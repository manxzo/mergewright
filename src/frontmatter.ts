// Markdown files with a YAML front matter block.
import YAML from "yaml";

export interface Parsed {
  /** Front matter as a plain object ({} when absent or not a mapping). */
  data: Record<string, unknown>;
  body: string;
  /** 1-based line number of the body's first line in the file. */
  bodyLine: number;
  /** Set when the front matter block is missing or is not valid YAML. */
  error?: string;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(text: string): Parsed {
  const m = FENCE.exec(text);
  if (!m) return { data: {}, body: text, bodyLine: 1, error: "missing front matter block (the file must start with '---')" };
  const body = text.slice(m[0].length);
  const bodyLine = m[0].split("\n").length;
  try {
    const data = YAML.parse(m[1] ?? "") as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { data: {}, body, bodyLine, error: "front matter must be a mapping of fields" };
    }
    return { data: data as Record<string, unknown>, body, bodyLine };
  } catch (e) {
    return { data: {}, body, bodyLine, error: `front matter is not valid YAML: ${(e as Error).message.split("\n")[0]}` };
  }
}

/**
 * Set fields in a file's front matter, keeping the rest of the block (order, comments) and the body
 * untouched. A value of `undefined` removes the field.
 */
export function setFrontmatter(text: string, changes: Record<string, unknown>): string {
  const m = FENCE.exec(text);
  if (!m) throw new Error("file has no front matter block");
  const doc = YAML.parseDocument(m[1] ?? "");
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) doc.delete(k);
    else doc.set(k, v);
  }
  const block = doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd();
  return `---\n${block}\n---\n${text.slice(m[0].length)}`;
}

/** Render a new file from front matter fields and a body. */
export function renderFrontmatter(data: Record<string, unknown>, body: string): string {
  const block = YAML.stringify(data, { lineWidth: 0, flowCollectionPadding: false }).trimEnd();
  return `---\n${block}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}
