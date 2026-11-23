#!/usr/bin/env bash
# Prove a built `mw` binary works with nothing else from this repository: a fresh HOME and project
# directory, a PATH holding only the binary, git and the shell tools git and a gate need (no node),
# and a card run end to end on the mock harness. One PASS/FAIL line per step; exits 1 on any failure.
#
#   scripts/clean-machine-test.sh <path-to-binary>
#   scripts/clean-machine-test.sh --container [image] <path-to-binary>   the same, inside a fresh
#       container (docker or podman); default image debian:stable-slim, git is installed at start
set -uo pipefail

if [ "${1:-}" = "--container" ]; then
  shift
  image=debian:stable-slim
  [ $# -ge 2 ] && { image=$1; shift; }
  bin=$(cd "$(dirname "${1:?usage: $0 --container [image] <path-to-binary>}")" && pwd)/$(basename "$1")
  self=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
  engine=$(command -v docker || command -v podman) || { echo "FAIL  container: neither docker nor podman is installed" >&2; exit 1; }
  # shortcut: the git install assumes a Debian or Ubuntu image (apt-get); other images need git preinstalled.
  exec "$engine" run --rm -v "$bin:/opt/mw/mw:ro" -v "$self:/opt/mw/clean-machine-test.sh:ro" "$image" sh -c \
    'command -v git >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null; } || exit 1
     command -v bash >/dev/null || { echo "FAIL  container: the image has no bash" >&2; exit 1; }
     exec bash /opt/mw/clean-machine-test.sh /opt/mw/mw'
fi

src=${1:?usage: $0 <path-to-binary>}
[ -x "$src" ] || { echo "FAIL  $src is not an executable file" >&2; exit 1; }
root=$(mktemp -d "${TMPDIR:-/tmp}/mw-clean.XXXXXX")
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin" "$root/home" "$root/greeter"
cp "$src" "$root/bin/mw"
# Only these tools are reachable: git, and what git and the gate below use.
for t in git bash sh env cat mkdir rm mv cp ls grep sed head tail tr wc date dirname basename mktemp printf test true false chmod sleep id uname; do
  p=$(command -v "$t") && ln -sf "$p" "$root/bin/$t"
done
cd "$root/greeter"

failed=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | tail -n 20 | sed 's/^/      /'; failed=1; }
# x <args...>: run in the clean environment (nothing from the caller's environment), output in $out
x() { out=$(env -i HOME="$root/home" PATH="$root/bin" TERM=dumb LANG=C.UTF-8 MW_MOCK_SCRIPT="$root/mock.json" "$@" </dev/null 2>&1); }
# step <name> <regex> <args...>: the command must exit 0 and print a line matching regex
step() { local name=$1 re=$2; shift 2; if x "$@" && grep -qE "$re" <<<"$out"; then pass "$name"; else fail "$name" "$out"; fi; }

if x sh -c 'command -v node'; then fail "no node on PATH" "$out"; else pass "no node on PATH"; fi
step "mw version" '^mergewright [0-9]' mw version
x git init -q -b main && x git config user.name "Clean Machine" && x git config user.email clean@example.com && x git config commit.gpgsign false
step "mw init" "MergeWright project 'greeter'" mw init --name greeter --prefix GR
step "mw check" '^ok: ' mw check

mkdir -p specs
cat > specs/greeting.spec.md <<'EOF'
---
id: greeting
title: Greeting
status: accepted
---

### REQ-greeting-001 Greet the user by name
- priority: must
- AC-1: Given a name, when the greeting is requested, then the reply contains that name.
EOF
# A gate that needs only bash: passes unless src/greet.txt says BROKEN.
cat > gates/default.gate.sh <<'EOF'
#!/usr/bin/env bash
set -u
OUT=${MERGEWRIGHT_GATE_JSON:-.mergewright/gate.json}; LOGS=${MERGEWRIGHT_GATE_LOGS:-.mergewright/gate-logs}
mkdir -p "$LOGS" "$(dirname "$OUT")"
if [ -f src/greet.txt ] && ! grep -q BROKEN src/greet.txt; then ok=true; code=0; else ok=false; code=1; fi
echo "greet file checked" > "$LOGS/check.log"
printf '{"ok":%s,"steps":[{"name":"check","kind":"test","ok":%s,"seconds":0,"log":"%s"}]}\n' $ok $ok "$LOGS/check.log" > "$OUT"
exit $code
EOF
chmod +x gates/default.gate.sh
# Every role on the mock harness.
cat >> mergewright.yaml <<'EOF'
roles:
  planner: {runs: mock}
  worker: {runs: mock}
  reviewer: {runs: mock}
  reviewer-deep: {runs: mock}
  redteam: {runs: mock}
  adjudicator: {runs: mock}
  reflector: {runs: mock}
  docs-writer: {runs: mock}
