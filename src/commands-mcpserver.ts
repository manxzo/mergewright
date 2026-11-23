// `mw mcp serve`: the MergeWright MCP server over stdio (docs/design/tooling.md section 3).
import path from "node:path";
import { str, type Handler } from "./cli.ts";
import { serve } from "./mcpserver/server.ts";
import { Project } from "./project.ts";

export const commands: Record<string, Handler> = {
  "mcp-serve": async (a) => {
    const dir = str(a, "project");
    const project = dir ? Project.load(path.resolve(dir)) : Project.load();
    // stdout carries the protocol only: anything that would print there goes to stderr.
    const toStderr = (...args: unknown[]) => process.stderr.write(`${args.map(String).join(" ")}\n`);
    console.log = toStderr;
    console.info = toStderr;
    console.warn = toStderr;
    console.debug = toStderr;
    // The server works for this one project; commands it reuses find their project from the working directory.
    process.chdir(project.root);
    await serve(project, { input: process.stdin, output: process.stdout });
    return 0;
  },
};
