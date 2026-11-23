import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ackCard, newCard } from "../src/cards.ts";
import { getConfig, setConfig } from "../src/config.ts";
import { eject } from "../src/eject.ts";
import { mcpsForRole, wireMcps } from "../src/mcpconfig.ts";
import { addDecision, addLesson, allLessons, applyReflection, renderIndex, searchMemory, setState, writeIndex } from "../src/memory.ts";
import { Project } from "../src/project.ts";
import { acceptChange, proposeChange, rejectChange } from "../src/specchange.ts";
import { card, codes, git, mw, newProject, read, SPEC, write } from "./helpers.ts";

const P = (dir: string) => new Project(dir);

test("lessons: added once, updated when the title repeats, indexed", () => {
  const dir = newProject();
  assert.equal(addLesson(P(dir), { topic: "Testing", title: "Run the gate before handing off", body: "It catches most review findings.", card: "DEMO-1" }), "added");
  assert.equal(addLesson(P(dir), { topic: "testing", title: "Seed the database in fixtures", body: "Tests must not depend on order." }), "added");
  assert.equal(addLesson(P(dir), { topic: "testing", title: "run the gate  before handing off!", body: "It catches most findings, and costs seconds.", card: "DEMO-4" }), "updated");
  const lessons = allLessons(P(dir));
  assert.equal(lessons.length, 2);
  const text = read(dir, "memory/lessons/testing.md");
  assert.match(text, /^# Testing\n/);
  assert.match(text, /costs seconds/);
  assert.doesNotMatch(text, /most review findings\./);
  assert.match(text, /- card: DEMO-4/);
  writeIndex(P(dir));
  // An updated lesson keeps its place in the file; only its text and title spelling change.
  assert.match(read(dir, "memory/INDEX.md"), /- lessons\/testing\.md: run the gate before handing off!; Seed the database in fixtures\n/);
  assert.equal(read(dir, "memory/INDEX.md"), renderIndex(P(dir)));
  assert.deepEqual(codes(dir), []);
  assert.throws(() => addLesson(P(dir), { topic: "x", title: "", body: "b" }), /needs a title/);
});

test("state is capped, decisions get dated files", () => {
  const dir = newProject();
  assert.throws(() => setState(P(dir), "# State\n" + "x\n".repeat(151)), /cap is 150/);
  assert.match(read(dir, "memory/STATE.md"), /Project initialised/, "a refused state changes nothing");
  assert.throws(() => setState(P(dir), "no heading"), /must start with/);
  setState(P(dir), "# State\n\n## Now\n- Auth shipped.\n");
  assert.equal(read(dir, "memory/STATE.md"), "# State\n\n## Now\n- Auth shipped.\n");
  const a = addDecision(P(dir), { title: "Use Postgres", body: "Because the team knows it." });
  const b = addDecision(P(dir), { title: "Use Postgres", body: "Confirmed." });
  assert.notEqual(a, b);
  assert.match(a, /^memory\/decisions\/\d{4}-\d{2}-\d{2}-use-postgres\.md$/);
  assert.match(b, /-2\.md$/);
});

test("a reflection updates state, outcome, lessons and index together; a bad one changes nothing", () => {
  const dir = newProject();
  const r = applyReflection(P(dir), "DEMO-1", "Sign in", {
    state: "# State\n\n## Now\n- Sign-in is merged.\n",
    outcome: "Delivered sign-in in one round.",
    lessons: [{ topic: "auth", title: "Hash passwords with the shared helper", body: "A second hashing path was a review finding." }],
    decisions: [{ title: "Sessions last 30 days", body: "Owner decision." }],
  });
  assert.deepEqual(r.lessons.map((l) => l.result), ["added"]);
  assert.match(read(dir, "memory/outcomes/DEMO-1.md"), /^# DEMO-1 Sign in\n/);
  assert.match(read(dir, "memory/INDEX.md"), /outcomes\/DEMO-1\.md: Sign in/);
  assert.match(read(dir, "memory/INDEX.md"), /decisions\/.*sessions-last-30-days\.md: Sessions last 30 days/);
  assert.deepEqual(codes(dir), []);
  assert.throws(() => applyReflection(P(dir), "DEMO-2", "X", { state: "# State\n" + "x\n".repeat(200), outcome: "o", lessons: [{ topic: "t", title: "T", body: "b" }], decisions: [] }), /cap/);
  assert.ok(!fs.existsSync(path.join(dir, "memory/outcomes/DEMO-2.md")));
});

test("memory search ranks by relevance", () => {
  const dir = newProject();
  addLesson(P(dir), { topic: "migrations", title: "Never edit an applied migration", body: "Add a new one instead." });
  addLesson(P(dir), { topic: "testing", title: "Seed fixtures", body: "A migration test needs seeded data." });
  addLesson(P(dir), { topic: "style", title: "Prefer short functions", body: "Readability." });
  const hits = searchMemory(P(dir), "write the migration for orders");
  assert.equal(hits[0]!.title, "Never edit an applied migration");
  assert.equal(hits.length, 2);
  assert.deepEqual(searchMemory(P(dir), "the and for"), []);
});

test("cards: new records requirement revisions; numbering continues", () => {
  const dir = newProject();
  write(dir, "specs/auth.spec.md", SPEC.replace("- priority: must", "- priority: must\n- rev: 2"));
  const id = newCard(P(dir), { title: "Sign in", implements: ["REQ-auth-001"], scope: ["src/**"], why: "Users need accounts.", withDocs: true });
  assert.equal(id, "DEMO-1");
  const text = read(dir, "cards/DEMO-1.card.md");
  assert.match(text, /revs:\n {2}REQ-auth-001: 2|revs: \{REQ-auth-001: 2\}/);
  assert.match(text, /## Why\n\nUsers need accounts\./);
  assert.equal(newCard(P(dir), { title: "Chore", kind: "chore", scope: ["a"], withDocs: true }), "DEMO-2");
  assert.deepEqual(codes(dir), []);
  assert.throws(() => newCard(P(dir), { title: "Bad", implements: ["REQ-auth-404"] }), /not defined by any spec/);
});

test("spec change: modify bumps the revision and flags the cards written against the old one", () => {
  const dir = newProject();
  write(dir, "specs/auth.spec.md", SPEC);
  newCard(P(dir), { title: "Sign in", implements: ["REQ-auth-001"], scope: ["src/**"], withDocs: true });
  newCard(P(dir), { title: "Sign out", implements: ["REQ-auth-002"], scope: ["src/**"], withDocs: true });
  const body = `## Why\n\nLockout was missing.\n\n## modify REQ-auth-001\n### REQ-auth-001 Sign in with email and password\n- priority: must\n- rev: 99\n- AC-1: Given a registered user, when they submit valid credentials, then a session starts.\n- AC-2: Given five wrong passwords, when a sixth is submitted, then the account is locked.\n\nLockout lasts 15 minutes.\n\n## add\n### REQ-auth-003 Remember me\n- priority: could\n\n## deprecate REQ-auth-002\nReplaced by automatic expiry.\n`;
  const rel = proposeChange(P(dir), "auth", "Add lockout", body, "planner");
  assert.match(rel, /^specs\/changes\/CHG-1-add-lockout\.change\.md$/);
  assert.deepEqual(codes(dir), []);
  const r = acceptChange(P(dir), "CHG-1");
  assert.deepEqual(r.changed.map((c) => `${c.req}:${c.op}:${c.rev}`).sort(), ["REQ-auth-001:modify:2", "REQ-auth-002:deprecate:2", "REQ-auth-003:add:1"]);
  assert.deepEqual(r.stale.sort(), ["DEMO-1", "DEMO-2"]);
  const spec = read(dir, "specs/auth.spec.md");
  assert.match(spec, /### REQ-auth-001 Sign in with email and password\n- priority: must\n- rev: 2\n- AC-1: .*\n- AC-2: Given five wrong passwords/);
  assert.match(spec, /Lockout lasts 15 minutes\./, "prose in the new block is kept");
  assert.doesNotMatch(spec, /rev: 99/, "the author cannot set the revision");
  assert.match(spec, /### REQ-auth-002 Sign out\n- priority: should\n- rev: 2\n- status: deprecated\n/);
  assert.match(spec, /Deprecated by CHG-1: Replaced by automatic expiry\./);
  assert.match(spec, /### REQ-auth-003 Remember me\n- priority: could\n$/);
  assert.match(read(dir, rel), /status: accepted/);
  const p = P(dir);
  assert.equal(p.requirements().get("REQ-auth-001")!.rev, 2);
  assert.equal(p.requirements().get("REQ-auth-001")!.criteria.length, 2);
  assert.deepEqual(codes(dir, "error"), []);
  assert.deepEqual(codes(dir, "warning"), ["card/deprecated-requirement", "card/stale", "card/stale"]);
  ackCard(P(dir), "DEMO-1");
  assert.deepEqual(codes(dir, "warning"), ["card/deprecated-requirement", "card/stale"]);
  assert.throws(() => acceptChange(P(dir), "CHG-1"), /already accepted/);
});

test("spec change: invalid proposals are refused, and only the owner accepts", () => {
  const dir = newProject();
  write(dir, "specs/auth.spec.md", SPEC);
  const before = read(dir, "specs/auth.spec.md");
  assert.throws(() => proposeChange(P(dir), "auth", "Dup", "## add\n### REQ-auth-001 Again\n- priority: could\n"), /already exists; the next free id is REQ-auth-003/);
  assert.throws(() => proposeChange(P(dir), "auth", "Bad", "## modify REQ-auth-001\n### REQ-auth-002 Other\n- priority: could\n"), /must be the same requirement/);
  assert.throws(() => proposeChange(P(dir), "auth", "Bad", "## modify REQ-auth-001\n### REQ-auth-001 T\n- priority: must\n- AC-1: not in the right form\n"), /Given/);
  assert.throws(() => proposeChange(P(dir), "auth", "Bad", "## deprecate REQ-billing-001\n"), /not a requirement of spec 'auth'/);
  assert.throws(() => proposeChange(P(dir), "nope", "x", "## add\n"), /does not exist/);
  // A skeleton proposal (no operations yet) is created, and `check` says it is empty.
  const rel = proposeChange(P(dir), "auth", "Later");
  assert.deepEqual(codes(dir), ["change/empty"]);
  rejectChange(P(dir), "CHG-1", "not needed");
  assert.match(read(dir, rel), /status: rejected/);
  assert.deepEqual(codes(dir), []);
  // An agent inside a run may propose but not accept.
  proposeChange(P(dir), "auth", "Agent idea", "## add\n### REQ-auth-003 New\n- priority: could\n");
  process.env.MW_ROLE = "worker";
  try { assert.throws(() => acceptChange(P(dir), "CHG-2"), /accepted by the owner/); } finally { delete process.env.MW_ROLE; }
  assert.equal(read(dir, "specs/auth.spec.md"), before);
  assert.equal(mw(dir, ["spec", "accept", "CHG-2"]).code, 0);
  assert.match(read(dir, "specs/auth.spec.md"), /REQ-auth-003 New/);
});

test("config: set validates, keeps comments, and refuses invalid results", () => {
  const dir = newProject();
  setConfig(P(dir), "limits.rounds", "3");
  assert.equal(getConfig(P(dir), "limits.rounds"), 3);
  assert.equal(P(dir).config.limits.rounds, 3);
  setConfig(P(dir), "roles.worker", "{model: sonnet}");
  assert.equal(P(dir).roles().get("worker")!.model, "sonnet");
  const text = read(dir, "mergewright.yaml");
  assert.match(text, /# fix rounds before a card stops and asks/, "comments survive");
  assert.throws(() => setConfig(P(dir), "risk.default", "extreme"), /would be invalid/);
  assert.throws(() => setConfig(P(dir), "nonsense.key", "1"), /unknown field 'nonsense'/);
  assert.equal(read(dir, "mergewright.yaml"), text, "a refused change leaves the file untouched");
  setConfig(P(dir), "roles.worker", undefined);
  assert.equal(P(dir).roles().get("worker")!.model, "opus");
  assert.equal(mw(dir, ["config", "get", "cards.prefix"]).out.trim(), "DEMO");
});

test("eject copies a preset file; the project's copy then wins", () => {
  const dir = newProject();
  assert.equal(P(dir).roles().get("worker")!.origin, "standard");
  assert.equal(eject(P(dir), "role", "worker"), "roles/worker.role.md");
  write(dir, "roles/worker.role.md", read(dir, "roles/worker.role.md").replace("model: opus", "model: haiku"));
  const p = P(dir);
  assert.equal(p.roles().get("worker")!.origin, "project");
  assert.equal(p.roles().get("worker")!.model, "haiku");
  assert.deepEqual(codes(dir), []);
  assert.throws(() => eject(P(dir), "role", "worker"), /already exists/);
  assert.throws(() => eject(P(dir), "role", "ghost"), /has no role 'ghost' \(it has: .*planner/);
  assert.throws(() => eject(P(dir), "widget", "x"), /cannot eject/);
  assert.equal(eject(P(dir), "flow", "quick"), "flows/quick.flow.yaml");
  assert.equal(eject(P(dir), "gate", "security"), "gates/security.gate.sh");
  assert.ok(fs.statSync(path.join(dir, "gates/security.gate.sh")).mode & 0o100);
});

test("mcp: add, assign to roles, wire per harness, keep secrets out of files", () => {
  const dir = newProject();
  assert.equal(mw(dir, ["mcp", "add", "docs", "--url", "http://docs.example.com:5055/mcp", "--header", "Authorization=Bearer ${NOTEBOOK_TOKEN}", "--roles", "docs-writer,worker", "--description", "Docs search"]).code, 0);
  assert.equal(mw(dir, ["mcp", "add", "files", "--command", "npx -y @scope/files-mcp", "--arg", "--root=.", "--env", "API_KEY=${FILES_KEY}", "--roles", "all"]).code, 0);
  assert.deepEqual(codes(dir), []);
  const p = P(dir);
  assert.deepEqual(mcpsForRole(p, p.roles().get("worker")!).map((m) => m.id), ["docs", "files"]);
  assert.deepEqual(mcpsForRole(p, p.roles().get("reviewer")!).map((m) => m.id), ["files"]);

  assert.throws(() => wireMcps(mcpsForRole(p, p.roles().get("worker")!), {}), /mcp 'docs' needs \$NOTEBOOK_TOKEN/);
  const w = wireMcps(mcpsForRole(p, p.roles().get("worker")!), { NOTEBOOK_TOKEN: "t0k", FILES_KEY: "k3y" });
  assert.deepEqual(w.json.mcpServers.docs, { type: "http", url: "http://docs.example.com:5055/mcp", headers: { Authorization: "Bearer t0k" } });
  assert.deepEqual(w.json.mcpServers.files, { command: "npx", args: ["-y", "@scope/files-mcp", "--root=."], env: { API_KEY: "k3y" } });
  assert.ok(w.codexArgs.includes('mcp_servers.files.command="npx"'));
  assert.ok(w.codexArgs.includes('mcp_servers.files.args=["-y", "@scope/files-mcp", "--root=."]'));
  assert.ok(w.codexArgs.includes('mcp_servers.docs.url="http://docs.example.com:5055/mcp"'));
  assert.deepEqual(w.env, { NOTEBOOK_TOKEN: "t0k", FILES_KEY: "k3y" });

  // A secret written into the file is refused, by the command and by check.
  const bad = mw(dir, ["mcp", "add", "leaky", "--url", "http://x", "--header", "Authorization=Bearer abc123"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /looks like a secret/);
  assert.ok(!fs.existsSync(path.join(dir, "mcps/leaky.mcp.yaml")));
  write(dir, "mcps/leaky.mcp.yaml", "id: leaky\ntransport: stdio\ncommand: x\nenv: {API_TOKEN: abc123}\n");
  assert.deepEqual(codes(dir), ["mcp/literal-secret"]);
  fs.rmSync(path.join(dir, "mcps/leaky.mcp.yaml"));

  assert.equal(mw(dir, ["mcp", "add", "x", "--url", "http://x", "--roles", "ghost"]).code, 1);
  assert.equal(mw(dir, ["mcp", "add", "docs", "--url", "http://y"]).code, 1, "no silent overwrite");
  assert.equal(mw(dir, ["mcp", "add", "both", "--url", "http://y", "--command", "z"]).code, 2);
  const shown = mw(dir, ["mcp", "show", "worker"], { NOTEBOOK_TOKEN: "t0k", FILES_KEY: "k3y" });
  assert.match(shown.out, /gets: docs, files/);
  assert.doesNotMatch(shown.out, /t0k|k3y/, "show never prints secret values");
  assert.equal(mw(dir, ["mcp", "remove", "files"]).code, 0);
  assert.deepEqual(mcpsForRole(P(dir), P(dir).roles().get("reviewer")!), []);
  // A role can also ask for a server by name.
  write(dir, "roles/reviewer.role.md", "---\nid: reviewer\nruns: codex\nmode: read\noutput: findings\nmcps: [docs]\n---\nReview {{diff}}.\n");
  assert.deepEqual(mcpsForRole(P(dir), P(dir).roles().get("reviewer")!).map((m) => m.id), ["docs"]);
  void git; void card;
});

// ── Regression tests for defects found in review ───────────────────────────────────────────

test("ids are never used as paths: traversal is refused", () => {
  const dir = newProject();
  const outside = path.join(path.dirname(dir), "victim.mcp.yaml");
  fs.writeFileSync(outside, "id: victim\n");
  try {
    const rm = mw(dir, ["mcp", "remove", "../../" + path.basename(dir) + "/../victim"]);
    assert.equal(rm.code, 2);
    assert.ok(fs.existsSync(outside), "a file outside the project is not deleted");
    assert.equal(mw(dir, ["mcp", "remove", "../victim"]).code, 2);
    assert.equal(mw(dir, ["mcp", "add", "../evil", "--url", "http://x"]).code, 2);
    assert.throws(() => eject(P(dir), "role", "../../standard/roles/planner"), /not a valid role id/);
    assert.ok(!fs.existsSync(path.join(dir, "..", "standard")));
  } finally {
    fs.rmSync(outside, { force: true });
  }
  // A card file whose id is not a card id is reported and then ignored, so it can never name a path.
  write(dir, "cards/weird.card.md", "---\nid: ../../x\ntitle: T\nstatus: todo\n---\n\n## Why\n\nx\n");
  assert.deepEqual(P(dir).cards(), []);
  assert.ok(codes(dir).includes("card/schema"));
});

test("a change may touch each requirement once", () => {
  const dir = newProject();
  write(dir, "specs/auth.spec.md", SPEC);
  const twice = "## modify REQ-auth-001\n### REQ-auth-001 First\n- priority: must\n- AC-1: Given A, when B, then C.\n\n## deprecate REQ-auth-001\nSuperseded.\n";
  assert.throws(() => proposeChange(P(dir), "auth", "Twice", twice), /appears in more than one operation/);
  const addTwice = "## add\n### REQ-auth-003 A\n- priority: could\n\n## add\n### REQ-auth-003 B\n- priority: could\n";
  assert.throws(() => proposeChange(P(dir), "auth", "Add twice", addTwice), /appears in more than one operation/);
  // A hand-written proposal with the same mistake is refused at accept time and the spec is untouched.
  write(dir, "specs/changes/CHG-1-twice.change.md", `---\nid: CHG-1\nspec: auth\nstatus: proposed\nsummary: Twice\n---\n\n${twice}`);
  assert.throws(() => acceptChange(P(dir), "CHG-1"), /more than one operation/);
  assert.equal(read(dir, "specs/auth.spec.md"), SPEC);
});

test("accepting a change replaces the spec and the proposal together, or neither", () => {
  const dir = newProject();
  write(dir, "specs/auth.spec.md", SPEC);
  proposeChange(P(dir), "auth", "Add remember me", "## add\n### REQ-auth-003 Remember me\n- priority: could\n");
  // Make the proposal's folder unwritable: staging its new content fails before the spec is replaced.
  const changes = path.join(dir, "specs/changes");
  fs.chmodSync(changes, 0o555);
  try {
    assert.throws(() => acceptChange(P(dir), "CHG-1"));
  } finally {
    fs.chmodSync(changes, 0o755);
  }
  assert.equal(read(dir, "specs/auth.spec.md"), SPEC, "the spec is unchanged when the proposal cannot be marked");
  assert.match(read(dir, "specs/changes/CHG-1-add-remember-me.change.md"), /status: proposed/);
  assert.deepEqual(fs.readdirSync(path.join(dir, "specs")).filter((n) => n.includes(".tmp")), [], "no staging files are left behind");
  acceptChange(P(dir), "CHG-1");
  assert.match(read(dir, "specs/auth.spec.md"), /REQ-auth-003 Remember me/);
});

test("the secret check covers common credential names and literal bearer values; show hides every value", () => {
  const dir = newProject();
  for (const [name, value] of [["X-Auth", "hunter2"], ["X-Credential", "abc"], ["Session", "abc"], ["X-Custom", "Bearer abc123"]] as const) {
    write(dir, "mcps/p.mcp.yaml", `id: p\ntransport: http\nurl: https://example.test/mcp\nheaders:\n  ${name}: "${value}"\nroles: all\n`);
    assert.deepEqual(codes(dir), ["mcp/literal-secret"], `${name}: ${value}`);
  }
  write(dir, "mcps/p.mcp.yaml", 'id: p\ntransport: http\nurl: https://example.test/mcp\nheaders:\n  Accept: application/json\n  X-Auth: "${P_AUTH}"\nroles: all\n');
  assert.deepEqual(codes(dir), []);
  const shown = mw(dir, ["mcp", "show", "worker"], { P_AUTH: "hunter2" });
  assert.equal(shown.code, 0);
  assert.doesNotMatch(shown.out, /hunter2|application\/json/);
  assert.match(shown.out, /"X-Auth": "<set>"/);
});

test("lesson files: headings inside code fences are text, and duplicate titles are never dropped", () => {
  const dir = newProject();
  const original = "# Parsing\n\n## Preserve examples\n\n```md\n## This is sample output\n```\nDo not treat it as a lesson.\n\n## Retry\n\nFirst lesson.\n\n## Retry\n\nSecond lesson.\n";
  write(dir, "memory/lessons/parsing.md", original);
  assert.equal(addLesson(P(dir), { topic: "parsing", title: "New", body: "Text" }), "added");
  const text = read(dir, "memory/lessons/parsing.md");
  assert.match(text, /## Preserve examples\n\n```md\n## This is sample output\n```\nDo not treat it as a lesson\./);
  assert.match(text, /First lesson\./);
  assert.match(text, /Second lesson\./);
  assert.deepEqual(allLessons(P(dir)).map((l) => l.title), ["Preserve examples", "Retry", "Retry", "New"]);
  // Updating a title that exists twice replaces the first and keeps the other.
  assert.equal(addLesson(P(dir), { topic: "parsing", title: "retry", body: "Merged." }), "updated");
  const after = read(dir, "memory/lessons/parsing.md");
  assert.match(after, /Merged\./);
  assert.doesNotMatch(after, /First lesson\./);
  assert.match(after, /Second lesson\./);
});

test("a reflection applied twice (a repeated phase) leaves one copy of everything", () => {
  const dir = newProject();
  const r = { state: "# State\n\n- Done.\n", outcome: "Delivered.", lessons: [{ topic: "auth", title: "Use the helper", body: "Reason." }], decisions: [{ title: "Sessions last 30 days", body: "Owner decision." }] };
  applyReflection(P(dir), "DEMO-1", "Sign in", r);
  const once = fs.readdirSync(path.join(dir, "memory/decisions")).sort();
  const index = read(dir, "memory/INDEX.md");
  applyReflection(P(dir), "DEMO-1", "Sign in", r);
  assert.deepEqual(fs.readdirSync(path.join(dir, "memory/decisions")).sort(), once);
  assert.equal(read(dir, "memory/INDEX.md"), index);
  assert.equal(allLessons(P(dir)).length, 1);
  // The same title from a different card is a different decision.
  applyReflection(P(dir), "DEMO-2", "Other", r);
  assert.equal(fs.readdirSync(path.join(dir, "memory/decisions")).filter((n) => n.endsWith(".md")).length, 2);
});

test("a reflection never writes a credential into memory", () => {
  const dir = newProject();
  applyReflection(P(dir), "DEMO-1", "Sign in", {
    state: "# State\n\n- Deployed with token ghp_abcdefghijklmnopqrstuvwxyz0123456789.\n",
    outcome: "Used api_key = \"sk_live_abcdefghijklmnop1234\" during the test.",
    lessons: [{ topic: "ops", title: "Rotate keys", body: "The header was Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature and AKIAABCDEFGHIJKLMNOP leaked." }],
    decisions: [],
  });
  const all = read(dir, "memory/STATE.md") + read(dir, "memory/outcomes/DEMO-1.md") + read(dir, "memory/lessons/ops.md");
  assert.doesNotMatch(all, /ghp_abcdef|sk_live_abcdef|eyJhbGci|AKIAABCDEF/);
  assert.equal((all.match(/\[redacted\]/g) ?? []).length, 4);
  assert.match(all, /Rotate keys/);
});
