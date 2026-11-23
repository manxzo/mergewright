// Refusing to run on an invalid configuration (specs/config.spec.md): a mergewright.yaml that fails
// its schema is loaded with every setting at its default, so runs, writing MCP tools and committing
// commands refuse with config/invalid before writing anything; read-only commands still answer.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCard } from "../../src/engine/run.ts";
import { callTool, TOOLS } from "../../src/mcpserver/server.ts";
import { schema, type ToolDef } from "../../src/mcpserver/tool.ts";
import { Project } from "../../src/project.ts";
import { MwError } from "../../src/util.ts";
import { work } from "../../src/work.ts";
import { hostName } from "../../src/hub.ts";
import { fakeHub, fakeIntegrations } from "../engine-helpers.ts";
import { addPackage, git, mw, newProject, read, tmpDir, write } from "../helpers.ts";

/**
 * Four schema errors next to a hub and a sandbox setting: limits.turns and limits.minutes of the wrong
 * type, an unknown key nested in limits and an unknown top-level key.
 */
const BAD_LIMITS = "limits:\n  rounds: 2\n  turns: lots\n  minutes: soon\n  typo: 1\ncolour: red\n";
/** The refusal's line for each error: "<key path>: <message>". */
const LINES = ["limits.turns: must be integer", "limits.minutes: must be integer", "limits.typo: unknown field", "colour: unknown field"];

const READY_CARD = "---\nid: DEMO-1\ntitle: Greet\nstatus: ready\nkind: chore\nscope: [\"src/**\"]\n---\n\n## Why\n\nThe demo needs it.\n\n## Out of scope\n\nNone\n\n## Acceptance\n\n- `src/app.txt` greets the user.\n";

/** A committed project with a ready card whose config sets git.hub and agents.sandbox and has typos in `limits`. */
function badProject(): string {
  const dir = newProject();
  const text = read(dir, "mergewright.yaml")
    .replace(/^limits:\n(?: .*\n)+/m, BAD_LIMITS)
    .replace(/^ {2}hub: .*$/m, "  hub: hub")
    .concat("\nagents:\n  sandbox: required\n");
  write(dir, "mergewright.yaml", text);
  write(dir, "cards/DEMO-1.card.md", READY_CARD);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "bad config");
  return dir;
}

/** Every file outside .git (path and contents), HEAD, branches, worktrees and `git status`: what a refusal must leave as it was. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === ".git") continue;
      if (e.isDirectory()) walk(r);
      else files[r] = read(dir, r);
    }
  };
  walk("");
  return {
    files: JSON.stringify(files),
    head: git(dir, "rev-parse", "HEAD"),
    branches: git(dir, "branch", "--list"),
    worktrees: git(dir, "worktree", "list"),
    status: git(dir, "status", "--porcelain", "--ignored"),
  };
}

/** Run as the owner, never as an agent inside a card run. */
const OWNER = { MW_ROLE: "", MW_CARD: "", MW_MODE: "" };

/** Each schema error is on a line of its own that starts with its key path. */
function assertLines(text: string, what = ""): void {
  const lines = text.split("\n").map((l) => l.trim());
  for (const l of LINES) assert.ok(lines.includes(l), `${what} names '${l}':\n${text}`);
}

function assertRefused(r: { code: number; out: string; err: string }): void {
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.err, /config\/invalid/);
  assertLines(r.err);
}

async function tool(dir: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const t = TOOLS.find((x) => x.name === name)!;
  const cwd = process.cwd();
  const role = process.env.MW_ROLE;
  delete process.env.MW_ROLE;
  try {
    process.chdir(dir);
    const r = await callTool(t, args, { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined });
    return { text: r.content.map((x) => x.text).join("\n"), isError: r.isError === true };
  } finally {
    process.chdir(cwd);
    if (role !== undefined) process.env.MW_ROLE = role;
  }
}

