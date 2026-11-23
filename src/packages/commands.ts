// `mw add`, `mw remove`, `mw packages` (EXPERIMENTAL), and the subcommands enabled packages provide.
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import YAML from "yaml";
import type { Handler, Out } from "../cli.ts";
import { keepCommentLayout } from "../config.ts";
import { CONFIG_FILE, Project } from "../project.ts";
import type { AvailablePackage, PackageData } from "../mcpserver/results.ts";
import { MwError, readText, writeAtomic } from "../util.ts";
import { API_VERSION } from "./api.ts";
import { loadPackages, runChecks } from "./loader.ts";
import { enabledPackages, installedNames, installFiles, MANIFEST_FILE, OFFICIAL_DIR, packagesDir, readManifest, removeFiles, resolveSource, secretNamesOf } from "./registry.ts";

function ownerOnly(what: string): void {
  if (process.env.MW_ROLE) throw new MwError("owner-only", `${what} is done by the owner, not from inside a card run (role '${process.env.MW_ROLE}'). Put what you need in your handoff.`);
}

/** Change mergewright.yaml through its YAML document, keeping comments and layout. */
function editConfig(project: Project, change: (doc: YAML.Document) => void): void {
  const file = path.join(project.root, CONFIG_FILE);
  const oldText = readText(file);
  const doc = YAML.parseDocument(oldText);
  change(doc);
  writeAtomic(file, keepCommentLayout(oldText, doc.toString({ lineWidth: 0, flowCollectionPadding: false })));
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^\s*y(es)?\s*$/i.test(await rl.question(question));
  } finally {
    rl.close();
  }
}

const add: Handler = async (a, out) => {
  ownerOnly("installing a package");
  const spec = a._[1];
  if (!spec) throw new MwError("usage", "use 'mw add <name | path> [--yes]'");
  const project = Project.loadRunnable();
  const source = resolveSource(spec);
  const m = readManifest(source.dir);
  if (m.apiVersion !== API_VERSION) {
    throw new MwError("package/api-version", `${m.name} ${m.version} was not installed: it is written for package API version ${m.apiVersion}, and this runtime provides version ${API_VERSION}`);
  }
  const secrets = secretNamesOf({ manifest: m, config: {} });
  out(`package ${m.name} ${m.version}: ${m.description}`);
  out(`  source:   ${source.official ? `official package, embedded in this runtime (${source.dir})` : `folder ${source.dir}`}`);
  out(`  provides: ${m.exports?.length ? m.exports.join(", ") : "nothing declared in its manifest"}${m.harnesses?.length ? ` (harnesses: ${m.harnesses.join(", ")})` : ""}`);
  out(`  reads:    settings under packages.${m.name} in ${CONFIG_FILE}${secrets.length ? `; the environment variables ${secrets.join(", ")}` : ""}`);
  out(`  entry:    ${m.entry}, package API ${m.apiVersion} (experimental). It runs with your rights whenever MergeWright loads it.`);
  if (a.flags.yes !== true) {
    if (!process.stdin.isTTY) {
      throw new MwError("package/consent", `${m.name} was not installed: a package runs with your rights, so installing one needs your confirmation. Run 'mw add ${spec}' in a terminal to be asked, or pass --yes if you have read what it does.`);
    }
    if (!(await confirm(`Install ${m.name} ${m.version}? [y/N] `))) {
      out(`${m.name} was not installed`);
      return 1;
    }
  }
  installFiles(project.root, source.dir, m.name);
  const enabled = Object.hasOwn(project.config.packages, m.name);
  if (!enabled) editConfig(project, (doc) => doc.setIn(["packages", m.name], doc.createNode({})));
  out(`installed ${m.name} ${m.version} in ${path.relative(project.root, path.join(packagesDir(project.root), m.name))}/${enabled ? "" : ` and enabled it under packages: in ${CONFIG_FILE}`}`);
  // Settings the package requires are the owner's to give; say what is missing.
  const problem = enabledPackages(project.root, { [m.name]: project.config.packages[m.name] ?? {} })[0]?.error;
  if (problem) out(`next: give its settings (${problem}), e.g. with 'mw config set packages.${m.name}.<key> <value>', then 'mw check'`);
  return 0;
};

