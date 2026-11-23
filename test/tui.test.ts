import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Project } from "../src/project.ts";
import { optionsFor, parseModelList } from "../src/tui/catalog.ts";
import { loadData, type Data } from "../src/tui/data.ts";
import { execute } from "../src/tui/effects.ts";
import type { CardRow, PackagesData, StatusData } from "../src/mcpserver/results.ts";
import { initState, reduce, settle, type Ctx, type Effect, type State } from "../src/tui/model.ts";
import { paint, render } from "../src/tui/render.ts";
import { decodeKeys } from "../src/tui/term.ts";
import { MW, newProject, read, write } from "./helpers.ts";

/** A fake of what the loader reads, so the reducer and renderer run without a project. */
function fakeData(): Data {
  return {
    name: "demo", spec: "0.1", root: "/tmp/demo",
    roles: [
      { id: "planner", origin: "standard", runs: "hermes", mode: "advise", output: "brief", description: "Plans the card.", overrides: [] },
      { id: "worker", origin: "standard", runs: "claude", model: "opus", mode: "write", output: "handoff", description: "Does the work.", overrides: [] },
      { id: "mine", origin: "project", runs: "local", profile: "qwen3.5:9b", mode: "advise", output: "text", description: "Local helper.", overrides: ["profile"] },
    ],
    config: [
      { key: "cards.mirror", effective: "none", description: "", type: "one of none, kanban", options: ["none", "kanban"] },
      { key: "limits.rounds", value: "2", effective: "2", description: "", type: "integer, minimum 0", options: [] },
      { key: "trace.ignore", effective: "[]", description: "Paths whose @req comments are not counted (fixtures, vendored code).", type: "list of string", options: [] },
    ],
    mcps: [
      { id: "github", origin: "project", transport: "http", target: "https://api.example.test/mcp", roles: "worker", envNames: [], headerNames: ["Authorization"], enabled: true, description: "GitHub" },
      { id: "fs", origin: "standard", transport: "stdio", target: "npx fs-server", roles: "all", envNames: ["TOKEN"], headerNames: [], enabled: true, description: "" },
    ],
    cards: [["todo", 2], ["ready", 1], ["in_progress", 0], ["review", 0], ["blocked", 0], ["done", 3]],
    localEndpoint: "http://ollama.test:11434/v1",
    problems: [],
  };
}

const fakeCtx: Ctx = { options: optionsFor };

/** Press keys in order; collect every effect. */
function press(s: State, keys: string[], ctx: Ctx = fakeCtx): { state: State; effects: Effect[] } {
  const effects: Effect[] = [];
  for (const k of keys) {
    const r = reduce(s, k, ctx);
    s = r.state;
    effects.push(...r.effects);
  }
  return { state: s, effects };
}
const type = (text: string) => [...text];
const screen = (s: State) => render(s, 80, 24).join("\n");

// ── Reducer ──────────────────────────────────────────────────────────────────────────────────

test("tui: Tab, Shift-Tab, arrows and digits move between the eight screens", () => {
  let s = initState(fakeData());
  const seen: string[] = [s.screen];
  for (let i = 0; i < 8; i++) { s = reduce(s, "tab").state; seen.push(s.screen); }
  assert.deepEqual(seen, ["overview", "roles", "models", "config", "packages", "mcps", "board", "approvals", "overview"]);
  assert.equal(reduce(s, "btab").state.screen, "approvals");
  assert.equal(reduce(s, "left").state.screen, "approvals");
  assert.equal(reduce(s, "4").state.screen, "config");
  assert.equal(reduce(s, "?").state.help, true);
  assert.equal(reduce(reduce(s, "?").state, "esc").state.help, false);
});

test("tui: q quits, but asks first when changes are unsaved; Ctrl-C always quits", () => {
  const s = initState(fakeData());
  assert.deepEqual(reduce(s, "q").effects, [{ kind: "quit" }]);
  const dirty = { ...s, pending: [{ kind: "save", key: "limits.rounds", value: "3" } as Effect] };
  const asked = reduce(dirty, "q");
  assert.deepEqual(asked.effects, []);
  assert.equal(asked.state.confirm?.kind, "quit");
  assert.deepEqual(reduce(asked.state, "y").effects, [{ kind: "quit" }]);
  assert.equal(reduce(asked.state, "n").state.confirm, undefined);
  assert.deepEqual(reduce(dirty, "ctrl-c").effects, [{ kind: "quit" }]);
});