// @req REQ-config-001
test("config/invalid: assertRunnable lists every schema error as '<key path>: <message>', in the order found", () => {
  const dir = badProject();
  const project = new Project(dir);
  const schemaDiags = project.diag.items.filter((d) => d.code === "config/schema");
  assert.equal(schemaDiags.length, LINES.length, schemaDiags.map((d) => d.message).join("\n"));
  // The diagnostics `mw check` prints keep their wording; the key path is carried beside it.
  assert.ok(schemaDiags.some((d) => d.message === "'limits' has unknown field 'typo'"), schemaDiags.map((d) => d.message).join("\n"));
  assert.deepEqual([...project.configErrors()].sort(), [...LINES].sort());
  assert.deepEqual(project.configErrors(), schemaDiags.map((d) => `${d.key}: ${d.detail}`), "in diag order");
  assert.throws(() => project.assertRunnable(), (e: unknown) => {
    assert.ok(e instanceof MwError);
    assert.equal(e.code, "config/invalid");
    // Every schema error, each on its own line led by its key path, in diag order; nothing else is listed.
    assert.deepEqual(e.message.split("\n").filter((l) => l.startsWith("  ")).map((l) => l.trim()), project.configErrors());
    assert.match(e.message, /mw check/);
    return true;
  });
});

