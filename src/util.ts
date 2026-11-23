// Small shared helpers: errors, processes, files, globs.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** An error the CLI prints as one line (no stack) and exits non-zero on. */
export class MwError extends Error {
  code: string;
  /** A JSON value a tool returns as the `data` of its error (src/mcpserver/results.ts), e.g. lint findings. */
  data?: object;
  constructor(code: string, message: string, data?: object) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ShOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Max bytes captured per stream. */
  maxBuffer?: number;
}

const secretEnvNames = new Set<string>();

/** Record that an environment variable holds a service credential (the secrets file loader calls this). */
export function markSecretEnv(name: string): void {
  secretEnvNames.add(name);
}

/** The environment every agent process starts from: enough to run, nothing it should not see. */
export function baseEnv(extra: Record<string, string>): Record<string, string> {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  env.GIT_TERMINAL_PROMPT = "0";
  return { ...env, ...extra };
}

/** Where an SSH agent's socket usually is, relative to the runtime directory, in the order tried. */
export const SSH_AGENT_SOCKETS = ["ssh-agent.socket", "keyring/ssh", "openssh_agent", "gcr/ssh"] as const;

function isSocket(file: string): boolean {
  try {
    return fs.statSync(file).isSocket();
  } catch {
    return false;
  }
}

/**
 * The SSH agent socket git should use. `SSH_AUTH_SOCK` when it is set; otherwise the
 * first of SSH_AGENT_SOCKETS that is a socket in `$XDG_RUNTIME_DIR` (or, when that is unset, in
 * `/run/user/<uid>`), so a process started without the login session's environment (an MCP server
 * an assistant starts) still reaches the hub over SSH. Undefined when there is none.
 */
export function sshAuthSock(env: NodeJS.ProcessEnv = process.env): { path: string; from: "SSH_AUTH_SOCK" | "found" } | undefined {
  if (env.SSH_AUTH_SOCK) return { path: env.SSH_AUTH_SOCK, from: "SSH_AUTH_SOCK" };
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const dir = env.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : undefined);
  if (!dir) return undefined;
  for (const rel of SSH_AGENT_SOCKETS) {
    const file = path.join(dir, rel);
    if (isSocket(file)) return { path: file, from: "found" };
  }
  return undefined;
}

/** What git itself may need of the runtime's environment besides `baseEnv`. */
const GIT_ALLOWED = /^(GIT_.*|SSH_AUTH_SOCK|SSH_AGENT_PID|LANG|LC_.*)$/;

/**
 * The environment for a git command the runtime runs. A worker shares the repository's hooks and
 * configuration through its linked worktree (a `core.sshCommand` it wrote runs under the runtime), so
 * runtime git never runs hooks (see `sh`) and gets a minimal environment built up, never a filtered
 * copy of the runtime's own: `baseEnv`, plus from the runtime's environment
 * only `GIT_*`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `LANG` and `LC_*` (never a variable loaded from the
 * secrets file), plus exactly what the caller passes in `extra`. Without `SSH_AUTH_SOCK`, the agent
 * socket `sshAuthSock` finds is used.
 */
export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = baseEnv({});
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || !GIT_ALLOWED.test(k) || secretEnvNames.has(k)) continue;
    out[k] = v;
  }
  // No agent in the environment (an MCP server started by an assistant): look for one.
  if (!out.SSH_AUTH_SOCK) {
    const sock = sshAuthSock();
    if (sock) out.SSH_AUTH_SOCK = sock.path;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
  return out;
}