test("tui Roles: Enter opens the fields, the picker offers the harness's models, free text is allowed, s saves", () => {
  let { state } = press(initState(fakeData()), ["2", "down", "enter"]);
  assert.equal(state.focus, "detail");
  ({ state } = press(state, ["down", "down", "enter"]));
  assert.equal(state.editor?.key, "roles.worker.model");
  assert.ok(state.editor!.options.includes("claude-opus-5-5"));
  ({ state } = press(state, type("son")));
  assert.match(screen(state), /▸ son  \(free text\)/);
  assert.match(screen(state), / {3}sonnet/);
  assert.match(screen(state), /claude-sonnet-5-5/);
  assert.doesNotMatch(screen(state), /claude-opus-5-5/);
  let r = press(state, ["enter"]);
  assert.equal(r.state.editor, undefined);
  assert.deepEqual(r.state.pending, [{ kind: "save", key: "roles.worker.model", value: "son", literal: true }], "the free text comes first");
  // Down to the catalogue entry instead.
  r = press(state, ["down", "enter"]);
  assert.deepEqual(r.state.pending, [{ kind: "save", key: "roles.worker.model", value: "sonnet", literal: true }]);
  assert.match(screen(r.state), /model +sonnet +\* unsaved/);
  const saved = press(r.state, ["s"]);
  assert.deepEqual(saved.effects, [{ kind: "save", key: "roles.worker.model", value: "sonnet", literal: true }]);
});

