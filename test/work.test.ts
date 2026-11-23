// `mw work`: ready cards run unattended in id order, dependencies unlock as cards finish, blocked
// cards are skipped, --max, interrupted runs first, --watch (new work, the other machine's lease,
// usage, releasing the lease when idle, stopping), and --dry-run.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import net from "node:net";
import { after, test } from "node:test";
import YAML from "yaml";
import { parseArgs } from "../src/cli.ts";
import { commands } from "../src/commands-work.ts";
import { quotaRecords, recordQuota } from "../src/engine/quota.ts";
import { runCard } from "../src/engine/run.ts";
import type { Hub, RunState } from "../src/engine/types.ts";
import { LEASE_REF, openHub } from "../src/hub.ts";
import { queueTiming } from "../src/integrations.ts";
import { Queue } from "../src/integrations/queue.ts";
import { localDir, Project } from "../src/project.ts";
import { sleepFor, work, type WorkOptions } from "../src/work.ts";
import { git, mem0Config, patchConfig, read, write } from "./helpers.ts";
import { as, at, fakeIntegrations, handoff, hubPair, project, script, T0, useScript } from "./engine-helpers.ts";


/** Each card's worker writes src/<CARD>.txt, so cards never touch the same file. */
const WORKER = `cat > /dev/null; mkdir -p src; echo "$MW_CARD" > "src/$MW_CARD.txt"; printf '%s' '${JSON.stringify(handoff({ summary: "Added the card file", changed: [] }))}'`;
const ROLES = { worker: { runs: "shell", command: WORKER } };

interface CardSpec {
  id: string;
  status?: string;
  depends?: string[];
  /** Default src/** and docs/**; a scope without src/ makes the card block at 'implement'. */
  scope?: string[];
}

function cardFile(c: CardSpec): string {
  const scope = c.scope ?? ["src/**", "docs/**"];
  return `---\nid: ${c.id}\ntitle: Card ${c.id}\nkind: feature\nstatus: ${c.status ?? "ready"}\nscope: [${scope.map((s) => JSON.stringify(s)).join(", ")}]\n${c.depends ? `depends: [${c.depends.join(", ")}]\n` : ""}---\n\n## Why\n\nBecause.\n\n## Acceptance\n\n- The card file exists.\n`;
}

/** Replace the project's cards with `cards` and commit them. */
function setCards(dir: string, cards: CardSpec[]): void {
  fs.rmSync(path.join(dir, "cards", "DEMO-1.card.md"), { force: true });
  for (const c of cards) write(dir, `cards/${c.id}.card.md`, cardFile(c));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "cards");
}

function setup(cards: CardSpec[]): string {
  const dir = project({ roles: ROLES });
  setCards(dir, cards);
  useScript(script());
  return dir;
}

