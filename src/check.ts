// `mw check`: is this project a conforming MergeWright project?
import fs from "node:fs";
import path from "node:path";
import { isProtectedGlob, NO_REQUIREMENT_MESSAGE, scopeCoversDocs } from "./cards.ts";
import { Diagnostics } from "./diagnostics.ts";
import { lineCount, renderIndex } from "./memory.ts";
import type { Project } from "./project.ts";
import { checkChange, loadChanges } from "./specchange.ts";
import { buildTrace, coverage } from "./trace.ts";
import { git, isSyncTemp, readIfExists } from "./util.ts";

/** File suffix each reserved folder expects; anything else in the folder is reported. */
const EXPECTED: Record<string, string[]> = {
  specs: [".spec.md"],
  cards: [".card.md"],
  roles: [".role.md"],
  flows: [".flow.yaml"],
  gates: [".gate.sh"],
  mcps: [".mcp.yaml"],
};
const ALLOWED_EXTRA = new Set(["README.md", ".gitkeep"]);

export function check(project: Project): Diagnostics {
  const d = project.diag;
  const cfg = project.config;
  const specs = project.specs();
  const cards = project.cards();
  const roles = project.roles();
  const flows = project.flows();
  const mcps = project.mcps();
  const gates = project.gates();
  const reqs = project.requirements();

  // Layout: stray files in reserved folders are almost always a misnamed file.
  for (const [dir, suffixes] of Object.entries(EXPECTED)) {
    let names: string[] = [];
    try { names = fs.readdirSync(project.abs(dir)); } catch { continue; }
    for (const n of names) {
      const full = project.abs(path.join(dir, n));
      if (fs.statSync(full).isDirectory()) continue; // e.g. specs/changes/
      if (isSyncTemp(n)) continue; // reported below when tracked, ignored otherwise
      if (ALLOWED_EXTRA.has(n) || suffixes.some((s) => n.endsWith(s))) continue;
      d.warn("layout/stray-file", `${dir}/${n}`, `files in ${dir}/ are named *${suffixes[0]}; this one is ignored`);
    }
  }
  for (const [dir, suffix] of [["specs/changes", ".change.md"], ["memory/lessons", ".md"], ["memory/decisions", ".md"], ["memory/outcomes", ".md"]] as const) {
    let names: string[] = [];
    try { names = fs.readdirSync(project.abs(dir)); } catch { continue; }
    for (const n of names) {
      if (ALLOWED_EXTRA.has(n) || isSyncTemp(n) || n.endsWith(suffix)) continue;
      d.warn("layout/stray-file", `${dir}/${n}`, `files in ${dir}/ are named *${suffix}; this one is ignored`);
    }
  }
  // Sync temporary and conflict files are never part of the project.
  const tracked = git(project.root, ["ls-files", "-z"], { allowFail: true });
  if (tracked.code === 0) {
    for (const f of tracked.stdout.split("\0").filter((x) => x && isSyncTemp(x))) {
      d.warn("sync/temp-file", f, "a sync temporary or conflict file is tracked by git; remove it ('git rm --cached') and keep '.*.tmp' and '*.sync-conflict-*' in .gitignore ('mw init' adds them)");
    }
  }
  if (!fs.existsSync(project.abs("AGENTS.md"))) d.warn("layout/agents", "AGENTS.md", "AGENTS.md is missing; agents read it first");

  // Specs
  const specIds = new Map<string, string>();
  const reqFiles = new Map<string, string>();
  for (const s of specs) {
    if (specIds.has(s.id)) d.error("spec/duplicate", s.file, `spec id '${s.id}' is also used by ${specIds.get(s.id)}`, 1);
    else specIds.set(s.id, s.file);
    for (const r of s.requirements) {
      const prev = reqFiles.get(r.id);
      if (prev && prev !== s.file) d.error("spec/duplicate-req", s.file, `${r.id} is also defined in ${prev}`, r.line);
      else reqFiles.set(r.id, s.file);
    }
  }

  // Flows: every role and gate a flow names must exist.
  for (const f of flows.values()) {
    for (const p of f.phases) {
      for (const roleId of [p.role, ...p.also.map((a) => a.role)]) {
        if (roleId && !roles.has(roleId)) d.error("flow/unknown-role", f.file, `phase '${p.id}' uses role '${roleId}', which does not exist`);
      }
      if (p.gate && !gates.has(p.gate)) d.error("flow/unknown-gate", f.file, `phase '${p.id}' uses gate '${p.gate}', which does not exist (expected gates/${p.gate}.gate.sh)`);
      const role = p.role ? roles.get(p.role) : undefined;
      if (p.action === "memory.update" && role && role.output !== "reflection") {
        d.error("flow/action-input", f.file, `phase '${p.id}': memory.update needs a role whose output is 'reflection' (role '${role.id}' outputs '${role.output}')`);
      }
      if (p.action === "memory.update" && !role) d.error("flow/action-input", f.file, `phase '${p.id}': memory.update needs a role that produces the reflection`);
      if (p.action === "merge" && !f.worktree) d.error("flow/merge", f.file, `phase '${p.id}' merges, but the flow has 'worktree: false' so there is no branch to merge`);
      for (const r of [p.role, ...p.also.map((a) => a.role)].map((id) => (id ? roles.get(id) : undefined))) {
        if (r?.mode === "write" && !f.worktree) d.error("flow/write", f.file, `phase '${p.id}' uses the writing role '${r.id}', but the flow has 'worktree: false'`);
      }
    }
  }

  // Roles and MCP servers
  for (const r of roles.values()) {
    for (const m of r.mcps) if (!mcps.has(m)) d.error("role/unknown-mcp", r.file, `role '${r.id}' uses mcp '${m}', which does not exist (expected mcps/${m}.mcp.yaml)`, 1);
  }
  for (const r of roles.values()) {
    // `local` and the harnesses packages provide are never given the project's MCP servers.
    if (r.runs !== "local" && !project.packageHarnesses.has(r.runs)) continue;
    const given = [...mcps.values()].filter((m) => m.enabled && (r.mcps.includes(m.id) || (m.roles !== "all" && m.roles.includes(r.id))));
    if (given.length) d.warn("role/mcp-unsupported", r.file, `role '${r.id}' runs on '${r.runs}', which cannot be given the project's MCP servers (${given.map((m) => m.id).join(", ")}); they are ignored for this role`, 1);
  }
  for (const m of mcps.values()) {
    if (m.roles !== "all") for (const r of m.roles) if (!roles.has(r)) d.error("mcp/unknown-role", m.file, `mcp '${m.id}' is offered to role '${r}', which does not exist`, 1);
  }
  for (const [id, file] of gates) {
    try { fs.accessSync(file, fs.constants.X_OK); } catch { d.error("gate/not-executable", file.startsWith(project.root) ? project.rel(file) : `preset gate ${id}`, "the gate is not executable (chmod +x)"); }
  }

  // Cards
  const byId = new Map<string, string>();
  for (const c of cards) {
    if (byId.has(c.id)) d.error("card/duplicate", c.file, `card id ${c.id} is also used by ${byId.get(c.id)}`, 1);
    else byId.set(c.id, c.file);
    if (!c.id.startsWith(`${cfg.cards.prefix}-`)) d.error("card/prefix", c.file, `card ids in this project start with ${cfg.cards.prefix}- (set by cards.prefix)`, 1);
    for (const id of c.implements) {
      const r = reqs.get(id);
      if (!r) d.error("card/unknown-requirement", c.file, `implements ${id}, which no spec defines`, 1);
      else {
        if (r.status === "deprecated" && c.status !== "done") d.warn("card/deprecated-requirement", c.file, `implements ${id}, which is deprecated`, 1);
        const known = c.revs[id] ?? 1;
        if (known < r.rev) d.warn("card/stale", c.file, `was written against ${id} rev ${known}; the requirement is now rev ${r.rev} (review the card, then 'mw card ack ${c.id}')`, 1);
      }
    }
    if (cfg.trace.requireImplements && c.kind === "feature" && c.implements.length === 0) {
      d.error("card/no-requirement", c.file, NO_REQUIREMENT_MESSAGE, 1);
    }
    for (const dep of c.depends) {
      if (dep === c.id) d.error("card/depends", c.file, "a card cannot depend on itself", 1);
      else if (!cards.some((x) => x.id === dep)) d.error("card/depends", c.file, `depends on ${dep}, which does not exist`, 1);
    }
    const flowId = project.flowFor(c);
    const flow = flows.get(flowId);
    if (!flow) d.error("card/unknown-flow", c.file, `uses flow '${flowId}', which does not exist`, 1);
    else if (c.status !== "done" && c.scope.length === 0 && flow.phases.some((p) => [p.role, ...p.also.map((a) => a.role)].some((id) => id && roles.get(id)?.mode === "write"))) {
      d.error("card/scope", c.file, `flow '${flowId}' changes files, so the card needs a 'scope:' list of paths it may write`, 1);
    }
    // The planner refuses a card whose documentation must change outside its scope (spec 4.2).
    const docs = cfg.docs.paths;
    if ((c.status === "todo" || c.status === "ready") && c.scope.length && docs.length && !scopeCoversDocs(c.scope, docs)) {
      d.warn("card/scope-docs", c.file, `the scope covers none of the documentation paths (${docs.join(", ")}), so the card cannot update the documentation its change makes stale; add the ones it may change to 'scope:' (or ignore this for a card that changes no documented behaviour)`, 1);
    }
    // A scope naming a protected path the card is not granted promises a change the
    // scope check refuses at the end of the run.
    if (c.status !== "done") {
      const refused = c.scope.filter((g) => isProtectedGlob(g, cfg.protected) && !isProtectedGlob(g, c.allowProtected));
      if (refused.length) d.warn("card/scope-protected", c.file, `the scope names protected path(s) (${refused.join(", ")}) the card is not granted, so a change to them is refused; remove them from 'scope:', or grant them with 'allow_protected:' (an owner's decision)`, 1);
    }
  }
  // Dependency cycles
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const cycle = [...trail.slice(trail.indexOf(id)), id];
      d.error("card/cycle", byId.get(id) ?? `cards/${id}.card.md`, `dependency cycle: ${cycle.join(" -> ")}`, 1);
      return;
    }
    state.set(id, 1);
    for (const dep of cards.find((c) => c.id === id)?.depends ?? []) if (byId.has(dep)) visit(dep, [...trail, id]);
    state.set(id, 2);
  };
  for (const c of cards) visit(c.id, []);

  // Memory
  for (const [name, cap] of [["STATE.md", cfg.memory.stateMaxLines], ["RULES.md", cfg.memory.rulesMaxLines]] as const) {
    const text = readIfExists(project.memoryFile(name));
    if (text === undefined) d.error("memory/missing", `memory/${name}`, `memory/${name} is missing`);
    else if (lineCount(text) > cap) d.error("memory/too-long", `memory/${name}`, `${lineCount(text)} lines; the cap is ${cap} because this file is loaded into every prompt`);
  }
  const index = readIfExists(project.memoryFile("INDEX.md"));
  if (index !== undefined && index !== renderIndex(project)) d.warn("memory/index-stale", "memory/INDEX.md", "the index does not match the files in memory/ (run 'mw memory index')");

  // Tracing
  const trace = buildTrace(project);
  for (const ref of trace.dangling) d.error("trace/unknown-requirement", ref.file, `@req ${ref.req}: no spec defines this requirement`, ref.line);
  if (cfg.trace.requireTests !== "none") {
    const levels = cfg.trace.requireTests === "must" ? ["must"] : ["must", "should"];
    for (const row of trace.rows) {
      if (coverage(row) === "built" && row.req.priority && levels.includes(row.req.priority)) {
        d.error("trace/untested", row.req.file, `${row.req.id} is implemented by a finished card (${row.cards.filter((c) => c.status === "done").map((c) => c.id).join(", ")}) but no test references it (add '@req ${row.req.id}' to a test)`, row.req.line);
      }
    }
  }
  // Spec change proposals
  for (const change of loadChanges(project, d)) if (change.status === "proposed") checkChange(project, change, d);
  return d;
}
