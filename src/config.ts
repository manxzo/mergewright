// `mw config get|set|unset`: edit mergewright.yaml through its schema, keeping comments and layout.
import path from "node:path";
import YAML from "yaml";
import { check } from "./check.ts";
import { CONFIG_FILE, MOVED_TO_PACKAGES, Project } from "./project.ts";
import { validate } from "./schemas.ts";
import { MwError, readText, writeAtomic } from "./util.ts";

function load(project: Project): YAML.Document {
  return YAML.parseDocument(readText(path.join(project.root, CONFIG_FILE)));
}

export function getConfig(project: Project, key: string): unknown {
  const node = load(project).getIn(key.split("."), true) as YAML.Node | undefined;
  return node === undefined ? undefined : (node as unknown as { toJSON(): unknown }).toJSON();
}

/**
 * Checks the schema cannot express, by dotted key, for `mw config set` and the TUI's Config screen.
 * Each returns what is wrong with the value, or undefined.
 */
export const KEY_CHECKS: Record<string, (value: unknown) => string | undefined> = {};

/** Set a dotted key. The value is parsed as YAML, so `3`, `true`, `[a, b]` and `{k: v}` keep their types. */
export function setConfig(project: Project, key: string, rawValue: string | undefined): void {
  const oldText = readText(path.join(project.root, CONFIG_FILE));
  const doc = YAML.parseDocument(oldText);
  const keys = key.split(".");
  if (rawValue === undefined) {
    doc.deleteIn(keys);
    pruneEmptyParents(doc, keys);
  } else {
    let value: unknown;
    try {
      value = YAML.parse(rawValue);
    } catch {
      value = rawValue;
    }
    const why = KEY_CHECKS[key]?.(value);
    if (why) throw new MwError("config/invalid", `not changed: '${key}' ${why}`);
    doc.setIn(keys, value);
  }
  // A setting that moved to a package says how to move it, as `mw check` does, rather than "unknown field".
  const moved = rawValue === undefined ? undefined : MOVED_TO_PACKAGES.find((m) => (key === m.key || key.startsWith(`${m.key}.`)) && m.present(doc.toJS() as Record<string, unknown>));
  if (moved) throw new MwError("config/invalid", `not changed: '${moved.key}' ${moved.detail}`);
  const problems = validate("config", doc.toJS());
  if (problems.length) throw new MwError("config/invalid", `not changed, because the result would be invalid: ${problems.join("; ")}`);
  const text = keepCommentLayout(oldText, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  // Load the project as it would be with the new file, in memory, before anything is written: a change
  // that makes a role or the config invalid (say, a role override with 'runs: shell' and no command) is
  // refused, and the file on disk never holds it, not even for a moment.
  const before = new Set(roleAndConfigErrors(new Project(project.root)));
  // A package with several required settings is filled one `mw config set` at a time: the fields
  // still missing are not this change's fault (`mw check` keeps reporting them).
  const onlyMissing = /packages\.[\w-]+: (?:it is missing required field '[^']+'(?:; )?)+ \[config\/package\]$/;
  const added = roleAndConfigErrors(new Project(project.root, { configText: text })).filter((x) => !before.has(x) && !(key.startsWith("packages.") && onlyMissing.test(x)));
  if (added.length) throw new MwError("config/invalid", `not changed, because the project would then be invalid: ${added.join("; ")}. Fix the value and set it again.`);
  writeAtomic(path.join(project.root, CONFIG_FILE), text);
}

/**
 * After `unset`, remove the maps the removal left empty (`reviewer: {}`), up to and
 * including the top-level key. A comment above a removed key moves to the key that follows it.
 */
function pruneEmptyParents(doc: YAML.Document, keys: string[]): void {
  for (let i = keys.length - 1; i >= 1; i--) {
    const parentPath = keys.slice(0, i);
    const node = doc.getIn(parentPath, true);
    if (!YAML.isMap(node) || node.items.length > 0) return;
    const holder = (i === 1 ? doc.contents : doc.getIn(keys.slice(0, i - 1), true)) as unknown;
    if (YAML.isMap(holder)) {
      const at = holder.items.findIndex((p) => (YAML.isScalar(p.key) ? p.key.value : p.key) === keys[i - 1]);
      const pair = holder.items[at];
      const comment = pair && YAML.isNode(pair.key) ? pair.key.commentBefore : undefined;
      const next = holder.items[at + 1];
      if (comment && next && YAML.isNode(next.key)) next.key.commentBefore = next.key.commentBefore ? `${comment}\n${next.key.commentBefore}` : comment;
    }
    doc.deleteIn(parentPath);
  }
}

/** A line with an inline comment: its content, the whitespace run, and the comment from `#`. */
const INLINE_COMMENT = /^(.*?\S)([ \t]+)(#.*)$/;
const normalized = (line: string) => line.replace(INLINE_COMMENT, "$1 $3");

/**
 * The `yaml` package writes every inline comment one space after its content (it keeps no spacing,
 * and no option of `toString` changes that), which would reflow every aligned comment in the file.
 * Undo that: a new line equal to an old line apart from the whitespace before `#` is the old line,
 * and a changed value keeps its comment in the old column. The result must parse to the same data
 * as `text`; otherwise `text` is returned as it is.
 */
export function keepCommentLayout(oldText: string, text: string): string {
  const pool = new Map<string, string[]>();
  const oldLines = oldText.split("\n");
  for (const line of oldLines) {
    const k = normalized(line);
    if (k !== line) pool.set(k, [...(pool.get(k) ?? []), line]);
  }
  const out = text.split("\n").map((line) => {
    const m = INLINE_COMMENT.exec(line);
    if (!m) return line;
    const same = pool.get(normalized(line));
    if (same?.length) return same.shift()!;
    // The same key and comment with another value: put the comment back in its old column.
    const key = /^\s*[^\s:#][^:#]*:/.exec(m[1]!)?.[0];
    const old = key ? oldLines.find((l) => l.startsWith(key) && INLINE_COMMENT.exec(l)?.[3] === m[3]) : undefined;
    const col = old ? old.length - m[3]!.length : 0;
    return col > m[1]!.length + 1 ? `${m[1]!.padEnd(col)}${m[3]}` : line;
  }).join("\n");
  try {
    return JSON.stringify(YAML.parse(out)) === JSON.stringify(YAML.parse(text)) ? out : text;
  } catch {
    return text;
  }
}

/** The `role/*` and `config/*` errors `mw check` reports for `project`, one line each. */
function roleAndConfigErrors(project: Project): string[] {
  return check(project).errors.filter((d) => /^(role|config)\//.test(d.code)).map((d) => `${d.file}: ${d.message} [${d.code}]`);
}
