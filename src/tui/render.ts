// State -> lines of plain text (deterministic; no escape codes). `paint` adds the colours afterwards,
// so snapshots stay readable.
import { redactUrl } from "../integrations/common.ts";
import { MODELS } from "./catalog.ts";
import type { CardRow } from "../mcpserver/results.ts";
import { approvalRows, columnRows, COLUMNS, currentCard, detailFields, editorEntries, MODEL_HARNESSES, SCREENS, staged, type State } from "./model.ts";

const SEL = "▸ ";
const NOSEL = "  ";

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = [...text];
  if (chars.length > width) return chars.slice(0, Math.max(0, width - 1)).join("") + "…";
  return text + " ".repeat(width - chars.length);
}

/** Word-wrap one paragraph to `width`, keeping its indentation; continuation lines are indented two more. */
function wrap(text: string, width: number): string[] {
  if (width < 8 || [...text].length <= width) return [text];
  const indent = /^\s*/.exec(text)![0];
  const out: string[] = [];
  let line = indent;
  for (const word of text.trim().split(/ +/)) {
    if (line.trim() && [...line].length + 1 + [...word].length > width) { out.push(line); line = `${indent}  `; }
    line += (line.trim() ? " " : "") + word;
  }
  if (line.trim()) out.push(line);
  return out;
}

/** Hide everything after '=' in each NAME=value item: env and header values are never shown. */
export function maskPairs(text: string): string {
  return text.split(",").map((item) => {
    const i = item.indexOf("=");
    return i < 0 ? item : `${item.slice(0, i)}=•••`;
  }).join(",");
}

