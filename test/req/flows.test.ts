// Minimum stops by risk (specs/flows.spec.md): a high or critical card waits for `go`
// before the flow's first writing phase and for `merge` before its merge phase in every flow, not only
// in the flows that declare those stops; the dry run shows the stops the runtime adds and why.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Diagnostics } from "../../src/diagnostics.ts";
import { checkExpr, evalExpr, RISK_LEVELS } from "../../src/expr.ts";
import { parseFlow } from "../../src/model/flow.ts";
import { stopPlan } from "../../src/engine/run.ts";
import { Project } from "../../src/project.ts";
import { git, mw, write } from "../helpers.ts";
import { phases, project, run, script, state, useScript } from "../engine-helpers.ts";

/** Runs DEMO-1 with the CLI; returns the output and the run state. */
function cli(dir: string, args: string[], env: Record<string, string>) {
  const r = mw(dir, args, env);
  assert.equal(r.code, 0, r.err);
  return { out: r.out, s: state(dir) };
}

const waits = (dir: string) => state(dir).history.filter((h) => h.outcome === "waiting").map((h) => `${h.phase}:${h.detail}`);

// @req REQ-flows-001
test("REQ-flows-001: a critical docs card waits for 'go' before the write phase and 'merge' before the merge", () => {
  const dir = project({ kind: "docs", cardExtra: "risk: critical\n" });
  const env = { MW_MOCK_SCRIPT: useScript(script()) };
  const main = git(dir, "rev-parse", "main");
  let r = cli(dir, ["run", "DEMO-1"], env);
  assert.equal(r.s.flow, "docs");
  assert.equal(r.s.status, "waiting");
  assert.equal(r.s.reason, "go");
  assert.deepEqual(phases(r.s), ["write:waiting"], "nothing ran before the go");
  assert.match(r.out, /waiting before 'write' for approval 'go'/);

  r = cli(dir, ["approve", "DEMO-1", "go"], env);
  assert.equal(r.s.status, "waiting", r.s.reason);
  assert.equal(r.s.reason, "merge");
  assert.equal(r.s.flow, "docs");
  assert.deepEqual(phases(r.s).slice(-1), ["merge:waiting"]);
  assert.equal(git(dir, "rev-parse", "main"), main, "nothing merged before the merge approval");

  r = cli(dir, ["approve", "DEMO-1", "merge"], env);
  assert.equal(r.s.status, "done", r.s.reason);
  assert.ok(r.s.merged);
  assert.deepEqual(waits(dir), ["write:waiting for approval 'go'", "merge:waiting for approval 'merge'"]);
});

// @req REQ-flows-001
test("REQ-flows-001: a critical spike card waits for 'go' only (the spike flow has no merge phase)", () => {
  const dir = project({ kind: "spike", cardExtra: "risk: critical\n" });
  const env = { MW_MOCK_SCRIPT: useScript(script()) };
  let r = cli(dir, ["run", "DEMO-1"], env);
  assert.equal(r.s.flow, "spike");
  assert.equal(r.s.status, "waiting");
  assert.equal(r.s.reason, "go");
  assert.deepEqual(phases(r.s), ["explore:waiting"]);

  r = cli(dir, ["approve", "DEMO-1", "go"], env);
  assert.equal(r.s.status, "done", r.s.reason);
  assert.equal(r.s.merged, undefined);
  assert.deepEqual(waits(dir), ["explore:waiting for approval 'go'"]);
});

// @req REQ-flows-001
test("REQ-flows-001: 'mw work --approve go,merge' grants the added stops in advance", async () => {
  const dir = project({ kind: "docs", cardExtra: "risk: high\n" });
  useScript(script());
  const s = await run(dir, { approve: ["go", "merge"] });
  assert.equal(s.status, "done", s.reason);
  assert.ok(s.merged);
  assert.deepEqual(s.approvals, ["write:go", "merge:merge"]);
});

