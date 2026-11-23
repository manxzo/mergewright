// Regression tests for the queue, sync files, configuration and card creation.
//   1. A queued Kanban item is not retried forever: an item whose target status the card has left is
//      dropped, a column only an agent session reaches is dropped after the first attempt (never
//      queued again), and `mw work` reports the cards the board cannot show right only when that changes.
//   2. Sync temp and conflict files are never committed or counted.
//   3. `mw config unset` removes parent maps it left empty.
//   4. The gate detail for gate/required-skipped names "NOT run: <step> (<reason>)".
//   5. The TUI lists the local model endpoint (on its Config screen).
//   6. `mw card new` refuses a card that needs a requirement and has none.
// Only long-standing symbols are imported statically (newer ones through namespace imports), so a
// missing newer one fails its own test instead of the whole file.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { flushQueue, queueFor } from "../src/integrations.ts";
import { newState, runDir, saveState } from "../src/engine/state.ts";
import { Project } from "../src/project.ts";
import { card, git, kanbanConfig, mw, newProject, read, tmpDir, write } from "./helpers.ts";
import { installFake, projectWith, queueItems } from "./fixtures/integrations/support.ts";

function kanbanProject(): { dir: string; stateFile: string; env: Record<string, string> } {
  const stateFile = path.join(tmpDir(), "kanban.json");
  process.env.FAKE_KANBAN_STATE = stateFile;
  process.env.FAKE_KANBAN_DOWN = "0";
  const { dir } = projectWith(kanbanConfig());
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1"));
  write(dir, "cards/DEMO-2.card.md", card("DEMO-2"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "cards");
  // The board shows both in backlog.
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: [
    { id: "t1", title: "[DEMO-1] Card DEMO-1", prompt: "[DEMO-1] Card DEMO-1", column: "backlog" },
    { id: "t2", title: "[DEMO-2] Card DEMO-2", prompt: "[DEMO-2] Card DEMO-2", column: "backlog" },
  ], calls: [], next: 3 }));
  return { dir, stateFile, env: { PATH: process.env.PATH!, FAKE_KANBAN_STATE: stateFile, FAKE_KANBAN_DOWN: "0" } };
}

function blockedRun(dir: string, id: string): void {
  const project = new Project(dir);
  const s = newState(id, "default");
  s.status = "blocked";
  s.reason = "the gate failed";
  saveState(runDir(project, id), s);
}

