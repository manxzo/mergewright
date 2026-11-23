// The official open-notebook package (packages/open-notebook), installed with `mw add open-notebook
// --yes`: the refusal of the old core setting, the commands that replace `mw docs sync|ask`, and its
// tools. Sync, search, queueing and the doctor check are tested where they were before the port
// (integrations-services, regressions-locks-merge, regressions-prompts-memory,
// regressions-memory-docs, integrations-core, mcpserver).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { allTools } from "../src/mcpserver/server.ts";
import { Project } from "../src/project.ts";
import { mockServer, projectWith } from "./fixtures/integrations/support.ts";
import { mw, MW, newProject, notebookConfig, write } from "./helpers.ts";

/** `mw` as a child process that does not block this one (the mock answers from here). */
function mwAsync(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, MW_ENV_FILE: "/dev/null" };
    delete env.MW_ROLE;
    const p = spawn(process.execPath, [MW, ...args], { cwd, env });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

test("open-notebook: the old core setting docs.notebook is refused by mw check, saying to run 'mw add open-notebook'", () => {
  const dir = newProject();
  write(dir, "mergewright.yaml", `${fs.readFileSync(path.join(dir, "mergewright.yaml"), "utf8").trimEnd()}\ndocs:\n  notebook:\n    url: http://127.0.0.1:1\n`);
  const r = mw(dir, ["check"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out + r.err, /'docs\.notebook' is no longer read: Open Notebook is now a package\. Run 'mw add open-notebook'/);
});

test("open-notebook: 'mw docs sync|ask' point to the package's commands; 'mw open-notebook ask' answers from the notebook; the tools come with the package", async () => {
  const dir = newProject();
  for (const sub of ["sync", "ask"]) {
    const r = mw(dir, ["docs", sub, "x"]);
    assert.equal(r.code, 2);
    assert.match(r.err, new RegExp(`'mw docs ${sub}' is a command of the documentation service's package now`));
  }
  const names = (await allTools(new Project(dir))).map((t) => t.name);
  assert.ok(!names.includes("mw_docs_ask") && !names.includes("mw_docs_sync"), "no package, no notebook tools");

  const nb = await mockServer((r) => {
    if (r.url === "/api/notebooks") return { body: [{ id: "notebook:1", name: "demo" }] };
    if (r.url === "/api/models/defaults") return { body: { default_chat_model: "model:1" } };
    if (r.url === "/api/search/ask/simple") return { body: { answer: `answer to: ${(r.body as { question: string }).question}` } };
    return undefined;
  });
  after(() => nb.close());
  const { dir: d2, project } = projectWith(notebookConfig({ url: nb.url }));
  const ask = await mwAsync(d2, ["open-notebook", "ask", "what", "is", "a", "lease?"]);
  assert.equal(ask.code, 0, ask.err);
  assert.equal(ask.out.trim(), "answer to: what is a lease?");
  const usage = await mwAsync(d2, ["open-notebook", "sync"]);
  assert.equal(usage.code, 2);
  assert.match(usage.err, /use 'mw open-notebook sync --all'/);
  const tools = (await allTools(project)).filter((t) => t.package === "open-notebook").map((t) => [t.name, t.write === true]);
  assert.deepEqual(tools, [["mw_docs_ask", false], ["mw_docs_sync", true]]);
});
