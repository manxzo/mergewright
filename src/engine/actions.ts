// Phase actions: side effects only the runtime performs (merge, memory, docs, notifications).
import fs from "node:fs";
import path from "node:path";
import { isProtectedGlob, newCard, scopeWithDocs, withCardStatus } from "../cards.ts";
import type { Risk } from "../expr.ts";
import { applyReflection, type Reflection } from "../memory.ts";
import type { Card } from "../model/card.ts";
import type { Flow, Outcome, Phase } from "../model/flow.ts";
import { Project } from "../project.ts";
import { NO_MERGE_COMMIT } from "../integrations/forge.ts";
import { docBlob } from "../integrations/docs.ts";
import { git, isSyncTemp, matchesAny, MwError, readJson, withoutSyncTemp, writeAtomic, writeJson } from "../util.ts";
import type { Adjudication, Brief } from "./context.ts";
import type { GateRun } from "./gate.ts";
import { branchHead, buildSquash, changedFiles, commitFiles, deleteBranch, dirtyFiles, head, isAncestor, mergeCardText, moveBase, removeWorktree, runtimeCardEdit, squashTree, treeOf, verifiedWorktree, withTempWorktree } from "./gitops.ts";
import { describeViolations, scopeViolations, type ScopeRules } from "./scope.ts";
import type { ArtifactStore } from "./state.ts";
import type { DocsSyncOutcome, Hub, Integrations, RunOptions, RunState } from "./types.ts";

/** Everything a running card needs, shared by the loop and the actions. */
export interface Engine {
  project: Project;
  card: Card;
  flow: Flow;
  state: RunState;
  runDir: string;
  base: string;
  branch: string;
  hub: Hub;
  integrations: Integrations;
  opts: RunOptions;
  /** The live status last sent to `integrations.mirrorCard`. */
  mirrored?: string;
  /** Persist `state` (the loop's save). */
  save: () => void;
  /** Fires when the lease heartbeat fails during a phase, or the owner stops the run (see `stop`). */
  signal?: AbortSignal;
  /** The owner's stop signal for the whole run (EngineDeps.stop in run.ts). */
  stop?: AbortSignal;
  /** The run's artifacts, held in memory once validated (decisions never re-read them from disk). */
  artifacts: ArtifactStore;
}

/** The scope rules of a card: its own scope and the brief's (an empty brief scope inherits). */
export function scopeRules(e: Engine): ScopeRules {
  return { cardScope: e.card.scope, briefScope: e.artifacts.get<Brief>("brief")?.scope ?? [], protected: e.project.config.protected, allowProtected: e.card.allowProtected };
}

/**
 * Paths the card's branch changed (since it left the base) that it may not change. The card file is
 * checked like any other path, except when its only change is the runtime's own `status: done` edit.
 */
export function branchViolations(e: Engine, cwd: string): string | undefined {
  const changed = changedFiles(cwd, e.base).filter((f) => !(f === e.card.file && runtimeCardEdit(cwd, e.base, e.card.file)));
  const rules = scopeRules(e);
  const v = scopeViolations(changed, rules);
  return v.length ? describeViolations(v, rules) : undefined;
}

/** The lease was lost: the phase's result must be discarded, with no commit and no push. */
export class LeaseLost extends MwError {
  constructor(message: string) {
    super("lease/lost", message);
  }
}

/**
 * A phase failure that ends the run blocked whatever the phase's `on` routes say (REQ-engine-010): the
 * run loop records it as the phase's `block` outcome and ends through the normal blocked-run path, which
 * releases the lock and the lease. Used where routing onward would leave the run claiming success.
 */
export class PhaseBlocked extends MwError {}

/** Stop before a side effect when the lease heartbeat has failed. */
export function assertLease(e: Engine): void {
  if (e.signal?.aborted) throw new LeaseLost("the lease heartbeat failed during the phase");
}

/** Every push refreshes the lease first; a failed refresh means the lease is lost. */
export async function pushing(e: Engine, push: () => Promise<void>): Promise<void> {
  assertLease(e);
  try {
    await e.hub.refresh();
  } catch (err) {
    throw new LeaseLost((err as Error).message);
  }
  await push();
}

export interface ActionResult {
  outcome: Outcome;
  detail: string;
  /**
   * REQ-gate-004: the failure goes to the flow's remediation phase whatever the phase's own `on` says
   * (the merge's re-gate failed on the new base: the worker's change must be rebuilt on it).
   */
  remediate?: boolean;
}

/**
 * What the merge evidence says about the head about to be merged: `refuse` blocks the merge;
 * `regate` (REQ-gate-004) names the gate to run again on the squash tree, because the
 * recorded gate result ran against another base commit than `onto`, or records none.
 */
export interface Evidence {
  refuse?: string;
  regate?: string;
}

/** Runs gate `gate` in `cwd` exactly as the gate phase does (REQ-gate-004). */
export type Regate = (gate: string, cwd: string) => Promise<GateRun>;

/** Integrations must not throw, but a run never fails because one did. */
export async function safely(e: Engine, what: string, f: () => Promise<unknown>): Promise<void> {
  try {
    await f();
  } catch (err) {
    e.state.warnings.push(`${what} failed: ${(err as Error).message}`);
  }
}