for (const risk of ["low", "medium"]) {
  for (const kind of ["docs", "spike"]) {
    // @req REQ-flows-001
    test(`REQ-flows-001: a ${risk} ${kind} card gets no stop from the runtime`, async () => {
      const dir = project({ kind, cardExtra: `risk: ${risk}\n` });
      useScript(script());
      const s = await run(dir);
      assert.equal(s.flow, kind);
      assert.equal(s.status, "done", s.reason);
      assert.deepEqual(s.history.filter((h) => h.outcome === "waiting"), []);
      assert.deepEqual(s.approvals, []);
    });
  }
}

// @req REQ-flows-001
test("REQ-flows-001: a high card on the standard flow waits once for 'go' and once for 'merge'", () => {
  const dir = project({ cardExtra: "risk: high\n" });
  const env = { MW_MOCK_SCRIPT: useScript(script()) };
  let r = cli(dir, ["run", "DEMO-1"], env);
  assert.equal(r.s.flow, "standard");
  assert.equal(r.s.reason, "go");
  r = cli(dir, ["approve", "DEMO-1", "go"], env);
  assert.equal(r.s.reason, "merge", r.s.reason);
  r = cli(dir, ["approve", "DEMO-1", "merge"], env);
  assert.equal(r.s.status, "done", r.s.reason);
  assert.deepEqual(waits(dir), ["implement:waiting for approval 'go'", "merge:waiting for approval 'merge'"]);
  assert.deepEqual(r.s.approvals, ["implement:go", "merge:merge"]);

  const p = new Project(dir);
  const flow = p.flows().get("standard")!;
  const ctx = { flow, roles: p.roles(), risk: "high" as const };
  const asks = flow.phases.map((ph) => `${ph.id}:${stopPlan(ph, ctx).stops.map((x) => x.ask).join(",")}`);
  assert.deepEqual(asks, ["brief:", "implement:go", "gate:", "review:", "adjudicate:", "merge:conditions,merge", "reflect:", "docs:"]);
  assert.deepEqual(flow.phases.flatMap((ph) => stopPlan(ph, ctx).added), [], "the standard flow declares both; the runtime adds nothing");
});

// @req REQ-flows-001
test("REQ-flows-001: a flow cannot weaken the runtime's stops; 'merge' comes after 'conditions'", () => {
  const dir = project();
  const p = new Project(dir);
  const flow = parseFlow("flows/weak.flow.yaml", [
    "id: weak", "phases:",
    "  - id: plan", "    role: planner",
    "  - id: work", "    role: worker", "    stop: {when: \"risk >= critical\", ask: go}",
    "  - id: again", "    role: worker",
    "  - id: merge", "    action: merge",
  ].join("\n"), "project", new Diagnostics())!;
  const plan = (risk: "medium" | "high") => flow.phases.map((ph) => stopPlan(ph, { flow, roles: p.roles(), risk }));
  const high = plan("high");
  assert.deepEqual(high.map((x) => x.stops), [[], [{ when: "(risk >= critical) or risk >= high", ask: "go" }], [], [{ when: "adjudication.conditions > 0", ask: "conditions" }, { when: "risk >= high", ask: "merge" }]]);
  assert.deepEqual(high.map((x) => x.added), [[], ["go"], [], ["merge"]]);
  const medium = plan("medium");
  assert.deepEqual(medium.map((x) => x.stops.map((s) => s.ask)), [[], ["go"], [], ["conditions"]], "a medium card gets the flow's own stops only");
  assert.deepEqual(medium.flatMap((x) => x.added), []);
});

