// Regression tests for the committing MCP tools, the docs flow and the service installer.
//   1. The committing MCP tools check their preconditions (git identity, base branch, repository
//      lock) before writing, and a commit that still fails restores what they wrote.
//   2. The preset docs flow remediates twice and reflects; the docs-writer runs the checks first.
//   3. docs.sync names the changed files outside docs.paths it did not consider.
//   4. scripts/install-service.sh accepts work and mw-work, and says when it rewrote the shared unit.
//   5. mw doctor does not crash without systemctl.
// Only long-standing symbols are imported statically, so a missing newer one fails its own test
// instead of the whole file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { check } from "../src/check.ts";
import * as doctorModule from "../src/commands-integrations.ts";
import { callTool, TOOLS } from "../src/mcpserver/server.ts";
import type { ToolContext } from "../src/mcpserver/tool.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { parseFlow } from "../src/model/flow.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { Project } from "../src/project.ts";
import { git, newProject, read, tmpDir } from "./helpers.ts";
import { handoff, project, run, script, state, useScript } from "./engine-helpers.ts";

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

/** Run `f` with git unable to find an identity anywhere but the repository's own config. */
async function withoutGlobalIdentity<T>(f: () => Promise<T>): Promise<T> {
  const names = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL", "GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME", "EMAIL"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    return await f();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

/** A project with card DEMO-1 (todo) committed, git's user.email removed and auto-detection off. */
function projectWithoutEmail(): string {
  const dir = newProject();
  fs.writeFileSync(path.join(dir, "cards", "DEMO-1.card.md"), "---\nid: DEMO-1\ntitle: First\nkind: docs\nstatus: todo\nscope: [docs/**]\n---\n\n## Why\n\nDemo.\n\n## Acceptance\n\n- The demo is documented.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "card");
  git(dir, "config", "--unset", "user.email");
  // Without this, git guesses an email from the host name when the host has a domain
  // (user@host.example), and the repository would still have an identity.
  git(dir, "config", "user.useConfigOnly", "true");
  return dir;
}

test("without a git identity the committing tools refuse before writing; nothing is staged", async () => {
  const dir = projectWithoutEmail();
  await withoutGlobalIdentity(async () => {
    const probe = spawnSync("git", ["var", "GIT_COMMITTER_IDENT"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(probe.status, 0, "the scratch repository has no identity");
    const head = git(dir, "rev-parse", "HEAD");
    const before = read(dir, "cards/DEMO-1.card.md");

    const r = await call(dir, "mw_card_set_status", { id: "DEMO-1", status: "ready" });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /git has no identity/);
    assert.match(r.text, /git config user\.email/);
    assert.equal(read(dir, "cards/DEMO-1.card.md"), before, "the card file is unchanged");
    assert.equal(git(dir, "status", "--porcelain"), "", "nothing written, nothing staged");

    const made = await call(dir, "mw_card_new", { title: "Second", kind: "chore" });
    assert.equal(made.isError, true, made.text);
    assert.equal(fs.existsSync(path.join(dir, "cards", "DEMO-2.card.md")), false, "no new card file");

    const st = await call(dir, "mw_memory_state", { text: "# State\n\nNew.\n" });
    assert.equal(st.isError, true, st.text);
    const lesson = await call(dir, "mw_memory_add", { kind: "lesson", topic: "testing", title: "T", body: "B" });
    assert.equal(lesson.isError, true, lesson.text);
    const doc = await call(dir, "mw_docs_write", { path: "docs/x.md", content: "# X\n" });
    assert.equal(doc.isError, true, doc.text);
    assert.match(doc.text, /git has no identity/);

    assert.equal(git(dir, "status", "--porcelain"), "", "no tool left a file or a staged change");
    assert.equal(git(dir, "rev-parse", "HEAD"), head);
  });
});

test("a commit that fails after the checks restores the files and unstages them", async () => {
  const dir = projectWithoutEmail();
  git(dir, "config", "user.email", "test@example.com");
  // Signing with a program that always fails: the identity is fine, the commit itself fails.
  git(dir, "config", "commit.gpgsign", "true");
  git(dir, "config", "gpg.program", "false");
  const head = git(dir, "rev-parse", "HEAD");
  const card = read(dir, "cards/DEMO-1.card.md");
  const stateBefore = read(dir, "memory/STATE.md");
  const indexBefore = read(dir, "memory/INDEX.md");

  const r = await call(dir, "mw_card_set_status", { id: "DEMO-1", status: "ready" });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /could not commit/);
  assert.match(r.text, /nothing was kept/);
  assert.equal(read(dir, "cards/DEMO-1.card.md"), card, "the card file is back as it was");

  const st = await call(dir, "mw_memory_state", { text: "# State\n\nNew.\n" });
  assert.equal(st.isError, true, st.text);
  assert.equal(read(dir, "memory/STATE.md"), stateBefore);

  const made = await call(dir, "mw_card_new", { title: "Second", kind: "chore" });
  assert.equal(made.isError, true, made.text);
  assert.equal(fs.existsSync(path.join(dir, "cards", "DEMO-2.card.md")), false, "the new card file is removed");

  const dec = await call(dir, "mw_memory_add", { kind: "decision", title: "Use X", body: "Because." });
  assert.equal(dec.isError, true, dec.text);
  assert.equal(read(dir, "memory/INDEX.md"), indexBefore);

  const doc = await call(dir, "mw_docs_write", { path: "docs/new-guide.md", content: "# Guide\n" });
  assert.equal(doc.isError, true, doc.text);
  assert.equal(fs.existsSync(path.join(dir, "docs", "new-guide.md")), false);

  assert.equal(git(dir, "status", "--porcelain"), "", "every file restored and unstaged");
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
});

test("mw doctor reports a missing git identity with the fix", async () => {
  const dir = projectWithoutEmail();
  const lines: string[] = [];
  const code = await withoutGlobalIdentity(() => doctorModule.doctor((l?: string) => { lines.push(l ?? ""); }, new Project(dir)));
  const gitLine = lines.find((l) => /^git\s/.test(l));
  assert.ok(gitLine, lines.join("\n"));
  assert.match(gitLine, /identity NOT set/);
  assert.match(gitLine, /git config user\.name/);
  assert.match(gitLine, /git config user\.email/);
  assert.match(gitLine, /on the base branch 'main'/);
  assert.match(gitLine, /no hub/);
  assert.equal(code, 1, "a missing identity is a problem");

  // With the identity set, the line says so.
  git(dir, "config", "user.email", "test@example.com");
  const ok: string[] = [];
  await withoutGlobalIdentity(() => doctorModule.doctor((l?: string) => { ok.push(l ?? ""); }, new Project(dir)));
  assert.match(ok.find((l) => /^git\s/.test(l)) ?? "", /identity set/);
});

test("the preset docs flow remediates twice and reflects after merge; the docs-writer runs the checks", () => {
  const file = path.join(PACKAGE_ROOT, "presets", "standard", "flows", "docs.flow.yaml");
  const diag = new Diagnostics();
  const flow = parseFlow(file, fs.readFileSync(file, "utf8"), "preset", diag);
  assert.ok(flow, diag.sorted().map((d) => d.message).join("\n"));
  assert.equal(flow.remediate?.maxRounds, 2);
  const ids = flow.phases.map((p) => p.id);
  assert.deepEqual(ids, ["write", "gate", "review", "adjudicate", "merge", "reflect", "sync"]);
  const reflect = flow.phases.find((p) => p.id === "reflect")!;
  assert.equal(reflect.role, "reflector");
  assert.equal(reflect.action, "memory.update");

  const writer = fs.readFileSync(path.join(PACKAGE_ROOT, "presets", "standard", "roles", "docs-writer.role.md"), "utf8");
  assert.match(writer, /format check/);
  assert.match(writer, /tests that\s+touch them/);
  assert.match(writer, /gates\/<id>\.gate\.sh/);

  // A project that extends standard still checks clean.
  const dir = newProject();
  assert.match(read(dir, "mergewright.yaml"), /extends: standard/);
  const d = check(new Project(dir));
  assert.deepEqual(d.errors.map((e) => `${e.code}: ${e.message}`), []);
});

test("docs.sync names the changed files outside docs.paths that it did not sync", async () => {
  const dir = project({ kind: "docs", scope: ["docs/**", "apps/**"] });
  useScript(script({ "docs-writer": [{ writes: { "docs/guide.md": "# Guide\n", "apps/api/evals/README.md": "# Evals\n" }, output: handoff() }] }));
  const s = await run(dir);
  assert.equal(s.status, "done", JSON.stringify(s.history, null, 1));
  const sync = s.history.find((h) => h.phase === "sync");
  assert.ok(sync, JSON.stringify(s.history.map((h) => h.phase)));
  assert.match(sync.detail, /not synced: apps\/api\/evals\/README\.md is outside docs\.paths/);
  assert.doesNotMatch(sync.detail, /docs\/guide\.md is outside/);
  assert.ok(s.history.some((h) => h.phase === "reflect"), "the docs flow reflects");
  assert.ok(state(dir));
});

test("install-service.sh accepts work and mw-work; usage without root; wrong argument refused first", () => {
  const script = path.join(PACKAGE_ROOT, "scripts", "install-service.sh");
  assert.equal(spawnSync("bash", ["-n", script]).status, 0, "bash -n");
  const help = spawnSync("bash", [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /work\|mw-work <project>/);
  const bad = spawnSync("bash", [script, "bogus"], { encoding: "utf8" });
  assert.equal(bad.status, 2, "a wrong first argument is a usage error, before the root check");
  assert.match(bad.stderr, /work\|mw-work/);
  // Without systemd (macOS, or a system with no systemctl) it refuses and says why; '--check' finds nothing installed.
  const noSystemd = { ...process.env, MW_SYSTEMCTL: "/nonexistent/systemctl" };
  const refused = spawnSync("bash", [script, "work", "x"], { encoding: "utf8", env: noSystemd });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /this system has no systemd/);
  assert.equal(spawnSync("bash", [script, "unit", "--check"], { encoding: "utf8", env: noSystemd }).status, 0);
  // The root check comes after the systemd check, so it is reached only where systemd is.
  if (process.getuid?.() !== 0 && process.platform === "linux") {
    for (const kind of ["work", "mw-work"]) {
      const r = spawnSync("bash", [script, kind, "x"], { encoding: "utf8" });
      assert.equal(r.status, 1, `${kind} is accepted (it stops at the root check): ${r.stderr}`);
      assert.match(r.stderr, /run with sudo/);
    }
  }
  const text = fs.readFileSync(script, "utf8");
  assert.match(text, /note: the shared unit file \$unit was rewritten; other mw-work@ instances pick it up on their next restart/);
  assert.match(fs.readFileSync(path.join(PACKAGE_ROOT, "docs", "install.md"), "utf8"), /`mw-work <name>`/);
});

test("mw doctor's systemd line is skipped silently without systemctl", async () => {
  const mod = doctorModule as Record<string, unknown>;
  const unitFile = mod.workUnitFile as { path: string } | undefined;
  assert.ok(unitFile, "workUnitFile is exported");
  const dir = newProject();
  const fake = path.join(tmpDir(), "mw-work@.service");
  fs.writeFileSync(fake, "[Unit]\n");
  const old = unitFile.path;
  const oldPath = process.env.PATH;
  unitFile.path = fake;
  try {
    // A PATH with git but without systemctl.
    const bin = tmpDir();
    const gitBin = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    fs.symlinkSync(gitBin, path.join(bin, "git"));
    process.env.PATH = bin;
    const units = (mod.workUnits as (root: string) => unknown)(dir);
    assert.equal(units, undefined);
  } finally {
    process.env.PATH = oldPath;
    unitFile.path = old;
  }
});
