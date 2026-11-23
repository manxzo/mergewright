// The one redactor for what the runtime writes into a run folder (REQ-engine-006): agent and gate
// streams, saved exchanges and prompts, and gate logs. It replaces the values of the project's
// configured credentials (every `key_env`, the forge token, every variable an MCP server's `env` or
// `headers` references and every literal value they hold) with `[redacted]`, then applies
// `redactSecrets()` for anything shaped like one.
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { McpWiring } from "../mcpconfig.ts";
import { packageSecretNames } from "../packages/registry.ts";
import type { Project } from "../project.ts";
import type { HarnessResult } from "./types.ts";
import { redactSecrets, tmpNameFor } from "../util.ts";
import { FILE_MODE, privateDir } from "./private.ts";

/** Values shorter than this are not redacted: they would blank out ordinary words. */
export const MIN_SECRET_LENGTH = 6;

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The variables the forge integration reads its token from when `git.forge.token_env` is unset
 * (`settings` in src/integrations/forge.ts: GITHUB_TOKEN for github, GITEA_TOKEN otherwise). Both
 * are listed whatever the forge kind, as the MCP server's list does: a value never reaches a run folder.
 */
export const FORGE_TOKEN_DEFAULTS = ["GITHUB_TOKEN", "GITEA_TOKEN"] as const;

/** The names of the variables that hold the project's configured credentials (`key_env`, `token_env`, and the secrets enabled packages declare). */
export function keyEnvNames(project: Project): string[] {
  const c = project.config;
  const names = [
    c.localModels?.keyEnv,
    ...(c.git.forge.tokenEnv ? [c.git.forge.tokenEnv] : FORGE_TOKEN_DEFAULTS),
    ...packageSecretNames(project.packages),
  ];
  return [...new Set(names.filter((n): n is string => !!n))];
}

/** The names of the variables the `env` and `headers` of the project's MCP servers reference. */
export function mcpEnvNames(project: Project): string[] {
  const names = new Set<string>();
  for (const m of project.mcps().values()) {
    for (const v of [...Object.values(m.env), ...Object.values(m.headers)]) {
      if (typeof v === "string") for (const ref of v.matchAll(REF)) names.add(ref[1]!);
    }
  }
  return [...names];
}

/** The `env` and `headers` values of the project's MCP servers that are written out, with no reference. */
export function mcpLiteralValues(project: Project): string[] {
  const values: string[] = [];
  for (const m of project.mcps().values()) {
    for (const v of [...Object.values(m.env), ...Object.values(m.headers)]) {
      if (typeof v === "string" && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(v)) values.push(v);
    }
  }
  return values;
}

/**
 * The secret values to redact for `project`: those of its `key_env` variables, of every variable its
 * MCP servers reference and every literal `env` or `headers` value they hold, plus the values `mcp` (a
 * role's resolved wiring) passes on. Never logged.
 */
export function secretsFor(project: Project, mcp?: McpWiring, env: NodeJS.ProcessEnv = process.env): string[] {
  let names: string[] = keyEnvNames(project);
  let literal: string[] = [];
  try {
    names = [...names, ...mcpEnvNames(project)];
    literal = mcpLiteralValues(project);
  } catch {
    /* unreadable MCP files: `mw check` reports them */
  }
  const values: (string | undefined)[] = [...names.map((n) => env[n]), ...literal];
  if (mcp) values.push(...Object.values(mcp.env), ...Object.values(mcp.codexEnv));
  return usable(values);
}

/** Distinct values long enough to redact, longest first (so a value that contains another goes whole). */
function usable(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length >= MIN_SECRET_LENGTH))].sort((a, b) => b.length - a.length);
}

function replaceValues(text: string, list: readonly string[]): string {
  let out = text;
  for (const s of list) if (out.includes(s)) out = out.split(s).join("[redacted]");
  return out;
}

