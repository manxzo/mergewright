// Regression tests for the sandbox policy, Codex usage wording, the lease at the end of `mw run`,
// documentation paths in a card's scope, the Codex home sweep, and `mw abort` with a live orphans
// record. Only long-standing symbols are imported, so a missing newer one fails its own test instead
// of the whole file.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { abort, runCard, usageTotals } from "../src/engine/run.ts";
import type { RunState } from "../src/engine/types.ts";
import { paidHarness } from "../src/integrations/usage.ts";
import { Project } from "../src/project.ts";
import { codes, mw, read, tmpDir, write } from "./helpers.ts";
import { branchExists, fakeHub, fakeIntegrations, hubPair, project, run, runPath, script, state, useScript } from "./engine-helpers.ts";


const ID = "DEMO-1";
const WT = (dir: string) => path.join(dir, ".mergewright", "worktrees", ID);
const LOCAL = (dir: string, ...rel: string[]) => path.join(dir, ".mergewright", "local", ...rel);

/** Set environment variables for the duration of `f` (undefined removes one). */
async function withEnv<T>(vars: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return await f();
  } finally {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

/** A `claude` on PATH that records that it ran and fails, so no real agent is ever started. */
function fakeClaude(): { bin: string; ran: string } {
  const bin = tmpDir("mw-fakeclaude-");
  const ran = path.join(bin, "ran");
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$@" >> '${ran}'\necho 'claude: not really' >&2\nexit 3\n`, { mode: 0o755 });
  return { bin, ran };
}

/** Field 22 of /proc/<pid>/stat (the identity a lock or orphans record carries). */
function startTime(pid: number): string {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 2).split(" ")[19]!;
}

function sleeper(): { pid: number; stop: () => void } {
  const c = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  c.unref();
  return { pid: c.pid!, stop: () => { try { process.kill(c.pid!, "SIGKILL"); } catch { /* gone */ } } };
}

// ── 1. Sandbox policy ───────────────────────────────────────────────────────────────────────

test("MW_SANDBOX=off records 'off (isolated host)' and never warns; 'required' with a failing probe blocks the write phase with run/sandbox-required", async () => {
  const sandboxWarnings = (s: RunState) => s.warnings.filter((w) => /sandbox/i.test(w));

  // off, on the mock harness: no warning, and the run state says the host is isolated.
  let dir = project();
  useScript(script());
  let s = await withEnv({ MW_SANDBOX: "off", MW_CLAUDE_SANDBOX: "off" }, () => run(dir, { until: "gate" }));
  assert.equal(s.status, "running", s.reason);
  assert.deepEqual(sandboxWarnings(s), []);
  assert.equal(state(dir).sandbox, "off (isolated host)");

  // off, with a write-mode Claude worker on a machine where the probe fails: still no warning.
  const claude = fakeClaude();
  dir = project({ roles: { worker: { runs: "claude" } } });
  useScript(script());
  s = await withEnv({ MW_SANDBOX: "off", MW_CLAUDE_SANDBOX: "off", PATH: `${claude.bin}:${process.env.PATH}` }, () => run(dir));
  assert.ok(fs.existsSync(claude.ran), "the worker was started");
  assert.deepEqual(sandboxWarnings(s), [], s.warnings.join("\n"));
  assert.equal(s.sandbox, "off (isolated host)");

  // required, with the probe failing (MW_CLAUDE_SANDBOX=off is the probe's seam): the write phase
  // does not start, and the run blocks naming the code.
  fs.rmSync(claude.ran, { force: true });
  dir = project({ roles: { worker: { runs: "claude" } } });
  useScript(script());
  s = await withEnv({ MW_SANDBOX: "required", MW_CLAUDE_SANDBOX: "off", PATH: `${claude.bin}:${process.env.PATH}` }, () => run(dir));
  assert.equal(s.status, "blocked");
  assert.match(s.reason ?? "", /run\/sandbox-required/);
  assert.match(s.reason ?? "", /phase 'implement' was not started/);
  assert.equal(fs.existsSync(claude.ran), false, "the Claude worker never ran");
  assert.deepEqual(s.history.map((h) => `${h.phase}:${h.outcome}`), ["brief:ok", "implement:block"]);
});

// ── 2. Usage wording ────────────────────────────────────────────────────────────────────────

