// Installed packages (EXPERIMENTAL): `.mergewright/packages/<name>/`, each with mergewright-package.yaml.
// Everything here is synchronous and runs no package code: it reads manifests only, so a project can
// check role harness ids, package settings and secret names before (or without) loading any package.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { PACKAGE_ROOT, SCHEMA_DIR } from "../paths.ts";
import { validateWith } from "../schemas.ts";
import { MwError } from "../util.ts";
import type { PackageManifest } from "./api.ts";

export const MANIFEST_FILE = "mergewright-package.yaml";
/**
 * Harness ids and `mw` commands that were built in and now come with an official package, by the
 * package's name: `runs: hermes` and `mw hermes` say to run 'mw add hermes' until it is installed.
 */
export const MOVED_TO_OFFICIAL: Readonly<Record<string, string>> = { hermes: "hermes" };
/** The official packages shipped with the runtime (embedded in the single executable). */
export const OFFICIAL_DIR = path.join(PACKAGE_ROOT, "packages");

/** `<root>/.mergewright/packages`: where `mw add` installs. Not committed; `packages:` in mergewright.yaml says which are enabled. */
export function packagesDir(root: string): string {
  return path.join(root, ".mergewright", "packages");
}

let manifestSchema: object | undefined;
/** Manifests by their text: the same `config` schema object is reused, so ajv compiles it once. */
const parsed = new Map<string, PackageManifest>();

/** The manifest of the package in `dir`, checked against schemas/package.schema.json. Throws MwError with a plain sentence. */
export function readManifest(dir: string): PackageManifest {
  const file = path.join(dir, MANIFEST_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new MwError("package/no-manifest", `${dir} has no ${MANIFEST_FILE}, so it is not a MergeWright package`);
  }
  const known = parsed.get(text);
  if (known) return checkEntry(dir, file, known);
  let data: unknown;
  try {
    data = YAML.parse(text);
  } catch (e) {
    throw new MwError("package/manifest", `${file} is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  manifestSchema ??= JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, "package.schema.json"), "utf8")) as object;
  const problems = validateWith(manifestSchema, data);
  if (problems.length) throw new MwError("package/manifest", `${file} is not a valid package manifest: ${problems.join("; ")}`);
  // Kept with its `config` schema stripped of `$id`: ajv refuses a second schema with the same id.
  const m = data as PackageManifest;
  if (m.config && "$id" in m.config) delete (m.config as { $id?: unknown }).$id;
  parsed.set(text, m);
  return checkEntry(dir, file, m);
}

function checkEntry(dir: string, file: string, m: PackageManifest): PackageManifest {
  if (!fs.existsSync(path.join(dir, m.entry))) throw new MwError("package/manifest", `${file} names the entry '${m.entry}', which the package does not have`);
  return m;
}

export interface EnabledPackage {
  name: string;
  /** Its folder under `.mergewright/packages/`. */
  dir: string;
  /** Its settings, `packages.<name>` (null or absent: {}). */
  config: Record<string, unknown>;
  manifest?: PackageManifest;
  /** Why it cannot be used: not installed, a bad manifest, or settings its schema refuses. */
  error?: string;
}

/** The packages `packages:` in mergewright.yaml enables, with their manifests read and settings checked. */
export function enabledPackages(root: string, packages: Record<string, unknown>): EnabledPackage[] {
  return Object.entries(packages).map(([name, raw]) => {
    const dir = path.join(packagesDir(root), name);
    const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const p: EnabledPackage = { name, dir, config };
    if (!fs.existsSync(dir)) return { ...p, error: `package '${name}' is enabled in mergewright.yaml but not installed here (run 'mw add ${name}')` };
    try {
      p.manifest = readManifest(dir);
    } catch (e) {
      return { ...p, error: (e as Error).message };
    }
    if (p.manifest.name !== name) return { ...p, error: `the package installed as '${name}' calls itself '${p.manifest.name}' (reinstall it with 'mw add')` };
    if (p.manifest.config) {
      const problems = validateWith(p.manifest.config, config);
      if (problems.length) return { ...p, error: `packages.${name}: ${problems.join("; ")}` };
    }
    return p;
  });
}

/** Harness ids the usable enabled packages declare (manifest `harnesses`), by id -> package name. */
export function packageHarnesses(enabled: EnabledPackage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of enabled) if (!p.error) for (const id of p.manifest?.harnesses ?? []) out.set(id, p.name);
  return out;
}

/** The environment variables the enabled packages declare as secrets, resolved against their settings. */
export function packageSecretNames(enabled: EnabledPackage[]): string[] {
  const out: string[] = [];
  for (const p of enabled) out.push(...secretNamesOf(p));
  return [...new Set(out)];
}

export function secretNamesOf(p: Pick<EnabledPackage, "manifest" | "config">): string[] {
  return (p.manifest?.secrets ?? []).map((s) => {
    if (typeof s === "string") return s;
    const v = p.config[s.config];
    return typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? v : s.default;
  });
}

/** Every folder under `.mergewright/packages/`, enabled or not. */
export function installedNames(root: string): string[] {
  try {
    return fs.readdirSync(packagesDir(root), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Where `mw add <spec>` takes a package from: a folder (a path), or an official package by name. */
export function resolveSource(spec: string, cwd: string = process.cwd()): { dir: string; official: boolean } {
  const looksLikePath = spec.includes("/") || spec.startsWith(".") || spec.includes(path.sep);
  if (looksLikePath) return { dir: path.resolve(cwd, spec), official: false };
  if (!/^[a-z][a-z0-9-]*$/.test(spec)) throw new MwError("usage", `'${spec}' is neither a package name nor a path to a package folder`);
  const dir = path.join(OFFICIAL_DIR, spec);
  if (!fs.existsSync(dir)) {
    const known = fs.existsSync(OFFICIAL_DIR) ? fs.readdirSync(OFFICIAL_DIR).filter((n) => fs.existsSync(path.join(OFFICIAL_DIR, n, MANIFEST_FILE))) : [];
    throw new MwError("package/unknown", `there is no official package '${spec}' (official packages: ${known.join(", ") || "none"}); to install a package from a folder, give its path, e.g. 'mw add ./${spec}'`);
  }
  return { dir, official: true };
}

/** Copy the package folder `from` to `.mergewright/packages/<name>/`, replacing an older install. */
export function installFiles(root: string, from: string, name: string): string {
  const target = path.join(packagesDir(root), name);
  const tmp = `${target}.installing-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Links are copied as the files they point to: a link could point outside the package folder.
  fs.cpSync(from, tmp, { recursive: true, dereference: true, filter: (src) => path.basename(src) !== ".git" });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(tmp, target);
  return target;
}

export function removeFiles(root: string, name: string): boolean {
  const target = path.join(packagesDir(root), name);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}
