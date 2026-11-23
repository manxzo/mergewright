// Running an agent CLI: asynchronous child process, minimal environment, hard timeout, abort,
// audit copies of its output. Shared by the claude and codex harnesses and, through host.agent, package harnesses.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { FILE_MODE, openPrivate, privateDir, writePrivate } from "../private.ts";
import { groupAlive as procGroupAlive } from "../procid.ts";
import { redactingSink, redactText, type Sink } from "../redact.ts";
import type { HarnessRequest, HarnessResult } from "../types.ts";
import { classified } from "./transient.ts";

/** Grace periods between SIGTERM and SIGKILL, on timeout and on abort. Mutable for tests only. */
export const timing = { killGraceMs: 30_000, abortGraceMs: 5_000 };

/** How much of each output stream of a child process is kept in memory (the end of it). Mutable for tests only. */
export const capture = { maxBytes: 8 * 1024 * 1024 };

export interface Tail {
  push(chunk: Buffer): void;
  text(): string;
  /** Bytes dropped from the front because the stream was longer than the limit. */
  dropped(): number;
}

/** Keeps the last `limit` bytes of a stream. */
export function tailBuffer(limit = capture.maxBytes): Tail {
  const chunks: Buffer[] = [];
  let size = 0;
  let dropped = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      size += chunk.length;
      while (size > limit && chunks.length) {
        const over = size - limit;
        const first = chunks[0]!;
        if (first.length <= over) {
          chunks.shift();
          size -= first.length;
          dropped += first.length;
        } else {
          chunks[0] = first.subarray(over);
          size -= over;
          dropped += over;
        }
      }
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    dropped: () => dropped,
  };
}

/**
 * A file every chunk is appended to as it arrives (best effort: a failure to write never fails the run).
 * The file is private (0600, its folder 0700, REQ-engine-005) and everything passes the redactor first
 * (REQ-engine-006): `secrets` and anything shaped like a credential become `[redacted]`, also when a value
 * is split across chunks. `close()` writes what the redactor held back; call it on every way out.
 */
export function streamFile(file: string, secrets: readonly string[] = []): Sink {
  let fd: number | undefined;
  try {
    fd = openPrivate(file);
  } catch {
    fd = undefined;
  }
  return redactingSink({
    write(chunk) {
      if (fd === undefined) return;
      try { fs.writeSync(fd, chunk); } catch { /* best effort */ }
    },
    close() {
      if (fd === undefined) return;
      try { fs.closeSync(fd); } catch { /* already closed */ }
      fd = undefined;
    },
  }, secrets);
}

/** True while any process of process group `pgid` exists that is not a zombie. */
export const groupAlive = procGroupAlive;

/** Test-only seams. Nothing in the runtime sets them. */
export const reapTestHooks: {
  /** Replaces `reapGroup` (a test makes it report a group that survived). */
  reapGroup?: (pgid: number, graceMs: number) => Promise<boolean>;
} = {};

/**
 * Process groups a stopped or timed-out child left alive after SIGTERM and SIGKILL.
 * The engine takes them after every phase (`takeSurvivors`) and does not go on, or let
 * the command exit quietly, while one is alive.
 */
const survivors = new Set<number>();

/** The surviving process groups recorded since the last call, which forgets them. */
export function takeSurvivors(): number[] {
  const out = [...survivors];
  survivors.clear();
  return out;
}

/**
 * After a stopped or timed-out child has exited, wait until the rest of its
 * process group (tools it started) is gone too: up to `graceMs` after SIGTERM, then SIGKILL and up to
 * `graceMs` more. Returns false when something of the group still exists after that (a zombie does not
 * count: it runs nothing and goes once its parent reaps it).
 */
export async function reapGroup(pgid: number | undefined, graceMs: number): Promise<boolean> {
  // kill(-0) would signal the caller's own group.
  if (pgid === undefined || !(pgid > 0)) return true;
  if (reapTestHooks.reapGroup) return reapTestHooks.reapGroup(pgid, graceMs);
  const until = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (groupAlive(pgid)) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  };
  if (!groupAlive(pgid)) return true;
  try { process.kill(-pgid, "SIGTERM"); } catch { /* gone */ }
  if (await until(graceMs)) return true;
  try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ }
  return until(Math.max(graceMs, 1000));
}

/**
 * `reapGroup`, and when the group survives it, record it (see `takeSurvivors`). Resolves with the
 * surviving group's id, or undefined when the group is gone. Never rejects.
 */
export async function reapOrRecord(pgid: number | undefined, graceMs: number): Promise<number | undefined> {
  let ok = false;
  try {
    ok = await reapGroup(pgid, graceMs);
  } catch {
    ok = false;
  }
  if (ok || pgid === undefined) return undefined;
  survivors.add(pgid);
  return pgid;
}