// @req REQ-config-001
test("config/invalid: a YAML syntax error is listed with the file name as its key path", () => {
  const dir = newProject();
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").concat("\nlimits: [unclosed\n"));
  const project = new Project(dir);
  const errors = project.configErrors();
  assert.equal(errors.length >= 1, true);
  assert.match(errors[0]!, /^mergewright\.yaml: not valid YAML: /);
  assert.throws(() => project.assertRunnable(), (e: unknown) => e instanceof MwError && e.code === "config/invalid" && e.message.includes(`  ${errors[0]}`));
});

// @req REQ-config-001
test("config/invalid: 'mw run' and 'mw work' refuse, start no phase and write nothing", () => {
  const dir = badProject();
  const before = snapshot(dir);
  assertRefused(mw(dir, ["run", "DEMO-1"], OWNER));
  assert.deepEqual(snapshot(dir), before);
  assertRefused(mw(dir, ["work"], OWNER));
  assert.deepEqual(snapshot(dir), before);
  assertRefused(mw(dir, ["work", "--dry-run"], OWNER));
  assert.deepEqual(snapshot(dir), before);
  assert.equal(fs.existsSync(path.join(dir, ".mergewright", "runs", "DEMO-1")), false);
});

// @req REQ-config-001
test("config/invalid: start() refuses a fresh run and a resumed one before the lock, the lease or a phase", async () => {
  const dir = badProject();
  const before = snapshot(dir);
  await assert.rejects(runCard(new Project(dir), "DEMO-1"), (e: unknown) => e instanceof MwError && e.code === "config/invalid" && LINES.every((l) => e.message.includes(`  ${l}\n`)));
  await assert.rejects(runCard(new Project(dir), "DEMO-1", { dryRun: true }), (e: unknown) => e instanceof MwError && e.code === "config/invalid");
  // A run in progress (its state on disk) is refused the same way when it would resume.
  write(dir, ".mergewright/runs/DEMO-1/state.json", JSON.stringify({ card: "DEMO-1", flow: "standard", phase: 1, round: 0, status: "running" }));
  const resumed = snapshot(dir);
  await assert.rejects(runCard(new Project(dir), "DEMO-1"), (e: unknown) => e instanceof MwError && e.code === "config/invalid");
  assert.deepEqual(snapshot(dir), resumed);
  fs.rmSync(path.join(dir, ".mergewright"), { recursive: true, force: true });
  await assert.rejects(work(dir, { out: () => undefined }), (e: unknown) => e instanceof MwError && e.code === "config/invalid");
  assert.deepEqual(snapshot(dir), before);
});

// @req REQ-config-001
test("config/invalid: mw_card_new and the other writing MCP tools refuse and commit nothing", async () => {
  const dir = badProject();
  const before = snapshot(dir);
  const calls: [string, Record<string, unknown>][] = [
    ["mw_card_new", { title: "Another", kind: "chore", scope: ["src/**"] }],
    ["mw_card_set_status", { id: "DEMO-1", status: "todo" }],
    ["mw_memory_add", { kind: "decision", title: "A decision", body: "Because." }],
    ["mw_run_start", { id: "DEMO-1" }],
  ];
  for (const [name, args] of calls) {
    const t = TOOLS.find((x) => x.name === name);
    assert.ok(t?.write, `${name} is a writing tool`);
    const r = await tool(dir, name, args);
    assert.equal(r.isError, true, `${name}: ${r.text}`);
    // A tool whose arguments this test got wrong would fail on them instead; the refusal must come first.
    assert.match(r.text, /config\/invalid/, `${name}: ${r.text}`);
    assertLines(r.text, name);
    assert.deepEqual(snapshot(dir), before, name);
  }
  // The check sits in callTool for every tool marked as writing, before its precheck and handler;
  // a read-only tool still answers.
  const reached: string[] = [];
  const fake = (write: boolean): ToolDef => ({
    name: write ? "fake_write" : "fake_read", description: "", inputSchema: schema({}), write,
    precheck: () => { reached.push(`precheck ${write}`); },
    handler: () => { reached.push(`handler ${write}`); return "done"; },
  });
  const ctx = { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined };
  const written = await callTool(fake(true), {}, ctx);
  assert.equal(written.isError, true);
  assert.match(written.content[0]!.text, /config\/invalid/);
  const readOnly = await callTool(fake(false), {}, ctx);
  assert.equal(readOnly.isError, undefined);
  assert.deepEqual(reached, ["precheck false", "handler false"]);
  assert.deepEqual(snapshot(dir), before);
});

// @req REQ-config-001
test("config/invalid: committing and writing commands refuse before they write", () => {
  const dir = badProject();
  const before = snapshot(dir);
  const commands = [
    ["card", "new", "--title", "Another", "--kind", "chore", "--scope", "src/**"],
    ["card", "status", "DEMO-1", "todo"],
    ["card", "ack", "DEMO-1"],
    ["memory", "add", "decision", "--title", "A decision", "--body", "Because."],
    ["memory", "add", "lesson", "--topic", "t", "--title", "A lesson", "--body", "Learned."],
    ["memory", "index"],
    ["spec", "propose", "auth", "--summary", "Change it"],
    ["eject", "role", "worker"],
    ["mcp", "add", "x", "--command", "true"],
    ["approve", "DEMO-1", "go"],
    ["retry", "DEMO-1"],
    ["abort", "DEMO-1"],
    ["sync"],
    ["lease", "take"],
  ];
  for (const argv of commands) {
    assertRefused(mw(dir, argv, OWNER));
    assert.deepEqual(snapshot(dir), before, argv.join(" "));
  }
});

// @req REQ-config-002
test("config/invalid: 'mw check', 'mw doctor' and 'mw status' answer from the tolerant load and report the errors", () => {
  const dir = badProject();
  const before = snapshot(dir);
  const checked = mw(dir, ["check"], OWNER);
  assert.equal(checked.code, 1);
  // `mw check` prints the schema diagnostics as they are, one per error.
  for (const d of new Project(dir).diag.items.filter((x) => x.code === "config/schema")) assert.ok(checked.out.includes(d.message), checked.out);
  assert.match(checked.out, /\[config\/schema\]/);

  const doctor = mw(dir, ["doctor"], OWNER);
  assert.doesNotMatch(doctor.err, /config\/invalid/);
  assert.match(doctor.out, /^config +PROBLEM/m);
  for (const l of LINES) assert.ok(doctor.out.includes(l), doctor.out);
  assert.match(doctor.out, /^git /m, "the rest of the report is still given");

  const status = mw(dir, ["status"], OWNER);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /DEMO-1/);
  assert.match(status.out, /config\/invalid/);
  assertLines(status.out, "mw status");

  const json = mw(dir, ["status", "--json"], OWNER);
  assert.equal(json.code, 0, json.err);
  assert.equal((JSON.parse(json.out) as { id: string }[])[0]!.id, "DEMO-1");
  assertLines(json.err, "mw status --json");

  for (const argv of [["card", "lint", "DEMO-1"], ["memory", "show"], ["spec", "list"], ["lease", "show"]]) {
    const r = mw(dir, argv, OWNER);
    assert.doesNotMatch(r.err, /config\/invalid/, argv.join(" "));
  }
  assert.deepEqual(snapshot(dir), before);
});