test("Codex usage is shown as tokens only, with no 'n/a' and no 'subscription'", () => {
  const h = (usageBy: RunState["history"][number]["usageBy"]) => ({ phase: "p", roles: [], outcome: "ok" as const, detail: "", round: 0, started: "", seconds: 0, usageBy });
  const s = { history: [h({ claude: { inputTokens: 100, outputTokens: 10, costUsd: 0.25 }, codex: { inputTokens: 1000, outputTokens: 50 } }), h({ codex: { inputTokens: 500, outputTokens: 25 } }), h({ claude: { costUsd: 0.17 } }), h({ hermes: {} })] } as unknown as RunState;
  const t = usageTotals(s)!;
  assert.equal(t.summary, "Claude $0.42; Codex 1,500 in / 75 out tokens");
  const all = JSON.stringify(t);
  assert.doesNotMatch(all, /n\/a/);
  assert.doesNotMatch(all, /subscription/);
  assert.deepEqual(t.byHarness.codex, { inputTokens: 1500, outputTokens: 75 });
  assert.equal(t.byHarness.hermes, undefined, "a harness that reported nothing is left out");
  // A package's harness is named by its id, and counts as paid for the usage guard.
  const pkg = usageTotals({ history: [h({ hermes: { inputTokens: 10, outputTokens: 2 } })] } as unknown as RunState)!;
  assert.equal(pkg.summary, "hermes 10 in / 2 out tokens");
  assert.deepEqual(["claude", "codex", "hermes", "local", "mock", "shell"].map(paidHarness), [true, true, true, false, false, false]);
});

// ── 3. The lease at the end of `mw run` ─────────────────────────────────────────────────────

test("'mw run' releases the lease when the run ends done, keeps it with --keep-lease; also releases it while waiting at a stop point", () => {
  const env = (s: string) => ({ MW_MOCK_SCRIPT: s, MW_HOST: "alpha" });
  const noHolder = /no machine holds the lease/;
  const heldHere = /lease held by alpha \(pid \d+, this machine\)/;

  // Done: released.
  let p = hubPair();
  let r = mw(p.a, ["run", ID], env(useScript(script())));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /DEMO-1 is done/);
  assert.match(r.out, /released the lease/);
  assert.match(mw(p.a, ["lease", "show"], env("")).out, noHolder);

  // Done with --keep-lease: held.
  p = hubPair();
  r = mw(p.a, ["run", ID, "--keep-lease"], env(useScript(script())));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /DEMO-1 is done/);
  assert.match(mw(p.a, ["lease", "show"], env("")).out, heldHere);

  // Waiting for 'go': released (the stop point is in the run state; whoever
  // approves takes the lease again); 'mw approve' that finishes the run releases it too.
  p = hubPair({ cardExtra: "risk: high\n" });
  const sc = useScript(script());
  r = mw(p.a, ["run", ID], env(sc));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /waiting before 'implement' for approval 'go'/);
  assert.match(mw(p.a, ["lease", "show"], env(sc)).out, noHolder);
  r = mw(p.a, ["approve", ID, "go"], env(sc));
  assert.match(r.out, /waiting before 'merge' for approval 'merge'/);
  assert.match(mw(p.a, ["lease", "show"], env(sc)).out, noHolder);
  r = mw(p.a, ["approve", ID, "merge"], env(sc));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /DEMO-1 is done/);
  assert.match(mw(p.a, ["lease", "show"], env(sc)).out, noHolder);
});

// ── 4. Documentation paths in a card's scope ────────────────────────────────────────────────

test("'mw card new' adds docs.paths to the scope (--no-docs opts out), and 'mw check' warns card/scope-docs for a todo or ready card without them", () => {
  const dir = project();
  let r = mw(dir, ["card", "new", "--title", "With docs", "--kind", "chore", "--scope", "lib/**"]);
  assert.equal(r.code, 0, r.err);
  const withDocs = read(dir, "cards/DEMO-2.card.md");
  assert.match(withDocs, /scope:[\s\S]*lib\/\*\*[\s\S]*docs\/\*\*[\s\S]*README\.md/);
  assert.deepEqual(codes(dir, "warning"), [], "the default card has its documentation paths");

  r = mw(dir, ["card", "new", "--title", "Without docs", "--kind", "chore", "--scope", "lib/**", "--no-docs"]);
  assert.equal(r.code, 0, r.err);
  const without = read(dir, "cards/DEMO-3.card.md");
  assert.doesNotMatch(without, /docs\/\*\*|README\.md/);
  assert.deepEqual(codes(dir, "warning"), ["card/scope-docs"]);
  const json = JSON.parse(mw(dir, ["check", "--json"]).out) as { diagnostics: { code: string; file: string }[] };
  assert.deepEqual(json.diagnostics.filter((x) => x.code === "card/scope-docs").map((x) => x.file), ["cards/DEMO-3.card.md"]);

  // Not for a card that is past planning, nor when the project has no documentation paths.
  write(dir, "cards/DEMO-3.card.md", without.replace("status: todo", "status: blocked"));
  assert.deepEqual(codes(dir, "warning"), []);
  write(dir, "cards/DEMO-3.card.md", without);
  write(dir, "mergewright.yaml", `${read(dir, "mergewright.yaml").trimEnd()}\ndocs:\n  paths: []\n`);
  assert.deepEqual(codes(dir, "warning"), []);
});

