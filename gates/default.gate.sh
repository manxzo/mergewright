#!/usr/bin/env bash
# MergeWright's own gate: the checks a card must pass before it merges.
#
# Contract (specification 4.6):
#   - runs from the directory it is started in (a card's worktree, or the project root)
#   - exits 0 when every step passes, non-zero otherwise
#   - writes {"ok": bool, "steps": [{name, kind, ok, seconds, log}]} to $MERGEWRIGHT_GATE_JSON
#   - writes step logs under $MERGEWRIGHT_GATE_LOGS
#   MERGEWRIGHT_GATE_KINDS=lint,test   run only steps of these kinds (build, types, test, lint)
#
# Steps, in order (gate.required in mergewright.yaml: typecheck, test):
#   install    npm ci --prefer-offline, only when node_modules is missing (a card worktree starts
#              without it; worktrees are not synced)
#   typecheck  npx tsc --noEmit
#   test       node --test over test/**/*.test.ts (hermetic; MW_DELEGATE_ALLOW_MOCK=1 for the mock
#              delegation tests); the step records {"tests": {passed, failed, skipped}}
#   scripts    bash -n on every scripts/*.sh, and sh -n on scripts/install-binary.sh (syntax only, nothing is run)
#   build      npm run build (tsc -p tsconfig.build.json into dist/, which is ignored by git)
set -uo pipefail
OUT=${MERGEWRIGHT_GATE_JSON:-.mergewright/gate.json}
LOGS=${MERGEWRIGHT_GATE_LOGS:-$(dirname "$OUT")/gate-logs}
KINDS=${MERGEWRIGHT_GATE_KINDS:-}
mkdir -p "$LOGS" "$(dirname "$OUT")"
LOGS=$(cd "$LOGS" && pwd)

# The gate gets a minimal environment: put the user's tool folders and the repo's own bins on PATH.
export PATH="$PWD/node_modules/.bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export CI=1 FORCE_COLOR=0 NO_COLOR=1 npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false

steps=(); failed=0
json() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }
want() { [ -z "$KINDS" ] || [[ ",$KINDS," == *",$1,"* ]]; }

# step <kind> <name> <command...>: run, log, record
step() {
  local kind=$1 name=$2; shift 2
  want "$kind" || return 0
  local log="$LOGS/$name.log" t0=$SECONDS ok=true
  if ( "$@" ) >"$log" 2>&1; then printf '  ok    %-10s (%ss)\n' "$name" "$((SECONDS - t0))"
  else ok=false; failed=1; printf '  FAIL  %-10s (%ss)  %s\n' "$name" "$((SECONDS - t0))" "$log"; tail -n 20 "$log" | sed 's/^/        /'; fi
  steps+=("{\"name\":\"$name\",\"kind\":\"$kind\",\"ok\":$ok,\"seconds\":$((SECONDS - t0)),\"log\":$(json "$log")$(extra "$name")}")
}
# skip <kind> <name> <reason>: record a step that could not run here, with the reason
skip() {
  local kind=$1 name=$2 reason=$3
  want "$kind" || return 0
  local log="$LOGS/$name.log"
  printf 'skipped: %s\n' "$reason" >"$log"
  printf '  skip  %-10s (%s)\n' "$name" "$reason"
  steps+=("{\"name\":\"$name\",\"kind\":\"$kind\",\"ok\":true,\"skipped\":true,\"reason\":$(json "$reason"),\"seconds\":0,\"log\":$(json "$log")}")
}
# Test counts of the test step, from the TAP summary node writes next to the dot output.
extra() {
  [ "$1" = test ] || return 0
  local tap="$LOGS/test.tap" p=0 f=0 s=0
  if [ -f "$tap" ]; then
    p=$(sed -n 's/^# pass \([0-9]*\)$/\1/p' "$tap" | tail -n 1); f=$(sed -n 's/^# fail \([0-9]*\)$/\1/p' "$tap" | tail -n 1)
    s=$(sed -n 's/^# skipped \([0-9]*\)$/\1/p' "$tap" | tail -n 1)
  fi
  printf ',"tests":{"passed":%s,"failed":%s,"skipped":%s}' "${p:-0}" "${f:-0}" "${s:-0}"
}
run_tests() {
  # The suite starts gates and `mw` itself: it must not inherit this gate's own MERGEWRIGHT_* paths.
  env -u MERGEWRIGHT_GATE_JSON -u MERGEWRIGHT_GATE_LOGS -u MERGEWRIGHT_GATE_KINDS -u MERGEWRIGHT_BASE \
    MW_DELEGATE_ALLOW_MOCK=1 node --test \
    --test-reporter=dot --test-reporter-destination=stdout \
    --test-reporter=tap --test-reporter-destination="$LOGS/test.tap" \
    'test/**/*.test.ts'
}
check_scripts() {
  local f rc=0
  for f in scripts/*.sh; do bash -n "$f" || { echo "syntax error: $f"; rc=1; }; done
  # The release installer runs under plain sh on the user's machine, so it is checked as sh too.
  if [ -f scripts/install-binary.sh ]; then sh -n scripts/install-binary.sh || { echo "syntax error (sh): scripts/install-binary.sh"; rc=1; }; fi
  return $rc
}

# ── STEPS ────────────────────────────────────────────────────────────────────────────────────
if [ -d node_modules/typescript ]; then
  skip build install "node_modules present"
else
  step build install npm ci --prefer-offline --no-audit --no-fund
fi
step types typecheck npx tsc --noEmit
step test  test      run_tests
step lint  scripts   check_scripts
step build build     npm run build
# ── END STEPS ────────────────────────────────────────────────────────────────────────────────

if [ ${#steps[@]} -eq 0 ]; then
  if [ -n "$KINDS" ]; then echo "  ok    no '$KINDS' checks apply to this project"
  else echo "  FAIL  no checks ran" >&2; failed=1; fi
fi
ok=true; [ $failed = 0 ] || ok=false
(IFS=,; printf '{"ok":%s,"steps":[%s]}\n' "$ok" "${steps[*]:-}") > "$OUT"
exit $failed
