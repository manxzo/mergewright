// Tool group "cards": the project's cards through src/cards.ts and `mw status --json`.
import { assertCardReady, assertNewCardReady, cardLintReport, newCard, setCardStatus, type NewCard } from "../../cards.ts";
import { cardStatuses, mirrorCardStatus, setAsideRun } from "../../engine/run.ts";
import { loadState, runDir } from "../../engine/state.ts";
import type { CardKind } from "../../model/card.ts";
import type { Project } from "../../project.ts";
import { CARD_ID, MwError, readText } from "../../util.ts";
import { insideProject, writeAndCommit } from "../repo.ts";
import { requirementView } from "./project.ts";
import { cardData, cardRow, cardRowOf } from "../data.ts";
import { need, S, schema, SLUG, str, strs, withData, type Args, type ToolDef } from "../tool.ts";

const STATUSES = ["todo", "ready", "in_progress", "review", "blocked", "done"];

/** The card named by `id` (a card id, not a path) and its file's real path inside the project. */
function cardFile(project: Project, a: Args): { id: string; title: string; status: string; file: string; abs: string } {
  const id = need(a, "id");
  if (!CARD_ID.test(id)) throw new MwError("usage", `'${id}' is not a card id (like DEMO-3)`);
  const card = project.card(id);
  // A card whose file is not named after its id (say `cards/*.card.md`) is
  // refused before anything is read further or changed; its name could select other files.
  if (card.file.split("/").pop() !== `${card.id}.card.md`) {
    throw new MwError("card/file-mismatch", `card ${card.id} is in '${card.file}', not in a file named ${card.id}.card.md (check reports it as card/file-name); rename the file by hand first (nothing was changed)`);
  }
  return { id: card.id, title: card.title, status: card.status, file: card.file, abs: insideProject(project, card.file, "card/path") };
}

/** mw_card_new's arguments as newCard() takes them. */
function newCardInput(a: Args): NewCard {
  return {
    title: need(a, "title"), kind: str(a, "kind") as CardKind | undefined, implements: strs(a, "implements"), scope: strs(a, "scope"),
    risk: str(a, "risk"), flow: str(a, "flow"), depends: strs(a, "depends"), why: str(a, "why"),
    outOfScope: str(a, "out_of_scope"), acceptance: strs(a, "acceptance"),
    tags: strs(a, "tags"), status: str(a, "status") as "todo" | "ready" | undefined,
    withDocs: a.no_docs !== true,
    requireImplements: true,
  };
}

/** mw_card_set_status ready: the card as it is now must pass lint (REQ-cards-003). Writes nothing. */
function assertSetReady(project: Project, a: Args): void {
  const card = cardFile(project, a);
  if (need(a, "status") !== "ready" || (card.status !== "todo" && card.status !== "ready")) return;
  assertCardReady(project, project.card(card.id), `${card.id} was not set ready`);
}

