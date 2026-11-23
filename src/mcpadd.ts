// Adding, removing and re-targeting the project's MCP servers (`mw mcp add|remove` and the TUI's MCPs screen).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { Diagnostics } from "./diagnostics.ts";
import { parseMcp } from "./model/mcp.ts";
import type { Project } from "./project.ts";
import { MwError, requireSlug, writeAtomic } from "./util.ts";

export interface McpSpec {
  id: string;
  /** A local server: the command line (split on whitespace; the first word is the program). */
  command?: string;
  /** Extra arguments after those in `command`. */
  args?: string[];
  /** A remote server. Exactly one of `command` and `url`. */
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Role ids, or ["all"]. */
  roles?: string[];
  description?: string;
  /** Replace an existing project file. */
  force?: boolean;
}

const fileOf = (id: string) => path.join("mcps", `${id}.mcp.yaml`);

/** Parse `NAME=value` items (from --env/--header, or the TUI's form). */
export function pairs(items: string[], flag: string): Record<string, string> {
  return Object.fromEntries(items.map((kv) => {
    const i = kv.indexOf("=");
    if (i < 1) throw new MwError("usage", `--${flag} takes NAME=value`);
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
}

/** Check `text` as the project's `rel` would be, including that every role it names exists. Throws `mcp/invalid`. */
function validateMcp(project: Project, rel: string, text: string, verb: string): void {
  const diag = new Diagnostics();
  const parsed = parseMcp(rel, text, "project", diag);
  for (const r of parsed && parsed.roles !== "all" ? parsed.roles : []) {
    if (!project.roles().has(r)) diag.error("mcp/unknown-role", rel, `there is no role '${r}'`);
  }
  if (diag.errors.length) throw new MwError("mcp/invalid", `not ${verb}: ${diag.errors.map((e) => e.message).join("; ")}`);
}

/** Write `mcps/<id>.mcp.yaml` after validating it. Returns the relative path. */
export function addMcp(project: Project, spec: McpSpec): string {
  const id = requireSlug(spec.id, "mcp");
  const rel = fileOf(id);
  if (fs.existsSync(project.abs(rel)) && !spec.force) throw new MwError("mcp/exists", `${rel} already exists (use --force to replace it)`);
  if (!spec.command === !spec.url) throw new MwError("usage", "give either --command (a local server) or --url (a remote one)");
  const doc: Record<string, unknown> = { id };
  if (spec.description) doc.description = spec.description;
  if (spec.command) {
    const [cmd, ...rest] = spec.command.split(/\s+/).filter(Boolean);
    Object.assign(doc, { transport: "stdio", command: cmd });
    const args = [...rest, ...(spec.args ?? [])];
    if (args.length) doc.args = args;
  } else Object.assign(doc, { transport: "http", url: spec.url });
  if (spec.env && Object.keys(spec.env).length) doc.env = spec.env;
  if (spec.headers && Object.keys(spec.headers).length) doc.headers = spec.headers;
  const roles = spec.roles ?? [];
  doc.roles = roles.length === 1 && roles[0] === "all" ? "all" : roles;
  const text = YAML.stringify(doc, { lineWidth: 0, flowCollectionPadding: false });
  validateMcp(project, rel, text, "added");
  writeAtomic(project.abs(rel), text);
  return rel;
}

/** Delete the project's `mcps/<id>.mcp.yaml`. Returns the relative path. */
export function removeMcp(project: Project, id: string): string {
  const rel = fileOf(requireSlug(id, "mcp"));
  if (!fs.existsSync(project.abs(rel))) throw new MwError("mcp/unknown", `${rel} does not exist in the project`);
  fs.rmSync(project.abs(rel));
  return rel;
}

/** Change which roles get a project MCP server, keeping the rest of the file (comments included). */
export function setMcpRoles(project: Project, id: string, roles: string[]): string {
  const rel = fileOf(requireSlug(id, "mcp"));
  if (!fs.existsSync(project.abs(rel))) {
    throw new MwError("mcp/unknown", `${rel} does not exist in the project${project.mcps().has(id) ? ` (the server comes from the preset; eject it first with 'mw eject mcp ${id}')` : ""}`);
  }
  const doc = YAML.parseDocument(fs.readFileSync(project.abs(rel), "utf8"));
  doc.set("roles", roles.length === 1 && roles[0] === "all" ? "all" : roles);
  const text = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  validateMcp(project, rel, text, "changed");
  writeAtomic(project.abs(rel), text);
  return rel;
}
