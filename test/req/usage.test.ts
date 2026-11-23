// Usage accounting (specs/usage.spec.md): Claude's input split into fresh, cache-write and
// cache-read tokens plus turns, summed per harness and shown by every report. The fixture is LL-69's
// implement phase: 54 fresh, 73,426 cache-write and 1,379,004 cache-read input tokens.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { claudeUsage, type ClaudeResult } from "../../src/engine/harness/claude.ts";
import { cardStatuses, runCard, Stopped, usageTotals } from "../../src/engine/run.ts";
import { integrationsFor } from "../../src/integrations.ts";
import { pausedFlag, usageGate, type UsageSettings } from "../../src/integrations/usage.ts";
import type { RunState, Usage } from "../../src/engine/types.ts";
import { callTool, TOOLS } from "../../src/mcpserver/server.ts";
import { Project } from "../../src/project.ts";
import { work } from "../../src/work.ts";
import { git, mw, read, tmpDir, write } from "../helpers.ts";
import { adjudication, brief, counters, fakeHub, fakeIntegrations, finding, findings, GATE, handoff, phases, project, reflection, run, runPath, script, state, useScript, type Script } from "../engine-helpers.ts";

const FRESH = 54;
const WRITE = 73_426;
const READ = 1_379_004;
const INPUT = 1_452_484;

/** Claude's `--output-format json` result for LL-69's implement phase. */
const LL69: ClaudeResult = {
  type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 1.28, num_turns: 41,
  usage: { input_tokens: FRESH, cache_creation_input_tokens: WRITE, cache_read_input_tokens: READ, output_tokens: 9_100 },
};

const SPLIT_KEYS = ["freshInputTokens", "cacheWriteTokens", "cacheReadTokens", "turns"] as const;

function entry(phase: string, usageBy: Record<string, Usage>): RunState["history"][number] {
  return { phase, roles: [], outcome: "ok", detail: "", round: 0, started: "2026-10-07T00:00:00.000Z", seconds: 1, usageBy };
}

/** A finished run of DEMO-1 whose implement phase reported LL-69's split and whose review ran on Codex. */
function ll69State(): RunState {
  const claude = claudeUsage(LL69)!;
  return {
    card: "DEMO-1", flow: "standard", phase: 3, round: 0, status: "waiting", reason: "merge", approvals: [],
    host: "test", started: "2026-10-07T00:00:00.000Z", updated: "2026-10-07T00:00:00.000Z", warnings: [],
    history: [
      entry("brief", { claude: { inputTokens: 1_000, outputTokens: 200, costUsd: 0.1, freshInputTokens: 1_000, turns: 1 } }),
      entry("implement", { claude }),
      entry("review", { codex: { inputTokens: 30_000, outputTokens: 1_500 } }),
    ],
  } as RunState;
}

function writeRun(dir: string, s: RunState): void {
  fs.mkdirSync(runPath(dir), { recursive: true });
  fs.writeFileSync(runPath(dir, "state.json"), JSON.stringify(s, null, 2));
}

// ── REQ-usage-001 ───────────────────────────────────────────────────────────────────────────

// @req REQ-usage-001
test("REQ-usage-001 AC-1: a Claude result with fresh, cache-write and cache-read input is kept split, inputTokens is their sum", () => {
  const u = claudeUsage(LL69)!;
  assert.equal(u.freshInputTokens, FRESH);
  assert.equal(u.cacheWriteTokens, WRITE);
  assert.equal(u.cacheReadTokens, READ);
  assert.equal(u.inputTokens, INPUT);
  assert.equal(u.outputTokens, 9_100);
  assert.equal(u.costUsd, 1.28);
});

// @req REQ-usage-001
test("REQ-usage-001 AC-2: a Claude result's num_turns becomes Usage.turns; a result without it leaves turns absent", () => {
  assert.equal(claudeUsage(LL69)!.turns, 41);
  const { num_turns: _, ...noTurns } = LL69;
  assert.equal("turns" in claudeUsage(noTurns)!, false);
  // A part the result does not report as a number is left out, not set to 0.
  const u = claudeUsage({ usage: { input_tokens: 10, output_tokens: 2 } })!;
  assert.deepEqual(u, { inputTokens: 10, outputTokens: 2, freshInputTokens: 10 });
});

// @req REQ-usage-001
test("REQ-usage-001 AC-3: a harness that reports only totals stores no split fields, not zeros", async () => {
  // The mock harness, like Codex, reports total input and output tokens only.
  useScript(script());
  const dir = project();
  await run(dir, { until: "review" });
  const stored = state(dir).history.filter((h) => h.usage);
  assert.ok(stored.length > 0, "the phases recorded usage");
  for (const h of stored) {
    for (const u of [h.usage!, ...Object.values(h.usageBy ?? {})]) {
      assert.ok((u.inputTokens ?? 0) > 0);
      for (const k of SPLIT_KEYS) assert.equal(k in u, false, `${h.phase}: ${k} is absent`);
    }
  }
  const t = usageTotals(state(dir))!;
  for (const k of SPLIT_KEYS) assert.equal(k in t.byHarness.mock!, false, `totals: ${k} is absent`);
  assert.match(t.summary, /^mock [\d,]+ in \/ [\d,]+ out tokens$/);
});

// ── REQ-usage-002 ───────────────────────────────────────────────────────────────────────────

// @req REQ-usage-002
test("REQ-usage-002 AC-1: usageTotals sums fresh, cache-write, cache-read and turns per harness next to the input sum", () => {
  const t = usageTotals(ll69State())!;
  const c = t.byHarness.claude!;
  assert.equal(c.inputTokens, INPUT + 1_000);
  assert.equal(c.freshInputTokens, FRESH + 1_000);
  assert.equal(c.cacheWriteTokens, WRITE, "summed only over the phases that reported it");
  assert.equal(c.cacheReadTokens, READ);
  assert.equal(c.turns, 42);
  assert.equal(c.outputTokens, 9_300);
  assert.ok(Math.abs(c.costUsd! - 1.38) < 1e-9);
  assert.deepEqual(t.byHarness.codex, { inputTokens: 30_000, outputTokens: 1_500 }, "Codex stays tokens only, with no split");
  assert.equal(t.summary, "Claude $1.38 (input 1,054 fresh, 1,452,430 cached: 73,426 written, 1,379,004 read; 42 turns); Codex 30,000 in / 1,500 out tokens");
  // A run recorded before the split (totals only, or one entry without per-harness usage) still sums.
  const old = { history: [entry("p", { claude: { inputTokens: 100, outputTokens: 10, costUsd: 0.25 } }), { ...entry("q", {}), usageBy: undefined, usage: { inputTokens: 5 } }] } as unknown as RunState;
  assert.equal(usageTotals(old)!.summary, "Claude $0.25; unattributed 5 in / 0 out tokens");
});

