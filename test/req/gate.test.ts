// Required gate steps fail closed (specs/gate.spec.md): every step `gate.required` names
// must be reported exactly once, well formed, not skipped and passing; with required steps, a gate
// that writes no usable summary fails; malformed steps are reported and satisfy nothing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runGate, type GateRun } from "../../src/engine/gate.ts";
import { buildSquash, moveBase, withTempWorktree } from "../../src/engine/gitops.ts";
import { runCard } from "../../src/engine/run.ts";
import type { Integrations } from "../../src/engine/types.ts";
import { NO_MERGE_COMMIT } from "../../src/integrations/forge.ts";
import { Project } from "../../src/project.ts";
import { MwError } from "../../src/util.ts";
import { git, read, tmpDir, write } from "../helpers.ts";
import { brief, fakeHub, fakeIntegrations, GATE, handoff, project, run, runPath, script, state, subjects, useScript } from "../engine-helpers.ts";

/** A fake gate that writes `summary` (verbatim, or nothing when undefined) and exits with `exit`. */
function gateScript(summary: string | undefined, exit = 0): string {
  const json = summary === undefined ? "" : `cat > "$MERGEWRIGHT_GATE_JSON" <<'JSON'\n${summary}\nJSON\n`;
  return `#!/usr/bin/env bash\nset -u\nmkdir -p "$MERGEWRIGHT_GATE_LOGS"\necho "checks ran"\n${json}exit ${exit}\n`;
}

async function gate(summary: string | undefined, required: string[], exit = 0): Promise<GateRun> {
  const dir = tmpDir();
  const file = path.join(dir, "default.gate.sh");
  fs.writeFileSync(file, gateScript(summary, exit));
  fs.chmodSync(file, 0o755);
  return runGate({ id: "default", file, cwd: dir, runDir: path.join(dir, "run"), base: "main", minutes: 1, env: { PATH: process.env.PATH! }, required });
}

const step = (name: string, ok = true, extra: Record<string, unknown> = {}) => ({ name, kind: "test", ok, seconds: 0, ...extra });
const summary = (...steps: unknown[]) => JSON.stringify({ ok: true, steps });

