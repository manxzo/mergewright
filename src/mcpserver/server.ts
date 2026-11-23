// The MergeWright MCP server (`mw mcp serve`): the tool groups of docs/design/tooling.md section 3
// over the protocol in protocol.ts. A tool that fails answers with an `isError` result carrying its
// message; nothing a tool does stops the server.
import fs from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../paths.ts";
import { activeExports } from "../packages/loader.ts";
import { packageSecretNames } from "../packages/registry.ts";
import { Project } from "../project.ts";
import { validateWith } from "../schemas.ts";
import { MwError, readJson, redactSecrets } from "../util.ts";
import { repoLock } from "./mutex.ts";
import { settleDeliveries } from "../integrations.ts";
import { repoTransaction } from "./repo.ts";
import { INVALID_PARAMS, INVALID_REQUEST, PROTOCOL_VERSION, RpcError, serveRpc, STRUCTURED_VERSIONS, SUPPORTED_VERSIONS, type Io, type Method } from "./protocol.ts";
import { RESULTS_VERSION, type ResultName } from "./results.ts";
import { ownerOnlyMessage, WithData, type ToolContext, type ToolDef } from "./tool.ts";
import { tools as cards } from "./tools/cards.ts";
import { tools as delegate } from "./tools/delegate.ts";
import { tools as docs } from "./tools/docs.ts";
import { tools as memory } from "./tools/memory.ts";
import { tools as projectTools } from "./tools/project.ts";
import { tools as runs } from "./tools/runs.ts";
import { tools as views } from "./tools/views.ts";

export const TOOLS: ToolDef[] = [...delegate, ...cards, ...runs, ...docs, ...memory, ...projectTools, ...views];

/** A tool result as MCP sends it: the text, and (to a client that asked for it, section 12.1) the data. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: object;
}

/**
 * A tool's answer for a caller in this process (the GUI's server): the text MCP clients get, the
 * structured data of the shape the tool declares (results.ts; absent when it declares none, and on
 * most errors), and whether it failed. Both are scrubbed of credentials.
 */
export interface StructuredResult {
  text: string;
  data?: object;
  isError: boolean;
}

/** A tool as `listTools` describes it. */
export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema (type object) of its arguments. */
  inputSchema: object;
  /** Changes the repository or a service: refused inside a card run (MW_ROLE set). */
  write: boolean;
  /** The name of its data type in results.ts; null when it returns text only. */
  result: ResultName | null;
  /** The enabled package that provides it; null for a core tool. */
  package: string | null;
}

function version(): string {
  return readJson<{ version?: string }>(path.join(PACKAGE_ROOT, "package.json"))?.version ?? "0.0.0";
}

/** Values of the environment variables that hold this project's service credentials (the enabled packages' declared secrets too). */
function secretValues(project: Project): string[] {
  const c = project.config;
  const names = [c.localModels?.keyEnv, c.git.forge.tokenEnv, "GITHUB_TOKEN", "GITEA_TOKEN", ...packageSecretNames(project.packages)];
  return names.map((n) => (n ? process.env[n] : undefined)).filter((v): v is string => !!v && v.length >= 6);
}

/** Tool output never carries a credential: known key values and anything shaped like one are blanked. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return redactSecrets(out);
}

/** The same scrubbing over every string (and key) of a JSON value. */
function scrubData(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return scrub(value, secrets);
  if (Array.isArray(value)) return value.map((v) => scrubData(v, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k, secrets), scrubData(v, secrets)]));
  return value;
}

const asText = (value: unknown): string => (typeof value === "string" ? value : value === undefined ? "ok" : JSON.stringify(value, null, 2));

/** Run one tool call: validate, check authority, call, and turn any error into an `isError` result. */
export async function runTool(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext): Promise<StructuredResult> {
  let secrets: string[] = [];
  try {
    secrets = secretValues(ctx.project());
  } catch {
    // a project that does not load still gets the generic scrubbing
  }
  const error = (text: string, data?: object): StructuredResult => ({ text: scrub(text, secrets), ...(data ? { data: scrubData(data, secrets) as object } : {}), isError: true });
  const problems = validateWith(tool.inputSchema, args);
  if (problems.length) return error(`invalid arguments for ${tool.name}: ${problems.join("; ")}`);
  if (tool.write && process.env.MW_ROLE) return error(ownerOnlyMessage(`'${tool.name}'`));
  try {
    // Repository-mutating tools run one at a time, each under the cross-process
    // repository lock and, on a hub-backed project, the lease and the hub protocol.
    // A precheck (the readiness lint of REQ-cards-003) refuses before the lock, the lease or a sync.
    // REQ-config-001: a writing tool (or one that writes files or runs an agent) refuses first, on a
    // config that fell back to its defaults. A locked tool's transaction checks again once it holds
    // the lock and has adopted the hub (repoTransaction), right before the handler.
    if (tool.write || tool.needsConfig) ctx.project().assertRunnable();
    if (tool.precheck) await tool.precheck(args, ctx);
    // REQ-engine-008: deliveries a locked tool records start once the lock and the lease are released.
    const value = tool.locked ? await repoLock.run(() => repoTransaction(ctx.project(), (tx) => tool.handler(args, { ...ctx, deliverAfterRelease: tx.deliverAfterRelease }))) : await tool.handler(args, ctx);
    if (value instanceof WithData) return { text: scrub(asText(value.text), secrets), data: scrubData(value.data, secrets) as object, isError: false };
    return { text: scrub(asText(value), secrets), isError: false };
  } catch (e) {
    if (e instanceof MwError) return error(e.message, e.data);
    // An unexpected error: its message and stack can carry paths and internals, so the client gets
    // a generic line and the server's log (standard error) gets the whole stack.
    ctx.log(`mw mcp serve: ${tool.name} failed: ${(e as Error)?.stack ?? String(e)}`);
    return error(`${tool.name} failed with an internal error; the MergeWright server's log (standard error) has the details`);
  }
}

