// Tool group "runs": start and steer card runs. A run can take an hour, so `mw_run_start` and
// `mw_approve` start a detached `mw` process; they wait a few seconds for it to fail or to get under
// way, then return, and the client polls `mw_run_status`.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { agentsOf, describeRun, usageTotals } from "../../engine/run.ts";
import { loadState, runDir } from "../../engine/state.ts";
import { selfCommand } from "../../paths.ts";
import { localDir, type Project } from "../../project.ts";
import { CARD_ID, MwError } from "../../util.ts";
import { cardRowOf, runData, runLog, tail } from "../data.ts";
import type { StartedData } from "../results.ts";
import { need, S, schema, SLUG, str, strs, viaCli, withData, type Args, type ToolDef } from "../tool.ts";

export { runLog };

const cardIdArg = S.matching(CARD_ID, "card id, e.g. DEMO-3");

function cardId(project: Project, id: string): string {
  if (!CARD_ID.test(id)) throw new MwError("usage", `'${id}' is not a card id (like DEMO-3)`);
  project.card(id); // must exist
  return id;
}

/** Start `mw <argv>` detached in the project root, its output appended to the card's log. */
function startDetached(project: Project, id: string, argv: string[]): { pid: number; log: string; child: ChildProcess } {
  const log = runLog(project, id);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "a");
  try {
    fs.writeSync(fd, `\n== ${new Date().toISOString()} mw ${argv.join(" ")} (started by the MCP server)\n`);
    const self = selfCommand();
    const env = { ...process.env };
    delete env.MW_ROLE;
    const child = spawn(self.command, [...self.args, ...argv], { cwd: project.root, detached: true, stdio: ["ignore", fd, fd], env });
    child.unref();
    if (child.pid === undefined) throw new MwError("run/spawn", `could not start 'mw ${argv.join(" ")}'`);
    return { pid: child.pid, log: project.rel(log), child };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * How long `mw_approve` and `mw_run_start` wait for the detached process. The
 * environment variable MW_MCP_WAIT_MS caps both (tests shorten them).
 */
export const DETACHED_WAIT = { approveMs: 20_000, startMs: 10_000, pollMs: 100 };
const capped = (ms: number) => {
  const cap = Number(process.env.MW_MCP_WAIT_MS);
  return Number.isFinite(cap) && cap >= 0 && process.env.MW_MCP_WAIT_MS !== "" ? Math.min(ms, cap) : ms;
};

/**
 * Wait up to `ms` for the detached process to exit or for `settled()` to return a value. Returns how it
 * ended: "failed" (exited non-zero), "exited" (exited 0), "settled" (with the value), or "timeout".
 */
async function watch<T>(child: ChildProcess, ms: number, settled: () => T | undefined): Promise<{ how: "failed" | "exited"; code: number | null } | { how: "settled"; value: T } | { how: "timeout" }> {
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  if (child.exitCode !== null || child.signalCode !== null) exit = { code: child.exitCode, signal: child.signalCode };
  else child.once("exit", (code, signal) => { exit = { code, signal }; });
  const deadline = Date.now() + capped(ms);
  for (;;) {
    if (exit) return { how: exit.code === 0 ? "exited" : "failed", code: exit.code };
    let v: T | undefined;
    try { v = settled(); } catch { v = undefined; }
    if (v !== undefined) return { how: "settled", value: v };
    if (Date.now() >= deadline) return { how: "timeout" };
    await new Promise((r) => setTimeout(r, DETACHED_WAIT.pollMs));
  }
}

/** The error for a detached `mw` that exited non-zero: its exit status and the end of its log. */
function failedDetached(project: Project, id: string, argv: string[], code: number | null): MwError {
  const t = tail(runLog(project, id), 15);
  return new MwError("run/failed", `'mw ${argv.join(" ")}' failed (exit ${code ?? "by a signal"}); the end of its log (${project.rel(runLog(project, id))}):\n${t || "(empty)"}`);
}

/** Where the run is now, for a tool's reply. */
function where(project: Project, id: string): Record<string, unknown> {
  const state = loadState(runDir(project, id));
  if (!state) return { status: "not started" };
  return { status: state.status, phase: project.flows().get(state.flow)?.phases[state.phase]?.id ?? "-", round: state.round, ...(state.reason ? { reason: state.reason } : {}), summary: describeRun(project, state) };
}

function stateStamp(project: Project, id: string): string {
  try {
    const st = fs.statSync(path.join(runDir(project, id), "state.json"));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

/** StartedData for a detached process, with the card as it is now. */
function started(project: Project, id: string, argv: string[], r: { pid: number; log: string }, finished: boolean): StartedData {
  return { started: `mw ${argv.join(" ")}`, pid: r.pid, log: r.log, finished, card: cardRowOf(project, id) };
}

/**
 * mw_run_start (and mw_retry with `run`): start `mw run <id>` detached and wait briefly for it to fail
 * or to write its state. Returns the reply as before and the data.
 */
async function startRun(project: Project, id: string, a: Args): Promise<{ reply: Record<string, unknown>; data: StartedData }> {
  const argv = ["run", id];
  if (strs(a, "approve").length) argv.push("--approve", strs(a, "approve").join(","));
  if (str(a, "from")) argv.push("--from", str(a, "from")!);
  if (str(a, "until")) argv.push("--until", str(a, "until")!);
  const before = stateStamp(project, id);
  const r = startDetached(project, id, argv);
  // A run that fails at once (a lock, the lease, a dirty checkout) is reported as
  // failed, not as started; wait until the run state is written (or rewritten) or the process ends.
  const w = await watch(r.child, DETACHED_WAIT.startMs, () => (stateStamp(project, id) !== before && stateStamp(project, id) !== "" ? true : undefined));
  if (w.how === "failed") throw failedDetached(project, id, argv, w.code);
  const base = { started: `mw ${argv.join(" ")}`, pid: r.pid, log: r.log, next: `mw_run_status ${id}` };
  const data = started(project, id, argv, r, w.how === "exited");
  if (w.how === "timeout") return { reply: { ...base, note: `continuing in the background: no run state yet after ${Math.round(capped(DETACHED_WAIT.startMs) / 1000)} s; follow it with mw_run_status ${id} or the log ${r.log}` }, data };
  return { reply: { ...base, ...(w.how === "exited" ? { finished: true } : {}), now: where(project, id) }, data };
}

export const tools: ToolDef[] = [
  {
    name: "mw_run_start",
    description: "Start 'mw run <card>' in the background and return at once with its pid and log file. Poll mw_run_status for progress. 'approve' grants stop points up front (e.g. [\"go\"]).",
    write: true,
    inputSchema: schema({
      id: cardIdArg,
      approve: S.listOf(SLUG, "approval words granted up front, e.g. go, merge"),
      from: S.matching(SLUG, "go back to this phase first (phase id)"),
      until: S.matching(SLUG, "stop before this phase (phase id)"),
    }, ["id"]),
    result: "StartedData",
    handler: async (a, ctx) => {
      const project = ctx.project();
      const { reply, data } = await startRun(project, cardId(project, need(a, "id")), a);
      return withData("StartedData", reply, data);
    },
  },
  {
    name: "mw_run_status",
    description: "Where a card's run is: status, phase, round, reason, the conditions it waits on, history of phases (with the harness, model and usage of each role), agent usage totals, warnings, and the last lines of its background log.",
    result: "RunData",
    inputSchema: schema({ id: cardIdArg, log_lines: { ...S.int("how many log lines to include (default 20, at most 500)", 0), maximum: 500 } }, ["id"]),
    handler: (a, ctx) => {
      const project = ctx.project();
      const id = cardId(project, need(a, "id"));
      const state = loadState(runDir(project, id));
      const lines = typeof a.log_lines === "number" ? a.log_lines : 20;
      const log = tail(runLog(project, id), lines);
      const data = runData(project, id, lines);
      if (!state) return withData("RunData", { id, status: "not started", log }, data);
      return withData("RunData", {
        id, status: state.status, summary: describeRun(project, state), flow: state.flow,
        phase: project.flows().get(state.flow)?.phases[state.phase]?.id ?? "-", round: state.round, reason: state.reason,
        approvals: state.approvals, merged: state.merged, updated: state.updated,
        ...(state.conditions?.length ? { conditions: state.conditions } : {}),
        ...(state.followUps?.length ? { follow_ups: state.followUps } : {}),
        history: state.history.map((h) => ({
          phase: h.phase, outcome: h.outcome, roles: h.roles, detail: h.detail, round: h.round, seconds: h.seconds,
          ...(h.harness ? { harness: h.harness, model: h.model } : {}), ...(h.usage ? { usage: h.usage } : {}), ...(h.usageBy ? { usageBy: h.usageBy } : {}),
        })),
        agents: agentsOf(state), usage: usageTotals(state) ?? null,
        warnings: state.warnings, log,
      }, data);
    },
  },
  {
    name: "mw_approve",
    description: "Answer the stop point a run waits at (e.g. 'go' or 'merge') and continue the run in the background. Waits up to 20 s: an approval that fails is an error with the end of its log; one the run has acted on returns the run's new phase; otherwise it says the run continues in the background (pid and log).",
    write: true,
    result: "StartedData",
    inputSchema: schema({ id: cardIdArg, word: S.matching(SLUG, "the approval word the run waits for") }, ["id", "word"]),
    handler: async (a, ctx) => {
      const project = ctx.project();
      const id = cardId(project, need(a, "id"));
      const word = need(a, "word");
      const state = loadState(runDir(project, id));
      if (state?.status !== "waiting") throw new MwError("run/not-waiting", `${id} is not waiting for an approval (${state ? state.status : "it has no run"})`);
      if (state.reason !== word) throw new MwError("run/wrong-word", `${id} waits for '${state.reason}', not '${word}'`);
      const argv = ["approve", id, word];
      const r = startDetached(project, id, argv);
      // Report what the approval did, not only that a process was started.
      const moved = () => {
        const now = loadState(runDir(project, id));
        return now && (now.status !== "waiting" || now.reason !== state.reason || now.phase !== state.phase) ? now : undefined;
      };
      const w = await watch(r.child, DETACHED_WAIT.approveMs, moved);
      if (w.how === "failed") throw failedDetached(project, id, argv, w.code);
      const base = { started: `mw ${argv.join(" ")}`, pid: r.pid, log: r.log, next: `mw_run_status ${id}` };
      const data = started(project, id, argv, r, w.how === "exited");
      if (w.how === "timeout") return withData("StartedData", { ...base, note: `continuing in the background: the run had not left '${word}' after ${Math.round(capped(DETACHED_WAIT.approveMs) / 1000)} s; follow it with mw_run_status ${id} or the log ${r.log}` }, data);
      return withData("StartedData", { ...base, approved: word, ...(w.how === "exited" ? { finished: true } : {}), now: where(project, id) }, data);
    },
  },
  {
    name: "mw_retry",
    description: "Put a blocked card back at a phase (default: the flow's remediation phase) without running it; then mw_run_start continues it, or pass run=true to start 'mw run <card>' in the background at once (as mw_run_start does: it returns within seconds, and mw_run_status follows the run).",
    write: true,
    result: "RetryData",
    inputSchema: schema({ id: cardIdArg, from: S.matching(SLUG, "phase to go back to (phase id)"), run: S.bool("then start the run in the background, as mw_run_start does") }, ["id"]),
    handler: async (a, ctx) => {
      const id = cardId(ctx.project(), need(a, "id"));
      const text = await viaCli(ctx.root, ["retry", id, ...(str(a, "from") ? ["--from", str(a, "from")!] : [])]);
      const card = cardRowOf(ctx.project(), id);
      const from = card.phase; // the run now stands at the phase it was put back to
      if (a.run !== true) return withData("RetryData", text, { card, from, started: null });
      const { reply, data } = await startRun(ctx.project(), id, {});
      return withData("RetryData", `${text}\n${JSON.stringify(reply, null, 2)}`, { card: data.card, from, started: data });
    },
  },
  {
    name: "mw_abort",
    description: "Stop a card's run: its work stays on the branch and its worktree is moved aside. 'force' also deletes the branch and takes over a lease another machine holds.",
    write: true,
    result: "CardChangeData",
    inputSchema: schema({ id: cardIdArg, force: S.bool("also delete the branch and take over the lease") }, ["id"]),
    handler: async (a, ctx) => {
      const id = cardId(ctx.project(), need(a, "id"));
      const text = await viaCli(ctx.root, ["abort", id, ...(a.force === true ? ["--force"] : [])]);
      return withData("CardChangeData", text, { card: cardRowOf(ctx.project(), id) });
    },
  },
];