test("a queued kanban item is dropped when the card left its status, or when only an agent session reaches its column", async () => {
  const fake = installFake("kanban", "fake-kanban.mjs");
  after(fake.restore);
  const { dir } = kanbanProject();
  // DEMO-1: the card file says todo and no run exists; the queued item still wants blocked.
  // DEMO-2: its run is blocked (the live case: 36 retries of "should be in review but is in backlog").
  blockedRun(dir, "DEMO-2");
  const queue = queueFor(new Project(dir));
  queue.add("cline-kanban", "kanban: DEMO-1 -> blocked (pending)", { cardId: "DEMO-1", title: "Card DEMO-1", status: "blocked" }, "x");
  queue.add("cline-kanban", "kanban: DEMO-2 -> blocked (pending)", { cardId: "DEMO-2", title: "Card DEMO-2", status: "blocked" }, "x");
  const r = await flushQueue(new Project(dir));
  assert.equal(r.length, 2);
  assert.ok(r.every((x) => x.dropped === true), JSON.stringify(r));
  assert.match(r[0]!.error ?? "", /stale: DEMO-1 is now todo, not blocked; dropped/);
  assert.match(r[1]!.error ?? "", /DEMO-2 should be in review but is in backlog: .*agent session; dropped \(not retried/);
  assert.deepEqual(queueItems(dir), [], "nothing is left to retry");
});

test("mw work reports a card the board cannot show right once, not at every start", () => {
  const fake = installFake("kanban", "fake-kanban.mjs");
  after(fake.restore);
  const { dir, env } = kanbanProject();
  blockedRun(dir, "DEMO-2");
  const first = mw(dir, ["work"], env);
  assert.equal(first.code, 0, first.err + first.out);
  assert.match(first.out, /kanban: board reconciled before taking cards \(1 of 2 card\(s\) shown right; DEMO-2: DEMO-2 should be in review/);
  const second = mw(dir, ["work"], env);
  assert.equal(second.code, 0, second.err + second.out);
  assert.doesNotMatch(second.out, /board reconciled/, "unchanged: not printed again");
  // A change is printed again.
  fs.rmSync(runDir(new Project(dir), "DEMO-2"), { recursive: true });
  const third = mw(dir, ["work"], env);
  assert.match(third.out, /kanban: board reconciled before taking cards \(2 of 2 card\(s\) shown right\)/);
});

test("Sync temp and conflict files are ignored by init, never committed by the runtime, and reported by mw check when tracked", async () => {
  const { commitAll } = await import("../src/engine/gitops.ts");
  const { commitAlone } = await import("../src/mcpserver/repo.ts");
  const { scopeViolations } = await import("../src/engine/scope.ts");
  const { check } = await import("../src/check.ts");
  const dir = newProject();
  const ignore = read(dir, ".gitignore");
  assert.match(ignore, /^\.\*\.tmp$/m);
  assert.match(ignore, /^\*\.sync-conflict-\*$/m);
  // A checkout whose .gitignore predates them: the runtime still never adds them.
  write(dir, ".gitignore", ".mergewright/\n");
  git(dir, "commit", "-qam", "old ignore");
  write(dir, "src/a.txt", "a\n");
  write(dir, "src/.sync.a.txt.tmp", "partial\n");
  write(dir, "memory/lessons/testing.sync-conflict-20261006-101010-ABCDEFG.md", "theirs\n");
  write(dir, ".sync.top.tmp", "partial\n");
  assert.equal(commitAll(dir, "work"), true);
  assert.deepEqual(git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean), ["src/a.txt"]);
  // commitAlone (MCP writes, docs) leaves them out too.
  write(dir, "memory/STATE.md", "# State\n\nchanged\n");
  const line = commitAlone(new Project(dir), ["memory/STATE.md", "src/.sync.a.txt.tmp"], "memory: state");
  assert.match(line, /^committed memory\/STATE\.md as /);
  assert.deepEqual(git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean), ["memory/STATE.md"]);
  // The scope check does not count them.
  assert.deepEqual(scopeViolations(["src/.sync.a.txt.tmp", "docs/x.sync-conflict-1-2-3.md"], { cardScope: ["src/a.txt"], briefScope: [], protected: [], allowProtected: [] }), []);
  // Untracked: no stray-file warning; tracked: sync/temp-file.
  const codes = check(new Project(dir)).items.map((x) => x.code);
  assert.ok(!codes.includes("layout/stray-file"), codes.join(","));
  assert.ok(!codes.includes("sync/temp-file"), codes.join(","));
  git(dir, "add", "-f", "src/.sync.a.txt.tmp");
  git(dir, "commit", "-qm", "oops");
  const d = check(new Project(dir)).items.filter((x) => x.code === "sync/temp-file");
  assert.deepEqual(d.map((x) => [x.severity, x.file]), [["warning", "src/.sync.a.txt.tmp"]]);
});

