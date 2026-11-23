import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { init } from "../src/init.ts";
import { Project } from "../src/project.ts";
import { buildTrace, coverage } from "../src/trace.ts";
import { card, codes, mw, newProject, read, SPEC, tmpDir, write } from "./helpers.ts";

test("a freshly initialised project conforms, with and without the example", () => {
  assert.deepEqual(codes(newProject()), []);
  assert.deepEqual(codes(newProject({ example: true })), []);
});

test("init fills in the project, is safe to repeat, and never overwrites", () => {
  const dir = tmpDir();
  write(dir, "AGENTS.md", "# mine\n");
  write(dir, ".gitignore", "node_modules/\n");
  const first = init(dir, { name: "shop", prefix: "SHOP" });
  assert.ok(first.added.includes("mergewright.yaml"));
  assert.ok(!first.added.includes("AGENTS.md"));
  assert.equal(read(dir, "AGENTS.md"), "# mine\n");
  assert.match(read(dir, "mergewright.yaml"), /name: shop/);
  assert.match(read(dir, "mergewright.yaml"), /prefix: SHOP/);
  assert.equal(read(dir, ".gitignore"), "node_modules/\n.mergewright/\n.*.tmp\n*.sync-conflict-*\n");
  assert.ok(fs.statSync(path.join(dir, "gates/default.gate.sh")).mode & 0o100);
  const second = init(dir, { name: "shop", prefix: "SHOP" });
  assert.deepEqual(second.added, []);
  assert.equal(read(dir, ".gitignore"), "node_modules/\n.mergewright/\n.*.tmp\n*.sync-conflict-*\n");
  assert.doesNotMatch(read(dir, "mergewright.yaml") + read(dir, "cards/README.md"), /__[A-Z_]+__/);
});

test("every preset role and flow loads without a diagnostic", () => {
  const p = new Project(newProject());
  p.roles(); p.flows(); p.mcps();
  assert.deepEqual(p.diag.items, []);
  assert.deepEqual([...p.flows().keys()].sort(), ["docs", "quick", "spike", "standard"]);
  assert.ok(p.roles().size >= 8);
});