// @req REQ-usage-002
test("REQ-usage-002 AC-2: 'mw status <ID> --json' and mw_run_status include the split fields", async () => {
  const dir = project();
  writeRun(dir, ll69State());
  const r = mw(dir, ["status", "DEMO-1", "--json"]);
  assert.equal(r.code, 0, r.err);
  const rows = JSON.parse(r.out) as { id: string; usage?: { byHarness: Record<string, Record<string, number>>; summary: string } }[];
  assert.deepEqual(rows.map((x) => x.id), ["DEMO-1"]);
  const c = rows[0]!.usage!.byHarness.claude!;
  assert.equal(c.freshInputTokens, FRESH + 1_000);
  assert.equal(c.cacheWriteTokens, WRITE);
  assert.equal(c.cacheReadTokens, READ);
  assert.equal(c.turns, 42);
  assert.equal(c.inputTokens, INPUT + 1_000);
  assert.deepEqual(rows[0]!.usage, cardStatuses(new Project(dir))[0]!.usage, "the same totals as usageTotals()");

  const tool = TOOLS.find((t) => t.name === "mw_run_status")!;
  const cwd = process.cwd();
  let text: string;
  try {
    const res = await callTool(tool, { id: "DEMO-1" }, { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined });
    assert.notEqual(res.isError, true);
    text = res.content.map((x) => x.text).join("\n");
  } finally {
    process.chdir(cwd);
  }
  const out = JSON.parse(text) as { usage: { byHarness: Record<string, Record<string, number>>; summary: string }; history: { phase: string; usageBy?: Record<string, Usage> }[] };
  assert.deepEqual(out.usage, rows[0]!.usage);
  assert.equal(out.history.find((h) => h.phase === "implement")!.usageBy!.claude!.cacheReadTokens, READ);
});

