// Card lint and readiness admission (specs/cards.spec.md): lintCard() finds an unready card before
// the planner sees it; `mw card lint` and the MCP tool `mw_card_lint` give the same report; every
// route to `ready`, and a fresh start(), refuses a card with lint errors and writes nothing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { lintCard, OUT_OF_SCOPE_SCAFFOLD, WHY_SCAFFOLD, type LintFinding } from "../../src/cards.ts";
import { runCard } from "../../src/engine/run.ts";
import { hubTestHooks, openHub } from "../../src/hub.ts";
import { repoLockTiming, withRepoLock } from "../../src/mcpserver/repo.ts";
import { callTool, TOOLS } from "../../src/mcpserver/server.ts";
import { Project } from "../../src/project.ts";
import { git, mw, newProject, read, sh, SPEC, write } from "../helpers.ts";
import { as, brief, project as engineProject, hubPair, run, runPath, script, useScript } from "../engine-helpers.ts";

/** A card that passes lint; `over` replaces front matter lines, `body` the whole body. */
function cardText(id: string, opts: { fm?: string; body?: string } = {}): string {
  const fm = opts.fm ?? "kind: chore\nscope: [\"src/**\", \"docs/**\"]\n";
  const body = opts.body ?? "## Why\n\nThe demo needs it.\n\n## Out of scope\n\nNone\n\n## Acceptance\n\n- `src/app.txt` greets the user.\n";
  return `---\nid: ${id}\ntitle: Card ${id}\nstatus: todo\n${fm}---\n\n${body}`;
}

function lint(dir: string, id = "DEMO-1"): LintFinding[] {
  return lintCard(new Project(dir), id);
}

const codesOf = (fs_: LintFinding[]) => fs_.map((f) => f.code).sort();

/** A committed project holding the given cards (id -> file text). */
function projectWith(cards: Record<string, string>): string {
  const dir = newProject();
  write(dir, "specs/auth.spec.md", SPEC);
  for (const [id, text] of Object.entries(cards)) write(dir, `cards/${id}.card.md`, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "cards");
  return dir;
}

