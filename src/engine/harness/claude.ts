// Harness 'claude': the Claude Code CLI in print mode. See docs/design/engine.md section 7.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Mode } from "../../model/role.ts";
import { MwError } from "../../util.ts";
import type { Harness, HarnessRequest, Usage } from "../types.ts";
import { baseEnv } from "./index.ts";
import { exitFailure, failedRun, runCli, scratchFile, stderrTail, timeoutResult } from "./proc.ts";
import { classified } from "./transient.ts";

const WRITE_TOOLS = ["Read", "Edit", "Write", "MultiEdit", "Grep", "Glob", "LS", "TodoWrite", "Bash"];
const READ_TOOLS = ["Read", "Grep", "Glob", "LS"];
/** The built-in tools the model can see at all, per mode ("" = none; undefined = the default set). */
const VISIBLE_TOOLS: Record<Mode, string | undefined> = { advise: "", read: "Read,Grep,Glob", write: undefined };
/**
 * Every `mw` command and subcommand an agent may not run (the commands of src/cli.ts and its modules).
 * Left allowed: `mw check`, `mw trace`, `mw memory search`, `mw docs`, `mw spec propose`.
 */
const MW_DENIED = [
  "init", "card", "config", "eject", "roles", "flows", "gates", "mcps", "mcp", "upgrade", "help", "version",
  "run", "approve", "abort", "status", "work", "sync", "lease", "queue", "integrations", "doctor",
  "memory index", "memory show", "memory add", "memory state", "memory list", "memory push",
  "spec list", "spec accept", "spec reject",
];
export const CLAUDE_DISALLOWED = [
  "Bash(sudo:*)", "Bash(ssh:*)", "Bash(scp:*)", "Bash(git push:*)", "Bash(git merge:*)",
  "Bash(git commit:*)", "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(git switch:*)", "Bash(git stash:*)",
  "Bash(git rebase:*)", "Bash(git config:*)", "Bash(git worktree:*)", "Bash(git branch:*)", "Bash(git remote:*)",
  "Bash(git update-ref:*)",
  "Bash(claude:*)", "Bash(codex:*)", "Bash(hermes:*)",
  "Bash(mw)", "Bash(mw memory)", "Bash(mw spec)",
  ...MW_DENIED.map((c) => `Bash(mw ${c}:*)`),
];

/**
 * Hosts a sandboxed shell command may reach. Claude Code has no "any host" setting (it refuses `*`),
 * so this lists what builds commonly need: source forges and package registries.
 */
export const SANDBOX_DOMAINS = [
  "github.com", "*.github.com", "*.githubusercontent.com", "gitlab.com", "*.gitlab.com", "bitbucket.org",
  "registry.npmjs.org", "*.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org",
  "crates.io", "*.crates.io", "proxy.golang.org", "sum.golang.org", "rubygems.org", "repo.maven.apache.org",
  "repo1.maven.org", "plugins.gradle.org", "api.nuget.org", "deb.debian.org", "archive.ubuntu.com",
];

/**
 * Settings for a write-mode run: Bash runs in Claude Code's sandbox (bubblewrap on Linux, Seatbelt on
 * macOS), which lets shell commands write only inside the working directory (and the temporary
 * directory), never retries a command outside it, and fails at startup rather than run unconfined.
 */
export const CLAUDE_SANDBOX_SETTINGS = {
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: SANDBOX_DOMAINS },
  },
};