function mergeBody(e: Engine): string {
  const brief = e.artifacts.get<Brief>("brief");
  const roles = e.project.roles();
  const reviewers = [...new Set(e.state.history.flatMap((h) => h.roles).filter((r) => roles.get(r)?.output === "findings"))];
  const lines = [];
  if (brief?.summary) lines.push(brief.summary.trim(), "");
  lines.push(`Reviewers: ${reviewers.join(", ") || "none"}`, `Rounds: ${e.state.round + 1}`, `Card: ${e.card.id} (flow ${e.flow.id})`);
  return lines.join("\n");
}

/**
 * Why the recorded `pendingMerge` cannot be accepted as the card's merge, or undefined when it can.
 * Its tree must be what `git merge-tree --write-tree <its parent>
 * <pendingMergeHead>` produces, its parent must be on the base, and the merge evidence must hold for
 * `pendingMergeHead`. Trees are compared, not commits, so a forge's own commit passes as well.
 * A forge commit whose check has not passed yet is checked here too (`forgeMismatch`), so
 * every caller, `mw run --from` as well as a resumed merge, gets it; a failed check is the problem.
 */
export function pendingMergeProblem(e: Engine, evidence?: (head: string) => string | undefined): string | undefined {
  const why = recordedMergeProblem(e, evidence);
  if (why) return why;
  const commit = e.state.pendingMerge!;
  const expected = uncheckedForgeMerge(e, commit);
  return expected && forgeMismatch(e, expected, commit)?.detail;
}

/** `pendingMergeProblem` without the forge check. */
function recordedMergeProblem(e: Engine, evidence?: (head: string) => string | undefined): string | undefined {
  const root = e.project.root;
  const commit = e.state.pendingMerge;
  if (!commit) return "no merge is recorded";
  const tip = e.state.pendingMergeHead;
  if (!tip) return "the branch head it was built from is not recorded";
  const rev = (r: string) => git(root, ["rev-parse", "--verify", "--quiet", r], { allowFail: true }).stdout.trim();
  const parent = rev(`${commit}^{commit}^`);
  if (!parent) return `${commit.slice(0, 10)} has no parent commit`;
  if (!isAncestor(root, parent, `refs/heads/${e.base}`)) return `its parent ${parent.slice(0, 10)} is not on ${e.base}`;
  if (!rev(`${tip}^{commit}`)) return `the branch head it was built from (${tip.slice(0, 10)}) does not exist here`;
  // REQ-engine-010: built as the squash was, so a resolved add/add on the card file is the same tree.
  const want = squashTree(root, parent, tip, e.card.file).tree ?? "";
  if (!want) return `the card's work (${tip.slice(0, 10)}) does not merge cleanly onto ${parent.slice(0, 10)}`;
  if (rev(`${commit}^{tree}`) !== want) return `its content is not the card's work (${tip.slice(0, 10)}) merged onto ${parent.slice(0, 10)}`;
  return evidence?.(tip);
}

/** The block reason for a recorded merge that does not match the card's work. */
export function pendingMergeRefusal(e: Engine, why: string): string {
  const at = e.flow.phases.find((p) => p.action === "merge")?.id ?? "merge";
  return `the recorded merge does not match the card's work: ${e.state.pendingMerge?.slice(0, 10) ?? "(none)"} is on ${e.base}, but ${why}. Nothing was cleaned up: branch ${e.branch} and its worktree are kept. Check ${e.base}; to set the recorded merge aside and merge the card's checked work afresh, run 'mw run ${e.card.id} --from ${at}'.`;
}

/**
 * `evidence` is asked about the branch head about to be merged and the base
 * commit the squash is built on, after the worktree and scope checks; a reason it returns blocks the
 * merge. When it names a gate to run again (REQ-gate-004), `regate` runs it on the squash commit before
 * the base moves.
 */