// @req REQ-usage-002
test("REQ-usage-002 AC-3: 'mw status <ID>' prints a usage line with cached and fresh input separately", () => {
  const dir = project();
  writeRun(dir, ll69State());
  const r = mw(dir, ["status", "DEMO-1"]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trimEnd().split("\n");
  assert.match(lines[0]!, /^DEMO-1\s+waiting\s+standard\s/);
  assert.equal(lines[1]!.trim(), "usage: Claude $1.38 (input 1,054 fresh, 1,452,430 cached: 73,426 written, 1,379,004 read; 42 turns); Codex 30,000 in / 1,500 out tokens");
  // An unknown card is an error, not an empty list.
  const missing = mw(dir, ["status", "DEMO-9"]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.err + missing.out, /no card DEMO-9/);
});

// ── REQ-usage-003, REQ-usage-004: the usage guard ───────────────────────────────────────────

/**
 * Give the project a usage command that prints usage.json from the project root, or exits 3 when the
 * file is missing (a failed reading). Returns a setter: a JSON text, or undefined for the failure.
 */
function usageCommand(dir: string): (json: string | undefined) => void {
  write(dir, "usage.mjs", `import fs from "node:fs";\nif (!fs.existsSync("usage.json")) { console.error("usage window unknown"); process.exit(3); }\nprocess.stdout.write(fs.readFileSync("usage.json", "utf8"));\n`);
  write(dir, "mergewright.yaml", `${read(dir, "mergewright.yaml").trimEnd()}\nusage:\n  command: ${JSON.stringify(`${JSON.stringify(process.execPath)} usage.mjs`)}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "usage command");
  return (json) => {
    if (json === undefined) fs.rmSync(path.join(dir, "usage.json"), { force: true });
    else fs.writeFileSync(path.join(dir, "usage.json"), json);
  };
}

const flagOf = (dir: string) => pausedFlag(path.join(dir, ".mergewright", "local"));

// @req REQ-usage-003
test("REQ-usage-003 AC-1: while paused, a failed reading or max_used null keeps the pause and says the reading failed", async () => {
  const dir = project();
  const set = usageCommand(dir);
  const guard = () => integrationsFor(new Project(dir)).usageOk();
  set(`{"max_used": 95}`);
  assert.equal((await guard()).ok, false);
  assert.ok(fs.existsSync(flagOf(dir)), "95% pauses");

  set(`{"max_used": null, "error": "no window data"}`);
  const nul = await guard();
  assert.equal(nul.ok, false);
  assert.match(nul.detail, /usage reading failed \(no usage reading \(no window data\)\)/);
  assert.ok(fs.existsSync(flagOf(dir)), "max_used null does not clear the pause");

  set(undefined);
  const failed = await guard();
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /usage reading failed \(.*exited 3: usage window unknown\)/);
  assert.ok(fs.existsSync(flagOf(dir)), "a failing command does not clear the pause");

  set(`{"max_used": 50}`);
  const resumed = await guard();
  assert.equal(resumed.ok, true);
  assert.match(resumed.detail, /resumed/);
  assert.equal(fs.existsSync(flagOf(dir)), false, "only a successful reading below the resume level clears it");
});

// @req REQ-usage-003
test("REQ-usage-003 AC-2: without a pause, a failed reading lets work continue", async () => {
  const dir = project();
  const set = usageCommand(dir);
  set(undefined);
  const failed = await integrationsFor(new Project(dir)).usageOk();
  assert.equal(failed.ok, true);
  assert.match(failed.detail, /usage guard could not run: .*exited 3/);
  set(`{"max_used": null}`);
  assert.equal((await integrationsFor(new Project(dir)).usageOk()).ok, true);
  assert.equal(fs.existsSync(flagOf(dir)), false, "a failed reading never sets the pause");
});

// @req REQ-usage-004
test("REQ-usage-004 AC-1: a read-mode reviewer on a paid harness waits while paused; roles on mock are not guarded", async () => {
  const dir = project({ roles: { reviewer: { runs: "codex" } } });
  assert.equal(new Project(dir).roles().get("reviewer")!.mode, "read");
  useScript(script());
  const integ = fakeIntegrations({ usage: () => ({ ok: false, detail: "5-hour window at 96%" }) });
  const s = await run(dir, {}, { integrations: integ });
  assert.equal(s.status, "waiting");
  assert.equal(s.reason, "usage");
  assert.deepEqual(phases(s), ["brief:ok", "implement:ok", "gate:ok", "review:waiting"]);
  assert.match(s.history.at(-1)!.detail, /usage: 5-hour window at 96%/);
  assert.equal(counters(dir).reviewer, undefined, "the reviewer never started");
  assert.equal(integ.of("usageOk").length, 1, "asked once: before the codex reviewer, not before the mock planner or worker");
});

// @req REQ-usage-004
test("REQ-usage-004 AC-1: mw_delegate on a paid harness is refused with reason usage while paused", async () => {
  const dir = project();
  const set = usageCommand(dir);
  set(`{"max_used": 97}`);
  const tool = TOOLS.find((t) => t.name === "mw_delegate")!;
  const cwd = process.cwd();
  let res: Awaited<ReturnType<typeof callTool>>;
  try {
    res = await callTool(tool, { task: "Is the retry policy sound?", runs: "codex" }, { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined });
  } finally {
    process.chdir(cwd);
  }
  assert.equal(res.isError, true);
  const text = res.content.map((x) => x.text).join("\n");
  assert.match(text, /refused \(reason: usage\): agent usage is too high \(usage at 97%/);
  assert.equal(fs.existsSync(path.join(dir, ".mergewright", "local", "delegate")), false, "nothing was started");
});

/** A project whose card DEMO-1 is ready for `mw work`, with the usage pause flag set and the reading failing. */
async function pausedWorkProject(roles?: Record<string, Record<string, string>>): Promise<string> {
  const dir = project({ roles });
  write(dir, "cards/DEMO-1.card.md", read(dir, "cards/DEMO-1.card.md").replace("status: todo", "status: ready"));
  const set = usageCommand(dir);
  set(`{"max_used": 95}`);
  assert.equal((await integrationsFor(new Project(dir)).usageOk()).ok, false);
  assert.ok(fs.existsSync(flagOf(dir)), "paused");
  set(undefined);
  useScript(script());
  return dir;
}

// @req REQ-usage-004
test("REQ-usage-004 AC-1: while paused, 'mw work' takes a card when no role is on a paid harness, and reports the pause when one is", async () => {
  const free = await pausedWorkProject();
  let lines: string[] = [];
  let r = await work(free, { out: (l) => lines.push(l) });
  assert.deepEqual(r.runs.map((x) => `${x.id}:${x.status}`), ["DEMO-1:done"], "mock roles only: the card is taken");
  assert.deepEqual(lines.filter((l) => /usage is too high/.test(l)), []);
  assert.ok(fs.existsSync(flagOf(free)), "the pause itself stays");

  const paid = await pausedWorkProject({ reviewer: { runs: "codex" } });
  lines = [];
  r = await work(paid, { out: (l) => lines.push(l) });
  assert.deepEqual(r.runs, [], "a paid reviewer: the card is not taken");
  assert.equal(lines.filter((l) => /agent usage is too high \(usage reading failed/.test(l)).length, 1, lines.join("\n"));
  assert.equal(fs.existsSync(path.join(paid, ".mergewright", "runs", "DEMO-1", "state.json")), false, "the card never started");
});

// ── REQ-usage-005: phase-visit limit ────────────────────────────────────────────────────────

/** A flow whose lint gate sends a failure back to implement by name; the worker always breaks the app. */
function loopProject(limit?: number): string {
  const dir = project({ cardExtra: "flow: loop\n" });
  write(dir, "flows/loop.flow.yaml", "id: loop\nphases:\n  - {id: implement, role: worker}\n  - {id: lint, gate: default, on: {fail: implement}}\n");
  if (limit !== undefined) write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace("limits:\n", `limits:\n  phase_visits: ${limit}\n`));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "loop flow");
  useScript(script({ worker: [{ writes: { "src/app.txt": "BROKEN\n" }, output: handoff() }] }));
  return dir;
}

// @req REQ-usage-005
test("REQ-usage-005 AC-1: a lint-to-implement loop blocks at the default limit: the 6th entry runs, the 7th blocks naming the phase and the count", async () => {
  assert.equal(new Project(project()).config.limits.phaseVisits, 6, "default 6");
  const dir = loopProject();
  const s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.equal(counters(dir).worker, 6, "the 6th entry into implement ran");
  assert.deepEqual(phases(s), [...Array.from({ length: 6 }, () => ["implement:ok", "lint:fail"]).flat(), "implement:block"]);
  assert.deepEqual(s.visits, { implement: 6, lint: 6 });
  assert.match(s.reason ?? "", /phase 'implement' was entered 6 time\(s\) in this run, the limit \(limits\.phase_visits: 6\), so entry 7 was not started/);
});

// @req REQ-usage-005
test("REQ-usage-005 AC-1: limits.phase_visits is configurable and the count survives a resumed run", async () => {
  const dir = loopProject(2);
  let s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.equal(counters(dir).worker, 2);
  assert.match(s.reason ?? "", /phase 'implement' was entered 2 time\(s\).*limits\.phase_visits: 2\), so entry 3/);

  s = await run(dir);
  assert.equal(s.status, "blocked", "resumed: still over the limit");
  assert.equal(counters(dir).worker, 2, "nothing ran again");
  assert.deepEqual(state(dir).visits, { implement: 2, lint: 2 });

  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace("phase_visits: 2", "phase_visits: 3"));
  git(dir, "commit", "-qam", "raise the limit");
  s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.equal(counters(dir).worker, 3, "one more entry, counted on from the saved count");
  assert.match(s.reason ?? "", /entered 3 time\(s\).*so entry 4 was not started/);
});

// @req REQ-usage-005
test("REQ-usage-005 AC-1: a phase that pauses for usage after one of its roles ran is counted as entered", async () => {
  // The review phase runs the mock reviewer, then its 'also' role reviewer-deep on codex meets the pause.
  const dir = project({ roles: { "reviewer-deep": { runs: "codex" } } });
  useScript(script({ planner: [{ output: brief({ deep_review: true }) }] }));
  const integ = fakeIntegrations({ usage: () => ({ ok: false, detail: "5-hour window at 96%" }) });
  const s = await run(dir, {}, { integrations: integ });
  assert.equal(s.status, "waiting");
  assert.equal(s.reason, "usage");
  assert.equal(s.history.at(-1)!.phase, "review");
  assert.deepEqual(s.history.at(-1)!.roles, ["reviewer"], "the reviewer ran before the pause");
  assert.equal(counters(dir).reviewer, 1);
  assert.equal(s.visits?.review, 1, "the entry is counted");
});

// @req REQ-usage-005
test("REQ-usage-005 AC-1: an entry is counted before the phase runs, so a phase stopped mid-way keeps its count on resume", async () => {
  const dir = loopProject(2);
  const mark = path.join(tmpDir("mw-mark-"), "lint");
  // The first entry into lint hangs (and is stopped); later entries run the usual gate (which fails on BROKEN).
  write(dir, "gates/default.gate.sh", GATE.replace("set -u\n", `set -u\nif [ ! -f ${JSON.stringify(`${mark}.started`)} ]; then touch ${JSON.stringify(`${mark}.started`)}; sleep 30; fi\n`));
  git(dir, "commit", "-qam", "slow gate");
  const ctl = new AbortController();
  const poll = setInterval(() => { if (fs.existsSync(`${mark}.started`)) ctl.abort(); }, 20);
  try {
    await assert.rejects(runCard(new Project(dir), "DEMO-1", {}, { hub: fakeHub(), integrations: fakeIntegrations(), stop: ctl.signal }), Stopped);
  } finally {
    clearInterval(poll);
  }
  assert.deepEqual(state(dir).visits, { implement: 1, lint: 1 }, "the lint entry was saved before the gate ran");

  const s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.deepEqual(s.visits, { implement: 2, lint: 2 });
  assert.equal(counters(dir).worker, 2);
  assert.match(s.reason ?? "", /phase 'lint' was entered 2 time\(s\).*limits\.phase_visits: 2\), so entry 3 was not started/);
});

// @req REQ-usage-004
test("REQ-usage-004 AC-1: a paid reflector refused for a too-long state is not run again while usage is too high", async () => {
  // A stand-in codex CLI: counts its starts and replies with a reflection whose state is over the cap.
  const bin = tmpDir("mw-fakecodex-");
  const starts = path.join(bin, "starts");
  const long = reflection({ state: `# State\n\n## Now\n${Array.from({ length: 12 }, (_, i) => `- line ${i + 1}`).join("\n")}\n` });
  write(bin, "fake-codex.mjs", `import fs from "node:fs";
const argv = process.argv.slice(2);
try { fs.readFileSync(0); } catch {}
fs.appendFileSync(${JSON.stringify(starts)}, "x");
fs.writeFileSync(argv[argv.indexOf("-o") + 1], ${JSON.stringify(JSON.stringify(long))});
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
`);
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, "fake-codex.mjs"))} "$@"\n`, { mode: 0o755 });

  const dir = project({ cardExtra: "flow: reflect\n", roles: { reflector: { runs: "codex" } } });
  write(dir, "flows/reflect.flow.yaml", "id: reflect\nphases:\n  - {id: implement, role: worker}\n  - {id: reflect, role: reflector, action: memory.update}\n");
  write(dir, "mergewright.yaml", `${read(dir, "mergewright.yaml").trimEnd()}\nmemory:\n  state_max_lines: 10\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "reflect flow");
  useScript(script());
  // The guard lets the reflector's first attempt start, then usage is too high.
  let asked = 0;
  const integ = fakeIntegrations({ usage: () => (++asked === 1 ? { ok: true, detail: "usage at 40%" } : { ok: false, detail: "5-hour window at 96%" }) });
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  let s: RunState;
  try {
    s = await run(dir, {}, { integrations: integ });
  } finally {
    process.env.PATH = before;
  }
  assert.equal(fs.readFileSync(starts, "utf8"), "x", "the reflector was started once, not again for the retry");
  assert.equal(integ.of("usageOk").length, 2, "the guard was asked before the first attempt and before the retry");
  assert.ok(s.warnings.some((w) => /memory\.update: the reflection was not run again because agent usage is too high \(5-hour window at 96%\)/.test(w)), s.warnings.join("\n"));
  assert.ok(s.warnings.some((w) => /STATE\.md was left unchanged/.test(w)), "handled as when the reflection is refused twice");
  const last = s.history.at(-1)!;
  assert.equal(`${last.phase}:${last.outcome}`, "reflect:ok");
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a low reading does not clear a pause another reading renewed while it ran", async () => {
  const dir = project();
  const set = usageCommand(dir);
  set(`{"max_used": 95}`);
  const guard = () => integrationsFor(new Project(dir)).usageOk();
  assert.equal((await guard()).ok, false);
  const flag = flagOf(dir);
  fs.utimesSync(flag, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  // While this reading runs, "another process" reads usage over the threshold and rewrites the flag.
  write(dir, "usage.mjs", `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(flag)}, "other 96\\n");\nprocess.stdout.write('{"max_used": 50}');\n`);
  const kept = await guard();
  assert.equal(kept.ok, false);
  assert.match(kept.detail, /usage at 50%, but another reading kept the pause/);
  assert.equal(read(dir, ".mergewright/local/usage-paused"), "other 96\n", "the other reading's flag stays");

  // A low reading with nothing changing the flag meanwhile clears it.
  write(dir, "usage.mjs", `process.stdout.write('{"max_used": 50}');\n`);
  const resumed = await guard();
  assert.equal(resumed.ok, true);
  assert.match(resumed.detail, /resumed/);
  assert.equal(fs.existsSync(flag), false);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a reading over the threshold rewrites an existing pause flag", async () => {
  const dir = project();
  const set = usageCommand(dir);
  set(`{"max_used": 95}`);
  const guard = () => integrationsFor(new Project(dir)).usageOk();
  assert.equal((await guard()).ok, false);
  const flag = flagOf(dir);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(flag, old, old);
  set(`{"max_used": 97}`);
  assert.equal((await guard()).ok, false);
  assert.ok(fs.statSync(flag).mtimeMs > old.getTime(), "the flag's mtime moved");
  assert.match(fs.readFileSync(flag, "utf8"), / 97\n$/);
});