/** A project whose gate writes `body` and whose mergewright.yaml requires `required`. */
function gatedProject(body: string, required: string[]): string {
  const dir = project();
  write(dir, "gates/default.gate.sh", body);
  fs.chmodSync(path.join(dir, "gates/default.gate.sh"), 0o755);
  write(dir, "mergewright.yaml", `${read(dir, "mergewright.yaml").trimEnd()}\ngate:\n  required: [${required.join(", ")}]\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "fake gate");
  return dir;
}

// @req REQ-gate-001
test("REQ-gate-001 AC-1: a required step absent from a passing gate's summary fails with gate/required-missing", async () => {
  const r = await gate(summary(step("lint")), ["test"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "gate/required-missing");
  assert.equal(r.json.ok, false);
  assert.match(r.detail, /gate\/required-missing/);
  assert.match(r.detail, /no well-formed step named test/);
});

// @req REQ-gate-001
test("REQ-gate-001 AC-1: in a run, gate/required-missing blocks the phase and spends no remediation round", async () => {
  useScript(script());
  const dir = gatedProject(gateScript(summary(step("lint"))), ["test"]);
  const s = await run(dir);
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason ?? "", /gate\/required-missing/);
  const g = s.history.find((h) => h.phase === "gate");
  assert.equal(g?.outcome, "block");
  assert.equal(s.round, 0, "no remediation round is spent");
  assert.equal(s.merged, undefined);
  assert.ok(!subjects(dir).includes("DEMO-1: Card DEMO-1"), "nothing was merged");
  const stored = JSON.parse(fs.readFileSync(runPath(dir, "gate.json"), "utf8")) as { ok: boolean };
  assert.equal(stored.ok, false);
});

// @req REQ-gate-001
test("REQ-gate-001 AC-2: a required step listed twice fails with gate/required-missing naming the duplicate", async () => {
  const r = await gate(summary(step("test"), step("test")), ["test"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "gate/required-missing");
  assert.match(r.detail, /lists the step test more than once/);
});

// @req REQ-gate-001
test("REQ-gate-001 AC-3: a gate that exits 0 with a required step reporting ok: false fails, naming the step", async () => {
  const r = await gate(summary(step("lint"), step("test", false)), ["test"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, undefined, "an ordinary failure: the worker can fix a failing check");
  assert.equal(r.json.ok, false);
  assert.match(r.detail, /required step test reported ok: false/);
  assert.match(r.detail, /step test failed/);
  // A non-required failing step does not override exit 0, as before.
  const loose = await gate(summary(step("lint", false), step("test")), ["test"]);
  assert.equal(loose.ok, true, loose.detail);
});

// @req REQ-gate-001
test("REQ-gate-001 AC-4: a required step reported skipped still yields gate/required-skipped", async () => {
  const r = await gate(summary(step("test", true, { skipped: true, reason: "DATABASE_URL not set" })), ["test"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "gate/required-skipped");
  assert.match(r.detail, /NOT run: test \(DATABASE_URL not set\)/);
});

// @req REQ-gate-002
test("REQ-gate-002 AC-1: with required steps, a gate that exits 0 and writes no JSON fails with gate/required-missing", async () => {
  const r = await gate(undefined, ["test"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "gate/required-missing");
  assert.match(r.detail, /wrote no JSON summary/);
  assert.ok(r.json.steps.every((s) => !s.ok), "no synthetic passing step");
});

// @req REQ-gate-002
test("REQ-gate-002 AC-2: with required steps, unparsable JSON or JSON without steps fails, saying the summary is malformed", async () => {
  for (const bad of ["{not json", JSON.stringify({ ok: true }), JSON.stringify({ ok: true, steps: "test" })]) {
    const r = await gate(bad, ["test"]);
    assert.equal(r.ok, false, bad);
    assert.equal(r.code, "gate/required-missing", bad);
    assert.match(r.detail, /summary is malformed/, bad);
  }
});

// @req REQ-gate-002
test("REQ-gate-002 AC-3: with an empty gate.required, the exit code alone decides when there is no JSON", async () => {
  const pass = await gate(undefined, []);
  assert.equal(pass.ok, true, pass.detail);
  assert.equal(pass.code, undefined);
  assert.deepEqual(pass.json.steps.map((s) => [s.name, s.ok]), [["default", true]]);
  const bad = await gate("{not json", []);
  assert.equal(bad.ok, true, bad.detail);
  const fail = await gate(undefined, [], 1);
  assert.equal(fail.ok, false);
  assert.equal(fail.code, undefined);
});

// @req REQ-gate-003
test("REQ-gate-003 AC-1: a step without a string name or a boolean ok is reported as malformed and satisfies nothing", async () => {
  const r = await gate(summary({ name: "test", ok: "true" }, { ok: true }, step("lint")), ["test"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "gate/required-missing", "a malformed step with the right name does not satisfy it");
  const warnings = r.json.warnings ?? [];
  assert.ok(warnings.some((w) => /step 'test' .*malformed.*boolean `ok`/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => /step number 2 .*malformed.*string `name`/.test(w)), warnings.join("\n"));
  assert.deepEqual(r.json.steps.map((s) => s.name), ["lint"], "malformed steps are not stored as steps");
  assert.match(r.detail, /Malformed steps:/);
});

// @req REQ-gate-003
test("REQ-gate-003 AC-2: a step's tests counts are kept unchanged in the stored gate artifact", async () => {
  const tests = { total: 470, pass: 467, fail: 0, skip: 3 };
  const r = await gate(summary(step("typecheck"), step("test", true, { tests })), ["typecheck", "test"]);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual((r.json.steps.find((s) => s.name === "test") as unknown as { tests: unknown }).tests, tests);
});

// ── REQ-gate-004: the tree that lands is the tree that was gated ────────────────

/**
 * A gate that appends its working folder to `marks` on every run (one line per run), and fails when
 * src/caller.txt calls old() but src/api.txt no longer defines it.
 */
function interfaceGate(marks: string): string {
  return `#!/usr/bin/env bash
set -u
mkdir -p "$MERGEWRIGHT_GATE_LOGS"
pwd >> ${JSON.stringify(marks)}
log="$MERGEWRIGHT_GATE_LOGS/check.log"
if [ -f src/caller.txt ] && grep -q 'old()' src/caller.txt && ! grep -q 'old()' src/api.txt; then
  echo "src/caller.txt calls old(), which src/api.txt no longer defines" > "$log"; ok=false; code=1
else
  echo "all fine" > "$log"; ok=true; code=0
fi
printf '{"ok":%s,"steps":[{"name":"check","kind":"test","ok":%s,"seconds":0,"log":"%s"}]}\\n' $ok $ok "$log" > "$MERGEWRIGHT_GATE_JSON"
exit $code
`;
}

/** DEMO-1 (with `cardExtra`) and DEMO-2 on a base whose src/api.txt defines old(); the gate counts its runs. */
function interfaceProject(cardExtra = ""): { dir: string; marks: string } {
  const dir = project({ cardExtra, scope: ["src/**"] });
  const marks = path.join(tmpDir("mw-marks-"), "gate-runs.txt");
  write(dir, "gates/default.gate.sh", interfaceGate(marks));
  fs.chmodSync(path.join(dir, "gates/default.gate.sh"), 0o755);
  write(dir, "src/api.txt", "old()\n");
  write(dir, "cards/DEMO-2.card.md", `---\nid: DEMO-2\ntitle: Card DEMO-2\nkind: feature\nstatus: todo\nscope: ["src/**"]\n---\n\n## Why\n\nThe interface changes.\n\n## Acceptance\n\n- The api defines new().\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "interface and counting gate");
  return { dir, marks };
}

const gateRuns = (marks: string): string[] => (fs.existsSync(marks) ? fs.readFileSync(marks, "utf8").split("\n").filter(Boolean) : []);
const worker = (writes: Record<string, string>) => script({ planner: [{ output: brief({ scope: ["src/**"] }) }], worker: [{ writes, output: handoff({ changed: Object.keys(writes) }) }] });
const regateDir = (dir: string) => path.join(dir, ".mergewright", "local", "regate");
const worktreeList = (dir: string) => git(dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));

