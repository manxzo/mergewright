// Documentation search (`mw docs search`, `mw_docs_search`): the files of docs.paths ranked with the
// memory search's keyword ranking, plus the hits of packages that search.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { searchDocFiles } from "../src/commands-docs.ts";
import { callTool, TOOLS } from "../src/mcpserver/server.ts";
import { Project } from "../src/project.ts";
import { git, mw, newProject, write } from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "packages");

function withDocs(): string {
  const dir = newProject();
  write(dir, "docs/guide.md", "# Retry guide\n\nHow retries work after a failed gate.\n");
  write(dir, "docs/notes.md", "Some notes\n\nA retry is sometimes needed.\n");
  write(dir, "docs/other.md", "# Other\n\nNothing about it.\n");
  write(dir, "src/retry.md", "# Retry outside docs.paths\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "docs");
  write(dir, "docs/untracked.md", "# Retry untracked\n");
  fs.symlinkSync(path.join(dir, "src", "retry.md"), path.join(dir, "docs", "link.md"));
  return dir;
}

test("docs search: tracked docs.paths files ranked like memory search, with path, heading or first line, and score", () => {
  const dir = withDocs();
  const hits = searchDocFiles(new Project(dir), "retry");
  assert.deepEqual(hits.map((h) => [h.file, h.title, h.score]), [["docs/guide.md", "Retry guide", 4], ["docs/notes.md", "Some notes", 1]]);
  assert.equal(hits[1]!.text, "A retry is sometimes needed.", "the first line that holds a query word");
  assert.deepEqual(searchDocFiles(new Project(dir), "the and"), [], "no keyword, no hits");
  const r = mw(dir, ["docs", "search", "retry", "--limit", "1"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "docs/guide.md: Retry guide (score 4)\n  # Retry guide");
  assert.match(mw(dir, ["docs", "search", "zebra"]).out, /nothing in the documentation matches/);
});

test("docs search: an enabled package's search hits are merged in, labelled with its name, in the CLI and the tool", async () => {
  const dir = withDocs();
  assert.equal(mw(dir, ["add", path.join(FIXTURES, "echo"), "--yes"]).code, 0);
  const r = mw(dir, ["docs", "search", "retry"]);
  assert.match(r.out, /^echo: echo: recalled for retry$/m);
  const tool = TOOLS.find((t) => t.name === "mw_docs_search")!;
  const res = await callTool(tool, { query: "retry" }, { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => {} });
  const doc = JSON.parse(res.content[0]!.text);
  assert.equal(doc.project[0].file, "docs/guide.md");
  assert.equal(doc.project[0].score, 4);
  assert.deepEqual(doc.echo, ["echo: recalled for retry"]);
});
