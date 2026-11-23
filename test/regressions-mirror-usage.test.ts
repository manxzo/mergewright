// Regression tests for the Kanban mirror on a machine without the board, the docs.sync message
// without a documentation service, Codex's per-run home, and usage totals per harness.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { docsSync, type Engine } from "../src/engine/actions.ts";
import codex, { codexHomeFor } from "../src/engine/harness/codex.ts";
import { usageTotals } from "../src/engine/run.ts";
import type { HarnessRequest, RunState } from "../src/engine/types.ts";
import { integrationsFor, queueFor } from "../src/integrations.ts";
import type { Role } from "../src/model/role.ts";
import { Project } from "../src/project.ts";
import { fakeIntegrations, project as engineProject, run, script, state, useScript } from "./engine-helpers.ts";
import { card, git, kanbanConfig, mw, tmpDir, write } from "./helpers.ts";
import { installFake, projectWith, queueItems } from "./fixtures/integrations/support.ts";

const BOARD_PATH = "/home/alice/workspace/greeter"; // the board machine's checkout; absent here

function kanbanEnv(knownPaths: string): { state: string; read: () => { tasks: { id: string; prompt: string; column: string }[]; calls: string[][] } } {
  const state = path.join(tmpDir(), "kanban.json");
  process.env.FAKE_KANBAN_STATE = state;
  process.env.FAKE_KANBAN_DOWN = "0";
  process.env.FAKE_KANBAN_PATHS = knownPaths;
  return { state, read: () => JSON.parse(fs.readFileSync(state, "utf8")) };
}

after(() => {
  delete process.env.FAKE_KANBAN_PATHS;
});

test("kanban: a board that does not know this machine's path queues nothing; the run records the note once", async () => {
  const fake = installFake("kanban", "fake-kanban.mjs");
  after(fake.restore);
  const k = kanbanEnv(BOARD_PATH);
  // Laptop: the board knows the project only by the board machine's path, and kanban_path is not set.
  const { dir, project } = projectWith(kanbanConfig());
  const note = await integrationsFor(project).mirrorCard("DEMO-1", "Sign in", "in_progress");
  assert.match(String(note), /^kanban: mirror skipped on \S+ \(board not reachable here\); the board machine reconciles$/);
  assert.deepEqual(queueItems(dir), [], "nothing queued: it would wait forever");
  assert.ok(k.read().calls.every((c) => c[1] === "list"), "only the reachability check ran");

  // With packages.cline-kanban.path, the CLI is asked about the board's path while running in this checkout.
  const other = projectWith(kanbanConfig({ path: BOARD_PATH }));
  assert.equal(await integrationsFor(other.project).mirrorCard("DEMO-1", "Sign in", "todo"), undefined);
  assert.deepEqual(k.read().tasks.map((t) => [t.prompt.split("\n")[0], t.column]), [["[DEMO-1] Sign in", "backlog"]]);
  assert.deepEqual(queueItems(other.dir), []);

  // In a run, the note lands in the run's warnings once, however often the status changes.
  const dir2 = engineProject();
  useScript(script());
  const integ = fakeIntegrations();
  integ.mirrorCard = async () => "kanban: mirror skipped on laptop (board not reachable here); the board machine reconciles";
  await run(dir2, { until: "review" }, { integrations: integ });
  assert.deepEqual(state(dir2).warnings.filter((w) => w.startsWith("kanban:")), ["kanban: mirror skipped on laptop (board not reachable here); the board machine reconciles"]);
});

