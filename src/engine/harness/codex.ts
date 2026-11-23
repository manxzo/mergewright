// Harness 'codex': the Codex CLI's non-interactive `exec`. See docs/design/engine.md section 7.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Harness, HarnessRequest, Usage } from "../types.ts";
import { FILE_MODE } from "../private.ts";
import { exitFailure, failedRun, removeScratch, runCli, saveText, scratchDir, scratchPath, timeoutResult, writeCreated } from "./proc.ts";
import { classified } from "./transient.ts";
import { baseEnv } from "./index.ts";

/**
 * Where Codex writes its final message (`-o`): this machine's unsynced scratch folder (`scratchPath`),
 * never the run directory, because Codex writes it unredacted (REQ-engine-006). The harness reads it
 * when Codex has ended, keeps a redacted copy as `<runDir>/<label>.codex.reply` and removes it.
 */
export function codexReplyFile(req: HarnessRequest): string {
  return path.join(scratchPath(req), `${req.label}.codex.reply`);
}

/** The argv (without the executable); writes the schema file when only the schema object was given. */
export function codexArgs(req: HarnessRequest): string[] {
  const sandbox = req.mode === "write" ? "workspace-write" : "read-only";
  // --ignore-user-config: none of the owner's MCP servers, plugins or defaults. The per-run CODEX_HOME
  // (prepareCodexHome) holds only auth.json, so no global AGENTS.md either. Without a role model codex
  // then uses its built-in default model.
  const args = ["exec", "--json", "-s", sandbox, "-C", req.cwd, "--ephemeral", "--skip-git-repo-check", "--ignore-user-config"];
  if (req.outputSchema || req.outputSchemaFile) {
    // Codex's structured output is strict (every property required); a schema with
    // optional properties is given to it with them required and nullable, which the reply then fills.
    const strict = req.outputSchema ? strictSchema(req.outputSchema) : undefined;
    const file = strict && strict !== req.outputSchema ? saveText(req, "schema.json", JSON.stringify(strict, null, 2) + "\n")
      : req.outputSchemaFile ?? saveText(req, "schema.json", JSON.stringify(req.outputSchema, null, 2) + "\n");
    args.push("--output-schema", file);
  }
  if (req.role.model) args.push("-m", req.role.model);
  args.push("-o", codexReplyFile(req));
  // REQ-engine-006: these name the variables that hold resolved MCP secrets; the values reach Codex
  // through its environment (`codexEnv`, set in `run`), never on its command line.
  if (req.mcp) args.push(...req.mcp.codexArgs);
  args.push(...req.role.args);
  args.push("-"); // prompt on stdin
  return args;
}

/**
 * The schema as Codex's strict structured output accepts it: every property of every object listed in
 * `required`, an optional one made nullable (`type: [<t>, "null"]`, or `anyOf` with null). Returns the
 * same object when nothing was optional. The runtime validates the reply against the original schema,
 * so a null it got for an optional field is dropped first (`dropNulls`).
 */
export function strictSchema(schema: object): object {
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const n = { ...(node as Record<string, unknown>) };
    for (const k of ["items", "anyOf", "oneOf", "allOf"]) if (k in n) n[k] = walk(n[k]);
    if (n.properties && typeof n.properties === "object") {
      const props: Record<string, unknown> = {};
      const required = Array.isArray(n.required) ? (n.required as string[]) : [];
      for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) {
        let p = walk(v) as Record<string, unknown>;
        if (!required.includes(k)) {
          changed = true;
          const { description, ...rest } = p;
          p = typeof rest.type === "string" ? { ...rest, type: [rest.type, "null"] } : { anyOf: [rest, { type: "null" }] };
          if (description !== undefined) p.description = description;
        }
        props[k] = p;
      }
      n.properties = props;
      n.required = Object.keys(props);
    }
    return n;
  };
  const out = walk(schema) as object;
  return changed ? out : schema;
}

/**
 * A reply to `strictSchema(schema)` with the nulls Codex put in the original schema's optional
 * properties removed (a null where the original allows one, in a required property, is kept).
 */
export function dropNulls(value: unknown, schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return value;
  const sc = schema as Record<string, unknown>;
  if (Array.isArray(value)) return value.map((v) => dropNulls(v, sc.items));
  if (!value || typeof value !== "object" || !sc.properties || typeof sc.properties !== "object") return value;
  const props = sc.properties as Record<string, unknown>;
  const required = Array.isArray(sc.required) ? (sc.required as string[]) : [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null && !required.includes(k)) continue;
    out[k] = dropNulls(v, props[k]);
  }
  return out;
}

/** The owner's Codex home: `$CODEX_HOME`, else `~/.codex`. */
export function ownerCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/**
 * The per-run Codex home (spec 8.6): Codex reads global instructions from `$CODEX_HOME/AGENTS.md`
 * (and AGENTS.override.md), hooks, rules, skills and memories from there too, which
 * `--ignore-user-config` does not stop. So each run gets its own home holding only `auth.json`.
 * It lives in this machine's `.mergewright/local/` (never file-synced, unlike the run directory, so the
 * login never reaches the other machine), or inside the run directory when that is not a project's.
 */
export function codexHomeFor(req: HarnessRequest): string {
  const runs = path.dirname(req.runDir);
  if (path.basename(runs) === "runs") return path.join(path.dirname(runs), "local", "codex-home", path.basename(req.runDir), req.label);
  return path.join(req.runDir, `${req.label}.codex-home`);
}

