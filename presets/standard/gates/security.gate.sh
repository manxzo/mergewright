#!/usr/bin/env bash
# MergeWright gate: secrets in the change, and known-vulnerable dependencies when a scanner is installed.
# Same contract as the default gate. The secret scan needs only git and works for any language.
set -uo pipefail
OUT=${MERGEWRIGHT_GATE_JSON:-.mergewright/gate.json}
LOGS=${MERGEWRIGHT_GATE_LOGS:-$(dirname "$OUT")/gate-logs}
BASE=${MERGEWRIGHT_BASE:-}
mkdir -p "$LOGS" "$(dirname "$OUT")"
steps=(); failed=0
# JSON string escaping for values that come from the environment (paths).
json() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }
step() {
  local name=$1; shift
  local log="$LOGS/$name.log" t0=$SECONDS ok=true
  if "$@" >"$log" 2>&1; then printf '  ok    %s\n' "$name"; else ok=false; failed=1; printf '  FAIL  %s  (%s)\n' "$name" "$log"; tail -n 15 "$log" | sed 's/^/        /'; fi
  steps+=("{\"name\":\"$name\",\"kind\":\"security\",\"ok\":$ok,\"seconds\":$((SECONDS - t0)),\"log\":$(json "$log")}")
}
have() { command -v "$1" >/dev/null 2>&1; }

# Lines this change adds: against the base branch when known, otherwise everything not yet committed.
added_lines() {
  if [ -n "$BASE" ] && git rev-parse --verify -q "$BASE" >/dev/null; then git diff "$BASE"...HEAD --unified=0 --no-color; git diff HEAD --unified=0 --no-color
  else git diff HEAD --unified=0 --no-color; fi | grep -E '^\+' | grep -vE '^\+\+\+'
}
secret_scan() {
  local hits
  hits=$(added_lines | grep -nE \
    -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
    -e 'AKIA[0-9A-Z]{16}' \
    -e 'gh[pousr]_[A-Za-z0-9]{30,}' \
    -e 'sk-[A-Za-z0-9_-]{24,}' \
    -e 'xox[baprs]-[A-Za-z0-9-]{10,}' \
    -e "(api[_-]?key|secret|token|password|passwd)[\"']?[[:space:]]*[:=][[:space:]]*[\"'][A-Za-z0-9+/_=-]{16,}[\"']" \
    | grep -viE '(example|placeholder|changeme|xxxx|\$\{|<[a-z_-]+>|process\.env|os\.environ)' || true)
  if [ -n "$hits" ]; then echo "possible secrets in added lines (values hidden):"; echo "$hits" | cut -c1-40 | sed 's/$/…/'; return 1; fi
  echo "no secrets found in added lines"
}
git rev-parse --git-dir >/dev/null 2>&1 && step secret-scan secret_scan
[ -f package-lock.json ] && have npm && step js-audit npm audit --omit=dev --audit-level=high
{ [ -f requirements.txt ] || [ -f pyproject.toml ]; } && have pip-audit && step py-audit pip-audit
[ -f Cargo.lock ] && have cargo-audit && step rs-audit cargo audit

[ ${#steps[@]} -eq 0 ] && echo "  ok    nothing to scan"
ok=true; [ $failed = 0 ] || ok=false
(IFS=,; printf '{"ok":%s,"steps":[%s]}\n' "$ok" "${steps[*]:-}") > "$OUT"
exit $failed