const remove: Handler = (a, out) => {
  ownerOnly("removing a package");
  const name = a._[1];
  if (!name) throw new MwError("usage", "use 'mw remove <name>'");
  const project = Project.loadRunnable();
  const enabled = Object.hasOwn(project.config.packages, name);
  const removed = removeFiles(project.root, name);
  if (!enabled && !removed) throw new MwError("package/unknown", `there is no package '${name}' here (see 'mw packages')`);
  if (enabled) {
    editConfig(project, (doc) => {
      doc.deleteIn(["packages", name]);
      const rest = doc.getIn(["packages"], true);
      if (YAML.isMap(rest) && rest.items.length === 0) doc.deleteIn(["packages"]);
    });
  }
  out(`removed ${name}${removed ? ` (its files in ${path.relative(project.root, packagesDir(project.root))}/${name}/)` : ""}${enabled ? ` and its settings under packages: in ${CONFIG_FILE}` : ""}`);
  return 0;
};

/** Every installed or enabled package of the project, with whether it loaded and what it still needs (`mw packages`, mw_packages). */
export async function packageList(project: Project, opts: { checks?: boolean } = {}): Promise<PackageData[]> {
  const loaded = new Map((await loadPackages(project)).map((l) => [l.name, l]));
  const installed = new Set(installedNames(project.root));
  const names = [...new Set([...installed, ...Object.keys(project.config.packages)])].sort();
  return Promise.all(names.map(async (name) => {
    const p = project.packages.find((x) => x.name === name);
    let manifest = p?.manifest;
    if (!manifest && installed.has(name)) {
      try { manifest = readManifest(path.join(packagesDir(project.root), name)); } catch { manifest = undefined; }
    }
    const l = loaded.get(name);
    const config = p?.config ?? {};
    const required = (manifest?.config as { required?: unknown } | undefined)?.required;
    const exports = l?.exports as Record<string, unknown> | undefined;
    return {
      name, version: manifest?.version ?? null, description: manifest?.description ?? null,
      installed: installed.has(name), enabled: !!p, loaded: !!exports,
      error: p ? l?.error ?? p.error ?? null : null,
      provides: exports ? Object.keys(exports).filter((k) => exports[k] !== undefined) : manifest?.exports ?? [],
      missingSettings: Array.isArray(required) ? required.filter((k): k is string => typeof k === "string" && !Object.hasOwn(config, k)) : [],
      secrets: manifest ? secretNamesOf({ manifest, config }) : [],
      notes: l?.notes ?? [],
      checks: opts.checks ? await runChecks(l?.exports) : null,
    };
  }));
}

/** The official packages embedded in this runtime that are not installed in the project (mw_packages). */
export function availablePackages(project: Project): AvailablePackage[] {
  const installed = new Set(installedNames(project.root));
  const names = fs.existsSync(OFFICIAL_DIR) ? fs.readdirSync(OFFICIAL_DIR).sort() : [];
  return names.filter((n) => !installed.has(n) && fs.existsSync(path.join(OFFICIAL_DIR, n, MANIFEST_FILE))).map((n) => {
    const m = readManifest(path.join(OFFICIAL_DIR, n));
    return { name: m.name, version: m.version, description: m.description, exports: m.exports ?? [] };
  });
}

/** One line of `mw packages` for a package. */
export function packageLine(p: PackageData): string {
  const status = !p.enabled ? "installed, not enabled" : p.error ? `NOT loaded: ${p.error}` : `loaded, provides ${p.provides.join(", ") || "nothing"}`;
  return `${p.name.padEnd(12)} ${String(p.version ?? "?").padEnd(8)} ${p.enabled ? "enabled " : "disabled"} ${status}`;
}

const packages: Handler = async (_a, out) => {
  const list = await packageList(Project.load());
  if (!list.length) { out("no packages installed ('mw add <name | path>' installs one)"); return 0; }
  for (const p of list) out(packageLine(p));
  return 0;
};

export const commands: Record<string, Handler> = { add, remove, packages };

/** The handler of `mw <name>` an enabled package provides, or undefined (no project here, or no such command). */
export async function packageCommand(name: string): Promise<Handler | undefined> {
  let project: Project;
  try {
    project = Project.load();
  } catch {
    return undefined;
  }
  for (const l of await loadPackages(project)) {
    const c = l.exports?.commands?.[name];
    if (typeof c === "function") return (a, out: Out) => c({ _: a._, flags: a.flags }, out);
  }
  return undefined;
}
