#!/usr/bin/env bash
# Build `mw` as one self-contained executable for this platform (Node's single-executable
# applications). The runtime is bundled; schemas/, presets/, template/, ops/, packages/,
# src/ui/web/ (the page of mw ui), scripts/install-service.sh and package.json are embedded and unpacked into ~/.cache/mergewright/sea-<hash>/ on first use.
#
#   scripts/build-binary.sh   -> build/mw-<platform>-<arch> (e.g. mw-linux-x64, mw-darwin-arm64),
#                                build/mw (a symlink to it) and build/SHA256SUMS
# It copies the node that runs it, so it cannot cross-build: run it on each target platform.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"
out=build
command -v node >/dev/null || { echo "build-binary: node is not installed; the build needs node 24.x" >&2; exit 1; }
node_version=$(node -p process.versions.node)
case $node_version in
  24.*) ;;
  *) echo "build-binary: node $node_version is running this build; the binary embeds the node that builds it and needs node 24.x" >&2; exit 1 ;;
esac
target=$(node -p 'process.platform + "-" + process.arch')
bin=$out/mw-$target
rm -rf "$out" && mkdir -p "$out"
commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)

# 1. One CommonJS file (single executables run CommonJS). import.meta.url is given a value so
#    code that resolves paths from it keeps working; the single-executable path does not use it.
npx esbuild src/sea-entry.ts --bundle --platform=node --format=cjs --target=node24 \
  --outfile="$out/mw.cjs" --log-level=warning \
  --define:import.meta.url=__mwImportMetaUrl \
  --banner:js="const __mwImportMetaUrl = require('node:url').pathToFileURL(__filename).href;"

# 2. The files the runtime reads at run time, as one manifest.
node -e '
const fs = require("node:fs"), path = require("node:path");
const out = {};
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else out[p] = fs.readFileSync(p).toString("base64"); } };
for (const d of ["schemas", "presets", "template", "ops", "packages", "src/ui/web"]) if (fs.existsSync(d)) walk(d);
out["scripts/install-service.sh"] = fs.readFileSync("scripts/install-service.sh").toString("base64");
out["package.json"] = fs.readFileSync("package.json").toString("base64");
out["INSTALLED_COMMIT"] = Buffer.from(process.argv[1] + "\n").toString("base64");
fs.writeFileSync(process.argv[2], JSON.stringify(out));
' "$commit" "$out/assets.json"

# 3. The blob, then inject it into a copy of this machine's node.
cat > "$out/sea-config.json" <<JSON
{ "main": "$out/mw.cjs", "output": "$out/sea-prep.blob", "disableExperimentalSEAWarning": true,
  "assets": { "assets.json": "$out/assets.json" } }
JSON
node --experimental-sea-config "$out/sea-config.json" 2>&1 | grep -v "^$" || true
cp "$(command -v node)" "$bin"
chmod u+w "$bin"
if [ "$(uname -s)" = Darwin ]; then
  # macOS (Node's single-executable docs): drop node's signature, inject into the NODE_SEA
  # segment, then sign ad hoc so the binary runs.
  codesign --remove-signature "$bin"
  npx postject "$bin" NODE_SEA_BLOB "$out/sea-prep.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA >/dev/null
  codesign --sign - "$bin"
else
  npx postject "$bin" NODE_SEA_BLOB "$out/sea-prep.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 >/dev/null
fi
rm -f "$out/sea-prep.blob"
ln -sf "$(basename "$bin")" "$out/mw"   # existing callers keep using build/mw
(cd "$out" && if command -v sha256sum >/dev/null; then sha256sum "$(basename "$bin")"; else shasum -a 256 "$(basename "$bin")"; fi > SHA256SUMS)
echo "built $bin ($(du -h "$bin" | cut -f1), commit $commit, node $node_version embedded, $target)"
