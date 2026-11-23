// The server's API (docs/specification.md section 16): the MCP tools over HTTP.

/** An error a tool answered with: its text, and its data when it has some (lint findings of a refusal). */
export class ToolError extends Error {
  constructor(text, data) {
    super(text);
    this.data = data;
  }
}

/** Call a tool: {text, data, isError}. Throws only when the request itself fails (sign-in, network). */
export async function call(name, args = {}) {
  const r = await fetch(`/api/tool/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
    credentials: "same-origin",
  });
  if (!r.ok) throw new Error(await problem(r));
  return r.json();
}

/** Call a read tool and return its data; a refusal throws a ToolError. */
export async function read(name, args = {}) {
  const r = await call(name, args);
  if (r.isError) throw new ToolError(r.text, r.data);
  return r.data;
}

export async function tools() {
  const r = await fetch("/api/tools", { credentials: "same-origin" });
  if (!r.ok) throw new Error(await problem(r));
  return (await r.json()).tools;
}

async function problem(r) {
  if (r.status === 401) return "Not signed in: open the link mw ui printed in the terminal.";
  try {
    return (await r.json()).error ?? `The server answered ${r.status}.`;
  } catch {
    return `The server answered ${r.status}.`;
  }
}
