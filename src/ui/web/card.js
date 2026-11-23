// Card detail (mw_card_get, mw_run_status) and the reader for one run file (mw_run_file).
import { read } from "./api.js";
import { askText, cardActions } from "./board.js";
import { bytes, dl, h, jsonView, mono } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

const md = (text, level) => h("div", { class: "md" }, renderMarkdown(text, document, level));
const cardLink = (id) => h("a", { href: `#/card/${encodeURIComponent(id)}` }, mono(id));
const codeList = (items) => (items.length ? h("ul", { class: "plain" }, items.map((s) => h("li", {}, mono(s)))) : h("p", { class: "muted" }, "none"));
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export async function renderCard(parts, ui) {
  const id = parts[0] ?? "";
  const fileName = parts[1] === "file" ? parts.slice(2).join("/") : null;
  const [card, run] = await Promise.all([read("mw_card_get", { id }), read("mw_run_status", { id, log_lines: 40 })]);
  const row = card.card;
  const ask = askText(row);
  return h("article", { class: "detail", "aria-labelledby": "card-title" },
    h("p", { class: "crumbs" }, h("a", { href: "#/board" }, "Board"), " / ", mono(row.id)),
    h("h2", { id: "card-title" }, mono(row.id), " ", row.title),
    h("p", { class: "label" }, h("span", { class: `badge status-${row.status}` }, row.status), " ", row.label),
    ask ? h("p", { class: "ask" }, ask) : null,
    cardActions(row, ui),
    fileName !== null ? await reader(id, fileName) : null,
    h("div", { class: "detail-grid" },
      h("div", { class: "detail-main" },
        h("section", { "aria-labelledby": "sec-card" }, h("h3", { id: "sec-card" }, "Card"),
          Object.keys(card.sections).length
            ? Object.entries(card.sections).map(([name, text]) => h("section", { class: "card-section" }, h("h4", {}, capital(name)), md(text, 5)))
            : md(card.body, 4)),
        runSection(run)),
      h("aside", { class: "detail-side", "aria-label": "Card facts" },
        h("section", {}, h("h3", {}, "Facts"), dl([["Kind", row.kind], ["Risk", row.risk], ["Flow", row.flow], ["Card file", mono(card.file)], ["Card status", row.cardStatus], ["Tags", card.tags.join(", ")]])),
        h("section", {}, h("h3", {}, "Scope"), codeList(card.scope)),
        h("section", {}, h("h3", {}, "Depends on"), card.depends.length ? h("ul", { class: "plain" }, card.depends.map((d) => h("li", {}, cardLink(d)))) : h("p", { class: "muted" }, "none")),
        h("section", {}, h("h3", {}, "Implements"),
          card.requirements.length || card.missingRequirements.length
            ? h("ul", { class: "plain" },
              card.requirements.map((r) => h("li", {}, h("details", {}, h("summary", {}, mono(r.id), " ", r.title), h("ol", { class: "criteria" }, r.acceptanceCriteria.map((c) => h("li", {}, h("strong", {}, `${c.id} `), c.text)))))),
              card.missingRequirements.map((r) => h("li", { class: "error-text" }, mono(r), " is not defined by any spec")))
            : h("p", { class: "muted" }, "none")),
        h("section", {}, h("h3", {}, "Documents to update"), codeList(card.docs)),
        h("section", {}, h("h3", {}, "Lint"),
          card.lint.ok && !card.lint.findings.length ? h("p", {}, "Passes lint.")
            : h("div", {}, h("p", {}, card.lint.ok ? "Passes lint, with warnings:" : "Lint errors: it cannot be set ready."),
              h("ul", { class: "findings" }, card.lint.findings.map((f) => h("li", { class: f.severity }, h("strong", {}, `${f.severity} `), mono(f.code), ": ", f.message))))))));
}

