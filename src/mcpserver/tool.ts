// What a tool of the MergeWright MCP server is, and small helpers the tool groups share.
import { handlers, parseArgs } from "../cli.ts";
import { Project } from "../project.ts";
import { MwError } from "../util.ts";
import { Mutex } from "./mutex.ts";
import type { ResultName } from "./results.ts";

export { WithData, withData } from "./answer.ts";

export interface ToolContext {
  /** The project root the server was started for. */
  root: string;
  /** The project as it is on disk now (loaded afresh for each call: files change between calls). */
  project(): Project;
  /** Fires when the client cancels the call. */
  signal: AbortSignal;
  log(line: string): void;
  /**
   * A locked tool's transaction (repoTransaction): deliver these queue items once the repository lock
   * and the lease are released. Absent outside a transaction: the items then wait for the next flush.
   */
  deliverAfterRelease?(files: string[]): void;
}

export type Args = Record<string, unknown>;

export interface ToolDef {
  /** Stable: the names are the contract with MCP clients (docs/design/tooling.md section 3). */
  name: string;
  description: string;
  /** JSON Schema of the arguments (type object). Arguments are validated against it before the call. */
  inputSchema: object;
  /** Changes the repository or a service: refused when the server runs inside a card run (MW_ROLE set). */
  write?: boolean;
  /**
   * Writes files or runs an agent, yet stays allowed inside a card run (unlike `write`): like a
   * writing tool it is refused (`config/invalid`) on a config that fails its schema (REQ-config-001).
   */
  needsConfig?: boolean;
  /** Changes files in the repository: the handler runs under the server's repository lock (mutex.ts). */
  locked?: boolean;
  /**
   * Read-only checks a locked tool makes before the repository lock and transaction are taken (on a
   * hub-backed project the transaction takes the lease and adopts the hub): a refusal here writes
   * nothing and touches neither. The handler repeats them on the state it then sees.
   */
  precheck?(args: Args, ctx: ToolContext): void | Promise<void>;
  /**
   * The name of the type in results.ts its `data` has, when it returns data (`withData`). A tool
   * that names one returns data on every successful call.
   */
  result?: ResultName;
  /** The enabled package that provides it (set for package tools only). */
  package?: string;
  /**
   * Returns text, or a value sent as JSON text, or `withData(text, data)` for both. Throws MwError for
   * an error the caller should see (its `data`, when set, is the error's data).
   */
  handler(args: Args, ctx: ToolContext): unknown | Promise<unknown>;
}

/** An object schema; every property listed in `required` must be given. No other properties are allowed. */
export function schema(properties: Record<string, object>, required: string[] = []): object {
  return { type: "object", properties, required, additionalProperties: false };
}

export const S = {
  str: (description: string): object => ({ type: "string", description }),
  int: (description: string, minimum = 1): object => ({ type: "integer", minimum, description }),
  bool: (description: string): object => ({ type: "boolean", description }),
  list: (description: string): object => ({ type: "array", items: { type: "string" }, description }),
  oneOf: (values: string[], description: string): object => ({ type: "string", enum: values, description }),
  map: (description: string): object => ({ type: "object", additionalProperties: { type: "string" }, description }),
  /** A string that must match `pattern` (validated before the handler runs). */
  matching: (pattern: RegExp, description: string): object => ({ type: "string", pattern: pattern.source, description }),
  /** A list of strings that each match `pattern`. */
  listOf: (pattern: RegExp, description: string): object => ({ type: "array", items: { type: "string", pattern: pattern.source }, description }),
};

/** Ids of phases, roles, MCP servers, specs and approval words: a lowercase slug, never an option. */
export const SLUG = /^[a-z][a-z0-9-]*$/;

export const str = (a: Args, k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined);
export const num = (a: Args, k: string): number | undefined => (typeof a[k] === "number" ? (a[k] as number) : undefined);
export const strs = (a: Args, k: string): string[] => (Array.isArray(a[k]) ? (a[k] as string[]) : []);
export const need = (a: Args, k: string): string => {
  const v = str(a, k);
  if (v === undefined || !v.trim()) throw new MwError("usage", `'${k}' is required`);
  return v;
};

/** The same refusal the CLI gives an agent inside a card run (cli.ts ownerOnly). */
export function ownerOnlyMessage(what: string): string {
  return `${what} is done by the owner, not from inside a card run (role '${process.env.MW_ROLE}'). Put what you need in your handoff.`;
}

/**
 * Commands run through viaCli one at a time: a command finds its project from the working directory,
 * which is the process's own, so while one runs nothing else may change it (the GUI's HTTP server calls
 * tools concurrently).
 */
const cliQueue = new Mutex();

/**
 * Run an existing `mw` command in-process and return what it printed. The command runs from `root`
 * (the commands find their project from the working directory), alone: calls wait for each other
 * (cliQueue), so each sees its own root for its whole run and prints only into its own lines. Its
 * MwError propagates and becomes the tool's error.
 */
export async function viaCli(root: string, argv: string[]): Promise<string> {
  const a = parseArgs(argv);
  const h = handlers[a._[0] ?? ""];
  if (!h) throw new MwError("usage", `no command '${a._[0]}'`);
  return cliQueue.run(async () => {
    if (process.cwd() !== root) process.chdir(root);
    const lines: string[] = [];
    const code = await h(a, (l = "") => lines.push(l));
    const text = lines.join("\n");
    if (code !== 0) throw new MwError("mcp/command", text || `'mw ${argv.join(" ")}' exited with ${code}`);
    return text;
  });
}
