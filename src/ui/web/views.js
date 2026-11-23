// Specs and trace, search, packages and settings.
import { read } from "./api.js";
import { dl, h, mono } from "./dom.js";

const cardLink = (c) => h("a", { href: `#/card/${encodeURIComponent(c.id)}` }, mono(c.id), ` ${c.status}`);
const none = () => h("span", { class: "muted" }, "none");
const table = (cols, rows) => h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, cols.map((c) => h("th", { scope: "col" }, c)))), h("tbody", {}, rows)));

export async function renderSpecs() {
  const [list, trace] = await Promise.all([read("mw_spec_list"), read("mw_trace")]);
  const bySpec = new Map();
  for (const r of trace.requirements) {
    if (!bySpec.has(r.spec)) bySpec.set(r.spec, []);
    bySpec.get(r.spec).push(r);
  }
  return h("section", { "aria-labelledby": "specs-title" },
    h("h2", { id: "specs-title" }, "Specs and trace"),
    list.specs.length ? null : h("p", { class: "muted" }, "No specs yet: add one in specs/."),
    list.specs.map((s) => h("section", { class: "spec", "aria-labelledby": `spec-${s.id}` },
      h("h3", { id: `spec-${s.id}` }, s.title, " ", h("span", { class: "muted" }, `(${s.id}, ${s.status})`)),
      h("p", { class: "muted" }, mono(s.file)),
      table(["Requirement", "Title", "Priority", "Status", "Coverage", "Cards", "Tests"], (bySpec.get(s.id) ?? []).map((r) => h("tr", {},
        h("th", { scope: "row" }, mono(r.id), r.rev > 1 ? h("span", { class: "muted" }, ` rev ${r.rev}`) : null),
        h("td", {}, r.title),
        h("td", {}, r.priority ?? "?"),
        h("td", {}, r.status),
        h("td", {}, h("span", { class: `badge coverage-${r.coverage}` }, r.coverage)),
        h("td", {}, r.cards.length ? h("ul", { class: "plain" }, r.cards.map((c) => h("li", {}, cardLink(c)))) : none()),
        h("td", {}, r.tests.length ? h("details", {}, h("summary", {}, `${r.tests.length} test${r.tests.length > 1 ? "s" : ""}`), h("ul", { class: "plain" }, r.tests.map((t) => h("li", {}, mono(t))))) : none())))))),
    list.changes.length ? h("section", { "aria-labelledby": "changes-title" }, h("h3", { id: "changes-title" }, "Spec changes"),
      h("ul", {}, list.changes.map((c) => h("li", {}, mono(c.id), ` ${c.status}, to ${c.spec}: `, c.summary)))) : null,
    trace.dangling.length ? h("section", { "aria-labelledby": "dangling-title" }, h("h3", { id: "dangling-title" }, "References to no requirement"),
      h("ul", {}, trace.dangling.map((d) => h("li", {}, mono(`${d.file}:${d.line}`), " names ", mono(d.req))))) : null);
}

export async function renderSearch(parts) {
  const q = (parts[0] ?? "").trim();
  const box = h("input", { type: "search", id: "search-q", name: "q", value: q, "data-key": "search", "data-focus-first": !q, autocomplete: "off" });
  const form = h("form", { role: "search", class: "search", onsubmit: (e) => { e.preventDefault(); location.hash = `#/search/${encodeURIComponent(box.value.trim())}`; } },
    h("label", { for: "search-q" }, "Search memory and documentation"), h("div", { class: "row" }, box, h("button", { type: "submit" }, "Search")));
  const head = [h("h2", { id: "search-title" }, "Search"), form];
  if (!q) return h("section", { "aria-labelledby": "search-title" }, head);
  const [memory, docs] = await Promise.all([read("mw_memory_search", { query: q, limit: 10 }), read("mw_docs_search", { query: q, limit: 10 })]);
  const group = (label, data) => [
    h("section", { class: "results", "aria-labelledby": `res-${label}` }, h("h3", { id: `res-${label}` }, label, " ", h("span", { class: "count" }, `(${data.hits.length})`)),
      data.hits.length ? h("ol", { class: "hits" }, data.hits.map((x) => h("li", {}, h("p", {}, h("span", { class: "badge" }, label.toLowerCase()), " ", h("strong", {}, x.title), " ", mono(x.file)), h("p", { class: "pre-wrap excerpt" }, x.text.slice(0, 600))))) : h("p", { class: "muted" }, "Nothing matches.")),
    data.sources.map((s) => h("section", { class: "results", "aria-label": `${label}: ${s.name}` }, h("h3", {}, `${label}: ${s.name}`),
      s.error ? h("p", { class: "error-text" }, `${s.name} did not answer: ${s.error}`)
        : s.hits.length ? h("ol", { class: "hits" }, s.hits.map((x) => h("li", {}, h("span", { class: "badge" }, s.name), " ", h("span", { class: "pre-wrap" }, x)))) : h("p", { class: "muted" }, "Nothing matches."))),
  ];
  return h("section", { "aria-labelledby": "search-title" }, head, h("p", { class: "muted", "aria-live": "polite" }, `Results for “${q}”`), group("Memory", memory), group("Docs", docs));
}

