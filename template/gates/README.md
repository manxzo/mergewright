# Gates

`default.gate.sh` is this project's gate: make it run the real checks. A gate is any executable that exits
non-zero on failure and writes its JSON summary to `$MERGEWRIGHT_GATE_JSON`. Flows call gates by name.
