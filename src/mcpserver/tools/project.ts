// Tool group "project": owner-level operations for an assistant acting for the owner. Each
// calls the function the matching `mw` command uses.
import { check } from "../../check.ts";
import { doctor } from "../../commands-integrations.ts";
import { Diagnostics } from "../../diagnostics.ts";
import { REQ_ID, type Requirement } from "../../model/spec.ts";
import type { Project } from "../../project.ts";
import { MwError } from "../../util.ts";
import { loadChanges, proposeChange } from "../../specchange.ts";
import { buildTrace, coverage } from "../../trace.ts";
import { requirementData, roleData } from "../data.ts";
import type { TraceData } from "../results.ts";
import { need, S, schema, SLUG, str, strs, viaCli, withData, type ToolDef } from "../tool.ts";

/**
 * One requirement as the tools return it: what it asks for (its acceptance criteria,
 * in full) and the cards that implement it.
 */
export function requirementView(project: Project, r: Requirement): Record<string, unknown> {
  return {
    id: r.id, title: r.title, priority: r.priority ?? null, rev: r.rev, status: r.status, spec: r.specId, file: r.file,
    acceptance_criteria: r.criteria.map((c) => ({ id: c.id, text: c.text })),
    cards: project.cards().filter((c) => c.implements.includes(r.id)).map((c) => ({ id: c.id, title: c.title, status: c.status })),
  };
}

