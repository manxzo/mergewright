// The TUI as a pure state machine: `reduce(state, key, ctx)` returns the next state and the effects
// (plain data) that src/tui/run.ts carries out against the project. No I/O here.
import type { LiveModels } from "./catalog.ts";
import { optionsFor } from "./catalog.ts";
import type { CardData, CardRow, PackagesData, RunData, StatusData } from "../mcpserver/results.ts";
import { ROLE_FIELDS, type Data, type Field, type RoleField } from "./data.ts";

export type Screen = "overview" | "roles" | "models" | "config" | "packages" | "mcps" | "board" | "approvals";
export const SCREENS: { id: Screen; title: string }[] = [
  { id: "overview", title: "Overview" },
  { id: "roles", title: "Roles" },
  { id: "models", title: "Models" },
  { id: "config", title: "Config" },
  { id: "packages", title: "Packages" },
  { id: "mcps", title: "MCPs" },
  { id: "board", title: "Board" },
  { id: "approvals", title: "Approvals" },
];
/** The board's columns, in the browser GUI's order and words (src/ui/web/board.js). */
export const COLUMNS = [
  { id: "todo", name: "To do" },
  { id: "ready", name: "Ready" },
  { id: "running", name: "Running" },
  { id: "queued", name: "Queued" },
  { id: "waiting", name: "Waiting for you" },
  { id: "blocked", name: "Blocked" },
  { id: "done", name: "Done" },
];
/** The harnesses the Models screen lists. */
export const MODEL_HARNESSES = ["claude", "codex", "local"];

export interface McpAddSpec {
  id: string;
  command?: string;
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  roles: string[];
  description?: string;
}

export type Effect =
  /** `setConfig(project, key, value)`; `value` undefined unsets. `literal`: the value is a plain string, not YAML. */
  | { kind: "save"; key: string; value?: string; literal?: boolean }
  | { kind: "eject"; what: "role" | "mcp"; id: string }
  | { kind: "probe" }
  | { kind: "mcp-add"; spec: McpAddSpec }
  | { kind: "mcp-remove"; id: string }
  | { kind: "mcp-roles"; id: string; roles: string[] }
  /** One call of the shared tool layer (callToolStructured); `into` says where its data goes, `action` reports the card's new state. */
  | { kind: "tool"; name: string; args: Record<string, unknown>; into: "board" | "packages" | "card" | "run" | "action" }
  | { kind: "quit" };

/** The outcome of one effect, folded back in with `settle`. */
export interface Result {
  ok: boolean;
  message: string;
  probes?: Record<string, Probe>;
  live?: LiveModels;
  /** A tool effect's data. */
  data?: unknown;
}

export interface Probe {
  state: string;
  detail?: string;
}

export interface Editor {
  /** A config key, or `mcp:<id>:roles`. */
  key: string;
  label: string;
  options: string[];
  text: string;
  sel: number;
  /** Offer "(unset)". */
  unset: boolean;
  literal: boolean;
}

export interface FormField {
  name: "id" | "target" | "env" | "headers" | "roles" | "description";
  label: string;
  value: string;
}
export interface Form {
  fields: FormField[];
  /** Index into fields; fields.length is the [add] button. */
  focus: number;
}

export interface State {
  screen: Screen;
  data: Data;
  /** Selected row of each screen's left list. */
  sel: Record<Screen, number>;
  focus: "list" | "detail";
  /** Selected field in the detail pane (Roles, Integrations). */
  field: number;
  editor?: Editor;
  form?: Form;
  confirm?: { kind: "mcp-remove"; id: string } | { kind: "quit" } | { kind: "act"; effect: Effect; lines: string[]; busy: string };
  help: boolean;
  /** Staged changes, written by `s`. */
  pending: Effect[];
  message?: { text: string; error: boolean };
  probes: Record<string, Probe>;
  live?: LiveModels;
  /** mw_status, mw_packages (with checks), as the tool layer returns them; undefined until loaded. */
  board?: StatusData;
  packages?: PackagesData;
  /** The board's column (index into COLUMNS). */
  col: number;
  /** The card opened on Board or Approvals (mw_card_get, mw_run_status), and how far its pane is scrolled. */
  detail?: { id: string; card?: CardData; run?: RunData; scroll: number };
}