function runSection(run) {
  const head = h("h3", { id: "sec-run" }, "Run");
  if (!run.exists) return h("section", { "aria-labelledby": "sec-run" }, head, h("p", { class: "muted" }, "No run yet."));
  const phaseState = (p) => (p.current ? "now" : p.done ? "done" : "to do");
  return h("section", { "aria-labelledby": "sec-run" }, head,
    run.summary ? h("p", { class: "pre-wrap" }, run.summary) : null,
    dl([["Round", `${run.round} of at most ${run.maxRounds}`], ["Approvals given", run.approvals.join(", ")], ["Merged as", run.merged ? mono(run.merged) : null],
      ["Started", run.started], ["Updated", run.updated], ["Machine", run.host], ["Usage", run.card.usage?.summary]]),
    h("h4", {}, "Phases"),
    h("ol", { class: "phases" }, run.phases.map((p) => h("li", { class: `phase ${p.current ? "current" : p.done ? "done" : ""}`, "aria-current": p.current ? "step" : null },
      h("span", { class: "phase-state" }, phaseState(p)), " ", mono(p.id), h("span", { class: "muted" }, ` ${p.kind} ${p.runs}`),
      p.stops.length ? h("span", { class: "stops" }, ` stops: ${p.stops.join(", ")}`) : null))),
    run.conditions.length ? [h("h4", {}, "Conditions of approval"), h("ul", {}, run.conditions.map((c) => h("li", {}, h("strong", {}, c.what), ": ", c.how)))] : null,
    run.followUps.length ? [h("h4", {}, "Follow-ups"), h("ul", {}, run.followUps.map((f) => h("li", { class: "pre-wrap" }, f)))] : null,
    run.warnings.length ? [h("h4", {}, "Warnings"), h("ul", { class: "warning-list" }, run.warnings.map((w) => h("li", { class: "pre-wrap" }, w)))] : null,
    run.history.length ? [h("h4", {}, "History"), h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Phase", "Outcome", "Round", "Roles", "Seconds", "Detail"].map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", {}, run.history.map((x) => h("tr", {}, h("td", {}, mono(x.phase)), h("td", {}, x.outcome), h("td", {}, String(x.round)), h("td", {}, x.roles.map((r) => `${r}${x.harness[r] ? ` (${x.harness[r]}${x.model[r] ? `/${x.model[r]}` : ""})` : ""}`).join(", ")), h("td", {}, String(Math.round(x.seconds))), h("td", { class: "pre-wrap" }, x.detail))))))] : null,
    h("h4", {}, "Run files"),
    run.files.length ? h("ul", { class: "files" }, run.files.map((f) => h("li", {},
      h("a", { href: `#/card/${encodeURIComponent(run.id)}/file/${f.name.split("/").map(encodeURIComponent).join("/")}`, "data-key": `file:${f.name}` }, mono(f.name)),
      h("span", { class: "muted" }, ` ${f.kind}, ${bytes(f.size)}`)))) : h("p", { class: "muted" }, "none"),
    run.log ? h("details", { class: "log" }, h("summary", {}, "Background log (last lines)"), h("pre", {}, run.log)) : null);
}

/** One run file: JSON as a readable tree (with the raw text beside it), Markdown rendered, the rest as text. */
async function reader(id, name) {
  let body;
  let file = null;
  try {
    file = await read("mw_run_file", { id, name });
    if (file.json !== null && typeof file.json === "object") body = [jsonView(file.json), h("details", {}, h("summary", {}, "Raw JSON"), h("pre", {}, JSON.stringify(file.json, null, 2)))];
    else if (/\.md$/i.test(name)) body = h("div", { class: "md" }, renderMarkdown(file.text, document, 4));
    else body = h("pre", {}, file.text);
  } catch (e) {
    body = h("p", { class: "error-text pre-wrap" }, e.message);
  }
  return h("section", { class: "reader", "aria-labelledby": "reader-title" },
    h("div", { class: "view-head" }, h("h3", { id: "reader-title", "data-focus-first": true }, "Run file ", mono(name)), h("a", { class: "button quiet", href: `#/card/${encodeURIComponent(id)}` }, "Close file")),
    file ? h("p", { class: "muted" }, `${file.kind}, ${bytes(file.size)}${file.truncated ? "; only the first 1 MB is shown" : ""}`) : null,
    h("div", { class: "reader-body" }, body));
}
