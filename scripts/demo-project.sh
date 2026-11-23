#!/usr/bin/env bash
# Make a small demo project to open the GUI on: cards in every interesting column, runs made on the
# mock harness (no agent CLI, no network). The mock scripts go in <dir>/.git/mw-demo/, outside the tree.
#
#   scripts/demo-project.sh <dir>        <dir> must not exist yet, or be empty
#   then:  cd <dir> && MW_MOCK_SCRIPT=$PWD/.git/mw-demo/mock.json mw ui
#
# The cards: DEMO-1 done; DEMO-2 waiting for 'go' (high risk); DEMO-3 blocked (its gate fails; Retry
# in the GUI then passes, since the GUI's runs use the good script); DEMO-4 ready; DEMO-5 todo that
# fails lint when set ready. MW selects the runtime (default: this checkout's bin/mw.js).
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dir=${1:?usage: $0 <dir>}
if [ -e "$dir" ] && [ -n "$(ls -A "$dir")" ]; then echo "demo-project: $dir exists and is not empty" >&2; exit 1; fi
mkdir -p "$dir"
dir=$(cd "$dir" && pwd)
mw() { if [ -n "${MW:-}" ]; then "$MW" "$@"; else node "$repo/bin/mw.js" "$@"; fi; }
cd "$dir"

git init -q -b main
git config user.name "Demo"
git config user.email demo@example.com
git config commit.gpgsign false
mw init --name demo --prefix DEMO >/dev/null

mkdir -p specs src
cat > specs/greeting.spec.md <<'EOF'
---
id: greeting
title: Greeting
status: accepted
---

### REQ-greeting-001 Greet the user by name
- priority: must
- AC-1: Given a name, when the greeting is requested, then the reply contains that name.

### REQ-greeting-002 Say goodbye
- priority: should
- AC-1: Given a signed-in user, when they leave, then the reply says goodbye.
EOF
echo "Hello, {name}!" > src/greet.txt
# A gate that needs only bash: it fails when a file under src/ says BROKEN.
cat > gates/default.gate.sh <<'EOF'
#!/usr/bin/env bash
set -u
OUT=${MERGEWRIGHT_GATE_JSON:-.mergewright/gate.json}; LOGS=${MERGEWRIGHT_GATE_LOGS:-.mergewright/gate-logs}
mkdir -p "$LOGS" "$(dirname "$OUT")"
if grep -rq BROKEN src 2>/dev/null; then ok=false; code=1; echo "src/ says BROKEN" > "$LOGS/check.log"; else ok=true; code=0; echo "src/ checked" > "$LOGS/check.log"; fi
printf '{"ok":%s,"steps":[{"name":"check","kind":"test","ok":%s,"seconds":0,"log":"%s"}]}\n' $ok $ok "$LOGS/check.log" > "$OUT"
exit $code
EOF
chmod +x gates/default.gate.sh
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
git add -A && git commit -q -m "demo: spec, gate, mock roles"

mkdir -p .git/mw-demo
good=.git/mw-demo/mock.json
broken=.git/mw-demo/mock-broken.json
cat > "$good" <<'EOF'
{
  "planner": [{"output": {"summary": "Change the greeting.", "approach": "Edit src/greet.txt.\n\n- keep it short\n- **no** network", "scope": ["src/**"], "acceptance": ["the greeting names the user"], "guards": ["no network"], "docs": [], "risk": "low", "deep_review": false, "ready": true, "blockers": []}}],
  "worker": [{"writes": {"src/greet.txt": "Hello, {name}! Goodbye, {name}.\n"}, "output": {"status": "done", "summary": "Changed the greeting", "changed": ["src/greet.txt"], "verified": ["gate"], "not_done": [], "docs_updated": [], "notes": ""}}],
  "reviewer": [{"output": {"summary": "Looks fine.", "findings": [{"id": "F1", "severity": "low", "blocking": false, "file": "src/greet.txt", "line": 1, "title": "The comma could go", "detail": "A *small* point: the comma after Hello is optional.", "suggestion": "Leave it, or drop it."}]}}],
  "reviewer-deep": [{"output": {"summary": "Looks fine.", "findings": []}}],
  "redteam": [{"output": {"summary": "Looks fine.", "findings": []}}],
  "adjudicator": [{"output": {"verdict": "approve", "summary": "Approve.", "accepted": [], "rejected": [], "instructions": ""}}],
  "reflector": [{"output": {"state": "# State\n\n## Now\n- The greeting is done.\n", "outcome": "Delivered in one round.", "lessons": [{"topic": "greeting", "title": "Greetings name the user", "body": "A greeting always contains the user's name."}], "decisions": []}}],
  "docs-writer": [{"output": {"status": "done", "summary": "No docs needed", "changed": [], "verified": [], "not_done": [], "docs_updated": [], "notes": ""}}]
}
EOF
sed 's|"src/greet.txt": "Hello, {name}! Goodbye, {name}.\\n"|"src/greet.txt": "BROKEN\\n"|' "$good" > "$broken"

card() { mw card new --commit "$@" >/dev/null; }
card --title "Greet the user by name" --implements REQ-greeting-001 --scope "src/**" --why "The product's first feature." \
  --out-of-scope "None" --acceptance "the greeting names the user" --status ready
card --title "Say goodbye" --implements REQ-greeting-002 --scope "src/**" --risk high --why "Users leave too." \
  --out-of-scope "The greeting itself" --acceptance "the reply says goodbye" --status ready
card --title "Shout the greeting" --kind fix --flow quick --scope "src/**" --why "It is too quiet." \
  --out-of-scope "None" --acceptance "the greeting is louder" --status ready
card --title "Tidy the readme" --kind chore --scope "README.md" --why "It repeats itself." \
  --out-of-scope "None" --acceptance "no paragraph says the same thing twice" --status ready --no-docs
card --title "Rename the greeting file" --kind chore --why "greet.txt is vague."

export MW_MOCK_SCRIPT="$dir/$good"
mw run DEMO-1 >/dev/null || true
mw run DEMO-2 >/dev/null || true
MW_MOCK_SCRIPT="$dir/$broken" mw run DEMO-3 >/dev/null || true
mw status
echo
echo "demo project in $dir; open the GUI with:"
echo "  cd $dir && MW_MOCK_SCRIPT=$dir/$good mw ui"
