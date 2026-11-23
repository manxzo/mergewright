// Carrying out the reducer's effects against a project. Every write goes through the same functions
// as the CLI: setConfig (`mw config set`), eject (`mw eject`), addMcp/removeMcp (`mw mcp add|remove`),
// and the same probes as `mw doctor`.
import { setConfig } from "../config.ts";
import { eject } from "../eject.ts";
import { integrationSettings } from "../integrations.ts";
import { errMessage, onPath, splitCommand } from "../integrations/common.ts";
import { addMcp, removeMcp, setMcpRoles } from "../mcpadd.ts";
import type { CardRow } from "../mcpserver/results.ts";
import { callToolStructured } from "../mcpserver/server.ts";
import { Project } from "../project.ts";
import { fetchLocalModels } from "./catalog.ts";
import type { Effect, Probe, Result } from "./model.ts";

/** Reachability of each integration, by the probes `mw doctor` uses. Never throws. */
export async function probeIntegrations(project: Project): Promise<Record<string, Probe>> {
  const s = integrationSettings(project);
  const notConfigured: Probe = { state: "not configured" };
  const out: Record<string, Probe> = {};
  const { notify } = s;
  const lm = project.config.localModels;
  if (!lm?.endpoint) out.local = notConfigured;
  else {
    const live = await fetchLocalModels(lm.endpoint, lm.keyEnv ? process.env[lm.keyEnv] : undefined);
    out.local = live.models ? { state: `reachable, ${live.models.length} model(s)` } : { state: "NOT reachable", detail: live.error };
  }
  if (!notify) out.report = notConfigured;
  else {
    let cmd = "";
    try { cmd = splitCommand(notify)[0] ?? ""; } catch { cmd = ""; }
    out.report = onPath(cmd) ? { state: `command '${cmd}' found` } : { state: `command '${cmd}' NOT found on PATH` };
  }
  return out;
}

/** Lines the tool layer logs (an internal error's stack); `mw tui` prints them after the terminal is restored. */
export const toolLog: string[] = [];

/** What an action did, as the GUI says it: the card's new state when the data has the card, else the text. */
function actionSummary(data: unknown, text: string): string {
  const d = data as { card?: CardRow; started?: { card?: CardRow } } | undefined;
  const card = d?.card ?? d?.started?.card;
  return card ? `${card.id}: ${card.label}` : text || "done";
}

/** Run one effect in the project at `root`. Refusals come back as `{ok: false, message}`, never as a throw. */
export async function execute(root: string, effect: Effect): Promise<Result> {
  try {
    const project = new Project(root);
    switch (effect.kind) {
      case "save": {
        // A plain string is written as a JSON string (valid YAML), so "4" or "yes" stay strings.
        const raw = effect.value === undefined ? undefined : effect.literal ? JSON.stringify(effect.value) : effect.value;
        setConfig(project, effect.key, raw);
        return { ok: true, message: effect.value === undefined ? `${effect.key} removed` : `${effect.key} set` };
      }
      case "eject":
        project.assertRunnable(); // REQ-config-001, as 'mw eject'
        return { ok: true, message: `copied to ${eject(project, effect.what, effect.id)}; the project's copy now overrides the preset` };
      case "mcp-add":
        project.assertRunnable();
        return { ok: true, message: `created ${addMcp(project, effect.spec)}` };
      case "mcp-remove":
        project.assertRunnable();
        return { ok: true, message: `removed ${removeMcp(project, effect.id)}` };
      case "mcp-roles":
        project.assertRunnable();
        return { ok: true, message: `${setMcpRoles(project, effect.id, effect.roles)}: roles changed` };
      case "probe": {
        const probes = await probeIntegrations(project);
        const lm = project.config.localModels;
        const live = lm?.endpoint ? await fetchLocalModels(lm.endpoint, lm.keyEnv ? process.env[lm.keyEnv] : undefined) : undefined;
        return { ok: true, message: "services probed", probes, live };
      }
      case "tool": {
        const r = await callToolStructured(effect.name, effect.args, { root, project: () => new Project(root), signal: new AbortController().signal, log: (l) => toolLog.push(l) });
        // The message line is one line; the tool's text is already redacted by the tool layer.
        const oneLine = r.text.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
        if (r.isError) return { ok: false, message: oneLine, data: r.data };
        return { ok: true, message: effect.into === "action" ? actionSummary(r.data, oneLine) : "", data: r.data };
      }
      case "quit":
        return { ok: true, message: "" };
    }
  } catch (e) {
    return { ok: false, message: errMessage(e) };
  }
}
