// The package API, version 1. EXPERIMENTAL: it may change in any release; a package states the version
// it is written for in its manifest (`apiVersion`), and a runtime refuses a package written for another.
//
// A package is a folder with `mergewright-package.yaml` (schemas/package.schema.json) and an ES module
// entry that exports `activate(host)`. `activate` returns the parts the package provides; every part is
// optional. A package never imports MergeWright's own files (in the single executable they exist only
// inside the bundle): everything it needs from the runtime arrives on `host`.
//
// This file is the contract and its documentation. Types only, apart from API_VERSION.
import type { HarnessRequest, HarnessResult, LessonRecord } from "../engine/types.ts";
import type { CliRun } from "../engine/harness/proc.ts";

export const API_VERSION = 1;

export type { CliRun, HarnessRequest, HarnessResult, LessonRecord };

// ── What the runtime gives a package ────────────────────────────────────────────────────────

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as multipart/form-data instead of `body`, e.g. a file upload: `form.append("file", new Blob([text]), "name.md")`. */
  form?: FormData;
  /** Default 10 000 ms. Inside a queue flush the flush's time budget also cuts the request. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** An HTTP failure: `status` is the HTTP status, or 0 when there was no response (refused, timed out). */
export interface HttpErrorLike extends Error {
  status: number;
  body: string;
}

/** What a deliverer may tell the queue while it works (see Deliverer). */
export interface DeliverContext {
  /** Rewrite the claimed item with what is still to deliver, so a delivery cut short never sends a part twice. */
  progress(remaining: unknown, summary?: string): void;
}

/** Per-record counts a deliverer of records may return; `mw queue flush` reports them. */
export interface DeliveryCounts {
  total: number;
  delivered: number;
  present: number;
}

/** A documentation file as a blob of one commit: its text, missing (deleted in that commit), or skipped and why. */
export type DocBlob = { kind: "file"; content: string } | { kind: "missing" } | { kind: "skipped"; why: string };

/** What a command run by `host.exec` gave back (`code` 127 when the command is not found). */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** It ran past its timeout and was stopped. */
  timedOut: boolean;
}

/** A card and its live status: its run's status when it has a readable run, else its card file's. */
export interface CardStatus {
  id: string;
  title: string;
  status: string;
}