// ── 5. Codex home sweep ─────────────────────────────────────────────────────────────────────

test("a run removes per-run Codex homes left by a hard-killed run, and keeps the one of a card another live process is running", async () => {
  const dir = project();
  const home = (card: string) => LOCAL(dir, "codex-home", card);
  for (const card of ["DEMO-7", ID, "DEMO-2"]) {
    fs.mkdirSync(path.join(home(card), "01-review-reviewer"), { recursive: true });
    fs.writeFileSync(path.join(home(card), "01-review-reviewer", "auth.json"), "{}\n", { mode: 0o600 });
  }
  const live = sleeper();
  try {
    fs.mkdirSync(LOCAL(dir, "locks"), { recursive: true });
    fs.writeFileSync(LOCAL(dir, "locks", "DEMO-2.lock"), JSON.stringify({ pid: live.pid, host: "here", started: new Date().toISOString(), procStart: startTime(live.pid) }) + "\n");
    useScript(script());
    const lines: string[] = [];
    const s = await runCard(new Project(dir), ID, { until: "gate", onProgress: (l) => lines.push(l) }, { hub: fakeHub(), integrations: fakeIntegrations() });
    assert.equal(s.status, "running", s.reason);
    assert.equal(fs.existsSync(home("DEMO-7")), false, "a leftover of a card with no live run is removed");
    assert.equal(fs.existsSync(home(ID)), false, "the run's own card started no Codex agent yet: its leftover goes too");
    assert.ok(fs.existsSync(home("DEMO-2")), "the card another live process is running keeps its Codex home");
    const removed = s.warnings.filter((w) => /per-run Codex home/.test(w));
    assert.equal(removed.length, 2, s.warnings.join("\n"));
    assert.ok(removed.some((w) => w.includes("codex-home/DEMO-7")));
    assert.ok(lines.some((l) => l.includes("codex-home/DEMO-7")), "and the line is printed");
  } finally {
    live.stop();
  }
});

// ── 6. `mw abort` and the orphans record ────────────────────────────────────────────────────

test("'mw abort --force' is refused while a process of the orphans record lives; a plain abort reports it and leaves the worktree in place", async () => {
  const dir = project();
  useScript(script());
  const s0 = await run(dir, { until: "gate" });
  assert.equal(s0.status, "running", s0.reason);
  assert.ok(fs.existsSync(WT(dir)));
  const stuck = sleeper();
  try {
    const file = LOCAL(dir, "locks", `${ID}.orphans`);
    fs.writeFileSync(file, JSON.stringify({ card: ID, host: "here", written: new Date().toISOString(), groups: [{ pgid: stuck.pid, members: [{ pid: stuck.pid, started: startTime(stuck.pid) }] }] }));
    const before = read(runPath(dir), "state.json");
    await assert.rejects(
      abort(new Project(dir), ID, { force: true }, { hub: fakeHub(), integrations: fakeIntegrations() }),
      (e: Error & { code?: string }) => e.code === "run/orphans-alive" && new RegExp(`process group ${stuck.pid}\\b`).test(e.message),
    );
    assert.ok(fs.existsSync(WT(dir)), "the worktree was not moved");
    assert.ok(branchExists(dir, `card/${ID}`), "the branch was not deleted");
    assert.equal(read(runPath(dir), "state.json"), before, "nothing of the run changed");

    // The command line says the same.
    let r = mw(dir, ["abort", ID, "--force"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /was not aborted: process group \d+.*still alive/);

    // A plain abort marks the run aborted, but reports the process and does not touch the worktree.
    r = mw(dir, ["abort", ID]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`DEMO-1 aborted, but process group ${stuck.pid}\\b.*still alive, so the worktree was left where it is`));
    assert.ok(fs.existsSync(WT(dir)));
    assert.equal(state(dir).status, "aborted");
  } finally {
    stuck.stop();
  }
  // Once the process is gone, the abort moves the worktree aside as usual.
  await new Promise((r) => setTimeout(r, 200));
  const r = mw(dir, ["abort", ID]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /its worktree was moved to/);
  assert.equal(fs.existsSync(WT(dir)), false);
});