/**
 * A stand-in codex CLI on PATH for `body`: each start appends to `starts` and replies with `reply`; the
 * first start also sets `pausedMark`, as if usage went over the threshold while the agent ran.
 */
async function withFakeCodex<T>(reply: unknown, body: (marks: { starts: string; pausedMark: string }) => Promise<T>): Promise<T> {
  const bin = tmpDir("mw-fakecodex-");
  const starts = path.join(bin, "starts");
  const pausedMark = path.join(bin, "paused");
  write(bin, "fake-codex.mjs", `import fs from "node:fs";
const argv = process.argv.slice(2);
try { fs.readFileSync(0); } catch {}
fs.appendFileSync(${JSON.stringify(starts)}, "x");
fs.writeFileSync(${JSON.stringify(pausedMark)}, "96");
fs.writeFileSync(argv[argv.indexOf("-o") + 1], ${JSON.stringify(JSON.stringify(reply))});
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
`);
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, "fake-codex.mjs"))} "$@"\n`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  try {
    return await body({ starts, pausedMark });
  } finally {
    process.env.PATH = before;
  }
}

const RETRY_ROUTES: { role: string; phase: string; why: string; reply: unknown; over: Script }[] = [
  { role: "reviewer", phase: "review", why: "a schema validation failure", reply: { summary: "no findings list" }, over: {} },
  { role: "adjudicator", phase: "adjudicate", why: "an adjudication validation failure", reply: adjudication("reject", { accepted: ["reviewer:R-99"], instructions: "Fix it." }),
    // A blocking finding, so the adjudicator runs; its reply names a finding that does not exist.
    over: { reviewer: [{ output: findings([finding("R-01", true)]) }] } },
];

for (const route of RETRY_ROUTES) {
  // @req REQ-usage-004
  test(`REQ-usage-004 AC-1: a paid ${route.role} is not run again after ${route.why} while usage is too high; the run waits for usage`, async () => {
    const dir = project({ roles: { [route.role]: { runs: "codex" } } });
    useScript(script(route.over));
    const s = await withFakeCodex(route.reply, async ({ starts, pausedMark }) => {
      // The guard lets the first attempt start; the agent's own run pushes usage over the threshold.
      const integ = fakeIntegrations({ usage: () => (fs.existsSync(pausedMark) ? { ok: false, detail: "5-hour window at 96%" } : { ok: true, detail: "usage at 40%" }) });
      const st = await run(dir, {}, { integrations: integ });
      assert.equal(fs.readFileSync(starts, "utf8"), "x", "the harness was started once, not again for the retry");
      assert.equal(integ.of("usageOk").length, 2, "the guard was asked before the first attempt and before the retry");
      return st;
    });
    assert.equal(s.status, "waiting");
    assert.equal(s.reason, "usage");
    const last = s.history.at(-1)!;
    assert.equal(`${last.phase}:${last.outcome}`, `${route.phase}:waiting`);
    assert.match(last.detail, /^usage: .*was not tried again: 5-hour window at 96%/);
    assert.deepEqual(last.roles, [route.role], "the first attempt ran, so the entry is counted");
    const files = fs.readdirSync(runPath(dir, "phases"));
    assert.ok(files.some((f) => f.endsWith(`-${route.phase}-${route.role}.output.txt`)), files.join(", "));
    assert.equal(files.filter((f) => f.includes("-retry")).length, 0, `no retry exchange was recorded: ${files.join(", ")}`);
    const saved = state(dir);
    assert.equal(`${saved.status}:${saved.reason}`, "waiting:usage", "state.json shows the run waiting for usage");
  });
}

/** Settings for calling usageGate directly: the usage command prints `max_used: pct` from a temp dir. */
function gateAt(dir: string, pct: number): UsageSettings {
  write(dir, `usage-${pct}.mjs`, `process.stdout.write('{"max_used": ${pct}}');\n`);
  return { command: `${JSON.stringify(process.execPath)} usage-${pct}.mjs`, pauseAtPct: 90, resumeBelowPct: 80, localDir: path.join(dir, "local"), cwd: dir };
}
/** Files the pause flag must not leave behind: tombstones, temporary flags and locks. */
const tombstones = (dir: string) => fs.readdirSync(path.join(dir, "local")).filter((f) => /\.(clearing|writing|stale)\.|\.lock$|\.lock\.recover$/.test(f));

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a pause another gate renews after a low reading decided to clear survives the clear", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(flag, old, old);
  // Gate A reads 50% and decides to clear; before it clears, gate B reads 96% and renews the pause.
  let renewed = "";
  const a = usageGate(gateAt(dir, 50), {
    beforeClear: () => {
      assert.equal(usageGate(gateAt(dir, 96)).ok, false);
      renewed = fs.readFileSync(flag, "utf8");
    },
  });
  assert.match(renewed, / 96\n$/);
  assert.equal(a.ok, false, "gate A stays paused");
  assert.match(a.detail, /usage at 50%, but another reading kept the pause/);
  assert.equal(fs.readFileSync(flag, "utf8"), renewed, "gate B's flag stays");
  assert.deepEqual(tombstones(dir), []);

  // A flag replaced by a new file (another inode) in the window survives as well.
  const b = usageGate(gateAt(dir, 50), {
    beforeClear: () => {
      fs.rmSync(flag);
      fs.writeFileSync(flag, "other 97\n");
    },
  });
  assert.equal(b.ok, false);
  assert.equal(fs.readFileSync(flag, "utf8"), "other 97\n");
  assert.deepEqual(tombstones(dir), []);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a low reading with no concurrent writer clears the pause and leaves no tombstone", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  assert.ok(fs.existsSync(flag));
  const r = usageGate(gateAt(dir, 50));
  assert.equal(r.ok, true);
  assert.match(r.detail, /usage at 50% \(resumed\)/);
  assert.equal(fs.existsSync(flag), false);
  assert.deepEqual(tombstones(dir), []);
});

/** An fs error with a code, as the injected file operations throw it. */
function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

/** Write the pause lock `<flag>.lock` as another process would, with its mtime set `ageMs` back. */
function holdLock(dir: string, content: string, ageMs = 0): string {
  const lock = `${pausedFlag(path.join(dir, "local"))}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, content);
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(lock, at, at);
  return lock;
}