/**
 * REQ-engine-004: once `child` (spawned `detached`, so it leads its own process group) has exited,
 * however it ended, reap the rest of its group through `reapOrRecord` (nothing to wait for when the
 * group is already gone; otherwise SIGTERM, `timing.abortGraceMs`, SIGKILL). Reaping starts on 'exit',
 * not 'close': a background child holding stdout open would keep 'close' from firing. Resolves after
 * 'close' too, so the captured output is complete, except when a group survived, whose pipes may never
 * close. `onExit` runs first, to stop timers and abort handlers.
 */
export function reapOnExit(child: ChildProcess, onExit?: () => void): Promise<{ code: number | null; signal: NodeJS.Signals | null; survivor?: number }> {
  return new Promise((resolve) => {
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let reaped: { survivor?: number } | undefined;
    let closed = false;
    const settle = () => {
      if (!exit || !reaped || (!closed && reaped.survivor === undefined)) return;
      if (!closed) { child.stdout?.destroy(); child.stderr?.destroy(); }
      resolve({ ...exit, ...reaped });
    };
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      onExit?.();
      void reapOrRecord(child.pid, timing.abortGraceMs).then((survivor) => { reaped = survivor === undefined ? {} : { survivor }; settle(); });
    });
    child.once("close", () => { closed = true; settle(); });
  });
}

/** The sentence a result carries when a process group survived. */
export function survivorNote(pgid: number | undefined): string {
  return pgid === undefined ? "" : `; process group ${pgid} is still running after SIGTERM and SIGKILL`;
}

export interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** `req.signal` fired (before or during the run). */
  aborted: boolean;
  /** The executable was not found. */
  missing: boolean;
  /** Spawn failed for another reason (message). */
  spawnError?: string;
  seconds: number;
  /** The child's process group, when it was still alive after SIGTERM and SIGKILL. */
  survivor?: number;
}

export interface CliOptions {
  harness: string;
  cmd: string;
  args: string[];
  req: HarnessRequest;
  env: Record<string, string>;
  stdin?: string;
}

/**
 * Run an agent CLI in `req.cwd` with exactly `env`, the prompt (if any) on stdin, and a hard
 * timeout of `req.limits.minutes` (SIGTERM to the whole process group, SIGKILL after the grace
 * period). Streams stdout and stderr in full to `<runDir>/<label>.<harness>.stdout|stderr` and keeps
 * only the last `capture.maxBytes` of each in memory. Never throws.
 */
