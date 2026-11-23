#!/usr/bin/env bash
# MergeWright gate: only the 'lint' steps of the default gate.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
default=gates/default.gate.sh; [ -x "$default" ] || default="$here/default.gate.sh"
MERGEWRIGHT_GATE_KINDS=lint exec "$default"
