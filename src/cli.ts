// The `mw` command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSea } from "node:sea";
import YAML from "yaml";
import { ackCard, assertCardReady, assertNewCardReady, cardLintReport, commitCardChange, newCard, setCardStatus, type NewCard } from "./cards.ts";
import { mirrorCardStatus, setAsideRun } from "./engine/run.ts";
import { check } from "./check.ts";
import { commands as engineCommands } from "./commands-engine.ts";
import { commands as docsCommands } from "./commands-docs.ts";
import { commands as mcpServerCommands } from "./commands-mcpserver.ts";
import { commands as tuiCommands } from "./commands-tui.ts";
import { commands as uiCommands } from "./commands-ui.ts";
import { commands as hubCommands } from "./commands-hub.ts";
import { commands as integrationCommands } from "./commands-integrations.ts";
import { describeCounts, describeDelivery, memoryServices, packageStore, pushMemory, searchRemoteLessons, storeMemory, type MemoryService } from "./integrations.ts";
import { commands as workCommands } from "./commands-work.ts";
import { commands as packageCommands, packageCommand } from "./packages/commands.ts";
import { MOVED_TO_OFFICIAL } from "./packages/registry.ts";
import { getConfig, setConfig } from "./config.ts";
import { formatDiagnostic } from "./diagnostics.ts";
import { eject } from "./eject.ts";
import { init } from "./init.ts";
import { addMcp, pairs, removeMcp } from "./mcpadd.ts";
import { mcpsForRole, wireMcps } from "./mcpconfig.ts";
import { gitIdentity, IDENTITY_FIX } from "./mcpserver/repo.ts";
import { addDecision, addLesson, renderIndex, searchMemory, setState, writeIndex } from "./memory.ts";
import { PACKAGE_ROOT, runtimeOrigin, SPEC_VERSION } from "./paths.ts";
import { Project } from "./project.ts";
import { acceptChange, loadChanges, proposeChange, rejectChange } from "./specchange.ts";
import { buildTrace, coverage } from "./trace.ts";
import { Diagnostics } from "./diagnostics.ts";
import { estimateTokens, markSecretEnv, MwError, readJson, readText, redactSecrets, slugify } from "./util.ts";

export interface Args {
  _: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** Flags that never take a value. Everything else takes the next token. */
const BOOLEAN = new Set(["json", "strict", "example", "dry-run", "all", "force", "help", "version", "watch", "offline", "text", "shared", "keep-lease", "no-docs", "no-open", "lessons", "decisions", "commit", "yes"]);

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let value: string | boolean;
    if (eq > 0) value = a.slice(eq + 1);
    else if (BOOLEAN.has(key)) value = true;
    else {
      const next = argv[i + 1];
      if (next === undefined) throw new MwError("usage", `--${key} needs a value`);
      value = next;
      i++;
    }
    const prev = out.flags[key];
    if (prev === undefined) out.flags[key] = value;
    else out.flags[key] = [...(Array.isArray(prev) ? prev : [String(prev)]), String(value)];
  }
  return out;
}

export const str = (a: Args, k: string): string | undefined => {
  const v = a.flags[k];
  return v === undefined || typeof v === "boolean" ? undefined : Array.isArray(v) ? v[v.length - 1] : v;
};
export const list = (a: Args, k: string): string[] => {
  const v = a.flags[k];
  if (v === undefined || typeof v === "boolean") return [];
  return (Array.isArray(v) ? v : [v]).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
};
export const many = (a: Args, k: string): string[] => {
  const v = a.flags[k];
  return v === undefined || typeof v === "boolean" ? [] : Array.isArray(v) ? v : [v];
};
export const need = (v: string | undefined, what: string): string => {
  if (!v) throw new MwError("usage", `missing ${what}`);
  return v;
};

/**
 * Only `mw sync` works offline. The commands that run or change cards do not take
 * `--offline`; passing it is a usage error that says where offline work is possible.
 */