export interface PackageHost {
  readonly apiVersion: number;
  /** The project the package runs for. */
  readonly project: { readonly root: string; readonly name: string };
  /** The package's own settings (`packages.<name>` in mergewright.yaml), already checked against the manifest's `config` schema; {} when none. */
  readonly config: Record<string, unknown>;
  /**
   * This machine's folder for the package (`.mergewright/local/packages/<name>/`): never committed or
   * file-synced, for caches and per-machine state. It may not exist yet; create it before writing.
   */
  readonly localDir: string;
  /** One line to standard error, prefixed with the package's name. Never log a secret value. */
  log(line: string): void;
  /** This machine's delivery queue (`mw queue`). A package may only use kinds `<name>` and `<name>:<anything>`. */
  readonly queue: {
    /** Queue an item for the package's deliverer of `kind`; returns the item's file. `lastError` says why it was not delivered now. */
    enqueue(kind: string, summary: string, payload: unknown, lastError?: string): string;
    /** Remove queued items of the package's own kinds that `match` accepts (a newer status supersedes an older one). */
    drop(match: (item: { kind: string; payload: unknown }) => boolean): number;
  };
  /** JSON over HTTP with a timeout; rejects with an `errors.HttpError` whose message never holds headers or the query string. */
  readonly http: { json(url: string, opts?: HttpOptions): Promise<unknown> };
  /** The runtime's own error classes, so the queue and the memory stores recognise what a package throws. */
  readonly errors: {
    HttpError: new (status: number, message: string, body?: string) => HttpErrorLike;
    /** Thrown by a deliverer that delivered part of a payload: only `remaining` stays queued. */
    PartialDelivery: new (message: string, remaining: unknown, summary?: string, counts?: DeliveryCounts) => Error;
    /** Thrown by a deliverer for an item that must not be retried: the item is removed, with this message. */
    Dropped: new (message: string) => Error;
    /** Thrown by `exec` when a queue flush's time budget stopped the command: an attempt, not the service failing. Rethrow it. */
    BudgetCut: new (message: string) => Error;
  };
  /**
   * Run a command without a shell (an argument list), from the project's root unless `cwd` says
   * otherwise, waiting for it (default timeout 30 000 ms), with `input` on its standard input. Inside a queue flush it gets at most what is
   * left of the flush's budget, and throws `errors.BudgetCut` when that budget stopped it.
   */
  exec(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; input?: string }): ExecResult;
  /** The absolute path of an executable on PATH, or undefined. */
  which(cmd: string): string | undefined;
  /** This machine's name (`MW_HOST`, else the host name), as the runtime names it in notes and the lease. */
  readonly machine: string;
  /** Every card of the project with its live status, in the project's card order. */
  cards(): CardStatus[];
  /** A file of the project (path relative to its root), or undefined when there is none. Refuses paths outside the project. */
  readFile(rel: string): string | undefined;
  /** Files under a folder of the project (relative paths, sorted), optionally only those ending in `suffix`. */
  listFiles(rel: string, suffix?: string): string[];
  /** The value of an environment variable the manifest declares under `secrets` or `env`; undefined for any other. */
  env(name: string): string | undefined;
  /**
   * The runtime's YAML library: `parse`, `stringify` (with the library's options), and for edits that
   * keep comments and layout `parseDocument` (a yaml Document) and `isMap` (is this node a map).
   */
  readonly yaml: {
    parse(text: string): unknown;
    stringify(value: unknown, options?: object): string;
    parseDocument(text: string): unknown;
    isMap(node: unknown): boolean;
  };
  /** How to start this runtime (`mw`): the executable and the arguments before mw's own. */
  readonly selfCommand: { readonly command: string; readonly args: readonly string[] };
  /** The SSH agent socket a process of this user can use (`SSH_AUTH_SOCK`, else a usual socket found), or undefined. */
  sshAgent(): string | undefined;
  /**
   * Which process instance a pid names (pids are reused): `identity` gives its start time where
   * `/proc` exists, and `alive` is false when no process has that pid or its start time differs.
   */
  readonly process: {
    identity(pid: number): { pid: number; started?: string };
    alive(id: { pid: number; started?: string }): boolean;
  };
  /**
   * For a harness: run an agent CLI the way the built-in harnesses do, and turn its run into a result.
   * The runtime keeps its protections here: the hard timeout (`req.limits.minutes`, the whole process
   * group stopped), the abort signal, the output kept in memory capped and the full output streamed,
   * redacted, to private files in the run folder, and the shared table of transient and quota failures.
   */
  readonly agent: AgentHelpers;
  /** `text` with the values of the declared secrets, and anything shaped like a credential, replaced by `[redacted]`. */
  redact(text: string): string;
  /** The stable id of a lesson in this project (SHA-256 of project, topic and title), shared by every memory store. */
  lessonId(lesson: Pick<LessonRecord, "topic" | "title">): string;
  /** The project's documentation (`docs.paths` minus `docs.exclude`), read from git, never from the working tree. */
  readonly docs: {
    readonly paths: readonly string[];
    readonly exclude: readonly string[];
    /** The tracked documentation files, sorted as git lists them. */
    files(): string[];
    /** The commit HEAD names now. */
    head(): string;
    /**
     * A documentation file as a blob of `commit`. A path that is not a plain path under `docs.paths`,
     * a symbolic link, a submodule, a folder and a binary file are `skipped`, with a sentence saying why.
     */
    blob(commit: string, rel: string): DocBlob;
  };
}

// ── What a package may provide ──────────────────────────────────────────────────────────────

/** Delivers one queued item; throws to keep it queued (or `errors.PartialDelivery` / `errors.Dropped`). */
export type Deliverer = (payload: unknown, ctx: DeliverContext) => Promise<DeliveryCounts | void>;

/** One open conversation with a memory store, for one batch of records. */
export interface MemorySession {
  /** Does the store already hold this record with this text? */
  present(lesson: LessonRecord): Promise<boolean>;
  store(lesson: LessonRecord): Promise<unknown>;
}

/**
 * A semantic memory store. The runtime keeps the queue semantics: lessons of the reflect phase are queued
 * (kind = the package's name) and delivered one record at a time; `mw memory add` and `mw memory push`
 * store directly and queue what the store could not take. An `errors.HttpError` with a 4xx status (not
 * 408 or 429) means the store refused the record: it is counted as failed, not queued.
 */
export interface MemoryStore {
  /** Where the records go, for messages, e.g. "mem0 (namespace 'demo')". */
  label: string;
  open(): MemorySession;
  /** `mw memory prune --service <name> --match TEXT`: the records whose text contains `match`, deleted unless `dryRun`. */
  prune?(match: string, opts: { dryRun: boolean }): Promise<{ id: string; text: string }[]>;
}