const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Make the per-run home with a copy of the owner's `auth.json` (mode 600) and nothing else. Returns
 * a function that removes it, first copying a login Codex refreshed during the run back to the owner's
 * home (when the owner's file did not change meanwhile), so a rotated refresh token is not lost.
 * The file's content is never logged.
 */
export function prepareCodexHome(req: HarnessRequest, ownerHome = ownerCodexHome()): { home: string; cleanup: () => void } {
  const home = codexHomeFor(req);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const src = path.join(ownerHome, "auth.json");
  let original: Buffer | undefined;
  try {
    original = fs.readFileSync(src);
  } catch {
    original = undefined; // not logged in through a file: codex reports it
  }
  const copy = path.join(home, "auth.json");
  if (original) writeCreated(copy, original.toString("utf8"), 0o600);
  const cleanup = () => {
    try {
      if (original) {
        const after = fs.readFileSync(copy);
        if (digest(after) !== digest(original) && digest(fs.readFileSync(src)) === digest(original)) {
          writeCreated(src, after.toString("utf8"), 0o600);
        }
      }
    } catch {
      /* the copy is gone or the owner's file moved: nothing to carry back */
    }
    fs.rmSync(home, { recursive: true, force: true });
    // The card's folder (`codex-home/<card>/`) goes too once no other home is in it.
    const parent = path.dirname(home);
    if (path.basename(path.dirname(parent)) === "codex-home") {
      try {
        fs.rmdirSync(parent); // only an empty folder is removed
      } catch {
        /* another agent of the run still has its home there */
      }
    }
  };
  return { home, cleanup };
}

/** Usage from the last `turn.completed` event of `--json` output. */
function codexUsage(stdout: string): Usage | undefined {
  let usage: Usage | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } };
      if (ev.type === "turn.completed" && ev.usage) {
        usage = {};
        if (ev.usage.input_tokens !== undefined) usage.inputTokens = ev.usage.input_tokens;
        if (ev.usage.output_tokens !== undefined) usage.outputTokens = ev.usage.output_tokens;
      }
    } catch {
      /* not an event line */
    }
  }
  return usage;
}

/** The error message of a `turn.failed` / `error` event, if any. */
function codexEventError(stdout: string): string | undefined {
  let msg: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; message?: string; error?: { message?: string } };
      if (ev.type === "turn.failed" || ev.type === "error") msg = ev.error?.message ?? ev.message ?? msg;
    } catch {
      /* not an event line */
    }
  }
  return msg?.split(/\r?\n/)[0]?.slice(0, 300);
}

const harness: Harness = {
  async run(req) {
    const replyFile = codexReplyFile(req);
    try {
      scratchDir(req);
      // Created empty and private now, so Codex writes into a 0600 file; never mistake an earlier reply for this one.
      writeCreated(replyFile, "", FILE_MODE);
    } catch {
      /* codex reports the unwritable file itself */
    }
    let r: Awaited<ReturnType<typeof runCli>>;
    let text = "";
    try {
      const args = codexArgs(req);
      let isolated: { home: string; cleanup: () => void };
      try {
        isolated = prepareCodexHome(req);
      } catch (e) {
        return { ok: false, text: "", seconds: 0, error: `codex: could not prepare its per-run home: ${(e as Error).message}` };
      }
      const env = baseEnv({ ...(req.mcp?.env ?? {}), ...(req.mcp?.codexEnv ?? {}), ...req.env, CODEX_HOME: isolated.home });
      try {
        r = await runCli({ harness: "codex", cmd: "codex", args, req, env, stdin: req.prompt });
      } finally {
        isolated.cleanup();
      }
      try {
        text = fs.readFileSync(replyFile, "utf8");
      } catch {
        /* no reply written */
      }
    } finally {
      removeScratch(replyFile);
    }
    // The run directory keeps only the redacted copy (saveText), like every other file of the run.
    if (text) saveText(req, "codex.reply", text);
    text = text.trim();
    const failed = failedRun("codex", r);
    if (failed) return failed;
    const usage = codexUsage(r.stdout);
    if (r.timedOut) return { ...timeoutResult("codex", r, req.limits.minutes, text), usage };
    // REQ-harness-001: a failure Codex reports in a `turn.failed` or `error` event (or on stderr) is
    // marked transient or quota through the shared table; "wrote no final message" alone is neither.
    if (r.code !== 0) {
      const ev = codexEventError(r.stdout);
      if (!ev) return exitFailure("codex", r, { text, usage });
      return classified({ ok: false, text, usage, seconds: r.seconds, error: `codex exited with code ${r.code}: ${ev}` });
    }
    if (!text) {
      const ev = codexEventError(r.stdout);
      return ev ? classified({ ok: false, text: "", usage, seconds: r.seconds, error: ev }) : { ok: false, text: "", usage, seconds: r.seconds, error: "codex wrote no final message" };
    }
    let json: unknown;
    if (req.outputSchema || req.outputSchemaFile) {
      try {
        json = JSON.parse(text);
        if (req.outputSchema && strictSchema(req.outputSchema) !== req.outputSchema) json = dropNulls(json, req.outputSchema);
      } catch {
        json = undefined; // the engine falls back to extractJson and validation
      }
    }
    return { ok: true, text, json, usage, seconds: r.seconds };
  },
};
export default harness;