/** Run one tool call and answer as MCP does (`structured`: add the data as `structuredContent`). */
export async function callTool(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext, structured = false): Promise<ToolResult> {
  const r = await runTool(tool, args, ctx);
  return {
    content: [{ type: "text", text: r.text }],
    ...(r.isError ? { isError: true } : {}),
    ...(structured && r.data ? { structuredContent: { resultsVersion: RESULTS_VERSION, ...r.data } } : {}),
  };
}

/** The core's tools and the enabled packages', as the server offers them (a package tool never takes a core name). */
export async function allTools(project: Project): Promise<ToolDef[]> {
  return [...TOOLS, ...(await packageTools(project))];
}

/** Every tool for `project` with its input schema, whether it writes and its data type: for the GUI's server. */
export async function listTools(project: Project): Promise<ToolInfo[]> {
  return (await allTools(project)).map((t) => ({
    name: t.name, description: t.description, inputSchema: t.inputSchema, write: t.write === true,
    result: t.result ?? null, package: t.package ?? null,
  }));
}

/**
 * Call one tool by name for a caller in this process (the GUI's server): what an MCP client would get,
 * as text and data. Safe to call concurrently. An unknown name is an `isError` result, not a throw.
 */
export async function callToolStructured(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<StructuredResult> {
  const tool = (await allTools(ctx.project())).find((t) => t.name === name);
  if (!tool) return { text: `unknown tool: ${name}`, isError: true };
  return runTool(tool, args, ctx);
}

/**
 * The MCP tools the enabled packages provide, as tool definitions. A tool whose name the core already
 * uses is left out; an error a package tool throws reaches the client as its message.
 */
export async function packageTools(project: Project, taken: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name))): Promise<ToolDef[]> {
  const out: ToolDef[] = [];
  for (const { name, exports: ex } of await activeExports(project)) {
    for (const t of ex.tools ?? []) {
      if (taken.has(t.name) || out.some((o) => o.name === t.name)) { process.stderr.write(`mw: package '${name}': tool '${t.name}' left out (the name is taken)\n`); continue; }
      out.push({
        name: t.name,
        description: `${t.description} (package ${name})`,
        inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object" },
        write: t.write === true,
        package: name,
        handler: async (args, ctx) => {
          try {
            return await t.handler(args, { signal: ctx.signal });
          } catch (e) {
            throw e instanceof MwError ? e : new MwError(`${name}/failed`, (e as Error)?.message ?? String(e));
          }
        },
      });
    }
  }
  return out;
}

/** Serve the tools for `project` (the core's and the enabled packages') until the client closes the input stream. */
export async function serve(project: Project, io: Io, given?: ToolDef[]): Promise<void> {
  const tools = given ?? [...TOOLS, ...(await packageTools(project))];
  const log = io.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const root = project.root;
  if (!fs.existsSync(root)) throw new MwError("mcp/no-project", `${root} does not exist`);
  log(`mw mcp serve: ${tools.length} tools for project '${project.config.name}' in ${root}`);
  // The MCP lifecycle: `initialize` comes first and once. Before it only `ping` is answered; every
  // other request is refused without running (notifications are never answered anyway).
  let initialized = false;
  // Section 12.1: structured results go to a client that asked for them, on a protocol version that has them.
  let structured = false;
  const afterInit = (m: Method): Method => (params, call) => {
    if (!initialized) throw new RpcError(INVALID_REQUEST, "the server is not initialized: send 'initialize' first");
    return m(params, call);
  };
  await serveRpc({ ...io, log }, {
    initialize: (params) => {
      if (initialized) throw new RpcError(INVALID_REQUEST, "the server is already initialized; 'initialize' is sent once per connection");
      initialized = true;
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
      const protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION;
      const caps = params.capabilities as { experimental?: { structuredContent?: unknown } } | undefined;
      structured = STRUCTURED_VERSIONS.includes(protocolVersion) && caps?.experimental?.structuredContent === true;
      return {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "mergewright", title: "MergeWright", version: version() },
        instructions: `MergeWright project '${project.config.name}' (${root}). Changes go through cards (mw_card_new, mw_run_start); never commit, merge or push by hand. Delegated sub-agents (mw_delegate, mw_review) only advise or read.`,
      };
    },
    ping: () => ({}),
    "tools/list": afterInit(() => ({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })),
    "tools/call": afterInit(async (params, call) => {
      const name = params.name;
      const tool = typeof name === "string" ? byName.get(name) : undefined;
      if (!tool) throw new RpcError(INVALID_PARAMS, `unknown tool: ${String(name)}`);
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const ctx: ToolContext = { root, project: () => new Project(root), signal: call.signal, log };
      return callTool(tool, args, ctx, structured);
    }),
  });
  // Deliveries the tools started after their transactions (bounded by the flush budget) end before the
  // server does, so an item is not left claimed; one that fails stays queued.
  await settleDeliveries();
}