function onPath(cmd: string, pathEnv: string | undefined): boolean {
  for (const dir of (pathEnv ?? "").split(path.delimiter).filter(Boolean)) {
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

const sandboxProbes = new Map<string, { ok: true } | { ok: false; why: string }>();

/**
 * Whether Claude Code's shell sandbox can work on this machine; `why` says what stands in the way.
 *
 * Having bubblewrap and socat is not enough: the sandbox creates a user namespace inside
 * bubblewrap's, and systems that restrict unprivileged user namespaces (Ubuntu's AppArmor default)
 * refuse that, after which every sandboxed command fails. So the same operation is tried once here.
 * `MW_CLAUDE_SANDBOX=off` turns the sandbox off; `=on` skips the trial.
 */
export function claudeSandbox(pathEnv: string | undefined = process.env.PATH, mode: string | undefined = process.env.MW_CLAUDE_SANDBOX): { ok: true } | { ok: false; why: string } {
  if (mode === "off") return { ok: false, why: "MW_CLAUDE_SANDBOX=off is set" };
  if (process.platform === "darwin") return { ok: true };
  if (process.platform !== "linux") return { ok: false, why: `Claude Code has no shell sandbox on ${process.platform}` };
  const missing = ["bwrap", "socat"].filter((c) => !onPath(c, pathEnv));
  if (missing.length) return { ok: false, why: `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not installed (the sandbox needs bubblewrap and socat)` };
  if (mode === "on") return { ok: true };
  const key = pathEnv ?? "";
  let probe = sandboxProbes.get(key);
  if (!probe) {
    const r = spawnSync("bwrap", ["--unshare-user", "--dev-bind", "/", "/", "unshare", "-U", "-r", "true"], { stdio: "ignore", timeout: 10_000, env: { PATH: pathEnv ?? "" } });
    probe = r.status === 0
      ? { ok: true }
      : { ok: false, why: "this system does not allow the nested user namespace the sandbox needs (unprivileged user namespaces are restricted, as Ubuntu's AppArmor does by default)" };
    sandboxProbes.set(key, probe);
  }
  return probe;
}

/** How write-mode Claude agents are confined (spec 8.6): `agents.sandbox`, overridden by `MW_SANDBOX`. */
export type SandboxPolicy = "auto" | "off" | "required";
export const SANDBOX_POLICIES: readonly SandboxPolicy[] = ["auto", "off", "required"];

/**
 * The effective sandbox policy on this machine: `MW_SANDBOX` (set per machine, for example in the
 * secrets file or the service unit) over the project's `agents.sandbox`, else `auto`. An unknown
 * `MW_SANDBOX` value is a usage error rather than a silent default.
 */
export function sandboxPolicy(configured?: SandboxPolicy, env: string | undefined = process.env.MW_SANDBOX): { policy: SandboxPolicy; source: "MW_SANDBOX" | "agents.sandbox" | "default" } {
  const v = env?.trim();
  if (v) {
    if (!(SANDBOX_POLICIES as readonly string[]).includes(v)) throw new MwError("usage", `MW_SANDBOX must be auto, off or required, not '${v}'`);
    return { policy: v as SandboxPolicy, source: "MW_SANDBOX" };
  }
  if (configured) return { policy: configured, source: "agents.sandbox" };
  return { policy: "auto", source: "default" };
}

/**
 * What the policy means for one write-mode Claude agent: `use` the sandbox or not, and `refuse` (with
 * the reason) when the policy is `required` and the sandbox does not work. `off` never runs the probe.
 */
export function sandboxDecision(policy: SandboxPolicy, pathEnv: string | undefined = process.env.PATH): { use: boolean; refuse?: string; why?: string } {
  if (policy === "off") return { use: false };
  const probe = claudeSandbox(pathEnv);
  if (probe.ok) return { use: true };
  return policy === "required" ? { use: false, refuse: probe.why, why: probe.why } : { use: false, why: probe.why };
}

/**
 * The argv (without the executable) for a request. `mcpConfig` is the file holding the role's MCP
 * servers (written by the harness, see `run`); without it no `--mcp-config` is passed.
 */
export function claudeArgs(req: HarnessRequest, mcpConfig?: string): string[] {
  const { role, mode } = req;
  // Only the project's own settings and CLAUDE.md, never the owner's user-level settings (plugins,
  // hooks, user CLAUDE.md), and only the project's MCP servers: measured 44k -> 2.6k prompt tokens
  // for a trivial call. --bare would also do it but disables subscription (OAuth) login.
  const args = ["-p", "--output-format", "json", "--setting-sources", "project,local"];
  if (role.model) args.push("--model", role.model);
  if (req.outputSchema) args.push("--json-schema", JSON.stringify(req.outputSchema));
  const visible = VISIBLE_TOOLS[mode];
  if (visible !== undefined) args.push("--tools", visible);
  const allowed = mode === "write" ? [...WRITE_TOOLS] : mode === "read" ? [...READ_TOOLS] : [];
  if (req.mcp) for (const id of req.mcp.ids) allowed.push(`mcp__${id}`);
  // --allowedTools, --disallowedTools, --tools and --mcp-config are variadic: each list ends at
  // the next option, so a non-variadic option always follows them.
  if (allowed.length) args.push("--allowedTools", ...allowed);
  args.push("--disallowedTools", ...CLAUDE_DISALLOWED);
  if (req.mcp && mcpConfig) args.push("--mcp-config", mcpConfig);
  args.push("--strict-mcp-config");
  // The engine decides by the sandbox policy (req.sandbox); elsewhere the policy and the probe decide here.
  if (mode === "write" && (req.sandbox ?? sandboxDecision(sandboxPolicy().policy, req.env.PATH ?? process.env.PATH).use)) {
    args.push("--settings", JSON.stringify(CLAUDE_SANDBOX_SETTINGS));
  }
  args.push("--permission-mode", "dontAsk");
  if (req.limits.turns !== undefined) args.push("--max-turns", String(req.limits.turns));
  args.push(...role.args);
  return args;
}

export interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

function parseClaude(stdout: string): ClaudeResult | undefined {
  const asObject = (s: string): ClaudeResult | undefined => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as ClaudeResult) : undefined;
    } catch {
      return undefined;
    }
  };
  const t = stdout.trim();
  if (!t) return undefined;
  // Normally the whole of stdout; otherwise the last line that is a JSON object.
  return asObject(t) ?? t.split(/\r?\n/).reverse().map(asObject).find((v) => v !== undefined);
}