EOF
cat > "$root/mock.json" <<'EOF'
{
  "planner": [{"output": {"summary": "Add the greeting.", "approach": "Write src/greet.txt.", "scope": ["src/**", "tests/**"], "acceptance": ["the greeting names the user"], "guards": ["no network"], "docs": [], "risk": "low", "deep_review": false, "ready": true, "blockers": []}}],
  "worker": [{"writes": {"src/greet.txt": "Hello, {name}!\n"}, "output": {"status": "done", "summary": "Added the greeting", "changed": ["src/greet.txt"], "verified": ["gate"], "not_done": [], "docs_updated": [], "notes": ""}}],
  "reviewer": [{"output": {"summary": "looks fine", "findings": []}}],
  "reviewer-deep": [{"output": {"summary": "looks fine", "findings": []}}],
  "redteam": [{"output": {"summary": "looks fine", "findings": []}}],
  "adjudicator": [{"output": {"verdict": "approve", "summary": "approve", "accepted": [], "rejected": [], "instructions": ""}}],
  "reflector": [{"output": {"state": "# State\n\n## Now\n- GR-1 is finished.\n", "outcome": "Delivered the greeting in one round.", "lessons": [{"topic": "greeting", "title": "Greetings name the user", "body": "A greeting always contains the user's name."}], "decisions": []}}],
  "docs-writer": [{"output": {"status": "done", "summary": "No docs needed", "changed": [], "verified": [], "not_done": [], "docs_updated": [], "notes": ""}}]
}
EOF
step "mw card new" 'GR-1' mw card new --title "Greet the user by name" --implements REQ-greeting-001 \
  --scope "src/**,tests/**" --why "The product's first feature." --out-of-scope "None"
x git add -A && x git commit -q -m "greeter: spec, card, gate" || fail "commit the project" "$out"
step "mw check (with spec and card)" '^ok: ' mw check
step "mw run GR-1 (mock harness)" 'GR-1 is done: merged into main' mw run GR-1
step "merged file on main" 'Hello' git show main:src/greet.txt
step "mw status" 'GR-1' mw status
step "mw memory search" 'Greetings name the user' mw memory search greeting
step "mw add mem0 --yes" '^installed mem0' mw add mem0 --yes
# Loading never contacts the service, so any address will do.
step "mw config set packages.mem0.url" '' mw config set packages.mem0.url http://127.0.0.1:9
step "mw packages (mem0 loaded)" '^mem0 +[0-9.]+ +enabled +loaded' mw packages
name="mw add without --yes and no TTY is refused"
if x mw add mem0; then fail "$name" "$out"; elif grep -q 'needs your confirmation' <<<"$out"; then pass "$name"; else fail "$name" "$out"; fi

# mw ui: start it, fetch the page without and with the printed token (HTTP over bash's /dev/tcp, so
# no curl is needed), then stop it with Ctrl-C (SIGINT).
http() { # http <port> <path> [cookie]: the whole response in $out
  local port=$1 path=$2 cookie=${3:-}
  exec 3<>"/dev/tcp/127.0.0.1/$port" || { out="(no connection)"; return 1; }
  printf 'GET %s HTTP/1.1\r\nHost: 127.0.0.1:%s\r\nConnection: close\r\n%s\r\n' "$path" "$port" "${cookie:+Cookie: $cookie$'\r\n'}" >&3
  out=$(cat <&3); exec 3<&-
}
env -i HOME="$root/home" PATH="$root/bin" TERM=dumb LANG=C.UTF-8 mw ui --no-open </dev/null >"$root/ui.log" 2>&1 &
ui_pid=$!
url=""
for _ in $(seq 1 50); do url=$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "$root/ui.log" 2>/dev/null) && break; sleep 0.2; done
if [ -z "$url" ]; then fail "mw ui prints its sign-in link" "$(cat "$root/ui.log")"; else
  pass "mw ui prints its sign-in link"
  port=${url#http://127.0.0.1:}; port=${port%%/*}; token=${url#*token=}
  if http "$port" / && grep -q '^HTTP/1.1 401' <<<"$out"; then pass "mw ui: no token is 401"; else fail "mw ui: no token is 401" "$out"; fi
  http "$port" "/?token=$token"
  cookie=$(grep -i '^set-cookie:' <<<"$out" | sed -E 's/^[^:]*: *([^;]*);.*/\1/' | tr -d '\r')
  if grep -q '^HTTP/1.1 303' <<<"$out" && grep -qi '^location: /' <<<"$out" && [ -n "$cookie" ]; then pass "mw ui: the token sets a cookie and redirects"; else fail "mw ui: the token sets a cookie and redirects" "$out"; fi
  if http "$port" / "$cookie" && grep -q '^HTTP/1.1 200' <<<"$out" && grep -q 'src="app.js"' <<<"$out"; then pass "mw ui: the page with the cookie"; else fail "mw ui: the page with the cookie" "$out"; fi
  if http "$port" /app.js "$cookie" && grep -q '^HTTP/1.1 200' <<<"$out" && grep -q 'EventSource' <<<"$out"; then pass "mw ui: the page's main script"; else fail "mw ui: the page's main script" "$out"; fi
fi
kill -INT "$ui_pid" 2>/dev/null; wait "$ui_pid" 2>/dev/null
if grep -q 'mw ui stopped' "$root/ui.log"; then pass "mw ui stops on Ctrl-C"; else fail "mw ui stops on Ctrl-C" "$(cat "$root/ui.log")"; fi

[ $failed = 0 ] && echo "clean-machine test: all steps passed" || echo "clean-machine test: FAILED"
exit $failed
