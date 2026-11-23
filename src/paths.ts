// Where the framework's own files live: from a checkout, from an installed package, or from a
// single-executable build (where they are embedded and unpacked once per version).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath } from "node:url";

export const SPEC_VERSION = "0.1";

function fromSea(): string | undefined {
  if (!isSea()) return undefined;
  // scripts/build-binary.sh embeds schemas/, presets/, template/, ops/, packages/, src/ui/web/, package.json and INSTALLED_COMMIT
  // as one manifest {path: base64}. It is written out once per distinct build, then reused.
  const manifest = Buffer.from(getAsset("assets.json")).toString("utf8");
  const tag = createHash("sha256").update(manifest).digest("hex").slice(0, 12);
  const root = path.join(process.env.MW_SEA_DIR ?? path.join(os.homedir(), ".cache", "mergewright"), `sea-${tag}`);
  if (!fs.existsSync(path.join(root, ".complete"))) {
    const files = JSON.parse(manifest) as Record<string, string>;
    const tmp = `${root}.${process.pid}`;
    for (const [rel, b64] of Object.entries(files)) {
      const target = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(b64, "base64"), { mode: rel.endsWith(".sh") ? 0o755 : 0o644 });
    }
    fs.writeFileSync(path.join(tmp, ".complete"), "");
    try {
      fs.renameSync(tmp, root);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true }); // another process finished first
    }
  }
  return root;
}

/** Root of the MergeWright package: the folder holding schemas/, presets/ and template/. */
export const PACKAGE_ROOT = fromSea() ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_DIR = path.join(PACKAGE_ROOT, "schemas");
export const PRESET_DIR = path.join(PACKAGE_ROOT, "presets");
export const TEMPLATE_DIR = path.join(PACKAGE_ROOT, "template");
/** Operations files shipped with the runtime (the mw-work service unit). */
export const OPS_DIR = path.join(PACKAGE_ROOT, "ops");
/** The GUI's page (`mw ui`): plain HTML, CSS and ES modules, embedded in the binary like the folders above. */
export const UI_DIR = path.join(PACKAGE_ROOT, "src", "ui", "web");

/** How to start this same runtime again: the single executable, or node with the package's launcher. */
export function selfCommand(): { command: string; args: string[] } {
  return isSea() ? { command: process.execPath, args: [] } : { command: process.execPath, args: [path.join(PACKAGE_ROOT, "bin", "mw.js")] };
}

/**
 * Where this runtime comes from, for `mw version`: "installed from commit X" (scripts/install.sh
 * records INSTALLED_COMMIT), "running from a checkout" (the package folder is a git checkout), or
 * "installed from the npm package <version>".
 */
export function runtimeOrigin(root: string = PACKAGE_ROOT): string {
  let commit = "";
  try {
    commit = fs.readFileSync(path.join(root, "INSTALLED_COMMIT"), "utf8").trim();
  } catch {
    // not made by scripts/install.sh
  }
  if (commit) return `installed from commit ${commit}`;
  if (fs.existsSync(path.join(root, ".git"))) return "running from a checkout";
  let version = "?";
  try {
    version = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string }).version ?? "?";
  } catch {
    // no readable package.json
  }
  return `installed from the npm package ${version}`;
}
