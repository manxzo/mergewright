// Running a gate: the project's checks, judged by exit code, summarised in gate.json.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Project } from "../project.ts";
import { readIfExists, redactSecrets } from "../util.ts";
import { baseEnv } from "./harness/index.ts";
import { makeScratch, reapOnExit, scratchPathOf, streamFile, survivorNote, tailBuffer } from "./harness/proc.ts";
import { privateDir } from "./private.ts";
import { copyTreeRedacted, redactText } from "./redact.ts";

export interface GateStep {
  name: string;
  kind?: string;
  ok: boolean;
  seconds?: number;
  log?: string;
  /**
   * The end of the step's log as the runtime copied it when the gate finished: bounded, secrets
   * redacted. Prompts are rendered from this copy, never from the log file.
   */
  tail?: string;
  /**
   * The step did not run (a tool or a variable it needs is missing here). A gate writes
   * `true` with a `reason`, or the reason itself; the runtime keeps `true` and a bounded, redacted `reason`.
   */
  skipped?: boolean | string;
  /** Why the step was skipped. */
  reason?: string;
}

/** A gate step that did not run, with why. */
export interface SkippedStep {
  name: string;
  reason?: string;
}

/** The code of a gate that failed because a step `gate.required` names was skipped. */
export const REQUIRED_SKIPPED = "gate/required-skipped";

/**
 * The code of a gate that exited 0 but did not show every step `gate.required` names
 * exactly once (missing, listed twice, malformed, or no usable summary at all). The gate script is
 * the owner's, so the engine blocks the phase for the owner rather than spending a round.
 */
export const REQUIRED_MISSING = "gate/required-missing";

export interface GateJson {
  ok: boolean;
  steps: GateStep[];
  /** The commit the gate judged; the engine adds it when it stores the artifact. */
  head?: string;
  /**
   * REQ-gate-004: the base commit the gate ran against: the commit of the base branch the judged tree
   * builds on (where the card branch left it). Absent in artifacts written by an older runtime; the
   * merge then treats the base as unknown, which counts as moved.
   */
  base?: string;
  /** What the runtime refused in the gate's own report. */
  warnings?: string[];
}

export interface GateRun {
  ok: boolean;
  /** For a failure: the failing steps and the end of each one's log. */
  detail: string;
  seconds: number;
  json: GateJson;
  /**
   * Set (to REQUIRED_SKIPPED) when the gate failed only because a required step was
   * skipped, or (to REQUIRED_MISSING) because a required step was missing, duplicated or
   * malformed, or the summary was: the worker cannot fix that, so the engine blocks the phase for the owner.
   */
  code?: string;
}

const TAIL = 40;

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process could not be started. */
  error?: string;
  /** The command's process group, when it was still alive after SIGTERM and SIGKILL. */
  survivor?: number;
}

/**
 * Run a command as an asynchronous child process in its own process group, so the event loop
 * (and the lease heartbeat) keeps running. Timeout and abort kill the whole group. Only the last
 * `capture.maxBytes` of stdout and of stderr are kept in memory; with `logFile`, both streams are
 * written there in full as they arrive, private and with `secrets` redacted (`streamFile`).
 */
export function spawnAsync(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number; signal?: AbortSignal; logFile?: string; secrets?: readonly string[] }): Promise<SpawnResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve({ code: 130, stdout: "", stderr: "", timedOut: false, aborted: true });
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = tailBuffer();
    const stderr = tailBuffer();
    const log = opts.logFile ? streamFile(opts.logFile, opts.secrets) : undefined;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const kill = () => {
      try {
        if (!(child.pid! > 0)) throw new Error("no pid");
        process.kill(-child.pid!, "SIGKILL");
      } catch { child.kill("SIGKILL"); }
    };
    child.stdout.on("data", (d: Buffer) => { stdout.push(d); log?.write(d); });
    child.stderr.on("data", (d: Buffer) => { stderr.push(d); log?.write(d); });
    child.stdin.on("error", () => {}); // a command that does not read stdin closes it early
    child.stdin.end(opts.input ?? "");
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    const onAbort = () => { aborted = true; kill(); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const stopTimers = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const done = (code: number | null, error?: string, survivor?: number) => {
      if (settled) return;
      settled = true;
      stopTimers();
      log?.close();
      const result = { code: code ?? (timedOut ? 124 : aborted ? 130 : 1), stdout: stdout.text(), stderr: stderr.text(), timedOut, aborted, error };
      resolve(survivor === undefined ? result : { ...result, survivor });
    };
    child.on("error", (e) => done(127, e.message));
    // REQ-engine-004: however the command ended, its process group is gone
    // before this returns (a background child never outlives the gate); one that survives is reported in
    // the result and recorded for the engine. The outcome still comes from the exit code alone.
    void reapOnExit(child, stopTimers).then(({ code, survivor }) => done(code, undefined, survivor));
  });
}

