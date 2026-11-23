// The official cline-kanban package (packages/cline-kanban), installed with `mw add cline-kanban --yes`:
// what the package provides and the core command it replaced. The mirror itself, the reconcile, the
// queue, the doctor check and the tools are tested where they were before the port (integrations-services,
// regressions-mirror-usage, regressions-mcp-tools, regressions-queue-config, regressions-prompts-memory,
// integrations-core, mcpserver, req/engine).
import assert from "node:assert/strict";
import { test } from "node:test";
import { allTools } from "../src/mcpserver/server.ts";
import { projectWith } from "./fixtures/integrations/support.ts";
import { kanbanConfig, mw, newProject } from "./helpers.ts";

test("cline-kanban: 'mw cards mirror' points to the package's command; the board's tools come with the package, the writing ones marked", async () => {
  const r = mw(newProject(), ["cards", "mirror"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /'mw cards mirror' is a command of the board's package now; see 'mw packages'/);
  const { dir, project } = projectWith(kanbanConfig());
  const tools = (await allTools(project)).filter((t) => t.package === "cline-kanban").map((t) => [t.name, t.write === true]);
  assert.deepEqual(tools, [
    ["mw_kanban_list", false], ["mw_kanban_get", false], ["mw_kanban_create", true], ["mw_kanban_update", true],
    ["mw_kanban_done", true], ["mw_kanban_delete", true], ["mw_kanban_link", true], ["mw_kanban_start", true],
  ]);
  const p = mw(dir, ["packages"]);
  assert.match(p.out, /^cline-kanban +0\.1\.0 +enabled +loaded, provides mirrorCard, reconcile, deliverers, commands, tools, checks$/m);
});