export function runCli(o: CliOptions): Promise<CliRun> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  return new Promise((resolve) => {
    const out = tailBuffer();
    const err = tailBuffer();
    const outFile = streamFile(path.join(o.req.runDir, `${o.req.label}.${o.harness}.stdout`), o.req.secrets);
    const errFile = streamFile(path.join(o.req.runDir, `${o.req.label}.${o.harness}.stderr`), o.req.secrets);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const signal = o.req.signal;
    const stopTimers = () => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (r: Omit<CliRun, "stdout" | "stderr" | "seconds" | "aborted">) => {
      if (settled) return;
      settled = true;
      stopTimers();
      outFile.close();
      errFile.close();
      resolve({ ...r, aborted, stdout: out.text(), stderr: err.text(), seconds: seconds() });
    };
    let onAbort = () => {};
    if (signal?.aborted) {
      aborted = true;
      finish({ code: null, signal: null, timedOut: false, missing: false });
      return;
    }
    if (!fs.existsSync(o.req.cwd)) {
      finish({ code: null, signal: null, timedOut: false, missing: false, spawnError: `working directory ${o.req.cwd} does not exist` });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(o.cmd, o.args, { cwd: o.req.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (e) {
      finish({ code: null, signal: null, timedOut: false, missing: false, spawnError: (e as Error).message });
      return;
    }
    // The agent runs in its own process group so a timeout also stops the tools it started.
    const group = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    child.on("error", (e: NodeJS.ErrnoException) => {
      finish({ code: null, signal: null, timedOut: false, missing: e.code === "ENOENT", spawnError: e.message });
    });
    child.stdout!.on("data", (b: Buffer) => { out.push(b); outFile.write(b); });
    child.stderr!.on("data", (b: Buffer) => { err.push(b); errFile.write(b); });
    child.stdin!.on("error", () => {
      /* the agent may exit without reading its stdin */
    });
    // Whatever way the agent ended, its group is gone before the run goes on (or the runtime exits);
    // one that survives is reported, never ignored (REQ-engine-004).
    void reapOnExit(child, stopTimers).then(({ code, signal: sig, survivor }) => finish({ code, signal: sig, timedOut, missing: false, ...(survivor === undefined ? {} : { survivor }) }));
    const stop = (graceMs: number) => {
      clearTimeout(termTimer);
      group("SIGTERM");
      if (!killTimer) killTimer = setTimeout(() => group("SIGKILL"), graceMs);
    };
    termTimer = setTimeout(() => {
      timedOut = true;
      stop(timing.killGraceMs);
    }, Math.max(1, o.req.limits.minutes * 60_000));
    onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      stop(timing.abortGraceMs);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin!.end(o.stdin ?? "");
  });
}

/**
 * Write `<runDir>/<label>.<suffix>` (creating the run directory): private (0600, REQ-engine-005) and
 * redacted with `req.secrets` (REQ-engine-006). Never use it for a file that holds secrets on purpose
 * (an MCP config): see `scratchFile`. Best effort; returns the path.
 */
export function saveText(req: HarnessRequest, suffix: string, content: string): string {
  const file = path.join(req.runDir, `${req.label}.${suffix}`);
  try {
    writePrivate(file, redactText(content, req.secrets));
  } catch {
    /* audit copies must never fail the run */
  }
  return file;
}

/**
 * Replace `file` with `content` through a temporary file that is newly created with `mode` (exclusive
 * create, so it can never be an older file with wider permissions) and set to `mode` again whatever the
 * umask, then renamed into place. Throws.
 */
export function writeCreated(file: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode, flag: "wx" });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * REQ-engine-006: where a harness puts a file that holds resolved secrets on purpose (an MCP config) for
 * one phase. For a card's run (`<root>/.mergewright/runs/<CARD>`) it is this machine's own, never
 * file-synced `<root>/.mergewright/local/scratch/<CARD>/`; for any other run directory (a delegated
 * run, already under `.mergewright/local/`) a `.scratch` folder in it. Folders 0700.
 */
export function scratchDir(req: HarnessRequest): string {
  return makeScratch(scratchPath(req));
}

/** The folder `scratchDir` makes, without making it. */
export function scratchPath(req: HarnessRequest): string {
  return scratchPathOf(req.runDir);
}

/** The scratch folder (see `scratchDir`) of the run directory `runDir`, without making it. */
export function scratchPathOf(runDir: string): string {
  const runs = path.dirname(runDir);
  return path.basename(runs) === "runs"
    ? path.join(path.dirname(runs), "local", "scratch", path.basename(runDir))
    : path.join(runDir, ".scratch");
}

/** Make the scratch folder `dir` (from `scratchPathOf`) and its parent, both 0700. Returns `dir`. Throws. */
export function makeScratch(dir: string): string {
  privateDir(path.dirname(dir));
  privateDir(dir);
  return dir;
}

/** Remove `file` and then `dir` when it is empty (another phase may still have a file there). */
export function removeScratch(file: string, dir = path.dirname(file)): void {
  fs.rmSync(file, { force: true });
  try {
    fs.rmdirSync(dir);
  } catch {
    /* not empty, or already gone */
  }
}

/**
 * Write a private (0600) scratch file `<label>.<suffix>` in `scratchDir(req)`; returns it and the function
 * that removes it (and the card's scratch folder once empty). Call that in a `finally`. Throws.
 */
export function scratchFile(req: HarnessRequest, suffix: string, content: string): { file: string; remove: () => void } {
  const dir = scratchDir(req);
  const file = path.join(dir, `${req.label}.${suffix}`);
  writeCreated(file, content, FILE_MODE);
  return {
    file,
    remove: () => removeScratch(file, dir),
  };
}

/** The failure result for a run that was aborted or never really started (missing CLI, spawn error). */
export function failedRun(cli: string, r: CliRun): HarnessResult | undefined {
  if (r.aborted) return { ok: false, text: "", error: `aborted${survivorNote(r.survivor)}`, seconds: r.seconds };
  if (r.missing) return { ok: false, text: "", error: `${cli} is not installed or not on PATH`, seconds: r.seconds };
  if (r.spawnError) return { ok: false, text: "", error: `${cli} could not start: ${r.spawnError}`, seconds: r.seconds };
  return undefined;
}

export function timeoutResult(cli: string, r: CliRun, minutes: number, text = ""): HarnessResult {
  return { ok: false, text, error: `${cli} timed out after ${minutes} minute(s)${survivorNote(r.survivor)}`, seconds: r.seconds, timedOut: true };
}

/** One line describing a non-zero exit, with the last meaningful line of stderr (or stdout). */
export function exitError(cli: string, r: CliRun): string {
  const last = (r.stderr.trim() ? r.stderr : r.stdout).trim().split(/\r?\n/).filter((l) => l.trim()).pop() ?? "";
  const how = r.signal ? `was killed by ${r.signal}` : `exited with code ${r.code}`;
  return `${cli} ${how}${last ? `: ${last.trim().slice(0, 300)}` : ""}`;
}

/** The last few meaningful lines of a failed CLI's stderr: what the provider said, for classification. */
export function stderrTail(r: CliRun, lines = 5): string {
  return r.stderr.trim().split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join("\n");
}

/**
 * The result of a non-zero exit (`exitError`), marked transient or quota through the shared table
 * (REQ-harness-001) on the error line and the end of stderr.
 */
export function exitFailure(cli: string, r: CliRun, extra: Partial<HarnessResult> = {}): HarnessResult {
  return classified({ ok: false, text: "", seconds: r.seconds, ...extra, error: exitError(cli, r) }, stderrTail(r));
}