/** `mw <name> ...`: `args._[0]` is the command's name; returns the exit code. */
export type PackageCommand = (args: { _: string[]; flags: Record<string, string | boolean | string[]> }, out: (line?: string) => void) => number | Promise<number>;

/** An MCP tool (`mw mcp serve`). Its name must start with `mw_`. */
export interface PackageTool {
  name: string;
  description: string;
  /** JSON Schema (type object) the arguments are checked against before the call. */
  inputSchema: object;
  /** Changes something: refused inside a card run. */
  write?: boolean;
  /** Returns text, or a value sent as JSON text. Throw an Error with a plain message for the caller. */
  handler(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): unknown | Promise<unknown>;
}

/** A health check `mw doctor` runs: one line, `ok` false when the service does not answer. */
export interface PackageCheck {
  name: string;
  run(): Promise<{ ok: boolean; detail: string }>;
}

/** What `host.agent` gives a harness (see PackageHost.agent). */
export interface AgentHelpers {
  /**
   * Run `cmd args` in `req.cwd` with the runtime's minimal environment plus `req.env` and `env`, `stdin`
   * on its standard input; its output goes to `<runDir>/<label>.<name>.stdout|stderr`. Never throws.
   */
  run(o: { name: string; cmd: string; args: string[]; req: HarnessRequest; env?: Record<string, string>; stdin?: string }): Promise<CliRun>;
  /** Write `<runDir>/<label>.<suffix>` (private, redacted with `req.secrets`); returns its path. */
  saveText(req: HarnessRequest, suffix: string, content: string): string;
  /** The result of a run that was aborted or never started (CLI missing, spawn failed), else undefined. */
  failedRun(name: string, r: CliRun): HarnessResult | undefined;
  /** The result of a run that timed out, keeping `text` (what it said so far). */
  timeoutResult(name: string, r: CliRun, minutes: number, text?: string): HarnessResult;
  /** The result of a non-zero exit, marked transient or quota through the shared table. */
  exitFailure(name: string, r: CliRun, extra?: Partial<HarnessResult>): HarnessResult;
}

/**
 * A harness a role can name in `runs:`. Advisory only (a role on it cannot have `mode: write`). The
 * runtime gives it no MCP servers (`req.mcp` is undefined: `mw check` warns about servers offered to
 * its roles), counts it as a paid harness for the usage guard, and turns a thrown error into a failed
 * result classified by the shared table.
 */
export interface PackageHarness {
  run(req: HarnessRequest): Promise<HarnessResult>;
}

export interface PackageExports {
  /** Handlers of queued items, by kind (`<name>` or `<name>:<anything>`). */
  deliverers?: Record<string, Deliverer>;
  /** Extra hits for the prompt's `{{memory.recall}}`, as `title: text` lines. */
  recall?(query: string, limit: number): Promise<string[]>;
  /** Extra hits for `mw memory search` and `mw docs search` (and their MCP tools), labelled with the package's name. */
  search?(query: string, limit: number): Promise<string[]>;
  /** Hits for `mw docs search` and `mw_docs_search` instead of `search` (`text`: plain text search instead of search by meaning). */
  searchDocs?(query: string, limit: number, opts: { text: boolean }): Promise<string[]>;
  remember?: MemoryStore;
  /** Mirror changed and deleted documentation files, read as blobs of `commit`. */
  docsSync?(changed: string[], deleted: string[], commit: string): Promise<"none" | "sent" | "queued" | "failed" | void>;
  /** Reflect a card's status on a board; may return a one-line note the run records. */
  mirrorCard?(cardId: string, title: string, status: string): Promise<string | void>;
  /** Bring an outside view level with every card (`mw work` calls it before taking cards and after finishing, `when` says which); may return one line for `mw work` to print. */
  reconcile?(when: string): Promise<string | void>;
  /** Harnesses by id; each id must be listed under `harnesses` in the manifest. */
  harness?: Record<string, PackageHarness>;
  commands?: Record<string, PackageCommand>;
  tools?: PackageTool[];
  checks?: PackageCheck[];
}

/** The entry module. */
export interface PackageModule {
  activate(host: PackageHost): PackageExports | Promise<PackageExports>;
}

// ── The manifest (mergewright-package.yaml) ─────────────────────────────────────────────────

export type ExportKind = keyof PackageExports;

export interface PackageManifest {
  name: string;
  version: string;
  description: string;
  apiVersion: number;
  entry: string;
  exports?: ExportKind[];
  harnesses?: string[];
  config?: object;
  secrets?: (string | { config: string; default: string })[];
  env?: string[];
}