// @req REQ-config-003
test("config/invalid: a typo in limits never lets a run use git.hub none and agents.sandbox auto", () => {
  const dir = badProject();
  const project = new Project(dir);
  // The tolerant load falls back to the defaults for everything, the safety settings included ...
  assert.equal(project.config.git.hub, "none");
  assert.equal(project.config.agents.sandbox, "auto");
  // ... so nothing may act on it: the run is refused.
  assert.throws(() => project.assertRunnable(), (e: unknown) => e instanceof MwError && e.code === "config/invalid");
  assertRefused(mw(dir, ["run", "DEMO-1"], OWNER));
});

// @req REQ-config-003
test("config/invalid: assertRunnable returns on a valid config, whatever other diagnostics the project has", () => {
  const dir = newProject();
  const project = new Project(dir);
  assert.doesNotThrow(() => project.assertRunnable());
  assert.deepEqual(project.configErrors(), []);
  // Diagnostics unrelated to the config file's schema (a broken card here) do not refuse a run.
  write(dir, "cards/DEMO-9.card.md", "---\nid: DEMO-9\n---\n");
  const other = new Project(dir);
  other.cards();
  assert.ok(other.diag.errors.length > 0);
  assert.doesNotThrow(() => other.assertRunnable());
  assert.doesNotThrow(() => Project.loadRunnable(dir));
});

/** Make a valid project's config invalid as `badProject` does (the same four errors). */
function breakConfig(dir: string): void {
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace(/^limits:\n(?: .*\n)+/m, BAD_LIMITS));
}

/** A committed project with a valid config and the ready card. */
function goodProject(): string {
  const dir = newProject();
  write(dir, "cards/DEMO-1.card.md", READY_CARD);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "card");
  return dir;
}

/** MCP tools that neither write nor run an agent: the only ones that answer on an invalid config. */
const READ_ONLY_TOOLS = [
  "mw_cards_list", "mw_card_get", "mw_card_lint", "mw_status", "mw_run_status", "mw_docs_search",
  "mw_memory_search",
  "mw_check", "mw_trace", "mw_doctor", "mw_spec_list", "mw_spec_get", "mw_req_get", "mw_roles",
  "mw_run_file", "mw_packages", "mw_settings",
];