export function refuseOffline(a: Args, command: string): void {
  if (a.flags.offline !== undefined) {
    throw new MwError("usage", `'mw ${command}' does not take --offline: only 'mw sync --offline' works without the hub. Run 'mw ${command}' without it (a project with a hub needs the hub to be reachable; one with git.hub set to none never contacts a hub anyway).`);
  }
}

export type Out = (line?: string) => void;
export type Handler = (a: Args, out: Out) => number | Promise<number>;

const HELP = `mw: MergeWright ${SPEC_VERSION}

Project
  mw init [dir] [--name N] [--prefix P] [--example]   make a folder a MergeWright project
  mw check [--strict] [--json]                        validate the project against the specification
  mw status [--json]                                  where every card is
  mw trace [--json]                                   requirement -> cards -> tests
  mw upgrade                                          migrate to this runtime's specification version

Work
  mw card new --title T [--kind K] [--implements REQ,..] [--scope glob,..] [--risk R] [--flow F]
              [--depends ID,..] [--why W] [--out-of-scope TEXT] [--acceptance TEXT]... [--tags a,b]
              [--status todo|ready] [--no-docs] [--commit]
                                                      (a given scope also gets docs.paths unless --no-docs;
                                                      --status ready only for a card that passes lint;
                                                      --commit commits the card file alone on the base branch
                                                      and pushes it to the hub, if there is one)
  mw card lint <ID> [--json]                          is the card ready to run? non-zero on any lint error; writes nothing
  mw card ack <ID>                                    record that a card was reviewed against changed requirements
  mw card status <ID> todo|ready [--commit]           move a card between todo and ready (a blocked run is aborted and
                                                      a blocked or aborted run's record moved aside first;
                                                      ready is refused for a card with lint errors; --commit
                                                      commits the card file as for mw card new)
  mw run <ID> [--approve go,merge] [--from PHASE] [--until PHASE] [--dry-run] [--keep-lease]
                                                      (releases the lease when it returns: run done, blocked, aborted
                                                      or waiting; unless --keep-lease or another run here needs it)
                                                      (Ctrl-C stops the current phase and exits with 130)
  mw retry <ID> [--from PHASE]                        put a blocked card back at a phase, for 'mw work' or 'mw run' to continue
  mw work [--approve go,merge] [--max N] [--watch] [--interval SECONDS]
                                                      run every ready card unattended, in id order
  mw work --dry-run                                   show which cards would run, and why the others would not
  mw approve <ID> <word> [--keep-lease]               answer a stop point, then continue the run (lease as for mw run)
  mw abort <ID> [--force]                             stop a run; its work stays on the branch and the worktree is moved to
                                                      .mergewright/local/discarded/ (--force also deletes the branch and takes
                                                      over a lease another machine holds; refused while a process in the
                                                      card's orphans record lives, which a plain abort reports)
  mw sync [--offline]                                 bring this checkout level with the hub
  mw lease [show|take [--force]|release]              which machine is driving this project

Managed updates
  mw memory show | index | search <words> [--limit N]
  mw memory add lesson --topic T --title T --body B [--card ID]      (owner)
  mw memory add decision --title T --body B [--card ID]              (owner)
                                                      (also stored in package memory stores such as mem0; queued if down)
  mw memory push [--lessons] [--decisions] [--service NAME]          (owner)
                                                      every lesson and decision file to the memory services
                                                      (idempotent: what a service already holds is not sent again)
  mw memory prune --service NAME --match TEXT [--dry-run]            (owner)
                                                      delete the service's records whose text contains TEXT
  mw memory state --file F                            replace STATE.md (also reads standard input)
  mw spec list | propose <spec> --summary S [--file F] [--by WHO] | accept <CHG> | reject <CHG> [--reason R]
  mw config get <key> | set <key> <value> | unset <key>

Services
  mw doctor                                           which integrations are configured and reachable
  mw queue [list|flush|adopt]                         deliveries waiting for a service that was down (adopt: move items
                                                      of the old shared .mergewright/queue/ in; run it on one machine only)
  mw docs search <words> [--text] [--limit N]         the documentation files, then the hits of packages that search
  mw <package> ...                                    a command an enabled package provides (see 'mw packages')

Building blocks
  mw roles | flows | gates | mcps                     list what the project and its preset define
  mw eject <role|flow|gate|mcp> <id>                  copy a preset file into the project to change it
  mw mcp add <id> (--command CMD [--arg A]... | --url URL) [--env K=V]... [--header K=V]...
             [--roles a,b|all] [--description D] [--force]
  mw mcp remove <id> | mw mcp show <role>
  mw mcp serve [--project DIR]                        run the MergeWright MCP server over stdio (for assistants and other MCP clients)

Packages (experimental)
  mw add <name | path> [--yes]                        install a package (an official one by name, or a folder) and enable it;
                                                      shows what it provides and asks first (--yes skips the question)
  mw remove <name>                                    remove an installed package and its settings
  mw packages                                         installed packages: version, enabled, load status

Assistants
  mw tui                                              terminal UI: board, approvals, packages, roles, models, config, MCP servers
  mw ui [--port N] [--no-open]                        the GUI in the browser: board, card runs, specs, search, packages
                                                      (127.0.0.1 only; port 7341 or a free one; prints the sign-in link)
`;

