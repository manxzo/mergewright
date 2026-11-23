// Regression tests for skipped gate steps, approvals with conditions, and card status.
//   1. Skipped gate steps and the adjudicator's conditions stop the merge: the gate result
//      exposes skipped steps (conditions, prompts), `gate.required` fails a gate that skipped a
//      required step, an approval with `conditions` stops at the stop point `conditions` before the
//      merge, and `follow_ups` become todo cards after it.
//   2. A card's status and its run's agree: moving a card between todo and ready sets a blocked
//      or aborted run aside, so the card file, `mw status` and the board agree.
//   3. Runs record which harness and model ran each phase; mw_run_status returns them and the usage.
//   4. Empty per-run Codex home folders are removed.
//   5. mw doctor warns when an installed Hermes skill differs from the shipped one (a check of the hermes package now).
//   6. The Hermes skill and the hermes package's README carry the readiness check and the Claude Code login recipe.
// Only long-standing symbols are imported statically (newer ones through namespace imports), so a
// missing newer one fails its own test instead of the whole file.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as commandsIntegrations from "../src/commands-integrations.ts";
import * as codex from "../src/engine/harness/codex.ts";
import * as expr from "../src/expr.ts";
import * as runModule from "../src/engine/run.ts";
import { approve, cardStatuses, describeRun } from "../src/engine/run.ts";
import type { HarnessRequest } from "../src/engine/types.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { callTool, TOOLS } from "../src/mcpserver/server.ts";
import type { ToolContext } from "../src/mcpserver/tool.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { parseFlow } from "../src/model/flow.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { Project } from "../src/project.ts";
import { loadSchema } from "../src/schemas.ts";
import { addPackage, git, mw, read, tmpDir, write } from "./helpers.ts";
import { adjudication, branchExists, brief, fakeHub, fakeIntegrations, finding, findings, project, promptFiles, run, runPath, script, state, subjects, useScript } from "./engine-helpers.ts";

/** A newer symbol of a module, failing this test (not the whole file) when it is missing. */
function added<T>(mod: object, name: string): T {
  const v = (mod as Record<string, unknown>)[name];
  assert.ok(v !== undefined, `${name} does not exist`);
  return v as T;
}

function ctxFor(dir: string): ToolContext {
  return { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined };
}

async function call(dir: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, name);
  const cwd = process.cwd();
  try {
    const r = await callTool(tool, args, ctxFor(dir));
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  } finally {
    process.chdir(cwd);
  }
}

/** A gate that passes, with step `db_api` reported as skipped because DATABASE_URL is not set. */
const SKIPPING_GATE = `#!/usr/bin/env bash
set -u
mkdir -p "$MERGEWRIGHT_GATE_LOGS"
log="$MERGEWRIGHT_GATE_LOGS/check.log"
echo "all fine" > "$log"
printf '{"ok":true,"steps":[{"name":"check","kind":"test","ok":true,"seconds":0,"log":"%s"},{"name":"db_api","kind":"test","ok":true,"seconds":0,"skipped":true,"reason":"DATABASE_URL not set"}]}\\n' "$log" > "$MERGEWRIGHT_GATE_JSON"
exit 0
`;

