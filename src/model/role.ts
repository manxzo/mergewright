// roles/*.role.md: who does a phase, on what, with which permissions. The body is the prompt.
import { Diagnostics } from "../diagnostics.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { validate } from "../schemas.ts";
import { MOVED_TO_OFFICIAL } from "../packages/registry.ts";
import { SLUG } from "../util.ts";

export const BUILTIN_HARNESSES = ["claude", "codex", "local", "shell", "mock"] as const;
export type BuiltinHarness = (typeof BUILTIN_HARNESSES)[number];
/** A built-in harness, or the id of one an installed package contributes. */
export type Harness = BuiltinHarness | (string & {});
export type Mode = "advise" | "read" | "write";
export type OutputKind = "brief" | "handoff" | "findings" | "adjudication" | "reflection" | "text";

export interface Role {
  id: string;
  description: string;
  runs: Harness;
  model?: string;
  /**
   * REQ-harness-003: the alternate model, on the same harness, that gets one attempt once transient
   * retries on `model` are spent (`fallback_model` in the front matter or in `roles.<id>` of the config).
   */
  fallbackModel?: string;
  provider?: string;
  profile?: string;
  command?: string;
  mode: Mode;
  output: OutputKind;
  limits: { turns?: number; minutes?: number };
  mcps: string[];
  /** Extra arguments for the harness command. */
  args: string[];
  prompt: string;
  file: string;
  /** "project" when defined in the project's roles/, otherwise the preset name. */
  origin: string;
}

/** Everything a role prompt may interpolate with {{name}}. */
export const PROMPT_VARIABLES = [
  "project.name", "project.description",
  "card", "card.id", "card.title", "card.kind", "card.risk", "card.scope",
  "requirements", "brief", "handoff", "findings", "gate", "adjudication", "diff",
  "memory.state", "memory.rules", "memory.index", "memory.recall",
  "round", "remediation", "protected", "branch", "base", "docs", "changed",
] as const;

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
/** Harnesses that can change files. The others only return text. */
const CAN_WRITE: readonly string[] = ["claude", "codex", "shell", "mock"];

/** `packageHarnesses`: harness ids installed packages contribute (`Project.packageHarnesses`). */
export function parseRole(file: string, text: string, origin: string, diag: Diagnostics, packageHarnesses: ReadonlyMap<string, string> = new Map()): Role | undefined {
  const fm = parseFrontmatter(text);
  if (fm.error) {
    diag.error("role/front-matter", file, fm.error, 1);
    return undefined;
  }
  for (const m of validate("role", fm.data)) diag.error("role/schema", file, m, 1);
  const d = fm.data;
  const id = typeof d.id === "string" ? d.id : "";
  if (!SLUG.test(id)) return undefined;
  const base = file.split("/").pop()!;
  if (base !== `${id}.role.md`) diag.error("role/file-name", file, `role ${id} must be in a file named ${id}.role.md`, 1);
  const runs = d.runs as Harness;
  const mode = d.mode as Mode;
  const prompt = fm.body.trim();
  if (!prompt) diag.error("role/prompt", file, "the role has no prompt (the text after the front matter)", fm.bodyLine);
  const known = new Set<string>(PROMPT_VARIABLES);
  fm.body.split(/\r?\n/).forEach((line, idx) => {
    for (const m of line.matchAll(PLACEHOLDER)) {
      if (!known.has(m[1]!)) diag.error("role/placeholder", file, `unknown placeholder {{${m[1]}}} (see the specification for the list)`, fm.bodyLine + idx);
    }
  });
  const limits = (d.limits && typeof d.limits === "object" ? d.limits : {}) as Role["limits"];
  const role: Role = {
    id,
    description: String(d.description ?? ""),
    runs,
    model: typeof d.model === "string" ? d.model : undefined,
    fallbackModel: typeof d.fallback_model === "string" ? d.fallback_model : undefined,
    provider: typeof d.provider === "string" ? d.provider : undefined,
    profile: typeof d.profile === "string" ? d.profile : undefined,
    command: typeof d.command === "string" ? d.command : undefined,
    mode,
    output: d.output as OutputKind,
    limits,
    mcps: Array.isArray(d.mcps) ? (d.mcps as string[]) : [],
    args: Array.isArray(d.args) ? (d.args as string[]) : [],
    prompt,
    file,
    origin,
  };
  checkRole(role, file, diag, packageHarnesses);
  return role;
}

/**
 * Rules that depend on which harness runs the role. Called for the role file and again after
 * `roles.<id>` overrides from the config are applied, so an override cannot create an invalid role.
 */
export function checkRole(role: Role, file: string, diag: Diagnostics, packageHarnesses: ReadonlyMap<string, string> = new Map()): void {
  // The schemas allow any id; which ones exist depends on the installed packages.
  const moved = typeof role.runs === "string" && !packageHarnesses.has(role.runs) && Object.hasOwn(MOVED_TO_OFFICIAL, role.runs) ? MOVED_TO_OFFICIAL[role.runs] : undefined;
  if (moved) {
    diag.error("role/schema", file, `'runs: ${role.runs}' is a harness of the official package '${moved}' now, which is not installed and enabled here; run 'mw add ${moved}' to use it`, 1);
  } else if (typeof role.runs === "string" && !(BUILTIN_HARNESSES as readonly string[]).includes(role.runs) && !packageHarnesses.has(role.runs)) {
    diag.error("role/schema", file, `'runs' must be one of: ${[...BUILTIN_HARNESSES, ...packageHarnesses.keys()].join(", ")} (a package's harness counts once the package is installed and enabled)`, 1);
  }
  if (role.mode === "write" && role.runs && !CAN_WRITE.includes(role.runs)) {
    diag.error("role/mode", file, `role '${role.id}' runs on '${role.runs}', which cannot have mode 'write' (only ${CAN_WRITE.join(", ")} can change files)`, 1);
  }
  if (role.runs === "shell" && !role.command) diag.error("role/command", file, `role '${role.id}' has 'runs: shell' and needs a 'command'`, 1);
  if (role.runs === "local" && !role.profile && !role.model) diag.error("role/profile", file, `role '${role.id}' has 'runs: local' and needs a 'profile' or a 'model'`, 1);
}

/** Fill {{placeholders}}. Unknown or absent values render as an empty string. */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, name: string) => values[name] ?? "");
}
