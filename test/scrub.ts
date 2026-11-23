// Private-detail scan shared by test/scrub.test.ts and scripts/scrub-update.ts.
// Generic patterns live here; the author's own list stays outside the repository and is read
// from the file named by MW_SCRUB_TERMS (extended regular expressions, one per line, # comments).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PACKAGE_ROOT } from "../src/paths.ts";

export const ALLOWLIST = "test/scrub-allowlist.txt";
const SKIP = new Set([ALLOWLIST, "package-lock.json"]);

// The sources below are written so that their own text never matches them.
export const GENERIC: RegExp[] = [
  /(?<![\d.])10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/g,
  /(?<![\d.])172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/g,
  /(?<![\d.])192\.168\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/g,
  // Tailscale and carrier-grade NAT, the 100.64/10 block.
  /(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/g,
  /[a-z0-9-]\.lan\b/gi,
  /\/home\/(?!(?:me|user|you|alice|bob|example)\/)[a-z_][a-z0-9_.-]*\//g,
];

/** Patterns from the MW_SCRUB_TERMS file, or none when the variable is unset. */
export function privateTerms(): RegExp[] {
  const f = process.env.MW_SCRUB_TERMS;
  if (!f) return [];
  const file = f.startsWith("~/") ? path.join(os.homedir(), f.slice(2)) : f;
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new RegExp(l, "gi"));
}

export function countHits(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const p of patterns) n += text.match(p)?.length ?? 0;
  return n;
}

/** Hit count per tracked text file, only files with hits. */
export function scan(patterns: RegExp[] = [...GENERIC, ...privateTerms()], root = PACKAGE_ROOT): Map<string, number> {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  const hits = new Map<string, number>();
  for (const rel of r.stdout.split("\0")) {
    if (!rel || SKIP.has(rel)) continue;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(root, rel));
    } catch {
      continue; // deleted in the working tree, not yet committed
    }
    if (buf.includes(0)) continue; // binary
    const n = countHits(buf.toString("utf8"), patterns);
    if (n > 0) hits.set(rel, n);
  }
  return hits;
}

export function readAllowlist(root = PACKAGE_ROOT): Map<string, number> {
  const m = new Map<string, number>();
  const f = path.join(root, ALLOWLIST);
  if (!fs.existsSync(f)) return m;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.lastIndexOf(":");
    m.set(t.slice(0, i), Number(t.slice(i + 1)));
  }
  return m;
}

export function formatAllowlist(hits: Map<string, number>): string {
  const head =
    "# Private-detail hits still allowed per tracked file (path:count). Counts may only go down.\n" +
    "# Regenerate with: MW_SCRUB_TERMS=<terms file> npm run scrub:update\n";
  return head + [...hits].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, n]) => `${p}:${n}\n`).join("");
}
