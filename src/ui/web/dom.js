// Building DOM nodes. Text always goes in as text nodes; nothing here parses HTML.

/** An element: h("p", {class: "x", onclick: fn}, "text", child, [more]). Props come from this page's code only. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return el;
}

/** A card id or other code-like value, in the monospace face. */
export const mono = (text) => h("code", { class: "mono" }, text);

/** A definition list from [term, value] pairs; empty values are left out. */
export function dl(pairs, cls = "facts") {
  return h("dl", { class: cls }, pairs.filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)).map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
}

/** A plain-text rendering of any JSON value as nested definition lists (strings keep their line breaks). */
export function jsonView(value) {
  if (value === null || value === undefined) return h("span", { class: "muted" }, "none");
  if (Array.isArray(value)) {
    if (!value.length) return h("span", { class: "muted" }, "none");
    return h("ol", { class: "json-list" }, value.map((v) => h("li", {}, jsonView(v))));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return h("span", { class: "muted" }, "none");
    return h("dl", { class: "json" }, entries.map(([k, v]) => [h("dt", {}, k), h("dd", {}, jsonView(v))]));
  }
  if (typeof value === "string") return h("span", { class: "pre-wrap" }, value);
  return h("span", {}, String(value));
}

export const bytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