test("card rules", () => {
  const dir = newProject();
  write(dir, "specs/auth.spec.md", SPEC);
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1", "implements: [REQ-auth-001]\nscope: [src/**, docs/**]\n"));
  assert.deepEqual(codes(dir), []);

  write(dir, "cards/DEMO-2.card.md", card("DEMO-2", "implements: [REQ-auth-404]\nscope: [src/**, docs/**]\n"));
  assert.deepEqual(codes(dir), ["card/unknown-requirement"]);

  write(dir, "cards/DEMO-2.card.md", card("DEMO-2", "scope: [src/**, docs/**]\n"));
  assert.deepEqual(codes(dir), ["card/no-requirement"]);
  write(dir, "cards/DEMO-2.card.md", card("DEMO-2", "kind: chore\nscope: [src/**, docs/**]\n"));
  assert.deepEqual(codes(dir), []);

  write(dir, "cards/DEMO-2.card.md", card("DEMO-2", "kind: chore\n"));
  assert.deepEqual(codes(dir), ["card/scope"]);
  write(dir, "cards/DEMO-2.card.md", card("DEMO-2", "kind: chore\nstatus: done\n").replace("status: todo\n", ""));
  assert.deepEqual(codes(dir), [], "a finished card needs no scope");

  write(dir, "cards/DEMO-2.card.md", card("DEMO-2", "kind: chore\nscope: [a, docs/**]\ndepends: [DEMO-3]\n"));
  write(dir, "cards/DEMO-3.card.md", card("DEMO-3", "kind: chore\nscope: [a, docs/**]\ndepends: [DEMO-2]\n"));
  assert.deepEqual(codes(dir), ["card/cycle"]);
  write(dir, "cards/DEMO-3.card.md", card("DEMO-3", "kind: chore\nscope: [a, docs/**]\ndepends: [DEMO-9]\n"));
  assert.deepEqual(codes(dir), ["card/depends"]);
  fs.rmSync(path.join(dir, "cards/DEMO-3.card.md"));

  write(dir, "cards/DEMO-2.card.md", card("DEMO-2", "kind: chore\nscope: [a, docs/**]\nflow: nonesuch\n"));
  assert.deepEqual(codes(dir), ["card/unknown-flow"]);
  write(dir, "cards/DEMO-2.card.md", card("OTHER-2", "kind: chore\nscope: [a, docs/**]\n"));
  assert.deepEqual(codes(dir), ["card/file-name", "card/prefix"]);
  write(dir, "cards/DEMO-2.card.md", card("DEMO-2", "kind: chore\nscope: [a, docs/**]\n", "No why section.\n"));
  assert.deepEqual(codes(dir), ["card/why"]);
  write(dir, "cards/DEMO-2.card.md", card("DEMO-2", "kind: chore\nscope: [a, docs/**]\nrisk: extreme\nbogus: 1\n"));
  assert.deepEqual(codes(dir), ["card/schema", "card/schema"]);
  write(dir, "cards/DEMO-2.card.md", "no front matter\n");
  assert.deepEqual(codes(dir), ["card/front-matter"]);
});

test("layout, memory and config rules", () => {
  const dir = newProject();
  write(dir, "cards/notes.txt", "x");
  assert.deepEqual(codes(dir), ["layout/stray-file"]);
  fs.rmSync(path.join(dir, "cards/notes.txt"));

  write(dir, "memory/STATE.md", "# State\n" + "line\n".repeat(200));
  assert.deepEqual(codes(dir), ["memory/too-long"]);
  fs.rmSync(path.join(dir, "memory/STATE.md"));
  assert.deepEqual(codes(dir), ["memory/missing"]);
  write(dir, "memory/STATE.md", "# State\n");

  write(dir, "memory/lessons/testing.md", "# Testing\n\n## Run the gate first\n\nBecause.\n");
  assert.deepEqual(codes(dir), ["memory/index-stale"]);
  assert.equal(mw(dir, ["memory", "index"]).code, 0);
  assert.deepEqual(codes(dir), []);

  const cfg = read(dir, "mergewright.yaml");
  write(dir, "mergewright.yaml", cfg.replace('mergewright: "0.1"', 'mergewright: "9.9"'));
  assert.ok(codes(dir).includes("config/schema"));
  write(dir, "mergewright.yaml", cfg.replace("extends: standard", "extends: imaginary"));
  assert.deepEqual(codes(dir), ["config/preset"]);
  write(dir, "mergewright.yaml", cfg + "\nsurprise: true\n");
  assert.deepEqual(codes(dir), ["config/schema"]);
  write(dir, "mergewright.yaml", cfg + "\nroles:\n  ghost: {model: x}\n");
  assert.deepEqual(codes(dir), ["config/role-override"]);
  write(dir, "mergewright.yaml", "name: [unclosed\n");
  assert.ok(codes(dir).includes("config/yaml"));
});

test("role and flow rules", () => {
  const dir = newProject();
  write(dir, "roles/helper.role.md", "---\nid: helper\nruns: local\nmodel: m\nmode: write\noutput: handoff\n---\nDo {{card}} and {{nonsense}}.\n");
  assert.deepEqual(codes(dir), ["role/mode", "role/placeholder"]);
  write(dir, "roles/helper.role.md", "---\nid: helper\nruns: shell\nmode: read\noutput: text\n---\nDo it.\n");
  assert.deepEqual(codes(dir), ["role/command"]);
  write(dir, "roles/helper.role.md", "---\nid: helper\nruns: claude\nmode: read\noutput: text\nmcps: [ghost]\n---\nDo it.\n");
  assert.deepEqual(codes(dir), ["role/unknown-mcp"]);
  fs.rmSync(path.join(dir, "roles/helper.role.md"));

  const flow = (body: string) => write(dir, "flows/mine.flow.yaml", `id: mine\nphases:\n${body}`);
  flow("  - {id: a, role: nobody}\n");
  assert.deepEqual(codes(dir), ["flow/unknown-role"]);
  flow("  - {id: a, gate: nonesuch}\n");
  assert.deepEqual(codes(dir), ["flow/unknown-gate"]);
  flow("  - {id: a}\n");
  assert.deepEqual(codes(dir), ["flow/empty-phase"]);
  flow("  - {id: a, role: worker, needs: [b]}\n  - {id: b, gate: default}\n");
  assert.deepEqual(codes(dir), ["flow/needs"]);
  flow("  - {id: a, role: worker, when: 'risk >= enormous'}\n");
  assert.deepEqual(codes(dir), ["flow/condition"]);
  flow("  - {id: a, role: worker, on: {fail: remediate}}\n");
  assert.deepEqual(codes(dir), ["flow/remediate"]);
  flow("  - {id: a, role: worker, on: {fail: elsewhere}}\n");
  assert.deepEqual(codes(dir), ["flow/on-target"]);
  flow("  - {id: a, role: worker}\n  - {id: a, gate: default}\n");
  assert.deepEqual(codes(dir), ["flow/duplicate-phase"]);
  flow("  - {id: a, role: planner, action: memory.update}\n");
  assert.deepEqual(codes(dir), ["flow/action-input"]);
  write(dir, "flows/mine.flow.yaml", "id: mine\nworktree: false\nphases:\n  - {id: a, role: worker}\n  - {id: m, action: merge}\n");
  assert.deepEqual(codes(dir), ["flow/merge", "flow/write"]);
  write(dir, "flows/mine.flow.yaml", "id: mine\nphases:\n  - {id: a, role: worker, on: {fail: remediate}}\nremediate: {phase: a, max_rounds: 1}\n");
  assert.deepEqual(codes(dir), []);
});

test("tracing: coverage follows the chain requirement -> card -> test", () => {
  const dir = newProject();
  write(dir, "specs/auth.spec.md", SPEC);
  const cov = () => Object.fromEntries(buildTrace(new Project(dir)).rows.map((r) => [r.req.id, coverage(r)]));
  assert.deepEqual(cov(), { "REQ-auth-001": "unplanned", "REQ-auth-002": "unplanned" });
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1", "implements: [REQ-auth-001, REQ-auth-002]\nscope: [src/**]\n"));
  assert.deepEqual(cov(), { "REQ-auth-001": "planned", "REQ-auth-002": "planned" });
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1", "implements: [REQ-auth-001, REQ-auth-002]\nscope: [src/**]\n").replace("status: todo", "status: done"));
  assert.deepEqual(cov(), { "REQ-auth-001": "built", "REQ-auth-002": "built" });
  // A finished 'must' requirement without a test is an error; a 'should' one is not (by default).
  assert.deepEqual(codes(dir), ["trace/untested"]);
  write(dir, "tests/auth_test.py", "# @req REQ-auth-001\ndef test_sign_in(): pass\n");
  assert.deepEqual(cov(), { "REQ-auth-001": "verified", "REQ-auth-002": "built" });
  assert.deepEqual(codes(dir), []);
  // A reference outside a test file does not count as a test.
  write(dir, "src/auth.py", "# implements @req REQ-auth-002\n");
  assert.equal(cov()["REQ-auth-002"], "built");
  // Several ids on one line, and an unknown id.
  write(dir, "tests/more.test.ts", "// @req REQ-auth-001, REQ-auth-002\n// @req REQ-auth-777\n");
  assert.equal(cov()["REQ-auth-002"], "verified");
  assert.deepEqual(codes(dir), ["trace/unknown-requirement"]);
  // Paths listed under trace.ignore are not scanned at all.
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace("  require_tests: must", "  require_tests: must\n  ignore: [tests/more.test.ts]"));
  assert.deepEqual(codes(dir), []);
  assert.equal(cov()["REQ-auth-002"], "built");
});

test("tracing also works outside a git repository", () => {
  const dir = tmpDir();
  init(dir, { name: "plain", prefix: "PL" });
  write(dir, "specs/auth.spec.md", SPEC);
  write(dir, "tests/a_test.go", "// @req REQ-auth-001\n");
  write(dir, "node_modules/x/test.js", "// @req REQ-auth-002\n");
  const rows = buildTrace(new Project(dir)).rows;
  assert.equal(rows[0]!.tests.length, 1);
  assert.equal(rows[1]!.tests.length, 0, "dependency folders are not scanned");
});

test("the command line reports problems and sets the exit code", () => {
  const dir = newProject();
  assert.equal(mw(dir, ["check"]).code, 0);
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1", "scope: [a]\n"));
  const r = mw(dir, ["check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /cards\/DEMO-1\.card\.md:1: error: a feature card must say which requirement/);
  const j = JSON.parse(mw(dir, ["check", "--json"]).out);
  assert.equal(j.ok, false);
  assert.equal(j.diagnostics[0].code, "card/no-requirement");
  assert.equal(mw(tmpDir(), ["check"]).code, 1, "outside a project");
  assert.equal(mw(dir, ["frobnicate"]).code, 2, "unknown command is a usage error");
  // --strict turns warnings into failures
  fs.rmSync(path.join(dir, "cards/DEMO-1.card.md"));
  write(dir, "cards/stray.txt", "x");
  assert.equal(mw(dir, ["check"]).code, 0);
  assert.equal(mw(dir, ["check", "--strict"]).code, 1);
});

test("the gate writes valid JSON even when its paths contain quotes or backslashes", () => {
  const dir = newProject();
  write(dir, "Makefile", "check:\n\t@echo fine\n");
  const logs = path.join(dir, 'lo"gs\\x');
  const out = path.join(dir, "gate.json");
  const r = spawnGate(dir, { MERGEWRIGHT_GATE_JSON: out, MERGEWRIGHT_GATE_LOGS: logs });
  assert.equal(r, 0);
  const summary = JSON.parse(read(dir, "gate.json"));
  assert.equal(summary.ok, true);
  assert.equal(summary.steps[0].log, path.join(logs, "make-check.log"));
  // A failing step still yields valid JSON and a non-zero exit.
  write(dir, "Makefile", "check:\n\t@exit 3\n");
  assert.notEqual(spawnGate(dir, { MERGEWRIGHT_GATE_JSON: out, MERGEWRIGHT_GATE_LOGS: logs }), 0);
  assert.equal(JSON.parse(read(dir, "gate.json")).ok, false);
});

function spawnGate(dir: string, env: Record<string, string>): number {
  return spawnSync(path.join(dir, "gates/default.gate.sh"), [], { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8" }).status ?? 1;
}

test("the per-machine secrets file fills in variables that are not already set", async () => {
  const { loadEnvFile } = await import("../src/cli.ts");
  const dir = tmpDir();
  write(dir, "env", "# comment\nMW_T_ONE=alpha\nexport MW_T_TWO=\"be ta\"\nMW_T_KEEP=from-file\n\nnot a line\n");
  process.env.MW_T_KEEP = "from-environment";
  try {
    loadEnvFile(path.join(dir, "env"));
    assert.equal(process.env.MW_T_ONE, "alpha");
    assert.equal(process.env.MW_T_TWO, "be ta");
    assert.equal(process.env.MW_T_KEEP, "from-environment", "the environment wins over the file");
    loadEnvFile(path.join(dir, "missing")); // a missing file is fine
  } finally {
    delete process.env.MW_T_ONE; delete process.env.MW_T_TWO; delete process.env.MW_T_KEEP;
  }
});

// ── Gaps found while the specification was written ─────────────────────────────────────────

test("a config override cannot create an invalid role", () => {
  const dir = newProject();
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml") + "\nroles:\n  worker: {runs: local, model: m}\n");
  assert.deepEqual(codes(dir), ["role/mode"]);
});

test("a deprecated spec deprecates its requirements", () => {
  const dir = newProject();
  write(dir, "specs/auth.spec.md", SPEC.replace("status: accepted", "status: deprecated"));
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1", "implements: [REQ-auth-001]\nscope: [src/**, docs/**]\n"));
  assert.deepEqual(codes(dir), ["card/deprecated-requirement"]);
  assert.equal(buildTrace(new Project(dir)).rows.every((r) => coverage(r) === "deprecated"), true);
});

test("also-roles, nested stray files and unsupported MCP assignments are checked", () => {
  const dir = newProject();
  write(dir, "flows/mine.flow.yaml", "id: mine\nworktree: false\nphases:\n  - {id: a, role: reviewer, also: [{role: worker}]}\n");
  assert.deepEqual(codes(dir), ["flow/write"]);
  write(dir, "flows/mine.flow.yaml", "id: mine\nphases:\n  - {id: a, role: reviewer, also: [{role: worker}]}\n");
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1", "kind: chore\nflow: mine\n"));
  assert.deepEqual(codes(dir), ["card/scope"], "a flow that writes only through an also-role still needs a scope");
  fs.rmSync(path.join(dir, "cards/DEMO-1.card.md")); fs.rmSync(path.join(dir, "flows/mine.flow.yaml"));

  write(dir, "specs/changes/notes.txt", "x");
  write(dir, "memory/lessons/draft.txt", "x");
  assert.deepEqual(codes(dir), ["layout/stray-file", "layout/stray-file"]);
  fs.rmSync(path.join(dir, "specs/changes/notes.txt")); fs.rmSync(path.join(dir, "memory/lessons/draft.txt"));

  write(dir, "mcps/docs.mcp.yaml", "id: docs\ntransport: http\nurl: http://x/mcp\nroles: [planner, worker]\n");
  assert.deepEqual(codes(dir), [], "the preset's planner runs on Claude, which takes project servers");
  write(dir, "mergewright.yaml", `${read(dir, "mergewright.yaml")}\nroles:\n  planner: {runs: local, model: m}\n`);
  assert.deepEqual(codes(dir), ["role/mcp-unsupported"], "a planner moved to the local harness cannot be given project servers (nor to a package's: packages-hermes)");
});

test("the line cap is counted the same way everywhere", () => {
  const dir = newProject();
  // exactly 150 lines, with trailing blank lines: allowed by both the command and the check
  const text = "# State\n" + "x\n".repeat(149) + "\n\n";
  write(dir, "memory/STATE.md", text);
  assert.deepEqual(codes(dir), []);
  write(dir, "memory/STATE.md", "# State\n" + "x\n".repeat(150));
  assert.deepEqual(codes(dir), ["memory/too-long"]);
});

test("default test globs match test files, not product files that merely contain the word", () => {
  const dir = newProject();
  write(dir, "specs/auth.spec.md", SPEC);
  for (const f of ["src/inspector.ts", "src/latest.js", "src/contest/rules.py"]) write(dir, f, "// @req REQ-auth-001\n");
  assert.equal(buildTrace(new Project(dir)).rows[0]!.tests.length, 0);
  assert.equal(buildTrace(new Project(dir)).rows[0]!.references.length, 3);
  for (const f of ["src/auth.test.ts", "pkg/auth_test.go", "tests/x.py", "test_auth.py", "src/__tests__/a.js", "app/AuthTest.java", "spec/auth_spec.rb"]) write(dir, f, "// @req REQ-auth-001\n");
  assert.equal(buildTrace(new Project(dir)).rows[0]!.tests.length, 7);
});

test("protected changes are refused from inside a card run", () => {
  const dir = newProject();
  write(dir, "specs/auth.spec.md", SPEC);
  const asWorker = { MW_ROLE: "worker" };
  const memory = () => fs.readdirSync(path.join(dir, "memory"), { recursive: true }).map(String).sort().join("\n") + read(dir, "memory/INDEX.md");
  const before = memory();
  for (const args of [
    ["config", "set", "limits.rounds", "9"], ["eject", "role", "worker"], ["mcp", "add", "x", "--url", "http://x"], ["memory", "state", "--file", "memory/STATE.md"],
    // Lessons and decisions are filed by the reflection from the handoff, not by agents.
    ["memory", "add", "lesson", "--topic", "t", "--title", "T", "--body", "B"], ["memory", "add", "decision", "--title", "T", "--body", "B"],
  ]) {
    const r = mw(dir, args, asWorker);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, /is done by the owner, not from inside a card run/);
  }
  assert.equal(new Project(dir).config.limits.rounds, 2);
  assert.equal(memory(), before, "no lesson or decision was written");
  // Proposing a spec change remains open to agents; the owner still adds lessons.
  assert.equal(mw(dir, ["spec", "propose", "auth", "--summary", "Idea"], asWorker).code, 0);
  assert.equal(mw(dir, ["memory", "add", "lesson", "--topic", "t", "--title", "T", "--body", "B"]).code, 0);
});

test("gate.env names the variables gates may see; a card's tags can ask for the deep review", () => {
  const dir = newProject();
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml") + "\ngate:\n  env: [DATABASE_URL]\n");
  assert.deepEqual(new Project(dir).config.gate.env, ["DATABASE_URL"]);
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace("[DATABASE_URL]", "['not a name']"));
  assert.deepEqual(codes(dir), ["config/schema"]);
  const d2 = newProject();
  assert.deepEqual(new Project(d2).config.gate.env, []);
  write(d2, "cards/DEMO-1.card.md", card("DEMO-1", "kind: chore\nscope: [a]\ntags: [Auth, ui]\n"));
  write(d2, "cards/DEMO-2.card.md", card("DEMO-2", "kind: chore\nscope: [a]\ntags: [ui]\n"));
  write(d2, "cards/DEMO-3.card.md", card("DEMO-3", "kind: chore\nscope: [a]\ndeep_review: true\n"));
  const p = new Project(d2);
  assert.deepEqual(p.cards().map((c) => p.deepReviewOf(c)), [true, false, true]);
});

test("init uses a remote as the hub only when the owner named it 'hub'", () => {
  const withOrigin = tmpDir();
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: withOrigin });
  spawnSync("git", ["remote", "add", "origin", "https://example.test/owner/repo.git"], { cwd: withOrigin });
  assert.equal(init(withOrigin, { name: "a", prefix: "A" }).hub, "none");
  assert.match(read(withOrigin, "mergewright.yaml"), /hub: none/);
  const withHub = tmpDir();
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: withHub });
  spawnSync("git", ["remote", "add", "hub", "/tmp/somewhere.git"], { cwd: withHub });
  assert.equal(init(withHub, { name: "b", prefix: "B" }).hub, "hub");
});

test("the standard preset runs on Claude Code and Codex only: a new project's first card needs no package harness", () => {
  const roles = new Project(newProject()).roles();
  const runs = Object.fromEntries([...roles.values()].map((r) => [r.id, r.runs]));
  for (const id of ["planner", "adjudicator", "reflector", "worker", "docs-writer"]) assert.equal(runs[id], "claude", id);
  for (const id of ["reviewer", "reviewer-deep", "redteam"]) assert.equal(runs[id], "codex", id);
  assert.equal(roles.get("planner")!.model, "sonnet");
});