const stateOf = (dir: string, id: string): RunState | undefined => {
  const f = path.join(dir, ".mergewright", "runs", id, "state.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as RunState) : undefined;
};
/** Card ids in the order their squash commits landed on main. */
const merged = (dir: string) => git(dir, "log", "--reverse", "--format=%s", "main").split("\n").filter((s) => /^DEMO-\d+: Card /.test(s)).map((s) => s.split(":")[0]);
const summaries = (lines: string[]) => lines.filter((l) => /^DEMO-\d+ +(done|waiting|blocked|error) /.test(l));

async function go(dir: string, opts: Partial<WorkOptions> = {}): Promise<{ lines: string[]; code: number; ids: string[] }> {
  const lines: string[] = [];
  const r = await work(dir, { out: (l) => lines.push(l), ...opts });
  return { lines, code: r.code, ids: r.runs.map((x) => `${x.id}:${x.status}`) };
}

test("cards run in id order, dependency chains unlock as cards finish, and todo cards are never picked", async () => {
  const dir = setup([
    { id: "DEMO-1" },
    { id: "DEMO-2", depends: ["DEMO-3"] },
    { id: "DEMO-3" },
    { id: "DEMO-4", status: "todo" },
    { id: "DEMO-9", depends: ["DEMO-2"] },
    { id: "DEMO-10" },
  ]);
  const r = await go(dir);
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.deepEqual(r.ids, ["DEMO-1:done", "DEMO-3:done", "DEMO-2:done", "DEMO-9:done", "DEMO-10:done"]);
  assert.deepEqual(merged(dir), ["DEMO-1", "DEMO-3", "DEMO-2", "DEMO-9", "DEMO-10"]);
  for (const id of ["DEMO-1", "DEMO-2", "DEMO-3", "DEMO-9", "DEMO-10"]) {
    assert.equal(read(dir, `src/${id}.txt`), `${id}\n`);
    assert.match(read(dir, `cards/${id}.card.md`), /status: done/);
  }
  assert.equal(stateOf(dir, "DEMO-4"), undefined, "the todo card was never run");
  assert.match(read(dir, "cards/DEMO-4.card.md"), /status: todo/);
  assert.match(summaries(r.lines)[0]!, /^DEMO-1 +done +merged into main as [0-9a-f]{10}$/);
  assert.equal(r.lines.at(-1), "mw work: ran 5 card(s): 5 done, 0 waiting, 0 blocked.");
  assert.ok(r.lines.some((l) => /^ {2}DEMO-3 {2}brief +ok/.test(l)), "phase lines are printed under the card");
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("a blocked card does not stop independent cards; its dependents are not run; the exit code is 1", async () => {
  const dir = setup([
    { id: "DEMO-1", scope: ["lib/**"] }, // the worker writes src/, outside the card's scope: blocks at 'implement'
    { id: "DEMO-2", depends: ["DEMO-1"] },
    { id: "DEMO-3" },
  ]);
  const r = await go(dir);
  assert.equal(r.code, 1);
  assert.deepEqual(r.ids, ["DEMO-1:blocked", "DEMO-3:done"]);
  assert.match(summaries(r.lines)[0]!, /^DEMO-1 +blocked +at 'implement': remediation budget spent \(2 round\(s\)\); last failure: the change touches paths it may not write:/);
  assert.equal(stateOf(dir, "DEMO-1")!.status, "blocked");
  assert.equal(stateOf(dir, "DEMO-2"), undefined);
  assert.deepEqual(merged(dir), ["DEMO-3"]);
  assert.ok(r.lines.includes("mw work: ran 2 card(s): 1 done, 0 waiting, 1 blocked."), r.lines.join("\n"));
  assert.ok(r.lines.includes("  not run: DEMO-2: it waits for DEMO-1 (blocked) to be done"), r.lines.join("\n"));
});

test("--max stops after that many cards were run", async () => {
  const dir = setup([{ id: "DEMO-1" }, { id: "DEMO-2" }, { id: "DEMO-3" }]);
  const r = await go(dir, { max: 2 });
  assert.equal(r.code, 0);
  assert.deepEqual(r.ids, ["DEMO-1:done", "DEMO-2:done"]);
  assert.equal(stateOf(dir, "DEMO-3"), undefined);
  assert.deepEqual(merged(dir), ["DEMO-1", "DEMO-2"]);
  assert.ok(r.lines.includes("mw work: ran 2 card(s) (stopped at --max 2): 2 done, 0 waiting, 0 blocked."), r.lines.join("\n"));
});

test("an interrupted run (status running) is continued first, without redoing its finished phases", async () => {
  const dir = setup([{ id: "DEMO-1" }, { id: "DEMO-2" }]);
  const first = await runCard(new Project(dir), "DEMO-2", { until: "gate" });
  assert.equal(first.status, "running");
  const r = await go(dir);
  assert.deepEqual(r.ids, ["DEMO-2:done", "DEMO-1:done"]);
  assert.deepEqual(merged(dir), ["DEMO-2", "DEMO-1"]);
  const s = stateOf(dir, "DEMO-2")!;
  assert.deepEqual(s.history.map((h) => h.phase).slice(0, 3), ["brief", "implement", "gate"]);
  assert.deepEqual(JSON.parse(read(dir, ".mergewright/runs/DEMO-2/mock-counters.json")), { planner: 1, reviewer: 1, reflector: 1 });
});

test("--watch picks up a card that becomes ready while it waits, logging the idle reason once per change", async () => {
  const dir = setup([{ id: "DEMO-1", status: "todo" }]);
  const stop = new AbortController();
  const safety = setTimeout(() => stop.abort(), 30_000);
  const flip = setTimeout(() => {
    write(dir, "cards/DEMO-1.card.md", cardFile({ id: "DEMO-1" }));
    git(dir, "commit", "-qam", "DEMO-1 is ready");
  }, 150);
  let sleeps = 0;
  const sleep = async (ms: number, signal?: AbortSignal) => {
    sleeps++;
    assert.equal(ms, 50);
    if (stateOf(dir, "DEMO-1")?.status === "done") stop.abort();
    await sleepFor(ms, signal);
  };
  let r;
  try {
    r = await go(dir, { watch: true, interval: 0.05, signal: stop.signal, sleep });
  } finally {
    clearTimeout(safety);
    clearTimeout(flip);
  }
  assert.deepEqual(r.ids, ["DEMO-1:done"]);
  assert.ok(sleeps >= 3, `waited ${sleeps} time(s)`);
  const idle = r.lines.filter((l) => l.startsWith("nothing to do"));
  assert.equal(idle.length, 2, "once before the card, once after it");
  assert.equal(r.lines.indexOf(idle[0]!), 0);
  assert.match(read(dir, "cards/DEMO-1.card.md"), /status: done/);
  assert.equal(r.lines.at(-1), "mw work: ran 1 card(s) (stopped on request): 1 done, 0 waiting, 0 blocked.");
  assert.equal(r.code, 0);
});

test("--watch takes a card while agent usage is too high when no role runs on a paid harness", async () => {
  // (REQ-usage-004): the usage guard is asked only when the project has a role on a paid
  // harness; this project's only role is a shell worker, so a high reading does not hold the card.
  const dir = setup([{ id: "DEMO-1" }]);
  let asked = 0;
  const integ = fakeIntegrations({ usage: () => { asked++; return { ok: false, detail: "5-hour window at 93%" }; } });
  const stop = new AbortController();
  const r = await go(dir, {
    watch: true, signal: stop.signal, integrations: () => integ,
    sleep: async () => {
      if (stateOf(dir, "DEMO-1")?.status === "done") stop.abort();
    },
  });
  assert.deepEqual(r.ids, ["DEMO-1:done"]);
  assert.deepEqual(r.lines.filter((l) => /usage is too high/.test(l)), []);
  assert.equal(asked, 0, "the usage command was never asked");
  assert.equal(stateOf(dir, "DEMO-1")!.history.filter((h) => h.outcome === "waiting").length, 0);
});

test("a harness usage limit with a reset time stops 'mw work' taking cards until it resets", async () => {
  const dir = setup([{ id: "DEMO-1" }]);
  recordQuota(new Project(dir), "codex", new Date(Date.now() + 3_600_000).toISOString(), "You've hit your usage limit");
  const r = await go(dir, {});
  assert.deepEqual(r.ids, []);
  assert.ok(r.lines.some((l) => /^an agent reported a usage limit \(codex until .*\), so no new work starts until it resets\. Nothing more was run/.test(l)), r.lines.join("\n"));
  assert.equal(stateOf(dir, "DEMO-1"), undefined, "the card never started");
  // A passed reset time no longer holds the work back.
  const records = quotaRecords(new Project(dir), "codex");
  for (const f of fs.readdirSync(records)) fs.writeFileSync(path.join(records, f), JSON.stringify({ until: new Date(Date.now() - 1000).toISOString(), detail: "passed" }));
  const later = await go(dir, {});
  assert.deepEqual(later.ids, ["DEMO-1:done"]);
});

test("--watch waits while the other machine holds a fresh lease, then takes over when it goes stale", async () => {
  const p = hubPair({ roles: ROLES });
  setCards(p.a, [{ id: "DEMO-1" }]);
  git(p.a, "push", "-q", "hub", "main");
  useScript(script());
  await as("beta", T0, () => openHub(new Project(p.b)).take());
  const clock = [at(4), at(6), at(31)]; // at(31): older than three lease times, so it may be taken over
  const stop = new AbortController();
  let sleeps = 0;
  const r = await as("alpha", at(2), () => go(p.a, {
    watch: true, interval: 60, signal: stop.signal,
    sleep: async (ms) => {
      assert.equal(ms, 60_000);
      if (sleeps < clock.length) process.env.MW_NOW = clock[sleeps];
      sleeps++;
      if (stateOf(p.a, "DEMO-1")?.status === "done") stop.abort();
    },
  }));
  assert.deepEqual(r.ids, ["DEMO-1:done"]);
  const waits = r.lines.filter((l) => /holds the lease/.test(l));
  assert.deepEqual(waits, ["beta holds the lease (refreshed 2 min ago by its clock), so this machine waits for it to finish; it may take the lease over in 10 min if the lease is not refreshed by then"], "logged once while it stayed the same");
  assert.equal(stateOf(p.a, "DEMO-1")!.host, "alpha");
  assert.equal(git(p.hubDir, "rev-parse", "main"), git(p.a, "rev-parse", "main"));
  assert.match(git(p.hubDir, "show", "main:cards/DEMO-1.card.md"), /status: done/);
  assert.equal(git(p.hubDir, "show", "main:src/DEMO-1.txt"), "DEMO-1");
});

test("--watch follows the hub's takeover rule: a lease older than lease_minutes but not yet observed that long is waited for, not run into", async () => {
  const p = hubPair({ roles: ROLES });
  setCards(p.a, [{ id: "DEMO-1" }]);
  git(p.a, "push", "-q", "hub", "main");
  useScript(script());
  await as("beta", T0, () => openHub(new Project(p.b)).take());
  // alpha first sees beta's lease when it is 11 min old: by the old age-only rule it was free, but the
  // hub lets alpha take it over only after watching it unchanged for 10 min (or once it is 30 min old).
  const clock = [at(11), at(11), at(21)];
  const stop = new AbortController();
  let sleeps = 0;
  const r = await as("alpha", at(11), () => go(p.a, {
    watch: true, interval: 60, signal: stop.signal,
    sleep: async () => {
      if (sleeps < 2) assert.equal(stateOf(p.a, "DEMO-1"), undefined, "no run was started while the takeover is refused");
      process.env.MW_NOW = clock[Math.min(sleeps, clock.length - 1)];
      sleeps++;
      if (stateOf(p.a, "DEMO-1")?.status === "done" || sleeps > 6) stop.abort();
    },
  }));
  assert.deepEqual(r.ids, ["DEMO-1:done"]);
  assert.deepEqual(r.lines.filter((l) => /another machine is driving/.test(l)), [], "never refused by the hub");
  const waits = r.lines.filter((l) => /holds the lease/.test(l));
  assert.equal(waits.length, 1);
  assert.match(waits[0]!, /^beta holds the lease \(refreshed 11 min ago by its clock\), so this machine waits for it to finish; it may take the lease over in 10 min/);
  assert.equal(stateOf(p.a, "DEMO-1")!.host, "alpha");
});

test("--watch releases the lease once the eligible work is done, so the other machine can take it at once", async () => {
  const p = hubPair({ roles: ROLES });
  setCards(p.a, [{ id: "DEMO-1" }]);
  git(p.a, "push", "-q", "hub", "main");
  useScript(script());
  const stop = new AbortController();
  let taken: Awaited<ReturnType<ReturnType<typeof openHub>["take"]>> | undefined;
  const r = await as("alpha", at(0), () => go(p.a, {
    watch: true, signal: stop.signal,
    sleep: async () => {
      if (stateOf(p.a, "DEMO-1")?.status !== "done") return;
      // One minute later the other machine wants to work: the lease is free, no takeover needed.
      taken = await as("beta", at(1), () => openHub(new Project(p.b)).take());
      stop.abort();
    },
  }));
  assert.deepEqual(r.ids, ["DEMO-1:done"]);
  assert.ok(r.lines.includes("released the lease after finishing the eligible work, so the other machine can take over now"), r.lines.join("\n"));
  assert.deepEqual(taken, { previous: undefined, refreshed: false }, "beta found no lease to take over");
  assert.equal((await openHub(new Project(p.a)).observe()).lease?.host, "beta", "stopping later did not release beta's lease");
});

test("a stop request lets the current card finish, takes no new one, and releases the lease", async () => {
  const p = hubPair({ roles: ROLES });
  setCards(p.a, [{ id: "DEMO-1" }, { id: "DEMO-2" }]);
  git(p.a, "push", "-q", "hub", "main");
  useScript(script());
  const stop = new AbortController();
  const lines: string[] = [];
  const r = await as("alpha", at(0), () => work(p.a, {
    watch: true, signal: stop.signal, sleep: sleepFor,
    out: (l) => {
      lines.push(l);
      if (/^ {2}DEMO-1 {2}gate/.test(l)) stop.abort(); // the owner presses Ctrl-C while DEMO-1 runs
    },
  }));
  assert.deepEqual(r.runs.map((x) => `${x.id}:${x.status}`), ["DEMO-1:done"]);
  assert.equal(r.code, 0);
  assert.equal(stateOf(p.a, "DEMO-2"), undefined);
  assert.ok(lines.includes("released the lease on the way out, so the other machine can take over now"), lines.join("\n"));
  assert.equal(git(p.hubDir, "for-each-ref", LEASE_REF), "", "no lease on the hub");
  assert.match(git(p.hubDir, "show", "main:cards/DEMO-1.card.md"), /status: done/);
});

test("without --watch, a fresh lease held by the other machine stops the work with exit code 1", async () => {
  const p = hubPair({ roles: ROLES });
  setCards(p.a, [{ id: "DEMO-1" }]);
  git(p.a, "push", "-q", "hub", "main");
  useScript(script());
  await as("beta", T0, () => openHub(new Project(p.b)).take());
  const r = await as("alpha", at(3), () => go(p.a));
  assert.equal(r.code, 1);
  assert.deepEqual(r.ids, []);
  assert.match(r.lines[0]!, /^beta holds the lease \(refreshed 3 min ago by its clock\).*Nothing more was run; 'mw work --watch' waits/);
  assert.equal(stateOf(p.a, "DEMO-1"), undefined);
});

test("--dry-run prints the order and why every other card that is not done is not eligible, and changes nothing", async () => {
  const dir = setup([
    { id: "DEMO-1" },
    { id: "DEMO-2", status: "todo" },
    { id: "DEMO-3", depends: ["DEMO-1"] },
    { id: "DEMO-4", depends: ["DEMO-99"] },
    { id: "DEMO-5" },
    { id: "DEMO-6" },
    { id: "DEMO-7" },
    { id: "DEMO-8", status: "done" },
    { id: "DEMO-9" },
  ]);
  write(dir, "cards/DEMO-5.card.md", cardFile({ id: "DEMO-5" }).replace("Because.", "Because, edited."));
  const fake = (id: string, status: string, reason?: string, phase = 2) =>
    write(dir, `.mergewright/runs/${id}/state.json`, JSON.stringify({ card: id, flow: "standard", phase, round: 0, status, reason, approvals: [], host: "x", started: T0, updated: T0, history: [], warnings: [] }));
  fake("DEMO-6", "blocked", "the gate failed twice");
  fake("DEMO-7", "running");
  fake("DEMO-9", "waiting", "go", 1);
  const head = git(dir, "rev-parse", "HEAD");
  const lines: string[] = [];
  const cwd = process.cwd();
  let code: number;
  try {
    process.chdir(dir);
    code = await commands.work!(parseArgs(["work", "--dry-run"]), (l = "") => { lines.push(l); });
  } finally {
    process.chdir(cwd);
  }
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    "would run, in this order:",
    "  DEMO-7   continue its interrupted run at 'gate': Card DEMO-7",
    "  DEMO-1   start (flow standard): Card DEMO-1",
    "not eligible:",
    "  DEMO-2   its status is 'todo'; only cards marked 'ready' are picked up",
    "  DEMO-3   it waits for DEMO-1 (ready) to be done",
    "  DEMO-4   it depends on DEMO-99, which does not exist",
    "  DEMO-5   cards/DEMO-5.card.md has changes that are not committed; commit it so the merge can mark the card done",
    "  DEMO-6   its run is blocked: the gate failed twice. Fix the cause, then run 'mw run DEMO-6'",
    "  DEMO-9   its run waits for approval 'go'; run 'mw approve DEMO-9 go'",
    "(dry run: no card was run, and the hub was not contacted)",
  ]);
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
  assert.equal(stateOf(dir, "DEMO-1"), undefined);
  assert.equal(stateOf(dir, "DEMO-7")!.status, "running");
  assert.equal(fs.existsSync(path.join(dir, ".mergewright", "worktrees")), false);
});

test("mw work refuses a --max or --interval that is not a positive number", async () => {
  const dir = setup([{ id: "DEMO-1" }]);
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    await assert.rejects(Promise.resolve(commands.work!(parseArgs(["work", "--max", "0"]), () => {})), /--max needs a positive whole number, not '0'/);
    await assert.rejects(Promise.resolve(commands.work!(parseArgs(["work", "--interval", "soon"]), () => {})), /--interval needs a positive number of seconds/);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(stateOf(dir, "DEMO-1"), undefined);
});

test("runCard leaves the integration queue alone (REQ-engine-009); mw work retries it after dispatching the pass's card", async () => {
  const dir = setup([{ id: "DEMO-1" }]);
  // The notify command says whether the card's work was already merged when the item was delivered.
  write(dir, ".mergewright/notify.sh", `if [ -f src/DEMO-1.txt ]; then echo "$1 (after DEMO-1)"; else echo "$1 (before DEMO-1)"; fi >> .mergewright/notified.log\n`);
  write(dir, "mergewright.yaml", `${read(dir, "mergewright.yaml").trimEnd()}\nreport:\n  command: "sh .mergewright/notify.sh {subject}"\n`);
  // Queued by an earlier run on this machine (in its own .mergewright/local/queue/).
  new Queue(path.join(dir, ".mergewright", "local")).add("notify", "notify: from yesterday", { subject: "from yesterday", body: "queued while the service was down" }, "down");
  const s = await runCard(new Project(dir), "DEMO-1", { until: "brief" });
  assert.equal(s.status, "running");
  assert.equal(fs.existsSync(path.join(dir, ".mergewright", "notified.log")), false, "not retried under the card's lock and the lease");
  assert.equal(fs.readdirSync(path.join(dir, ".mergewright", "local", "queue")).length, 1);
  const r = await go(dir);
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.deepEqual(r.ids, ["DEMO-1:done"]);
  const log = read(dir, ".mergewright/notified.log");
  assert.match(log, /^from yesterday \(after DEMO-1\)$/m, log);
  assert.doesNotMatch(log, /from yesterday \(before DEMO-1\)/);
  assert.deepEqual(fs.readdirSync(path.join(dir, ".mergewright", "local", "queue")), []);
});

test("on a hub, a drain cut by --max flushes the queue once, after the card, with the lease still held", async () => {
  // REQ-engine-009, REQ-engine-012: the card's pass flushes after its card while this
  // machine keeps the lease (no run of this machine is inside its merge phase); the exit does not
  // flush a second time.
  const p = hubPair({ roles: ROLES });
  const probes: boolean[] = [];
  const sockets = new Set<net.Socket>();
  const hole = net.createServer((s) => {
    sockets.add(s);
    s.on("error", () => undefined);
    s.once("data", () => probes.push(git(p.hubDir, "for-each-ref", LEASE_REF) !== ""));
  });
  await new Promise<void>((resolve) => hole.listen(0, "127.0.0.1", resolve));
  after(() => {
    for (const s of sockets) s.destroy();
    hole.close();
  });
  patchConfig(p.a, mem0Config({ url: `http://127.0.0.1:${(hole.address() as net.AddressInfo).port}`, key_env: "MW_TEST_MEM0_KEY" }));
  setCards(p.a, [{ id: "DEMO-1" }, { id: "DEMO-2" }]);
  git(p.a, "push", "-q", "hub", "main");
  useScript(script());
  process.env.MW_TEST_MEM0_KEY = "mem0-test-key-not-a-secret";
  new Queue(localDir(new Project(p.a))).add("mem0", "mem0 (demo): 1 lesson(s): Later", { lessons: [{ topic: "testing", title: "Later", body: "Later, because." }] });
  queueTiming.budgetMs = 300;
  try {
    const r = await as("alpha", undefined, () => go(p.a, { max: 1, integrations: () => fakeIntegrations() }));
    assert.deepEqual(r.ids, ["DEMO-1:done"]);
    assert.ok(r.lines.includes("released the lease before exiting, so the other machine can take over now"), r.lines.join("\n"));
  } finally {
    queueTiming.budgetMs = undefined;
  }
  assert.deepEqual(probes, [true], "one flush, after the card and before the lease was released");
  assert.equal(git(p.hubDir, "for-each-ref", LEASE_REF), "");
  assert.equal(new Queue(localDir(new Project(p.a))).list()[0]!.item.attempts, 1, "cut at the budget, still queued");
});

test("on a hub, mw work connects to a delivery service only after its card was merged, with the lease kept or released, also when its release failed (kept)", async () => {
  // @req REQ-engine-008
  // The card is dispatched first and the queue is flushed after it. (REQ-engine-012): the
  // lease this machine keeps no longer holds the flush back, also when the release did not go through.
  const p = hubPair({ roles: ROLES });
  const leaseHeld = () => git(p.hubDir, "for-each-ref", LEASE_REF) !== "";
  const doneOn = (id: string) => stateOf(p.a, id)?.status === "done" && /status: done/.test(git(p.hubDir, "show", `main:cards/${id}.card.md`));
  /** One entry per connection: the lease and the card's state when it opened, then the request it sent. */
  type Conn = { lease: boolean; done: boolean; request?: string; leaseAtRequest?: boolean };
  /**
   * A mem0 at a new port that answers a search (a read) at once and never answers anything else. Each
   * phase gets its own, so the HTTP client reconnecting to an earlier one (it may do so after a request
   * cut at the budget, without sending anything) is never counted against a later phase.
   */
  const blackhole = async (card: string) => {
    const conns: Conn[] = [];
    const server = http.createServer((req, res) => {
      const c = (req.socket as net.Socket & { probe?: Conn }).probe!;
      c.request = `${req.method} ${req.url}`;
      c.leaseAtRequest = leaseHeld();
      req.resume();
      if (req.method === "POST" && req.url === "/search") req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results: [] })));
    });
    server.on("connection", (s: net.Socket & { probe?: Conn }) => {
      s.probe = { lease: leaseHeld(), done: doneOn(card) };
      conns.push(s.probe);
      s.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    after(() => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }));
    patchConfig(p.a, mem0Config({ url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, key_env: "MW_TEST_MEM0_KEY" }));
    return conns;
  };
  const conns = await blackhole("DEMO-1");
  setCards(p.a, [{ id: "DEMO-1" }, { id: "DEMO-2", status: "todo" }]);
  git(p.a, "push", "-q", "hub", "main");
  useScript(script());
  process.env.MW_TEST_MEM0_KEY = "mem0-test-key-not-a-secret";
  const queue = new Queue(localDir(new Project(p.a)));
  queue.add("mem0", "mem0 (demo): 1 lesson(s): Later", { lessons: [{ topic: "testing", title: "Later", body: "Later, because." }] });
  queueTiming.budgetMs = 300;
  try {
    // 1. The release goes through: the card's pass flushes after the card with the lease still held,
    //    and the idle pass flushes again after the release.
    const r = await as("alpha", undefined, () => go(p.a, { integrations: () => fakeIntegrations() }));
    assert.equal(r.code, 0, r.lines.join("\n"));
    assert.deepEqual(r.ids, ["DEMO-1:done"]);
    assert.ok(r.lines.includes("released the lease after finishing the eligible work, so the other machine can take over now"), r.lines.join("\n"));
    const deliveries = conns.filter((c) => c.request !== undefined && c.request !== "POST /search");
    assert.deepEqual(deliveries.map((c) => [c.lease, c.leaseAtRequest]), [[true, true], [false, false]], `one flush after the card with the lease kept, one after the release: ${JSON.stringify(conns)}`);
    assert.ok(conns.every((c) => c.done), `no connection before DEMO-1 was dispatched and merged: ${JSON.stringify(conns)}`);
    assert.equal(leaseHeld(), false);
    assert.equal(queue.list()[0]!.item.attempts, 2, "two attempts, each cut at the budget, still queued");

    // 2. The release fails: the lease stays on the hub ('kept'). No other 'mw' process of this machine
    //    has a run, so that lease is this process's own: the pass after the card, the idle pass that
    //    tried the release and a later --watch pass that pauses all flush with the lease kept, each only
    //    after DEMO-2 was dispatched and merged.
    write(p.a, "cards/DEMO-2.card.md", cardFile({ id: "DEMO-2" }));
    git(p.a, "commit", "-qam", "DEMO-2 is ready");
    git(p.a, "push", "-q", "hub", "main");
    const later = await blackhole("DEMO-2");
    git(p.a, "commit", "-qam", "mem0 moved");
    git(p.a, "push", "-q", "hub", "main");
    const before = Object.fromEntries(fs.readdirSync(queue.dir).map((f) => [f, fs.readFileSync(path.join(queue.dir, f), "utf8")]));
    const failing = (proj: Project): Hub => ({ ...openHub(proj), release: async () => { throw new Error("the hub did not answer (test)"); } });
    const stop = new AbortController();
    let sleeps = 0;
    const k = await as("alpha", undefined, () => go(p.a, {
      watch: true, signal: stop.signal, hub: failing, integrations: () => fakeIntegrations(),
      sleep: async () => {
        // After the idle pass: the next pass pauses for a usage limit, the branch that flushes unless 'kept'.
        if (++sleeps === 1) recordQuota(new Project(p.a), "codex", new Date(Date.now() + 3_600_000).toISOString(), "You've hit your usage limit");
        else stop.abort();
      },
    }));
    assert.deepEqual(k.ids, ["DEMO-2:done"], k.lines.join("\n"));
    assert.equal(sleeps, 2, "an idle pass and a paused pass ran after the card");
    assert.ok(k.lines.some((l) => /^an agent reported a usage limit \(codex until /.test(l)), k.lines.join("\n"));
    assert.ok(doneOn("DEMO-2"), "DEMO-2 was dispatched and merged");
    assert.ok(k.lines.some((l) => /^could not release the lease: the hub did not answer \(test\)/.test(l)), k.lines.join("\n"));
    assert.equal(leaseHeld(), true, "the lease is still on the hub");
    const sent = later.filter((c) => c.request !== undefined && c.request !== "POST /search");
    assert.equal(sent.length, 3, `three flushes with the lease kept: ${JSON.stringify(later)}`);
    assert.ok(later.every((c) => c.lease && c.done), `every connection came after DEMO-2 was merged, with the lease kept: ${JSON.stringify(later)}`);
    assert.equal(queue.list()[0]!.item.attempts, 5, "two attempts before, three more now, still queued");
    assert.notDeepEqual(Object.fromEntries(fs.readdirSync(queue.dir).map((f) => [f, fs.readFileSync(path.join(queue.dir, f), "utf8")])), before, "the item records the new attempts");
  } finally {
    queueTiming.budgetMs = undefined;
  }
});