// @req REQ-flows-001
test("REQ-flows-001: a flow's stricter stop keeps stopping a medium card when a high card's stop is enforced", () => {
  const dir = project({ cardExtra: "risk: medium\n" });
  const p = new Project(dir);
  const flow = parseFlow("flows/strict.flow.yaml", [
    "id: strict", "phases:",
    "  - id: work", "    role: worker", "    stop: {when: \"risk >= medium\", ask: go}",
    "  - id: merge", "    action: merge",
  ].join("\n"), "project", new Diagnostics())!;
  const work = (risk: "medium" | "high") => stopPlan(flow.phases[0]!, { flow, roles: p.roles(), risk }).stops;
  assert.deepEqual(work("high"), [{ when: "(risk >= medium) or risk >= high", ask: "go" }]);
  assert.deepEqual(work("medium"), [{ when: "risk >= medium", ask: "go" }]);
  const enforced = work("high")[0]!.when;
  assert.equal(checkExpr(enforced), undefined);
  for (const risk of RISK_LEVELS) assert.equal(evalExpr(enforced, { risk }), risk !== "low", `${risk} card`);
});

/** Parses a project flow from its lines. */
const flowOf = (id: string, lines: string[]) => parseFlow(`flows/${id}.flow.yaml`, [`id: ${id}`, "phases:", ...lines].join("\n"), "project", new Diagnostics())!;

// @req REQ-flows-001
test("REQ-flows-001: a merge phase that lists 'merge' before 'conditions' stops for 'conditions' first", () => {
  const p = new Project(project());
  const flow = flowOf("order", [
    "  - id: work", "    role: worker",
    "  - id: merge", "    action: merge",
    "    stop:",
    "      - {when: \"risk >= low\", ask: merge}",
    "      - {when: \"adjudication.conditions > 0\", ask: conditions}",
    "      - {when: \"risk >= critical\", ask: go}",
  ]);
  const merge = flow.phases[1]!;
  for (const risk of ["medium", "high"] as const) {
    assert.deepEqual(stopPlan(merge, { flow, roles: p.roles(), risk }).stops.map((s) => s.ask), ["conditions", "merge", "go"], `${risk} card`);
  }
  assert.deepEqual(stopPlan(merge).stops.map((s) => s.ask), ["conditions", "merge", "go"], "without a context too");
});

