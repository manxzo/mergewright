#!/usr/bin/env bash
# Install the committed MergeWright runtime on this machine and put `mw` on PATH.
#
#   scripts/install.sh            install HEAD of this checkout
#   scripts/install.sh <commit>   install that commit
#
# The runtime is copied out of the working tree (to ~/.local/share/mergewright) so that edits in
# progress, on this machine or arriving by file sync, never change what a running `mw` executes.
# Run it again after pulling new history to update.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ref=${1:-HEAD}
dest=${MW_INSTALL_DIR:-$HOME/.local/share/mergewright}
bin=${MW_BIN_DIR:-$HOME/.local/bin}
commit=$(git -C "$repo" rev-parse --short "$ref")

command -v node >/dev/null || { echo "node is not installed (version 24 or newer is needed)" >&2; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || { echo "node $major is too old: MergeWright needs node 24 or newer" >&2; exit 1; }

stage=$(mktemp -d "${dest}.new.XXXXXX" 2>/dev/null || { mkdir -p "$(dirname "$dest")"; mktemp -d "${dest}.new.XXXXXX"; })
trap 'rm -rf "$stage"' EXIT
git -C "$repo" archive "$ref" | tar -x -C "$stage"
(cd "$stage" && npm ci --omit=dev --silent)
echo "$commit" > "$stage/INSTALLED_COMMIT"
# Replace the old copy in one step, so a running `mw` never sees a half-written tree.
old="${dest}.old.$$"
[ -e "$dest" ] && mv "$dest" "$old"
mv "$stage" "$dest"
rm -rf "$old"
trap - EXIT

mkdir -p "$bin"
cat > "$bin/mw" <<WRAP
#!/bin/sh
exec node "$dest/bin/mw.js" "\$@"
WRAP
chmod +x "$bin/mw"
echo "installed MergeWright $commit in $dest; 'mw' is at $bin/mw"

# REQ-engine-011 AC-3: when this machine has the mw-work@ unit, bring it level with the installed
# ops/mw-work@.service (scripts/install-service.sh renders it; there is no second copy here). That
# needs root: done through passwordless sudo, otherwise the command is printed. Run as root, this script
# installs for root, so the unit (written for the user who runs mw work) is left alone.
if [ "$(id -u)" != 0 ] && ! "$dest/scripts/install-service.sh" unit --check >/dev/null; then
  if command -v sudo >/dev/null && sudo -n true 2>/dev/null; then
    sudo -n "$dest/scripts/install-service.sh" unit || echo "note: the mw-work@ unit could not be updated; run: sudo $dest/scripts/install-service.sh unit"
  else
    echo "note: the installed mw-work@ unit is out of date; update it with: sudo $dest/scripts/install-service.sh unit"
  fi
fi
case ":$PATH:" in *":$bin:"*) ;; *) echo "note: $bin is not on PATH in this shell" ;; esac