// @req REQ-config-001
test("config/invalid: mw_delegate and mw_review refuse before they write their run folder or run an agent", async () => {
  const dir = badProject();
  const before = snapshot(dir);
  const allow = process.env.MW_DELEGATE_ALLOW_MOCK;
  process.env.MW_DELEGATE_ALLOW_MOCK = "1";
  try {
    for (const [name, args] of [["mw_delegate", { task: "Say hello.", runs: "mock" }], ["mw_review", { diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", runs: "mock" }]] as const) {
      const r = await tool(dir, name, args);
      assert.equal(r.isError, true, `${name}: ${r.text}`);
      assert.match(r.text, /config\/invalid/, `${name}: ${r.text}`);
      assertLines(r.text, name);
      assert.deepEqual(snapshot(dir), before, name);
    }
  } finally {
    if (allow === undefined) delete process.env.MW_DELEGATE_ALLOW_MOCK;
    else process.env.MW_DELEGATE_ALLOW_MOCK = allow;
  }
  assert.equal(fs.existsSync(path.join(dir, ".mergewright", "local", "delegate")), false);
  // Every tool is either checked (writes, or writes files or runs an agent) or known to be read-only:
  // a new tool must be put on one side or the other.
  const unchecked = TOOLS.filter((t) => !t.write && !t.needsConfig).map((t) => t.name).sort();
  assert.deepEqual(unchecked, [...READ_ONLY_TOOLS].sort());
});

// @req REQ-config-002
test("config/invalid: the mw_status tool answers with the cards and the config errors", async () => {
  const dir = badProject();
  const bad = JSON.parse((await tool(dir, "mw_status", {})).text) as { config_errors: string[]; cards: { id: string }[] };
  assert.deepEqual([...bad.config_errors].sort(), [...LINES].sort());
  assert.equal(bad.cards[0]!.id, "DEMO-1");
  // On a valid config the answer is the card list, as 'mw status --json' gives it.
  const good = JSON.parse((await tool(goodProject(), "mw_status", {})).text) as { id: string }[];
  assert.ok(Array.isArray(good));
  assert.equal(good[0]!.id, "DEMO-1");
});

// @req REQ-config-001
test("config/invalid: start() checks the config again after the hub sync, fresh and resumed, and starts no phase", async () => {
  for (const resumed of [false, true]) {
    const dir = goodProject();
    if (resumed) write(dir, ".mergewright/runs/DEMO-1/state.json", JSON.stringify({ card: "DEMO-1", flow: "standard", phase: 1, round: 0, status: "running", history: [], approvals: [], warnings: [] }));
    const head = git(dir, "rev-parse", "HEAD");
    const worktrees = git(dir, "worktree", "list");
    const stateBefore = resumed ? read(dir, ".mergewright/runs/DEMO-1/state.json") : undefined;
    // The hub sync adopts an invalid mergewright.yaml (simulated: prepare() writes it).
    const hub = fakeHub({ holder: hostName() });
    const prepare = hub.prepare.bind(hub);
    hub.prepare = async (o) => { breakConfig(dir); return prepare(o); };
    const integrations = fakeIntegrations();
    await assert.rejects(runCard(new Project(dir), "DEMO-1", {}, { hub, integrations }), (e: unknown) => {
      assert.ok(e instanceof MwError, String(e));
      assert.equal(e.code, "config/invalid");
      assertLines(e.message);
      return true;
    });
    assert.ok(hub.names().includes("prepare"));
    assert.ok(hub.names().includes("release"), `the lease prepare() took is handed back: ${hub.names().join(",")}`);
    assert.deepEqual(integrations.calls, [], "no integration was called");
    assert.equal(git(dir, "rev-parse", "HEAD"), head);
    assert.equal(git(dir, "worktree", "list"), worktrees);
    if (resumed) assert.equal(read(dir, ".mergewright/runs/DEMO-1/state.json"), stateBefore, "the run state is not touched");
    else assert.equal(fs.existsSync(path.join(dir, ".mergewright", "runs", "DEMO-1")), false, "nothing of the run is written");
  }
});

// @req REQ-config-001
test("config/invalid: a writing MCP tool checks the config again once it holds the repository lock", async () => {
  const dir = goodProject();
  const before = snapshot(dir);
  const reached: string[] = [];
  // The config is valid when callTool first checks it, and is made invalid before the lock is taken
  // (the precheck runs there): the check inside the transaction must refuse before the handler runs.
  const locked: ToolDef = {
    name: "fake_locked", description: "", inputSchema: schema({}), write: true, locked: true,
    precheck: () => { reached.push("precheck"); breakConfig(dir); },
    handler: () => { reached.push("handler"); write(dir, "x.txt", "x"); return "done"; },
  };
  const r = await callTool(locked, {}, { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined });
  assert.equal(r.isError, true, r.content[0]!.text);
  assert.match(r.content[0]!.text, /config\/invalid/);
  assertLines(r.content[0]!.text);
  assert.deepEqual(reached, ["precheck"]);
  assert.equal(fs.existsSync(path.join(dir, "x.txt")), false);
  assert.equal(git(dir, "rev-parse", "HEAD"), before.head);
});

// @req REQ-config-001
test("config/invalid: 'mw work --watch' checks the config at every pass and does nothing on a pass where it is invalid", async () => {
  const dir = newProject();
  const lines: string[] = [];
  const integrations = fakeIntegrations();
  const hub = fakeHub();
  const stop = new AbortController();
  let sleeps = 0;
  let callsAtBreak = 0;
  let hubCallsAtBreak = 0;
  const result = await work(dir, {
    watch: true, interval: 1, out: (l) => lines.push(l), signal: stop.signal,
    hub: () => hub, integrations: () => integrations,
    sleep: async () => {
      sleeps++;
      if (sleeps === 1) {
        // After a valid pass (nothing to do), the config turns invalid while the worker sleeps.
        breakConfig(dir);
        callsAtBreak = integrations.calls.length;
        hubCallsAtBreak = hub.calls.length;
      } else stop.abort();
    },
  });
  assert.ok(callsAtBreak > 0 && hubCallsAtBreak > 0, "the first pass checked usage and the hub");
  assert.equal(sleeps, 2);
  assert.equal(integrations.calls.length, callsAtBreak, "the invalid pass calls no integration");
  assert.equal(hub.calls.length, hubCallsAtBreak, "the invalid pass touches neither the lease nor the hub");
  const text = lines.join("\n");
  assert.match(text, /config\/invalid/);
  assertLines(text, "mw work --watch");
  assert.deepEqual(result.runs, []);

  // Without --watch a pass that finds it invalid ends the command, with a failing exit code.
  const once = goodProject();
  const out: string[] = [];
  const hub2 = fakeHub();
  const prepare = hub2.sync.bind(hub2);
  hub2.sync = async (o) => { breakConfig(once); return prepare(o); }; // the pass's hub sync adopts an invalid config
  const r = await work(once, { out: (l) => out.push(l), hub: () => hub2, integrations: () => fakeIntegrations() });
  assert.equal(r.code, 1);
  assert.deepEqual(r.runs, [], "no card was taken");
  assert.match(out.join("\n"), /config\/invalid/);
  assert.equal(fs.existsSync(path.join(once, ".mergewright", "runs", "DEMO-1")), false);
});

/** Every file under a directory, path and contents: the Hermes home a refused command must leave as it was. */
function tree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else files[r] = fs.readFileSync(path.join(root, r), "utf8");
    }
  };
  walk("");
  return files;
}