// @req REQ-flows-001
test("REQ-flows-001: a 'go' declared on a phase before the first write stays there and does not stand in for the write's 'go'", () => {
  const dir = project({ cardExtra: "risk: critical\nflow: early\n" });
  const lines = [
    "  - id: plan", "    role: planner", "    stop: {when: \"risk >= critical\", ask: go}",
    "  - id: work", "    role: worker",
    "  - id: merge", "    action: merge", "    stop: {when: \"risk >= critical\", ask: merge}",
  ];
  write(dir, "flows/early.flow.yaml", ["id: early", "phases:", ...lines].join("\n") + "\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "early flow");
  const p = new Project(dir);
  const flow = flowOf("early", lines);
  const plan = flow.phases.map((ph) => stopPlan(ph, { flow, roles: p.roles(), risk: "high" }));
  assert.deepEqual(plan.map((x) => x.stops), [
    [{ when: "risk >= critical", ask: "go" }],
    [{ when: "risk >= high", ask: "go" }],
    [{ when: "adjudication.conditions > 0", ask: "conditions" }, { when: "(risk >= critical) or risk >= high", ask: "merge" }],
  ], "the early phase keeps its own 'go'; the write gets the runtime's; the merge phase widens its own");
  assert.deepEqual(plan.map((x) => x.added), [[], ["go"], ["merge"]]);

  // An earlier conditional phase that declares 'go' (or 'merge') never stands in for the target's stop.
  const early = flowOf("earlymerge", [
    "  - id: maybe", "    role: planner", "    when: \"risk >= critical\"", "    stop: {when: \"risk >= low\", ask: go}",
    "  - id: plan", "    role: planner", "    stop: {when: \"risk >= critical\", ask: merge}",
    "  - id: work", "    role: worker",
    "  - id: merge", "    action: merge",
  ]);
  for (const risk of ["high", "critical"] as const) {
    const ctx = { flow: early, roles: p.roles(), risk };
    assert.deepEqual(early.phases.map((ph) => stopPlan(ph, ctx).stops.map((s) => `${s.ask} when ${s.when}`)), [
      ["go when risk >= low"],
      ["merge when risk >= critical"],
      ["go when risk >= high"],
      ["conditions when adjudication.conditions > 0", "merge when risk >= high"],
    ], `${risk} card`);
  }

  // The real engine on the first flow, critical card: 'go' at plan, again at the write, then 'merge'.
  const env = { MW_MOCK_SCRIPT: useScript(script()) };
  let r = cli(dir, ["run", "DEMO-1"], env);
  assert.equal(r.s.flow, "early");
  assert.equal(r.s.reason, "go");
  r = cli(dir, ["approve", "DEMO-1", "go"], env);
  assert.equal(r.s.reason, "go", r.s.reason);
  r = cli(dir, ["approve", "DEMO-1", "go"], env);
  assert.equal(r.s.reason, "merge", r.s.reason);
  r = cli(dir, ["approve", "DEMO-1", "merge"], env);
  assert.equal(r.s.status, "done", r.s.reason);
  assert.deepEqual(waits(dir), ["plan:waiting for approval 'go'", "work:waiting for approval 'go'", "merge:waiting for approval 'merge'"]);
});

// @req REQ-flows-001
test("REQ-flows-001: '--approve go' grants every phase that asks for 'go', the declared one and the runtime's", async () => {
  const dir = project({ cardExtra: "risk: critical\nflow: early\n" });
  write(dir, "flows/early.flow.yaml", ["id: early", "phases:",
    "  - id: plan", "    role: planner", "    stop: {when: \"risk >= critical\", ask: go}",
    "  - id: work", "    role: worker",
    "  - id: merge", "    action: merge",
  ].join("\n") + "\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "early flow");
  useScript(script());
  const s = await run(dir, { approve: ["go", "merge"] });
  assert.equal(s.status, "done", s.reason);
  assert.deepEqual(s.approvals, ["plan:go", "work:go", "merge:merge"]);
});

// @req REQ-flows-001
test("REQ-flows-001: a 'go' declared only after the first write does not protect it; the runtime adds 'go' at the write", () => {
  const p = new Project(project());
  const flow = flowOf("late", [
    "  - id: work", "    role: worker",
    "  - id: check", "    role: planner", "    stop: {when: \"risk >= critical\", ask: go}",
    "  - id: merge", "    action: merge",
  ]);
  const plan = flow.phases.map((ph) => stopPlan(ph, { flow, roles: p.roles(), risk: "high" }));
  assert.deepEqual(plan.map((x) => x.stops.map((s) => `${s.ask} when ${s.when}`)), [
    ["go when risk >= high"],
    ["go when risk >= critical"],
    ["conditions when adjudication.conditions > 0", "merge when risk >= high"],
  ]);
  assert.deepEqual(plan.map((x) => x.added), [["go"], [], ["merge"]]);
});

// @req REQ-flows-002
test("REQ-flows-002: the dry run of a high docs card lists the added 'go' and 'merge' stops and says they come from the risk", () => {
  const dir = project({ kind: "docs", cardExtra: "risk: high\n" });
  const r = mw(dir, ["run", "DEMO-1", "--dry-run"], { MW_MOCK_SCRIPT: useScript(script()) });
  assert.equal(r.code, 0, r.err);
  const line = (id: string) => r.out.split("\n").find((l) => l.startsWith(`${id} `)) ?? "";
  assert.match(line("write"), /stops for 'go' when risk >= high \(now true\); 'go' added by the runtime because the card's risk is high/, r.out);
  assert.match(line("merge"), /stops for 'conditions' when adjudication\.conditions > 0 \(now false\); stops for 'merge' when risk >= high \(now true\); 'merge' added by the runtime because the card's risk is high/, r.out);
  assert.doesNotMatch(line("review"), /stops for/);

  const low = project({ kind: "docs", cardExtra: "risk: low\n" });
  const quiet = mw(low, ["run", "DEMO-1", "--dry-run"], { MW_MOCK_SCRIPT: useScript(script()) });
  assert.equal(quiet.code, 0, quiet.err);
  assert.doesNotMatch(quiet.out, /added by the runtime|stops for 'go'|stops for 'merge'/);
});
