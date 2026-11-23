// `mw ui [--port N] [--no-open]`: the GUI (docs/specification.md section 16).
import { spawn, spawnSync } from "node:child_process";
import { str, type Handler } from "./cli.ts";
import { Project } from "./project.ts";
import { startUiServer } from "./ui/server.ts";
import { MwError } from "./util.ts";

/** The command that opens a link in the browser here, or why there is none. */
function opener(): { command: string } | { skip: string } {
  if (process.env.NODE_TEST_CONTEXT) return { skip: "running under a test" };
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  if (process.platform !== "darwin" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { skip: "there is no display" };
  if (spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status !== 0) return { skip: `${command} is not installed` };
  return { command };
}

export const commands: Record<string, Handler> = {
  ui: async (a, out) => {
    const project = Project.load();
    const given = str(a, "port");
    const port = given === undefined ? undefined : Number(given);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new MwError("usage", `--port takes a port number from 0 (any free one) to 65535, not '${given}'`);
    const ui = await startUiServer({ root: project.root, port, fallback: port === undefined });
    out(`MergeWright GUI for project '${project.config.name}': ${ui.url}`);
    out("Open that link to sign in (it holds this start's access token; anyone with it can act as you). Ctrl-C stops the server.");
    const o = a.flags["no-open"] === true ? { skip: "--no-open" } : opener();
    if ("command" in o) {
      const child = spawn(o.command, [ui.url], { stdio: "ignore", detached: true });
      child.on("error", () => out(`could not start ${o.command}; open the link by hand`));
      child.unref();
    } else out(`(the browser was not opened: ${o.skip})`);
    await new Promise<void>((resolve) => {
      const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); void ui.close().then(resolve); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    out("mw ui stopped");
    return 0;
  },
};