test("tui Roles: the picker follows a staged harness; a package harness's provider is free text; e ejects a preset role only", () => {
  let { state } = press(initState(fakeData()), ["2", "enter", "down", "enter"]);
  assert.equal(state.editor?.key, "roles.planner.provider");
  assert.equal(state.editor!.options.length, 0, "the core suggests no providers for a package's harness (hermes)");
  ({ state } = press(state, ["esc", "up", "enter", ...type("codex"), "enter", "down", "down", "enter"]));
  assert.equal(state.editor?.key, "roles.planner.model");
  assert.ok(state.editor!.options.includes("gpt-5.6-sol"), "runs is staged as codex, so codex models are offered");
  assert.deepEqual(press(initState(fakeData()), ["2", "e"]).effects, [{ kind: "eject", what: "role", id: "planner" }]);
  const own = press(initState(fakeData()), ["2", "down", "down", "e"]);
  assert.deepEqual(own.effects, []);
  assert.match(own.state.message!.text, /already the project's own/);
});

test("tui Config: Enter edits a key with its enum, the value is staged as YAML, (unset) removes it", () => {
  let { state } = press(initState(fakeData()), ["4", "enter"]);
  assert.deepEqual(state.editor?.options, ["none", "kanban"]);
  ({ state } = press(state, ["down", "enter"]));
  assert.deepEqual(state.pending, [{ kind: "save", key: "cards.mirror", value: "kanban", literal: false }]);
  ({ state } = press(state, ["down", "enter", "backspace", ...type("5"), "enter"]));
  assert.deepEqual(state.pending[1], { kind: "save", key: "limits.rounds", value: "5", literal: false });
  ({ state } = press(state, ["down", "enter", "down", "enter"]));
  assert.equal(state.editor, undefined);
  const unset = press(initState(fakeData()), ["4", "down", "enter", "backspace", "up", "down", "enter"]);
  assert.deepEqual(unset.state.pending, [{ kind: "save", key: "limits.rounds", value: undefined, literal: false }]);
  assert.equal(press(state, ["s"]).effects.length, state.pending.length);
});

// ── Board, Approvals, Packages (data from the tool layer: mw_status, mw_card_get, mw_run_status, mw_packages) ──

function row(id: string, status: CardRow["status"], extra: Partial<CardRow> = {}): CardRow {
  return {
    id, title: `Card ${id}`, kind: "chore", status, label: status, cardStatus: "todo", runStatus: null, flow: "standard", phase: null,
    risk: "medium", reason: null, ask: null, usage: null, agents: [], depends: [], implements: [], ...extra,
  };
}
const boardData = (): StatusData => ({
  cards: [
    row("DEMO-1", "done"), row("DEMO-2", "waiting", { ask: "go", reason: "go", phase: "build", label: "waiting before 'build' for approval 'go'" }),
    row("DEMO-3", "blocked", { reason: "gate failed", phase: "gate" }), row("DEMO-4", "todo"), row("DEMO-5", "todo"), row("DEMO-6", "aborted"),
    row("DEMO-7", "waiting", { reason: "usage" }),
  ],
  configErrors: [],
});
const withBoard = (screen: "board" | "approvals") => settle({ ...initState(fakeData()), screen }, { kind: "tool", name: "mw_status", args: {}, into: "board" }, { ok: true, message: "", data: boardData() });

test("tui Board: cards grouped by status, one column at a time; ← → change column, ↑↓ move; r sets a To do card ready", () => {
  const s0 = withBoard("board");
  assert.match(screen(s0), /\[To do 2\] Ready 0 Running 0 Queued 0 Waiting for you 2 Blocked 1 Done 2/, "counts of every column, aborted folded into Done");
  let { state, effects } = press(s0, ["down"]);
  assert.match(screen(state), /▸ DEMO-5/);
  ({ state, effects } = press(state, ["r"]));
  assert.deepEqual(effects, [{ kind: "tool", name: "mw_card_set_status", args: { id: "DEMO-5", status: "ready" }, into: "action" }, { kind: "tool", name: "mw_status", args: {}, into: "board" }]);
  state = press(s0, ["right", "right", "right", "right"]).state;
  assert.match(screen(state), /\[Waiting for you 2\]/);
  assert.match(screen(state), /Needs your approval: go/);
  assert.match(screen(press(state, ["down"]).state), /Paused for usage/);
  assert.match(press(state, ["r"]).state.message!.text, /only a card in To do can be set ready/);
  const blocked = press(state, ["right"]).state;
  ({ state, effects } = press(blocked, ["R"]));
  assert.deepEqual(effects, [], "retry asks first");
  assert.match(screen(state), /Retry DEMO-3/);
  assert.deepEqual(press(state, ["y"]).effects[0], { kind: "tool", name: "mw_retry", args: { id: "DEMO-3", run: true }, into: "action" });
  assert.equal(press(s0, ["left", "left"]).state.col, 0);
  assert.equal(press(s0, Array(9).fill("right")).state.col, 6);
});

test("tui Board: Enter opens a card: its facts, its sections, its run and the run's files; Esc goes back", () => {
  let { state, effects } = press(withBoard("board"), ["right", "right", "right", "right", "enter"]);
  assert.deepEqual(effects, [{ kind: "tool", name: "mw_card_get", args: { id: "DEMO-2" }, into: "card" }, { kind: "tool", name: "mw_run_status", args: { id: "DEMO-2" }, into: "run" }]);
  const card = { card: row("DEMO-2", "waiting"), file: "cards/DEMO-2.card.md", sections: { why: "Users leave too.", acceptance: "- says goodbye" }, body: "", scope: ["src/**"], depends: [], implements: [], lint: { ok: true, findings: [] } };
  const run = { exists: true, summary: "waits for go", round: 1, maxRounds: 3, approvals: [], merged: null, conditions: [{ what: "tests", how: "add one" }], warnings: [], phases: [{ id: "plan", done: true, current: false }, { id: "build", done: false, current: true }], files: [{ name: "brief.json", kind: "brief", size: 120 }] };
  state = settle(state, effects[0]!, { ok: true, message: "", data: card });
  state = settle(state, effects[1]!, { ok: true, message: "", data: run });
  const text = render(state, 80, 40).join("\n");
  for (const p of [/file +cards\/DEMO-2\.card\.md/, /── why/, /Users leave too\./, /── run/, /phases +✓plan ▸build/, /tests: add one/, /run files:/, /brief\.json +brief, 120 B/, /Esc back/]) assert.match(text, p);
  assert.ok(press(state, ["down", "down"]).state.detail!.scroll === 2);
  assert.equal(press(state, ["esc"]).state.detail, undefined);
});

test("tui Approvals: a shows what it approves and asks; y runs mw_approve then re-reads; the card's new state is reported", async () => {
  const s0 = withBoard("approvals");
  assert.match(screen(s0), /▸ DEMO-2 +go/);
  assert.doesNotMatch(screen(s0), /DEMO-7/, "a card paused for usage is not an approval");
  let { state, effects } = press(s0, ["a"]);
  assert.deepEqual(effects, [], "nothing is applied before y");
  const text = screen(state);
  for (const p of [/Approve 'go' for DEMO-2 \(Card DEMO-2\)\?/, /phase +build/, /mw approve DEMO-2 go/, /y approves, any other key cancels/]) assert.match(text, p);
  assert.match(press(state, ["n"]).state.message!.text, /cancelled/);
  assert.deepEqual(press(state, ["n"]).effects, []);
  ({ state, effects } = press(state, ["y"]));
  assert.deepEqual(effects, [{ kind: "tool", name: "mw_approve", args: { id: "DEMO-2", word: "go" }, into: "action" }, { kind: "tool", name: "mw_status", args: {}, into: "board" }]);
  assert.match(state.message!.text, /approving DEMO-2 \(go\)/);
  // The executor reports the card's new state from the tool's data, as the GUI does.
  const dir = newProject();
  const r = await execute(dir, { kind: "tool", name: "mw_approve", args: { id: "DEMO-1", word: "go" }, into: "action" });
  assert.equal(r.ok, false);
  assert.match(r.message, /DEMO-1/);
  assert.doesNotMatch(r.message, /\n/);
  const after = settle(state, effects[0]!, { ok: true, message: "DEMO-2: running", data: {} });
  assert.match(screen(after), /DEMO-2: running/);
});

test("tui Packages: installed ones with exports and health, the official ones not installed with the 'mw add' command; none installed", async () => {
  const s0 = { ...initState(fakeData()), screen: "packages" as const };
  assert.match(screen(s0), /loading/);
  const pkg = { name: "mem0", version: "0.1.0", description: "Lessons in mem0.", installed: true, enabled: true, loaded: true, error: null, provides: ["recall", "checks"], missingSettings: [], secrets: ["MEM0_API_KEY"], notes: [], checks: [{ name: "mem0", ok: false, detail: "NOT reachable (timed out)" }] };
  const avail = { name: "letta", version: "0.1.0", description: "Memory in Letta.", exports: ["recall", "tools"] };
  let s = settle(s0, { kind: "tool", name: "mw_packages", args: { checks: true }, into: "packages" }, { ok: true, message: "", data: { packages: [pkg], available: [avail] } });
  for (const p of [/▸ mem0 +0\.1\.0/, /letta +available/, /exports +recall, checks/, /secrets +MEM0_API_KEY/, /mem0 +NOT ok +NOT reachable \(timed out\)/]) assert.match(screen(s), p);
  s = press(s, ["down"]).state;
  for (const p of [/letta 0\.1\.0 +\(official, not installed\)/, /exports +recall, tools/, /mw add letta/]) assert.match(screen(s), p);
  // Through the tool layer on a project with no package: every official package is offered.
  const r = await execute(newProject(), { kind: "tool", name: "mw_packages", args: { checks: true }, into: "packages" });
  assert.equal(r.ok, true, r.message);
  const data = r.data as PackagesData;
  assert.deepEqual(data.packages, []);
  assert.deepEqual(data.available.map((a) => a.name), ["board-4ga", "cline-kanban", "hermes", "letta", "mem0", "notebook-opennotelm", "open-notebook"]);
  s = settle(s0, { kind: "tool", name: "mw_packages", args: {}, into: "packages" }, r);
  assert.match(screen(s), /▸ board-4ga +available/);
  assert.match(screen(s), /mw add board-4ga/);
});

test("tui render: Board, Approvals and an approval fit 80 columns", () => {
  const b = withBoard("board");
  const views = [b, press(b, ["right", "right", "right", "right", "a"]).state, withBoard("approvals"), press(withBoard("approvals"), ["a"]).state];
  for (const v of views) {
    const lines = render(v, 80, 24);
    assert.equal(lines.length, 24);
    for (const l of lines) assert.ok([...l].length <= 80, `line wider than 80: ${l}`);
    assert.match(lines.at(-1)!, /q quit|y confirms/);
  }
  assert.match(render(b, 80, 24)[2]!, /^\[To do 2\] .* Done 2 *$/, "the column strip sits under the header");
});

test("tui MCPs: a adds through a form, Enter changes roles, d removes after y, preset servers are not removed", () => {
  const s0 = press(initState(fakeData()), ["6"]).state;
  let { state, effects } = press(s0, ["a", ...type("docs"), "enter", ...type("npx docs-mcp --stdio"), "enter", ...type("TOKEN=${DOCS_TOKEN}"), "enter", "enter", ...type("worker,planner"), "enter", "enter", "enter"]);
  assert.equal(state.form, undefined);
  assert.deepEqual(effects, [{ kind: "mcp-add", spec: { id: "docs", command: "npx docs-mcp --stdio", url: undefined, env: { TOKEN: "${DOCS_TOKEN}" }, headers: {}, roles: ["worker", "planner"], description: undefined } }]);
  const bad = press(s0, ["a", "down", "down", "down", "down", "down", "down", "enter"]);
  assert.match(bad.state.message!.text, /needs an id/);
  ({ state } = press(s0, ["enter", ...type("all"), "enter"]));
  assert.deepEqual(state.pending, [{ kind: "mcp-roles", id: "github", roles: ["all"] }]);
  ({ state, effects } = press(s0, ["d"]));
  assert.equal(state.confirm?.kind, "mcp-remove");
  assert.deepEqual(press(state, ["y"]).effects, [{ kind: "mcp-remove", id: "github" }]);
  assert.deepEqual(press(state, ["n"]).effects, []);
  const preset = press(s0, ["down", "d"]);
  assert.equal(preset.state.confirm, undefined);
  assert.deepEqual(press(s0, ["down", "e"]).effects, [{ kind: "eject", what: "mcp", id: "fs" }]);
});

test("tui Models: static lists per harness, the local fallback, then the live list", () => {
  let s = press(initState(fakeData()), ["3"]).state;
  assert.match(screen(s), /claude-haiku-4-5-20251001/);
  s = press(s, ["down"]).state;
  assert.match(screen(s), /gpt-6-astra-900k/);
  s = press(s, ["down"]).state; // the hermes row went with the hermes package
  assert.doesNotMatch(screen(s), /providers:/);
  assert.match(screen(s), /qwen3\.5:9b/);
  assert.match(screen(s), /fallback list/);
  const live = settle(s, { kind: "probe" }, { ok: true, message: "", live: { endpoint: "http://ollama.test:11434/v1", models: ["gemma4:26b", "qwen3.6:35b"] } });
  assert.match(screen(live), /live list from/);
  assert.match(screen(live), /qwen3\.6:35b/);
  assert.deepEqual(optionsFor("model", "local", live.live), ["gemma4:26b", "qwen3.6:35b"]);
  assert.deepEqual(parseModelList({ data: [{ id: "b" }, { id: "a" }] }), ["a", "b"]);
  assert.deepEqual(parseModelList({ models: [{ name: "qwen3.5:9b" }] }), ["qwen3.5:9b"]);
});

// ── Render ───────────────────────────────────────────────────────────────────────────────────

test("tui render: 80x24 snapshots of every screen (header, list | detail, footer), plain text until paint", () => {
  const expect: Record<string, RegExp[]> = {
    overview: [/\[Overview\]/, /todo +2/, /done +3/, /project +demo/, /Local models +not probed yet/, /cards +6 in all/],
    roles: [/\[Roles\]/, /▸ planner +hermes/, /worker +claude/, /planner +\(preset standard\)/, /runs +hermes/, /output +brief/, /e eject/],
    models: [/\[Models\]/, /▸ claude/, /opus/, /sonnet/],
    config: [/\[Config\]/, /▸ cards\.mirror/, /value +\(default\) none/, /type +one of none, kanban/],
    packages: [/\[Packages\]/, /loading/],
    mcps: [/\[MCPs\]/, /▸ github/, /transport http/, /headers +Authorization/, /a add/],
    board: [/\[Board\]/, /\[To do 0\]/, /reading the board/],
    approvals: [/\[Approvals\]/, /reading the board/],
  };
  let s = initState(fakeData());
  for (const [name, patterns] of Object.entries(expect)) {
    const lines = render(s, 80, 24);
    assert.equal(lines.length, 24, name);
    for (const l of lines) assert.ok([...l].length <= 80, `${name}: line wider than 80: ${l}`);
    assert.match(lines[0]!, /^ demo 0\.1 │/);
    assert.match(lines[1]!, /^─+$/);
    assert.match(lines[23]!, /Tab screen .* q quit/);
    for (const l of lines) assert.doesNotMatch(l, /\x1b/);
    const text = lines.join("\n");
    for (const p of patterns) assert.match(text, p, `${name} shows ${p}`);
    s = reduce(s, "tab").state;
  }
  const painted = paint(render(s, 80, 24));
  assert.match(painted[0]!, /^\x1b\[7m/);
});

test("tui render: a small terminal still fits, and the list scrolls to the selection", () => {
  const d = fakeData();
  d.config = Array.from({ length: 30 }, (_, i) => ({ key: `limits.k${i}`, effective: "1", description: "", type: "integer", options: [] }));
  const s = press(initState(d), ["4", ...Array(25).fill("down")]).state;
  const lines = render(s, 60, 12);
  assert.equal(lines.length, 12);
  assert.match(lines.join("\n"), /▸ limits\.k25/);
});

test("tui keys: escape sequences, Enter, Tab, Backspace, Ctrl-C and printable characters", () => {
  assert.deepEqual(decodeKeys("\x1b[A\x1b[B\x1b[C\x1b[D\x1b[Z\r\t\x7fa?\x03\x1b"), ["up", "down", "right", "left", "btab", "enter", "tab", "backspace", "a", "?", "ctrl-c", "esc"]);
  assert.deepEqual(decodeKeys("\x1bOA\x1b[3~é"), ["up", "delete", "é"]);
});

// ── Against a project ────────────────────────────────────────────────────────────────────────

async function run(root: string, s: State, effects: Effect[]): Promise<State> {
  for (const e of effects) {
    const result = await execute(root, e);
    s = settle(s, e, result, loadData(new Project(root)));
  }
  return s;
}

test("tui: a role model change through reduce and its effects lands in mergewright.yaml and in Project.load()", async () => {
  const dir = newProject();
  const s0 = initState(loadData(new Project(dir)));
  const worker = s0.data.roles.findIndex((r) => r.id === "worker");
  const { state, effects } = press(s0, ["2", ...Array(worker).fill("down"), "enter", "down", "down", "enter", ...type("sonnet"), "enter", "s"]);
  assert.deepEqual(effects, [{ kind: "save", key: "roles.worker.model", value: "sonnet", literal: true }]);
  const after = await run(dir, state, effects);
  assert.deepEqual(after.pending, []);
  assert.equal(after.message?.error, false);
  assert.match(read(dir, "mergewright.yaml"), /worker:\s*\n?\s*model: sonnet|worker: \{model: sonnet\}/);
  assert.equal(Project.load(dir).roles().get("worker")!.model, "sonnet");
  assert.match(screen({ ...after, focus: "list" }), /model +sonnet +\(mergewright\.yaml\)/);
});

test("tui: an invalid limits.rounds is refused with the validator's message, stays staged, and the file is unchanged", async () => {
  const dir = newProject();
  const before = read(dir, "mergewright.yaml");
  const s0 = initState(loadData(new Project(dir)));
  const row = s0.data.config.findIndex((c) => c.key === "limits.rounds");
  const { state, effects } = press(s0, ["4", ...Array(row).fill("down"), "enter", "backspace", ...type("-1"), "enter", "s"]);
  assert.deepEqual(effects, [{ kind: "save", key: "limits.rounds", value: "-1", literal: false }]);
  const after = await run(dir, state, effects);
  assert.equal(after.message?.error, true);
  assert.match(after.message!.text, /not changed, because the result would be invalid/);
  assert.equal(after.pending.length, 1);
  assert.equal(read(dir, "mergewright.yaml"), before);
  assert.match(screen(after), /^! .*not changed/m);
});

test("tui: MCP add, change roles, remove and eject go through the CLI's functions", async () => {
  const dir = newProject();
  let s = press(initState(loadData(new Project(dir))), ["6"]).state;
  const add: Effect = { kind: "mcp-add", spec: { id: "docs", command: "npx docs-mcp", env: { TOKEN: "${DOCS_TOKEN}" }, headers: {}, roles: ["worker"] } };
  s = await run(dir, s, [add]);
  assert.match(s.message!.text, /created mcps\/docs\.mcp\.yaml/);
  assert.equal(Project.load(dir).mcps().get("docs")!.command, "npx");
  s = await run(dir, s, [{ kind: "mcp-roles", id: "docs", roles: ["nobody"] }]);
  assert.match(s.message!.text, /there is no role 'nobody'/);
  s = await run(dir, s, [{ kind: "mcp-roles", id: "docs", roles: ["all"] }]);
  assert.equal(Project.load(dir).mcps().get("docs")!.roles, "all");
  const bad = await execute(dir, { kind: "mcp-add", spec: { id: "leak", url: "https://x.test", env: {}, headers: { Authorization: "Bearer abc123" }, roles: [] } });
  assert.equal(bad.ok, false);
  assert.ok(!fs.existsSync(path.join(dir, "mcps", "leak.mcp.yaml")));
  s = await run(dir, s, [{ kind: "mcp-remove", id: "docs" }]);
  assert.ok(!fs.existsSync(path.join(dir, "mcps", "docs.mcp.yaml")));
  s = await run(dir, s, [{ kind: "eject", what: "role", id: "reviewer" }]);
  assert.match(s.message!.text, /copied to roles\/reviewer\.role\.md/);
  assert.equal(s.data.roles.find((r) => r.id === "reviewer")!.origin, "project");
});

test("tui: no secret value is ever rendered for an MCP with env TOKEN=${X}", () => {
  const dir = newProject();
  fs.appendFileSync(path.join(dir, "mergewright.yaml"), "local_models:\n  endpoint: https://user:pw@llm.test/v1?key=q1\n");
  write(dir, "mcps/svc.mcp.yaml", "id: svc\ntransport: http\nurl: https://user:pw@svc.test/mcp?key=q1\nenv: {TOKEN: \"${X}\"}\nheaders: {Authorization: \"Bearer ${X}\"}\nroles: all\n");
  process.env.X = "sekrit-value-123";
  try {
    let s = initState(loadData(new Project(dir)));
    const texts: string[] = [];
    for (let i = 0; i < 8; i++) { texts.push(screen(s), screen({ ...s, focus: "detail" })); s = reduce(s, "tab").state; }
    s = press(s, ["6", "a", "down", "down", ...type("TOKEN=sekrit-value-123")]).state;
    texts.push(screen(s));
    const all = texts.join("\n");
    assert.match(all, /env +TOKEN/);
    assert.match(all, /headers +Authorization/);
    s = press(s, ["esc", "4", ...Array(40).fill("down")]).state; // the Config screen's local_models keys come last
    texts.push(...Array.from({ length: 12 }, (_, i) => screen(press(s, Array(i).fill("up")).state)), screen(press(s, ["up", "up", "up", "enter"]).state));
    assert.match(texts.join("\n"), /local_models\.endpoint/);
    for (const leak of ["sekrit", "${X}", "Bearer", "pw@", "key=q1"]) assert.ok(!all.includes(leak), `rendered output contains ${leak}`);
  } finally {
    delete process.env.X;
  }
});

test("tui: 'mw tui' without a terminal exits 2 and names the mw config command", () => {
  const dir = newProject();
  const devnull = fs.openSync("/dev/null", "r");
  try {
    const r = spawnSync(process.execPath, [MW, "tui"], { cwd: dir, stdio: [devnull, "pipe", "pipe"], encoding: "utf8", env: { ...process.env, MW_ENV_FILE: "/dev/null" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /needs an interactive terminal/);
    assert.match(r.stderr, /mw config set/);
  } finally {
    fs.closeSync(devnull);
  }
});
