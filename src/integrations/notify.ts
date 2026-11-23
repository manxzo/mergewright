// Owner notifications through `config.report.command` (a template: {subject} and {file} are substituted).
import fs from "node:fs";
import path from "node:path";
import { sh } from "../util.ts";
import { BUDGET_RAN_OUT, BudgetCut, commandTimeout, fillArgs, randomTag, splitCommand } from "./common.ts";

export interface NotifyPayload {
  subject: string;
  body: string;
}

const TIMEOUT_MS = 60_000;

/**
 * Run the report command once. The body goes to a temp file under `<localDir>/tmp/` (this machine's
 * `.mergewright/local/tmp/`), removed afterwards. Throws with a one-line reason when the command is
 * missing or fails. In a queue flush the command gets at most what is left of the flush's budget
 * (`commandTimeout`): one cut by the budget throws `BudgetCut`, one that ran out its own TIMEOUT_MS
 * "timed out".
 */
export async function deliverNotify(command: string, localDir: string, cwd: string, p: NotifyPayload): Promise<void> {
  const args = splitCommand(command);
  if (!args.length) throw new Error("report.command is empty");
  const tmpDir = path.join(localDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const limit = commandTimeout(TIMEOUT_MS);
  const file = path.join(tmpDir, `notify-${Date.now()}-${randomTag()}.md`);
  fs.writeFileSync(file, p.body);
  try {
    const [cmd, ...rest] = fillArgs(args, { subject: p.subject, file });
    const r = sh(cmd!, rest, { cwd, timeoutMs: limit.timeoutMs });
    if (r.timedOut && limit.byBudget) throw new BudgetCut(`${cmd} stopped (${BUDGET_RAN_OUT})`);
    if (r.timedOut) throw new Error(`${cmd} timed out after ${TIMEOUT_MS / 1000}s`);
    if (r.code !== 0) throw new Error(`${cmd} exited ${r.code}: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" | ")}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
}