function skippingProject(required?: string[]): string {
  const dir = project();
  write(dir, "gates/default.gate.sh", SKIPPING_GATE);
  fs.chmodSync(path.join(dir, "gates/default.gate.sh"), 0o755);
  if (required) write(dir, "mergewright.yaml", `${read(dir, "mergewright.yaml").trimEnd()}\ngate:\n  required: [${required.join(", ")}]\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "skipping gate");
  return dir;
}

const CONDITION = { what: "Run the DB API tests against a database", how: "set DATABASE_URL to a test database, then npm run test:db" };

test("a gate that skips a step gate.required lists fails it and the run blocks before the merge", async () => {
  useScript(script());
  const dir = skippingProject(["db_api"]);
  // On a runtime without gate.required the configuration is invalid and the roles' mock overrides
  // would not apply: stop here rather than start real agents.
  assert.deepEqual(new Project(dir).diag.items.filter((d) => d.severity === "error").map((d) => d.message), [], "gate.required is a valid key");
  const s = await run(dir);
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason ?? "", /gate\/required-skipped/);
  assert.match(s.reason ?? "", /db_api \(DATABASE_URL not set\)/);
  const gate = s.history.find((h) => h.phase === "gate");
  assert.equal(gate?.outcome, "block", "a worker cannot fix a missing variable: no remediation round is spent");
  assert.equal(s.round, 0);
  assert.equal(s.merged, undefined);
  assert.ok(!subjects(dir).includes("DEMO-1: Card DEMO-1"), "nothing was merged");
  const g = JSON.parse(fs.readFileSync(runPath(dir, "gate.json"), "utf8")) as { ok: boolean; steps: { name: string; skipped?: boolean; reason?: string }[] };
  assert.equal(g.ok, false, "the gate counts as failed");
  assert.deepEqual(g.steps.find((x) => x.name === "db_api"), { name: "db_api", kind: "test", ok: true, seconds: 0, skipped: true, reason: "DATABASE_URL not set" });
});

test("skipped gate steps reach flow conditions and the review prompt, and the gate detail names them", async () => {
  assert.equal(expr.checkExpr("gate.skipped > 0"), undefined);
  assert.equal(expr.checkExpr("gate.skipped_names == db_api"), undefined);
  assert.equal(expr.checkExpr("adjudication.conditions > 0"), undefined);
  assert.equal(expr.checkExpr("adjudication.follow_ups >= 1"), undefined);
  assert.match(expr.checkExpr("gate.skipped_names > db_api") ?? "", /list of names/);
  const vars = { "gate.skipped": 1, "gate.skipped_names": ["db_api"] } as unknown as expr.Vars;
  assert.equal(expr.evalExpr("gate.skipped > 0 and gate.skipped_names == db_api", vars), true);
  assert.equal(expr.evalExpr("gate.skipped_names != db_api", vars), false);
  assert.equal(expr.evalExpr("gate.skipped_names == lint", vars), false);

  useScript(script());
  const dir = skippingProject();
  const s = await run(dir, { until: "adjudicate" });
  assert.equal(s.status, "running", s.reason);
  assert.match(s.history.find((h) => h.phase === "gate")?.detail ?? "", /NOT run: db_api \(DATABASE_URL not set\)/);
  const [review] = promptFiles(dir, /-review-reviewer\.prompt\.md$/);
  assert.match(review ?? "", /- db_api: NOT RUN \(DATABASE_URL not set\)/);
  assert.match(review ?? "", /Gate steps NOT run: db_api \(DATABASE_URL not set\)/);
});

test("an approval with conditions waits at 'conditions' before the merge; mw approve <ID> conditions merges", async () => {
  useScript(script({
    reviewer: [{ output: findings([finding("R-01", true)]) }],
    adjudicator: [{ output: adjudication("approve", { rejected: [{ id: "reviewer:R-01", reason: "out of scope for this card" }], accepted: [], conditions: [CONDITION] }) }],
  }));
  const dir = project();
  const integrations = fakeIntegrations();
  const s = await run(dir, {}, { integrations });
  assert.equal(s.status, "waiting", s.reason);
  assert.equal(s.reason, "conditions");
  assert.equal(s.history[s.history.length - 1]?.phase, "merge");
  assert.deepEqual((s as { conditions?: unknown }).conditions, [CONDITION]);
  assert.equal(s.merged, undefined);
  assert.ok(!subjects(dir).includes("DEMO-1: Card DEMO-1"), "nothing was merged");
  assert.match(s.history[s.history.length - 1]?.detail ?? "", /Run the DB API tests/);
  const note = integrations.of("notify").map((c) => String(c.args[1])).join("\n");
  assert.match(note, /Run the DB API tests against a database \(how: set DATABASE_URL to a test database/);
  const said = describeRun(new Project(dir), s);
  assert.match(said, /Run the DB API tests/);
  assert.match(said, /mw approve DEMO-1 conditions/);

  // The MCP tool checks the word against the one the run waits for.
  const wrong = await call(dir, "mw_approve", { id: "DEMO-1", word: "merge" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /waits for 'conditions'/);

  const after = await approve(new Project(dir), "DEMO-1", "conditions", {}, { hub: fakeHub(), integrations: fakeIntegrations() });
  assert.equal(after.status, "done", after.reason);
  assert.ok(after.merged);
  assert.ok(after.approvals.includes("merge:conditions"));
});

test("the preset flows hold the merge for conditions; a merge phase of any flow does", () => {
  const diag = new Diagnostics();
  const file = path.join(PACKAGE_ROOT, "presets", "standard", "flows", "standard.flow.yaml");
  const flow = parseFlow(file, fs.readFileSync(file, "utf8"), "standard", diag);
  assert.deepEqual(diag.items, []);
  const merge = flow!.phases.find((p) => p.id === "merge") as unknown as { stops: { when: string; ask: string }[] };
  assert.deepEqual(merge.stops, [{ when: "adjudication.conditions > 0", ask: "conditions" }, { when: "risk >= high", ask: "merge" }]);
  const stopsOf = added<(p: unknown) => { ask: string }[]>(runModule, "stopsOf");
  const bare = parseFlow("flows/x.flow.yaml", "id: x\nphases:\n  - id: merge\n    action: merge\n", "project", new Diagnostics());
  assert.deepEqual(stopsOf(bare!.phases[0]).map((x) => x.ask), ["conditions"], "a merge phase without the stop still gets it");
});

test("follow-ups become todo cards after the merge, committed with the reflection", async () => {
  useScript(script({
    reviewer: [{ output: findings([finding("R-01", true)]) }],
    adjudicator: [{ output: adjudication("approve", { rejected: [{ id: "reviewer:R-01", reason: "out of scope for this card" }], follow_ups: [
      { title: "Index the orders table", why: "the review found a slow query", scope: ["db/**"], kind: "fix" },
      { title: "Document the orders API", why: "the guide does not cover it" },
    ] }) }],
  }));
  const dir = project();
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  assert.deepEqual((s as { followUps?: string[] }).followUps, ["DEMO-2", "DEMO-3"]);
  const reflect = s.history.find((h) => h.phase === "reflect");
  assert.match(reflect?.detail ?? "", /follow-up card\(s\): DEMO-2, DEMO-3/);
  const subject = "DEMO-1: update project memory, add follow-up cards DEMO-2, DEMO-3";
  assert.ok(subjects(dir).includes(subject), subjects(dir).join("\n"));
  const files = git(dir, "show", "--name-only", "--format=", `:/${subject}`).split("\n");
  assert.ok(files.includes("cards/DEMO-2.card.md") && files.includes("cards/DEMO-3.card.md") && files.some((f) => f.startsWith("memory/")), files.join(", "));
  const two = parseFrontmatter(git(dir, "show", "main:cards/DEMO-2.card.md"));
  assert.equal(two.data.status, "todo");
  assert.equal(two.data.kind, "fix");
  assert.equal(two.data.risk, "medium");
  assert.deepEqual(two.data.scope, ["db/**", "docs/**", "README.md"], "plus the documentation paths");
  assert.match(two.body, /Follow-up from DEMO-1 adjudication: the review found a slow query/);
  const three = parseFrontmatter(git(dir, "show", "main:cards/DEMO-3.card.md"));
  assert.equal(three.data.kind, "chore");
  assert.deepEqual(three.data.scope, ["src/**", "docs/**", "README.md"], "the parent's scope, plus the documentation paths");
  assert.match(three.body, /Follow-up from DEMO-1 adjudication: the guide does not cover it/);
});

test("Codex gets the adjudication schema with its optional fields required and nullable", () => {
  const strictSchema = added<(s: object) => Record<string, unknown>>(codex, "strictSchema");
  const original = loadSchema("output.adjudication");
  const strict = strictSchema(original) as { required: string[]; properties: Record<string, { type?: unknown; items?: { required: string[] } }> };
  assert.deepEqual([...strict.required].sort(), ["accepted", "conditions", "follow_ups", "instructions", "rejected", "summary", "verdict"]);
  assert.deepEqual(strict.properties.conditions?.type, ["array", "null"]);
  assert.deepEqual([...(strict.properties.follow_ups as { anyOf?: unknown } & { items?: { required: string[] } }).items?.required ?? []].sort(), ["kind", "risk", "scope", "title", "why"]);
  const findingsSchema = loadSchema("output.findings");
  assert.equal(strictSchema(findingsSchema), findingsSchema, "a schema with nothing optional is passed as it is");
  const dropNulls = added<(v: unknown, s: object) => unknown>(codex, "dropNulls");
  assert.deepEqual(dropNulls({ verdict: "approve", conditions: null, follow_ups: [{ title: "t", why: "w", scope: null, kind: null }] }, original), { verdict: "approve", follow_ups: [{ title: "t", why: "w" }] });
});

test("mw_card_set_status on a card whose run is blocked aborts that run and sets its record aside", async () => {
  useScript(script({ planner: [{ output: brief({ ready: false, blockers: ["the card needs the owner's numbers"] }) }] }));
  const dir = project();
  write(dir, "cards/DEMO-1.card.md", read(dir, "cards/DEMO-1.card.md").replace("status: todo", "status: ready"));
  git(dir, "commit", "-qam", "ready");
  const s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.deepEqual(cardStatuses(new Project(dir)).map((r) => r.status), ["blocked"]);

  const r = await call(dir, "mw_card_set_status", { id: "DEMO-1", status: "todo" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /blocked run was aborted/);
  assert.match(r.text, /ready -> todo/);
  assert.equal(fs.existsSync(runPath(dir)), false, "the run record was moved aside");
  const discarded = fs.readdirSync(path.join(dir, ".mergewright", "local", "discarded"));
  assert.ok(discarded.some((n) => /^DEMO-1-run-\d{4}-/.test(n)), discarded.join(", "));
  assert.ok(branchExists(dir, "card/DEMO-1"), "the branch is kept");
  assert.equal(fs.existsSync(path.join(dir, ".mergewright", "worktrees", "DEMO-1")), false, "the worktree was moved aside");
  // One status everywhere: the card file, mw status and mw_status.
  assert.equal(parseFrontmatter(read(dir, "cards/DEMO-1.card.md")).data.status, "todo");
  assert.deepEqual(cardStatuses(new Project(dir)).map((x) => x.status), ["todo"]);
  assert.ok(subjects(dir).includes("card: DEMO-1 todo"));
  const again = await call(dir, "mw_card_set_status", { id: "DEMO-1", status: "ready" });
  assert.equal(again.isError, false, again.text);
  assert.deepEqual(cardStatuses(new Project(dir)).map((x) => x.status), ["ready"]);
});

test("the board follows (aborted, then the card's status) and mw card status <ID> does the same from the command line", async () => {
  useScript(script({ planner: [{ output: brief({ ready: false, blockers: ["not ready"] }) }] }));
  const dir = project();
  assert.equal((await run(dir)).status, "blocked");
  const setAsideRun = added<(p: Project, id: string, d: object) => Promise<string | undefined>>(runModule, "setAsideRun");
  const mirrorCardStatus = added<(p: Project, id: string, status: string, d: object) => Promise<string | undefined>>(runModule, "mirrorCardStatus");
  const integrations = fakeIntegrations();
  const note = await setAsideRun(new Project(dir), "DEMO-1", { hub: fakeHub(), integrations });
  assert.match(note ?? "", /aborted.*run record was moved/);
  await mirrorCardStatus(new Project(dir), "DEMO-1", "todo", { integrations });
  assert.deepEqual(integrations.of("mirrorCard").map((c) => c.args[2]), ["aborted", "todo"]);
  assert.deepEqual(cardStatuses(new Project(dir)).map((x) => x.status), ["todo"]);

  useScript(script({ planner: [{ output: brief({ ready: false, blockers: ["not ready"] }) }] }));
  const other = project();
  assert.equal((await run(other)).status, "blocked");
  const r = mw(other, ["card", "status", "DEMO-1", "ready"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /blocked run was aborted/);
  const rows = JSON.parse(mw(other, ["status", "--json"]).out) as { status: string }[];
  assert.deepEqual(rows.map((x) => x.status), ["ready"]);
  assert.equal(parseFrontmatter(read(other, "cards/DEMO-1.card.md")).data.status, "ready");
});

test("history entries carry the harness and model of each role; mw_run_status returns them and the usage", async () => {
  useScript(script());
  const dir = project({ roles: { planner: { model: "plan-model", provider: "acme" } } });
  const s = await run(dir, { until: "review" });
  const brief0 = s.history.find((h) => h.phase === "brief") as { harness?: Record<string, string>; model?: Record<string, string> } | undefined;
  assert.deepEqual(brief0?.harness, { planner: "mock" });
  assert.deepEqual(brief0?.model, { planner: "acme/plan-model" });
  const impl = s.history.find((h) => h.phase === "implement") as { harness?: Record<string, string> } | undefined;
  assert.deepEqual(impl?.harness, { worker: "mock" });
  assert.equal((s.history.find((h) => h.phase === "gate") as { harness?: unknown }).harness, undefined, "a gate runs no agent");

  const r = await call(dir, "mw_run_status", { id: "DEMO-1" });
  assert.equal(r.isError, false, r.text);
  const out = JSON.parse(r.text) as { history: { phase: string; harness?: Record<string, string>; model?: Record<string, string>; usage?: { inputTokens?: number } }[]; usage?: { summary: string }; agents?: { role: string; harness: string; model: string }[] };
  const b = out.history.find((h) => h.phase === "brief");
  assert.deepEqual(b?.harness, { planner: "mock" });
  assert.deepEqual(b?.model, { planner: "acme/plan-model" });
  assert.ok((b?.usage?.inputTokens ?? 0) > 0);
  assert.match(out.usage?.summary ?? "", /^mock [\d,]+ in \/ [\d,]+ out tokens$/);
  assert.deepEqual(out.agents?.find((x) => x.role === "planner"), { role: "planner", harness: "mock", model: "acme/plan-model" });
  assert.equal(state(dir).history.length, s.history.length);
});

test("a per-run Codex home's clean-up removes the card's folder when it is empty; the sweep removes empty folders silently", () => {
  const root = tmpDir("mw-codexhome-");
  const runDir = path.join(root, ".mergewright", "runs", "DEMO-1");
  fs.mkdirSync(runDir, { recursive: true });
  const owner = path.join(root, "owner");
  fs.mkdirSync(owner);
  fs.writeFileSync(path.join(owner, "auth.json"), "{}\n");
  const req = { runDir, label: "03-review-reviewer" } as HarnessRequest;
  const { home, cleanup } = codex.prepareCodexHome(req, owner);
  assert.equal(home, path.join(root, ".mergewright", "local", "codex-home", "DEMO-1", "03-review-reviewer"));
  assert.ok(fs.existsSync(path.join(home, "auth.json")));
  cleanup();
  assert.equal(fs.existsSync(home), false);
  assert.equal(fs.existsSync(path.dirname(home)), false, "the card's folder went with its last home");
  assert.ok(fs.existsSync(path.join(root, ".mergewright", "local", "codex-home")), "codex-home itself stays");

  const dir = project();
  const empty = path.join(dir, ".mergewright", "local", "codex-home", "DEMO-1");
  fs.mkdirSync(empty, { recursive: true });
  assert.deepEqual(runModule.sweepCodexHomes(new Project(dir)), [], "no warning for an empty folder");
  assert.equal(fs.existsSync(empty), false);
  const full = path.join(dir, ".mergewright", "local", "codex-home", "DEMO-2", "01-brief-planner");
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, "auth.json"), "{}\n");
  assert.equal(runModule.sweepCodexHomes(new Project(dir)).length, 1, "a home with a login in it is still reported");
});

test("mw doctor warns when an installed Hermes skill differs from the one the hermes package ships", async () => {
  const saved = { HERMES_HOME: process.env.HERMES_HOME, HOME: process.env.HOME };
  const scratch = tmpDir("mw-hermes-");
  process.env.HERMES_HOME = path.join(scratch, "hermes");
  process.env.HOME = path.join(scratch, "home");
  try {
    const dir = project();
    addPackage(dir, "hermes");
    const shipped = fs.readFileSync(path.join(PACKAGE_ROOT, "packages", "hermes", "SKILL.md"), "utf8");
    const own = path.join(scratch, "hermes", "skills", "mergewright", "SKILL.md");
    const shared = path.join(scratch, "hermes", "shared-skills", "mergewright", "SKILL.md");
    const doctor = async () => {
      const lines: string[] = [];
      await commandsIntegrations.doctor((l?: string) => { lines.push(l ?? ""); }, new Project(dir));
      return lines.filter((l) => l.startsWith("hermes") && /NOT ok/.test(l));
    };
    assert.deepEqual(await doctor(), [], "nothing installed: nothing to warn about");
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, shipped);
    assert.deepEqual(await doctor(), [], "an up-to-date skill: nothing to warn about");
    fs.writeFileSync(own, "---\nname: mergewright\n---\nan older skill\n");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, "an older shared skill\n");
    const lines = await doctor();
    assert.equal(lines.length, 2, lines.join("\n"));
    assert.match(lines[0]!, new RegExp(`${own.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} differs .*run 'mw hermes init' to update`));
    assert.match(lines[1]!, /shared-skills.*run 'mw hermes init --shared' to update/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("the Hermes skill checks a card can be done before readying it; the package's README has the Claude Code login recipe", () => {
  const skill = fs.readFileSync(path.join(PACKAGE_ROOT, "packages", "hermes", "SKILL.md"), "utf8");
  assert.match(skill, /Before .*ready/i);
  assert.match(skill, /mw_delegate[^\n]*planner[^\n]*advise[^\n]*brief/);
  assert.match(skill, /allow_protected/);
  assert.match(skill, /-t mergewright-<project>/);
  assert.match(skill, /mw_approve <id> conditions/);
  const doc = fs.readFileSync(path.join(PACKAGE_ROOT, "packages", "hermes", "README.md"), "utf8");
  assert.match(doc, /provider: claude-code/);
  assert.match(doc, /\.claude\/\.credentials\.json/);
  assert.match(doc, /adopt_external_logins/);
  assert.match(doc, /openai-codex[^\n]*(does not|not) reuse[^\n]*\.codex\/auth\.json/);
  assert.match(doc, /hermes auth status anthropic/);
});