/** HEAD, `git status` and every file under cards/: what a refused command must leave as it was. */
function snapshot(dir: string): { head: string; status: string; cards: Record<string, string> } {
  const cards: Record<string, string> = {};
  for (const n of fs.readdirSync(path.join(dir, "cards")).sort()) cards[n] = read(dir, `cards/${n}`);
  return { head: git(dir, "rev-parse", "HEAD"), status: git(dir, "status", "--porcelain"), cards };
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

// @req REQ-cards-001
test("lint/placeholder: the Out of scope text 'mw card new' wrote is reported; None or real text passes", () => {
  const dir = projectWith({});
  const r = mw(dir, ["card", "new", "--title", "Greet", "--kind", "chore", "--scope", "src/**", "--why", "Users like it.", "--acceptance", "It greets."]);
  assert.equal(r.code, 0, r.err);
  assert.match(read(dir, "cards/DEMO-1.card.md"), new RegExp(`## Out of scope\\n\\n${OUT_OF_SCOPE_SCAFFOLD.replace(/[()]/g, "\\$&")}\\n`));
  const found = lint(dir).filter((f) => f.code === "lint/placeholder");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, "error");
  assert.match(found[0]!.message, /Out of scope/);

  for (const text of ["None", "The login page."]) {
    write(dir, "cards/DEMO-1.card.md", read(dir, "cards/DEMO-1.card.md").replace(/## Out of scope\n\n[^\n]*\n/, `## Out of scope\n\n${text}\n`));
    assert.deepEqual(lint(dir), [], `'${text}' under Out of scope passes`);
  }
});

// @req REQ-cards-001
test("lint/why-empty: an empty Why or the scaffold Why is reported; a real Why passes", () => {
  const body = (why: string) => `## Why\n\n${why}\n\n## Out of scope\n\nNone\n\n## Acceptance\n\n- It works.\n`;
  const dir = projectWith({ "DEMO-1": cardText("DEMO-1", { body: body("") }), "DEMO-2": cardText("DEMO-2", { body: body(WHY_SCAFFOLD) }), "DEMO-3": cardText("DEMO-3", { body: body("Users asked.") }) });
  assert.deepEqual(codesOf(lint(dir, "DEMO-1")), ["lint/why-empty"]);
  assert.deepEqual(codesOf(lint(dir, "DEMO-2")), ["lint/why-empty"]);
  assert.deepEqual(lint(dir, "DEMO-3"), []);
});

// @req REQ-cards-001
test("lint/no-acceptance: no criteria and no requirement is reported; either one passes", () => {
  const noAcc = "## Why\n\nThe demo needs it.\n\n## Out of scope\n\nNone\n";
  const dir = projectWith({
    "DEMO-1": cardText("DEMO-1", { body: noAcc }),
    "DEMO-2": cardText("DEMO-2", { body: `${noAcc}\n## Acceptance\n\n- It works.\n` }),
    "DEMO-3": cardText("DEMO-3", { fm: "implements: [REQ-auth-001]\nscope: [\"src/**\"]\n", body: noAcc }),
  });
  assert.deepEqual(codesOf(lint(dir, "DEMO-1")), ["lint/no-acceptance"]);
  assert.deepEqual(lint(dir, "DEMO-2"), []);
  assert.deepEqual(lint(dir, "DEMO-3"), []);
});

// @req REQ-cards-001
test("lint/scope-empty: a card without scope globs is reported; one with a scope passes", () => {
  const dir = projectWith({ "DEMO-1": cardText("DEMO-1", { fm: "kind: chore\n" }), "DEMO-2": cardText("DEMO-2") });
  assert.deepEqual(codesOf(lint(dir, "DEMO-1")), ["lint/scope-empty"]);
  assert.deepEqual(lint(dir, "DEMO-2"), []);
});

// @req REQ-cards-001
test("lint/scope-protected: a scope glob covering an ungranted protected path is reported; allow_protected passes", () => {
  const dir = projectWith({
    "DEMO-1": cardText("DEMO-1", { fm: "kind: chore\nscope: [\"src/**\", \"roles/**\"]\n" }),
    "DEMO-2": cardText("DEMO-2", { fm: "kind: chore\nscope: [\"src/**\", \"roles/**\"]\nallow_protected: [\"roles/**\"]\n" }),
  });
  const found = lint(dir, "DEMO-1");
  assert.deepEqual(codesOf(found), ["lint/scope-protected"]);
  assert.match(found[0]!.message, /'roles\/\*\*'/);
  assert.deepEqual(lint(dir, "DEMO-2"), []);
});

// @req REQ-cards-001
test("lint/scope-protected: a broad scope glob that covers a protected glob is reported; a grant or a narrow scope passes", () => {
  const dir = projectWith({});
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml") + "protected: [\"roles/**\"]\n");
  for (const [id, fm] of [
    ["DEMO-1", "kind: chore\nscope: [\"**\"]\n"],
    ["DEMO-2", "kind: chore\nscope: [\"**\"]\nallow_protected: [\"roles/**\"]\n"],
    ["DEMO-3", "kind: chore\nscope: [\"src/**\"]\n"],
    ["DEMO-4", "kind: chore\nscope: [\"src/**\", \"roles/a.md\"]\n"],
  ] as const) write(dir, `cards/${id}.card.md`, cardText(id, { fm }));
  const found = lint(dir, "DEMO-1");
  assert.deepEqual(codesOf(found), ["lint/scope-protected"]);
  assert.match(found[0]!.message, /scope glob '\*\*' covers the protected path 'roles\/\*\*'/);
  assert.deepEqual(lint(dir, "DEMO-2"), []);
  assert.deepEqual(lint(dir, "DEMO-3"), []);
  // The narrow direction still holds: a scope glob inside a protected glob.
  assert.deepEqual(codesOf(lint(dir, "DEMO-4")), ["lint/scope-protected"]);
  assert.match(lint(dir, "DEMO-4")[0]!.message, /'roles\/a\.md' covers the protected path 'roles\/\*\*'/);
});

// @req REQ-cards-001
test("lint/scope-protected: a documentation path beside a protected path beneath it passes; another broad glob does not", () => {
  const dir = projectWith({
    "DEMO-1": cardText("DEMO-1", { fm: "kind: chore\nscope: [\"src/**\", \"docs/**\"]\n" }),
    "DEMO-2": cardText("DEMO-2", { fm: "kind: chore\nscope: [\"src/**\", \"**/*.md\"]\n" }),
  });
  // docs/** is a default documentation path; the protected docs/adr/** beneath it is not a finding.
  assert.deepEqual(lint(dir, "DEMO-1"), []);
  const found = lint(dir, "DEMO-2");
  assert.deepEqual(codesOf(found), ["lint/scope-protected"]);
  assert.match(found[0]!.message, /'AGENTS\.md'/);
});

// @req REQ-cards-001
test("lint/output-outside-scope: a path in Acceptance or docs that no scope glob covers is named; covered paths and codes pass", () => {
  const body = (acc: string) => `## Why\n\nThe demo needs it.\n\n## Out of scope\n\nNone\n\n## Acceptance\n\n${acc}\n`;
  const dir = projectWith({
    "DEMO-1": cardText("DEMO-1", { body: body("- `lib/greet.ts` greets; the lint code `lint/placeholder` stays.") }),
    "DEMO-2": cardText("DEMO-2", { fm: "kind: chore\nscope: [\"src/**\"]\ndocs: [guides/use.md]\n" }),
    "DEMO-3": cardText("DEMO-3", { body: body("- src/greet.ts and `docs/guide.md` are updated (see `lint/placeholder`).") }),
  });
  const a = lint(dir, "DEMO-1");
  assert.deepEqual(codesOf(a), ["lint/output-outside-scope"]);
  assert.match(a[0]!.message, /'lib\/greet\.ts'/);
  const b = lint(dir, "DEMO-2");
  assert.deepEqual(codesOf(b), ["lint/output-outside-scope"]);
  assert.match(b[0]!.message, /'guides\/use\.md' named in 'docs:'/);
  assert.deepEqual(lint(dir, "DEMO-3"), []);
});

// @req REQ-cards-001
test("lint/output-outside-scope: backticked paths without an extension count (bin/mw, docs/guide, src/engine/, a root Dockerfile); plain words and codes do not", () => {
  const body = (acc: string) => `## Why\n\nThe demo needs it.\n\n## Out of scope\n\nNone\n\n## Acceptance\n\n${acc}\n`;
  const dir = projectWith({
    "DEMO-1": cardText("DEMO-1", { fm: "kind: chore\nscope: [\"src/**\"]\n", body: body("- `bin/mw` starts, `docs/guide` explains it, `lib/engine/` holds it, `Dockerfile` builds it.") }),
    "DEMO-2": cardText("DEMO-2", { fm: "kind: chore\nscope: [\"bin/**\", \"docs/**\", \"src/**\", \"Dockerfile\"]\n", body: body("- `bin/mw` starts, `docs/guide` explains it, `src/engine/` and `src/engine` hold it, `Dockerfile` builds it.") }),
    "DEMO-3": cardText("DEMO-3", { fm: "kind: chore\nscope: [\"src/**\"]\n", body: body("- It works for users and/or admins; `Makefile` and `notes` are words here, bin/mw too, and `card/no-requirement` is a code.") }),
  });
  write(dir, "Dockerfile", "FROM scratch\n");
  write(dir, "bin/setup.sh", "\n");
  write(dir, "docs/index.md", "\n");
  write(dir, "src/engine/run.ts", "\n");
  const a = lint(dir, "DEMO-1");
  assert.deepEqual(codesOf(a), Array(4).fill("lint/output-outside-scope"));
  const named = a.map((f) => /The path '([^']+)'/.exec(f.message)?.[1]).sort();
  assert.deepEqual(named, ["Dockerfile", "bin/mw", "docs/guide", "lib/engine/"]);
  assert.deepEqual(lint(dir, "DEMO-2"), []);
  assert.deepEqual(lint(dir, "DEMO-3"), [], "plain words, unquoted paths without an extension and absent root names are not paths");
});

// @req REQ-cards-001
test("lint/depends-open: a dependency that is not done is reported (a warning); a done one passes", () => {
  const dir = projectWith({
    "DEMO-1": cardText("DEMO-1", { fm: "kind: chore\nscope: [\"src/**\"]\ndepends: [DEMO-2]\n" }),
    "DEMO-2": cardText("DEMO-2"),
    "DEMO-3": cardText("DEMO-3", { fm: "kind: chore\nscope: [\"src/**\"]\ndepends: [DEMO-4]\n" }),
    "DEMO-4": cardText("DEMO-4").replace("status: todo", "status: done"),
  });
  const found = lint(dir, "DEMO-1");
  assert.deepEqual(found.map((f) => [f.code, f.severity]), [["lint/depends-open", "warning"]]);
  assert.match(found[0]!.message, /DEMO-2, which is todo/);
  assert.deepEqual(lint(dir, "DEMO-3"), []);
});

// @req REQ-cards-001
test("lint/stale: a requirement whose revision moved past the card's is reported; the current revision passes", () => {
  const fm = (rev: number) => `implements: [REQ-auth-001]\nrevs: {REQ-auth-001: ${rev}}\nscope: ["src/**"]\n`;
  const dir = projectWith({ "DEMO-1": cardText("DEMO-1", { fm: fm(1) }), "DEMO-2": cardText("DEMO-2", { fm: fm(2) }) });
  write(dir, "specs/auth.spec.md", SPEC.replace("- priority: must\n", "- priority: must\n- rev: 2\n"));
  const found = lint(dir, "DEMO-1");
  assert.deepEqual(codesOf(found), ["lint/stale"]);
  assert.match(found[0]!.message, /rev 1.*now rev 2.*mw card ack DEMO-1/);
  assert.deepEqual(lint(dir, "DEMO-2"), []);
});

// @req REQ-cards-002
test("mw card lint --json and mw_card_lint return the same codes and messages", async () => {
  const dir = projectWith({ "DEMO-1": cardText("DEMO-1", { fm: "kind: chore\ndepends: [DEMO-2]\n", body: "## Why\n\n\n## Out of scope\n\n(what this card must not touch)\n" }), "DEMO-2": cardText("DEMO-2") });
  const cli = mw(dir, ["card", "lint", "DEMO-1", "--json"]);
  assert.equal(cli.code, 1);
  const fromCli = JSON.parse(cli.out);
  assert.deepEqual(fromCli.findings.map((f: LintFinding) => f.code).sort(), ["lint/depends-open", "lint/no-acceptance", "lint/placeholder", "lint/scope-empty", "lint/why-empty"]);
  const r = await tool(dir, "mw_card_lint", { id: "DEMO-1" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(JSON.parse(r.text), fromCli);
  assert.deepEqual(fromCli, { id: "DEMO-1", ok: false, findings: lint(dir) });

  const clean = mw(dir, ["card", "lint", "DEMO-2", "--json"]);
  assert.equal(clean.code, 0, clean.err);
  assert.deepEqual(JSON.parse(clean.out), JSON.parse((await tool(dir, "mw_card_lint", { id: "DEMO-2" })).text));
  assert.deepEqual(JSON.parse(clean.out), { id: "DEMO-2", ok: true, findings: [] });
});

// @req REQ-cards-002
test("mw card lint --json and mw_card_lint agree for a card whose file is not named after its id, and change nothing", async () => {
  const dir = projectWith({});
  write(dir, "cards/greeting.card.md", cardText("DEMO-4", { fm: "kind: chore\n" }));
  write(dir, "cards/welcome.card.md", cardText("DEMO-5"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "cards with other file names");
  const before = snapshot(dir);
  for (const [id, ok] of [["DEMO-4", false], ["DEMO-5", true]] as const) {
    const cli = mw(dir, ["card", "lint", id, "--json"]);
    assert.equal(cli.code, ok ? 0 : 1, cli.err);
    const r = await tool(dir, "mw_card_lint", { id });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(JSON.parse(r.text), JSON.parse(cli.out));
    assert.equal(JSON.parse(cli.out).ok, ok);
  }
  assert.deepEqual(codesOf(JSON.parse((await tool(dir, "mw_card_lint", { id: "DEMO-4" })).text).findings), ["lint/scope-empty"]);
  assert.deepEqual(snapshot(dir), before, "HEAD, git status and the card files are unchanged");
});

// @req REQ-cards-002
test("mw card lint exits non-zero on lint errors and writes nothing; a clean card exits 0", () => {
  const dir = projectWith({ "DEMO-1": cardText("DEMO-1", { fm: "kind: chore\n" }), "DEMO-2": cardText("DEMO-2") });
  const before = snapshot(dir);
  const r = mw(dir, ["card", "lint", "DEMO-1"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /error lint\/scope-empty: /);
  assert.match(r.out, /DEMO-1 has 1 lint error\(s\)/);
  assert.deepEqual(snapshot(dir), before);
  const ok = mw(dir, ["card", "lint", "DEMO-2"]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /DEMO-2 passes lint/);
  assert.deepEqual(snapshot(dir), before);
});

// @req REQ-cards-003
test("mw card status ready refuses a card with lint errors, naming the codes; no file or commit changes", () => {
  const dir = projectWith({ "DEMO-1": cardText("DEMO-1", { body: "## Why\n\nThe demo needs it.\n\n## Out of scope\n\n(what this card must not touch)\n\n## Acceptance\n\n- It works.\n" }), "DEMO-2": cardText("DEMO-2") });
  const before = snapshot(dir);
  const r = mw(dir, ["card", "status", "DEMO-1", "ready"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /DEMO-1 was not set ready: it has lint errors \(lint\/placeholder\)\..*mw card lint DEMO-1.*nothing was written/);
  assert.deepEqual(snapshot(dir), before);
  // A clean card still becomes ready.
  const ok = mw(dir, ["card", "status", "DEMO-2", "ready"]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(read(dir, "cards/DEMO-2.card.md"), /status: ready/);
});

// @req REQ-cards-003
test("mw_card_set_status ready refuses a card with lint errors; no file or commit changes", async () => {
  const dir = projectWith({ "DEMO-1": cardText("DEMO-1", { fm: "kind: chore\n" }), "DEMO-2": cardText("DEMO-2") });
  const before = snapshot(dir);
  const r = await tool(dir, "mw_card_set_status", { id: "DEMO-1", status: "ready" });
  assert.equal(r.isError, true);
  assert.match(r.text, /DEMO-1 was not set ready: it has lint errors \(lint\/scope-empty\)/);
  assert.deepEqual(snapshot(dir), before);
  const ok = await tool(dir, "mw_card_set_status", { id: "DEMO-2", status: "ready" });
  assert.equal(ok.isError, false, ok.text);
  assert.notEqual(git(dir, "rev-parse", "HEAD"), before.head);
  assert.equal(git(dir, "log", "-1", "--format=%s"), "card: DEMO-2 ready");
});

// @req REQ-cards-003
test("mw card new --status ready and mw_card_new status ready refuse a card that fails lint; no card file is written", async () => {
  const dir = projectWith({});
  const before = snapshot(dir);
  const r = mw(dir, ["card", "new", "--title", "Greet", "--kind", "chore", "--scope", "src/**", "--why", "Users like it.", "--status", "ready"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /DEMO-1 was not created ready: it has lint errors \(lint\/placeholder, lint\/no-acceptance\)/);
  assert.deepEqual(snapshot(dir), before);
  const t = await tool(dir, "mw_card_new", { title: "Greet", kind: "chore", scope: ["src/**"], why: "Users like it.", status: "ready" });
  assert.equal(t.isError, true);
  assert.match(t.text, /lint\/placeholder, lint\/no-acceptance/);
  assert.deepEqual(snapshot(dir), before);
  // With the sections filled, the same card is created ready.
  const ok = mw(dir, ["card", "new", "--title", "Greet", "--kind", "chore", "--scope", "src/**", "--why", "Users like it.", "--out-of-scope", "None", "--acceptance", "It greets.", "--status", "ready"]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(read(dir, "cards/DEMO-1.card.md"), /status: ready/);
});

// @req REQ-cards-003
test("start() refuses a fresh run of a ready card that has gained a lint error, before any phase; a resumed run is not linted", async () => {
  const dir = engineProject();
  useScript(script());
  write(dir, "cards/DEMO-1.card.md", read(dir, "cards/DEMO-1.card.md").replace("status: todo", "status: ready").replace("## Acceptance", "## Out of scope\n\n(what this card must not touch)\n\n## Acceptance"));
  git(dir, "commit", "-qam", "card gains a placeholder");
  const head = git(dir, "rev-parse", "HEAD");
  await assert.rejects(run(dir), /DEMO-1 was not started: it has lint errors \(lint\/placeholder\)/);
  assert.equal(fs.existsSync(runPath(dir)), false, "no run files");
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
  assert.equal(git(dir, "branch", "--list", "card/DEMO-1"), "");

  // A run that is waiting at a stop point continues even though its card now fails lint.
  const dir2 = engineProject({ cardExtra: "risk: high\n" });
  useScript(script());
  const first = await run(dir2);
  assert.equal(first.status, "waiting");
  write(dir2, "cards/DEMO-1.card.md", read(dir2, "cards/DEMO-1.card.md").replace("## Acceptance", "## Out of scope\n\n(what this card must not touch)\n\n## Acceptance"));
  git(dir2, "commit", "-qam", "card gains a placeholder");
  const phasesBefore = first.history.length;
  const next = await run(dir2, { approve: ["go"] });
  assert.ok(next.history.length > phasesBefore, "the resumed run went on to further phases");
});

// @req REQ-cards-003
test("mw run --dry-run refuses a fresh ready card with a lint error; a valid card still dry-runs", () => {
  const bad = engineProject();
  write(bad, "cards/DEMO-1.card.md", read(bad, "cards/DEMO-1.card.md").replace("status: todo", "status: ready").replace("## Acceptance", "## Out of scope\n\n(what this card must not touch)\n\n## Acceptance"));
  git(bad, "commit", "-qam", "card gains a placeholder");
  const head = git(bad, "rev-parse", "HEAD");
  const r = mw(bad, ["run", "DEMO-1", "--dry-run"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /DEMO-1 was not started: it has lint errors \(lint\/placeholder\)\..*nothing was written/);
  assert.equal(fs.existsSync(runPath(bad)), false, "no run directory");
  assert.equal(git(bad, "rev-parse", "HEAD"), head);

  const good = engineProject();
  write(good, "cards/DEMO-1.card.md", read(good, "cards/DEMO-1.card.md").replace("status: todo", "status: ready"));
  git(good, "commit", "-qam", "ready");
  const ok = mw(good, ["run", "DEMO-1", "--dry-run"]);
  assert.equal(ok.code, 0, ok.err);
});

// @req REQ-cards-004
test("mw card new --out-of-scope and --acceptance replace the scaffold in those sections", () => {
  const dir = projectWith({});
  const r = mw(dir, ["card", "new", "--title", "Greet", "--kind", "chore", "--scope", "src/**", "--why", "Users like it.", "--out-of-scope", "The login page.", "--acceptance", "It greets by name.", "--acceptance", "src/greet.ts exports greet()."]);
  assert.equal(r.code, 0, r.err);
  const text = read(dir, "cards/DEMO-1.card.md");
  assert.match(text, /## Out of scope\n\nThe login page\.\n\n## Acceptance\n\n- It greets by name\.\n- src\/greet\.ts exports greet\(\)\.\n$/);
  assert.ok(!text.includes(OUT_OF_SCOPE_SCAFFOLD));
  assert.deepEqual(lint(dir), []);
});

// @req REQ-cards-004
test("mw_card_new refuses a feature card with no requirement while trace.require_implements is true, as the CLI does", async () => {
  const dir = projectWith({});
  const before = snapshot(dir);
  const cli = mw(dir, ["card", "new", "--title", "Greet", "--scope", "src/**"]);
  assert.equal(cli.code, 1);
  const t = await tool(dir, "mw_card_new", { title: "Greet", scope: ["src/**"] });
  assert.equal(t.isError, true);
  assert.match(t.text, /card\/no-requirement|a feature card must say which requirement it implements/);
  assert.equal(t.text, cli.err.replace(/^mw: /, "").trim());
  assert.deepEqual(snapshot(dir), before);
  const ok = await tool(dir, "mw_card_new", { title: "Greet", implements: ["REQ-auth-001"], scope: ["src/**"], why: "Users like it.", out_of_scope: "None", acceptance: ["It greets."] });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(lint(dir), []);
});

// @req REQ-cards-003
test("the MCP ready routes lint before the repository lock and the lease: a lint-failing card is refused without taking either", async () => {
  const p = hubPair();
  // On b: one card that fails lint (no scope) and one that passes, committed.
  write(p.b, "cards/DEMO-8.card.md", cardText("DEMO-8", { fm: "kind: chore\n" }));
  write(p.b, "cards/DEMO-9.card.md", cardText("DEMO-9"));
  git(p.b, "add", "-A");
  git(p.b, "commit", "-q", "-m", "cards on b");
  // Another machine holds the lease, and another holder has b's repository lock: a call that entered
  // the transaction would be refused with repo/locked (or lease/held), not with the lint codes.
  await as("alpha", undefined, () => openHub(new Project(p.a)).take());
  const lease = git(p.hubDir, "rev-parse", "refs/mergewright/lease");
  const wait = repoLockTiming.waitMs;
  repoLockTiming.waitMs = 300;
  try {
    await withRepoLock(new Project(p.b), async () => {
      const before = snapshot(p.b);
      const set = await as("beta", undefined, () => tool(p.b, "mw_card_set_status", { id: "DEMO-8", status: "ready" }));
      assert.equal(set.isError, true);
      assert.match(set.text, /DEMO-8 was not set ready: it has lint errors \(lint\/scope-empty\)\..*mw card lint DEMO-8.*nothing was written/);
      const made = await as("beta", undefined, () => tool(p.b, "mw_card_new", { title: "Greet", kind: "chore", scope: ["src/**"], why: "Users like it.", status: "ready" }));
      assert.equal(made.isError, true);
      assert.match(made.text, /was not created ready: it has lint errors \(lint\/placeholder, lint\/no-acceptance\)\..*nothing was written/);
      assert.deepEqual(snapshot(p.b), before, "HEAD and the card files are unchanged");
      assert.equal(git(p.b, "status", "--porcelain"), "");
      // The fixture would catch a call that took the lock: a lint-clean card does reach it and waits.
      const control = await as("beta", undefined, () => tool(p.b, "mw_card_set_status", { id: "DEMO-9", status: "ready" }));
      assert.equal(control.isError, true);
      assert.match(control.text, /repository is locked/);
    });
  } finally {
    repoLockTiming.waitMs = wait;
  }
  // With the lock free, a lint-clean card reaches the transaction and meets alpha's lease.
  const leased = await as("beta", undefined, () => tool(p.b, "mw_card_set_status", { id: "DEMO-9", status: "ready" }));
  assert.equal(leased.isError, true);
  assert.match(leased.text, /alpha .*holds the lease/);
  assert.equal(git(p.hubDir, "rev-parse", "refs/mergewright/lease"), lease, "alpha's lease is untouched");
});

// @req REQ-cards-003
test("start() lints a fresh run again after adopting the hub: a newer hub card with a lint error is refused before any phase", async () => {
  const p = hubPair();
  useScript(script());
  // b readies the lint-clean card and pushes it; a then adds a placeholder to it and pushes that.
  write(p.b, "cards/DEMO-1.card.md", read(p.b, "cards/DEMO-1.card.md").replace("status: todo", "status: ready"));
  git(p.b, "commit", "-qam", "ready");
  git(p.b, "push", "-q", "hub", "main");
  git(p.a, "pull", "-q", "--ff-only", "hub", "main");
  write(p.a, "cards/DEMO-1.card.md", read(p.a, "cards/DEMO-1.card.md").replace("## Acceptance", "## Out of scope\n\n(what this card must not touch)\n\n## Acceptance"));
  git(p.a, "commit", "-qam", "card gains a placeholder");
  git(p.a, "push", "-q", "hub", "main");
  const hubHead = git(p.hubDir, "rev-parse", "main");
  assert.deepEqual(lint(p.b), [], "b's own copy of the card is lint-clean");

  // Adopting moves only the branch and the index; file sync delivers the files, here while the hub is adopted.
  hubTestHooks.beforeAdoptUpdate = () => write(p.b, "cards/DEMO-1.card.md", read(p.a, "cards/DEMO-1.card.md"));
  try {
    await assert.rejects(as("beta", undefined, () => runCard(new Project(p.b), "DEMO-1", {})), /DEMO-1 was not started: it has lint errors \(lint\/placeholder\)\..*nothing was written/);
  } finally {
    delete hubTestHooks.beforeAdoptUpdate;
  }
  // b adopted the hub's history and wrote nothing of its own: no commit, no run files, no branch, no phase.
  assert.equal(git(p.b, "rev-parse", "HEAD"), hubHead);
  assert.equal(git(p.hubDir, "rev-parse", "main"), hubHead, "nothing was pushed");
  assert.equal(git(p.b, "status", "--porcelain"), "");
  assert.equal(read(p.b, "cards/DEMO-1.card.md"), read(p.a, "cards/DEMO-1.card.md"));
  assert.equal(fs.existsSync(runPath(p.b)), false, "no run files and no phase ran");
  assert.equal(git(p.b, "branch", "--list", "card/DEMO-1"), "");
  assert.equal(fs.existsSync(path.join(p.b, ".mergewright", "worktrees", "DEMO-1")), false, "no worktree");
  // The lease prepare() took for the refused start was handed back, so it blocks no other machine.
  assert.equal(git(p.hubDir, "for-each-ref", "refs/mergewright/lease"), "", "no hub lease remains");
});

/** The files the commit `rev` changed, sorted. */
const touched = (dir: string, rev = "HEAD") => git(dir, "show", "--name-only", "--format=", rev).split("\n").filter(Boolean).sort();

// @req REQ-cards-006
test("mw card status ready|todo --commit and mw card new --commit each commit the card file alone on the base branch", () => {
  const dir = projectWith({ "DEMO-1": cardText("DEMO-1") });
  // An unrelated change in the working tree stays out of every commit.
  write(dir, "src/app.txt", "work in progress\n");
  const head0 = git(dir, "rev-parse", "HEAD");

  const ready = mw(dir, ["card", "status", "DEMO-1", "ready", "--commit"]);
  assert.equal(ready.code, 0, ready.err);
  assert.match(ready.out, /DEMO-1: todo -> ready\ncommitted cards\/DEMO-1\.card\.md as [0-9a-f]{10} \('card: DEMO-1 ready'\); git\.hub is none, so the commit stays in this checkout/);
  assert.doesNotMatch(ready.out, /is not committed/);
  assert.equal(git(dir, "rev-list", "--count", `${head0}..HEAD`), "1");
  assert.equal(git(dir, "log", "-1", "--format=%s"), "card: DEMO-1 ready");
  assert.deepEqual(touched(dir), ["cards/DEMO-1.card.md"]);
  assert.match(git(dir, "show", "HEAD:cards/DEMO-1.card.md"), /status: ready/);
  assert.equal(git(dir, "symbolic-ref", "--short", "HEAD"), "main");

  const head1 = git(dir, "rev-parse", "HEAD");
  const todo = mw(dir, ["card", "status", "DEMO-1", "todo", "--commit"]);
  assert.equal(todo.code, 0, todo.err);
  assert.equal(git(dir, "rev-list", "--count", `${head1}..HEAD`), "1");
  assert.equal(git(dir, "log", "-1", "--format=%s"), "card: DEMO-1 todo");
  assert.deepEqual(touched(dir), ["cards/DEMO-1.card.md"]);
  assert.match(git(dir, "show", "HEAD:cards/DEMO-1.card.md"), /status: todo/);

  const head2 = git(dir, "rev-parse", "HEAD");
  const made = mw(dir, ["card", "new", "--title", "Greet", "--kind", "chore", "--scope", "src/**", "--why", "Users like it.", "--out-of-scope", "None", "--acceptance", "It greets.", "--commit"]);
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /created cards\/DEMO-2\.card\.md \(status todo\)\ncommitted cards\/DEMO-2\.card\.md/);
  assert.equal(git(dir, "rev-list", "--count", `${head2}..HEAD`), "1");
  assert.equal(git(dir, "log", "-1", "--format=%s"), "card: DEMO-2 Greet");
  assert.deepEqual(touched(dir), ["cards/DEMO-2.card.md"]);

  // Nothing else was committed or staged: the unrelated change is still only in the working tree.
  assert.equal(git(dir, "status", "--porcelain", "--untracked-files=all"), "?? src/app.txt");
});

// @req REQ-cards-006
test("without --commit, mw card status and mw card new leave HEAD and the index alone and keep the not-committed warning", () => {
  const dir = projectWith({ "DEMO-1": cardText("DEMO-1") });
  const head = git(dir, "rev-parse", "HEAD");
  const r = mw(dir, ["card", "status", "DEMO-1", "ready"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "DEMO-1: todo -> ready (cards/DEMO-1.card.md is not committed; commit it so 'mw work' can merge the card later)\n");
  const made = mw(dir, ["card", "new", "--title", "Greet", "--kind", "chore", "--scope", "src/**", "--why", "Users like it."]);
  assert.equal(made.code, 0, made.err);
  assert.equal(made.out, "created cards/DEMO-2.card.md (status todo)\n");
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
  assert.equal(git(dir, "diff", "--cached", "--name-only"), "");
  assert.equal(sh(dir, "git", ["status", "--porcelain", "--untracked-files=all"]).out, " M cards/DEMO-1.card.md\n?? cards/DEMO-2.card.md\n");
});

// @req REQ-cards-006
test("--commit pushes the card commit to the hub through the lease fence, and releases the lease it took", () => {
  const { a, hubDir } = hubPair({ kind: "chore" });
  const env = { MW_HOST: "c6-host" };
  const st = mw(a, ["card", "status", "DEMO-1", "ready", "--commit"], env);
  assert.equal(st.code, 0, st.err);
  assert.match(st.out, /the commit is on the hub 'hub'/);
  assert.equal(git(hubDir, "rev-parse", "main"), git(a, "rev-parse", "HEAD"));
  assert.equal(git(hubDir, "log", "-1", "--format=%s", "main"), "card: DEMO-1 ready");
  assert.deepEqual(touched(a), ["cards/DEMO-1.card.md"]);

  const made = mw(a, ["card", "new", "--title", "Greet", "--kind", "chore", "--scope", "src/**", "--why", "Users like it.", "--commit"], env);
  assert.equal(made.code, 0, made.err);
  assert.equal(git(hubDir, "rev-parse", "main"), git(a, "rev-parse", "HEAD"));
  assert.equal(git(hubDir, "log", "-1", "--format=%s", "main"), "card: DEMO-2 Greet");
  assert.deepEqual(touched(a), ["cards/DEMO-2.card.md"]);
  // The lease was taken for the push and given back: no machine holds it now.
  const lease = mw(a, ["lease", "show"], env);
  assert.match(lease.out, /no machine holds the lease/);
});

// @req REQ-cards-006
test("a refused --commit writes and commits nothing: lint errors, another status, not on the base branch, other staged changes", () => {
  const unready = cardText("DEMO-1", { fm: "kind: chore\n" });
  const dir = projectWith({ "DEMO-1": unready, "DEMO-2": cardText("DEMO-2") });
  const refused = (args: string[], err: RegExp) => {
    const before = snapshot(dir);
    const r = mw(dir, args);
    assert.equal(r.code, 1, r.out);
    assert.match(r.err, err);
    assert.deepEqual(snapshot(dir), before);
  };
  refused(["card", "status", "DEMO-1", "ready", "--commit"], /DEMO-1 was not set ready: it has lint errors \(lint\/scope-empty\).*nothing was written/);
  refused(["card", "status", "DEMO-2", "done", "--commit"], /a card is set to todo or ready by hand, not 'done'/);
  refused(["card", "new", "--title", "Greet", "--kind", "chore", "--scope", "src/**", "--why", "Users like it.", "--status", "ready", "--commit"], /DEMO-3 was not created ready: it has lint errors/);

  // Staged changes to another file would ride along: refused, and they stay staged.
  write(dir, "src/app.txt", "staged\n");
  git(dir, "add", "src/app.txt");
  refused(["card", "status", "DEMO-2", "ready", "--commit"], /staged changes to src\/app\.txt.*nothing was written/);
  refused(["card", "new", "--title", "Greet", "--kind", "chore", "--commit"], /staged changes to src\/app\.txt.*nothing was written/);
  git(dir, "rm", "-q", "--cached", "src/app.txt");
  fs.rmSync(path.join(dir, "src/app.txt"));

  // Off the base branch.
  git(dir, "switch", "-q", "-c", "other");
  refused(["card", "status", "DEMO-2", "ready", "--commit"], /on 'other', not the base branch 'main'.*nothing was written/);
  refused(["card", "new", "--title", "Greet", "--kind", "chore", "--commit"], /on 'other', not the base branch 'main'.*nothing was written/);
});

// @req REQ-cards-006
test("a --commit whose commit fails leaves a blocked run as it was: no run aborted, no worktree moved, no record set aside", async () => {
  useScript(script({ planner: [{ output: brief({ ready: false, blockers: ["the card needs the owner's numbers"] }) }] }));
  const dir = engineProject();
  write(dir, "cards/DEMO-1.card.md", read(dir, "cards/DEMO-1.card.md").replace("status: todo", "status: ready"));
  git(dir, "commit", "-qam", "ready");
  assert.equal((await run(dir)).status, "blocked");
  const worktree = path.join(dir, ".mergewright", "worktrees", "DEMO-1");
  // Uncommitted work in the worktree: setting the run aside would commit it to the card branch.
  if (fs.existsSync(worktree)) fs.writeFileSync(path.join(worktree, "wip.txt"), "unsaved\n");
  const stateBefore = fs.readFileSync(runPath(dir, "state.json"), "utf8");
  const branchBefore = git(dir, "for-each-ref", "refs/heads/card/");
  const worktreeBefore = fs.existsSync(worktree) ? git(worktree, "status", "--porcelain", "--untracked-files=all") : undefined;
  const before = snapshot(dir);
  const index = git(dir, "ls-files", "-s", "cards/DEMO-1.card.md");
  // The card commit fails (the runtime runs git without hooks, so through a signing program that fails).
  git(dir, "config", "commit.gpgsign", "true");
  git(dir, "config", "gpg.program", "false");

  const r = mw(dir, ["card", "status", "DEMO-1", "todo", "--commit"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /could not commit it.*nothing was kept: cards\/DEMO-1\.card\.md restored/);
  assert.doesNotMatch(r.out, /blocked run was aborted/);
  // HEAD, the card file and its index entry are as they were.
  assert.deepEqual(snapshot(dir), before);
  assert.equal(git(dir, "ls-files", "-s", "cards/DEMO-1.card.md"), index);
  assert.match(read(dir, "cards/DEMO-1.card.md"), /status: ready/);
  // The run is untouched: its record, its branch and its worktree (with the uncommitted work).
  assert.equal(fs.readFileSync(runPath(dir, "state.json"), "utf8"), stateBefore);
  assert.equal(git(dir, "for-each-ref", "refs/heads/card/"), branchBefore);
  if (worktreeBefore !== undefined) assert.equal(git(worktree, "status", "--porcelain", "--untracked-files=all"), worktreeBefore);
  assert.equal(fs.existsSync(path.join(dir, ".mergewright", "local", "discarded")), false, "nothing was set aside");
  assert.equal(JSON.parse(stateBefore).status, "blocked");

  // With signing off again the same command commits the card, then sets the run aside.
  git(dir, "config", "commit.gpgsign", "false");
  const ok = mw(dir, ["card", "status", "DEMO-1", "todo", "--commit"]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /DEMO-1: its blocked run was aborted/);
  assert.equal(git(dir, "log", "-1", "--format=%s"), "card: DEMO-1 todo");
  assert.deepEqual(touched(dir), ["cards/DEMO-1.card.md"]);
  assert.equal(fs.existsSync(runPath(dir)), false, "the run record was moved aside after the commit");
});