export function tail(text: string, n = TAIL): string {
  return text.replace(/\s+$/, "").split("\n").slice(-n).join("\n");
}

/** The gate's summary as it was found: absent, present but unusable (with why), or usable. */
type ReadSummary = { json: GateJson } | { absent: true } | { malformed: string };

function readGateJson(file: string): ReadSummary {
  const t = readIfExists(file);
  if (t === undefined) return { absent: true };
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return { malformed: "it is not valid JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { malformed: "it is not a JSON object" };
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.steps)) return { malformed: "it has no `steps` list" };
  if (typeof o.ok !== "boolean") return { malformed: "it has no boolean `ok`" };
  return { json: o as unknown as GateJson };
}

/** What `checkSteps` found about the steps of a gate summary and the names `gate.required` lists. */
export interface StepCheck {
  /** The well-formed steps (an object with a string `name` and a boolean `ok`), in order. */
  steps: GateStep[];
  /** One sentence per malformed step; such a step is dropped and satisfies nothing. */
  warnings: string[];
  /** Required names no well-formed step carries. */
  missing: string[];
  /** Required names more than one well-formed step carries. */
  duplicated: string[];
  /** Required steps (present once) reported as skipped. */
  skipped: string[];
  /** Required steps (present once, not skipped) that report `ok: false`. */
  failed: string[];
}

const isSkipped = (s: { skipped?: unknown }) => s.skipped === true || typeof s.skipped === "string";

/**
 * (REQ-gate-001, REQ-gate-003): the one place that validates gate steps and checks them
 * against `gate.required`. A step needs a string `name` and a boolean `ok`; any other step is
 * reported and never satisfies a required name, even when its name matches. Each required name must
 * be carried by exactly one well-formed step, which must have run and passed.
 */
export function checkSteps(raw: unknown[], required: string[]): StepCheck {
  const steps: GateStep[] = [];
  const warnings: string[] = [];
  raw.forEach((s, i) => {
    const o = s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : undefined;
    const name = typeof o?.name === "string" && o.name ? o.name : undefined;
    const ok = typeof o?.ok === "boolean";
    if (o && name && ok) return void steps.push(o as unknown as GateStep);
    const which = name ? `'${redactSecrets(name.slice(0, 80))}'` : `number ${i + 1}`;
    const why = [!o ? "it is not an object" : !name ? "it has no string `name`" : "", o && !ok ? "it has no boolean `ok`" : ""].filter(Boolean).join(" and ");
    warnings.push(`step ${which} of the gate summary is malformed (${why}); it was ignored and satisfies no required step`);
  });
  const out: StepCheck = { steps, warnings, missing: [], duplicated: [], skipped: [], failed: [] };
  for (const want of new Set(required)) {
    const hits = steps.filter((s) => s.name === want);
    if (hits.length === 0) out.missing.push(want);
    else if (hits.length > 1) out.duplicated.push(want);
    else if (isSkipped(hits[0]!)) out.skipped.push(want);
    else if (!hits[0]!.ok) out.failed.push(want);
  }
  return out;
}