export const tools: ToolDef[] = [
  {
    name: "mw_check",
    description: "Validate the project against the MergeWright specification (same as 'mw check --json'): ok plus every diagnostic.",
    inputSchema: schema({}),
    handler: (_a, ctx) => {
      const d = check(ctx.project());
      return { ok: d.errors.length === 0, diagnostics: d.sorted() };
    },
  },
  {
    name: "mw_trace",
    result: "TraceData",
    description: "Requirement -> cards -> tests, with each requirement's coverage (unplanned, planned, built, verified, deprecated), and dangling @req references.",
    inputSchema: schema({}),
    handler: (_a, ctx) => {
      const t = buildTrace(ctx.project());
      const data: TraceData = {
        requirements: t.rows.map((r) => ({ id: r.req.id, title: r.req.title, priority: r.req.priority ?? null, rev: r.req.rev, status: r.req.status, spec: r.req.specId, coverage: coverage(r), cards: r.cards.map((c) => ({ id: c.id, title: c.title, status: c.status })), tests: r.tests.map((x) => `${x.file}:${x.line}`) })),
        dangling: t.dangling.map((d) => ({ req: d.req, file: d.file, line: d.line })),
      };
      return withData("TraceData", {
        requirements: t.rows.map((r) => ({ id: r.req.id, title: r.req.title, priority: r.req.priority, rev: r.req.rev, coverage: coverage(r), cards: r.cards.map((c) => ({ id: c.id, status: c.status })), tests: r.tests.map((x) => `${x.file}:${x.line}`) })),
        dangling: t.dangling,
      }, data);
    },
  },
  {
    name: "mw_doctor",
    description: "Which integrations (notify, usage guard, forge, sync folder, queue, and the checks of enabled packages) are configured and reachable. Shows key variable names only, never values.",
    inputSchema: schema({}),
    handler: async (_a, ctx) => {
      const lines: string[] = [];
      const code = await doctor((l = "") => lines.push(l), ctx.project());
      return `${lines.join("\n")}${code ? "\n(problems found)" : ""}`;
    },
  },
  {
    name: "mw_spec_list",
    result: "SpecListData",
    description: "The project's specs (id, status, requirement count, title) and spec change proposals (id, status, spec, summary).",
    inputSchema: schema({}),
    handler: (_a, ctx) => {
      const project = ctx.project();
      const changes = loadChanges(project, new Diagnostics()).map((c) => ({ id: c.id, status: c.status, spec: c.spec, summary: c.summary }));
      return withData("SpecListData", {
        specs: project.specs().map((s) => ({ id: s.id, status: s.status, title: s.title, requirements: s.requirements.map((r) => ({ id: r.id, title: r.title, priority: r.priority, rev: r.rev })) })),
        changes,
      }, {
        specs: project.specs().map((s) => ({ id: s.id, title: s.title, status: s.status, file: s.file, requirements: s.requirements.map((r) => ({ id: r.id, title: r.title, priority: r.priority ?? null, rev: r.rev, status: r.status })) })),
        changes,
      });
    },
  },
  {
    name: "mw_spec_get",
    result: "SpecData",
    description: "One spec: its id, title, status and file, and every requirement with its id, title, priority, rev, status, acceptance criteria (full text) and the cards implementing it. Read it before writing or readying a card.",
    inputSchema: schema({ id: S.matching(SLUG, "spec id, e.g. auth") }, ["id"]),
    handler: (a, ctx) => {
      const project = ctx.project();
      const id = need(a, "id");
      const spec = project.specs().find((s) => s.id === id);
      if (!spec) throw new MwError("spec/unknown", `no spec '${id}' (mw_spec_list lists them)`);
      return withData("SpecData", { id: spec.id, title: spec.title, status: spec.status, file: spec.file, requirements: spec.requirements.map((r) => requirementView(project, r)) },
        { id: spec.id, title: spec.title, status: spec.status, file: spec.file, requirements: spec.requirements.map((r) => requirementData(project, r)) });
    },
  },
  {
    name: "mw_req_get",
    result: "RequirementData",
    description: "One requirement (REQ id): title, priority, rev, status, its spec, its acceptance criteria (full text) and the cards implementing it. What a card that implements it must satisfy.",
    inputSchema: schema({ id: S.matching(REQ_ID, "requirement id, e.g. REQ-auth-001") }, ["id"]),
    handler: (a, ctx) => {
      const project = ctx.project();
      const id = need(a, "id");
      const r = project.requirements().get(id);
      if (!r) throw new MwError("spec/unknown-requirement", `${id} is not defined by any spec (mw_spec_list lists the requirements)`);
      return withData("RequirementData", requirementView(project, r), requirementData(project, r));
    },
  },
  {
    name: "mw_spec_propose",
    description: "Propose a change to a spec (specs are protected: they change only through accepted proposals). 'body' holds the operations ('## add', '## modify REQ-..', '## deprecate REQ-..' sections); without it a skeleton is written to fill in. The owner accepts with 'mw spec accept'.",
    write: true,
    locked: true,
    inputSchema: schema({ spec: S.matching(SLUG, "spec id"), summary: S.str("one-line summary"), body: S.str("the proposal's operations, Markdown"), by: S.str("who proposes (default assistant)") }, ["spec", "summary"]),
    handler: (a, ctx) => {
      const rel = proposeChange(ctx.project(), need(a, "spec"), need(a, "summary"), str(a, "body"), str(a, "by") ?? "assistant");
      return `created ${rel}${str(a, "body") ? "" : " (fill in its operations, then 'mw check')"}`;
    },
  },
  {
    name: "mw_roles",
    description: "Every role (project and preset): which harness runs it, model, provider, mode (advise/read/write), output kind and description. Role ids are what mw_delegate takes.",
    inputSchema: schema({}),
    result: "RolesData",
    handler: (_a, ctx) => {
      const roles = [...ctx.project().roles().values()];
      return withData("RolesData", roles.map((r) => ({ id: r.id, origin: r.origin, runs: r.runs, model: r.model, provider: r.provider, profile: r.profile, mode: r.mode, output: r.output, description: r.description })), { roles: roles.map(roleData) });
    },
  },
  {
    name: "mw_mcp_add",
    description: "Add an MCP server to the project (writes mcps/<id>.mcp.yaml, same as 'mw mcp add') with roles: [], so no role gets it yet: attaching it to a role is the owner's decision ('mw mcp add --roles', the TUI, or the file). A local server (command, args) or a remote one (url). env and headers values may be ${VAR} references; prefer those to literal secrets. Delegated runs (mw_delegate, mw_review) never get MCP servers.",
    write: true,
    locked: true,
    inputSchema: schema({
      id: S.matching(SLUG, "server id (lowercase slug)"),
      command: S.str("executable of a local (stdio) server"),
      args: S.list("its arguments"),
      url: S.str("URL of a remote (http) server"),
      env: S.map("environment for a local server, NAME: value"),
      headers: S.map("HTTP headers for a remote server, NAME: value"),
      description: S.str("one line"),
      force: S.bool("replace an existing file"),
    }, ["id"]),
    handler: async (a, ctx) => {
      const argv = ["mcp", "add", need(a, "id")];
      if (str(a, "command")) argv.push("--command", str(a, "command")!);
      for (const x of strs(a, "args")) argv.push(`--arg=${x}`);
      if (str(a, "url")) argv.push("--url", str(a, "url")!);
      for (const [flag, key] of [["env", "env"], ["header", "headers"]] as const) {
        const m = a[key];
        if (m && typeof m === "object") for (const [k, v] of Object.entries(m)) argv.push(`--${flag}=${k}=${String(v)}`);
      }
      if (str(a, "description")) argv.push("--description", str(a, "description")!);
      if (a.force === true) argv.push("--force");
      // Never --roles: which roles run a server is a separate trust decision the owner makes.
      const out = await viaCli(ctx.root, argv);
      return `${out}\nwritten with roles: [] (no role gets this server); attaching it to a role is the owner's decision (the TUI's MCPs screen, the roles: line of mcps/${need(a, "id")}.mcp.yaml, or 'mw mcp add ... --roles <ids> --force')`;
    },
  },
];