/** What `reduce` needs besides the state: the picker's options. Tests can pass a fake. */
export interface Ctx {
  options(field: string, harness: string | undefined, live?: LiveModels): string[];
}
export const defaultCtx: Ctx = { options: optionsFor };

export function initState(data: Data): State {
  return {
    screen: "overview", data, sel: { overview: 0, roles: 0, models: 0, config: 0, packages: 0, mcps: 0, board: 0, approvals: 0 },
    focus: "list", field: 0, help: false, pending: [], probes: {}, col: 0,
  };
}

/** Rows in the current screen's left list. */
export function listLength(s: State): number {
  switch (s.screen) {
    case "overview": return s.data.cards.length;
    case "roles": return s.data.roles.length;
    case "models": return MODEL_HARNESSES.length;
    case "config": return s.data.config.length;
    case "packages": return (s.packages?.packages.length ?? 0) + (s.packages?.available.length ?? 0);
    case "mcps": return s.data.mcps.length;
    case "board": return columnRows(s, s.col).length;
    case "approvals": return approvalRows(s).length;
  }
}

/** The column a card is in: an aborted run is folded into Done (as the GUI does). */
export const columnOf = (row: CardRow): string => (row.status === "aborted" ? "done" : row.status);
export const columnRows = (s: State, col: number): CardRow[] => (s.board?.cards ?? []).filter((r) => columnOf(r) === COLUMNS[col]?.id);
/** Cards waiting at a stop point for the owner's word (not those paused for usage). */
export const approvalRows = (s: State): CardRow[] => (s.board?.cards ?? []).filter((r) => r.status === "waiting" && r.ask);

/** The card the Board or Approvals keys act on: the opened one, else the selected row. */
export function currentCard(s: State): CardRow | undefined {
  if (s.detail) return s.board?.cards.find((r) => r.id === s.detail!.id) ?? s.detail.card?.card;
  return s.screen === "board" ? columnRows(s, s.col)[s.sel.board] : s.screen === "approvals" ? approvalRows(s)[s.sel.approvals] : undefined;
}

/** The reads that refresh what the screens show: the board, the packages with their health checks, the opened card. */
export function refreshEffects(s: State): Effect[] {
  const out: Effect[] = [{ kind: "tool", name: "mw_status", args: {}, into: "board" }, { kind: "tool", name: "mw_packages", args: { checks: true }, into: "packages" }];
  if (s.detail) out.push({ kind: "tool", name: "mw_card_get", args: { id: s.detail.id }, into: "card" }, { kind: "tool", name: "mw_run_status", args: { id: s.detail.id }, into: "run" });
  return out;
}

/** The editable fields of the selected row (Roles and Integrations). */
export function detailFields(s: State): Field[] {
  if (s.screen === "roles") {
    const r = s.data.roles[s.sel.roles];
    if (!r) return [];
    return ROLE_FIELDS.map((f) => ({ key: `roles.${r.id}.${f}`, label: f, value: staged(s, `roles.${r.id}.${f}`) ?? r[f], options: [] }));
  }
  return [];
}

/** The staged value for a key: a string, "(unset)" for a staged removal, or undefined when nothing is staged. */
export function staged(s: State, key: string): string | undefined {
  const p = s.pending.find((e) => e.kind === "save" && e.key === key);
  return p?.kind === "save" ? p.value ?? "(unset)" : undefined;
}

export interface Entry {
  label: string;
  value: string | undefined;
}
/** The picker's choices: the free text first (when it is not already a choice), then the matching options, then "(unset)". */
export function editorEntries(ed: Editor): Entry[] {
  const t = ed.text.trim();
  const match = t ? ed.options.filter((o) => o.toLowerCase().includes(t.toLowerCase())) : ed.options;
  const out: Entry[] = [];
  if (t && !ed.options.includes(t)) out.push({ label: `${t}  (free text)`, value: t });
  for (const o of match) out.push({ label: o, value: o });
  if (ed.unset && !t) out.push({ label: "(unset)", value: undefined });
  return out;
}

