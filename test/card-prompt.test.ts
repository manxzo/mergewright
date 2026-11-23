// The card as the planner sees it ({{card}}, renderCard): an owner's allow_protected grant, the docs
// to update and the requirements implemented are listed when set, and absent when not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { git, SPEC, write } from "./helpers.ts";
import { project, promptFiles, run, script, useScript } from "./engine-helpers.ts";

async function plannerPrompt(dir: string): Promise<string> {
  useScript(script());
  const s = await run(dir, { until: "implement" });
  assert.equal(s.status, "running");
  const [prompt] = promptFiles(dir, /brief.*\.prompt\.md$/);
  assert.ok(prompt, "the brief phase wrote its prompt");
  return prompt;
}

test("the planner's card lists allow_protected, docs and implements after depends", async () => {
  const dir = project({ cardExtra: "allow_protected: [docs/specification.md, AGENTS.md]\ndocs: [docs/guide.md, docs/api.md]\nimplements: [REQ-auth-001]\nrevs: {REQ-auth-001: 1}\n" });
  write(dir, "specs/auth.spec.md", SPEC);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "spec");
  const prompt = await plannerPrompt(dir);
  assert.match(prompt, /^- allow_protected: docs\/specification\.md, AGENTS\.md$/m);
  assert.match(prompt, /^- docs: docs\/guide\.md, docs\/api\.md$/m);
  assert.match(prompt, /^- implements: REQ-auth-001$/m);
  assert.match(prompt, /- scope: src\/\*\*, docs\/\*\*\n- depends: \(none\)\n- allow_protected: [^\n]+\n- docs: [^\n]+\n- implements: REQ-auth-001\n\n## Why/);
});

test("a card without allow_protected, docs or implements gets no line for them", async () => {
  const prompt = await plannerPrompt(project());
  assert.match(prompt, /- scope: src\/\*\*, docs\/\*\*\n- depends: \(none\)\n\n## Why/);
  assert.doesNotMatch(prompt, /^- (allow_protected|docs|implements):/m);
});
