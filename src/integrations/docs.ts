// Documentation files as the integrations send them: each file is read as a git
// blob of one commit (the merged commit, or HEAD), never from the working tree. A symbolic link, a
// submodule, a folder or a binary file is skipped, and a path that leaves the repository or is not
// under docs.paths is refused. Packages reach this through `host.docs`.
import { git, matchesAny, MwError, toPosix } from "../util.ts";

/** Why a documentation path is refused before delivery, or undefined when it may be sent. */
export function badDocPath(rel: string, allowed: readonly string[]): string | undefined {
  if (typeof rel !== "string" || !rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").some((p) => p === ".." || p === ".")) return `'${String(rel)}' is not a plain path inside the repository`;
  if (!matchesAny(rel, allowed)) return `'${rel}' is not under docs.paths`;
  return undefined;
}

/** Extensions of files that are never sent to a documentation service (text sources only). */
export const BINARY_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "zip", "gz", "tgz", "woff", "woff2", "ttf", "otf", "mp3", "mp4", "mov", "wav", "docx", "pptx", "xlsx"];

/** Why a file is binary by its name (a binary extension), or undefined. */
export function binaryByName(rel: string): string | undefined {
  const ext = /\.([^./]+)$/.exec(rel)?.[1]?.toLowerCase();
  return ext && BINARY_EXTENSIONS.includes(ext) ? `${rel} is a binary file (.${ext}), so it was not sent` : undefined;
}

/** Why a file is binary by its content (a NUL byte in its first 8 KB), or undefined. */
export function binaryByContent(rel: string, content: string): string | undefined {
  return content.slice(0, 8192).includes("\0") ? `${rel} is a binary file (it contains NUL bytes), so it was not sent` : undefined;
}

export type DocBlob = { kind: "file"; content: string } | { kind: "missing" } | { kind: "skipped"; why: string };

/** A documentation file as a blob of `commit`: its text, missing (deleted), or skipped (a link, a submodule, a folder, a binary file). */
export function docBlob(root: string, commit: string, rel: string): DocBlob {
  const ls = git(root, ["ls-tree", "-z", commit, "--", rel], { allowFail: true });
  if (ls.code !== 0) throw new Error(`git cannot read commit ${commit.slice(0, 10)}: ${ls.stderr.trim()}`);
  const entry = ls.stdout.split("\0").find((e) => e.endsWith(`\t${rel}`));
  if (!entry) return { kind: "missing" };
  const [mode, type, sha] = entry.slice(0, entry.indexOf("\t")).split(" ");
  if (mode === "120000") return { kind: "skipped", why: `${rel} is a symbolic link in ${commit.slice(0, 10)}, so it was not sent` };
  if (type !== "blob" || !sha) return { kind: "skipped", why: `${rel} is not a file in ${commit.slice(0, 10)}, so it was not sent` };
  const byName = binaryByName(rel);
  if (byName) return { kind: "skipped", why: byName };
  const content = git(root, ["cat-file", "blob", sha]).stdout;
  const byContent = binaryByContent(rel, content);
  return byContent ? { kind: "skipped", why: byContent } : { kind: "file", content };
}

/** Does this repository path count as documentation: under `paths` (docs.paths) and not under `exclude` (docs.exclude)? */
export function isDocPath(rel: string, docs: { readonly paths: readonly string[]; readonly exclude: readonly string[] }): boolean {
  return matchesAny(rel, docs.paths) && !matchesAny(rel, docs.exclude);
}

/** Tracked files of the repository at `root` that count as documentation. */
export function trackedDocFiles(root: string, docs: { readonly paths: readonly string[]; readonly exclude: readonly string[] }): string[] {
  const r = git(root, ["ls-files"], { allowFail: true });
  if (r.code !== 0) throw new MwError("docs/git", "listing documentation files needs a git repository");
  return r.stdout.split("\n").filter(Boolean).map(toPosix).filter((f) => isDocPath(f, docs));
}
