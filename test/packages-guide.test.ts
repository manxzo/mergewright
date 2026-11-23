// The example package of docs/packages.md, taken from the guide's own code blocks: installed with
// `mw add <path> --yes` and exercised, so the guide's example works as written.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { integrationsFor } from "../src/integrations.ts";
import { packageTools } from "../src/mcpserver/server.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { Project } from "../src/project.ts";
import { mw, newProject, tmpDir, write } from "./helpers.ts";

const guide = fs.readFileSync(path.join(PACKAGE_ROOT, "docs", "packages.md"), "utf8");
/** The first fenced block of `lang` after the line naming `file`. */
function block(file: string, lang: string): string {
  const at = guide.indexOf(`\`hello/${file}\`:`);
  assert.ok(at >= 0, `the guide names hello/${file}`);
  const m = new RegExp("```" + lang + "\\n([\\s\\S]*?)```").exec(guide.slice(at));
  assert.ok(m, `a ${lang} block follows hello/${file}`);
  return m[1]!;
}

test("docs/packages.md: the example package installs, loads and does what the guide says", async () => {
  const pkg = path.join(tmpDir("mw-guide-"), "hello");
  write(pkg, "mergewright-package.yaml", block("mergewright-package.yaml", "yaml"));
  write(pkg, "index.mjs", block("index.mjs", "js"));
  const dir = newProject();
  const add = mw(dir, ["add", pkg, "--yes"]);
  assert.equal(add.code, 0, add.err);
  assert.match(add.out, /provides: commands, tools, checks, recall/);
  assert.equal(mw(dir, ["config", "set", "packages.hello.greeting", "Hi"]).code, 0);
  assert.equal(mw(dir, ["check"]).code, 0);

  const hello = mw(dir, ["hello", "Alice"]);
  assert.equal(hello.code, 0, hello.err);
  assert.equal(hello.out.trim(), "Hi, Alice!");
  assert.match(mw(dir, ["packages"]).out, /^hello +0\.1\.0 +enabled +loaded, provides commands, tools, checks, recall$/m);
  assert.match(mw(dir, ["doctor"]).out, /^hello +ok +HELLO_TOKEN NOT set \(package hello\)$/m);

  const project = new Project(dir);
  const tool = (await packageTools(project)).find((t) => t.name === "mw_hello");
  assert.ok(tool);
  assert.equal(await tool.handler({}, { project: () => project, root: dir, signal: new AbortController().signal, log: () => {} }), "Hi, demo!");
  write(dir, "docs/hello.md", "# Hello\n\nThe gate runs first.\n");
  assert.deepEqual(await integrationsFor(project).recall("gate", 3), ["hello.md: The gate runs first."]);

  const removed = mw(dir, ["remove", "hello"]);
  assert.equal(removed.code, 0, removed.err);
  assert.equal(fs.existsSync(path.join(dir, ".mergewright", "packages", "hello")), false);
});