/** `text` with every value of `secrets` replaced by `[redacted]`, then through `redactSecrets()`. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  return redactSecrets(replaceValues(text, usable(secrets)));
}

/** `value` with every string in it (object keys left as they are) passed through `redactText`. */
function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, secrets)]));
  }
  return value;
}

/** A harness result with its text, error and parsed reply redacted (`redactText`). */
export function redactResult(res: HarnessResult, secrets: readonly string[] = []): HarnessResult {
  const out: HarnessResult = { ...res, text: redactText(res.text, secrets) };
  if (res.error !== undefined) out.error = redactText(res.error, secrets);
  if (res.json !== undefined) out.json = redactValue(res.json, secrets);
  return out;
}

export interface Sink {
  write(chunk: Buffer): void;
  close(): void;
}

/**
 * A sink that redacts what passes through it into `sink`. A value can arrive split across chunks, so
 * the last (longest secret length - 1) characters are held back until the next chunk shows how they go
 * on; `close()` flushes them (redacted) and closes `sink`. Text is decoded as UTF-8 across chunks.
 */
export function redactingSink(sink: Sink, secrets: readonly string[] = []): Sink {
  const list = usable(secrets);
  const hold = Math.max(0, (list[0]?.length ?? 0) - 1);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let closed = false;
  const emit = (text: string) => {
    if (text) sink.write(Buffer.from(redactSecrets(text), "utf8"));
  };
  return {
    write(chunk) {
      if (closed) return;
      pending = replaceValues(pending + decoder.write(chunk), list);
      if (pending.length <= hold) return;
      let cut = pending.length - hold;
      const code = pending.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--; // never split a surrogate pair
      emit(pending.slice(0, cut));
      pending = pending.slice(cut);
    },
    close() {
      if (closed) return;
      closed = true;
      emit(replaceValues(pending + decoder.end(), list));
      pending = "";
      sink.close();
    },
  };
}

/**
 * Copy `src` to `dst` redacted, through a private temporary file next to `dst` renamed into place (mode
 * 0600, its folder 0700). `src` must be a regular file; a symbolic link is refused, never followed. For
 * files a child process wrote itself (a gate's summary and step logs). Throws.
 */
export function copyRedacted(src: string, dst: string, secrets: readonly string[] = []): void {
  privateDir(path.dirname(dst));
  const tmp = tmpNameFor(dst);
  const out = fs.openSync(tmp, "wx", FILE_MODE);
  let inFd: number | undefined;
  try {
    fs.fchmodSync(out, FILE_MODE);
    const sink = redactingSink({ write: (b) => { fs.writeSync(out, b); }, close: () => {} }, secrets);
    inFd = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(inFd).isFile()) throw new Error("not a regular file");
    const buf = Buffer.alloc(64 * 1024);
    for (let n; (n = fs.readSync(inFd, buf, 0, buf.length, null)) > 0;) sink.write(Buffer.from(buf.subarray(0, n)));
    sink.close();
    fs.closeSync(out);
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { fs.closeSync(out); } catch { /* already closed */ }
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally {
    if (inFd !== undefined) fs.closeSync(inFd);
  }
}

/**
 * Copy every regular file under `from` to the same place under `to`, redacted and 0600 in 0700 folders
 * (`copyRedacted`); symbolic links and anything else are not copied, nor are the relative paths in
 * `skip`. Returns the real path of each source file that was copied, mapped to its copy. A file that
 * cannot be copied is left out (a step then reports its log as missing). Best effort.
 */
export function copyTreeRedacted(from: string, to: string, secrets: readonly string[] = [], skip: ReadonlySet<string> = new Set()): Map<string, string> {
  const copied = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? path.join(rel, e.name) : e.name;
      const src = path.join(dir, e.name);
      if (e.isDirectory()) walk(src, r);
      else if (e.isFile() && !skip.has(r)) {
        const dst = path.join(to, r);
        try {
          copyRedacted(src, dst, secrets);
          copied.set(fs.realpathSync(src), dst);
        } catch {
          /* left out: nothing unredacted is copied */
        }
      }
    }
  };
  walk(from, "");
  return copied;
}