/** Run a command without a shell. Never throws on a non-zero exit. */
export function sh(cmd: string, args: string[], opts: ShOptions = {}): ShResult {
  if (cmd === "git") {
    // No hook installed in the repository (by anyone, including a careless worker) runs under the runtime.
    // Every path the runtime names is a literal path, never a pattern: a file named `cards/*.card.md`
    // selects that file alone. Both are global options, before the subcommand.
    args = ["-c", "core.hooksPath=/dev/null", "--literal-pathspecs", ...args];
    opts = { ...opts, env: gitEnv(opts.env) };
  }
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env: opts.env ?? process.env,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    killSignal: "SIGTERM",
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
  if (r.error && !timedOut && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { code: 127, stdout: "", stderr: `${cmd}: command not found`, timedOut: false };
  }
  return { code: r.status ?? (timedOut ? 124 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut };
}

/** Run git in `cwd`; throws MwError on failure unless `allowFail`. */
export function git(cwd: string, args: string[], opts: { allowFail?: boolean; input?: string } = {}): ShResult {
  const r = sh("git", args, { cwd, input: opts.input });
  if (r.code !== 0 && !opts.allowFail) {
    throw new MwError("git", `git ${args.join(" ")} failed in ${cwd}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
  }
  return r;
}

export function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

export function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Write via a temp file and rename, so readers (and file-sync tools) never see a half-written file. */
let tmpCounter = 0;
/**
 * A temporary name next to `file` that no other write uses: the pid (other processes), a per-process
 * counter (other writes in this process, even concurrent ones) and a random suffix (a reused pid).
 */
export function tmpNameFor(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${++tmpCounter}.${randomBytes(4).toString("hex")}.tmp`);
}

export function writeAtomic(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpNameFor(file);
  fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
}

/**
 * Replace several files as one step: every new file is fully written first, and only then are
 * they moved into place. A failure while writing (disk full, unwritable folder) changes nothing.
 */
export function writeAllAtomic(files: { file: string; content: string }[]): void {
  const staged: { tmp: string; file: string }[] = [];
  try {
    for (const { file, content } of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = tmpNameFor(file);
      fs.writeFileSync(tmp, content);
      staged.push({ tmp, file });
    }
  } catch (e) {
    for (const s of staged) fs.rmSync(s.tmp, { force: true });
    throw e;
  }
  for (const s of staged) fs.renameSync(s.tmp, s.file);
}

export const SLUG = /^[a-z][a-z0-9-]*$/;
export const CARD_ID = /^[A-Z][A-Z0-9]{0,9}-[0-9]+$/;

/** Ids become file names, so anything that is not a plain slug is refused before it reaches a path. */
export function requireSlug(id: string, what: string): string {
  if (!SLUG.test(id)) throw new MwError("usage", `'${id}' is not a valid ${what} id (lower-case letters, digits and hyphens, starting with a letter)`);
  return id;
}

export function writeJson(file: string, value: unknown): void {
  writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

export function readJson<T>(file: string): T | undefined {
  const t = readIfExists(file);
  if (t === undefined) return undefined;
  try {
    return JSON.parse(t) as T;
  } catch {
    throw new MwError("json", `${file} is not valid JSON`);
  }
}

/**
 * The files a file-sync tool leaves while it copies (hidden `.<name>.tmp` files, the
 * same form `writeAtomic` uses) and when two machines changed a file at once
 * (`<name>.sync-conflict-<date>-<time>-<device>.<ext>`). The runtime never commits them, never counts
 * them as project files, and `mw init` puts these patterns in `.gitignore`.
 */
export const SYNC_TEMP_PATTERNS = [".*.tmp", "*.sync-conflict-*"] as const;

/** True when the file's name (any path form) is a sync temporary or conflict file. */
export function isSyncTemp(file: string): boolean {
  const name = file.split(/[\\/]/).pop() ?? file;
  return (name.startsWith(".") && name.endsWith(".tmp")) || name.includes(".sync-conflict-");
}

/** `files` without the sync temporary and conflict files. */
export function withoutSyncTemp(files: readonly string[]): string[] {
  return files.filter((f) => !isSyncTemp(f));
}

/** Files directly inside `dir` whose names end with `suffix`, sorted. Missing dir = []. Sync temporary and conflict files are left out. */
export function listFiles(dir: string, suffix: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return names.filter((n) => n.endsWith(suffix) && !isSyncTemp(n)).sort().map((n) => path.join(dir, n));
}

/** True if `file` (repo-relative, forward slashes) matches any of the globs. `dir/**` also matches `dir`'s contents at any depth. */
export function matchesAny(file: string, globs: readonly string[]): boolean {
  const f = file.split(path.sep).join("/");
  return globs.some((g) => path.matchesGlob(cased(f), cased(g)) || (g.endsWith("/**") && f.startsWith(g.slice(0, -2))));
}

// path.matchesGlob ignores case in wildcard segments on macOS ('latest.js' would match '*Test.*'). Mapping
// A-Z to private-use characters, one for one, keeps the match case-sensitive there, as on Linux.
// shortcut: only ASCII capitals are mapped; a non-ASCII capital in a wildcard segment still matches either case.
const cased = process.platform === "darwin" ? (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(0xe000 + c.charCodeAt(0))) : (s: string) => s;

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Rough token estimate for budgeting prompts (about 4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];
const SECRET_ASSIGNMENT = /((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)([A-Za-z0-9+/_=.-]{16,})/gi;

/**
 * Blank out anything that looks like a credential. Used on text a model wrote before it is stored
 * in memory or sent to a service: a secret a worker saw must not be written down by the reflection.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[redacted]");
  return out.replace(SECRET_ASSIGNMENT, "$1[redacted]");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";
}

/** Truncate long text in the middle, keeping head and tail (both matter in diffs and logs). */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - maxChars} characters omitted ...]\n\n${text.slice(-tail)}`;
}