// @req REQ-gate-004
test("REQ-gate-004 AC-1, AC-2: a caller that passed alone is re-gated on the base another card changed, fails, is not merged and remediates", async () => {
  const { dir, marks } = interfaceProject("risk: high\n");
  // Card 2 (DEMO-1) adds a caller of old() and passes its gate alone; it waits for the owner's merge approval.
  useScript(worker({ "src/caller.txt": "calls old()\n" }));
  const waiting = await run(dir, { approve: ["go"] });
  assert.equal(waiting.status, "waiting", waiting.reason);
  assert.equal(gateRuns(marks).length, 1);
  const forked = git(dir, "rev-parse", "main");
  assert.equal((JSON.parse(fs.readFileSync(runPath(dir, "gate.json"), "utf8")) as { base?: string }).base, forked, "the gate artifact records the base it ran against");
  // Card 1 (DEMO-2) renames the interface and merges.
  useScript(worker({ "src/api.txt": "new()\n" }));
  const first = await runCard(new Project(dir), "DEMO-2", {}, { hub: fakeHub(), integrations: fakeIntegrations() });
  assert.equal(first.status, "done", first.reason);
  assert.ok(first.merged);
  assert.equal(gateRuns(marks).length, 2);
  const moved = git(dir, "rev-parse", "main");
  assert.notEqual(moved, forked);
  // Merging card 2 now re-gates the squash tree, which fails: nothing merges, the run remediates.
  useScript(worker({ "src/caller.txt": "calls old()\n" }));
  const branch = git(dir, "rev-parse", "card/DEMO-1");
  const s = await run(dir, { approve: ["merge"], until: "implement" });
  assert.equal(git(dir, "rev-parse", "card/DEMO-1"), branch, "the card branch is unchanged (no status commit)");
  const runs = gateRuns(marks);
  assert.equal(runs.length, 3, "the gate ran once more, on the squash tree");
  assert.ok(runs[2]!.startsWith(fs.realpathSync(regateDir(dir)) + path.sep), `the re-gate ran in a temporary worktree, not in ${runs[2]}`);
  assert.equal(git(dir, "rev-parse", "main"), moved, "the base did not move");
  assert.equal(s.merged, undefined);
  assert.equal(s.pendingMerge, undefined);
  const m = s.history.findLast((h) => h.phase === "merge");
  assert.equal(m?.outcome, "fail");
  assert.equal(s.round, 1, "one remediation round");
  assert.match(s.remediation ?? "", /^rebuild on the new base/);
  assert.match(s.remediation ?? "", /src\/caller\.txt calls old\(\), which src\/api\.txt no longer defines/, "the re-run's gate log");
  assert.deepEqual(fs.readdirSync(regateDir(dir)), [], "the temporary worktree is gone");
  assert.ok(!worktreeList(dir).some((w) => w.includes(`${path.sep}regate${path.sep}`)), worktreeList(dir).join("\n"));
  assert.ok(!git(dir, "branch", "--list").includes("regate"), "no branch is left behind");
});

// @req REQ-gate-004
test("REQ-gate-004 AC-3: with an unmoved base the card merges after exactly one gate run, and the artifact records that base", async () => {
  const { dir, marks } = interfaceProject();
  const base = git(dir, "rev-parse", "main");
  useScript(worker({ "src/caller.txt": "calls old()\n" }));
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.ok(s.merged);
  assert.ok(subjects(dir).includes("DEMO-1: Card DEMO-1"), "the card merged into main");
  assert.equal(gateRuns(marks).length, 1, "the gate is not run again");
  assert.equal((JSON.parse(fs.readFileSync(runPath(dir, "gate.json"), "utf8")) as { base?: string }).base, base);
});

