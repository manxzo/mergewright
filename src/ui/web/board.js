// The board (mw_status) and the new-card form (mw_card_new), and the card actions both views use.
import { call, read } from "./api.js";
import { dl, h, mono } from "./dom.js";

export const COLUMNS = [
  { id: "todo", name: "To do" },
  { id: "ready", name: "Ready" },
  { id: "running", name: "Running" },
  { id: "queued", name: "Queued" },
  { id: "waiting", name: "Waiting for you" },
  { id: "blocked", name: "Blocked" },
  { id: "done", name: "Done" },
];

/** The column a card is in: an aborted run is folded into Done, with its label saying so. */
const columnOf = (row) => (row.status === "aborted" ? "done" : row.status);

/** Lint refusals of "set ready", shown on the card until the next successful action. */
const lintShown = new Map();

/** What the owner is asked for, in words. */
export function askText(row) {
  if (row.status !== "waiting") return null;
  if (row.ask) return `Needs your approval: ${row.ask}`;
  if (row.reason === "usage") return "Paused for usage; it continues when usage allows";
  return row.reason ? `Waiting: ${row.reason}` : "Waiting";
}

function findings(list) {
  return h("ul", { class: "findings" }, list.map((f) => h("li", { class: f.severity }, h("strong", {}, f.severity === "error" ? "Error " : "Warning "), mono(f.code), ": ", f.message)));
}

/** The actions a card's status allows, as buttons (and the retry form). */
export function cardActions(row, ui) {
  const id = row.id;
  const out = [];
  const button = (label, key, busy, fn, cls = "") => h("button", { type: "button", class: cls, "data-key": `${key}:${id}`, onclick: (e) => ui.act(e.currentTarget, busy, fn) }, label);
  if (row.status === "todo") {
    out.push(button("Set ready", "ready", "Setting ready…", async () => {
      const r = await call("mw_card_set_status", { id, status: "ready" });
      if (r.isError && r.data && r.data.lint) lintShown.set(id, r.data.lint.findings);
      else if (!r.isError) lintShown.delete(id);
      return r;
    }));
  }
  if (row.status === "ready") {
    out.push(button("Start run", "run", "Starting…", () => call("mw_run_start", { id })));
    out.push(button("Back to to do", "todo", "Moving…", () => call("mw_card_set_status", { id, status: "todo" }), "quiet"));
  }
  if (row.status === "waiting" && row.ask) {
    out.push(button(`Approve ${row.ask}`, "approve", "Approving…", () => call("mw_approve", { id, word: row.ask }), "accent"));
  }
  if (row.status === "blocked" || row.status === "aborted") out.push(retryForm(row, ui));
  if (["running", "queued", "waiting", "blocked"].includes(row.status)) {
    out.push(button("Abort", "abort", "Aborting…", async () => {
      if (!window.confirm(`Abort the run of ${id}? Its work stays on its branch and its worktree is moved aside.`)) return null;
      return call("mw_abort", { id });
    }, "danger"));
  }
  return out.length ? h("div", { class: "actions" }, out) : null;
}

/** Retry, optionally from a phase of the card's flow. */
function retryForm(row, ui) {
  const flow = ui.settings?.flows.find((f) => f.id === row.flow);
  const selectId = `retry-from-${row.id}`;
  const runId = `retry-run-${row.id}`;
  const select = h("select", { id: selectId, name: "from", "data-key": `from:${row.id}` },
    h("option", { value: "" }, flow?.remediate ? `default (${flow.remediate})` : "default"),
    (flow?.phases ?? []).map((p) => h("option", { value: p.id }, p.id)));
  const run = h("input", { type: "checkbox", id: runId, name: "run", checked: true, "data-key": `retryrun:${row.id}` });
  const submit = h("button", { type: "submit", "data-key": `retry:${row.id}` }, "Retry");
  return h("form", {
    class: "retry",
    onsubmit: (e) => {
      e.preventDefault();
      const args = { id: row.id, ...(select.value ? { from: select.value } : {}), ...(run.checked ? { run: true } : {}) };
      ui.act(submit, "Retrying…", () => call("mw_retry", args));
    },
  }, h("label", { for: selectId }, "From phase"), select, h("span", { class: "check" }, run, h("label", { for: runId }, "and start the run")), submit);
}