export async function merge(e: Engine, evidence?: (head: string, onto?: string) => Evidence, regate?: Regate): Promise<ActionResult> {
  const { project, card, state } = e;
  const root = project.root;
  const title = `${card.id}: ${card.title}`;
  if (state.merged) {
    if (state.cleanupPending) return cleanUp(e, `finished the clean-up after the merge as ${state.merged.slice(0, 10)}`);
    return { outcome: "ok", detail: `already merged as ${state.merged.slice(0, 10)}` };
  }
  if (!e.flow.worktree) {
    // No branch: the work is already on the base branch; only the card's status remains. The same
    // merge-evidence rule holds: the base head must be what the gate and review judged.
    const missing = evidence?.(head(root)).refuse;
    if (missing) return { outcome: "block", detail: missing };
    markCardDone(e, root, title);
    state.merged = head(root);
    e.save();
    await pushing(e, () => e.hub.pushBase());
    return { outcome: "ok", detail: `marked done on ${e.base} as ${state.merged.slice(0, 10)}` };
  }

  const resumed = !!state.pendingMerge && isAncestor(root, state.pendingMerge, `refs/heads/${e.base}`);
  if (resumed) {
    // A recorded merge already on the base is finished only when it is the card's
    // checked work; the state file alone is not trusted to say so.
    const why = recordedMergeProblem(e, evidence && ((h) => evidence(h).refuse));
    if (why) return { outcome: "block", detail: pendingMergeRefusal(e, why) };
    // A forge commit recorded before its check ran is checked now, against the expectation
    // recorded with it; until that check passes the card is not done.
    const expected = uncheckedForgeMerge(e, state.pendingMerge!);
    if (expected) {
      const mismatch = forgeMismatch(e, expected, state.pendingMerge!);
      if (mismatch) return setAside(e, mismatch);
    }
  } else {
    // A forge commit that failed its check is on the base; no later merge goes past it.
    const refused = failedForgeMerge(e);
    if (refused) return refused;
    const v = verifiedWorktree(project, card.id);
    if (!v.ok) {
      if (!fs.existsSync(path.join(project.workDir, "worktrees", card.id))) {
        return { outcome: "block", detail: `the card's worktree is missing, so there is nothing to merge; run 'mw run ${card.id}' again to recreate it from branch ${e.branch}` };
      }
      return { outcome: "block", detail: `${v.why}. Nothing was merged; repair or remove it by hand, then run 'mw run ${card.id}' again.` };
    }
    const wt = v.path;
    // Only what was checked is merged: nothing uncommitted, and the whole branch inside the scope.
    const dirty = dirtyFiles(wt);
    if (dirty.length) {
      return { outcome: "fail", detail: `the worktree has changes that were never committed or checked: ${dirty.join(", ")}. Remove them, or make them part of the work so they are checked, then merge again.` };
    }
    const outside = branchViolations(e, wt);
    if (outside) return { outcome: "fail", detail: outside };
    // Sync temporary and conflict files never reach the base branch.
    const synced = changedFiles(wt, e.base).filter(isSyncTemp);
    if (synced.length) {
      return { outcome: "fail", detail: `the branch commits sync temporary or conflict files, which are never merged: ${synced.join(", ")}. Remove them from the branch ('git rm --cached' and commit), then merge again.` };
    }
    const onto = branchHead(root, e.base);
    const checked = evidence?.(head(wt), onto);
    if (checked?.refuse) return { outcome: "block", detail: checked.refuse };
    // An earlier attempt that asked the forge to merge this same branch head left its
    // expectation behind. The forge may have merged already, so the base may already hold the card's
    // squash: that expectation is used, not a re-gate on the base as it is now.
    const saved = savedForgeCheck(e, head(wt));
    // REQ-gate-004: re-gate the branch merged onto the moved base before the runtime touches the branch,
    // so a failed re-gate leaves the base, the main checkout and the card branch as they were.
    // The base a forge's squash must sit on is the one the re-gate built on, when it ran.
    let gatedBase = onto;
    // The tree that was gated, the branch head judged above squashed onto that base; the
    // forge expectation may differ from it only in the card file.
    const tip = head(wt);
    let gatedTree: string | null = null;
    if (!saved && checked?.regate && regate) {
      const r = await regateSquash(e, checked.regate, regate, tip, title);
      if (r.refused) return r.refused;
      if (r.base) gatedBase = r.base;
      if (r.tree) gatedTree = r.tree;
    }
    if (!saved && !gatedTree) gatedTree = mergedTree(root, gatedBase, tip);
    // The runtime's own change: the card's status line, and nothing else, in a commit of its own.
    markCardDone(e, wt, `${card.id}: mark done`);
    const body = mergeBody(e);
    const pushed = head(wt);
    // The expectation is on disk before the forge is asked to merge, so a merge whose answer
    // is lost (a crash, a dropped connection) is still checked against it when the card runs again.
    const expected = saved ?? forgeCheck(e, gatedBase, pushed, gatedTree);
    if (saved) {
      if (!saved.base || !saved.tree) return forgeUnchecked(e, saved, `the base and tree recorded in ${FORGE_CHECK} before the forge was asked to merge cannot be read, so no merge the forge reports can be checked; delete that file only once the pull request is known not to be merged`, pushed);
    } else {
      writeJson(path.join(e.runDir, FORGE_CHECK), { commit: null, expected, actual: { base: null, tree: null }, ok: false, problem: "the forge merge has not been requested or checked yet", pushedHead: pushed } satisfies ForgeCheck);
    }
    let commit: string | undefined;
    try {
      await pushing(e, () => e.hub.pushBranch(e.branch));
      // The phase's signal fires when the lease is lost: the forge stops before recording or merging.
      commit = await e.integrations.forgeMerge({ card: card.id, branch: e.branch, base: e.base, title, body, signal: e.signal });
    } catch (err) {
      // Merged, but with no commit to check: blocked for the owner, never a success.
      if (err instanceof MwError && err.code === NO_MERGE_COMMIT) return forgeUnchecked(e, expected, err.message, pushed);
      if (err instanceof MwError && err.code.startsWith("merge/")) return { outcome: "fail", detail: err.message };
      throw err;
    }
    if (commit === undefined) {
      // No forge: a local merge keeps no forge record, and one left by an interrupted attempt is dropped
      // and the merge starts over, re-gate included.
      fs.rmSync(path.join(e.runDir, FORGE_CHECK), { force: true });
      if (saved) return merge(e, evidence, regate);
    }
    if (commit !== undefined) {
      if (!commit) return forgeUnchecked(e, expected, "the forge reported the merge but returned no merge commit", pushed);
      // The expectation is on disk before the commit is recorded, so a run that stops before the check
      // below runs it on resume (not only the generic recorded-merge check).
      writeJson(path.join(e.runDir, FORGE_CHECK), { commit: null, expected, actual: { base: null, tree: null }, ok: false, problem: `the forge's commit ${commit.slice(0, 10)} has not been checked yet`, pushedHead: pushed } satisfies ForgeCheck);
      state.pendingMerge = commit;
      state.pendingMergeHead = head(wt);
      e.save();
      await e.hub.sync();
      // Nothing is cleaned up until the forge's commit is really on the local base branch.
      if (!isAncestor(root, commit, `refs/heads/${e.base}`)) {
        return { outcome: "block", detail: `the forge reported the merge as ${commit.slice(0, 10)}, but that commit is not on the local ${e.base} after syncing with the hub, so the branch and worktree were kept. Check that the forge and the hub are the same repository and bring ${e.base} up to date, then run 'mw run ${card.id}' again.` };
      }
      // The forge built its own squash; it must be the gated one, on the gated base.
      const mismatch = forgeMismatch(e, expected, commit);
      if (mismatch) return setAside(e, mismatch);
    } else {
      const squashed = head(wt); // the branch head the squash is built from (pushed above)
      const built = buildSquash(root, e.base, squashed, `${title}\n\n${body}\n`, e.card.file);
      if (!built.ok) return { outcome: "fail", detail: built.detail };
      if (onto && built.base !== onto) {
        // The lease keeps merges serial, so this means the base moved by hand while the merge ran.
        return { outcome: "fail", detail: `${e.base} moved from ${onto.slice(0, 10)} to ${built.base!.slice(0, 10)} while ${card.id} was being merged, so nothing was merged. Run 'mw run ${card.id}' again to merge onto the new base.` };
      }
      assertLease(e);
      state.pendingMerge = built.commit!;
      state.pendingMergeHead = squashed;
      e.save(); // before the base moves, so a crash after it is recognised on resume
      const moved = moveBase(root, e.base, built.commit!);
      if (!moved.ok) {
        state.pendingMerge = undefined;
        state.pendingMergeHead = undefined;
        e.save();
        return { outcome: "fail", detail: moved.detail };
      }
    }
  }
  const commit = state.pendingMerge!;
  state.merged = commit;
  state.pendingMerge = undefined;
  state.pendingMergeHead = undefined;
  state.cleanupPending = true;
  e.save(); // merged and clean-up pending together: a crash from here on resumes the clean-up
  return cleanUp(e, `${resumed ? "finished an interrupted merge: " : ""}merged into ${e.base} as ${commit.slice(0, 10)}`);
}

