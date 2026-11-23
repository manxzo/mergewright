#!/bin/sh
# Install the `mw` single executable from a GitHub release. Read it before you run it:
#
#   curl -fsSLO https://raw.githubusercontent.com/manxzo/mergewright/main/scripts/install-binary.sh
#   less install-binary.sh && sh install-binary.sh
#
# It picks the release asset for this machine (mw-linux-x64 or mw-linux-arm64),
# downloads it with the release's SHA256SUMS, refuses to install when the checksum does not match,
# and puts it at $MW_INSTALL_DIR/mw (default ~/.local/bin/mw). Nothing else is changed.
#
#   MW_REPO       GitHub repository to install from (default manxzo/mergewright)
#   MW_BASE_URL   where the assets are (default: the repository's latest release)
#   MW_INSTALL_DIR  where to put mw (default ~/.local/bin)
set -eu
repo=${MW_REPO:-manxzo/mergewright}
base=${MW_BASE_URL:-https://github.com/$repo/releases/latest/download}
dir=${MW_INSTALL_DIR:-$HOME/.local/bin}

die() { echo "install-binary: $*" >&2; exit 1; }

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) die "macOS is not supported yet: MergeWright's run locks read /proc, which macOS does not have" ;;
  *) die "there is no mw release for $(uname -s); install with npm (npm i -g mergewright) on Node 24 instead" ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "there is no mw release for the $(uname -m) processor; install with npm (npm i -g mergewright) on Node 24 instead" ;;
esac
asset=mw-$os-$arch
[ "$asset" != mw-darwin-x64 ] || die "there is no mw release for Intel Macs; install with npm (npm i -g mergewright) on Node 24 instead"

if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -q -O "$2" "$1"; }
else die "neither curl nor wget is installed; install one and run this again"; fi
if command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "neither sha256sum nor shasum is installed, so the download cannot be checked"; fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
echo "downloading $asset from $base"
fetch "$base/$asset" "$tmp/mw" || die "could not download $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "could not download $base/SHA256SUMS"
want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || die "SHA256SUMS has no entry for $asset; nothing was installed"
got=$(sum "$tmp/mw")
[ "$got" = "$want" ] || die "the checksum of $asset does not match SHA256SUMS (expected $want, got $got); nothing was installed"

mkdir -p "$dir"
chmod 755 "$tmp/mw"
mv "$tmp/mw" "$dir/mw.new.$$" && mv "$dir/mw.new.$$" "$dir/mw"
echo "installed $asset at $dir/mw (sha256 $got)"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "note: $dir is not on PATH; add it, for example: export PATH=\"$dir:\$PATH\"" ;;
esac