/**
 * Changes to protected parts of a project are the owner's. An agent inside a card run (the engine
 * sets MW_ROLE for it) is refused; it proposes instead, or reports in its handoff.
 */
function ownerOnly(what: string): void {
  if (process.env.MW_ROLE) throw new MwError("owner-only", `${what} is done by the owner, not from inside a card run (role '${process.env.MW_ROLE}'). Put what you need in your handoff.`);
}

/** After `mw memory add`: store the record in the configured memory services and say where it went. */
async function reportStored(project: Project, record: { topic: string; title: string; body: string; card?: string }, out: Out): Promise<void> {
  if (!memoryServices(project).length) return;
  out((await storeMemory(project, [record])).map(describeDelivery).join(", "));
}

function printDiagnostics(d: Diagnostics, out: Out, strict: boolean): number {
  for (const item of d.sorted()) out(formatDiagnostic(item));
  const errors = d.errors.length + (strict ? d.warnings.length : 0);
  const warnings = strict ? 0 : d.warnings.length;
  if (errors === 0 && warnings === 0) out("ok: the project conforms to MergeWright " + SPEC_VERSION);
  // Under --strict the warnings keep their "warning:" lines, and the summary says they count as errors.
  else if (strict) out(`${errors} error(s)${d.warnings.length ? ` (${d.warnings.length} of them warnings promoted by --strict)` : ""}`);
  else out(`${errors} error(s), ${warnings} warning(s)`);
  return errors ? 1 : 0;
}