const PRINTABLE = (k: string) => [...k].length === 1 && k >= " ";
const clamp = (n: number, len: number) => (len <= 0 ? 0 : Math.max(0, Math.min(len - 1, n)));
const say = (s: State, text: string, error = false): State => ({ ...s, message: { text, error } });
const none = (state: State) => ({ state, effects: [] as Effect[] });

function stage(s: State, e: Effect & { kind: "save" | "mcp-roles" }, what: string): State {
  const same = (x: Effect) => (e.kind === "save" ? x.kind === "save" && x.key === e.key : x.kind === "mcp-roles" && x.id === e.id);
  const pending = [...s.pending.filter((x) => !same(x)), e];
  return say({ ...s, pending, editor: undefined }, `staged ${what}; ${pending.length} unsaved change(s), s saves`);
}

function openEditor(s: State, ctx: Ctx): State {
  if (s.screen === "config") {
    const row = s.data.config[s.sel.config];
    if (!row) return s;
    const cur = staged(s, row.key) ?? row.value ?? "";
    // A plain string key (a path, a branch name) is saved as typed; any other is YAML (numbers, lists).
    // A URL is not put back into the input: it may carry credentials (local_models.endpoint).
    return { ...s, editor: { key: row.key, label: row.key, options: row.options, text: cur === "(unset)" || /^\w+:\/\//.test(cur) ? "" : cur, sel: 0, unset: true, literal: row.type === "string" && !row.options.length } };
  }
  if (s.screen === "mcps") {
    const m = s.data.mcps[s.sel.mcps];
    if (!m) return s;
    return { ...s, editor: { key: `mcp:${m.id}:roles`, label: `roles of MCP '${m.id}' (comma-separated, or all)`, options: ["all", ...s.data.roles.map((r) => r.id)], text: "", sel: 0, unset: false, literal: true } };
  }
  const f = detailFields(s)[s.field];
  if (!f) return s;
  let options = f.options;
  if (s.screen === "roles") {
    const r = s.data.roles[s.sel.roles]!;
    const runs = staged(s, `roles.${r.id}.runs`) ?? r.runs;
    options = ctx.options(f.label as RoleField, runs, s.live);
  }
  return { ...s, editor: { key: f.key, label: f.key, options, text: "", sel: 0, unset: true, literal: true } };
}

function reduceEditor(s: State, ed: Editor, key: string): { state: State; effects: Effect[] } {
  const entries = editorEntries(ed);
  if (key === "esc") return none({ ...s, editor: undefined });
  if (key === "up") return none({ ...s, editor: { ...ed, sel: clamp(ed.sel - 1, entries.length) } });
  if (key === "down" || key === "tab") return none({ ...s, editor: { ...ed, sel: clamp(ed.sel + 1, entries.length) } });
  if (key === "backspace") return none({ ...s, editor: { ...ed, text: ed.text.slice(0, -1), sel: 0 } });
  if (PRINTABLE(key)) return none({ ...s, editor: { ...ed, text: ed.text + key, sel: 0 } });
  if (key !== "enter") return none(s);
  const pick = entries[clamp(ed.sel, entries.length)];
  if (!pick) return none(say(s, "type a value, or Esc to cancel", true));
  const m = /^mcp:(.+):roles$/.exec(ed.key);
  if (m) {
    const roles = (pick.value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    return none(stage(s, { kind: "mcp-roles", id: m[1]!, roles }, `roles of '${m[1]}' = ${roles.join(", ") || "(none)"}`));
  }
  return none(stage(s, { kind: "save", key: ed.key, value: pick.value, literal: ed.literal }, `${ed.key} = ${pick.value ?? "(unset)"}`));
}

const FORM_FIELDS: FormField[] = [
  { name: "id", label: "id", value: "" },
  { name: "target", label: "command or URL", value: "" },
  { name: "env", label: "env NAME=value,..", value: "" },
  { name: "headers", label: "headers NAME=value,..", value: "" },
  { name: "roles", label: "roles (a,b or all)", value: "" },
  { name: "description", label: "description", value: "" },
];

function kv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of text.split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = item.indexOf("=");
    if (i < 1) throw new Error(`'${item.split("=")[0]}' needs the form NAME=value`);
    out[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return out;
}

/** The form's values as `mw mcp add` would take them. Throws with a message for the user. */
export function formSpec(form: Form): McpAddSpec {
  const v = Object.fromEntries(form.fields.map((f) => [f.name, f.value.trim()])) as Record<FormField["name"], string>;
  if (!v.id) throw new Error("the server needs an id");
  if (!v.target) throw new Error("give a command (a local server) or a URL (a remote one)");
  const remote = /^https?:\/\//i.test(v.target);
  return {
    id: v.id, command: remote ? undefined : v.target, url: remote ? v.target : undefined,
    env: kv(v.env), headers: kv(v.headers), roles: v.roles.split(",").map((x) => x.trim()).filter(Boolean),
    description: v.description || undefined,
  };
}

function reduceForm(s: State, form: Form, key: string): { state: State; effects: Effect[] } {
  const n = form.fields.length + 1;
  if (key === "esc") return none({ ...s, form: undefined });
  if (key === "up" || key === "btab") return none({ ...s, form: { ...form, focus: (form.focus + n - 1) % n } });
  if (key === "down" || key === "tab") return none({ ...s, form: { ...form, focus: (form.focus + 1) % n } });
  const f = form.fields[form.focus];
  if (f && (key === "backspace" || PRINTABLE(key))) {
    const value = key === "backspace" ? f.value.slice(0, -1) : f.value + key;
    return none({ ...s, form: { ...form, fields: form.fields.map((x, i) => (i === form.focus ? { ...x, value } : x)) } });
  }
  if (key !== "enter") return none(s);
  if (f) return none({ ...s, form: { ...form, focus: form.focus + 1 } });
  try {
    const spec = formSpec(form);
    return { state: { ...s, form: undefined }, effects: [{ kind: "mcp-add", spec }] };
  } catch (e) {
    return none(say(s, (e as Error).message, true));
  }
}

function moveScreen(s: State, by: number): State {
  const i = SCREENS.findIndex((x) => x.id === s.screen);
  return { ...s, screen: SCREENS[(i + by + SCREENS.length) % SCREENS.length]!.id, focus: "list", field: 0, help: false, detail: undefined };
}

/** Keys of Board and Approvals; undefined: the key is not theirs. */
function reduceCards(s: State, key: string): { state: State; effects: Effect[] } | undefined {
  const row = currentCard(s);
  if (s.detail && ["up", "down", "pageup", "pagedown"].includes(key)) {
    const by = { up: -1, down: 1, pageup: -10, pagedown: 10 }[key]!;
    return none({ ...s, detail: { ...s.detail, scroll: Math.max(0, Math.min(500, s.detail.scroll + by)) } });
  }
  if (s.detail && (key === "esc" || key === "left")) return none({ ...s, detail: undefined });
  if (!s.detail && s.screen === "board" && (key === "left" || key === "right")) {
    return none({ ...s, col: Math.max(0, Math.min(COLUMNS.length - 1, s.col + (key === "left" ? -1 : 1))), sel: { ...s.sel, board: 0 } });
  }
  if (!row) return ["enter", "r", "R", "a"].includes(key) ? none(say(s, s.board ? "no card selected" : "the board is not loaded yet (p loads it)")) : undefined;
  const board: Effect = { kind: "tool", name: "mw_status", args: {}, into: "board" };
  const act = (name: string, args: Record<string, unknown>): Effect => ({ kind: "tool", name, args, into: "action" });
  switch (key) {
    case "enter": {
      const detail = { id: row.id, scroll: 0 };
      return { state: say({ ...s, detail }, `opening ${row.id}...`), effects: refreshEffects({ ...s, detail }).slice(2) };
    }
    case "r":
      if (row.status !== "todo") return none(say(s, `${row.id} is not in To do; only a card in To do can be set ready`, true));
      return { state: say(s, `setting ${row.id} ready...`), effects: [act("mw_card_set_status", { id: row.id, status: "ready" }), board] };
    case "R": {
      if (row.status !== "blocked" && row.status !== "aborted") return none(say(s, `${row.id} is ${row.status}; only a blocked or aborted card can be retried`, true));
      const lines = [`Retry ${row.id} (${row.title})?`, "", `now     ${row.label === row.status ? row.status : row.label}${row.reason ? ` (${row.reason})` : ""}`, "", "It goes back to its flow's default phase and the run starts in the background, as 'mw retry' followed by 'mw run'.", "", "y retries, any other key cancels"];
      return none({ ...s, confirm: { kind: "act", effect: act("mw_retry", { id: row.id, run: true }), lines, busy: `retrying ${row.id}...` } });
    }
    case "a": {
      if (!row.ask) return none(say(s, `${row.id} is not waiting for an approval`, true));
      const run = s.detail?.id === row.id ? s.detail.run : undefined;
      const lines = [`Approve '${row.ask}' for ${row.id} (${row.title})?`, "", `now     ${row.status}, at the stop point '${row.ask}'`, `phase   ${row.phase ?? "-"}   flow ${row.flow}   risk ${row.risk}`];
      if (run?.summary) lines.push("", ...run.summary.split("\n"));
      if (run?.conditions.length) lines.push("", "conditions of approval:", ...run.conditions.map((c) => `  ${c.what}: ${c.how}`));
      lines.push("", `This is 'mw approve ${row.id} ${row.ask}': the run continues in the background.`, "", "y approves, any other key cancels");
      return none({ ...s, confirm: { kind: "act", effect: act("mw_approve", { id: row.id, word: row.ask }), lines, busy: `approving ${row.id} (${row.ask})...` } });
    }
  }
  return undefined;
}

export function reduce(state: State, key: string, ctx: Ctx = defaultCtx): { state: State; effects: Effect[] } {
  if (key === "ctrl-c") return { state, effects: [{ kind: "quit" }] };
  const s = state;
  if (s.confirm) {
    const c = s.confirm;
    const cleared: State = { ...s, confirm: undefined };
    if (key !== "y") return none(say(cleared, "cancelled"));
    if (c.kind === "quit") return { state: cleared, effects: [{ kind: "quit" }] };
    if (c.kind === "act") return { state: say(cleared, c.busy), effects: [c.effect, ...refreshEffects(cleared).filter((e) => e.kind !== "tool" || e.into !== "packages")] };
    return { state: cleared, effects: [{ kind: "mcp-remove", id: c.id }] };
  }
  if (s.editor) return reduceEditor(s, s.editor, key);
  if (s.form) return reduceForm(s, s.form, key);
  if (s.screen === "board" || s.screen === "approvals") {
    const r = reduceCards(s, key);
    if (r) return r;
  }

  const len = listLength(s);
  switch (key) {
    case "q":
      if (s.pending.length) return none(say({ ...s, confirm: { kind: "quit" } }, `${s.pending.length} unsaved change(s): y quits without saving, any other key goes back`, true));
      return { state: s, effects: [{ kind: "quit" }] };
    case "?": return none({ ...s, help: !s.help });
    case "tab": return none(moveScreen(s, 1));
    case "btab": return none(moveScreen(s, -1));
    case "left": return none(s.focus === "detail" ? { ...s, focus: "list" } : moveScreen(s, -1));
    case "right": return none(s.focus === "list" && detailFields(s).length ? { ...s, focus: "detail", field: 0 } : s.focus === "list" ? moveScreen(s, 1) : s);
    case "esc":
      if (s.help) return none({ ...s, help: false });
      if (s.focus === "detail") return none({ ...s, focus: "list" });
      return none({ ...s, message: undefined });
    case "up":
    case "down": {
      const by = key === "up" ? -1 : 1;
      if (s.focus === "detail") return none({ ...s, field: clamp(s.field + by, detailFields(s).length) });
      return none({ ...s, sel: { ...s.sel, [s.screen]: clamp(s.sel[s.screen] + by, len) }, field: 0 });
    }
    case "enter":
      if (s.screen === "config" || s.screen === "mcps") return none(openEditor(s, ctx));
      if (s.screen === "roles") {
        if (s.focus === "list") return none(detailFields(s).length ? { ...s, focus: "detail", field: 0 } : s);
        return none(openEditor(s, ctx));
      }
      return none(say(s, "nothing to edit here"));
    case "s":
      if (!s.pending.length) return none(say(s, "nothing to save"));
      return { state: say(s, `saving ${s.pending.length} change(s)...`), effects: [...s.pending] };
    case "p": return { state: say(s, "probing services, reading the board and the packages..."), effects: [{ kind: "probe" }, ...refreshEffects(s)] };
    case "e": {
      if (s.screen === "roles") {
        const r = s.data.roles[s.sel.roles];
        if (!r) return none(s);
        if (r.origin === "project") return none(say(s, `roles/${r.id}.role.md is already the project's own`));
        return { state: s, effects: [{ kind: "eject", what: "role", id: r.id }] };
      }
      if (s.screen === "mcps") {
        const m = s.data.mcps[s.sel.mcps];
        if (!m) return none(s);
        if (m.origin === "project") return none(say(s, `mcps/${m.id}.mcp.yaml is already the project's own`));
        return { state: s, effects: [{ kind: "eject", what: "mcp", id: m.id }] };
      }
      return none(s);
    }
    case "a":
      if (s.screen !== "mcps") return none(s);
      return none({ ...s, form: { fields: FORM_FIELDS.map((f) => ({ ...f })), focus: 0 } });
    case "d": {
      if (s.screen !== "mcps") return none(s);
      const m = s.data.mcps[s.sel.mcps];
      if (!m) return none(s);
      if (m.origin !== "project") return none(say(s, `'${m.id}' comes from the preset; only the project's own servers can be removed`, true));
      return none(say({ ...s, confirm: { kind: "mcp-remove", id: m.id } }, `remove mcps/${m.id}.mcp.yaml? y removes, any other key keeps it`, true));
    }
    default: {
      const n = Number(key);
      if (/^[1-8]$/.test(key)) return none({ ...s, screen: SCREENS[n - 1]!.id, focus: "list", field: 0, help: false, detail: undefined });
      return none(s);
    }
  }
}

/**
 * Fold an effect's outcome back in: a saved change leaves `pending`, a refused one stays (with the
 * validator's message shown); `data` is the project re-read after the write.
 */
export function settle(state: State, effect: Effect, result: Result, data?: Data): State {
  let s: State = { ...state, data: data ?? state.data };
  if (result.probes) s = { ...s, probes: { ...s.probes, ...result.probes } };
  if (result.live) s = { ...s, live: result.live };
  if (effect.kind === "tool" && result.ok && result.data) {
    const data = result.data;
    if (effect.into === "board") s = { ...s, board: data as StatusData };
    if (effect.into === "packages") s = { ...s, packages: data as PackagesData };
    const d = s.detail;
    if (effect.into === "card" && d && d.id === effect.args.id) s = { ...s, detail: { ...d, card: data as CardData }, message: undefined };
    if (effect.into === "run" && d && d.id === effect.args.id) s = { ...s, detail: { ...d, run: data as RunData } };
  }
  if (result.ok && (effect.kind === "save" || effect.kind === "mcp-roles")) s = { ...s, pending: s.pending.filter((p) => p !== effect) };
  const sel = { ...s.sel };
  for (const scr of SCREENS) sel[scr.id] = clamp(sel[scr.id], listLengthOf(s, scr.id));
  s = { ...s, sel };
  return result.message ? say(s, result.message, !result.ok) : s;
}

function listLengthOf(s: State, screen: Screen): number {
  return listLength({ ...s, screen });
}
