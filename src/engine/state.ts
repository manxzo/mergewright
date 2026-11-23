// Run state on disk: .mergewright/runs/<CARD>/ holds state.json, the artifacts, the audit trail of
// prompts and replies and the gate logs; it is shared between the machines. The run lock is this
// machine's own: .mergewright/local/locks/<CARD>.lock. See docs/design/engine.md section 1.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hostName } from "../hub.ts";
import type { OutputKind } from "../model/role.ts";
import type { Project } from "../project.ts";
import { lockAlive, lockHolder, locksDir, REPO_LOCK, withGuardSync, type LockInfo } from "./registry.ts";
import { processIdentity } from "./procid.ts";
import { narrowTree, writePrivate } from "./private.ts";
import { redactText } from "./redact.ts";
import { MwError, readIfExists, readJson } from "../util.ts";
import type { RunState } from "./types.ts";

/** Artifact kinds stored as `<kind>.json` in the run directory. */
export type ArtifactKind = Exclude<OutputKind, "text"> | "gate";

export function runDir(project: Project, cardId: string): string {
  return path.join(project.workDir, "runs", cardId);
}

/**
 * REQ-engine-005: make a run's folder private before the runtime writes into it: create it 0700, and
 * narrow what an earlier runtime left with wider modes (folders to 0700, files to 0600), whatever the
 * umask. Called by the engine once it holds the run's lock and the lease. Throws.
 */
export function privateRunDir(dir: string): void {
  narrowTree(dir);
}

export function worktreeDir(project: Project, cardId: string): string {
  return path.join(project.workDir, "worktrees", cardId);
}

export function branchName(cardId: string): string {
  return `card/${cardId}`;
}

/**
 * The run state as last saved. It is trusted as written by the runtime, which holds only while workers
 * cannot write it: see the limitation noted at `readRunState` in run.ts.
 */
export function loadState(dir: string): RunState | undefined {
  return readJson<RunState>(path.join(dir, "state.json"));
}

export function saveState(dir: string, state: RunState): void {
  state.updated = new Date().toISOString();
  writePrivate(path.join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n"); // 0600 (REQ-engine-005)
}

export function newState(cardId: string, flow: string): RunState {
  const now = new Date().toISOString();
  return {
    card: cardId, flow, phase: 0, round: 0, status: "running", approvals: [],
    host: hostName(), started: now, updated: now, history: [], warnings: [],
  };
}

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["brief", "handoff", "findings", "adjudication", "reflection", "gate"];

/** Artifacts by content: `<runDir>/artifacts/<kind>-<sha256>.json`, written once and never changed. */
export const ARTIFACT_DIR = "artifacts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function artifactText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function hashedFile(dir: string, kind: ArtifactKind, sha: string): string {
  return path.join(dir, ARTIFACT_DIR, `${kind}-${sha}.json`);
}

/**
 * The run's artifacts as the runtime validated and wrote them. Within one process every decision reads
 * the copy held here, never the file: an agent that rewrites `brief.json` changes nothing. Each write
 * stores the content under its SHA-256 in `artifacts/` and records that hash in `state.artifacts`, so a
 * later process reads exactly what the runtime wrote.
 */
export interface ArtifactStore {
  get<T>(kind: ArtifactKind): T | undefined;
  has(kind: ArtifactKind): boolean;
  put(kind: ArtifactKind, value: unknown): void;
}

/**
 * `save` persists the state. A write is three steps: the hash-named file, then the state naming its
 * hash (that one atomic write decides), then the plain `<kind>.json` copy for people to read. A crash
 * after the first step leaves a file nothing refers to, and the phase runs again; a crash after the
 * second leaves an old plain copy, which the next process rewrites. Every file is 0600 (REQ-engine-005).
 */