/** The pid of a child process that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(r.status, 0);
  assert.ok(r.pid);
  return r.pid;
}

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a clear whose removal fails leaves the flag in place, the run paused and no lock behind", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const before = fs.readFileSync(flag, "utf8");
  const r = usageGate(gateAt(dir, 50), {
    unlinkSync: () => {
      throw fsError("EPERM");
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /usage at 50%, but the pause flag could not be cleared \(EPERM\): still paused until below 80%/);
  assert.equal(fs.readFileSync(flag, "utf8"), before);
  assert.deepEqual(tombstones(dir), []);
  // A later low reading clears it.
  assert.equal(usageGate(gateAt(dir, 50)).ok, true);
  assert.equal(fs.existsSync(flag), false);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: concurrent clear and reaffirm keep the flag: a clear that arrives while a high reading holds the lock stays paused", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const old = fs.statSync(flag).ino;
  // Writer B has its reading of 97% ready and holds the lock; clearer A reads 50% in that window.
  let cleared: { ok: boolean; detail: string } | undefined;
  const b = usageGate(gateAt(dir, 97), {
    beforePublish: () => {
      cleared = usageGate(gateAt(dir, 50));
      assert.equal(fs.statSync(flag).ino, old, "the clearer did not touch the flag");
    },
  });
  assert.equal(cleared?.ok, false, "the clearer stays paused");
  assert.match(cleared?.detail ?? "", new RegExp(`could not be cleared \\(the pause lock is held by pid ${process.pid}\\)`));
  assert.equal(b.ok, false);
  assert.match(fs.readFileSync(flag, "utf8"), / 97\n$/, "the writer's flag stands");
  assert.deepEqual(tombstones(dir), []);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: concurrent clear and reaffirm: a writer that cannot get the lock while a clear holds it leaves the flag untouched and stays paused", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const lock = `${flag}.lock`;
  // Clearer A has compared the flag and holds the lock; writer B reads 96% before A removes it.
  let b: { ok: boolean; detail: string } | undefined;
  const a = usageGate(gateAt(dir, 50), {
    beforeUnlink: () => {
      const held = fs.readFileSync(lock, "utf8");
      const before = fs.readFileSync(flag, "utf8");
      b = usageGate(gateAt(dir, 96));
      assert.equal(fs.readFileSync(flag, "utf8"), before, "the writer left the flag as it was");
      assert.equal(fs.readFileSync(lock, "utf8"), held, "the writer did not take over the live lock");
    },
  });
  assert.equal(b?.ok, false, "the writer is paused");
  assert.match(b?.detail ?? "", new RegExp(`the pause flag could not be written: the pause lock is held by pid ${process.pid}`));
  assert.equal(a.ok, true, "the clear completes: it holds the lock from comparison to removal");
  assert.deepEqual(tombstones(dir), []);
  // The writer's next reading pauses again.
  assert.equal(usageGate(gateAt(dir, 96)).ok, false);
  assert.match(fs.readFileSync(flag, "utf8"), / 96\n$/);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a double restore fault no longer leaves a tombstone: the clear either completes or leaves the flag in place", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  // Every way to put a flag back and every removal fail (an earlier version left a .clearing.* tombstone here).
  const faults = {
    linkSync: () => {
      throw fsError("EPERM");
    },
    writeFileSync: () => {
      throw fsError("EROFS");
    },
    unlinkSync: () => {
      throw fsError("EPERM");
    },
  };
  // Gate B renews the pause before gate A clears: the renewed flag stays.
  const renewed = usageGate(gateAt(dir, 50), { ...faults, beforeClear: () => assert.equal(usageGate(gateAt(dir, 96)).ok, false) });
  assert.equal(renewed.ok, false);
  assert.match(fs.readFileSync(flag, "utf8"), / 96\n$/, "the renewed flag is live");
  assert.deepEqual(tombstones(dir), []);
  // No concurrent writer, the removal fails: the observed flag stays.
  const failed = usageGate(gateAt(dir, 50), faults);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /could not be cleared \(EPERM\)/);
  assert.match(fs.readFileSync(flag, "utf8"), / 96\n$/);
  assert.deepEqual(tombstones(dir), []);
  // Without faults the clear completes.
  assert.equal(usageGate(gateAt(dir, 50)).ok, true);
  assert.equal(fs.existsSync(flag), false);
  assert.deepEqual(tombstones(dir), []);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a stale lock from a dead pid is recovered, by a clear and by a high reading", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const pid = deadPid();
  const lock = holdLock(dir, JSON.stringify({ pid, time: Date.now() - 60_000 }), 60_000);
  const r = usageGate(gateAt(dir, 50));
  assert.equal(r.ok, true, r.detail);
  assert.equal(fs.existsSync(flag), false);
  assert.equal(fs.existsSync(lock), false, "the recovered lock was released");
  assert.deepEqual(tombstones(dir), []);

  holdLock(dir, JSON.stringify({ pid, time: Date.now() - 60_000 }), 60_000);
  const high = usageGate(gateAt(dir, 97));
  assert.equal(high.ok, false);
  assert.doesNotMatch(high.detail, /could not be written/);
  assert.match(fs.readFileSync(flag, "utf8"), / 97\n$/);
  assert.deepEqual(tombstones(dir), []);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a delayed stale-lock recoverer never removes the live lock a contender took on the freed path", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const before = fs.readFileSync(flag, "utf8");
  const lock = holdLock(dir, JSON.stringify({ pid: deadPid(), time: Date.now() - 60_000 }), 60_000);
  // Recoverer B has judged the lock stale; before B removes it, A removes it and takes the freed path.
  const live = JSON.stringify({ pid: process.pid, time: Date.now(), nonce: "contender" });
  let dropped = 0;
  let judged = 0;
  const b = usageGate(gateAt(dir, 50), {
    beforeDropStale: () => {
      dropped++;
    },
    beforeRecover: () => {
      judged++;
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, live);
    },
  });
  assert.equal(judged, 1, "B judged the lock stale once");
  assert.equal(dropped, 0, "B's re-check under the recovery file found the lock changed and removed nothing");
  assert.equal(b.ok, false, "B stays paused");
  assert.match(b.detail, new RegExp(`could not be cleared \\(the pause lock is held by pid ${process.pid}\\)`));
  assert.equal(fs.readFileSync(lock, "utf8"), live, "the contender's live lock stays");
  assert.equal(fs.readFileSync(flag, "utf8"), before);
  fs.rmSync(lock);
  assert.deepEqual(tombstones(dir), [], "no recovery file is left");
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a second stale-lock recoverer removes nothing while the first holds the recovery file", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const stale = JSON.stringify({ pid: deadPid(), time: Date.now() - 60_000 });
  const lock = holdLock(dir, stale, 60_000);
  // Recoverer A has re-checked the stale lock and holds `<flag>.lock.recover`; recoverer B arrives.
  let second: { ok: boolean; detail: string } | undefined;
  let calls = 0;
  const a = usageGate(gateAt(dir, 50), {
    beforeDropStale: () => {
      calls++;
      assert.ok(fs.existsSync(`${lock}.recover`), "A holds the recovery file");
      second = usageGate(gateAt(dir, 97));
      assert.equal(fs.readFileSync(lock, "utf8"), stale, "B did not remove the lock");
      assert.ok(fs.existsSync(`${lock}.recover`), "B did not take over the recovery file");
    },
  });
  assert.equal(calls, 1, "only A reached the removal");
  assert.equal(second?.ok, false, "B stays paused");
  assert.match(second?.detail ?? "", /the pause flag could not be written: the pause lock is held by pid \d+/);
  assert.equal(a.ok, true, a.detail);
  assert.equal(fs.existsSync(flag), false, "A cleared the flag holding the lock it took on the freed path");
  assert.deepEqual(tombstones(dir), [], "no lock and no recovery file are left");
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a holder's release does not unlink a lock whose content is not its own", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const lock = `${flag}.lock`;
  const other = JSON.stringify({ pid: process.pid, time: Date.now(), nonce: "other" });
  // While the clear holds the lock, another holder's lock replaces it at the path.
  const r = usageGate(gateAt(dir, 50), {
    beforeUnlink: () => {
      assert.match(fs.readFileSync(lock, "utf8"), /"nonce":"[0-9a-f]+"/, "the holder wrote a nonce");
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, other);
    },
  });
  assert.equal(r.ok, true, r.detail);
  assert.equal(fs.readFileSync(lock, "utf8"), other, "the other holder's lock stays");
  fs.rmSync(lock);
  assert.deepEqual(tombstones(dir), []);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a stale lock needs a dead pid and age: a fresh lock of a dead pid, an old lock of a live pid and a fresh unreadable lock keep the gate paused", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const before = fs.readFileSync(flag, "utf8");
  const pid = deadPid();
  for (const [content, ageMs] of [
    [JSON.stringify({ pid, time: Date.now() }), 0],
    [JSON.stringify({ pid: process.pid, time: Date.now() - 3_600_000 }), 3_600_000],
    ["", 0],
  ] as const) {
    const lock = holdLock(dir, content, ageMs);
    const r = usageGate(gateAt(dir, 50));
    assert.equal(r.ok, false, content);
    assert.match(r.detail, /could not be cleared \(the pause lock is held by/);
    assert.equal(fs.readFileSync(flag, "utf8"), before);
    assert.equal(fs.readFileSync(lock, "utf8"), content, "the lock was not taken over");
  }
  // An unreadable (half-written) lock is taken over only when it is old.
  holdLock(dir, "", 120_000);
  assert.equal(usageGate(gateAt(dir, 50)).ok, true);
  assert.equal(fs.existsSync(flag), false);
  assert.deepEqual(tombstones(dir), []);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a live lock keeps the gate paused: the clear removes nothing and a high reading leaves the flag as it is", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const before = fs.readFileSync(flag, "utf8");
  const ino = fs.statSync(flag).ino;
  const content = JSON.stringify({ pid: process.pid, time: Date.now() });
  const lock = holdLock(dir, content);
  const r = usageGate(gateAt(dir, 50));
  assert.equal(r.ok, false);
  assert.equal(r.detail, `usage at 50%, but the pause flag could not be cleared (the pause lock is held by pid ${process.pid}): still paused until below 80%`);
  assert.equal(fs.readFileSync(flag, "utf8"), before);
  const high = usageGate(gateAt(dir, 97));
  assert.equal(high.ok, false);
  assert.match(high.detail, new RegExp(`the pause flag could not be written: the pause lock is held by pid ${process.pid}`));
  assert.equal(fs.readFileSync(flag, "utf8"), before, "the flag is not removed or overwritten");
  assert.equal(fs.statSync(flag).ino, ino);
  assert.equal(fs.readFileSync(lock, "utf8"), content, "the live lock stays");
  fs.rmSync(lock);
  assert.equal(usageGate(gateAt(dir, 50)).ok, true);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a beforeClear hook that throws keeps the flag and the run paused", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const before = fs.readFileSync(flag, "utf8");
  const r = usageGate(gateAt(dir, 50), {
    beforeClear: () => {
      throw fsError("EIO");
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /usage at 50%, but the pause flag could not be cleared \(EIO\): still paused until below 80%/);
  assert.equal(fs.readFileSync(flag, "utf8"), before);
  assert.deepEqual(tombstones(dir), []);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: an error while the clear holds the lock keeps the flag, the run paused, and releases the lock", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const before = fs.readFileSync(flag, "utf8");
  const r = usageGate(gateAt(dir, 50), {
    beforeUnlink: () => {
      assert.ok(fs.existsSync(`${flag}.lock`), "the clear holds the lock");
      throw new Error("interrupted");
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /could not be cleared \(interrupted\)/);
  assert.equal(fs.readFileSync(flag, "utf8"), before);
  assert.deepEqual(tombstones(dir), [], "no lock and no tombstone are left");
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a high reading whose flag cannot be written returns paused and leaves no temporary file", () => {
  const dir = tmpDir();
  const flag = pausedFlag(path.join(dir, "local"));
  const r = usageGate(gateAt(dir, 95), {
    renameSync: () => {
      throw fsError("EROFS");
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /usage at 95% \(pause at 90%\) \(the pause flag could not be written: EROFS\): paused until below 80%/);
  assert.equal(fs.existsSync(flag), false);
  assert.deepEqual(tombstones(dir), []);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a directory at the flag path is a pause that a low reading cannot clear", () => {
  const dir = tmpDir();
  const flag = pausedFlag(path.join(dir, "local"));
  fs.mkdirSync(flag, { recursive: true });
  const r = usageGate(gateAt(dir, 50));
  assert.equal(r.ok, false);
  assert.match(r.detail, /usage at 50%, but the pause flag could not be cleared \(the pause flag could not be read \(EISDIR\)\): still paused until below 80%/);
  assert.ok(fs.statSync(flag).isDirectory(), "the directory stays");
  assert.deepEqual(tombstones(dir), []);
  // A failed reading keeps the pause; a high reading returns paused.
  const none = usageGate({ ...gateAt(dir, 50), command: `${JSON.stringify(process.execPath)} -e "process.exit(3)"` });
  assert.equal(none.ok, false);
  assert.match(none.detail, /usage reading failed/);
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  assert.ok(fs.statSync(flag).isDirectory());
  assert.deepEqual(tombstones(dir), []);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a pause flag without read permission is a pause that a low reading cannot clear", { skip: process.getuid?.() === 0 ? "root reads any file" : false }, () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  fs.chmodSync(flag, 0o000);
  try {
    const r = usageGate(gateAt(dir, 50));
    assert.equal(r.ok, false);
    assert.match(r.detail, /could not be cleared \(the pause flag could not be read \(EACCES\)\)/);
    assert.ok(fs.existsSync(flag), "the flag stays");
    assert.deepEqual(tombstones(dir), []);
  } finally {
    fs.chmodSync(flag, 0o644);
  }
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: .clearing.* files left by an older version do not break the gate: they count as a pause and are adopted", () => {
  const dir = tmpDir();
  const local = path.join(dir, "local");
  const flag = pausedFlag(local);
  write(local, "usage-paused.clearing.1.aaaaaa", "old 95\n");
  write(local, "usage-paused.clearing.2.bbbbbb", "old 96\n");
  fs.utimesSync(path.join(local, "usage-paused.clearing.1.aaaaaa"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  // A removal that fails keeps the run paused without throwing.
  const r = usageGate(gateAt(dir, 50), {
    unlinkSync: () => {
      throw fsError("EIO");
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /could not be cleared \(a leftover \.clearing\.\* file could not be adopted \(EIO\)\)/);
  assert.equal(fs.readFileSync(flag, "utf8"), "old 96\n", "the newest is the pause");
  // A reading between the levels keeps the adopted pause; the next leftover is removed.
  assert.equal(usageGate(gateAt(dir, 85)).ok, false);
  assert.deepEqual(tombstones(dir), []);
  assert.equal(fs.readFileSync(flag, "utf8"), "old 96\n");
  // A low reading clears it.
  assert.equal(usageGate(gateAt(dir, 50)).ok, true);
  assert.equal(fs.existsSync(flag), false);

  // A leftover with no live flag becomes the flag, and a high reading renews it.
  write(local, "usage-paused.clearing.3.cccccc", "old 95\n");
  assert.equal(usageGate(gateAt(dir, 97)).ok, false);
  assert.match(fs.readFileSync(flag, "utf8"), / 97\n$/);
  assert.deepEqual(tombstones(dir), []);
});

/** A script that takes the pause lock as another process through `usageGate` and exits while it holds it, printing the lock. */
function lockTaker(dir: string): string {
  const usage = pathToFileURL(path.resolve(import.meta.dirname, "../../src/integrations/usage.ts")).href;
  write(
    dir,
    "take-lock.ts",
    `import fs from "node:fs";\nimport { usageGate } from ${JSON.stringify(usage)};\nconst s = JSON.parse(process.argv[2]);\nusageGate(s, { beforePublish: () => { process.stdout.write(fs.readFileSync(process.argv[3], "utf8")); process.exit(0); } });\nprocess.exit(4);\n`,
  );
  return path.join(dir, "take-lock.ts");
}

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a holder stalled between creating the lock and writing its owner, whose lock was taken over as stale meanwhile, does not run its body and leaves the replacement lock", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const lock = `${flag}.lock`;
  const before = fs.readFileSync(flag, "utf8");
  const taker = lockTaker(dir);
  let stalls = 0;
  let replacement = "";
  let ranBody = 0;
  const r = usageGate(gateAt(dir, 50), {
    afterCreate: () => {
      stalls++;
      // While the holder is stalled its lock comes to look stale (a dead pid, an old time) and another process takes it over.
      const old = Date.now() - 120_000;
      fs.writeFileSync(lock, JSON.stringify({ pid: deadPid(), time: old }));
      fs.utimesSync(lock, new Date(old), new Date(old));
      const child = spawnSync(process.execPath, [taker, JSON.stringify(gateAt(dir, 97)), lock], { cwd: dir, encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
      replacement = child.stdout;
      assert.equal(JSON.parse(replacement).pid, child.pid, "the other process holds the lock");
    },
    beforeUnlink: () => {
      ranBody++;
    },
  });
  assert.equal(stalls, 1);
  assert.equal(ranBody, 0, "the stalled holder's body did not run");
  assert.equal(r.ok, false, "the caller stays paused");
  assert.equal(r.detail, "usage at 50%, but the pause flag could not be cleared (the pause lock was lost to another process while it was being taken): still paused until below 80%");
  assert.equal(fs.readFileSync(flag, "utf8"), before, "the flag stays");
  assert.equal(fs.readFileSync(lock, "utf8"), replacement, "the replacement lock is still present");
  assert.equal(fs.existsSync(`${lock}.recover`), false, "the recovery file was not touched");
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a high reading whose lock tries run out while another holder keeps the lock returns paused naming the refused write; the next high reading after release writes the flag", () => {
  const dir = tmpDir();
  const flag = pausedFlag(path.join(dir, "local"));
  const content = JSON.stringify({ pid: process.pid, time: Date.now(), nonce: "other" });
  const lock = holdLock(dir, content);
  const waits: number[] = [];
  const r = usageGate(gateAt(dir, 97), { sleep: (ms) => waits.push(ms) });
  assert.deepEqual(waits, [10, 10, 10, 10, 10], "every try was spent");
  assert.equal(r.ok, false);
  assert.equal(r.detail, `usage at 97% (pause at 90%) (the pause flag could not be written: the pause lock is held by pid ${process.pid}): paused until below 80%`);
  assert.equal(fs.existsSync(flag), false, "no flag was written");
  assert.equal(fs.readFileSync(lock, "utf8"), content, "the other holder's lock stays");
  fs.rmSync(lock);
  assert.deepEqual(tombstones(dir), [], "no temporary flag is left");
  const next = usageGate(gateAt(dir, 97), { sleep: () => assert.fail("a free lock is taken at once") });
  assert.equal(next.ok, false);
  assert.doesNotMatch(next.detail, /could not be written/);
  assert.match(fs.readFileSync(flag, "utf8"), / 97\n$/);
  assert.deepEqual(tombstones(dir), []);
});