test("mw cards mirror on the board machine moves a done card to trash, idempotently; unreachable board exits 1", async () => {
  const fake = installFake("kanban", "fake-kanban.mjs");
  after(fake.restore);
  const { dir } = projectWith(kanbanConfig());
  const k = kanbanEnv(dir);
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1").replace("status: todo", "status: done"));
  write(dir, "cards/DEMO-2.card.md", card("DEMO-2"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "cards");
  // The board still shows DEMO-1 in backlog: the laptop finished it and could not mirror that.
  fs.writeFileSync(k.state, JSON.stringify({ tasks: [{ id: "t1", title: "[DEMO-1] Card DEMO-1", prompt: "[DEMO-1] Card DEMO-1", column: "backlog" }], calls: [], next: 2 }));
  // A pending move the board machine queued earlier for DEMO-1 is settled by the reconcile.
  queueFor(new Project(dir)).add("cline-kanban", "kanban: DEMO-1 -> review (pending)", { cardId: "DEMO-1", title: "Card DEMO-1", status: "review" });
  const env = { PATH: process.env.PATH!, FAKE_KANBAN_STATE: k.state, FAKE_KANBAN_PATHS: dir, FAKE_KANBAN_DOWN: "0" };

  let r = mw(dir, ["cline-kanban", "mirror"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ok\s+DEMO-1\s+done\s+DEMO-1 moved to done/);
  assert.match(r.out, /ok\s+DEMO-2\s+todo\s+DEMO-2 is in backlog/);
  assert.match(r.out, /2 of 2 card\(s\) shown right on the board/);
  assert.deepEqual(k.read().tasks.map((t) => [t.prompt.split("\n")[0], t.column]), [["[DEMO-1] Card DEMO-1", "trash"], ["[DEMO-2] Card DEMO-2", "backlog"]]);
  assert.deepEqual(queueItems(dir), []);

  r = mw(dir, ["cline-kanban", "mirror"], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(k.read().calls.filter((c) => c[1] === "trash").length, 1, "idempotent: nothing trashed twice");
  assert.equal(k.read().calls.filter((c) => c[1] === "create").length, 1, "idempotent: nothing created twice");

  r = mw(dir, ["cline-kanban", "mirror"], { ...env, FAKE_KANBAN_PATHS: BOARD_PATH });
  assert.equal(r.code, 1);
  assert.match(r.out, /the board does not answer on this machine for .*is not added to Kanban yet.*Run 'mw cline-kanban mirror' on the machine where the board runs/);
});

test("mw queue flush drops a kanban item whose card status has since changed", async () => {
  const fake = installFake("kanban", "fake-kanban.mjs");
  after(fake.restore);
  const { dir } = projectWith(kanbanConfig());
  const k = kanbanEnv(dir);
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1").replace("status: todo", "status: done"));
  write(dir, "cards/DEMO-2.card.md", card("DEMO-2"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "cards");
  const q = queueFor(new Project(dir));
  q.add("cline-kanban", "kanban: DEMO-1 -> in_progress", { cardId: "DEMO-1", title: "Card DEMO-1", status: "in_progress" }, "Project /mnt/x is not added to Kanban yet.");
  q.add("cline-kanban", "kanban: DEMO-2 -> todo", { cardId: "DEMO-2", title: "Card DEMO-2", status: "todo" });
  const env = { PATH: process.env.PATH!, FAKE_KANBAN_STATE: k.state, FAKE_KANBAN_PATHS: dir, FAKE_KANBAN_DOWN: "0" };
  const r = mw(dir, ["queue", "flush"], env);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /dropped\s+cline-kanban\s+kanban: DEMO-1 -> in_progress: stale: DEMO-1 is now done, not in_progress; dropped/);
  assert.match(r.out, /delivered\s+cline-kanban\s+kanban: DEMO-2 -> todo/);
  assert.match(r.out, /1 delivered, 1 dropped, 0 still queued/);
  assert.deepEqual(queueItems(dir), []);
  assert.ok(!k.read().calls.some((c) => c[1] === "create" && c.join(" ").includes("[DEMO-1]")), "the stale status never reached the board");
});

test("docs.sync without a documentation service says so instead of 'sent'", async () => {
  const { dir, project } = projectWith();
  write(dir, "docs/guide.md", "# Guide\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "docs");
  const merged = git(dir, "rev-parse", "HEAD");
  const e = { project, state: { merged, warnings: [] }, integrations: integrationsFor(project) } as unknown as Engine;
  assert.deepEqual(await docsSync(e), { outcome: "ok", detail: "no documentation service configured; nothing synced" });
  const sent = { ...e, integrations: { ...fakeIntegrations(), docsSync: async () => "sent" as const } } as Engine;
  assert.equal((await docsSync(sent)).detail, "1 changed and 0 deleted documentation file(s) sent");
  const queued = { ...e, integrations: { ...fakeIntegrations(), docsSync: async () => "queued" as const } } as Engine;
  assert.match((await docsSync(queued)).detail, /^1 changed and 0 deleted documentation file\(s\) queued/);
});

test("codex runs with a per-run CODEX_HOME holding only auth.json (mode 600), removed after the run", async () => {
  const owner = tmpDir("mw-codex-owner-");
  fs.writeFileSync(path.join(owner, "auth.json"), '{"fake":"login"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(owner, "AGENTS.md"), "Global instruction that must not reach the agent.\n");
  fs.writeFileSync(path.join(owner, "config.toml"), 'model = "owner-default"\n');
  const bin = tmpDir("mw-codex-bin-");
  const record = path.join(tmpDir(), "record.json");
  // Records CODEX_HOME, its listing and auth.json's mode during the run; writes the -o reply.
  write(bin, "codex", `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const files = fs.readdirSync(home).sort();
const mode = fs.statSync(home + "/auth.json").mode & 0o777;
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ home, files, mode }));
fs.writeFileSync(home + "/auth.json", '{"fake":"refreshed"}\\n');
fs.writeFileSync(argv[argv.indexOf("-o") + 1], "PONG");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }) + "\\n");
`);
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  const root = tmpDir("mw-codex-project-");
  const runDir = path.join(root, ".mergewright", "runs", "DEMO-1");
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd, { recursive: true });
  const role: Role = { id: "reviewer", description: "", runs: "codex", mode: "advise", output: "text", limits: {}, mcps: [], args: [], prompt: "", file: "roles/reviewer.role.md", origin: "project" };
  const req: HarnessRequest = { role, prompt: "ping", cwd, mode: "advise", outputKind: "text", limits: { minutes: 1 }, env: { PATH: `${bin}:${process.env.PATH}` }, runDir, label: "3-review-reviewer" };
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = owner;
  try {
    const r = await codex.run(req);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.text, "PONG");
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
  const seen = JSON.parse(fs.readFileSync(record, "utf8")) as { home: string; files: string[]; mode: number };
  // The machine-local part of the run's folders (.mergewright/local/), never file-synced like runs/.
  assert.equal(seen.home, codexHomeFor(req));
  assert.equal(seen.home, path.join(root, ".mergewright", "local", "codex-home", "DEMO-1", "3-review-reviewer"));
  assert.deepEqual(seen.files, ["auth.json"], "no AGENTS.md, no config.toml");
  assert.equal(seen.mode, 0o600);
  assert.equal(fs.existsSync(seen.home), false, "removed after the run");
  assert.equal(fs.readFileSync(path.join(owner, "auth.json"), "utf8"), '{"fake":"refreshed"}\n', "a login refreshed during the run is carried back");
  assert.equal(fs.statSync(path.join(owner, "auth.json")).mode & 0o777, 0o600);
});

test("usage totals: Claude by price, Codex by tokens only", () => {
  const h = (usageBy: RunState["history"][number]["usageBy"]) => ({ phase: "p", roles: [], outcome: "ok" as const, detail: "", round: 0, started: "", seconds: 0, usageBy });
  const s = { history: [h({ claude: { inputTokens: 100, outputTokens: 10, costUsd: 0.25 }, codex: { inputTokens: 1000, outputTokens: 50 } }), h({ codex: { inputTokens: 500, outputTokens: 25 } }), h({ claude: { costUsd: 0.17 } })] } as unknown as RunState;
  const t = usageTotals(s)!;
  assert.equal(t.summary, "Claude $0.42; Codex 1,500 in / 75 out tokens");
  assert.deepEqual(t.byHarness.codex, { inputTokens: 1500, outputTokens: 75 });
  assert.ok(Math.abs(t.byHarness.claude!.costUsd! - 0.42) < 1e-9);
  assert.equal(usageTotals({ history: [] } as unknown as RunState), undefined);
});
