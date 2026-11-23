// Registry: `runs:` in a role file -> the harness that executes it.
import type { BuiltinHarness, Harness as HarnessId } from "../../model/role.ts";
import { activeExports } from "../../packages/loader.ts";
import type { Project } from "../../project.ts";
import { errMessage } from "../../integrations/common.ts";
import { MwError } from "../../util.ts";
import type { Harness } from "../types.ts";
import { classified } from "./transient.ts";

const loaders: Record<BuiltinHarness, () => Promise<{ default: Harness }>> = {
  mock: () => import("./mock.ts"),
  shell: () => import("./shell.ts"),
  claude: () => import("./claude.ts"),
  codex: () => import("./codex.ts"),
  local: () => import("./local.ts"),
};

/** A built-in harness, else (given the project) one an enabled package contributes. */
export async function harnessFor(id: HarnessId, project?: Project): Promise<Harness> {
  const load = (loaders as Record<string, (() => Promise<{ default: Harness }>) | undefined>)[id];
  if (load) return (await load()).default;
  const owner = project?.packageHarnesses.get(id);
  if (project && owner) {
    const h = (await activeExports(project)).find((p) => p.name === owner)?.exports.harness?.[id];
    if (h) return packaged(id, h);
    throw new MwError("harness/unknown", `'runs: ${id}' is a harness of package '${owner}', which did not load or did not provide it (see 'mw packages')`);
  }
  throw new MwError("harness/unknown", `no harness for 'runs: ${id}'`);
}

/**
 * A package's harness as the engine runs it: never given the project's MCP servers (their resolved
 * secrets stay with the built-in harnesses), and a thrown error becomes a failed result classified by
 * the shared table, like any harness's (REQ-harness-001). Timeouts, capture and redaction come from
 * `host.agent`, which runs the CLI through the same code as the built-in harnesses.
 */
function packaged(id: string, h: Harness): Harness {
  return {
    async run(req) {
      const started = Date.now();
      try {
        return await h.run({ ...req, mcp: undefined });
      } catch (e) {
        return classified({ ok: false, text: "", seconds: Math.round((Date.now() - started) / 100) / 10, error: `harness '${id}' failed: ${errMessage(e).split("\n")[0]}` });
      }
    },
  };
}

/** The environment every agent process starts from (defined with `gitEnv` in util.ts). */
export { baseEnv } from "../../util.ts";