// @req REQ-gate-004
test("REQ-gate-004 AC-1: a moved base whose squash tree equals the branch tree merges without a second gate run", async () => {
  const { dir, marks } = interfaceProject("risk: high\n");
  useScript(worker({ "src/shared.txt": "same\n" }));
  const forked = git(dir, "rev-parse", "main");
  const waiting = await run(dir, { approve: ["go"] });
  assert.equal(waiting.status, "waiting", waiting.reason);
  assert.equal((JSON.parse(fs.readFileSync(runPath(dir, "gate.json"), "utf8")) as { base?: string }).base, forked, "the gate artifact records the base it ran against");
  // Another card landed the very same file on the base: the base moved, the merged tree does not change.
  write(dir, "src/shared.txt", "same\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "the same file, merged by another card");
  const s = await run(dir, { approve: ["merge"] });
  assert.equal(s.status, "done", s.reason);
  assert.ok(subjects(dir).includes("DEMO-1: Card DEMO-1"), "the card merged into main");
  assert.equal(gateRuns(marks).length, 1, "no second gate run");
});

// @req REQ-gate-004
test("REQ-gate-004: the temporary worktree is removed when the gate run in it throws", async () => {
  const dir = project();
  const before = worktreeList(dir);
  let seen = "";
  await assert.rejects(withTempWorktree(new Project(dir), "DEMO-1", git(dir, "rev-parse", "main"), async (wt) => {
    seen = wt;
    assert.ok(fs.existsSync(path.join(wt, "cards", "DEMO-1.card.md")));
    throw new Error("the gate blew up");
  }), /the gate blew up/);
  assert.ok(seen && !fs.existsSync(seen), "the folder is gone");
  assert.deepEqual(worktreeList(dir), before, "git lists no extra worktree");
});

// ── REQ-gate-004: the forge's own squash is the re-gated squash ─────────────────

interface ForgeCheckJson {
  commit: string | null;
  expected: { base: string | null; tree: string | null };
  actual: { base: string | null; tree: string | null };
  ok: boolean;
  problem?: string;
}

const forgeCheck = (dir: string) => JSON.parse(fs.readFileSync(runPath(dir, "forge-check.json"), "utf8")) as ForgeCheckJson;

/**
 * A local fake forge: it squashes the pushed card branch onto main in the project's own repository, as
 * a forge would on its base, and reports that commit (the same one again on a retry). `moveFirst` lands
 * another commit on main first, as if the forge's base moved outside the lease.
 */
function squashingForge(dir: string, opts: { moveFirst?: boolean } = {}): ReturnType<typeof fakeIntegrations> & { merged: () => string } {
  let merged = "";
  return {
    ...fakeIntegrations(),
    merged: () => merged,
    async forgeMerge() {
      if (merged) return merged;
      if (opts.moveFirst) {
        write(dir, "README.forge.md", "landed on the forge while DEMO-1 was being merged\n");
        git(dir, "add", "README.forge.md");
        git(dir, "commit", "-qm", "another merge on the forge");
      }
      const built = buildSquash(dir, "main", git(dir, "rev-parse", "card/DEMO-1"), "DEMO-1: Card DEMO-1\n");
      assert.ok(built.ok, built.detail);
      assert.ok(moveBase(dir, "main", built.commit!).ok);
      merged = built.commit!;
      return merged;
    },
  };
}

// @req REQ-gate-004
test("REQ-gate-004: a forge squash on the re-gated base with the re-gated tree completes the card, and the check is recorded", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  // The base moves before the merge (another card), so the merge re-gates on it.
  write(dir, "README.extra.md", "another card's work\n");
  git(dir, "add", "README.extra.md");
  git(dir, "commit", "-qm", "another card");
  const onto = git(dir, "rev-parse", "main");
  const forge = squashingForge(dir);
  const hub = fakeHub();
  const s = await run(dir, {}, { hub, integrations: forge });
  assert.equal(s.status, "done", s.reason);
  assert.equal(s.merged, forge.merged());
  assert.ok(fs.existsSync(runPath(dir, "regate", "gate-logs")), "the merge re-gated on the moved base");
  const c = forgeCheck(dir);
  assert.equal(c.ok, true);
  assert.equal(c.commit, forge.merged());
  assert.equal(c.expected.base, onto, "the expected base is the base the re-gate ran against");
  assert.equal(c.actual.base, onto);
  assert.equal(c.expected.tree, git(dir, "rev-parse", `${forge.merged()}^{tree}`));
  assert.equal(c.actual.tree, c.expected.tree);
  assert.ok(!s.warnings.some((w) => w.startsWith("forge merge check")), s.warnings.join("\n"));
  assert.ok(hub.names().includes("deleteBranch"), "the clean-up ran");
});

