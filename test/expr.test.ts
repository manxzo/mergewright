import assert from "node:assert/strict";
import { test } from "node:test";
import { checkExpr, evalExpr } from "../src/expr.ts";

test("risk levels compare by rank", () => {
  assert.equal(evalExpr("risk >= high", { risk: "high" }), true);
  assert.equal(evalExpr("risk >= high", { risk: "critical" }), true);
  assert.equal(evalExpr("risk >= high", { risk: "medium" }), false);
  assert.equal(evalExpr("risk < medium", { risk: "low" }), true);
  assert.equal(evalExpr("risk == medium", { risk: "medium" }), true);
});

test("and, or, not and parentheses", () => {
  const v = { risk: "low", deep_review: true, "findings.blocking": 0, kind: "docs" };
  assert.equal(evalExpr("deep_review or risk >= high", v), true);
  assert.equal(evalExpr("deep_review and risk >= high", v), false);
  assert.equal(evalExpr("not deep_review", v), false);
  assert.equal(evalExpr("findings.blocking > 0 or (kind == docs and not never)", v), true);
  assert.equal(evalExpr("always", {}), true);
  assert.equal(evalExpr("never", {}), false);
  assert.equal(evalExpr("deep_review == false", v), false);
});

test("a value that is not known yet makes its comparison false", () => {
  assert.equal(evalExpr("findings.blocking > 0", {}), false);
  assert.equal(evalExpr("gate.ok", {}), false);
});

test("mistakes are reported in words", () => {
  assert.match(checkExpr("risk >= hihg")!, /not a risk level/);
  assert.match(checkExpr("rsik >= high")!, /unknown variable 'rsik'/);
  assert.match(checkExpr("risk")!, /compare it/);
  assert.match(checkExpr("round > two")!, /is a number/);
  assert.match(checkExpr("kind > docs")!, /only be compared with == or !=/);
  assert.match(checkExpr("(risk >= high")!, /missing '\)'/);
  assert.match(checkExpr("risk >= high high")!, /unexpected 'high'/);
  assert.match(checkExpr("risk >= ")!, /missing value/);
  assert.match(checkExpr("risk >= high; rm")!, /unexpected character/);
  assert.equal(checkExpr("findings.blocking > 0 or risk >= high"), undefined);
});