/**
 * The runtime's own change: the card's status set to done in checkout `cwd`, committed there as
 * `message` (when it changed). REQ-engine-010: a checkout without the card file takes it from the base
 * branch (`mergeCardText`); any other failure to read, write or commit it throws `PhaseBlocked`
 * (merge/card-file), which no route of the merge phase can pass, so the run ends blocked and releases
 * its lock and lease as every blocked run does.
 */
function markCardDone(e: Engine, cwd: string, message: string): void {
  const file = e.card.file;
  try {
    // writeAtomic creates the cards folder when the checkout has none.
    writeAtomic(path.join(cwd, file), withCardStatus(mergeCardText(cwd, file, e.base), "done"));
    assertLease(e);
    git(cwd, ["add", "--", file]);
    if (git(cwd, ["diff", "--cached", "--quiet", "--", file], { allowFail: true }).code !== 0) {
      git(cwd, ["commit", "--quiet", "--no-verify", "-m", message, "--", file]);
    }
  } catch (err) {
    if (err instanceof LeaseLost) throw err;
    const at = e.flow.phases.find((p) => p.action === "merge")?.id ?? "merge";
    throw new PhaseBlocked("merge/card-file", `${e.card.id} was not merged (merge/card-file): the card file ${path.join(cwd, file)} could not be read, written or committed with status done: ${(err as Error).message}. Nothing was merged. Repair or restore that file, then run 'mw run ${e.card.id} --from ${at}'.`);
  }
}

/**
 * REQ-gate-004: the gate result was recorded against another base commit than the current one. The
 * branch head `tip` is squashed onto the base (a commit no ref points to; the base does not move) and,
 * unless the squash tree is the branch's own tree, gate `gate` runs again on it in a temporary worktree
 * that is removed afterwards. The runtime's status commit is added after this, as after the gate phase.
 * Returns in `refused` why the merge must not happen, absent when it may: an ordinary failure
 * remediates ("rebuild on the new base", with the re-run's log); a required step missing or not run
 * blocks, as in the gate phase; a conflict is left to the merge's own squash, which reports it.
 * `base` is the base commit the squash was built on and judged against (absent when no
 * squash was built), which a forge's own squash must sit on; `tree` is that squash's tree.
 */
async function regateSquash(e: Engine, gate: string, regate: Regate, tip: string, title: string): Promise<{ refused?: ActionResult; base?: string; tree?: string }> {
  const root = e.project.root;
  const built = buildSquash(root, e.base, tip, `${title}\n\nre-gate on the new base\n`, e.card.file);
  if (!built.ok) return {};
  const base = built.base;
  const tree = treeOf(root, built.commit!);
  if (tree === treeOf(root, tip)) return { base, tree };
  const g = await withTempWorktree(e.project, e.card.id, built.commit!, (dir) => regate(gate, dir));
  assertLease(e);
  if (g.ok) return { base, tree };
  const what = `${e.base} moved to ${built.base!.slice(0, 10)} since the gate passed, and gate '${gate}' failed on ${e.branch} merged onto it (${built.commit!.slice(0, 10)}), so nothing was merged`;
  if (g.code) return { refused: { outcome: "block", detail: `${e.card.id} was not merged: ${what}.\n${g.detail}` } };
  return { refused: { outcome: "fail", remediate: true, detail: `rebuild on the new base: ${what}. Bring the change up to date with ${e.base} so the gate passes on it.\n${g.detail}` } };
}