/**
 * Usage from Claude's result: `inputTokens` is fresh + cache-write + cache-read input, and each part
 * (and the turns) is kept as well when the result reports it as a number.
 */
export function claudeUsage(r: ClaudeResult): Usage | undefined {
  const u = r.usage;
  if (!u && typeof r.total_cost_usd !== "number") return undefined;
  const usage: Usage = {};
  const num = (x: unknown) => (typeof x === "number" ? x : undefined);
  if (u?.input_tokens !== undefined) {
    usage.inputTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  }
  if (u?.output_tokens !== undefined) usage.outputTokens = u.output_tokens;
  if (typeof r.total_cost_usd === "number") usage.costUsd = r.total_cost_usd;
  const fresh = num(u?.input_tokens), write = num(u?.cache_creation_input_tokens), read = num(u?.cache_read_input_tokens), turns = num(r.num_turns);
  if (fresh !== undefined) usage.freshInputTokens = fresh;
  if (write !== undefined) usage.cacheWriteTokens = write;
  if (read !== undefined) usage.cacheReadTokens = read;
  if (turns !== undefined) usage.turns = turns;
  return usage;
}

const harness: Harness = {
  async run(req) {
    // REQ-engine-006: the MCP config holds resolved secrets, so it is written to this machine's unsynced
    // `.mergewright/local/scratch/` (0600), never into the run folder, and removed however the phase ends.
    let mcp: { file: string; remove: () => void } | undefined;
    if (req.mcp) {
      try {
        mcp = scratchFile(req, "mcp.json", JSON.stringify(req.mcp.json, null, 2) + "\n");
      } catch (e) {
        return { ok: false, text: "", seconds: 0, error: `claude: could not write its MCP config: ${(e as Error).message}` };
      }
    }
    let r: Awaited<ReturnType<typeof runCli>>;
    try {
      const args = claudeArgs(req, mcp?.file);
      const env = baseEnv({ ...(req.mcp?.env ?? {}), ...req.env });
      // The prompt goes on stdin rather than as the final argument: a single argv string is capped
      // at 128 KiB on Linux (E2BIG), and a rendered prompt with a diff can be larger.
      r = await runCli({ harness: "claude", cmd: "claude", args, req, env, stdin: req.prompt });
    } finally {
      mcp?.remove();
    }
    const failed = failedRun("claude", r);
    if (failed) return failed;
    const parsed = parseClaude(r.stdout);
    const usage = parsed ? claudeUsage(parsed) : undefined;
    const json = parsed?.structured_output ?? undefined;
    const text = json !== undefined ? JSON.stringify(json) : typeof parsed?.result === "string" ? parsed.result : "";
    if (r.timedOut) return { ...timeoutResult("claude", r, req.limits.minutes, text), usage };
    if (!parsed) {
      return r.code === 0 ? { ok: false, text: "", seconds: r.seconds, error: "claude printed no JSON result" } : exitFailure("claude", r);
    }
    if (parsed.is_error || r.code !== 0) {
      const said = (parsed.result ?? "").trim().split(/\r?\n/)[0]!.slice(0, 300);
      const why = parsed.subtype && parsed.subtype !== "success" ? parsed.subtype : said;
      // REQ-harness-001: the API error Claude reports in its result ("API Error: 529 ... overloaded_error",
      // "You've hit your session limit") is classified by the shared table.
      return classified({ ok: false, text, json, usage, seconds: r.seconds, error: `claude reported an error${why ? `: ${why}` : ""}${r.code ? ` (exit ${r.code})` : ""}` }, said, stderrTail(r));
    }
    if (!text.trim()) return { ok: false, text: "", usage, seconds: r.seconds, error: "claude returned an empty reply" };
    return { ok: true, text, json, usage, seconds: r.seconds };
  },
};
export default harness;
