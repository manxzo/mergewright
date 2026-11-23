// mcps/*.mcp.yaml: an MCP server that roles can be given.
import YAML from "yaml";
import { Diagnostics } from "../diagnostics.ts";
import { validate } from "../schemas.ts";
import { SLUG } from "../util.ts";

export interface Mcp {
  id: string;
  description: string;
  transport: "stdio" | "http";
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  /** Roles that get this server without naming it: "all" or a list of role ids. */
  roles: "all" | string[];
  enabled: boolean;
  file: string;
  origin: string;
}

/** Names that carry credentials. Deliberately broad: a false positive only asks for an environment reference. */
export const SECRET_NAME = /(key|token|secret|password|passwd|auth|credential|cookie|session|bearer|signature)/i;
const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$|^Bearer \$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export function parseMcp(file: string, text: string, origin: string, diag: Diagnostics): Mcp | undefined {
  let data: unknown;
  try {
    data = YAML.parse(text);
  } catch (e) {
    diag.error("mcp/yaml", file, `not valid YAML: ${(e as Error).message.split("\n")[0]}`, 1);
    return undefined;
  }
  for (const m of validate("mcp", data)) diag.error("mcp/schema", file, m, 1);
  if (data === null || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  const id = typeof d.id === "string" ? d.id : "";
  if (!SLUG.test(id)) return undefined;
  const base = file.split("/").pop()!;
  if (base !== `${id}.mcp.yaml`) diag.error("mcp/file-name", file, `mcp ${id} must be in a file named ${id}.mcp.yaml`, 1);
  if (d.transport === "stdio" && typeof d.command !== "string") diag.error("mcp/command", file, "an mcp with 'transport: stdio' needs a 'command'", 1);
  if (d.transport === "http" && typeof d.url !== "string") diag.error("mcp/url", file, "an mcp with 'transport: http' needs a 'url'", 1);
  const env = (d.env ?? {}) as Record<string, string>;
  const headers = (d.headers ?? {}) as Record<string, string>;
  for (const [kind, map] of [["env", env], ["headers", headers]] as const) {
    for (const [k, v] of Object.entries(map)) {
      const literalBearer = typeof v === "string" && /^(bearer|basic|token)\s+\S/i.test(v) && !ENV_REF.test(v);
      if ((SECRET_NAME.test(k) || literalBearer) && typeof v === "string" && !ENV_REF.test(v)) {
        diag.error("mcp/literal-secret", file, `${kind}.${k} looks like a secret written into the file; reference an environment variable instead, e.g. "\${${k.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}}"`, 1);
      }
    }
  }
  return {
    id,
    description: String(d.description ?? ""),
    transport: d.transport as Mcp["transport"],
    command: d.command as string | undefined,
    args: Array.isArray(d.args) ? (d.args as string[]) : [],
    url: d.url as string | undefined,
    env,
    headers,
    roles: d.roles === "all" ? "all" : Array.isArray(d.roles) ? (d.roles as string[]) : [],
    enabled: d.enabled !== false,
    file,
    origin,
  };
}

/** Replace ${VAR} references with values from the environment. Returns the names that were not set. */
export function resolveEnvRefs(map: Record<string, string>, env: NodeJS.ProcessEnv): { values: Record<string, string>; missing: string[] } {
  const missing: string[] = [];
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    values[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const val = env[name];
      if (val === undefined) missing.push(name);
      return val ?? "";
    });
  }
  return { values, missing };
}
