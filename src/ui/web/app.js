// The page's shell: routing by URL hash, the status line, messages and live updates.
import { read, tools } from "./api.js";
import { renderBoard, renderNewCard } from "./board.js";
import { renderCard } from "./card.js";
import { h } from "./dom.js";
import { renderSearch, renderSettings, renderSpecs } from "./views.js";

const main = document.getElementById("main");
const messages = document.getElementById("messages");
const streamState = document.getElementById("stream-state");
const projectName = document.getElementById("project-name");

/** What every view shares. */
export const ui = {
  settings: null,
  tools: new Map(),
  /** Show a message in the status line; errors stay until dismissed. */
  notify(text, kind = "info") {
    const item = h("li", { class: `message ${kind}` },
      h("span", { class: "message-kind" }, kind === "error" ? "Error: " : "Done: "),
      h("span", { class: "pre-wrap" }, text),
      h("button", { type: "button", class: "quiet", "aria-label": "Dismiss this message", onclick: () => item.remove() }, "Dismiss"));
    messages.appendChild(item);
    while (messages.children.length > 6) messages.firstElementChild.remove();
    if (kind !== "error") setTimeout(() => item.remove(), 15000);
  },
  /** Re-render the current view (after an action or a change notice). */
  refresh: () => render(false),
  /** Run an action from a button: busy while it runs, its refusal shown as a message. Returns the tool result. */
  async act(button, label, fn) {
    const text = button.textContent;
    const key = button.dataset.key;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = label;
    try {
      const r = await fn();
      if (r && r.isError) ui.notify(r.text, "error");
      else if (r) ui.notify(summary(r), "info");
      return r;
    } catch (e) {
      ui.notify(e.message, "error");
      return null;
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = text;
      // The disabled button lost focus: give it back to the same control after the re-render, or to
      // the card's link when the action removed the control (a card that moved column).
      await render(false);
      const id = key ? key.slice(key.indexOf(":") + 1) : "";
      const target = (key && main.querySelector(`[data-key="${CSS.escape(key)}"]`)) || (id && main.querySelector(`[data-key="${CSS.escape(`open:${id}`)}"]`));
      if (target) target.focus();
    }
  },
};

/** One line saying what an action did: the card's new state when the data has the card, else the text's first line. */
function summary(r) {
  const card = r.data?.card ?? r.data?.started?.card;
  if (card) return `${card.id}: ${card.label}`;
  const line = String(r.text ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line && !/^[[{]/.test(line) ? line : "done";
}

function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map((p) => { try { return decodeURIComponent(p); } catch { return ""; } });
  return { view: parts[0] || "board", parts: parts.slice(1) };
}

const VIEWS = {
  board: renderBoard,
  new: renderNewCard,
  card: renderCard,
  specs: renderSpecs,
  search: renderSearch,
  settings: renderSettings,
};

let generation = 0;
let pending = false;

/** Render the view the hash names. `moved`: a navigation (focus goes to the view's heading). */
async function render(moved) {
  const r = route();
  // A live update never replaces a form being filled in: it waits until focus leaves it.
  const active = document.activeElement;
  if (!moved && active && main.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) {
    if (!pending) {
      pending = true;
      main.addEventListener("focusout", () => { pending = false; setTimeout(() => render(false), 0); }, { once: true });
    }
    return;
  }
  const mine = ++generation;
  const view = VIEWS[r.view] ?? renderBoard;
  for (const a of document.querySelectorAll("nav a")) {
    if (a.dataset.view === (VIEWS[r.view] ? (r.view === "new" ? "board" : r.view) : "board")) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const key = active && main.contains(active) ? active.dataset.key : undefined;
  const scroll = window.scrollY;
  let content;
  try {
    content = await view(r.parts, ui);
  } catch (e) {
    content = h("section", {}, h("h2", { tabindex: "-1" }, "Could not load this view"), h("p", { class: "error-text pre-wrap" }, e.message));
  }
  if (mine !== generation) return; // a newer render started meanwhile
  main.replaceChildren(content);
  main.setAttribute("aria-busy", "false");
  const title = main.querySelector("h2");
  document.title = `${title ? title.textContent : "MergeWright"} · MergeWright`;
  if (moved) {
    const target = main.querySelector("[data-focus-first]") ?? title;
    if (target) { target.setAttribute("tabindex", "-1"); target.focus({ preventScroll: false }); }
    window.scrollTo(0, 0);
  } else {
    if (key) main.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    window.scrollTo(0, scroll);
  }
}

function connect() {
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => { streamState.textContent = "Live updates on"; streamState.dataset.state = "on"; });
  source.addEventListener("error", () => { streamState.textContent = "Live updates off (reconnecting)"; streamState.dataset.state = "off"; });
  source.addEventListener("changed", () => {
    if (["board", "card"].includes(route().view)) render(false);
  });
}

async function start() {
  window.addEventListener("hashchange", () => render(true));
  try {
    for (const t of await tools()) ui.tools.set(t.name, t);
    ui.settings = await read("mw_settings");
    projectName.textContent = ui.settings.name;
  } catch (e) {
    ui.notify(e.message, "error");
  }
  connect();
  await render(false);
}

start();
