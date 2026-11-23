import assert from "node:assert/strict";
import { test } from "node:test";
import { Diagnostics } from "../src/diagnostics.ts";
import { parseSpec } from "../src/model/spec.ts";
import { SPEC } from "./helpers.ts";

const parse = (text: string, file = "specs/auth.spec.md") => {
  const d = new Diagnostics();
  return { spec: parseSpec(file, text, d), codes: d.items.map((x) => x.code), d };
};

test("a well-formed spec parses with no diagnostics", () => {
  const { spec, codes } = parse(SPEC);
  assert.deepEqual(codes, []);
  assert.equal(spec!.requirements.length, 2);
  const r = spec!.requirements[0]!;
  assert.equal(r.id, "REQ-auth-001");
  assert.equal(r.title, "Sign in with email and password");
  assert.equal(r.priority, "must");
  assert.equal(r.rev, 1);
  assert.equal(r.criteria.length, 2);
  assert.equal(r.line, 7);
  assert.equal(spec!.requirements[1]!.line, 12);
});

test("rev and status lines are read", () => {
  const { spec, codes } = parse(SPEC.replace("- priority: should", "- priority: should\n- rev: 3\n- status: deprecated"));
  assert.deepEqual(codes, []);
  assert.equal(spec!.requirements[1]!.rev, 3);
  assert.equal(spec!.requirements[1]!.status, "deprecated");
});

test("each grammar mistake has its own diagnostic", () => {
  assert.deepEqual(parse(SPEC.replace("### REQ-auth-001", "## REQ-auth-001")).codes, ["spec/req-heading"]);
  assert.deepEqual(parse(SPEC.replace("### REQ-auth-001", "### REQ-auth-1")).codes, ["spec/req-heading"]);
  assert.deepEqual(parse(SPEC.replace("REQ-auth-002", "REQ-billing-002")).codes, ["spec/req-prefix"]);
  assert.deepEqual(parse(SPEC.replace("REQ-auth-002", "REQ-auth-001")).codes, ["spec/duplicate-req"]);
  assert.deepEqual(parse(SPEC.replace("- priority: must\n", "")).codes, ["spec/priority"]);
  assert.deepEqual(parse(SPEC.replace("- priority: must", "- priority: urgent")).codes, ["spec/priority", "spec/priority"]);
  assert.deepEqual(parse(SPEC.replace("- AC-1: Given a signed-in user, when they sign out, then the session ends.\n", "")).codes, ["spec/no-criteria"]);
  assert.deepEqual(parse(SPEC.replace("Given a signed-in user, when they sign out, then the session ends.", "The session ends on sign out.")).codes, ["spec/criterion-form"]);
  assert.deepEqual(parse(SPEC.replace("- AC-2:", "- AC-1:")).codes, ["spec/duplicate-criterion"]);
  assert.deepEqual(parse(SPEC.replace("- AC-2:", "- AC two:")).codes, ["spec/criterion-id"]);
  assert.deepEqual(parse(SPEC.replace("status: accepted", "status: final")).codes, ["spec/schema"]);
  assert.deepEqual(parse(SPEC, "specs/login.spec.md").codes, ["spec/file-name"]);
  assert.deepEqual(parse("# no front matter\n").codes, ["spec/front-matter"]);
});

test("a 'could' requirement may have no criteria, and prose is allowed anywhere", () => {
  const text = SPEC + "\nSome closing prose.\n\n### REQ-auth-003 Remember me\n- priority: could\n\nNot decided yet.\n";
  const { spec, codes } = parse(text);
  assert.deepEqual(codes, []);
  assert.equal(spec!.requirements.length, 3);
});

test("requirement-looking text inside a code fence is ignored", () => {
  const text = SPEC + "\n```markdown\n### REQ-auth-999 Example only\n- priority: nonsense\n```\n";
  const { spec, codes } = parse(text);
  assert.deepEqual(codes, []);
  assert.equal(spec!.requirements.length, 2);
});

test("a higher-level heading ends the requirement block", () => {
  const text = SPEC + "\n## Notes\n\n- AC-9: this bullet is not part of any requirement\n";
  const { spec, codes } = parse(text);
  assert.deepEqual(codes, []);
  assert.equal(spec!.requirements[1]!.criteria.length, 1);
});