export function artifactStore(dir: string, state: RunState, save: () => void, initial: Map<ArtifactKind, unknown> = new Map()): ArtifactStore {
  const held = new Map(initial);
  return {
    get<T>(kind: ArtifactKind) { return held.get(kind) as T | undefined; },
    has(kind) { return held.has(kind); },
    put(kind, value) {
      const text = artifactText(value);
      const sha = sha256(text);
      writePrivate(hashedFile(dir, kind, sha), text);
      (state.artifacts ??= {})[kind] = sha;
      held.set(kind, JSON.parse(text) as unknown);
      save();
      writePrivate(path.join(dir, `${kind}.json`), text);
    },
  };
}

export interface VerifiedArtifacts {
  /** Files that do not match the state (changed, added or removed outside the runtime). */
  bad: string[];
  /** The parsed artifacts; complete only when `bad` is empty. */
  values: Map<ArtifactKind, unknown>;
  /** Plain copies that differ from the verified content, with that content (see `rewritePlainCopies`). */
  stale: { kind: ArtifactKind; text: string }[];
}

/**
 * Check the artifacts a previous process wrote against the hashes recorded in state. Each is read from
 * its hash-named file; a missing or changed one is reported. Runs written before artifacts were stored
 * by hash have only the plain `<kind>.json`: when its hash-named file is missing, the plain copy is
 * accepted if it matches the recorded hash. A plain copy whose kind has no recorded hash is reported.
 */
export function verifyArtifacts(dir: string, state: RunState): VerifiedArtifacts {
  const out: VerifiedArtifacts = { bad: [], values: new Map(), stale: [] };
  for (const kind of ARTIFACT_KINDS) {
    const plain = readIfExists(path.join(dir, `${kind}.json`));
    const want = state.artifacts?.[kind];
    if (want === undefined) {
      if (plain !== undefined) out.bad.push(`${kind}.json`);
      continue;
    }
    let text = readIfExists(hashedFile(dir, kind, want));
    if (text !== undefined) {
      if (sha256(text) !== want) { out.bad.push(`${ARTIFACT_DIR}/${kind}-${want}.json`); continue; }
      if (plain !== text) out.stale.push({ kind, text });
    } else if (plain === undefined) {
      out.bad.push(`${kind}.json (deleted)`);
      continue;
    } else if (sha256(plain) !== want) {
      out.bad.push(`${kind}.json`);
      continue;
    } else text = plain;
    try {
      out.values.set(kind, JSON.parse(text) as unknown);
    } catch {
      out.bad.push(`${kind}.json`);
    }
  }
  return out;
}

/** Put back the plain copies `verifyArtifacts` found out of date (call only while holding the lease). */
export function rewritePlainCopies(dir: string, stale: VerifiedArtifacts["stale"]): void {
  for (const { kind, text } of stale) writePrivate(path.join(dir, `${kind}.json`), text);
}

/**
 * Save what was sent to an agent and what came back, for audit: private (0600, REQ-engine-005) and with
 * `secrets` redacted (REQ-engine-006).
 */
export function saveExchange(dir: string, label: string, prompt: string, output?: string, secrets: readonly string[] = []): void {
  writePrivate(path.join(dir, "phases", `${label}.prompt.md`), redactText(prompt, secrets));
  if (output !== undefined) writePrivate(path.join(dir, "phases", `${label}.output.txt`), redactText(output, secrets));
}

/**
 * This machine's lock on a card's run: `.mergewright/local/locks/<CARD>.lock`. It is never file-synced,
 * so it only ever names a process of this machine. (Runs started by an older runtime kept a `lock`
 * file in the shared run directory; it is ignored and left where it is.) The locks folder is this
 * machine's registry of active runs (src/engine/registry.ts).
 */
export function lockFile(project: Project, cardId: string): string {
  return path.join(locksDir(project), `${cardId}.lock`);
}

export { lockHolder, locksDir };

/** Fail when another live process on this machine is running the card. Writes nothing. */
export function assertUnlocked(file: string, cardId: string): void {
  const holder = lockHolder(file);
  if (holder) {
    throw new MwError("run/locked", `${cardId} is already being run by process ${holder.pid} on this machine (since ${holder.started}); wait for it to finish, or stop that process first`);
  }
}

