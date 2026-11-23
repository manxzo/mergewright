// Harness 'shell': `sh -c <role.command>`, the escape hatch for any other agent CLI.
// The prompt arrives on stdin and in MW_PROMPT_FILE; stdout is the reply.
import { spawnAsync } from "../gate.ts";
import type { Harness } from "../types.ts";
import { baseEnv } from "./index.ts";
import { saveText, scratchFile, survivorNote } from "./proc.ts";

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const harness: Harness = {
  async run(req) {
    const t0 = Date.now();
    const seconds = () => Math.round((Date.now() - t0) / 1000);
    if (!req.role.command) return { ok: false, text: "", error: `role '${req.role.id}' runs on 'shell' but has no 'command'`, seconds: 0 };
    const promptFile = saveText(req, "prompt.txt", req.prompt);
    const extra: Record<string, string> = { ...req.env, MW_PROMPT_FILE: promptFile };
    if (req.outputSchemaFile) extra.MW_OUTPUT_SCHEMA = req.outputSchemaFile;
    // REQ-engine-006: it holds resolved credentials, so it is created private (0600) in this machine's
    // unsynced scratch folder, never in the run folder, and removed however the command ends.
    let mcp: { file: string; remove: () => void } | undefined;
    if (req.mcp) {
      mcp = scratchFile(req, "mcp.json", JSON.stringify(req.mcp.json, null, 2) + "\n");
      extra.MW_MCP_CONFIG = mcp.file;
    }
    const command = [req.role.command, ...req.role.args.map(quote)].join(" ");
    let r: Awaited<ReturnType<typeof spawnAsync>>;
    try {
      r = await spawnAsync("sh", ["-c", command], { cwd: req.cwd, env: baseEnv(extra), input: req.prompt, timeoutMs: req.limits.minutes * 60_000, signal: req.signal });
    } finally {
      mcp?.remove();
    }
    const text = r.stdout.trim();
    const fail = (error: string, timedOut?: boolean) => ({ ok: false, text, error, seconds: seconds(), timedOut });
    if (r.error) return fail(`could not start sh: ${r.error}`);
    if (r.aborted) return fail(`the command was stopped by the runtime${survivorNote(r.survivor)}`);
    if (r.timedOut) return fail(`the command timed out after ${req.limits.minutes} minute(s)${survivorNote(r.survivor)}`, true);
    if (r.code !== 0) return fail(`the command exited with ${r.code}: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
    if (!text) return fail("the command printed nothing");
    return { ok: true, text, seconds: seconds() };
  },
};
export default harness;
