#!/usr/bin/env bash
# MergeWright gate: the project's checks.
#
# Contract (all a gate must honour):
#   - runs from the directory it is started in (a card's worktree, or the project root)
#   - exits 0 when every step passes, non-zero otherwise
#   - writes a JSON summary to $MERGEWRIGHT_GATE_JSON:
#       {"ok": bool, "steps": [{"name": str, "kind": str, "ok": bool, "seconds": int, "log": path}]}
#     a step that cannot run here adds "skipped": true and "reason": str (see `skip` below); a step
#     listed in gate.required (mergewright.yaml) that is skipped fails the gate
#
# As shipped it detects common stacks and runs their standard checks. Replace the STEPS section
# with this project's real commands; keep the contract.
#   MERGEWRIGHT_GATE_KINDS=lint,test   run only steps of these kinds (lint, types, test, build)
set -uo pipefail
OUT=${MERGEWRIGHT_GATE_JSON:-.mergewright/gate.json}
LOGS=${MERGEWRIGHT_GATE_LOGS:-$(dirname "$OUT")/gate-logs}
KINDS=${MERGEWRIGHT_GATE_KINDS:-}
mkdir -p "$LOGS" "$(dirname "$OUT")"
steps=(); failed=0
# JSON string escaping for values that come from the environment (paths).
json() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }

# step <kind> <name> <command...>: run, log, record
step() {
  local kind=$1 name=$2; shift 2
  if [ -n "$KINDS" ] && [[ ",$KINDS," != *",$kind,"* ]]; then return 0; fi
  local log="$LOGS/$name.log" t0=$SECONDS ok=true
  if "$@" >"$log" 2>&1; then printf '  ok    %s\n' "$name"; else ok=false; failed=1; printf '  FAIL  %s  (%s)\n' "$name" "$log"; tail -n 15 "$log" | sed 's/^/        /'; fi
  steps+=("{\"name\":\"$name\",\"kind\":\"$kind\",\"ok\":$ok,\"seconds\":$((SECONDS - t0)),\"log\":$(json "$log")}")
}
# skip <kind> <name> <reason>: a step that cannot run on this machine, reported as not run, e.g.
#   if [ -n "${DATABASE_URL:-}" ]; then step test db-api npm run test:db; else skip test db-api "DATABASE_URL not set"; fi
skip() {
  local kind=$1 name=$2 reason=$3
  if [ -n "$KINDS" ] && [[ ",$KINDS," != *",$kind,"* ]]; then return 0; fi
  printf '  skip  %s  (%s)\n' "$name" "$reason"
  steps+=("{\"name\":\"$name\",\"kind\":\"$kind\",\"ok\":true,\"seconds\":0,\"skipped\":true,\"reason\":$(json "$reason")}")
}
have() { command -v "$1" >/dev/null 2>&1; }
# missing <kind> <step> <tool>: the stack was detected but its required tool is not installed -> fail loudly
missing() { step "$1" "$2" bash -c "echo '$3 is not installed on this machine; install it or edit the gate' >&2; exit 127"; }
script() { [ -f package.json ] && grep -q "\"$1\"[[:space:]]*:" package.json; }

# ── STEPS ────────────────────────────────────────────────────────────────────────────────────
if [ -f Makefile ] && grep -qE '^check:' Makefile; then
  step test make-check make check                  # a project that defines `make check` owns its gate
else
  if [ -f package.json ]; then
    pm=npm; [ -f pnpm-lock.yaml ] && pm=pnpm; [ -f yarn.lock ] && pm=yarn; [ -f bun.lockb ] && pm=bun
    if [ ! -d node_modules ] && grep -qE '"(dev)?[dD]ependencies"' package.json; then step build js-install $pm install; fi
    script lint      && step lint  js-lint      $pm run lint
    script typecheck && step types js-typecheck $pm run typecheck
    script test      && step test  js-test      $pm run test
    script build     && step build js-build     $pm run build
  fi
  if [ -f pyproject.toml ] || [ -f setup.py ] || [ -f requirements.txt ]; then
    have ruff && step lint py-lint ruff check .
    have mypy && [ -f mypy.ini ] && step types py-types mypy .
    if have pytest; then step test py-test pytest -q
    elif python3 -c 'import pytest' 2>/dev/null; then step test py-test python3 -m pytest -q
    elif [ -d tests ] || compgen -G 'test_*.py' >/dev/null || compgen -G '*_test.py' >/dev/null; then missing test py-test pytest; fi
  fi
  if [ -f Cargo.toml ] && ! have cargo; then missing test rs-test cargo
  elif [ -f Cargo.toml ]; then
    step lint rs-fmt    cargo fmt --check
    step lint rs-clippy cargo clippy --all-targets -- -D warnings
    step test rs-test   cargo test
  fi
  if [ -f go.mod ] && ! have go; then missing test go-test go
  elif [ -f go.mod ]; then
    step lint go-vet  go vet ./...
    step test go-test go test ./...
  fi
  if ls ./*.sh bin/*.sh scripts/*.sh >/dev/null 2>&1 && have shellcheck; then
    step lint sh-lint bash -c 'shellcheck $(ls ./*.sh bin/*.sh scripts/*.sh 2>/dev/null)'
  fi
fi
# ── END STEPS ────────────────────────────────────────────────────────────────────────────────

if [ ${#steps[@]} -eq 0 ]; then
  if [ -n "$KINDS" ]; then echo "  ok    no '$KINDS' checks apply to this project"
  else echo "  FAIL  no checks ran: this project has no gate yet. Edit gates/default.gate.sh." >&2; failed=1; fi
fi
ok=true; [ $failed = 0 ] || ok=false
(IFS=,; printf '{"ok":%s,"steps":[%s]}\n' "$ok" "${steps[*]:-}") > "$OUT"
exit $failed