/** Whether a lock file's holder may still be running: a live process (this process included). */
function lockLive(raw: string | undefined): LockInfo | undefined {
  let info: LockInfo | undefined;
  try {
    info = raw ? (JSON.parse(raw) as LockInfo) : undefined;
  } catch {
    return undefined; // unreadable: stale
  }
  if (!info || typeof info.pid !== "number") return undefined;
  return lockAlive(info) ? info : undefined;
}

/**
 * The live process (this process included) that holds a lock file, or undefined when the lock is
 * missing, unreadable or names a process that is gone (the same test `acquireLock` applies). Reads only.
 */
export function lockDriver(file: string): LockInfo | undefined {
  try {
    return lockLive(readIfExists(file));
  } catch {
    return undefined; // unreadable: stale, as for acquireLock
  }
}

/** Test-only seams. Nothing in the runtime sets them. */
export const lockTestHooks: {
  /** The lock has just been published under its name, before `acquireLock` returns. */
  afterPublish?: (file: string) => void;
} = {};

/**
 * Take the run's lock. The lock is written completely under a temporary name
 * first and then published with `link()`, which fails when the name exists: no process ever sees a
 * lock that is not yet written, and of two processes starting at once exactly one gets it. A lock left
 * by a dead process (or unreadable) is replaced. All of it happens under the registry's guard
 * (src/engine/registry.ts), so two processes cannot both judge the same lock stale and both win, and an
 * automatic release of the lease never runs between the check of the registry and a new run's lock.
 * Returns the function that releases it. The lock lives in this machine's own folder, so releasing it
 * never touches anything the other machine sees, even after the lease was lost.
 */
export function acquireLock(file: string, cardId: string): () => void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const self = processIdentity(process.pid);
  const mine: LockInfo = { pid: process.pid, host: hostName(), started: new Date().toISOString(), ...(self.started ? { procStart: self.started } : {}) };
  const locked = (h: LockInfo) => new MwError("run/locked", `${cardId} is already being run by process ${h.pid} on this machine (since ${h.started}); wait for it to finish, or stop that process first`);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(mine) + "\n", { flag: "wx", mode: 0o644 });
  try {
    withGuardSync(dir, "lock", () => {
      for (let attempt = 0; ; attempt++) {
        try {
          fs.linkSync(tmp, file);
          return;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        const holder = lockLive(readIfExists(file));
        if (holder) throw locked(holder);
        if (attempt > 0) throw new MwError("run/locked", `${cardId}: another process took the run lock at the same moment; wait for it to finish, then run the card again`);
        // Stale (its process is gone, or it cannot be read): only a process holding the guard removes it.
        fs.rmSync(file, { force: true });
      }
    });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  lockTestHooks.afterPublish?.(file);
  return () => {
    try {
      const cur = readJson<LockInfo>(file);
      if (cur?.pid === process.pid && cur.started === mine.started) fs.rmSync(file, { force: true });
    } catch {
      // nothing to release
    }
  };
}

/**
 * REQ-engine-012: the cards whose run on this machine is inside its merge phase now. A run counts when
 * a live process (this one included) holds its run lock and its state says `running` at a phase whose
 * action is `merge`: from entering that phase until the run ends or blocks (the phase index moves on,
 * or the status changes; a run waiting at the merge's stop point has not entered it). A run state that
 * cannot be read while its lock is held counts too, so the answer errs on the side of waiting. The one
 * check every queue flush of `mw work` and `mw queue flush` waits on; the lease is never asked.
 */
export function mergingHere(project: Project): string[] {
  const dir = locksDir(project);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || !name.endsWith(".lock") || name === REPO_LOCK) continue;
    if (!lockLive(readIfExists(path.join(dir, name)))) continue;
    const card = name.slice(0, -".lock".length);
    let state: RunState | undefined;
    try {
      state = loadState(runDir(project, card));
    } catch {
      out.push(card);
      continue;
    }
    if (state?.status !== "running") continue;
    if (project.flows().get(state.flow)?.phases[state.phase]?.action === "merge") out.push(card);
  }
  return out;
}