/** One card on the board. */
function cardItem(row, ui) {
  const ask = askText(row);
  const lint = lintShown.get(row.id);
  return h("li", {},
    h("article", { class: `card${row.status === "waiting" ? " needs-owner" : ""}`, "aria-labelledby": `card-${row.id}` },
      h("h4", { id: `card-${row.id}` }, h("a", { href: `#/card/${encodeURIComponent(row.id)}`, "data-key": `open:${row.id}` }, mono(row.id), " ", row.title)),
      h("p", { class: "label" }, h("span", { class: `badge status-${row.status}` }, row.status), " ", row.label),
      ask ? h("p", { class: "ask" }, ask) : null,
      dl([["Risk", row.risk], ["Flow", row.flow], ["Phase", row.phase], ["Kind", row.kind]], "facts inline"),
      row.agents.length ? h("p", { class: "agents" }, h("span", { class: "visually-hidden" }, "Agents: "), row.agents.map((a) => `${a.role} ${a.harness}${a.model && a.model !== "default" ? `/${a.model}` : ""}`).join(", ")) : null,
      row.usage ? h("p", { class: "usage" }, h("span", { class: "visually-hidden" }, "Usage: "), row.usage.summary) : null,
      lint ? h("div", { class: "lint-refusal", role: "group", "aria-label": `Why ${row.id} was not set ready` }, h("p", {}, "Not set ready: fix these in the card file first."), findings(lint)) : null,
      cardActions(row, ui)));
}

export async function renderBoard(parts, ui) {
  const status = await read("mw_status");
  const only = COLUMNS.some((c) => c.id === parts[0]) ? parts[0] : "";
  const byColumn = new Map(COLUMNS.map((c) => [c.id, []]));
  for (const row of status.cards) byColumn.get(columnOf(row))?.push(row);
  const filterId = "board-filter";
  const filter = h("select", { id: filterId, "data-key": "filter", onchange: (e) => { location.hash = e.currentTarget.value ? `#/board/${e.currentTarget.value}` : "#/board"; } },
    h("option", { value: "" }, `All columns (${status.cards.length})`),
    COLUMNS.map((c) => h("option", { value: c.id, selected: c.id === only }, `${c.name} (${byColumn.get(c.id).length})`)));
  const waiting = byColumn.get("waiting").length;
  return h("section", { "aria-labelledby": "board-title" },
    h("div", { class: "view-head" },
      h("h2", { id: "board-title" }, "Board"),
      h("div", { class: "view-tools" },
        h("span", { class: "filter" }, h("label", { for: filterId }, "Show"), filter),
        h("a", { class: "button", href: "#/new" }, "New card"))),
    waiting ? h("p", { class: "ask banner" }, `${waiting} card${waiting > 1 ? "s" : ""} waiting for you.`) : null,
    status.configErrors.length ? h("div", { class: "warning", role: "group", "aria-label": "Configuration errors" },
      h("p", {}, "mergewright.yaml has errors; writing actions are refused until they are fixed:"),
      h("ul", {}, status.configErrors.map((e) => h("li", { class: "pre-wrap" }, e)))) : null,
    h("div", { class: `columns${only ? " single" : ""}` },
      COLUMNS.filter((c) => !only || c.id === only).map((c) => {
        const rows = byColumn.get(c.id);
        return h("section", { class: `column column-${c.id}`, "aria-labelledby": `col-${c.id}` },
          h("h3", { id: `col-${c.id}` }, c.name, " ", h("span", { class: "count" }, `(${rows.length})`)),
          rows.length ? h("ul", { class: "cards", role: "list" }, rows.map((r) => cardItem(r, ui))) : h("p", { class: "muted empty" }, "No cards"));
      })));
}

// ── New card ────────────────────────────────────────────────────────────────────────────────

const CARD_ID = /^[A-Z][A-Z0-9]{0,9}-[0-9]+$/;
const REQ_ID = /^REQ-[a-z][a-z0-9-]*-[0-9]{3,}$/;
const listOf = (v) => v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

