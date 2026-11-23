// Turning the project's mcps/*.mcp.yaml into what each harness understands.
import { resolveEnvRefs, type Mcp } from "./model/mcp.ts";
import type { Role } from "./model/role.ts";
import type { Project } from "./project.ts";
import { MwError } from "./util.ts";

/** The servers a role gets: those that offer themselves to it, plus those it names. */
export function mcpsForRole(project: Project, role: Role): Mcp[] {
  return [...project.mcps().values()].filter(
    (m) => m.enabled && (m.roles === "all" || m.roles.includes(role.id) || role.mcps.includes(m.id)),
  );
}

export interface McpWiring {
  /** The `mcpServers` document most MCP clients read (Claude Code's --mcp-config format). */
  json: { mcpServers: Record<string, unknown> };
  /**
   * `-c key=value` overrides for the Codex CLI. They never hold an `env` or header value, literal or from
   * the environment (REQ-engine-006): those are named here (`env_vars`, `env_http_headers`) and set in `codexEnv`.
   */
  codexArgs: string[];
  /** The variables the Codex process gets for `codexArgs` to name: resolved values, never on its command line. */
  codexEnv: Record<string, string>;
  /** Environment variables the servers need; pass them through to the harness. */
  env: Record<string, string>;
  ids: string[];
}

const toml = (v: string) => JSON.stringify(v); // a JSON string is a valid TOML basic string
const envName = (...parts: string[]) => parts.join("_").toUpperCase().replace(/[^A-Z0-9_]/g, "_");

/** Resolve environment references and build the per-harness configuration. Throws when a referenced variable is not set. */
export function wireMcps(servers: Mcp[], env: NodeJS.ProcessEnv = process.env): McpWiring {
  const json: McpWiring["json"] = { mcpServers: {} };
  const codexArgs: string[] = [];
  const codexEnv: Record<string, string> = {};
  const passEnv: Record<string, string> = {};
  // Codex reads a variable by its name from its own environment, so two servers cannot give one name two values.
  const setCodexEnv = (id: string, name: string, value: string) => {
    if (name in codexEnv && codexEnv[name] !== value) {
      throw new MwError("mcp/env", `mcp '${id}' sets ${name}, which another server of the role sets to a different value; Codex passes such variables by name, so give one of them another name`);
    }
    codexEnv[name] = value;
  };
  for (const m of servers) {
    const e = resolveEnvRefs(m.env, env);
    const h = resolveEnvRefs(m.headers, env);
    const missing = [...new Set([...e.missing, ...h.missing])];
    if (missing.length) throw new MwError("mcp/env", `mcp '${m.id}' needs ${missing.map((n) => `$${n}`).join(", ")} set in the environment`);
    if (m.transport === "stdio") {
      json.mcpServers[m.id] = { command: m.command, args: m.args, env: e.values };
      codexArgs.push("-c", `mcp_servers.${m.id}.command=${toml(m.command ?? "")}`);
      if (m.args.length) codexArgs.push("-c", `mcp_servers.${m.id}.args=[${m.args.map(toml).join(", ")}]`);
      // Every value goes through the environment, literal or not: argv is visible in the process list.
      const vars = Object.entries(e.values);
      for (const [k, v] of vars) setCodexEnv(m.id, k, v);
      if (vars.length) codexArgs.push("-c", `mcp_servers.${m.id}.env_vars=[${vars.map(([k]) => toml(k)).join(", ")}]`);
    } else {
      json.mcpServers[m.id] = { type: "http", url: m.url, headers: h.values };
      codexArgs.push("-c", `mcp_servers.${m.id}.url=${toml(m.url ?? "")}`);
      const named = Object.entries(h.values).map(([k, v]) => {
        const name = envName("MW_MCP", m.id, k);
        setCodexEnv(m.id, name, v);
        return `${toml(k)} = ${toml(name)}`;
      });
      if (named.length) codexArgs.push("-c", `mcp_servers.${m.id}.env_http_headers={${named.join(", ")}}`);
    }
    // Variables referenced by name are also passed through, for servers that read them directly.
    for (const src of [...Object.values(m.env), ...Object.values(m.headers)]) {
      for (const ref of src.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const v = env[ref[1]!];
        if (v !== undefined) passEnv[ref[1]!] = v;
      }
    }
  }
  return { json, codexArgs, codexEnv, env: passEnv, ids: servers.map((m) => m.id) };
}
