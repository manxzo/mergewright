// `mw init`: make a folder a MergeWright project. Adds what is missing; never overwrites.
import fs from "node:fs";
import path from "node:path";
import { writeIndex } from "./memory.ts";
import { PRESET_DIR, TEMPLATE_DIR } from "./paths.ts";
import { CONFIG_FILE, Project } from "./project.ts";
import { readIfExists, sh, slugify, writeAtomic } from "./util.ts";

export interface InitOptions {
  name?: string;
  prefix?: string;
  /** Also write a small example spec and card. */
  example?: boolean;
}

export interface InitResult {
  root: string;
  name: string;
  prefix: string;
  base: string;
  hub: string;
  added: string[];
  isGit: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function init(dir: string, opts: InitOptions = {}): InitResult {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  const name = opts.name ?? slugify(path.basename(root));
  const letters = name.replace(/[^a-zA-Z]/g, "").slice(0, 4).toUpperCase();
  const prefix = opts.prefix ?? (letters || "CARD");

  const isGit = sh("git", ["rev-parse", "--git-dir"], { cwd: root }).code === 0;
  let base = "main";
  let hub = "none";
  if (isGit) {
    const head = sh("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root }).stdout.trim();
    const originHead = sh("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: root }).stdout.trim().replace(/^origin\//, "");
    base = originHead || head || "main";
    const remotes = sh("git", ["remote"], { cwd: root }).stdout.split("\n").filter(Boolean);
    // Only a remote the owner named "hub" is used as the shared-state hub. "origin" is often a
    // public forge: pushing a lease ref and syncing through it must be the owner's choice.
    hub = remotes.includes("hub") ? "hub" : "none";
  }

  const fill = (text: string) =>
    text.replaceAll("__PROJECT__", name).replaceAll("__PREFIX__", prefix).replaceAll("__BASE_BRANCH__", base).replaceAll("__HUB__", hub);
  const added: string[] = [];
  const put = (rel: string, content: string, mode?: number) => {
    const dst = path.join(root, rel);
    if (fs.existsSync(dst)) return;
    writeAtomic(dst, content, mode);
    added.push(rel);
  };

  for (const src of walk(TEMPLATE_DIR)) {
    const rel = path.relative(TEMPLATE_DIR, src);
    if (rel === "gitignore.append") continue;
    put(rel, fill(fs.readFileSync(src, "utf8")), fs.statSync(src).mode & 0o111 ? 0o755 : undefined);
  }
  // The gate is the one preset file every project is expected to make its own.
  put("gates/default.gate.sh", fs.readFileSync(path.join(PRESET_DIR, "standard", "gates", "default.gate.sh"), "utf8"), 0o755);

  if (opts.example) {
    put("specs/example.spec.md", `---\nid: example\ntitle: Example\nstatus: draft\n---\n\nDelete this file once the project has a real spec.\n\n### REQ-example-001 Greets the user by name\n- priority: should\n- AC-1: Given a name, when the greeting is requested, then the reply contains that name.\n`);
    put(`cards/${prefix}-1.card.md`, `---\nid: ${prefix}-1\ntitle: Greet the user by name\nkind: feature\nstatus: todo\nimplements: [REQ-example-001]\nrevs: {REQ-example-001: 1}\nrisk: low\nscope: ["src/**", "tests/**", "docs/**", "README.md"]\n---\n\n## Why\n\nThe example requirement needs an implementation.\n\n## Out of scope\n\nEverything else.\n`);
  }

  const ignoreFile = path.join(root, ".gitignore");
  const have = (readIfExists(ignoreFile) ?? "").split("\n");
  const want = fs.readFileSync(path.join(TEMPLATE_DIR, "gitignore.append"), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
  const missing = want.filter((l) => !have.includes(l));
  if (missing.length) {
    const cur = readIfExists(ignoreFile) ?? "";
    writeAtomic(ignoreFile, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
  }

  if (fs.existsSync(path.join(root, CONFIG_FILE))) {
    const project = new Project(root);
    if (!fs.existsSync(project.memoryFile("INDEX.md"))) {
      writeIndex(project);
      added.push("memory/INDEX.md");
    }
  }
  return { root, name, prefix, base, hub, added, isGit };
}