/** A config value as shown: a URL without user, password or query string. */
const shown = (v: string) => (/^\w+:\/\//.test(v) ? redactUrl(v) : v);

interface Panes {
  left: string[];
  right: string[];
  /** A line between the header and the panes (the board's columns and counts). */
  strip?: string;
}

function overview(s: State): Panes {
  const d = s.data;
  const left = d.cards.map(([st, n], i) => `${i === s.sel.overview ? SEL : NOSEL}${st.padEnd(12)}${String(n).padStart(4)}`);
  const right = [`project   ${d.name}`, `spec      ${d.spec}`, `root      ${d.root}`, "", "services (p probes, as 'mw doctor'; settings on Config):"];
  for (const [id, title] of [["local", "Local models"], ["report", "Report"]] as const) right.push(`  ${title.padEnd(14)}${s.probes[id]?.state ?? "not probed yet"}`);
  const waiting = approvalRows(s).length;
  if (waiting) right.push("", `${waiting} card${waiting > 1 ? "s" : ""} waiting for you (Approvals).`);
  const total = d.cards.reduce((n, [, c]) => n + c, 0);
  right.push("", `cards     ${total} in all`);
  if (d.problems.length) right.push("", `${d.problems.length} problem(s) loading the project ('mw check'):`, ...d.problems.slice(0, 4).map((p) => `  ${p}`));
  return { left, right };
}

function roles(s: State): Panes {
  const left = s.data.roles.map((r, i) => {
    const mark = s.pending.some((p) => p.kind === "save" && p.key.startsWith(`roles.${r.id}.`)) ? "*" : " ";
    return `${i === s.sel.roles ? SEL : NOSEL}${r.id.padEnd(14)}${mark}${r.runs}`;
  });
  const r = s.data.roles[s.sel.roles];
  if (!r) return { left: ["  (no roles)"], right: [] };
  const right = [`${r.id}  (${r.origin === "project" ? "project" : `preset ${r.origin}`})`, ...wrap(r.description, 50), ""];
  detailFields(s).forEach((f, i) => {
    const cursor = s.focus === "detail" && i === s.field ? SEL : NOSEL;
    const pend = staged(s, f.key) !== undefined ? "  * unsaved" : r.overrides.includes(f.label) ? "  (mergewright.yaml)" : "";
    right.push(`${cursor}${f.label.padEnd(10)}${f.value ?? "-"}${pend}`);
  });
  right.push(`  ${"mode".padEnd(10)}${r.mode}`, `  ${"output".padEnd(10)}${r.output}`, "");
  right.push(s.focus === "detail" ? "Enter picks a value for the field" : "Enter edits the fields; e ejects the role file");
  return { left, right };
}

function models(s: State): Panes {
  const left = MODEL_HARNESSES.map((h, i) => `${i === s.sel.models ? SEL : NOSEL}${h}`);
  const h = MODEL_HARNESSES[s.sel.models] ?? "claude";
  const right = [`${h}: models the picker offers (free text is always allowed)`, ""];
  if (h === "local") {
    const live = s.live;
    right.push(`endpoint: ${s.data.localEndpoint ? redactUrl(s.data.localEndpoint) : "(local_models.endpoint not set)"}`);
    if (live?.models) right.push(`live list from ${redactUrl(live.endpoint)}/models:`, ...live.models.map((m) => `  ${m}`));
    else {
      right.push(live?.error ? `not reachable (${live.error}); fallback list:` : "not asked yet (p asks); fallback list:");
      right.push(...MODELS.local!.map((m) => `  ${m}`));
    }
  } else right.push(...(MODELS[h] ?? []).map((m) => `  ${m}`));
  return { left, right };
}

function config(s: State): Panes {
  const left = s.data.config.map((c, i) => `${i === s.sel.config ? SEL : NOSEL}${staged(s, c.key) !== undefined ? "*" : ""}${c.key}`);
  const c = s.data.config[s.sel.config];
  if (!c) return { left, right: [] };
  const st = staged(s, c.key);
  const right = [c.key, "", `value     ${c.value !== undefined ? shown(c.value) : `(default) ${shown(c.effective)}`}`];
  if (st !== undefined) right.push(`unsaved   ${shown(st)}`);
  right.push(`type      ${c.type}`);
  if (c.description) right.push("", ...wrap(c.description, 50));
  right.push("", "Enter edits; the value is YAML ([a, b] for a list)");
  return { left, right };
}

function packages(s: State): Panes {
  const pk = s.packages;
  if (!pk) return { left: ["  (loading)"], right: ["reading the packages and running their checks (as 'mw doctor')..."] };
  const rows = [...pk.packages.map((p) => ({ name: p.name, note: p.version ?? "?" })), ...pk.available.map((a) => ({ name: a.name, note: "available" }))];
  const left = rows.map((r, i) => `${i === s.sel.packages ? SEL : NOSEL}${r.name.padEnd(14)}${r.note}`);
  if (!left.length) left.push("  (none)");
  const p = pk.packages[s.sel.packages];
  if (p) {
    const state = !p.enabled ? "installed, not enabled" : p.error ? `NOT loaded: ${p.error}` : "enabled, loaded";
    const right = [`${p.name} ${p.version ?? "?"}`, ...(p.description ? wrap(p.description, 50) : []), "", `status    ${state}`, `exports   ${p.provides.join(", ") || "-"}`];
    if (p.missingSettings.length) right.push(`missing   packages.${p.name}.${p.missingSettings.join(", ")}`);
    right.push(`secrets   ${p.secrets.join(", ") || "-"}  (names only)`, "", "health (as 'mw doctor'; p runs it again):");
    if (!p.checks) right.push("  not run");
    else if (!p.checks.length) right.push(p.loaded ? "  it provides no checks" : "  not loaded, so no checks ran");
    else right.push(...p.checks.map((c) => `  ${c.name.padEnd(12)}${c.ok ? "ok" : "NOT ok"}  ${c.detail}`));
    right.push(...p.notes.map((n) => `note: ${n}`), "", `'mw remove ${p.name}' removes it.`);
    return { left, right };
  }
  const a = pk.available[s.sel.packages - pk.packages.length];
  if (!a) return { left, right: ["no packages installed, and no official package left to install"] };
  return {
    left,
    right: [`${a.name} ${a.version}  (official, not installed)`, ...wrap(a.description, 50), "", `exports   ${a.exports.join(", ") || "-"}`, "",
      "To install it, run in a terminal:", "", `  mw add ${a.name}`, "", "It shows the source and what the package provides, and asks before it installs (a package runs with your rights)."],
  };
}

/** The facts of one card, as the board shows them. */
function cardLines(r: CardRow): string[] {
  const out = [`${r.id}  ${r.title}`, `status  ${r.label === r.status ? r.status : `${r.status}: ${r.label}`}`];
  if (r.status === "waiting") out.push(r.ask ? `Needs your approval: ${r.ask}` : r.reason === "usage" ? "Paused for usage; it continues when usage allows" : `Waiting: ${r.reason ?? ""}`);
  out.push(`kind ${r.kind} · risk ${r.risk} · flow ${r.flow}${r.phase ? ` · phase ${r.phase}` : ""}`);
  if (r.agents.length) out.push(`agents  ${r.agents.map((a) => `${a.role} ${a.harness}${a.model && a.model !== "default" ? `/${a.model}` : ""}`).join(", ")}`);
  if (r.usage) out.push(`usage   ${r.usage.summary}`);
  return out;
}

/** What the keys do to this card (the GUI's buttons). */
function cardKeys(r: CardRow): string {
  const k = [r.status === "todo" ? "r sets it ready" : "", r.ask ? `a approves '${r.ask}' (asks first)` : "", r.status === "blocked" || r.status === "aborted" ? "R retries (asks first)" : ""].filter(Boolean);
  return k.length ? k.join("; ") : "";
}

/** The opened card: its facts, its sections (the brief), its run and the run's files. */
function detailLines(s: State): string[] {
  const d = s.detail!;
  const row = currentCard(s);
  const out = row ? cardLines(row) : [d.id];
  if (row && cardKeys(row)) out.push(cardKeys(row));
  if (!d.card) return [...out, "", "loading..."];
  const c = d.card;
  out.push("", `file    ${c.file}`, `scope   ${c.scope.join(", ") || "-"}`, `depends ${c.depends.join(", ") || "-"}`, `implements ${c.implements.join(", ") || "-"}`);
  if (!c.lint.ok) out.push(`lint    ${c.lint.findings.filter((f) => f.severity === "error").length} error(s): it cannot be set ready`);
  const sections = Object.entries(c.sections);
  for (const [name, text] of sections.length ? sections : [["card", c.body] as [string, string]]) out.push("", `── ${name}`, ...text.split("\n").filter((l) => l.trim()));
  const run = d.run;
  out.push("", "── run");
  if (!run) out.push("loading...");
  else if (!run.exists) out.push("No run yet.");
  else {
    if (run.summary) out.push(...run.summary.split("\n"));
    out.push(`round ${run.round} of at most ${run.maxRounds}; approvals given: ${run.approvals.join(", ") || "none"}${run.merged ? `; merged as ${run.merged}` : ""}`);
    out.push(`phases  ${run.phases.map((p) => `${p.current ? "▸" : p.done ? "✓" : "·"}${p.id}`).join(" ")}`);
    if (run.conditions.length) out.push("conditions of approval:", ...run.conditions.map((x) => `  ${x.what}: ${x.how}`));
    if (run.warnings.length) out.push("warnings:", ...run.warnings.map((w) => `  ${w}`));
    out.push("", "run files:", ...(run.files.length ? run.files.map((f) => `  ${f.name}  ${f.kind}, ${f.size} B`) : ["  none"]));
  }
  return out;
}

function board(s: State): Panes {
  // Seven columns do not fit side by side in 80 columns: one column at a time, all counts on the strip.
  const strip = COLUMNS.map((c, i) => (i === s.col ? `[${c.name} ${columnRows(s, i).length}]` : `${c.name} ${columnRows(s, i).length}`)).join(" ");
  if (!s.board) return { left: ["  (loading)"], right: ["reading the board (mw status)..."], strip };
  const rows = columnRows(s, s.col);
  const left = rows.map((r, i) => `${i === s.sel.board ? SEL : NOSEL}${r.id} ${r.title}`);
  if (!left.length) left.push("  No cards");
  if (s.detail) return { left, right: detailLines(s), strip };
  const r = rows[s.sel.board];
  const right = r ? [...cardLines(r), "", cardKeys(r) || "nothing to do here for now", "Enter opens the card"] : [`No cards in ${COLUMNS[s.col]!.name}; ← → change column`];
  if (s.board.configErrors.length) right.push("", "mergewright.yaml has errors; writing actions are refused until they are fixed:", ...s.board.configErrors);
  return { left, right, strip };
}

function approvals(s: State): Panes {
  if (!s.board) return { left: ["  (loading)"], right: ["reading the board (mw status)..."] };
  const rows = approvalRows(s);
  const left = rows.map((r, i) => `${i === s.sel.approvals ? SEL : NOSEL}${r.id.padEnd(10)}${r.ask}`);
  if (!left.length) left.push("  (none)");
  if (s.detail) return { left, right: detailLines(s) };
  const r = rows[s.sel.approvals];
  if (!r) return { left, right: ["No card is waiting for your approval."] };
  return { left, right: [...cardLines(r), "", `a approves '${r.ask}' (it shows what it approves and asks first)`, "Enter opens the card (its brief, run and files)"] };
}

function mcps(s: State): Panes {
  const left = s.data.mcps.map((m, i) => `${i === s.sel.mcps ? SEL : NOSEL}${m.id}`);
  if (!left.length) left.push("  (none; a adds)");
  const m = s.data.mcps[s.sel.mcps];
  if (!m) return { left, right: ["no MCP servers defined; a adds one (as 'mw mcp add')"] };
  const pend = s.pending.find((p) => p.kind === "mcp-roles" && p.id === m.id);
  const right = [
    `${m.id}  (${m.origin === "project" ? "project" : `preset ${m.origin}`})${m.enabled ? "" : "  disabled"}`, ...wrap(m.description, 50), "",
    `transport ${m.transport}`, `${m.transport === "stdio" ? "command" : "url"}${m.transport === "stdio" ? "   " : "       "}${m.target}`,
    `roles     ${m.roles}${pend?.kind === "mcp-roles" ? `  * unsaved: ${pend.roles.join(", ") || "(none)"}` : ""}`,
    `env       ${m.envNames.join(", ") || "-"}`, `headers   ${m.headerNames.join(", ") || "-"}`,
    "", "values of env and headers are never shown", "Enter changes roles; a adds, d removes, e ejects",
  ];
  return { left, right };
}

function editorPane(s: State): string[] {
  const ed = s.editor!;
  const out = [`edit ${ed.label}`, "", `> ${ed.text}_`, ""];
  editorEntries(ed).forEach((e, i) => out.push(`${i === ed.sel ? SEL : NOSEL}${e.label}`));
  if (!editorEntries(ed).length) out.push("  (type a value)");
  out.push("", "type to filter or enter free text; Enter stages, Esc cancels");
  return out;
}

function formPane(s: State): string[] {
  const f = s.form!;
  const out = ["add an MCP server (as 'mw mcp add')", ""];
  f.fields.forEach((x, i) => {
    const v = x.name === "env" || x.name === "headers" ? maskPairs(x.value) : x.value;
    out.push(`${i === f.focus ? SEL : NOSEL}${x.label.padEnd(22)}${v}${i === f.focus ? "_" : ""}`);
  });
  out.push(`${f.focus === f.fields.length ? SEL : NOSEL}[ add ]`, "", "values: ${VAR} references, not secrets", "Up/Down/Tab move, Enter next/add, Esc cancels");
  return out;
}

const HELP = [
  "keys",
  "  Tab Shift-Tab  next / previous screen",
  "  1-8            jump to a screen",
  "  Board          ← → column, ↑↓ card, Enter opens it,",
  "                 r set ready, R retry, a approve",
  "  Approvals      ↑↓ card, Enter opens it, a approve",
  "  Left Right     screens, or list <-> fields",
  "  Up Down        move",
  "  Enter          edit (picker, free text allowed)",
  "  Esc            back",
  "  s              save the staged changes",
  "  e              eject (Roles, MCPs)",
  "  a  d           add / remove an MCP server",
  "  p              probe services, re-read board, packages",
  "  ?              this help",
  "  q              quit",
  "",
  "every write is validated like 'mw config set';",
  "a refused value leaves mergewright.yaml unchanged",
];

function footer(s: State): string {
  if (s.confirm) return "y confirms · any other key cancels";
  if (s.detail) return "↑↓ scroll  Esc back  r ready  R retry  a approve  p refresh  q quit";
  if (s.screen === "board") return "Tab screen  ←→ status  ⏎ open  r ready  R retry  a approve  p refresh  q quit";
  if (s.screen === "approvals") return "Tab screen  ↑↓ move  ⏎ open  a approve  p refresh  ? help  q quit";
  if (s.screen === "packages") return "Tab screen  ↑↓ move  p re-run checks  ? help  q quit";
  if (s.editor) return "type · ↑↓ choose · Enter stage · Esc cancel";
  if (s.form) return "type · ↑↓/Tab move · Enter next/add · Esc cancel";
  const extra = s.screen === "roles" ? "  e eject" : s.screen === "mcps" ? "  a add  d remove  e eject" : "  p probe";
  return `Tab screen  ↑↓ move  ⏎ edit  s save${extra}  ? help  q quit`;
}

export function render(s: State, columns: number, rows: number): string[] {
  const cols = Math.max(20, columns);
  const tabs = SCREENS.map((x) => (x.id === s.screen ? `[${x.title}]` : ` ${x.title} `)).join("");
  const lines = [fit(` ${s.data.name} ${s.data.spec} │${tabs}`, cols), "─".repeat(cols)];
  const panes = { overview, roles, models, config, packages, mcps, board, approvals }[s.screen](s);
  if (panes.strip !== undefined) lines.push(fit(panes.strip, cols));
  const right = s.help ? HELP : s.confirm?.kind === "act" ? s.confirm.lines : s.editor ? editorPane(s) : s.form ? formPane(s) : panes.right;
  const leftW = Math.min(28, Math.floor(cols * 0.34));
  const rightW = cols - leftW - 3;
  const body = Math.max(1, rows - 4 - (panes.strip !== undefined ? 1 : 0));
  const selRow = s.sel[s.screen];
  const top = Math.max(0, Math.min(selRow - body + 1, panes.left.length - body));
  const left = panes.left.slice(top, top + body);
  const all = right.flatMap((l) => (l.length > rightW ? wrap(l, rightW) : [l]));
  const scroll = s.detail && right === panes.right ? Math.max(0, Math.min(s.detail.scroll, all.length - body)) : 0;
  const wrapped = all.slice(scroll);
  for (let i = 0; i < body; i++) lines.push(`${fit(left[i] ?? "", leftW)} │ ${fit(wrapped[i] ?? "", rightW)}`);
  const pending = s.pending.length ? `${s.pending.length} unsaved change(s) · ` : "";
  lines.push(fit(s.message ? `${s.message.error ? "! " : ""}${pending}${s.message.text}` : pending.replace(/ · $/, ""), cols));
  lines.push(fit(footer(s), cols));
  return lines.slice(0, Math.max(rows, 4));
}

/** Add colour: header and footer inverse, the selection marker bold, error messages red. */
export function paint(lines: string[]): string[] {
  const last = lines.length - 1;
  return lines.map((l, i) => {
    if (i === 0) return `\x1b[7m${l}\x1b[0m`;
    if (i === last) return `\x1b[2m${l}\x1b[0m`;
    if (i === last - 1 && l.startsWith("! ")) return `\x1b[31m${l}\x1b[0m`;
    return l.replaceAll(SEL, `\x1b[1;36m${SEL}\x1b[0m`);
  });
}