// @req REQ-config-001
test("config/invalid: 'mw hermes init', 'remove' and 'status' (the hermes package) refuse with config/invalid and leave the Hermes config and skill alone", () => {
  const dir = badProject();
  const bad = read(dir, "mergewright.yaml");
  const home = tmpDir("mw-home-");
  const hermesHome = path.join(home, ".hermes");
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), "mcp_servers: {}\n");
  // A PATH with git and a shell but no hermes CLI, so nothing outside the scratch HOME is asked to change.
  const bin = tmpDir("mw-path-");
  for (const t of ["git", "sh", "bash", "env"]) {
    for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
      if (fs.existsSync(path.join(d, t))) { fs.symlinkSync(path.join(d, t), path.join(bin, t)); break; }
    }
  }
  const env = { ...OWNER, HOME: home, HERMES_HOME: hermesHome, PATH: bin, SSH_AUTH_SOCK: "", XDG_RUNTIME_DIR: tmpDir("mw-run-") };

  // With a valid config the project is registered, so 'remove' would have something to take away.
  write(dir, "mergewright.yaml", git(dir, "show", "HEAD~1:mergewright.yaml") + "\n");
  addPackage(dir, "hermes");
  const seeded = mw(dir, ["hermes", "init"], env);
  assert.equal(seeded.code, 0, seeded.err);
  write(dir, "mergewright.yaml", bad);
  const registered = tree(home);
  assert.ok(Object.keys(registered).some((f) => f.endsWith("SKILL.md")), JSON.stringify(Object.keys(registered)));
  const before = snapshot(dir);

  for (const argv of [["hermes", "init"], ["hermes", "remove"], ["hermes", "init", "--name", "mw-other"]]) {
    assertRefused(mw(dir, argv, env));
    assert.deepEqual(tree(home), registered, argv.join(" "));
    assert.deepEqual(snapshot(dir), before, argv.join(" "));
  }

  // An invalid config enables no package, so the package's read-only 'status' is not there either: it
  // refuses the same way (before the port it answered).
  assertRefused(mw(dir, ["hermes", "status"], env));
  assert.deepEqual(tree(home), registered);
});