/** Wait, blocking this process, until `file` exists; another process creates it. Throws after 20 s. */
function waitFileSync(file: string): void {
  const end = Date.now() + 20_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${path.basename(file)}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

/** Write a marker file whole (temp file, then rename), so a reader in another process never sees it half-written. */
function markFile(file: string, text = ""): void {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * A script for a holder in another process: a low reading whose clear stalls between creating the lock
 * and writing its owner (it ages the lock so it looks stale, marks `created`, waits for `go`), then
 * marks `in-body` with its lock's content inside its body and waits for `finish`; it marks `released`
 * with its result once `usageGate` returns.
 */
function stalledHolder(dir: string): string {
  const usage = pathToFileURL(path.resolve(import.meta.dirname, "../../src/integrations/usage.ts")).href;
  write(
    dir,
    "stalled-holder.ts",
    [
      `import fs from "node:fs";`,
      `import path from "node:path";`,
      `import { usageGate } from ${JSON.stringify(usage)};`,
      `const [s, marks, lock] = [JSON.parse(process.argv[2]), process.argv[3], process.argv[4]];`,
      `const until = (name) => { const end = Date.now() + 20000; while (!fs.existsSync(path.join(marks, name))) { if (Date.now() > end) process.exit(5); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } };`,
      `const mark = (name, text = "") => { const f = path.join(marks, name); fs.writeFileSync(f + ".tmp", text); fs.renameSync(f + ".tmp", f); };`,
      `const r = usageGate(s, {`,
      `  afterCreate: () => { const old = new Date(Date.now() - 120000); fs.utimesSync(lock, old, old); mark("created"); until("go"); },`,
      `  beforeUnlink: () => { mark("in-body", fs.readFileSync(lock, "utf8")); until("finish"); },`,
      `});`,
      `mark("released", JSON.stringify(r));`,
      ``,
    ].join("\n"),
  );
  return path.join(dir, "stalled-holder.ts");
}

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a stale-lock recoverer whose last check passed while the stalled holder resumed, wrote its owner and passed its re-check does not remove the live lock, and the two bodies never overlap", async () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const lock = `${flag}.lock`;
  const marks = path.join(dir, "marks");
  fs.mkdirSync(marks);
  const mark = (name: string) => path.join(marks, name);
  const holder = spawn(process.execPath, [stalledHolder(dir), JSON.stringify(gateAt(dir, 50)), marks, lock], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  holder.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((resolve) => holder.on("exit", (code) => resolve(code)));
  try {
    // The holder has created its lock (no owner yet, old enough to look stale) and is stalled.
    const end = Date.now() + 20_000;
    while (!fs.existsSync(mark("created"))) {
      assert.ok(Date.now() < end, `the holder did not create its lock: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const events: string[] = [];
    const problems: string[] = [];
    let held = "";
    let sleeps = 0;
    const r = usageGate(gateAt(dir, 97), {
      // The recoverer has judged the holder's lock stale and re-checked it under the recovery file. Now the
      // holder resumes, writes its owner, passes its re-check and enters its body while the recoverer waits.
      beforeDropStale: () => {
        events.push("recoverer checked");
        try {
          markFile(mark("go"));
          waitFileSync(mark("in-body"));
          held = fs.readFileSync(mark("in-body"), "utf8");
          events.push("holder in body");
        } catch (e) {
          problems.push(String(e));
        }
      },
      sleep: () => {
        sleeps++;
        if (sleeps > 1) return;
        events.push("recoverer waits");
        // Still inside the holder's body: its lock is in place with its content and nothing was moved aside for good.
        if (fs.readFileSync(lock, "utf8") !== held) problems.push("the live holder's lock was changed");
        const left = fs.readdirSync(path.dirname(lock)).filter((f) => f.includes(".stale."));
        if (left.length) problems.push(`left behind: ${left.join(", ")}`);
        markFile(mark("finish"));
        waitFileSync(mark("released"));
        events.push("holder released");
      },
      beforePublish: () => {
        events.push("recoverer body");
        if (!fs.existsSync(mark("released"))) problems.push("the recoverer's body ran while the holder's body ran");
      },
    });
    assert.deepEqual(problems, []);
    assert.deepEqual(events, ["recoverer checked", "holder in body", "recoverer waits", "holder released", "recoverer body"]);
    assert.equal(JSON.parse(held).pid, holder.pid, "the holder wrote its owner and passed its re-check");
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.detail, /could not be written/, r.detail);
    assert.equal(await exited, 0, stderr);
    assert.equal(JSON.parse(fs.readFileSync(mark("released"), "utf8")).ok, true, "the holder's clear ran and completed");
    assert.match(fs.readFileSync(flag, "utf8"), / 97\n$/, "the recoverer wrote its reading after the holder's clear");
    assert.deepEqual(tombstones(dir), [], "no lock, recovery file or moved-aside lock is left");
  } finally {
    holder.kill();
    await exited;
  }
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a stale lock that cannot be moved aside is not removed and the caller stays paused", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const before = fs.readFileSync(flag, "utf8");
  const stale = JSON.stringify({ pid: deadPid(), time: Date.now() - 60_000 });
  const lock = holdLock(dir, stale, 60_000);
  let renames = 0;
  let cleared = 0;
  const r = usageGate(gateAt(dir, 50), {
    renameLock: () => {
      renames++;
      throw fsError("EPERM");
    },
    beforeUnlink: () => {
      cleared++;
    },
  });
  assert.equal(renames, 1);
  assert.equal(cleared, 0, "the clear did not run");
  assert.equal(r.ok, false);
  assert.equal(r.detail, "usage at 50%, but the pause flag could not be cleared (the stale pause lock could not be moved aside (EPERM)): still paused until below 80%");
  assert.equal(fs.readFileSync(lock, "utf8"), stale, "the stale lock is still in place");
  assert.equal(fs.readFileSync(flag, "utf8"), before);
  fs.rmSync(lock);
  assert.deepEqual(tombstones(dir), [], "no recovery file or moved-aside lock is left");
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a moved-aside lock that is not the stale one and cannot be put back is kept, nothing is removed and the caller stays paused", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const before = fs.readFileSync(flag, "utf8");
  const lock = holdLock(dir, JSON.stringify({ pid: deadPid(), time: Date.now() - 60_000 }), 60_000);
  const live = JSON.stringify({ pid: process.pid, time: Date.now(), nonce: "resumed" });
  const third = JSON.stringify({ pid: process.pid, time: Date.now(), nonce: "third" });
  let moved = "";
  let cleared = 0;
  const r = usageGate(gateAt(dir, 50), {
    // The holder rewrites its lock (same inode) just before the rename; right after it, a third process takes the freed path.
    renameLock: (from, to) => {
      fs.writeFileSync(from, live);
      fs.renameSync(from, to);
      moved = to;
      fs.writeFileSync(from, third);
    },
    beforeUnlink: () => {
      cleared++;
    },
  });
  assert.equal(cleared, 0, "the clear did not run");
  assert.equal(r.ok, false);
  assert.match(r.detail, /^usage at 50%, but the pause flag could not be cleared \(a live pause lock was moved aside and could not be put back \(EEXIST\); it is kept as usage-paused\.lock\.stale\.\d+\.[0-9a-f]+\): still paused until below 80%$/);
  assert.equal(path.dirname(moved), path.dirname(lock), "the lock was moved within its folder");
  assert.equal(fs.readFileSync(moved, "utf8"), live, "the live lock was not deleted");
  assert.equal(fs.readFileSync(lock, "utf8"), third, "the third process's lock was not replaced");
  assert.equal(fs.readFileSync(flag, "utf8"), before);
  assert.equal(fs.existsSync(`${lock}.recover`), false, "the recovery file was released");
  fs.rmSync(moved);
  fs.rmSync(lock);
  assert.deepEqual(tombstones(dir), []);
});

// @req REQ-usage-003
test("REQ-usage-003 AC-1: a live lock put back whose moved-aside name cannot be removed keeps the caller paused and the restored lock in place", () => {
  const dir = tmpDir();
  assert.equal(usageGate(gateAt(dir, 95)).ok, false);
  const flag = pausedFlag(path.join(dir, "local"));
  const before = fs.readFileSync(flag, "utf8");
  const lock = holdLock(dir, JSON.stringify({ pid: deadPid(), time: Date.now() - 60_000 }), 60_000);
  const live = JSON.stringify({ pid: process.pid, time: Date.now(), nonce: "resumed" });
  let moved = "";
  let unlinks = 0;
  let cleared = 0;
  const r = usageGate(gateAt(dir, 50), {
    // The holder rewrites its lock (same inode) just before the rename; nobody takes the freed path, so the put-back succeeds.
    renameLock: (from, to) => {
      fs.writeFileSync(from, live);
      fs.renameSync(from, to);
      moved = to;
    },
    unlinkLock: () => {
      unlinks++;
      throw fsError("EPERM");
    },
    beforeUnlink: () => {
      cleared++;
    },
  });
  assert.equal(unlinks, 1);
  assert.equal(r.ok, false);
  assert.equal(
    r.detail,
    `usage at 50%, but the pause flag could not be cleared (the live pause lock was put back but its moved-aside name could not be removed (EPERM); it is kept as ${path.basename(moved)}): still paused until below 80%`,
  );
  assert.equal(cleared, 0, "the clear did not run");
  assert.equal(fs.readFileSync(lock, "utf8"), live, "the restored lock has the live holder's content");
  assert.equal(fs.readFileSync(flag, "utf8"), before);
  assert.equal(fs.existsSync(`${lock}.recover`), false, "the recovery file was released");
  fs.rmSync(moved);
  fs.rmSync(lock);
  assert.deepEqual(tombstones(dir), []);
});
