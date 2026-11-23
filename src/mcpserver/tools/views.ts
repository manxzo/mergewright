// Tool group "views": read-only views a board needs beside the other groups: one file of a card's
// run folder, the installed packages and the project settings.
import { availablePackages, packageLine, packageList } from "../../packages/commands.ts";
import { CARD_ID } from "../../util.ts";
import { readRunFile, settingsData } from "../data.ts";
import { need, S, schema, withData, type ToolDef } from "../tool.ts";

export const tools: ToolDef[] = [
  {
    name: "mw_run_file",
    description: "One file of a card's run folder (.mergewright/runs/<ID>/), by the name mw_run_status lists under files: the brief, handoff, findings, adjudication, reflection and gate summary (<kind>.json), a gate step's log (gate-logs/...), what an agent was sent and answered (phases/...). Returns its text (at most 1 MB, credentials redacted). A name that leaves the run folder is refused. Read-only.",
    result: "RunFileData",
    inputSchema: schema({
      id: S.matching(CARD_ID, "card id, e.g. DEMO-3"),
      name: S.str("the file's path inside the run folder, e.g. brief.json or gate-logs/test.log"),
    }, ["id", "name"]),
    handler: (a, ctx) => {
      const project = ctx.project();
      const id = need(a, "id");
      project.card(id); // must exist
      const file = readRunFile(project, id, need(a, "name"));
      return withData("RunFileData", file.text, file);
    },
  },
  {
    name: "mw_packages",
    description: "The installed and enabled packages, as 'mw packages' lists them: version, enabled or not, whether it loaded (and what it provides) or why not; the data adds its description, the settings it still needs, the names of the environment variables it reads, its health checks as 'mw doctor' reports them (with checks=true), and the official packages that are not installed ('mw add <name>' installs one). Read-only.",
    result: "PackagesData",
    inputSchema: schema({ checks: S.bool("also run each loaded package's health checks, as 'mw doctor' does (a check may ask its service)") }),
    handler: async (a, ctx) => {
      const project = ctx.project();
      const list = await packageList(project, { checks: a.checks === true });
      return withData("PackagesData", list.length ? list.map(packageLine).join("\n") : "no packages installed ('mw add <name | path>' installs one)", { packages: list, available: availablePackages(project) });
    },
  },
  {
    name: "mw_settings",
    description: "The project settings a UI shows: name, card id prefix, base branch, default flow and risk, every flow with its phases and stop points, every role with its harness and model, the gate's required steps, docs.paths, the enabled packages, and the config's errors. Read-only.",
    result: "SettingsData",
    inputSchema: schema({}),
    handler: (_a, ctx) => {
      const data = settingsData(ctx.project());
      return withData("SettingsData", data, data);
    },
  },
];
