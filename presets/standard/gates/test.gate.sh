#!/usr/bin/env bash
# MergeWright gate: only the 'test' steps of the default gate.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
default=gates/default.gate.sh; [ -x "$default" ] || default="$here/default.gate.sh"
MERGEWRIGHT_GATE_KINDS=test exec "$default"