export async function renderNewCard(_parts, ui) {
  const props = ui.tools.get("mw_card_new")?.inputSchema?.properties ?? {};
  const enumOf = (k, fallback) => props[k]?.enum ?? fallback;
  const flows = ui.settings?.flows ?? [];
  const field = (name, label, control, help) => {
    control.id = `new-${name}`;
    control.name = name;
    control.dataset.key = `new:${name}`;
    const helpId = help ? `new-${name}-help` : null;
    const errId = `new-${name}-error`;
    control.setAttribute("aria-describedby", [helpId, errId].filter(Boolean).join(" "));
    return h("div", { class: "field" }, h("label", { for: control.id }, label), help ? h("p", { class: "help", id: helpId }, help) : null, control, h("p", { class: "field-error", id: errId, hidden: true }));
  };
  const input = (attrs = {}) => h("input", { type: "text", autocomplete: "off", ...attrs });
  const select = (values, blank) => h("select", {}, blank ? h("option", { value: "" }, blank) : null, values.map((v) => h("option", { value: v }, v)));
  const result = h("div", { class: "form-result", "aria-live": "polite" });
  const form = h("form", { class: "new-card", novalidate: true },
    field("title", "Title (required)", input({ required: true, "data-focus-first": true }), "What the card delivers, in one line."),
    field("kind", "Kind", select(enumOf("kind", ["feature", "fix", "chore", "docs", "spike"]))),
    field("implements", "Implements", input(), "Requirement ids, separated by commas, e.g. REQ-auth-001. A feature card usually needs one."),
    field("scope", "Scope", input(), "Globs of the files it may change, separated by commas, e.g. src/auth/**."),
    field("risk", "Risk", select(enumOf("risk", ["low", "medium", "high", "critical"]), `project default (${ui.settings?.defaultRisk ?? "?"})`)),
    field("flow", "Flow", select(flows.map((f) => f.id), `project default (${ui.settings?.defaultFlow ?? "?"})`)),
    field("depends", "Depends on", input(), "Card ids that must be done first, separated by commas."),
    field("why", "Why", h("textarea", { rows: 3 }), "Why the work matters."),
    field("out_of_scope", "Out of scope", h("textarea", { rows: 2 }), "What the card must not touch; None when nothing needs saying. Needed to set it ready."),
    field("acceptance", "Acceptance", h("textarea", { rows: 3 }), "One criterion per line. Needed to set it ready."),
    field("tags", "Tags", input(), "Free labels, separated by commas."),
    field("status", "Status", select(enumOf("status", ["todo", "ready"]))),
    h("div", { class: "field check" }, h("input", { type: "checkbox", id: "new-no_docs", name: "no_docs", "data-key": "new:no_docs" }), h("label", { for: "new-no_docs" }, "Leave documentation out of the scope (only for a card that must not touch docs)")),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary", "data-key": "new:submit" }, "Create card"), h("a", { href: "#/board", class: "button quiet" }, "Cancel")),
    result);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = (name) => form.elements[name].value.trim();
    const errors = {};
    const args = { title: v("title") };
    if (!args.title) errors.title = "A title is required.";
    for (const k of ["kind", "risk", "flow", "status", "why", "out_of_scope"]) if (v(k)) args[k] = v(k);
    for (const k of ["implements", "scope", "depends", "tags"]) if (listOf(v(k)).length) args[k] = listOf(v(k));
    const acceptance = v("acceptance").split("\n").map((s) => s.trim()).filter(Boolean);
    if (acceptance.length) args.acceptance = acceptance;
    if (form.elements.no_docs.checked) args.no_docs = true;
    const bad = (k, re, what) => { const b = (args[k] ?? []).filter((x) => !re.test(x)); if (b.length) errors[k] = `${b.join(", ")} ${b.length > 1 ? "are" : "is"} not ${what}.`; };
    bad("implements", REQ_ID, "a requirement id like REQ-auth-001");
    bad("depends", CARD_ID, "a card id like DEMO-3");
    if (args.status === "ready" && (!args.out_of_scope || !args.acceptance)) errors.status = "A card created ready needs Out of scope and Acceptance filled in (or create it as todo).";
    for (const el of form.querySelectorAll(".field-error")) { el.hidden = true; el.textContent = ""; }
    for (const el of form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
    const names = Object.keys(errors);
    if (names.length) {
      for (const k of names) {
        const el = document.getElementById(`new-${k}-error`);
        el.textContent = errors[k];
        el.hidden = false;
        form.elements[k].setAttribute("aria-invalid", "true");
      }
      result.replaceChildren(h("p", { class: "error-text" }, `${names.length} field${names.length > 1 ? "s need" : " needs"} fixing.`));
      form.elements[names[0]].focus();
      return;
    }
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const r = await call("mw_card_new", args);
      if (r.isError) {
        result.replaceChildren(h("p", { class: "error-text pre-wrap" }, r.text), r.data?.lint ? findings(r.data.lint.findings) : null);
        result.querySelector("p").setAttribute("tabindex", "-1");
        result.querySelector("p").focus();
        return;
      }
      ui.notify(`Created ${r.data.card.id}: ${r.data.card.title}`);
      location.hash = `#/card/${encodeURIComponent(r.data.card.id)}`;
    } catch (err) {
      result.replaceChildren(h("p", { class: "error-text" }, err.message));
    } finally {
      submit.disabled = false;
    }
  });
  return h("section", { "aria-labelledby": "new-title" }, h("h2", { id: "new-title" }, "New card"), form);
}