export const tools: ToolDef[] = [
  {
    name: "mw_cards_list",
    description: "List the project's cards (id, title, kind, status, requirements, scope). Optionally only those with one status.",
    inputSchema: schema({ status: S.oneOf(STATUSES, "only cards with this status in their card file") }),
    handler: (a, ctx) => {
      const status = str(a, "status");
      return ctx.project().cards()
        .filter((c) => !status || c.status === status)
        .map((c) => ({ id: c.id, title: c.title, kind: c.kind, status: c.status, implements: c.implements, scope: c.scope, depends: c.depends }));
    },
  },
  {
    name: "mw_card_get",
    description: "One card: its file (front matter and body), the requirements it implements with their acceptance criteria (what the card must satisfy), and, when it has been run, where its run is.",
    result: "CardData",
    inputSchema: schema({ id: S.matching(CARD_ID, "card id, e.g. DEMO-3") }, ["id"]),
    handler: (a, ctx) => {
      const project = ctx.project();
      const card = cardFile(project, a);
      const state = loadState(runDir(project, card.id));
      const run = state ? { status: state.status, flow: state.flow, phase: project.flows().get(state.flow)?.phases[state.phase]?.id ?? "-", round: state.round, reason: state.reason, merged: state.merged } : undefined;
      // What the card must satisfy, so it can be checked before it is set ready.
      const reqs = project.requirements();
      const requirements = project.card(card.id).implements.map((rid) => {
        const r = reqs.get(rid);
        return r ? requirementView(project, r) : { id: rid, missing: "no spec defines this requirement" };
      });
      return withData("CardData", { id: card.id, file: card.file, text: readText(card.abs), requirements, run }, cardData(project, card.id));
    },
  },
  {
    name: "mw_card_new",
    description: "Create a card (status todo, or ready when status is 'ready') and commit its file alone ('card: <ID> <title>') on the base branch (on a project with a hub: under the lease, after adopting the hub, then pushed to it). Every change to the repository is made through a card: create it, check it with mw_card_lint, set it ready, then mw_run_start. A card created ready, or set ready, must pass lint (out_of_scope and acceptance fill the sections lint checks). A feature card must name its requirement in implements when the project requires it. The project's docs.paths are added to the scope; pass no_docs only for a card that must not touch documentation.",
    write: true,
    locked: true,
    result: "CardChangeData",
    inputSchema: schema({
      title: S.str("what the card delivers, one line"),
      kind: S.oneOf(["feature", "fix", "chore", "docs", "spike"], "default feature"),
      implements: S.list("requirement ids it implements, e.g. REQ-auth-001"),
      scope: S.list("globs of the files it may change, e.g. src/auth/**"),
      risk: S.oneOf(["low", "medium", "high", "critical"], "overrides the project default"),
      flow: S.matching(SLUG, "flow id (default: the project's default flow)"),
      depends: S.listOf(CARD_ID, "card ids that must be done first"),
      why: S.str("why the work matters (goes in the card body)"),
      out_of_scope: S.str("what the card must not touch (its '## Out of scope' section); 'None' when nothing needs saying"),
      acceptance: S.list("acceptance criteria, one per item (its '## Acceptance' section)"),
      tags: S.list("free labels for the card (frontmatter tags)"),
      status: S.oneOf(["todo", "ready"], "starting status (default todo; ready cards are picked up by 'mw work')"),
      no_docs: S.bool("only for a card that must NOT touch documentation: leaves the project's docs.paths out of the scope. By default never pass it: docs.paths are added so the card can update documentation with the change"),
    }, ["title"]),
    // REQ-cards-003: a card asked for ready is linted as it would be written before the transaction starts.
    precheck: (a, ctx) => {
      if (str(a, "status") === "ready") assertNewCardReady(ctx.project(), newCardInput(a));
    },
    handler: (a, ctx) => {
      const project = ctx.project();
      const title = need(a, "title");
      insideProject(project, "cards/x.card.md", "card/path");
      let id = "";
      // Branch, git identity and repository lock are checked before the card file is written; a
      // failed commit removes it again (spec section 12.5).
      const committed = writeAndCommit(project, { branchCode: "card/branch", what: "a card", files: [], subject: () => `card: ${id} ${title}` }, () => {
        id = newCard(project, newCardInput(a));
        return [`cards/${id}.card.md`];
      });
      const made = ctx.project().card(id);
      const next = made.status === "ready" ? `It is ready: mw_run_start ${id} (or 'mw work') runs it.` : `Review it, then mw_card_set_status ${id} ready and mw_run_start.`;
      return withData("CardChangeData", `created ${made.file} (status ${made.status})\n${committed}\n${next}`, { card: cardRowOf(ctx.project(), id) });
    },
  },
  {
    name: "mw_card_lint",
    description: "Lint a card: is it ready to run? Returns {id, ok, findings: [{code, severity, message}]}, the same as 'mw card lint <ID> --json'. ok is false when any finding is an error; such a card cannot be set ready. Read-only.",
    inputSchema: schema({ id: S.matching(CARD_ID, "card id, e.g. DEMO-3") }, ["id"]),
    // The card is found as 'mw card lint' finds it (Project.card()), so the two agree for any card,
    // even one whose file is not named after its id.
    result: "LintData",
    handler: (a, ctx) => {
      const report = cardLintReport(ctx.project(), need(a, "id"));
      return withData("LintData", report, report);
    },
  },
  {
    name: "mw_card_set_status",
    description: "Move a card between todo and ready (ready cards are picked up by 'mw work'; ready is refused for a card with lint errors, see mw_card_lint) and commit its file alone ('card: <ID> ready') on the base branch. A blocked run of the card is aborted first (its branch kept) and a blocked or aborted run's record is moved aside, so the card file, mw_status and the board agree. Other statuses belong to the runtime.",
    write: true,
    locked: true,
    result: "CardChangeData",
    inputSchema: schema({ id: S.matching(CARD_ID, "card id, e.g. DEMO-3"), status: S.oneOf(["todo", "ready"], "the new status") }, ["id", "status"]),
    precheck: (a, ctx) => assertSetReady(ctx.project(), a),
    handler: async (a, ctx) => {
      const project = ctx.project();
      const card = cardFile(project, a);
      const status = need(a, "status") as "todo" | "ready";
      if (card.status !== "todo" && card.status !== "ready") throw new MwError("card/status", `${card.id} is ${card.status}; only todo and ready cards can be set by hand (the runtime moves the others)`);
      // REQ-cards-003: only a lint-clean card becomes ready, refused before anything is written (the
      // precheck refused it before the transaction; this sees the card after any adoption of the hub).
      if (status === "ready") assertSetReady(project, a);
      // A blocked or aborted run would otherwise keep its own status beside the file's.
      const aside = await setAsideRun(project, card.id);
      const lines: string[] = aside ? [`${card.id}: ${aside}`] : [];
      const done = (text: string) => withData("CardChangeData", text, { card: cardRowOf(ctx.project(), card.id) });
      if (card.status === status) {
        if (aside) {
          const note = await mirrorCardStatus(project, card.id, status);
          return done([...lines, `${card.id} is ${status}`, ...(note ? [note] : [])].join("\n"));
        }
        return done(`${card.id} is already ${status}`);
      }
      const committed = writeAndCommit(project, { branchCode: "card/branch", what: "a card status", files: [card.file], subject: `card: ${card.id} ${status}` }, () => {
        setCardStatus(card.abs, status);
        return [card.file];
      });
      const note = await mirrorCardStatus(project, card.id, status);
      return done([...lines, `${card.id}: ${card.status} -> ${status}`, committed, ...(note ? [note] : [])].join("\n"));
    },
  },
  {
    name: "mw_status",
    result: "StatusData",
    description: "Where every card is: its run status (or card status when it has no run), flow, phase and the reason it waits or is blocked. Same as 'mw status --json'. When mergewright.yaml fails its schema, the answer is { config_errors, cards } instead: the errors as '<key path>: <message>' (writing tools refuse with config/invalid until it is fixed) and the same card list.",
    inputSchema: schema({}),
    handler: (_a, ctx) => {
      const project = ctx.project();
      const rows = cardStatuses(project);
      // REQ-config-002: answered from the tolerant load, with the config's errors when it has any.
      const configErrors = project.configErrors();
      const data = { cards: project.cards().map((c) => cardRow(project, c)), configErrors };
      return withData("StatusData", configErrors.length ? { config_errors: configErrors, cards: rows } : rows, data);
    },
  },
];
