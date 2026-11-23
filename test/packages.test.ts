// The package mechanism (experimental): mw add | remove | packages, loading, the host, and what a
// package contributes (deliverers, recall, harness ids, commands, tools, checks, secrets).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { harnessFor } from "../src/engine/harness/index.ts";
import { promptValues } from "../src/engine/context.ts";
import { artifactStore, newState } from "../src/engine/state.ts";
import { flushQueue, integrationsFor, queueFor } from "../src/integrations.ts";
import { callTool, packageTools } from "../src/mcpserver/server.ts";
import { loadPackages } from "../src/packages/loader.ts";
import { Project } from "../src/project.ts";
import { card, codes, mw, newProject, read, write } from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "packages");
const fixture = (name: string) => path.join(FIXTURES, name);

/** A project with the fixture packages `names` installed through `mw add <path> --yes`. */
function withPackages(...names: string[]): string {
  const dir = newProject();
  for (const n of names) {
    const r = mw(dir, ["add", fixture(n), "--yes"]);
    assert.equal(r.code, 0, r.err);
  }
  return dir;
}

/** Set `packages.<name>` in mergewright.yaml. */
function setPackageConfig(dir: string, name: string, yaml: string): void {
  const text = read(dir, "mergewright.yaml").replace(new RegExp(`^  ${name}: \\{\\}\\n`, "m"), "");
  write(dir, "mergewright.yaml", `${text.trimEnd()}\n${text.includes("\npackages:") ? "" : "packages:\n"}  ${name}: ${yaml}\n`);
}

test("packages: mw add without --yes and without a terminal is refused and installs nothing", () => {
  const dir = newProject();
  const r = mw(dir, ["add", fixture("echo")]);
  assert.equal(r.code, 1);
  assert.match(r.err, /echo was not installed: a package runs with your rights, so installing one needs your confirmation.*--yes/);
  assert.match(r.out, /package echo 1\.2\.3: A test package that echoes what it is given\./, "it still shows what it would install");
  assert.ok(!fs.existsSync(path.join(dir, ".mergewright", "packages", "echo")));
  assert.doesNotMatch(read(dir, "mergewright.yaml"), /packages:/);
});

test("packages: mw add --yes shows the manifest, installs, enables; mw packages lists it; mw remove removes both", () => {
  const dir = newProject();
  const r = mw(dir, ["add", fixture("echo"), "--yes"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /package echo 1\.2\.3: A test package/);
  assert.match(r.out, /source: +folder .*fixtures\/packages\/echo/);
  assert.match(r.out, /provides: deliverers, recall, search, harness, commands, tools, checks \(harnesses: echo\)/);
  assert.match(r.out, /the environment variables ECHO_FIXTURE_TOKEN/);
  assert.match(r.out, /installed echo 1\.2\.3 in \.mergewright\/packages\/echo\/ and enabled it under packages:/);
  assert.ok(fs.existsSync(path.join(dir, ".mergewright", "packages", "echo", "lib.mjs")), "the whole folder is copied");
  assert.match(read(dir, "mergewright.yaml"), /^packages:\n  echo: \{\}$/m);
  assert.deepEqual(codes(dir, "error"), []);

  const list = mw(dir, ["packages"]);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /^echo +1\.2\.3 +enabled +loaded, provides deliverers, recall, search, harness, commands, tools, checks$/m);

  const gone = mw(dir, ["remove", "echo"]);
  assert.equal(gone.code, 0, gone.err);
  assert.match(gone.out, /removed echo/);
  assert.ok(!fs.existsSync(path.join(dir, ".mergewright", "packages", "echo")));
  assert.doesNotMatch(read(dir, "mergewright.yaml"), /packages:|echo/);
  assert.match(mw(dir, ["packages"]).out, /no packages installed/);
  assert.equal(mw(dir, ["remove", "echo"]).code, 1, "removing it again is an error");
});

