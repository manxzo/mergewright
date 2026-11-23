// What the TUI's screens show, read from a project. The reducer only ever sees this plain data, so
// tests can hand it a fake. Secret values never enter it: MCP env/headers and key_env appear as names.
// The board and the packages are not here: they come from the tool layer (mw_status, mw_packages).
import { getConfig } from "../config.ts";
import { redactUrl } from "../integrations/common.ts";
import { SPEC_VERSION } from "../paths.ts";
import type { Project } from "../project.ts";
import { loadSchema } from "../schemas.ts";

export const ROLE_FIELDS = ["runs", "provider", "model", "profile"] as const;
export type RoleField = (typeof ROLE_FIELDS)[number];

export interface RoleRow {
  id: string;
  origin: string;
  runs: string;
  provider?: string;
  model?: string;
  profile?: string;
  mode: string;
  output: string;
  description: string;
  /** Fields set under `roles.<id>` in mergewright.yaml. */
  overrides: string[];
}

export interface ConfigRow {
  key: string;
  /** The value written in mergewright.yaml, as YAML flow text; undefined when the default applies. */
  value?: string;
  /** The value in effect (the file's or the default). */
  effective: string;
  description: string;
  /** Type and limits from the schema, e.g. "integer, minimum 0". */
  type: string;
  options: string[];
}

export interface Field {
  key: string;
  label: string;
  value?: string;
  options: string[];
}

export interface McpRow {
  id: string;
  origin: string;
  transport: string;
  /** Command and arguments, or the URL without query string or credentials. */
  target: string;
  roles: string;
  envNames: string[];
  headerNames: string[];
  enabled: boolean;
  description: string;
}

export interface Data {
  name: string;
  spec: string;
  root: string;
  roles: RoleRow[];
  config: ConfigRow[];
  mcps: McpRow[];
  cards: [string, number][];
  /** `local_models.endpoint` and the name of its key variable. */
  localEndpoint?: string;
  localKeyEnv?: string;
  /** Problems found while loading (config and files), one line each. */
  problems: string[];
}

const STATUSES = ["todo", "ready", "in_progress", "review", "blocked", "done"];
const CONFIG_SECTIONS = ["cards", "git", "risk", "limits", "trace", "local_models", "report"];

type SchemaNode = { type?: string; enum?: unknown[]; description?: string; minimum?: number; pattern?: string; properties?: Record<string, SchemaNode>; items?: SchemaNode };

/** Leaf keys of the config schema under the sections the Config screen shows. */
export function configKeys(): { key: string; node: SchemaNode }[] {
  const schema = loadSchema("config") as SchemaNode;
  const out: { key: string; node: SchemaNode }[] = [];
  const walk = (prefix: string, node: SchemaNode) => {
    if (node.properties) for (const [k, v] of Object.entries(node.properties)) walk(`${prefix}.${k}`, v);
    else out.push({ key: prefix, node });
  };
  for (const s of CONFIG_SECTIONS) {
    const n = schema.properties?.[s];
    if (n) walk(s, n);
  }
  return out;
}

/** A value as one line of YAML flow text. */
export function flow(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return `[${v.map(flow).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${k}: ${flow(x)}`).join(", ")}}`;
  return String(v);
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function effectiveValue(project: Project, key: string): unknown {
  let v: unknown = project.config;
  for (const part of key.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[camel(part)] : undefined;
  return v;
}

function typeOf(node: SchemaNode): string {
  const parts = [node.enum ? `one of ${node.enum.join(", ")}` : node.type === "array" ? `list of ${node.items?.type ?? "values"}` : node.type ?? "value"];
  if (node.minimum !== undefined) parts.push(`minimum ${node.minimum}`);
  if (node.pattern) parts.push(`pattern ${node.pattern}`);
  return parts.join(", ");
}

/** Read everything the screens show. Throws only when the project cannot be read at all. */
export function loadData(project: Project): Data {
  const roles: RoleRow[] = [...project.roles().values()].map((r) => ({
    id: r.id, origin: r.origin, runs: r.runs, provider: r.provider, model: r.model, profile: r.profile, mode: r.mode, output: r.output,
    description: r.description, overrides: Object.keys(project.config.roles[r.id] ?? {}),
  }));
  const config: ConfigRow[] = configKeys().map(({ key, node }) => {
    const v = getConfig(project, key);
    return {
      key, value: v === undefined ? undefined : flow(v), effective: flow(v ?? effectiveValue(project, key)),
      description: node.description ?? "", type: typeOf(node),
      options: node.enum ? node.enum.map(String) : node.type === "boolean" ? ["true", "false"] : [],
    };
  });
  const mcps: McpRow[] = [...project.mcps().values()].map((m) => ({
    id: m.id, origin: m.origin, transport: m.transport,
    target: m.transport === "stdio" ? [m.command ?? "", ...m.args].join(" ") : redactUrl(m.url ?? ""),
    roles: m.roles === "all" ? "all" : m.roles.join(", ") || "(only roles that name it)",
    envNames: Object.keys(m.env), headerNames: Object.keys(m.headers), enabled: m.enabled, description: m.description,
  }));
  const counts = new Map<string, number>(STATUSES.map((s) => [s, 0]));
  for (const c of project.cards()) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  return {
    name: project.config.name, spec: project.config.version || SPEC_VERSION, root: project.root,
    roles, config, mcps, cards: [...counts],
    localEndpoint: project.config.localModels?.endpoint, localKeyEnv: project.config.localModels?.keyEnv,
    problems: project.diag.errors.map((d) => `${d.file}: ${d.message}`),
  };
}