// @req REQ-gate-004
test("REQ-gate-004: a forge squash on a base that moved outside the lease blocks for the owner, naming expected and actual base and tree", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  const onto = git(dir, "rev-parse", "main");
  const forge = squashingForge(dir, { moveFirst: true });
  const hub = fakeHub();
  const s = await run(dir, {}, { hub, integrations: forge });
  assert.equal(s.status, "blocked");
  assert.equal(s.merged, undefined, "the card is not recorded as merged");
  assert.equal(s.pendingMerge, undefined, "the forge's commit is not kept as a merge to finish later");
  assert.equal(s.history.findLast((h) => h.phase === "merge")?.outcome, "block");
  const moved = git(dir, "rev-parse", `${forge.merged()}^1`);
  assert.notEqual(moved, onto);
  const c = forgeCheck(dir);
  assert.equal(c.ok, false);
  assert.equal(c.commit, forge.merged());
  assert.equal(c.expected.base, onto);
  assert.equal(c.actual.base, moved);
  assert.equal(c.actual.tree, git(dir, "rev-parse", `${forge.merged()}^{tree}`));
  assert.ok(c.expected.tree && c.expected.tree !== c.actual.tree, "the trees differ too");
  const named = new RegExp(`expected base ${onto.slice(0, 10)} and tree ${c.expected.tree.slice(0, 10)}, actual base ${moved.slice(0, 10)} and tree ${c.actual.tree!.slice(0, 10)}`);
  assert.match(s.reason ?? "", named);
  assert.ok(s.warnings.some((w) => w.startsWith("forge merge check: ") && named.test(w)), s.warnings.join("\n"));
  assert.doesNotMatch(s.reason ?? "", /tok|token|secret/i);
  assert.ok(fs.existsSync(path.join(dir, ".mergewright", "worktrees", "DEMO-1")), "the worktree is kept");
  assert.ok(git(dir, "branch", "--list", "card/DEMO-1"), "the branch is kept");
  assert.ok(!hub.names().includes("deleteBranch"));
  const notified = forge.of("notify").map((n) => String(n.args[1]));
  assert.ok(notified.some((b) => named.test(b)), "the owner is told");
  // A second run checks the same forge commit again and blocks again: never a silent success.
  const again = await run(dir, {}, { hub: fakeHub(), integrations: forge });
  assert.equal(again.status, "blocked", again.reason);
  assert.equal(again.merged, undefined);
  assert.equal(forgeCheck(dir).ok, false);
});

// @req REQ-gate-004
test("REQ-gate-004: a commit that reaches the card branch after the re-gate and before the push blocks the forge check, naming the extra path", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  // The base moves (another card) with a gate that, while it re-gates, slips a commit onto the card branch.
  const wt = path.join(dir, ".mergewright", "worktrees", "DEMO-1");
  const sneak = `case "$PWD" in */regate/*) printf 'not gated\\n' > ${JSON.stringify(path.join(wt, "src", "smuggled.txt"))}; git -C ${JSON.stringify(wt)} add src/smuggled.txt; git -C ${JSON.stringify(wt)} -c user.name=sneak -c user.email=sneak@example.invalid commit -qm "not gated" ;; esac\n`;
  write(dir, "gates/default.gate.sh", GATE.replace("set -u\n", `set -u\n${sneak}`));
  write(dir, "README.extra.md", "another card's work\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "another card");
  const forge = squashingForge(dir);
  const s = await run(dir, {}, { hub: fakeHub(), integrations: forge });
  assert.ok(fs.existsSync(runPath(dir, "regate", "gate-logs")), "the merge re-gated on the moved base");
  assert.equal(git(dir, "show", `${forge.merged()}:src/smuggled.txt`), "not gated", "the forge squashed the ungated commit");
  assert.equal(s.status, "blocked", s.reason);
  assert.equal(s.merged, undefined, "the card is not recorded as merged");
  assert.equal(s.pendingMerge, undefined);
  assert.equal(s.history.findLast((h) => h.phase === "merge")?.outcome, "block");
  const c = forgeCheck(dir);
  assert.equal(c.ok, false);
  assert.equal(c.commit, forge.merged());
  assert.equal(c.expected.tree, null, "the expectation is not tied to the gated tree");
  assert.match(c.problem ?? "", /in more than the card file: src\/smuggled\.txt\)/);
  assert.doesNotMatch(c.problem ?? "", /cards\/DEMO-1\.card\.md/, "the card file's status line is allowed");
  assert.match(s.reason ?? "", /not the gated merge.*src\/smuggled\.txt/);
  assert.ok(s.warnings.some((w) => w.startsWith("forge merge check: ") && w.includes("src/smuggled.txt")), s.warnings.join("\n"));
});

