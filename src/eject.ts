// `mw eject`: copy a preset file into the project so it can be changed.
import fs from "node:fs";
import path from "node:path";
import type { Project } from "./project.ts";
import { MwError, requireSlug, writeAtomic } from "./util.ts";

const KINDS = { role: ["roles", ".role.md"], flow: ["flows", ".flow.yaml"], gate: ["gates", ".gate.sh"], mcp: ["mcps", ".mcp.yaml"] } as const;
export type EjectKind = keyof typeof KINDS;

export function eject(project: Project, kind: string, id: string): string {
  const k = KINDS[kind as EjectKind];
  if (!k) throw new MwError("eject/kind", `cannot eject a '${kind}'; choose one of: ${Object.keys(KINDS).join(", ")}`);
  if (!project.presetDir) throw new MwError("eject/preset", "the project's preset was not found");
  requireSlug(id, kind);
  const [dir, suffix] = k;
  const src = path.join(project.presetDir, dir, `${id}${suffix}`);
  if (!fs.existsSync(src)) {
    const have = fs.existsSync(path.join(project.presetDir, dir)) ? fs.readdirSync(path.join(project.presetDir, dir)).filter((n) => n.endsWith(suffix)).map((n) => n.slice(0, -suffix.length)) : [];
    throw new MwError("eject/unknown", `preset '${project.config.extends}' has no ${kind} '${id}' (it has: ${have.join(", ") || "none"})`);
  }
  const rel = path.join(dir, `${id}${suffix}`);
  if (fs.existsSync(project.abs(rel))) throw new MwError("eject/exists", `${rel} already exists in the project`);
  writeAtomic(project.abs(rel), fs.readFileSync(src, "utf8"), fs.statSync(src).mode & 0o111 ? 0o755 : undefined);
  return rel;
}