export async function renderSettings(_parts, ui) {
  const [pk, s] = await Promise.all([read("mw_packages"), read("mw_settings")]);
  ui.settings = s;
  const yesNo = (b) => (b ? "yes" : "no");
  return h("section", { "aria-labelledby": "settings-title" },
    h("h2", { id: "settings-title" }, "Packages and settings"),
    h("section", { "aria-labelledby": "pk-title" }, h("h3", { id: "pk-title" }, "Packages"),
      pk.packages.length ? table(["Package", "Version", "Installed", "Enabled", "Loaded", "Provides", "Missing settings", "Secret variables"], pk.packages.map((p) => h("tr", {},
        h("th", { scope: "row" }, mono(p.name), p.description ? h("p", { class: "muted" }, p.description) : null),
        h("td", {}, p.version ?? "?"), h("td", {}, yesNo(p.installed)), h("td", {}, yesNo(p.enabled)),
        h("td", {}, p.loaded ? "loaded" : h("span", { class: "error-text" }, `not loaded${p.error ? `: ${p.error}` : ""}`)),
        h("td", {}, p.provides.join(", ") || none()),
        h("td", {}, p.missingSettings.length ? h("span", { class: "error-text" }, p.missingSettings.join(", ")) : none()),
        h("td", {}, p.secrets.length ? p.secrets.map((x) => mono(x)) : none()))))
        : h("p", { class: "muted" }, "No packages installed. 'mw add <name>' installs one.")),
    h("section", { "aria-labelledby": "proj-title" }, h("h3", { id: "proj-title" }, "Project"),
      h("p", { class: "muted" }, "Read-only here: change settings with 'mw config set' or 'mw tui'."),
      s.configErrors.length ? h("div", { class: "warning" }, h("p", {}, "mergewright.yaml has errors:"), h("ul", {}, s.configErrors.map((e) => h("li", { class: "pre-wrap" }, e)))) : null,
      dl([["Name", s.name], ["Description", s.description], ["Card prefix", mono(s.prefix)], ["Base branch", mono(s.base)], ["Default flow", s.defaultFlow], ["Default risk", s.defaultRisk],
        ["Gate requires", s.gate.required.join(", ")], ["Documentation paths", s.docsPaths.map((p) => mono(p))], ["Packages", s.packages.join(", ")]])),
    h("section", { "aria-labelledby": "flows-title" }, h("h3", { id: "flows-title" }, "Flows"),
      s.flows.map((f) => h("section", { class: "flow" }, h("h4", {}, mono(f.id), " ", h("span", { class: "muted" }, `(${f.origin})`)), f.description ? h("p", {}, f.description) : null,
        h("ol", { class: "phases" }, f.phases.map((p) => h("li", {}, mono(p.id), h("span", { class: "muted" }, ` ${p.kind} ${p.runs}`), p.stops.length ? ` stops: ${p.stops.join(", ")}` : null))),
        f.remediate ? h("p", { class: "muted" }, `Rejected work goes back to ${f.remediate}.`) : null))),
    h("section", { "aria-labelledby": "roles-title" }, h("h3", { id: "roles-title" }, "Roles"),
      table(["Role", "Harness", "Model", "Mode", "Output", "Description"], s.roles.map((r) => h("tr", {},
        h("th", { scope: "row" }, mono(r.id)), h("td", {}, r.harness), h("td", {}, r.model ?? "harness default"), h("td", {}, r.mode), h("td", {}, r.output), h("td", {}, r.description))))));
}
