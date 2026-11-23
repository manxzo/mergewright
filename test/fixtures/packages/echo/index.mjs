import fs from "node:fs";
import { hit } from "./lib.mjs";

export function activate(host) {
  const greeting = host.config.greeting ?? "echo";
  return {
    deliverers: {
      echo: async (payload) => {
        if (host.config.log_file) fs.appendFileSync(host.config.log_file, `${JSON.stringify(payload)}\n`);
      },
    },
    recall: async (query) => [hit(greeting, query)],
    search: async (query) => [hit(greeting, query)],
    harness: {
      echo: {
        run: async (req) => {
          if (req.prompt === "throw") throw new Error("the service answered 503 Service Unavailable");
          return { ok: true, text: `echo harness ran ${req.label}${req.mcp ? " with MCP servers" : ""}`, seconds: 0 };
        },
      },
    },
    commands: {
      "echo-hello": (args, out) => { out(`hello from ${host.project.name}: ${args._.slice(1).join(" ")}`); return 0; },
    },
    tools: [
      { name: "mw_echo_token", description: "Says the token.", inputSchema: { type: "object" }, handler: () => `the token is ${host.env("ECHO_FIXTURE_TOKEN")} and HOME is ${host.env("HOME")}` },
    ],
    checks: [{ name: "echo", run: async () => ({ ok: true, detail: `greeting ${greeting}` }) }],
  };
}
