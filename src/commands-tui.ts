// `mw tui`: see docs/design/tooling.md. Filled in by the tooling build.
import type { Handler } from "./cli.ts";
import { MwError } from "./util.ts";

export const commands: Record<string, Handler> = {
  tui: async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new MwError("tui/no-tty", "'mw tui' needs an interactive terminal. Without one, use 'mw config set <key> <value>' (for example 'mw config set roles.worker.model sonnet'), 'mw config unset <key>', 'mw mcp add|remove' and 'mw doctor'.");
    }
    if (process.env.MW_ROLE) throw new MwError("owner-only", `'mw tui' is the owner's, not for use inside a card run (role '${process.env.MW_ROLE}')`);
    const { Project } = await import("./project.ts");
    const { runTui } = await import("./tui/run.ts");
    return runTui(Project.load());
  },
};