/** The last `bytes` of a file as text ("" when it cannot be read): a log may be huge. */
function readEnd(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const real = (p: string) => {
  try { return fs.realpathSync(p); } catch { return undefined; }
};

/**
 * Copy the end of each step's log into the step (`tail`, bounded and redacted),
 * but only from a regular file whose real path lies inside the gate-log folder. Any other `log` (a
 * path elsewhere, a symbolic link, a folder) is dropped from the step with a warning in the result.
 */
export function snapshotLogs(json: GateJson, cwd: string, logs: string): GateJson {
  const home = real(logs);
  const warnings = [...(json.warnings ?? [])];
  const steps = json.steps.filter((x) => x && typeof x === "object").map((step): GateStep => {
    const { tail: _ignored, skipped: rawSkipped, reason: rawReason, ...plain } = step as GateStep & Record<string, unknown>;
    // A skipped step keeps `skipped: true` and its reason, bounded and redacted.
    const skipWhy = typeof rawReason === "string" && rawReason.trim() ? rawReason : typeof rawSkipped === "string" && rawSkipped.trim() ? rawSkipped : undefined;
    const rest: GateStep = rawSkipped === true || typeof rawSkipped === "string" ? { ...plain, skipped: true, ...(skipWhy ? { reason: redactSecrets(skipWhy.trim().split("\n")[0]!.slice(0, 200)) } : {}) } : plain;
    if (typeof rest.log !== "string" || !rest.log) return { ...rest, log: undefined };
    const file = path.resolve(cwd, rest.log);
    let why: string | undefined;
    let st: fs.Stats | undefined;
    try { st = fs.lstatSync(file); } catch { why = "it does not exist"; }
    const at = real(file);
    if (!why && st && !st.isFile()) why = st.isSymbolicLink() ? "it is a symbolic link" : "it is not a regular file";
    if (!why && (!home || !at || !at.startsWith(home + path.sep))) why = `it is not inside the gate-log folder ${logs}`;
    if (why) {
      warnings.push(`the log '${rest.log}' of step '${String(rest.name)}' was ignored: ${why}`);
      return { ...rest, log: undefined };
    }
    return { ...rest, tail: redactSecrets(tail(readEnd(file, 256 * 1024))) };
  });
  return { ...json, steps, ...(warnings.length ? { warnings } : {}) };
}

/** The steps of a gate result that did not run. */
export function skippedSteps(json: GateJson | undefined): SkippedStep[] {
  return (json?.steps ?? []).filter((s) => s.skipped === true || typeof s.skipped === "string").map((s) => ({ name: String(s.name), ...(s.reason ? { reason: s.reason } : {}) }));
}

/** "db_api (DATABASE_URL not set), lint" */
export function describeSkipped(steps: SkippedStep[]): string {
  return steps.map((s) => `${s.name}${s.reason ? ` (${s.reason})` : ""}`).join(", ");
}

/** The end of a step's log, as copied into the gate artifact when the gate finished. */
export function stepLog(step: GateStep): string {
  return typeof step.tail === "string" ? step.tail : "";
}

/**
 * The environment a gate runs with: the minimal agent environment, the `MERGEWRIGHT_*` variables, and
 * only the variables the owner listed in `gate.env`. Nothing else of the runtime's environment
 * (integration tokens loaded from the secrets file among it) reaches gate code, which runs files a
 * worker may have changed.
 */
export function gateEnv(project: Project, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("MERGEWRIGHT_") && v !== undefined) env[k] = v;
  for (const k of project.config.gate.env) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return baseEnv({ ...env, ...extra });
}

export interface GateOptions {
  id: string;
  file: string;
  cwd: string;
  runDir: string;
  base: string;
  minutes: number;
  env: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Step names that must run (`gate.required`). Each must be reported
   * exactly once, well formed, not skipped and passing, or the gate fails.
   */
  required?: string[];
  /**
   * REQ-engine-006: secret values (`secretsFor`) replaced by `[redacted]` in the gate's log, in the step
   * logs it wrote and in the detail. Never logged.
   */
  secrets?: readonly string[];
  /** REQ-gate-004: the base commit the checked tree builds on, recorded as `base` in the result. */
  baseCommit?: string;
}

/**
 * Run a gate. The gate writes its JSON summary and its step logs into a private scratch folder outside
 * the run directory; when it has ended the runtime copies them redacted into `gate-logs/`, reads the
 * copy, lets the exit code decide, and returns the result (the engine stores it as the `gate` artifact).
 */