// @req REQ-gate-004
test("REQ-gate-004: a forge that reports the merge without a merge commit blocks the run, never a silent success", async () => {
  for (const answer of ["no-commit error", "empty commit"] as const) {
    const dir = project();
    useScript(script());
    await run(dir, { until: "merge" });
    const onto = git(dir, "rev-parse", "main");
    const forge: Integrations = {
      ...fakeIntegrations(),
      async forgeMerge() {
        if (answer === "empty commit") return "";
        throw new MwError(NO_MERGE_COMMIT, "the forge reports pull request #7 as merged but names no merge commit, so what landed cannot be checked");
      },
    };
    const s = await run(dir, {}, { integrations: forge });
    assert.equal(s.status, "blocked", `${answer}: ${s.reason}`);
    assert.equal(s.merged, undefined, answer);
    assert.equal(s.pendingMerge, undefined, answer);
    assert.equal(git(dir, "rev-parse", "main"), onto, `${answer}: the base did not move here`);
    assert.match(s.reason ?? "", new RegExp(`expected base ${onto.slice(0, 10)} and tree [0-9a-f]{10}, actual base \\(unknown\\) and tree \\(unknown\\)`), answer);
    const c = forgeCheck(dir);
    assert.deepEqual([c.ok, c.commit, c.expected.base, c.actual], [false, null, onto, { base: null, tree: null }], answer);
    assert.ok(s.warnings.some((w) => w.startsWith("forge merge check: ")), answer);
    assert.ok(fs.existsSync(path.join(dir, ".mergewright", "worktrees", "DEMO-1")), `${answer}: the worktree is kept`);
  }
});

// @req REQ-gate-004
test("REQ-gate-004: a run that stops after the forge's commit is recorded runs the forge check on resume", async () => {
  for (const movedBase of [true, false]) {
    const what = movedBase ? "moved base" : "matching squash";
    const dir = project();
    useScript(script());
    await run(dir, { until: "merge" });
    const onto = git(dir, "rev-parse", "main");
    const forge = squashingForge(dir, { moveFirst: movedBase });
    // The machine stops once, at the sync after the forge's commit was recorded and before the check.
    const base = fakeHub();
    let stopped = false;
    const hub = {
      ...base,
      async sync(o?: { offline?: boolean }) {
        if (!stopped && state(dir).pendingMerge) {
          stopped = true;
          throw new Error("the machine stopped");
        }
        return base.sync(o);
      },
    };
    await assert.rejects(run(dir, {}, { hub, integrations: forge }), /the machine stopped/);
    assert.equal(state(dir).pendingMerge, forge.merged(), `${what}: the forge's commit was recorded`);
    const pending = forgeCheck(dir);
    assert.deepEqual([pending.ok, pending.commit, pending.expected.base], [false, null, onto], `${what}: the expectation was recorded before the commit`);
    const s = await run(dir, {}, { hub: fakeHub(), integrations: forge });
    const c = forgeCheck(dir);
    assert.equal(c.commit, forge.merged(), what);
    assert.equal(c.expected.base, onto, what);
    assert.equal(c.actual.base, git(dir, "rev-parse", `${forge.merged()}^1`), what);
    if (movedBase) {
      assert.equal(s.status, "blocked", `${what}: ${s.reason}`);
      assert.equal(s.merged, undefined, `${what}: the card is not recorded as merged`);
      assert.equal(s.pendingMerge, undefined, what);
      assert.equal(c.ok, false, what);
      assert.notEqual(c.actual.base, onto, what);
      assert.match(s.reason ?? "", new RegExp(`expected base ${onto.slice(0, 10)} and tree [0-9a-f]{10}, actual base ${c.actual.base!.slice(0, 10)} and tree [0-9a-f]{10}`), what);
      assert.ok(fs.existsSync(path.join(dir, ".mergewright", "worktrees", "DEMO-1")), `${what}: the worktree is kept`);
    } else {
      assert.equal(s.status, "done", `${what}: ${s.reason}`);
      assert.equal(s.merged, forge.merged(), what);
      assert.equal(c.ok, true, what);
      assert.equal(c.actual.tree, c.expected.tree, what);
    }
  }
});