/** The run's record of the forge check, `<runDir>/forge-check.json`. */
export const FORGE_CHECK = "forge-check.json";

/** A base commit and a tree; null where it is not known. */
export interface BaseAndTree {
  base: string | null;
  tree: string | null;
  /** Why the expected tree was set to null because it is not tied to the gated tree. */
  untied?: string;
}

/**
 * What a forge merge is checked against and what it produced. `expected` is the base commit
 * the re-gate (REQ-gate-004) built its squash on, or the one the merge evidence judged against when no
 * re-gate ran, and the tree of the branch head that
 * was pushed (the gated tree plus the runtime's status line) merged onto that base; `actual` is the
 * forge commit's first parent and tree.
 */
export interface ForgeCheck {
  commit: string | null;
  expected: BaseAndTree;
  actual: BaseAndTree;
  ok: boolean;
  /** Why the check failed; absent when it passed. */
  problem?: string;
  /** The branch head that was pushed for the forge to merge, which `expected` was built for. */
  pushedHead?: string;
}

/** The tree `git merge-tree --write-tree` builds for `tip` merged onto `onto`; null when it cannot. */
function mergedTree(root: string, onto: string, tip: string): string | null {
  if (!onto) return null;
  const mt = git(root, ["merge-tree", "--write-tree", "--no-messages", onto, tip], { allowFail: true });
  return (mt.code === 0 ? (mt.stdout.split("\n")[0] ?? "").trim() : "") || null;
}

/**
 * The expected half of a forge check: `onto` and the pushed branch head merged onto it. That
 * tree may differ from `gatedTree`, the tree that was gated, only in the card file (the runtime's status
 * line); otherwise, or when the gated tree is missing or unknown, the expected tree is null and the check
 * blocks, with the reason in `untied`.
 */