export const handlers: Record<string, Handler> = {
  help: (_a, out) => { out(HELP); return 0; },
  version: (_a, out) => {
    const pkg = readJson<{ version: string }>(path.join(PACKAGE_ROOT, "package.json"));
    out(`mergewright ${pkg?.version ?? "?"} (specification ${SPEC_VERSION}), ${runtimeOrigin()}`);
    return 0;
  },

  init: (a, out) => {
    const r = init(a._[1] ?? ".", { name: str(a, "name"), prefix: str(a, "prefix"), example: a.flags.example === true });
    out(`MergeWright project '${r.name}' in ${r.root}: ${r.added.length} file(s) added (cards ${r.prefix}-n, base ${r.base}, hub ${r.hub})`);
    if (!r.isGit) out("note: this folder is not a git repository yet; run 'git init' before the first card");
    else {
      const id = gitIdentity(r.root);
      if (!id.ok) out(`note: git has no identity here (${id.why}), so runs and the MCP tools cannot commit; ${IDENTITY_FIX}`);
    }
    if (r.added.length) out("next: make gates/default.gate.sh run this project's real checks, then 'mw check'");
    return 0;
  },

  check: (a, out) => {
    const d = check(Project.load());
    if (a.flags.json) { out(JSON.stringify({ ok: d.errors.length === 0, diagnostics: d.sorted() }, null, 2)); return d.errors.length ? 1 : 0; }
    return printDiagnostics(d, out, a.flags.strict === true);
  },

  trace: (a, out) => {
    const project = Project.load();
    const t = buildTrace(project);
    if (a.flags.json) {
      out(JSON.stringify({
        requirements: t.rows.map((r) => ({ id: r.req.id, title: r.req.title, priority: r.req.priority, rev: r.req.rev, coverage: coverage(r), cards: r.cards.map((c) => ({ id: c.id, status: c.status })), tests: r.tests.map((x) => `${x.file}:${x.line}`) })),
        dangling: t.dangling,
      }, null, 2));
      return 0;
    }
    if (!t.rows.length) { out("no requirements yet (add a spec in specs/)"); return 0; }
    const w = Math.max(...t.rows.map((r) => r.req.id.length));
    for (const r of t.rows) {
      const cards = r.cards.map((c) => `${c.id}(${c.status})`).join(" ") || "-";
      const tests = r.tests.length ? `${r.tests.length} test${r.tests.length > 1 ? "s" : ""}` : "no test";
      out(`${r.req.id.padEnd(w)}  ${coverage(r).padEnd(10)} ${(r.req.priority ?? "?").padEnd(6)} ${cards}  ${tests}  ${r.req.title}`);
    }
    for (const x of t.dangling) out(`${x.file}:${x.line}: @req ${x.req} names a requirement that does not exist`);
    const n = (c: string) => t.rows.filter((r) => coverage(r) === c).length;
    out(`${t.rows.length} requirement(s): ${n("verified")} verified, ${n("built")} built without a test, ${n("planned")} planned, ${n("unplanned")} unplanned`);
    return 0;
  },

  card: async (a, out) => {
    const sub = a._[1];
    // REQ-config-001: every card subcommand but lint writes, so it needs the config as written.
    const project = sub === "lint" ? Project.load() : Project.loadRunnable();
    if (sub === "new") {
      const status = str(a, "status") as "todo" | "ready" | undefined;
      const input: NewCard = {
        title: need(str(a, "title"), "--title"), kind: str(a, "kind") as never, implements: list(a, "implements"),
        scope: list(a, "scope"), risk: str(a, "risk"), flow: str(a, "flow"), depends: list(a, "depends"), why: str(a, "why"),
        outOfScope: str(a, "out-of-scope"), acceptance: many(a, "acceptance"), tags: list(a, "tags"), status,
        withDocs: a.flags["no-docs"] !== true,
        requireImplements: true,
      };
      if (a.flags.commit !== true) {
        const id = newCard(project, input);
        out(`created cards/${id}.card.md (status ${status ?? "todo"})`);
        return 0;
      }
      // REQ-cards-006: refused (REQ-cards-003 lint included) before the lock, the lease or a sync; the
      // id is taken and the card checked again after the hub was adopted.
      assertNewCardReady(project, input);
      let id = "";
      const committed = await commitCardChange(project, {
        what: "a card", subject: () => `card: ${id} ${input.title.trim()}`,
        write: (now) => { id = newCard(now, input); return `cards/${id}.card.md`; },
      });
      out(`created cards/${id}.card.md (status ${status ?? "todo"})`);
      out(committed);
      return 0;
    }
    if (sub === "lint") {
      // REQ-cards-002: read-only, the same report as the MCP tool mw_card_lint; non-zero on any error.
      const r = cardLintReport(project, need(a._[2], "a card id"));
      if (a.flags.json) out(JSON.stringify(r, null, 2));
      else {
        for (const f of r.findings) out(`${f.severity} ${f.code}: ${f.message}`);
        const errors = r.findings.filter((f) => f.severity === "error").length;
        out(r.ok ? `${r.id} passes lint${r.findings.length ? ` (${r.findings.length} warning(s))` : ""}; it can be set ready.` : `${r.id} has ${errors} lint error(s); fix the card, then run 'mw card lint ${r.id}' again.`);
      }
      return r.ok ? 0 : 1;
    }
    if (sub === "ack") {
      ownerOnly("acknowledging a changed requirement");
      const id = need(a._[2], "a card id");
      const revs = ackCard(project, id);
      out(`${id}: now recorded against ${Object.entries(revs).map(([r, v]) => `${r} rev ${v}`).join(", ") || "no requirements"}`);
      return 0;
    }
    if (sub === "status") {
      ownerOnly("changing a card's status");
      const id = need(a._[2], "a card id");
      const status = need(a._[3], "the new status, todo or ready");
      if (status !== "todo" && status !== "ready") throw new MwError("card/status", `a card is set to todo or ready by hand, not '${status}' (the runtime moves the others)`);
      const settable = (p: Project) => {
        const card = p.card(id);
        if (card.status !== "todo" && card.status !== "ready") throw new MwError("card/status", `${card.id} is ${card.status}; only todo and ready cards can be set by hand (the runtime moves the others)`);
        // REQ-cards-003: only a lint-clean card becomes ready, refused before anything is written.
        if (status === "ready") assertCardReady(p, card, `${card.id} was not set ready`);
        return card;
      };
      const card = settable(project);
      if (a.flags.commit === true) {
        // REQ-cards-006: the same checks again once the hub was adopted, then the card file written and
        // committed alone, and only then the run set aside (still under the lock and the lease): a
        // refusal or a failed commit leaves the card file, the run and its worktree as they were.
        let from = card.status;
        const lines: string[] = [];
        const committed = await commitCardChange(project, {
          what: "a card status", file: card.file, subject: `card: ${card.id} ${status}`,
          before: (now) => { from = settable(now).status; },
          write: (now) => {
            if (from !== status) setCardStatus(now.abs(card.file), status);
            return card.file;
          },
          after: async (now) => {
            const aside = await setAsideRun(now, card.id);
            if (aside) lines.push(`${card.id}: ${aside}`);
          },
        });
        for (const l of lines) out(l);
        out(from === status ? `${card.id} is ${status}` : `${card.id}: ${from} -> ${status}`);
        out(committed);
        const note = await mirrorCardStatus(project, card.id, status);
        if (note) out(note);
        return 0;
      }
      // The card file, 'mw status' and the board must agree on one status.
      const aside = await setAsideRun(project, card.id);
      if (aside) out(`${card.id}: ${aside}`);
      if (card.status !== status) setCardStatus(project.abs(card.file), status);
      out(card.status === status ? `${card.id} is ${status}` : `${card.id}: ${card.status} -> ${status} (${card.file} is not committed; commit it so 'mw work' can merge the card later)`);
      const note = await mirrorCardStatus(project, card.id, status);
      if (note) out(note);
      return 0;
    }
    throw new MwError("usage", "use 'mw card new --title ...', 'mw card lint <ID> [--json]', 'mw card ack <ID>' or 'mw card status <ID> todo|ready [--commit]'");
  },

  memory: async (a, out) => {
    const sub = a._[1];
    const project = sub === "show" || sub === "search" ? Project.load() : Project.loadRunnable();
    if (sub === "index") { out(writeIndex(project) ? "memory/INDEX.md updated" : "memory/INDEX.md is up to date"); return 0; }
    if (sub === "show") {
      const parts = [project.readMemory("STATE.md"), project.readMemory("RULES.md"), project.readMemory("INDEX.md") || renderIndex(project)];
      out(parts.join("\n"));
      out(`-- always-loaded memory: about ${estimateTokens(parts.join("\n"))} tokens`);
      return 0;
    }
    if (sub === "search") {
      const query = a._.slice(2).join(" ");
      const limit = Number(str(a, "limit") ?? 5);
      const hits = searchMemory(project, query, limit);
      if (!hits.length) out("nothing in memory matches");
      for (const h of hits) out(`${h.file}: ${h.title}\n  ${h.text.split("\n")[0]}`);
      // The semantic stores of enabled packages, each labelled.
      if (query.trim()) {
        for (const r of await searchRemoteLessons(project, query, limit)) {
          if (r.error) out(`${r.name}: did not answer (${r.error})`);
          else if (!r.hits.length) out(`${r.name}: nothing matches`);
          else for (const h of r.hits) out(`${r.name}: ${h}`);
        }
      }
      return 0;
    }
    if (sub === "add" && a._[2] === "lesson") {
      // Agents report what they learned in their handoff; the reflection files it.
      ownerOnly("adding a lesson to memory");
      const lesson = { topic: slugify(need(str(a, "topic"), "--topic")), title: need(str(a, "title"), "--title").trim().replace(/\s+/g, " "), body: redactSecrets(need(str(a, "body"), "--body")).trim(), card: str(a, "card") };
      const r = addLesson(project, lesson);
      writeIndex(project);
      out(`lesson ${r}`);
      await reportStored(project, lesson, out);
      return 0;
    }
    if (sub === "add" && a._[2] === "decision") {
      ownerOnly("recording a decision in memory");
      const decision = { topic: "decision", title: need(str(a, "title"), "--title").trim().replace(/\s+/g, " "), body: redactSecrets(need(str(a, "body"), "--body")).trim(), card: str(a, "card") };
      const f = addDecision(project, decision);
      writeIndex(project);
      out(`created ${f}`);
      await reportStored(project, decision, out);
      return 0;
    }
    if (sub === "push") {
      ownerOnly("pushing memory to the memory services");
      const only = str(a, "service");
      if (only !== undefined && !memoryServices(project).includes(only)) throw new MwError("usage", "--service is an enabled package that provides a memory store (e.g. mem0, after 'mw add mem0')");
      const r = await pushMemory(project, { lessons: a.flags.lessons === true, decisions: a.flags.decisions === true, only: only as MemoryService | undefined });
      out(`${r.records} record(s) in memory/`);
      for (const d of r.deliveries) out(describeCounts(d));
      return r.deliveries.some((d) => d.failed) ? 1 : 0;
    }
    if (sub === "prune") {
      // Delete records from a semantic store by their text (leftovers of tests, wrong entries).
      ownerOnly("deleting records from a memory service");
      const service = str(a, "service") ?? "";
      const fromPackage = await packageStore(project, service);
      if (!fromPackage) throw new MwError("usage", "--service is an enabled package that provides a memory store (e.g. mem0, after 'mw add mem0')");
      const match = str(a, "match") ?? "";
      if (match.trim().length < 3) throw new MwError("usage", "--match needs the text (at least 3 characters) the records to delete contain");
      const dryRun = a.flags["dry-run"] === true;
      let hits: { id: string; text: string }[];
      try {
        if (!fromPackage.prune) throw new MwError(`${service}/no-prune`, `package '${service}' cannot delete records`);
        hits = await fromPackage.prune(match, { dryRun });
      } catch (e) {
        if (e instanceof MwError) throw e;
        throw new MwError(`${service}/failed`, `${service} did not answer: ${(e as Error).message}`);
      }
      const where = fromPackage.label;
      for (const h of hits) out(`${dryRun ? "would delete" : "deleted"} ${h.id}: ${h.text.replace(/\s+/g, " ").trim().slice(0, 120)}`);
      out(`${hits.length} record(s) containing '${match}' ${dryRun ? "would be deleted from" : "deleted from"} ${where}`);
      return 0;
    }
    if (sub === "state") {
      ownerOnly("replacing the project state");
      const file = str(a, "file");
      setState(project, file ? readText(file) : fs.readFileSync(0, "utf8"));
      out("memory/STATE.md replaced");
      return 0;
    }
    throw new MwError("usage", "use 'mw memory show|index|search|add lesson|add decision|state|push|prune'");
  },

  spec: (a, out) => {
    const sub = a._[1];
    const project = sub === "list" || sub === undefined ? Project.load() : Project.loadRunnable();
    if (sub === "list" || sub === undefined) {
      for (const s of project.specs()) out(`${s.id.padEnd(16)} ${s.status.padEnd(10)} ${s.requirements.length} requirement(s)  ${s.title}`);
      for (const c of loadChanges(project, new Diagnostics())) out(`${c.id.padEnd(16)} ${c.status.padEnd(10)} change to '${c.spec}': ${c.summary}`);
      return 0;
    }
    if (sub === "propose") {
      const file = str(a, "file");
      const rel = proposeChange(project, need(a._[2], "the spec id"), need(str(a, "summary"), "--summary"), file ? readText(file) : undefined, str(a, "by") ?? process.env.MW_ROLE);
      out(`created ${rel}${file ? "" : " (fill in its operations, then 'mw check')"}`);
      return 0;
    }
    if (sub === "accept") {
      const r = acceptChange(project, need(a._[2], "a change id"));
      out(`${r.specFile} updated: ${r.changed.map((c) => `${c.req} ${c.op === "add" ? "added" : c.op === "modify" ? `now rev ${c.rev}` : `deprecated (rev ${c.rev})`}`).join(", ")}`);
      if (r.stale.length) out(`stale cards to review: ${r.stale.join(", ")} (then 'mw card ack <ID>')`);
      return 0;
    }
    if (sub === "reject") {
      ownerOnly("rejecting a spec change");
      rejectChange(project, need(a._[2], "a change id"), str(a, "reason") ?? "");
      out(`${a._[2]} rejected`);
      return 0;
    }
    throw new MwError("usage", "use 'mw spec list|propose|accept|reject'");
  },

  config: (a, out) => {
    const project = Project.load();
    const sub = a._[1];
    const key = need(a._[2], "a config key, e.g. limits.rounds");
    if (sub === "get") {
      const v = getConfig(project, key);
      out(v === undefined ? "(not set)" : typeof v === "object" ? YAML.stringify(v).trimEnd() : String(v));
      return 0;
    }
    if (sub === "set") { ownerOnly("changing the project config"); setConfig(project, key, need(a._[3], "a value")); out(`${key} set`); return 0; }
    if (sub === "unset") { ownerOnly("changing the project config"); setConfig(project, key, undefined); out(`${key} removed`); return 0; }
    throw new MwError("usage", "use 'mw config get|set|unset <key> [value]'");
  },

  eject: (a, out) => {
    ownerOnly("copying a preset file into the project");
    const rel = eject(Project.loadRunnable(), need(a._[1], "what to eject (role, flow, gate or mcp)"), need(a._[2], "its id"));
    out(`copied to ${rel}; the project's copy now overrides the preset`);
    return 0;
  },

  roles: (_a, out) => {
    for (const r of Project.load().roles().values()) out(`${r.id.padEnd(14)} ${r.origin.padEnd(9)} ${r.runs.padEnd(7)} ${r.mode.padEnd(7)} ${(r.model ?? "-").padEnd(16)} -> ${r.output.padEnd(12)} ${r.description}`);
    return 0;
  },
  flows: (_a, out) => {
    for (const f of Project.load().flows().values()) out(`${f.id.padEnd(10)} ${f.origin.padEnd(9)} ${f.phases.map((p) => p.id).join(" > ")}`);
    return 0;
  },
  gates: (_a, out) => {
    const project = Project.load();
    for (const [id, file] of project.gates()) out(`${id.padEnd(10)} ${file.startsWith(project.root) ? project.rel(file) : `preset:${project.config.extends}`}`);
    return 0;
  },
  mcps: (_a, out) => {
    const all = [...Project.load().mcps().values()];
    if (!all.length) out("no MCP servers defined (add one with 'mw mcp add')");
    for (const m of all) out(`${m.id.padEnd(14)} ${m.origin.padEnd(9)} ${m.transport.padEnd(6)} ${m.enabled ? "" : "(disabled) "}roles: ${m.roles === "all" ? "all" : m.roles.join(",") || "(only roles that name it)"}  ${m.description}`);
    return 0;
  },

  mcp: (a, out) => {
    const sub = a._[1];
    if (sub === "list" || sub === undefined) return handlers.mcps!(a, out);
    if (sub === "serve") return mcpServerCommands["mcp-serve"]!(a, out);
    const project = sub === "show" ? Project.load() : Project.loadRunnable();
    if (sub === "add") {
      ownerOnly("adding an MCP server");
      const rel = addMcp(project, {
        id: need(a._[2], "an id for the server"), command: str(a, "command"), args: many(a, "arg"), url: str(a, "url"),
        env: pairs(many(a, "env"), "env"), headers: pairs(many(a, "header"), "header"), roles: list(a, "roles"),
        description: str(a, "description"), force: a.flags.force === true,
      });
      out(`created ${rel}`);
      return 0;
    }
    if (sub === "remove") {
      ownerOnly("removing an MCP server");
      out(`removed ${removeMcp(project, need(a._[2], "the server id"))}`);
      return 0;
    }
    if (sub === "show") {
      const role = project.roles().get(need(a._[2], "a role id"));
      if (!role) throw new MwError("mcp/unknown-role", `there is no role '${a._[2]}'`);
      const servers = mcpsForRole(project, role);
      if (!servers.length) { out(`role '${role.id}' gets no MCP servers`); return 0; }
      const w = wireMcps(servers);
      out(`role '${role.id}' (${role.runs}) gets: ${w.ids.join(", ")}`);
      // Every resolved env and header value is hidden: which of them is a credential is not ours to guess.
      const hidden = (o: unknown) => (o && typeof o === "object" ? Object.fromEntries(Object.keys(o).map((k) => [k, "<set>"])) : o);
      out(JSON.stringify(w.json, (k, v) => (k === "env" || k === "headers" ? hidden(v) : v), 2));
      return 0;
    }
    throw new MwError("usage", "use 'mw mcp add|remove|list|show'");
  },

  upgrade: (_a, out) => {
    const project = Project.load();
    if (project.config.version === SPEC_VERSION) { out(`already on specification ${SPEC_VERSION}; nothing to migrate`); return 0; }
    throw new MwError("upgrade", `this runtime has no migration from specification '${project.config.version}' to ${SPEC_VERSION}`);
  },

  ...engineCommands,
  ...hubCommands,
  ...integrationCommands,
  ...docsCommands,
  ...tuiCommands,
  ...uiCommands,
  ...workCommands,
  ...packageCommands,
};