test("mw config unset removes the parent maps it left empty, keeping comments", () => {
  const dir = newProject();
  write(dir, "mergewright.yaml", `${read(dir, "mergewright.yaml").trimEnd()}\n# Models per role.\nroles:\n  reviewer:\n    model: opus   # the deep one\nreport: {command: "true"}\n`);
  git(dir, "commit", "-qam", "roles");
  let r = mw(dir, ["config", "unset", "roles.reviewer.model"]);
  assert.equal(r.code, 0, r.err);
  const text = read(dir, "mergewright.yaml");
  assert.doesNotMatch(text, /^ +reviewer:/m);
  assert.doesNotMatch(text, /^roles:/m);
  assert.match(text, /# Models per role\./, "the comment is kept");
  r = mw(dir, ["config", "get", "roles.reviewer"]);
  assert.equal(r.out.trim(), "(not set)");
  assert.equal(mw(dir, ["config", "get", "roles"]).out.trim(), "(not set)");
  assert.equal(mw(dir, ["check"]).code, 0);
  // A parent that still holds something stays.
  write(dir, "mergewright.yaml", `${text.trimEnd()}\nroles:\n  reviewer: {model: opus, runs: claude}\n`);
  assert.equal(mw(dir, ["config", "unset", "roles.reviewer.model"]).code, 0);
  assert.equal(mw(dir, ["config", "get", "roles.reviewer.runs"]).out.trim(), "claude");
});

test("the blocked gate detail for gate/required-skipped says \"NOT run: <step> (<reason>)\"", async () => {
  const { runGate } = await import("../src/engine/gate.ts");
  const dir = tmpDir();
  const file = path.join(dir, "default.gate.sh");
  fs.writeFileSync(file, `#!/usr/bin/env bash
set -u
mkdir -p "$MERGEWRIGHT_GATE_LOGS"
log="$MERGEWRIGHT_GATE_LOGS/check.log"
echo "all fine" > "$log"
printf '{"ok":true,"steps":[{"name":"check","kind":"test","ok":true,"seconds":0,"log":"%s"},{"name":"db_api","kind":"test","ok":true,"seconds":0,"skipped":true,"reason":"DATABASE_URL not set"}]}\\n' "$log" > "$MERGEWRIGHT_GATE_JSON"
exit 0
`);
  fs.chmodSync(file, 0o755);
  const r = await runGate({ id: "default", file, cwd: dir, runDir: path.join(dir, "run"), base: "main", minutes: 1, env: { PATH: process.env.PATH! }, required: ["db_api"] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "gate/required-skipped");
  assert.match(r.detail, /NOT run: db_api \(DATABASE_URL not set\)/);
});


test("the TUI lists the local model endpoint (Config, without credentials); a service not configured says so once", async () => {
  const { loadData } = await import("../src/tui/data.ts");
  const { initState } = await import("../src/tui/model.ts");
  const { render } = await import("../src/tui/render.ts");
  const { dir, project } = projectWith({
    local_models: { endpoint: "http://user:pw@llama.test:8081/v1", key_env: "LLAMACPP_TEST_KEY_X" },
  });
  assert.ok(dir);
  const data = loadData(project);
  const keys = data.config.map((c) => c.key);
  assert.ok(keys.includes("local_models.endpoint") && keys.includes("report.command"), keys.join(","));
  const base = { ...initState(data), screen: "config" as const };
  const at = (key: string) => render({ ...base, sel: { ...base.sel, config: keys.indexOf(key) } }, 100, 30).join("\n");
  const local = at("local_models.endpoint");
  assert.match(local, /value +http:\/\/llama\.test:8081\/v1/);
  assert.doesNotMatch(local, /pw@/);
  assert.match(at("local_models.key_env"), /value +LLAMACPP_TEST_KEY_X/);
  // Overview: the probe of a service that is not configured says so, once.
  const probed = render({ ...initState(data), probes: { report: { state: "not configured" } } }, 100, 30).join("\n");
  assert.match(probed, /Report +not configured +│?/);
  assert.doesNotMatch(probed, /not configured, not configured/);
});

test("mw card new refuses a feature card without --implements, with mw check's message; chore and docs cards need none", () => {
  const dir = newProject({ example: true });
  const before = fs.readdirSync(path.join(dir, "cards")).sort();
  let r = mw(dir, ["card", "new", "--title", "A feature", "--scope", "src/**"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /a feature card must say which requirement it implements \('implements: \[REQ-\.\.\.\]'\); use kind: chore, fix, docs or spike for work with no requirement/);
  assert.match(r.err, /not written/);
  assert.deepEqual(fs.readdirSync(path.join(dir, "cards")).sort(), before, "nothing was written");
  r = mw(dir, ["card", "new", "--title", "Explicit feature", "--kind", "feature", "--scope", "src/**"]);
  assert.equal(r.code, 1);
  for (const kind of ["chore", "docs"]) {
    r = mw(dir, ["card", "new", "--title", `A ${kind}`, "--kind", kind, "--scope", "src/**"]);
    assert.equal(r.code, 0, r.err);
  }
  r = mw(dir, ["card", "new", "--title", "Implemented", "--implements", "REQ-example-001", "--scope", "src/**"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(mw(dir, ["check"]).code, 0, mw(dir, ["check"]).out);
});