test("packages: an unknown official name is refused with the list of official packages", () => {
  const r = mw(newProject(), ["add", "no-such-package", "--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /there is no official package 'no-such-package' \(official packages: .*\)/);
});

test("packages: a .ts entry loads by type stripping and contributes to recall", async () => {
  const dir = withPackages("echo-ts");
  const loaded = await loadPackages(new Project(dir));
  assert.equal(loaded[0]?.error, undefined);
  assert.deepEqual(await integrationsFor(new Project(dir)).recall("gates", 5), ["typed recall in demo for gates"]);
});

test("packages: a package written for another API version, or one that throws in activate(), is reported and skipped", async () => {
  const dir = withPackages("echo", "broken");
  // An installed package whose manifest asks for API version 2 (mw add refuses to install it).
  const future = path.join(dir, ".mergewright", "packages", "future");
  fs.cpSync(fixture("broken"), future, { recursive: true });
  fs.writeFileSync(path.join(future, "mergewright-package.yaml"), "name: future\nversion: 9.0.0\ndescription: From the future.\napiVersion: 2\nentry: index.mjs\n");
  setPackageConfig(dir, "future", "{}");
  const add = mw(dir, ["add", future, "--yes"]);
  assert.equal(add.code, 1);
  assert.match(add.err, /future 9\.0\.0 was not installed: it is written for package API version 2, and this runtime provides version 1/);

  const loaded = await loadPackages(new Project(dir));
  const by = new Map(loaded.map((l) => [l.name, l]));
  assert.match(by.get("future")!.error!, /written for package API version 2, and this runtime provides version 1/);
  assert.match(by.get("broken")!.error!, /activate\(\) failed: this package is broken on purpose/);
  assert.equal(by.get("echo")!.error, undefined);
  // The others still work: a broken package never breaks a run.
  assert.deepEqual(await integrationsFor(new Project(dir)).recall("q", 5), ["echo: recalled for q"]);
  const list = mw(dir, ["packages"]);
  assert.match(list.out, /^broken .*NOT loaded: activate\(\) failed: this package is broken on purpose$/m);
  assert.match(list.out, /^future +9\.0\.0 .*NOT loaded: it is written for package API version 2/m);
  const doctor = mw(dir, ["doctor"]);
  assert.match(doctor.out, /^broken +package NOT loaded/m);
  assert.match(doctor.out, /^echo +ok  greeting echo \(package echo\)$/m);
});

test("packages: a package's deliverer receives the queued item of its kind", async () => {
  const dir = withPackages("echo");
  const log = path.join(dir, "delivered.log");
  setPackageConfig(dir, "echo", `{ log_file: ${JSON.stringify(log)} }`);
  const project = new Project(dir);
  queueFor(project).add("echo", "echo: one", { hello: "world" });
  const results = await flushQueue(project);
  assert.deepEqual(results.map((r) => [r.kind, r.ok]), [["echo", true]]);
  assert.deepEqual(fs.readFileSync(log, "utf8"), '{"hello":"world"}\n');
  assert.equal(queueFor(project).list().length, 0);
});

test("packages: a recall provider's hits reach the prompt's {{memory.recall}}", async () => {
  const dir = withPackages("echo");
  setPackageConfig(dir, "echo", "{ greeting: hi }");
  write(dir, "cards/DEMO-1.card.md", card("DEMO-1"));
  const project = new Project(dir);
  const c = project.card("DEMO-1");
  const state = newState(c.id, "standard");
  const runDir = path.join(dir, ".mergewright", "runs", c.id);
  const ctx = { project, card: c, state, runDir, cwd: dir, base: "main", branch: "main", diffBase: "main", artifacts: artifactStore(runDir, state, () => undefined) };
  const values = await promptValues(ctx, "{{memory.recall}}", integrationsFor(project));
  assert.match(values["memory.recall"]!, /^- hi: recalled for Card DEMO-1$/m);
});

test("packages: a role may name a harness an installed package contributes; mw check accepts it and the run finds it", async () => {
  const dir = newProject();
  write(dir, "roles/helper.role.md", "---\nid: helper\ndescription: Helps.\nruns: echo\nmode: read\noutput: text\n---\n\nHelp.\n");
  assert.ok(codes(dir, "error").includes("role/schema"), "unknown before the package is installed");
  assert.match(mw(dir, ["check"]).out, /'runs' must be one of: claude, codex, local, shell, mock/);
  assert.equal(mw(dir, ["add", fixture("echo"), "--yes"]).code, 0);
  assert.deepEqual(codes(dir, "error"), []);
  const project = new Project(dir);
  const h = await harnessFor("echo", project);
  assert.equal((await h.run({ label: "1-x" } as never)).text, "echo harness ran 1-x");
});

test("packages: the engine gives a package harness no MCP servers, and turns what it throws into a failed result classified by the shared table", async () => {
  const dir = newProject();
  assert.equal(mw(dir, ["add", fixture("echo"), "--yes"]).code, 0);
  const h = await harnessFor("echo", new Project(dir));
  const mcp = { json: {}, codexArgs: [], codexEnv: {}, env: { DOCS_TOKEN: "s3cret" }, ids: ["docs"] };
  assert.equal((await h.run({ label: "1-x", mcp } as never)).text, "echo harness ran 1-x", "req.mcp is undefined for a package harness");
  const r = await h.run({ label: "1-y", prompt: "throw" } as never);
  assert.equal(r.ok, false);
  assert.equal(r.error, "harness 'echo' failed: the service answered 503 Service Unavailable");
  assert.equal(r.transient, true, "classified by the shared table");
});

test("packages: settings the manifest's schema refuses are a config/package error, and the package is not loaded", async () => {
  const dir = withPackages("echo");
  setPackageConfig(dir, "echo", "{ bogus: 1 }");
  assert.ok(codes(dir, "error").includes("config/package"));
  assert.match(mw(dir, ["check"]).out, /packages\.echo: .*unknown field 'bogus'/);
  const [l] = await loadPackages(new Project(dir));
  assert.match(l!.error!, /packages\.echo: /);
  // Enabled but not installed is reported too.
  setPackageConfig(dir, "ghost", "{}");
  assert.match(mw(dir, ["check"]).out, /package 'ghost' is enabled in mergewright\.yaml but not installed here \(run 'mw add ghost'\)/);
});

test("packages: a package's tool output has its declared secrets redacted, and host.env reads only declared ones", async () => {
  const dir = withPackages("echo");
  process.env.ECHO_FIXTURE_TOKEN = "echo-token-value-0123456789";
  try {
    const project = new Project(dir);
    const tool = (await packageTools(project)).find((t) => t.name === "mw_echo_token")!;
    assert.ok(tool, "the package's tool is registered");
    const r = await callTool(tool, {}, { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => {} });
    assert.equal(r.content[0]!.text, "the token is [redacted] and HOME is undefined");
  } finally {
    delete process.env.ECHO_FIXTURE_TOKEN;
  }
});

test("packages: mw <command> runs a command an enabled package provides", () => {
  const dir = withPackages("echo");
  const r = mw(dir, ["echo-hello", "big", "world"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "hello from demo: big world");
  assert.match(mw(dir, ["no-such-command"]).err, /unknown command 'no-such-command'/);
});