// @req REQ-gate-004
test("REQ-gate-004: 'mw run --from' after a stop with the forge's commit recorded runs the forge check before accepting it", async () => {
  for (const movedBase of [true, false]) {
    const what = movedBase ? "moved base" : "matching squash";
    const dir = project();
    useScript(script());
    await run(dir, { until: "merge" });
    const onto = git(dir, "rev-parse", "main");
    const forge = squashingForge(dir, { moveFirst: movedBase });
    // The machine stops once, at the sync after the forge's commit was recorded and before the check.
    const base = fakeHub();
    let stopped = false;
    const hub = {
      ...base,
      async sync(o?: { offline?: boolean }) {
        if (!stopped && state(dir).pendingMerge) {
          stopped = true;
          throw new Error("the machine stopped");
        }
        return base.sync(o);
      },
    };
    await assert.rejects(run(dir, {}, { hub, integrations: forge }), /the machine stopped/);
    assert.equal(state(dir).pendingMerge, forge.merged(), `${what}: the forge's commit was recorded`);
    if (movedBase) {
      const s = await run(dir, { from: "merge" }, { hub: fakeHub(), integrations: forge });
      assert.equal(s.status, "blocked", `${what}: ${s.reason}`);
      assert.equal(s.merged, undefined, `${what}: the card is not recorded as merged`);
      assert.equal(s.cleanupPending, undefined, what);
      const c = forgeCheck(dir);
      assert.equal(c.ok, false, what);
      assert.equal(c.commit, forge.merged(), what);
      const actual = git(dir, "rev-parse", `${forge.merged()}^1`);
      assert.equal(c.actual.base, actual, what);
      assert.equal(c.actual.tree, git(dir, "rev-parse", `${forge.merged()}^{tree}`), what);
      assert.notEqual(c.expected.base, actual, what);
      // The recorded commit was checked against the expectation saved with it, set aside, and blocks the merge.
      assert.equal(c.expected.base, onto, what);
      const named = new RegExp(`expected base ${onto.slice(0, 10)} and tree ${c.expected.tree!.slice(0, 10)}, actual base ${actual.slice(0, 10)} and tree ${c.actual.tree!.slice(0, 10)}`);
      assert.match(s.reason ?? "", named, what);
      assert.ok(s.warnings.some((w) => w.startsWith("the recorded merge ") && w.includes("was set aside") && named.test(w)), s.warnings.join("\n"));
      assert.ok(fs.existsSync(path.join(dir, ".mergewright", "worktrees", "DEMO-1")), `${what}: the worktree is kept`);
    } else {
      await assert.rejects(run(dir, { from: "merge" }, { hub: fakeHub(), integrations: forge }), /already merged/);
      const c = forgeCheck(dir);
      assert.equal(c.ok, true, what);
      assert.equal(c.commit, forge.merged(), what);
      assert.equal(c.expected.base, onto, what);
      assert.equal(c.actual.tree, c.expected.tree, what);
      const s = await run(dir, {}, { hub: fakeHub(), integrations: forge });
      assert.equal(s.status, "done", `${what}: ${s.reason}`);
      assert.equal(s.merged, forge.merged(), what);
    }
  }
});

// @req REQ-gate-004
test("REQ-gate-004: the forge check expects the base the re-gate built on, also when the base moved after the merge first read it", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  // The base moves before the merge, so the merge re-gates.
  write(dir, "README.extra.md", "another card's work\n");
  git(dir, "add", "README.extra.md");
  git(dir, "commit", "-qm", "another card");
  const first = git(dir, "rev-parse", "main");
  // And again while the merge evidence is judged: after the merge read the base, before the re-gate built on it.
  // The run loads the project afresh, so the hook sits on the class for this run only.
  const roles = Project.prototype.roles;
  let regated = "";
  Project.prototype.roles = function (this: Project) {
    if (!regated && /mergeEvidence/.test(new Error().stack ?? "")) {
      write(dir, "README.later.md", "landed while the merge was being judged\n");
      git(dir, "add", "README.later.md");
      git(dir, "commit", "-qm", "another card, later");
      regated = git(dir, "rev-parse", "main");
    }
    return roles.call(this);
  };
  const forge = squashingForge(dir);
  let s;
  try {
    s = await runCard(new Project(dir), "DEMO-1", {}, { hub: fakeHub(), integrations: forge });
  } finally {
    Project.prototype.roles = roles;
  }
  assert.ok(regated && regated !== first, "the base moved during the merge");
  assert.ok(fs.existsSync(runPath(dir, "regate", "gate-logs")), "the merge re-gated");
  assert.equal(git(dir, "rev-parse", `${forge.merged()}^1`), regated, "the forge squashed onto the base the re-gate used");
  assert.equal(s.status, "done", s.reason);
  assert.equal(s.merged, forge.merged());
  const c = forgeCheck(dir);
  assert.equal(c.ok, true);
  assert.equal(c.expected.base, regated, "the expected base is the one the re-gate built on, not the first read");
  assert.equal(c.actual.tree, c.expected.tree);
});

