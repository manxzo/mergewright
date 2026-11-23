// A small, safe Markdown renderer for text written by agents (untrusted). parseMarkdown is pure: it
// turns text into a tree of {tag, href?, children} and strings, with only the tags below; toDom
// builds DOM nodes from that tree with createElement and createTextNode only (no HTML parsing anywhere), and
// checks tags and links again. Raw HTML in the text stays text.
//
// Supported: headings, paragraphs, lists (one level), code fences, inline code, bold, italic,
// links (http, https, mailto and #fragments only), block quotes and rules.

export const TAGS = new Set(["h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "pre", "code", "strong", "em", "a", "blockquote", "hr", "br"]);

/** The link target if it is a safe one (http, https, mailto or a #fragment), else null. */
export function safeHref(url) {
  const u = String(url ?? "").trim();
  if (/^https?:\/\/[^\s]+$/i.test(u) || /^mailto:[^\s]+$/i.test(u) || /^#[^\s]*$/.test(u)) return u;
  return null;
}

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*?)\*|(?<![A-Za-z0-9])_([^_\s][^_]*?)_(?![A-Za-z0-9])/g;

/** Inline Markdown of one block's text, as tree nodes. */
export function parseInline(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push({ tag: "code", children: [m[1]] });
    else if (m[2] !== undefined) out.push({ tag: "strong", children: parseInline(m[2]) });
    else if (m[3] !== undefined) {
      const href = safeHref(m[4]);
      // An unsafe link keeps its text and loses its target.
      out.push(href ? { tag: "a", href, children: parseInline(m[3]) } : m[3]);
    } else out.push({ tag: "em", children: parseInline(m[5] ?? m[6]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Block Markdown as tree nodes. `level` is the heading level the text's biggest heading becomes (default 3), so
 * headings inside agent text never outrank the page's own; deeper ones follow, at most h6.
 */
export function parseMarkdown(text, level = 3) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  // The text's biggest heading becomes `level`, so levels follow each other without a gap.
  let fenced = false;
  const top = Math.min(6, ...lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    return (!fenced && /^(#{1,6})\s/.exec(l)?.[1].length) || 6;
  }));
  const out = [];
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) {
      const children = [];
      para.forEach((l, i) => { if (i) children.push({ tag: "br", children: [] }); children.push(...parseInline(l)); });
      out.push({ tag: "p", children });
      para = [];
    }
    if (list) { out.push(list); list = null; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const body = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push({ tag: "pre", children: [{ tag: "code", children: [body.join("\n")] }] });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      out.push({ tag: `h${Math.min(6, level + heading[1].length - top)}`, children: parseInline(heading[2]) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push({ tag: "hr", children: [] }); continue; }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const body = [quote[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) body.push(lines[++i].replace(/^\s*>\s?/, ""));
      out.push({ tag: "blockquote", children: parseMarkdown(body.join("\n"), level) });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      const tag = item[1] ? "ul" : "ol";
      if (para.length || (list && list.tag !== tag)) flush();
      if (!list) list = { tag, children: [] };
      list.children.push({ tag: "li", children: parseInline(item[3]) });
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // a continuation line of the last item
      const li = list.children[list.children.length - 1];
      li.children.push(" ", ...parseInline(line.trim()));
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return out;
}

/** DOM nodes for tree nodes, built with `doc` (the page's document, or a stand-in in tests). */
export function toDom(nodes, doc) {
  const frag = doc.createDocumentFragment();
  for (const n of nodes) frag.appendChild(nodeToDom(n, doc));
  return frag;
}

function nodeToDom(n, doc) {
  if (typeof n === "string") return doc.createTextNode(n);
  if (!n || !TAGS.has(n.tag)) return doc.createTextNode("");
  const el = doc.createElement(n.tag);
  if (n.tag === "a") {
    const href = safeHref(n.href);
    if (href) {
      el.setAttribute("href", href);
      if (!href.startsWith("#")) { el.setAttribute("rel", "noopener noreferrer"); el.setAttribute("target", "_blank"); }
    }
  }
  for (const c of n.children ?? []) el.appendChild(nodeToDom(c, doc));
  return el;
}

/** Render Markdown `text` into DOM nodes. */
export function renderMarkdown(text, doc, level = 3) {
  return toDom(parseMarkdown(text, level), doc);
}