/**
 * Secrets for integrations live in a per-machine file outside every repository and synced folder:
 * ~/.config/mergewright/env, lines of NAME=value. Variables already set in the environment win.
 */
export function loadEnvFile(file = process.env.MW_ENV_FILE ?? path.join(os.homedir(), ".config", "mergewright", "env")): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
    markSecretEnv(m[1]!);
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
}

export async function main(argv: string[], out: Out = (l = "") => console.log(l)): Promise<number> {
  try {
    loadEnvFile();
    const a = parseArgs(argv);
    if (a.flags.version) return await handlers.version!(a, out);
    const name = a._[0] ?? "help";
    if (a.flags.help || name === "help") return await handlers.help!(a, out);
    const h = Object.hasOwn(handlers, name) ? handlers[name] : await packageCommand(name);
    if (!h && Object.hasOwn(MOVED_TO_OFFICIAL, name)) {
      const pkg = MOVED_TO_OFFICIAL[name]!;
      // An invalid config enables no package: say that (REQ-config-001) rather than "install it".
      let invalid: unknown;
      try { Project.loadRunnable(); } catch (e) { invalid = e; }
      if (invalid instanceof MwError && invalid.code === "config/invalid") throw invalid;
      throw new MwError("usage", `'mw ${name}' is a command of the official package '${pkg}' now, which is not installed and enabled here; run 'mw add ${pkg}' to use it`);
    }
    if (!h) throw new MwError("usage", `unknown command '${name}' (see 'mw help')`);
    return await h(a, out);
  } catch (e) {
    if (e instanceof MwError) {
      console.error(`mw: ${e.message}`);
      return e.code === "usage" || e.code === "tui/no-tty" ? 2 : 1;
    }
    throw e;
  }
}

// Run when started as a script (not when imported, and not inside the single executable, which has its own entry).
if (!isSea() && process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  // No top-level await: the single-executable build bundles this file as CommonJS.
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