function forgeCheck(e: Engine, onto: string, pushed: string, gatedTree: string | null): BaseAndTree {
  if (!onto) return { base: null, tree: null };
  const root = e.project.root;
  const tree = mergedTree(root, onto, pushed);
  if (!tree) return { base: onto, tree: null };
  const known = gatedTree && git(root, ["rev-parse", "--verify", "--quiet", `${gatedTree}^{tree}`], { allowFail: true }).code === 0;
  if (!known) return { base: onto, tree: null, untied: `the gated tree ${short(gatedTree)} is not known, so the expected tree cannot be tied to it` };
  const diff = git(root, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", gatedTree, tree], { allowFail: true });
  if (diff.code !== 0) return { base: onto, tree: null, untied: `the expected tree ${short(tree)} could not be compared with the gated tree ${short(gatedTree)}` };
  const norm = (p: string) => path.posix.normalize(p.split(path.sep).join("/"));
  const cardFile = norm(e.card.file);
  const extra = diff.stdout.split("\0").filter(Boolean).map(norm).filter((p) => p !== cardFile);
  if (extra.length) return { base: onto, tree: null, untied: `the pushed branch differs from the gated tree ${short(gatedTree)} in more than the card file: ${extra.join(", ")}` };
  return { base: onto, tree };
}

const short = (sha: string | null) => (sha ? sha.slice(0, 10) : "(unknown)");
const untied = (expected: BaseAndTree) => (expected.untied ? ` (${expected.untied})` : "");
/** The `untied` reason of a recorded expectation, when it has one. */
const untiedOf = (v: unknown) => (typeof v === "string" && v ? { untied: v } : {});

/** Record the check in the run's merge evidence and, when it failed, in the run's warnings. */
function recordForgeCheck(e: Engine, check: ForgeCheck): void {
  writeJson(path.join(e.runDir, FORGE_CHECK), check);
  if (!check.ok) e.state.warnings.push(`forge merge check: ${check.problem}`);
  e.save();
}

/** The block for a forge merge that did not return a commit to check. */
function forgeUnchecked(e: Engine, expected: BaseAndTree, why: string, pushedHead: string): ActionResult {
  const actual: BaseAndTree = { base: null, tree: null };
  const problem = `${why}; expected base ${short(expected.base)} and tree ${short(expected.tree)}, actual base ${short(actual.base)} and tree ${short(actual.tree)}${untied(expected)}`;
  // Kept with the pushed head, so running the card again checks a merge the forge then names against it.
  recordForgeCheck(e, { commit: null, expected, actual, ok: false, problem, pushedHead });
  return { outcome: "block", detail: `${e.card.id} was not completed: ${problem}. Check the pull request and ${e.base} on the forge, then run 'mw run ${e.card.id}' again (a merge the forge then names is checked). Branch ${e.branch} and its worktree are kept.` };
}

/**
 * Compare the forge's commit (on the local base) with what was gated: its first parent must
 * be the expected base commit and its tree the expected tree. Records the check either way; returns the
 * block when they differ (or cannot be read), undefined when they match. The caller sets the recorded
 * merge aside on a mismatch (`setAside`, or `mw run --from`), so a later run cannot accept the forge's
 * commit as a finished merge.
 */
function forgeMismatch(e: Engine, expected: BaseAndTree, commit: string): ActionResult | undefined {
  const rev = (r: string) => git(e.project.root, ["rev-parse", "--verify", "--quiet", r], { allowFail: true }).stdout.trim() || null;
  const actual: BaseAndTree = { base: rev(`${commit}^{commit}^1`), tree: rev(`${commit}^{tree}`) };
  const ok = !!expected.base && !!expected.tree && actual.base === expected.base && actual.tree === expected.tree;
  if (ok) {
    recordForgeCheck(e, { commit, expected, actual, ok });
    return undefined;
  }
  const problem = `the forge merged ${e.branch} as ${commit.slice(0, 10)}, which is not the gated merge: expected base ${short(expected.base)} and tree ${short(expected.tree)}, actual base ${short(actual.base)} and tree ${short(actual.tree)}${untied(expected)}`;
  recordForgeCheck(e, { commit, expected, actual, ok, problem });
  return mismatchBlock(e, commit, problem);
}

function mismatchBlock(e: Engine, commit: string, problem: string): ActionResult {
  return { outcome: "block", detail: `${e.card.id} was not completed: ${problem}. The forge built its own squash on a base or with content the gate did not check, and it is already on ${e.base}. Check ${commit.slice(0, 10)} on ${e.base} (run the gate on it and revert it if it fails); the run is not finished, and branch ${e.branch} and its worktree are kept. Running the card again blocks again, so close the card by hand ('mw abort ${e.card.id}') once ${e.base} is checked.` };
}

/**
 * The block for a merge attempted after a forge commit failed its check and is on the base
 * (for instance after 'mw run --from', which sets the recorded merge aside), with the recorded problem;
 * undefined when the run's record names no such commit.
 */
function failedForgeMerge(e: Engine): ActionResult | undefined {
  const file = path.join(e.runDir, FORGE_CHECK);
  if (!fs.existsSync(file)) return undefined;
  let rec: Partial<ForgeCheck> | undefined;
  try {
    rec = readJson<Partial<ForgeCheck>>(file);
  } catch {
    return undefined;
  }
  const commit = rec?.commit;
  if (rec?.ok !== false || typeof commit !== "string" || !commit || typeof rec.problem !== "string") return undefined;
  if (!isAncestor(e.project.root, commit, `refs/heads/${e.base}`)) return undefined;
  return mismatchBlock(e, commit, rec.problem);
}

/** Forget the recorded merge a failed forge check refused, and return that block. */
function setAside(e: Engine, block: ActionResult): ActionResult {
  e.state.pendingMerge = undefined;
  e.state.pendingMergeHead = undefined;
  e.save();
  return block;
}

/**
 * The expectation an earlier merge attempt recorded before it asked the forge to merge
 * `pushed`, the branch head about to be merged again (a record with no `commit` and that `pushedHead`);
 * a record that cannot be read counts as one with unknown values, which blocks. Any other record is
 * stale (a commit already checked or refused, or another branch head): it is removed and undefined
 * returned, so the merge is gated and checked afresh.
 */
function savedForgeCheck(e: Engine, pushed: string): BaseAndTree | undefined {
  const file = path.join(e.runDir, FORGE_CHECK);
  if (!fs.existsSync(file)) return undefined;
  let rec: Partial<ForgeCheck> | undefined;
  try {
    rec = readJson<Partial<ForgeCheck>>(file);
  } catch {
    return { base: null, tree: null };
  }
  if (rec && rec.commit == null && rec.pushedHead === pushed) {
    const sha = (v: unknown) => (typeof v === "string" && v ? v : null);
    return { base: sha(rec.expected?.base), tree: sha(rec.expected?.tree), ...untiedOf(rec.expected?.untied) };
  }
  fs.rmSync(file, { force: true });
  return undefined;
}

/**
 * The expectation a recorded forge commit must still be checked against on resume, read
 * from `<runDir>/forge-check.json`; undefined when there is no record (a local merge never writes one)
 * or the record says `commit` already passed. A record that cannot be read gives an unknown expectation,
 * which `forgeMismatch` blocks on.
 */
function uncheckedForgeMerge(e: Engine, commit: string): BaseAndTree | undefined {
  const file = path.join(e.runDir, FORGE_CHECK);
  if (!fs.existsSync(file)) return undefined;
  let rec: Partial<ForgeCheck> | undefined;
  try {
    rec = readJson<Partial<ForgeCheck>>(file);
  } catch {
    rec = undefined;
  }
  if (rec?.ok === true && rec.commit === commit) return undefined;
  const sha = (v: unknown) => (typeof v === "string" && v ? v : null);
  return { base: sha(rec?.expected?.base), tree: sha(rec?.expected?.tree), ...untiedOf(rec?.expected?.untied) };
}

/** After the merge: push the base, move the worktree aside, delete the branch here and on the hub. Each step tolerates having been done. */
async function cleanUp(e: Engine, detail: string): Promise<ActionResult> {
  const { project, card, state } = e;
  await pushing(e, () => e.hub.pushBase());
  try {
    removeWorktree(project, card.id); // moved to .mergewright/local/discarded/, kept seven days
  } catch (err) {
    if (!(err instanceof MwError)) throw err;
    return { outcome: "block", detail: `merged into ${e.base} as ${state.merged!.slice(0, 10)}, but the clean-up stopped: ${err.message} Then run 'mw run ${card.id}' to finish it.` };
  }
  state.worktree = undefined;
  deleteBranch(project.root, e.branch);
  await pushing(e, () => e.hub.deleteBranch(e.branch));
  delete state.cleanupPending;
  e.save();
  return { outcome: "ok", detail };
}

/** Commit exactly `files` (paths the runtime wrote) on the base branch in the main checkout. Returns true when committed. */
function commitMemory(root: string, message: string, all: string[]): boolean {
  const files = withoutSyncTemp(all); // never a sync temporary or conflict file
  if (!files.length) return false;
  git(root, ["add", "--", ...files]);
  if (git(root, ["diff", "--cached", "--quiet", "--", ...files], { allowFail: true }).code === 0) return false;
  git(root, ["commit", "--quiet", "--no-verify", "-m", message, "--", ...files]);
  return true;
}

/**
 * Apply reflection.json to memory in the main checkout and commit only the files it wrote. Refuses
 * (outcome `block`) while memory/ has uncommitted changes, so an owner's edit is never overwritten or
 * swept into the commit: checked once up front, and again once every new content is
 * computed, immediately before the first file is written. What remains is the few milliseconds the
 * writes themselves take. An over-long state gets one rerun of the role (`rerun` returns the new
 * reflection); after that everything but the state is applied. Other problems become warnings.
 */
export async function memoryUpdate(e: Engine, risk: Risk, rerun: (error: string) => Promise<Reflection | undefined>): Promise<ActionResult> {
  const { project, card, state } = e;
  let r = e.artifacts.get<Reflection>("reflection");
  const dirtyMemory = () => dirtyFiles(project.root, ["memory/"]);
  const refusal = (dirty: string[]) => `memory/ has uncommitted changes (${dirty.join(", ")}); commit or discard them, then run 'mw run ${card.id}' again`;
  if (r) {
    const dirty = dirtyMemory();
    if (dirty.length) return { outcome: "block", detail: refusal(dirty) };
  }
  // The adjudication's follow-ups become todo cards, committed with the reflection.
  const followUps = createFollowUps(e);
  const followNote = followUps.ids.length ? `; follow-up card(s): ${followUps.ids.join(", ")}` : "";
  if (!r) {
    if (!followUps.files.length) return { outcome: "ok", detail: "no reflection to apply" };
    assertLease(e);
    const committed = commitMemory(project.root, `${card.id}: add follow-up cards ${followUps.ids.join(", ")}`, followUps.files);
    if (committed) await pushing(e, () => e.hub.pushBase());
    return { outcome: "ok", detail: `no reflection to apply${followNote}` };
  }
  const guard = () => {
    const now = dirtyMemory();
    if (now.length) throw new MwError("memory/dirty", refusal(now));
  };
  let note = "";
  let files: string[] = [];
  try {
    try {
      files = applyReflection(project, card.id, card.title, r, { guard }).files;
    } catch (err) {
      if (!(err instanceof MwError && err.code === "memory/too-long")) throw err;
      const again = await rerun(err.message);
      if (again) r = again;
      try {
        files = applyReflection(project, card.id, card.title, r, { guard }).files;
      } catch (err2) {
        if (!(err2 instanceof MwError && err2.code === "memory/too-long")) throw err2;
        files = applyReflection(project, card.id, card.title, r, { guard, skipState: true }).files;
        note = "; the new state was still too long, so STATE.md was left unchanged";
        state.warnings.push(`memory.update: ${err2.message}; STATE.md was left unchanged and everything else was applied`);
      }
    }
  } catch (err) {
    if (!(err instanceof MwError)) throw err;
    if (err.code === "memory/dirty") return { outcome: "block", detail: err.message };
    state.warnings.push(`memory.update: ${err.message}`);
    if (followUps.files.length) {
      assertLease(e);
      if (commitMemory(project.root, `${card.id}: add follow-up cards ${followUps.ids.join(", ")}`, followUps.files)) await pushing(e, () => e.hub.pushBase());
    }
    return { outcome: "ok", detail: `memory not updated: ${err.message}${followNote}` };
  }
  assertLease(e);
  const message = followUps.ids.length ? `${card.id}: update project memory, add follow-up cards ${followUps.ids.join(", ")}` : `${card.id}: update project memory`;
  const committed = commitMemory(project.root, message, [...files, ...followUps.files]);
  if (committed) await pushing(e, () => e.hub.pushBase());
  const lessons = r.lessons.map((l) => ({ ...l, card: card.id }));
  if (lessons.length) await safely(e, "remember", () => e.integrations.remember(lessons));
  return { outcome: "ok", detail: `${committed ? "memory updated and committed" : "memory unchanged"} (${lessons.length} lesson(s))${note}${followNote}` };
}

/**
 * Make a `todo` card in the main checkout for each follow-up of an approving
 * adjudication: its kind (default `chore`), tagged `follow-up`, its body "Follow-up from <CARD>
 * adjudication: <why>". Risk `medium` unless the follow-up names one; scope the
 * follow-up's (else the parent's) without protected paths, plus the project's `docs.paths` that are
 * not protected (as `mw card new` adds them), so the card passes `mw check --strict`. Done once per
 * run: the ids are recorded in the run state before anything else, and a phase run again only collects
 * the files of the cards made the first time (so they are committed). Returns the ids and card files.
 */
export function createFollowUps(e: Engine): { ids: string[]; files: string[] } {
  const { card, state } = e;
  const a = e.artifacts.get<Adjudication>("adjudication");
  const fileOf = (id: string) => `cards/${id}.card.md`;
  if (state.followUps) {
    const ids = state.followUps;
    return { ids, files: ids.map(fileOf).filter((f) => fs.existsSync(e.project.abs(f))) };
  }
  const list = a?.verdict === "approve" && Array.isArray(a.follow_ups) ? a.follow_ups.filter((f) => f.title?.trim()) : [];
  if (!list.length) return { ids: [], files: [] };
  assertLease(e);
  const ids: string[] = [];
  for (const f of list) {
    // A fresh view of the project each time: the next id counts the card just written.
    const fresh = new Project(e.project.root);
    const protectedPaths = fresh.config.protected;
    const scope = (f.scope?.length ? f.scope : card.scope).filter((g) => !isProtectedGlob(g, protectedPaths));
    const withDocs = scopeWithDocs(scope, fresh.config.docs.paths, protectedPaths);
    try {
      ids.push(newCard(fresh, {
        title: f.title, kind: f.kind ?? "chore", risk: f.risk ?? "medium", scope: withDocs, status: "todo",
        tags: ["follow-up"], why: `Follow-up from ${card.id} adjudication: ${f.why}`,
      }));
    } catch (err) {
      if (!(err instanceof MwError)) throw err;
      state.warnings.push(`follow-up '${f.title}' was not made a card: ${err.message}`);
    }
    state.followUps = [...ids];
    e.save();
  }
  return { ids, files: ids.map(fileOf) };
}

/** File names that read as documentation wherever they are (named when they fall outside docs.paths). */
const DOC_LIKE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
/** MergeWright's own files (spec section 2.2), never documentation of the product: not named. */
const RUNTIME_FILE = /^(specs|cards|roles|flows|gates|mcps|memory|\.mergewright)\//;

/**
 * The changed files a docs.sync did not consider because they are outside `docs.paths`:
 * every such file of a `docs` card, documentation-like files (DOC_LIKE) of any other card; files
 * `docs.exclude` names are left out on purpose and MergeWright's own folders (RUNTIME_FILE) are not
 * documentation, so neither is listed. Empty when there are none.
 */
export function outsideDocsNote(kind: string, files: string[], paths: string[], exclude: string[]): string {
  const outside = files.filter((f) => !RUNTIME_FILE.test(f) && !matchesAny(f, paths) && !matchesAny(f, exclude) && (kind === "docs" || DOC_LIKE.test(f)));
  if (!outside.length) return "";
  const shown = outside.slice(0, 5).join(", ") + (outside.length > 5 ? ` and ${outside.length - 5} more` : "");
  return `; not synced: ${shown} ${outside.length === 1 ? "is" : "are"} outside docs.paths (${paths.join(", ")}); widen docs.paths to sync ${outside.length === 1 ? "it" : "them"} to the documentation service`;
}

export async function docsSync(e: Engine): Promise<ActionResult> {
  if (!e.state.merged) return { outcome: "ok", detail: "nothing merged, so no documentation to sync" };
  const files = commitFiles(e.project.root, e.state.merged);
  const { paths, exclude } = e.project.config.docs;
  const isDoc = (f: string) => matchesAny(f, paths) && !matchesAny(f, exclude);
  const changed = files.changed.filter(isDoc);
  const deleted = files.deleted.filter(isDoc);
  const outsideNote = outsideDocsNote(e.card?.kind ?? "", [...files.changed, ...files.deleted], paths, exclude);
  if (!changed.length && !deleted.length) return { outcome: "ok", detail: `no documentation changed${outsideNote}` };
  // Files are read as blobs of the merged commit; a symbolic link is not sent.
  const merged = e.state.merged;
  const send: string[] = [];
  let skipped = 0;
  for (const f of changed) {
    const blob = docBlob(e.project.root, merged, f);
    if (blob.kind === "skipped") { e.state.warnings.push(`docs.sync: ${blob.why}`); skipped++; }
    else send.push(f);
  }
  const skippedNote = (skipped ? `; ${skipped} skipped (see the warnings)` : "") + outsideNote;
  if (!send.length && !deleted.length) return { outcome: "ok", detail: `no documentation to send${skippedNote}` };
  let outcome: DocsSyncOutcome | void = undefined;
  await safely(e, "docs.sync", async () => { outcome = await e.integrations.docsSync(send, deleted, merged); });
  const what = `${send.length} changed and ${deleted.length} deleted documentation file(s)`;
  const done = (detail: string): ActionResult => ({ outcome: "ok", detail: detail + skippedNote });
  switch (outcome as DocsSyncOutcome | void) {
    case "none": return done("no documentation service configured; nothing synced");
    case "queued": return done(`${what} queued: the documentation service did not take them; 'mw queue flush' retries`);
    case "failed": return done(`${what} not sent (see the warnings)`);
    case "sent": return done(`${what} sent`);
    default: return done(`${what} handed to the documentation service`);
  }
}

export async function notifyAction(e: Engine, phase: Phase): Promise<ActionResult> {
  const last = e.state.history[e.state.history.length - 1];
  await safely(e, "notify", () => e.integrations.notify(`${e.card.id}: ${phase.id}`, `${e.card.title}\n\nLast phase: ${last ? `${last.phase} ${last.outcome}: ${last.detail}` : "(none)"}`));
  return { outcome: "ok", detail: "owner notified" };
}
