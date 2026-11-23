// Shared test fixtures: throwaway projects in the system temp directory.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { check } from "../src/check.ts";
import { harnessFor } from "../src/engine/harness/index.ts";
import type { Harness } from "../src/engine/types.ts";
import { init } from "../src/init.ts";
import { makeHost } from "../src/packages/host.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { Project } from "../src/project.ts";

export const MW = path.join(PACKAGE_ROOT, "bin", "mw.js");

/** `ps -o <field>= -p <pid>` on macOS (UTC, C locale), or undefined when there is no such process. */
function psField(pid: number, field: string): string | undefined {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC0" } }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The start time a lock or orphans record carries for `pid`, read here independently of the runtime:
 * field 22 of /proc/<pid>/stat on Linux, the `ps` start time in seconds since the epoch on macOS.
 */
export function procStart(pid: number): string {
  if (process.platform === "darwin") return String(Date.parse(`${psField(pid, "lstart")} UTC`) / 1000);
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 2).split(" ")[19]!;
}

/** The one-letter state of `pid` (Z for a zombie), or undefined when there is no such process. */
export function procState(pid: number): string | undefined {
  if (process.platform === "darwin") return psField(pid, "stat")?.[0];
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return undefined;
  }
}

const created: string[] = [];
// Each test file runs in its own process; remove what it created when that process ends, so
// repeated runs do not fill the temporary filesystem (thousands of small git repositories).
process.on("exit", () => {
  if (process.env.MW_KEEP_TMP) return;
  for (const d of created) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

// Resolved once: on macOS the temp folder (/var/folders/...) is a symlink to /private/var/folders/...,
// and the runtime reports resolved paths.
const TMP_ROOT = fs.realpathSync(os.tmpdir());

export function tmpDir(prefix = "mw-"): string {
  const d = fs.mkdtempSync(path.join(TMP_ROOT, prefix));
  created.push(d);
  return d;
}

export function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

export function git(cwd: string, ...args: string[]): string {
  const r = sh(cwd, "git", args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out.trim();
}

/** A new git repository that is a MergeWright project with one commit. */
export function newProject(opts: { example?: boolean; prefix?: string } = {}): string {
  const dir = tmpDir();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  // Never derive an identity from the host name (user@host.example): a test that removes
  // user.email must leave the repository without one on every machine.
  git(dir, "config", "user.useConfigOnly", "true");
  init(dir, { name: "demo", prefix: opts.prefix ?? "DEMO", example: opts.example });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

export function write(dir: string, rel: string, content: string): void {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

export function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

/** Diagnostic codes `mw check` reports for the project, sorted. */
export function codes(dir: string, severity?: "error" | "warning"): string[] {
  const d = check(new Project(dir));
  return d.items.filter((x) => !severity || x.severity === severity).map((x) => x.code).sort();
}

/**
 * Install the official package `name` in the project at `dir` with `mw add <name> --yes` (once: an
 * installed package is left as it is). `mw add` enables it as `packages.<name>: {}` in mergewright.yaml.
 */
export function addPackage(dir: string, name: string): void {
  if (fs.existsSync(path.join(dir, ".mergewright", "packages", name))) return;
  const r = mw(dir, ["add", name, "--yes"]);
  if (r.code !== 0) throw new Error(`mw add ${name} --yes failed: ${r.err || r.out}`);
}

/**
 * A package's harness as the engine runs it (`harnessFor`, so the engine's wrapping applies), from a
 * scratch project with the official package `pkg` installed.
 */
export async function packageHarness(pkg: string, id: string = pkg): Promise<Harness> {
  const dir = newProject();
  addPackage(dir, pkg);
  return harnessFor(id, new Project(dir));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HermesPackage = Record<string, any>;
let hermesModule: Promise<HermesPackage> | undefined;
/** The hermes package's module, this checkout's copy (its `configLock` and `testHooks` are the ones `hermesTools` uses). */
export function hermesPackage(): Promise<HermesPackage> {
  hermesModule ??= import(pathToFileURL(path.join(PACKAGE_ROOT, "packages", "hermes", "index.mjs")).href) as Promise<HermesPackage>;
  return hermesModule;
}
/** The hermes package's config tools (`init`, `remove`, `status`, ...) for the project at `dir`, the package installed first. */
export async function hermesTools(dir: string): Promise<HermesPackage> {
  addPackage(dir, "hermes");
  const p = new Project(dir);
  const e = p.packages.find((x) => x.name === "hermes");
  if (!e || e.error) throw new Error(`the hermes package is not usable in ${dir}: ${e?.error ?? "not enabled"}`);
  return (await hermesPackage()).hermesTools(makeHost(p, e)) as HermesPackage;
}

/** A config patch enabling the mem0 package with `settings` (url, user, key_env, write_timeout_ms); `patchConfig` and `projectWith` install it. */
export const mem0Config = (settings: Record<string, unknown>): { packages: { mem0: Record<string, unknown> } } => ({ packages: { mem0: settings } });
/** The same for the open-notebook package (url, name, key_env). */
export const notebookConfig = (settings: Record<string, unknown>): { packages: { "open-notebook": Record<string, unknown> } } => ({ packages: { "open-notebook": settings } });
/** The same for the cline-kanban package (path: the project's path as the board knows it). */
export const kanbanConfig = (settings: Record<string, unknown> = {}): { packages: { "cline-kanban": Record<string, unknown> } } => ({ packages: { "cline-kanban": settings } });
/** The same for the letta package, with test values for its required models (url, agent, key_env, model, embedding, embedding_endpoint, embedding_dim, write_timeout_ms). */
export const lettaConfig = (settings: Record<string, unknown>): { packages: { letta: Record<string, unknown> } } => ({ packages: { letta: { model: "openai-proxy/qwen3.6-35b-a3b", embedding: "qwen3-embedding-0.6b", ...(settings.embedding === undefined ? { embedding_endpoint: "http://llamacpp-embed:8080/v1" } : {}), ...settings } } });

/**
 * Merge `patch` into the project's mergewright.yaml, one level deep (`{packages: {letta: ...}}` keeps the
 * other packages). Every package `patch.packages` names is installed first (`addPackage`).
 */
export function patchConfig(dir: string, patch: Record<string, unknown>): void {
  const pkgs = patch.packages;
  if (pkgs && typeof pkgs === "object") for (const name of Object.keys(pkgs)) addPackage(dir, name);
  // The letta package requires its models: tests that do not care get the test values of `lettaConfig`.
  const letta = (pkgs as Record<string, unknown> | undefined)?.letta;
  if (letta && typeof letta === "object") patch = { ...patch, packages: { ...(pkgs as object), ...lettaConfig(letta as Record<string, unknown>).packages } };
  const file = path.join(dir, "mergewright.yaml");
  const raw = YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    const cur = raw[k];
    raw[k] = cur && typeof cur === "object" && v && typeof v === "object" && !Array.isArray(v) ? { ...(cur as object), ...(v as object) } : v;
  }
  fs.writeFileSync(file, YAML.stringify(raw));
}

export function mw(cwd: string, args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  // Tests never read the machine's own secrets file.
  return sh(cwd, process.execPath, [MW, ...args], { MW_ENV_FILE: "/dev/null", ...env });
}

export const SPEC = `---
id: auth
title: Authentication
status: accepted
---

### REQ-auth-001 Sign in with email and password
- priority: must
- AC-1: Given a registered user, when they submit valid credentials, then a session starts.
- AC-2: Given a registered user, when they submit a wrong password, then no session starts.

### REQ-auth-002 Sign out
- priority: should
- AC-1: Given a signed-in user, when they sign out, then the session ends.
`;

export function card(id: string, extra: string = "", body = "## Why\n\nBecause.\n"): string {
  return `---\nid: ${id}\ntitle: Card ${id}\nstatus: todo\n${extra}---\n\n${body}`;
}