export async function runGate(opts: GateOptions): Promise<GateRun> {
  const logs = path.join(opts.runDir, "gate-logs");
  privateDir(logs); // REQ-engine-005
  // REQ-engine-006: the gate never writes into the (file-synced) run folder itself: its
  // summary and step logs go to this machine's unsynced scratch folder (0700), removed however it ends.
  const card = scratchPathOf(opts.runDir);
  const scratch = path.join(card, `gate-${opts.id}`);
  fs.rmSync(scratch, { recursive: true, force: true });
  try {
    makeScratch(card);
    privateDir(scratch);
    return await gateIn(opts, logs, scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    try {
      fs.rmdirSync(card); // once empty: a harness of the same card may still have a file there
    } catch {
      /* not empty, or already gone */
    }
  }
}

/**
 * Point the step logs of `json` that the gate wrote in `scratch` at their redacted copies in the run
 * folder (`copied`: real source path to copy). Any other `log` is left as it is for `snapshotLogs`.
 */
function relocateLogs(json: GateJson, cwd: string, copied: ReadonlyMap<string, string>): GateJson {
  const steps = json.steps.map((step) => {
    if (!step || typeof step !== "object" || typeof step.log !== "string" || !step.log) return step;
    const file = path.resolve(cwd, step.log);
    let isFile = false;
    try { isFile = fs.lstatSync(file).isFile(); } catch { /* missing */ }
    const at = isFile ? real(file) : undefined;
    const copy = at ? copied.get(at) : undefined;
    return copy ? { ...step, log: copy } : step;
  });
  return { ...json, steps };
}

async function gateIn(opts: GateOptions, logs: string, scratch: string): Promise<GateRun> {
  const jsonName = `${opts.id}.gate.json`;
  const jsonFile = path.join(logs, jsonName);
  fs.rmSync(jsonFile, { force: true });
  const outLog = path.join(logs, `${opts.id}.out.log`);
  const env = { ...opts.env, MERGEWRIGHT_GATE_JSON: path.join(scratch, jsonName), MERGEWRIGHT_GATE_LOGS: scratch, MERGEWRIGHT_BASE: opts.base };
  const executable = (fs.statSync(opts.file).mode & 0o111) !== 0;
  const t0 = Date.now();
  const run = { cwd: opts.cwd, env, timeoutMs: opts.minutes * 60_000, signal: opts.signal, logFile: outLog, secrets: opts.secrets };
  const r = executable ? await spawnAsync(opts.file, [], run) : await spawnAsync("bash", [opts.file], run);
  const seconds = Math.round((Date.now() - t0) / 1000);
  const ok = r.code === 0 && !r.timedOut && !r.aborted;

  const required = opts.required ?? [];
  // REQ-engine-005, REQ-engine-006: what the gate wrote itself (step logs, its summary) is copied into
  // the run folder redacted and 0600 before anything is read; its own log was redacted as it was
  // written (and is never overwritten by a file of the same name).
  const copied = copyTreeRedacted(scratch, logs, opts.secrets, new Set([path.basename(outLog)]));
  const read = readGateJson(jsonFile);
  const summaryProblem = "absent" in read ? "the gate wrote no JSON summary" : "malformed" in read ? `the gate's JSON summary is malformed: ${read.malformed}` : undefined;
  // REQ-gate-002: with required steps, no usable summary fails closed: no synthetic passing step.
  const closed = ok && required.length > 0 && summaryProblem !== undefined;
  const found = "json" in read ? read.json : { ok: ok && !closed, steps: [{ name: opts.id, kind: "gate", ok: ok && !closed, seconds, log: outLog }] };
  const check = checkSteps(found.steps, "json" in read ? required : []);
  let json: GateJson = { ok, steps: check.steps, ...(opts.baseCommit ? { base: opts.baseCommit } : {}), ...(check.warnings.length ? { warnings: check.warnings } : {}) }; // the exit code decides
  json = snapshotLogs(relocateLogs(json, opts.cwd, copied), opts.cwd, logs);

  const skipped = skippedSteps(json);
  const notRun = skipped.length ? `; NOT run: ${describeSkipped(skipped)}` : "";
  const malformedNote = check.warnings.length ? ` Malformed steps: ${check.warnings.join("; ")}.` : "";
  // (REQ-gate-001, REQ-gate-002): a required step the summary does not show exactly once,
  // well formed, blocks the phase: the gate script is the owner's, a worker cannot repair it.
  if (ok && (closed || check.missing.length || check.duplicated.length)) {
    json = { ...json, ok: false };
    const why: string[] = [];
    if (closed) why.push(`${summaryProblem}, so none of the required step(s) ${required.join(", ")} can be shown to have passed`);
    if (check.missing.length) why.push(`the summary has no well-formed step named ${check.missing.join(", ")}`);
    if (check.duplicated.length) why.push(`the summary lists the step${check.duplicated.length > 1 ? "s" : ""} ${check.duplicated.join(", ")} more than once`);
    if (check.skipped.length) why.push(`the required step(s) ${describeSkipped(skipped.filter((s) => check.skipped.includes(s.name)))} did not run`);
    const detail = `gate '${opts.id}' failed (${REQUIRED_MISSING}): ${why.join("; ")}, and gate.required in mergewright.yaml lists ${required.length > 1 ? "them" : "it"}${notRun}.${malformedNote} Make the gate write its JSON summary to MERGEWRIGHT_GATE_JSON with each required step exactly once (a string name and a boolean ok), or remove the step from gate.required, then run the card again.`;
    return { ok: false, detail: redactText(detail, opts.secrets), seconds, json, code: REQUIRED_MISSING };
  }
  // A step the owner requires that did not run fails the gate, whatever the exit code.
  const missing = skipped.filter((s) => check.skipped.includes(s.name));
  if (ok && missing.length) {
    json = { ...json, ok: false };
    const names = missing.map((s) => s.name).join(", ");
    const detail = `gate '${opts.id}' failed (${REQUIRED_SKIPPED}): the required step${missing.length > 1 ? "s" : ""} ${describeSkipped(missing)} did not run, and gate.required in mergewright.yaml lists ${missing.length > 1 ? "them" : "it"}${notRun} (spec 8.3: skipped steps are named either way). Make ${missing.length > 1 ? "them" : "it"} runnable on this machine (for a missing variable: set it and list it in gate.env), or remove ${names} from gate.required, then run the card again.`;
    return { ok: false, detail: redactText(detail, opts.secrets), seconds, json, code: REQUIRED_SKIPPED };
  }
  // (REQ-gate-001 AC-3): a required step that reports a failure fails the gate even when it
  // exited 0. This is an ordinary failure: the worker can fix a failing check.
  if (ok && check.failed.length) {
    json = { ...json, ok: false };
    const parts = [`gate '${opts.id}' failed: it exited 0, but the required step${check.failed.length > 1 ? "s" : ""} ${check.failed.join(", ")} reported ok: false${notRun}`];
    for (const s of json.steps.filter((x) => check.failed.includes(x.name))) parts.push(`step ${s.name} failed:\n${stepLog(s) || "(no log)"}`);
    return { ok: false, detail: redactText(parts.join("\n"), opts.secrets), seconds, json };
  }
  if (ok) return { ok, detail: `gate '${opts.id}' passed (${json.steps.length} step(s)${notRun})${malformedNote ? `.${malformedNote}` : ""}`, seconds, json };
  const failing = json.steps.filter((s) => !s.ok);
  const parts: string[] = [
    r.timedOut ? `gate '${opts.id}' timed out after ${opts.minutes} minute(s)${survivorNote(r.survivor)}` : r.aborted ? `gate '${opts.id}' was stopped${survivorNote(r.survivor)}` : r.error ? `gate '${opts.id}' could not start: ${r.error}` : `gate '${opts.id}' failed (exit ${r.code})`,
  ];
  for (const s of failing) parts.push(`step ${s.name} failed:\n${stepLog(s) || "(no log)"}`);
  if (skipped.length) parts.push(`steps NOT run: ${describeSkipped(skipped)}`);
  if (!failing.length) parts.push(`gate output:\n${tail(`${r.stdout}\n${r.stderr}`) || "(no output)"}`);
  // The detail becomes the remediation prompt: a credential a test printed never goes in.
  return { ok, detail: redactText(parts.join("\n"), opts.secrets), seconds, json };
}

/**
 * gate.json rendered for a prompt: pass/fail per step, and the end of each failing step's log as the
 * runtime copied it when the gate finished (no file is read here: a log changed since changes nothing).
 */
export function renderGate(json: GateJson | undefined): string {
  if (!json) return "";
  const out = [`Gate ${json.ok ? "passed" : "failed"}.`];
  for (const s of json.steps) {
    const skipped = s.skipped === true || typeof s.skipped === "string";
    out.push(`- ${s.name}: ${skipped ? `NOT RUN${s.reason ? ` (${s.reason})` : ""}` : s.ok ? "ok" : "FAIL"}`);
    if (!s.ok && !skipped) {
      const log = redactSecrets(stepLog(s));
      if (log) out.push("```", log, "```");
    }
  }
  // Say plainly what the gate did not check, so a review or an approval does not rest on it.
  const skipped = skippedSteps(json);
  if (skipped.length) out.push(`Gate steps NOT run: ${describeSkipped(skipped)}. Passing the gate says nothing about what they check.`);
  for (const w of json.warnings ?? []) out.push(`(runtime: ${w})`);
  return out.join("\n");
}