/** A fake hub that keeps the card branches pushed to it and gives a branch back when it is fetched and missing here. */
function keepingHub(dir: string): ReturnType<typeof fakeHub> {
  const base = fakeHub();
  const kept = new Map<string, string>();
  return {
    ...base,
    async pushBranch(b: string) {
      kept.set(b, git(dir, "rev-parse", b));
      return base.pushBranch(b);
    },
    async fetchBranch(b: string) {
      const sha = kept.get(b);
      if (sha && !git(dir, "branch", "--list", b)) git(dir, "branch", b, sha);
      await base.fetchBranch(b);
      return !!sha;
    },
  };
}

// @req REQ-gate-004
test("REQ-gate-004: a forge merge whose answer is lost is checked on the next run against the expectation recorded before the call", async () => {
  for (const movedBase of [false, true]) {
    const what = movedBase ? "moved base" : "matching squash";
    const dir = project();
    useScript(script());
    await run(dir, { until: "merge" });
    const onto = git(dir, "rev-parse", "main");
    // The forge squashes onto main, then the answer is lost before the commit reaches the runtime.
    const forge = squashingForge(dir, { moveFirst: movedBase });
    const lost: Integrations = {
      ...forge,
      async forgeMerge(req) {
        await forge.forgeMerge(req);
        throw new Error("connection lost");
      },
    };
    // The hub keeps the pushed card branch: the next run prunes the local one (main says the card is
    // done) and makes the worktree again from the hub's copy.
    const hub = keepingHub(dir);
    await assert.rejects(run(dir, {}, { hub, integrations: lost }), /connection lost/);
    assert.ok(forge.merged(), `${what}: the forge merged`);
    assert.equal(state(dir).pendingMerge, undefined, `${what}: no commit was recorded`);
    const pending = forgeCheck(dir);
    assert.deepEqual([pending.ok, pending.commit, pending.expected.base], [false, null, onto], `${what}: the expectation was recorded before the forge call`);
    assert.ok(pending.expected.tree, what);
    const pushed = git(dir, "rev-parse", "card/DEMO-1");
    assert.equal((pending as ForgeCheckJson & { pushedHead?: string }).pushedHead, pushed, what);
    // The next run finds the merged pull request and checks it against that expectation, not the base as it is now.
    const s = await run(dir, {}, { hub, integrations: forge });
    const c = forgeCheck(dir);
    assert.equal(c.commit, forge.merged(), `${what}: ${s.status}: ${s.reason}`);
    assert.equal(c.expected.base, onto, `${what}: the expected base is the original base, not the post-merge head`);
    assert.equal(c.expected.tree, pending.expected.tree, what);
    assert.equal(c.actual.base, git(dir, "rev-parse", `${forge.merged()}^1`), what);
    if (movedBase) {
      assert.equal(s.status, "blocked", `${what}: ${s.reason}`);
      assert.equal(s.merged, undefined, what);
      assert.equal(c.ok, false, what);
      assert.notEqual(c.actual.base, onto, what);
      assert.match(s.reason ?? "", new RegExp(`expected base ${onto.slice(0, 10)} and tree ${c.expected.tree!.slice(0, 10)}, actual base ${c.actual.base!.slice(0, 10)}`), what);
      assert.ok(fs.existsSync(path.join(dir, ".mergewright", "worktrees", "DEMO-1")), `${what}: the worktree is kept`);
    } else {
      assert.equal(s.status, "done", `${what}: ${s.reason}`);
      assert.equal(s.merged, forge.merged(), what);
      assert.equal(c.ok, true, what);
      assert.equal(c.actual.tree, c.expected.tree, what);
      assert.ok(!fs.existsSync(runPath(dir, "regate", "gate-logs")), `${what}: no re-gate on the post-merge base`);
    }
  }
});

// @req REQ-gate-004
test("REQ-gate-004: an unreadable expectation recorded before the forge call blocks the next run before the forge is asked", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "merge" });
  const forge = squashingForge(dir);
  const lost: Integrations = { ...forge, async forgeMerge() { throw new Error("connection lost"); } };
  await assert.rejects(run(dir, {}, { hub: fakeHub(), integrations: lost }), /connection lost/);
  fs.writeFileSync(runPath(dir, "forge-check.json"), "{ not json");
  const s = await run(dir, {}, { hub: fakeHub(), integrations: forge });
  assert.equal(s.status, "blocked", s.reason);
  assert.equal(s.merged, undefined);
  assert.equal(forge.merged(), "", "the forge was not asked to merge");
  assert.match(s.reason ?? "", /cannot be read/);
  assert.deepEqual([forgeCheck(dir).ok, forgeCheck(dir).commit], [false, null]);
});
