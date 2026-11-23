// Loading and activating the enabled packages (EXPERIMENTAL). A package that cannot load, or throws in
// activate(), is reported and skipped: it never stops a run or a command that does not need it.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { errMessage } from "../integrations/common.ts";
import type { Project } from "../project.ts";
import { API_VERSION, type PackageExports } from "./api.ts";
import { makeHost, ownsKind } from "./host.ts";
import type { EnabledPackage } from "./registry.ts";

export interface LoadedPackage {
  name: string;
  version?: string;
  /** What activate() returned, cleaned of parts the package may not provide; undefined when it did not load. */
  exports?: PackageExports;
  /** Why it did not load, in a plain sentence. */
  error?: string;
  /** Parts activate() returned that were left out, and why. */
  notes: string[];
}

const TS_ENTRY = /\.(ts|mts)$/;

/** Activate one enabled package. Never throws. */
export async function loadPackage(project: Project, p: EnabledPackage): Promise<LoadedPackage> {
  const out: LoadedPackage = { name: p.name, version: p.manifest?.version, notes: [] };
  const fail = (why: string): LoadedPackage => ({ ...out, error: why });
  if (p.error || !p.manifest) return fail(p.error ?? "it has no manifest");
  const m = p.manifest;
  if (m.apiVersion !== API_VERSION) {
    return fail(`it is written for package API version ${m.apiVersion}, and this runtime provides version ${API_VERSION}; install a version of '${p.name}' made for this runtime`);
  }
  if (TS_ENTRY.test(m.entry) && !(process.features as { typescript?: unknown }).typescript) {
    return fail(`its entry '${m.entry}' is TypeScript, and this Node runtime cannot strip types (Node 24 with type stripping is needed); use a package with a .mjs or .js entry`);
  }
  let mod: { activate?: unknown };
  try {
    mod = (await import(pathToFileURL(path.join(p.dir, m.entry)).href)) as { activate?: unknown };
  } catch (e) {
    return fail(`its entry '${m.entry}' did not load: ${errMessage(e).split("\n")[0]}`);
  }
  if (typeof mod.activate !== "function") return fail(`its entry '${m.entry}' does not export a function 'activate'`);
  let ex: PackageExports;
  try {
    ex = ((await (mod.activate as (h: unknown) => unknown)(makeHost(project, p))) ?? {}) as PackageExports;
  } catch (e) {
    return fail(`activate() failed: ${errMessage(e).split("\n")[0]}`);
  }
  if (typeof ex !== "object") return fail("activate() did not return an object");
  return { ...out, exports: clean(p, ex, out.notes) };
}

/** Drop the parts a package may not provide: other packages' queue kinds, undeclared harnesses, tools not named mw_*. */
function clean(p: EnabledPackage, ex: PackageExports, notes: string[]): PackageExports {
  const c: PackageExports = { ...ex };
  if (ex.deliverers) {
    c.deliverers = {};
    for (const [kind, d] of Object.entries(ex.deliverers)) {
      if (ownsKind(p.name, kind) && typeof d === "function") c.deliverers[kind] = d;
      else notes.push(`deliverer '${kind}' left out (a package delivers only kinds '${p.name}' and '${p.name}:<anything>')`);
    }
  }
  if (ex.harness) {
    const declared = new Set(p.manifest?.harnesses ?? []);
    c.harness = {};
    for (const [id, h] of Object.entries(ex.harness)) {
      if (declared.has(id) && typeof h?.run === "function") c.harness[id] = h;
      else notes.push(`harness '${id}' left out (not listed under 'harnesses' in the manifest)`);
    }
  }
  if (ex.tools) {
    c.tools = ex.tools.filter((t) => {
      const ok = typeof t?.name === "string" && /^mw_[a-z0-9_]+$/.test(t.name) && typeof t.handler === "function";
      if (!ok) notes.push(`tool '${String(t?.name)}' left out (a tool needs a name mw_<lowercase> and a handler)`);
      return ok;
    });
  }
  return c;
}

const cache = new Map<string, Promise<LoadedPackage[]>>();
const reported = new Set<string>();

/**
 * The enabled packages of `project`, activated once per process for the same settings. A package that
 * did not load is reported on standard error once and left in the list with its `error`.
 */
export function loadPackages(project: Project): Promise<LoadedPackage[]> {
  if (!project.packages.length) return Promise.resolve([]);
  // shortcut: a package changed on disk while this process runs is not loaded again (Node caches the module); restart to pick it up.
  const key = `${project.root}\0${JSON.stringify(project.config.packages)}\0${project.packages.map((p) => p.manifest?.version ?? "").join(",")}`;
  let p = cache.get(key);
  if (!p) {
    p = Promise.all(project.packages.map((x) => loadPackage(project, x))).then((all) => {
      for (const l of all) {
        const line = l.error ? `package '${l.name}' is skipped: ${l.error}` : l.notes.length ? `package '${l.name}': ${l.notes.join("; ")}` : "";
        if (line && !reported.has(`${key}\0${line}`)) {
          reported.add(`${key}\0${line}`);
          process.stderr.write(`mw: ${line}\n`);
        }
      }
      return all;
    });
    cache.set(key, p);
  }
  return p;
}

/** The loaded packages' exports, in the order mergewright.yaml lists them. */
export async function activeExports(project: Project): Promise<{ name: string; exports: PackageExports }[]> {
  return (await loadPackages(project)).flatMap((l) => (l.exports ? [{ name: l.name, exports: l.exports }] : []));
}

/** Run a loaded package's health checks, as `mw doctor` reports them: a check that throws is not ok, with its message. */
export async function runChecks(ex: PackageExports | undefined): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const out: { name: string; ok: boolean; detail: string }[] = [];
  for (const c of ex?.checks ?? []) {
    try {
      const r = await c.run();
      out.push({ name: c.name, ok: !!r.ok, detail: String(r.detail ?? "") });
    } catch (e) {
      out.push({ name: c.name, ok: false, detail: errMessage(e) });
    }
  }
  return out;
}
