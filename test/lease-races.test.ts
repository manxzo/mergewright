// Regression tests for the lease, the shared run directory and the hub protocol when two machines
// race. Each test reproduces a trigger and asserts the state the runtime must leave. Newer symbols
// are reached through namespace imports, so that a missing one fails its own test instead of the
// whole file.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import * as commandsIntegrations from "../src/commands-integrations.ts";
import * as gitops from "../src/engine/gitops.ts";
import { abort, runCard } from "../src/engine/run.ts";
import * as stateModule from "../src/engine/state.ts";
import type { Hub, Integrations, MergeRequest } from "../src/engine/types.ts";
import { hubTestHooks, LEASE_REF, openHub } from "../src/hub.ts";
import { integrationsFor } from "../src/integrations.ts";
import * as memory from "../src/memory.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { Project } from "../src/project.ts";
import { MwError } from "../src/util.ts";
import { git, MW, mw, newProject, read, tmpDir, write } from "./helpers.ts";
import {
  as, at, counters, fakeHub, fakeIntegrations, hubPair, mirror, phases, project, reflection, run, runPath, script, setRoles,
  state, subjects, useScript,
} from "./engine-helpers.ts";
import { projectWith } from "./fixtures/integrations/support.ts";


const ID = "DEMO-1";
const WT = (dir: string) => path.join(dir, ".mergewright", "worktrees", ID);
const LOCAL = (dir: string, ...rel: string[]) => path.join(dir, ".mergewright", "local", ...rel);
const discarded = (dir: string) => (fs.existsSync(LOCAL(dir, "discarded")) ? fs.readdirSync(LOCAL(dir, "discarded")).sort().map((n) => LOCAL(dir, "discarded", n)) : []);
const hubRef = (hubDir: string, ref: string) => {
  try {
    return git(hubDir, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
};

/** Every file under `dir` with its content, sorted (for "nothing changed" checks). */
function files(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) visit(full);
      else out.push(`${path.relative(dir, full)}: ${fs.readFileSync(full, "utf8")}`);
    }
  };
  visit(dir);
  return out;
}

/** Commit a tracked file in the main checkout, then give it an uncommitted edit and add an untracked file (the owner's work). */
function ownerEdit(dir: string): void {
  write(dir, "notes.md", "committed\n");
  git(dir, "add", "notes.md");
  git(dir, "commit", "-qm", "notes");
  write(dir, "notes.md", "the owner's uncommitted edit\n");
  write(dir, "owner-untracked.txt", "not added yet\n");
}

function ownerWorkIntact(dir: string, main: string): void {
  assert.equal(read(dir, "notes.md"), "the owner's uncommitted edit\n", "the owner's uncommitted edit survived");
  assert.equal(read(dir, "owner-untracked.txt"), "not added yet\n", "the owner's untracked file survived");
  assert.equal(git(dir, "rev-parse", "main"), main, "the base branch did not move");
  assert.equal(git(dir, "status", "--porcelain"), "M notes.md\n?? owner-untracked.txt");
}

// ── Per-machine files live in .mergewright/local/ ───────────────────────────────────────

test("the queue, temporary files, the usage flag and the lease observation are this machine's own, under .mergewright/local/", async () => {
  const dir = newProject();
  write(dir, "usage.json", `{"max_used": 95}\n`);
  write(dir, "mergewright.yaml", `${read(dir, "mergewright.yaml").trimEnd()}\nreport:\n  command: "sh -c 'exit 3'"\nusage:\n  command: "cat usage.json"\n`);
  const i = integrationsFor(new Project(dir));
  await i.notify("subject", "body");
  assert.equal((await i.usageOk()).ok, false);
  assert.equal(fs.readdirSync(LOCAL(dir, "queue")).filter((f) => f.endsWith(".json")).length, 1, "the undelivered item is queued on this machine");
  assert.deepEqual(fs.readdirSync(LOCAL(dir, "tmp")), [], "the notification body went through local/tmp and was removed");
  assert.ok(fs.existsSync(LOCAL(dir, "usage-paused")));
  for (const shared of ["queue", "tmp", "usage-paused"]) assert.equal(fs.existsSync(path.join(dir, ".mergewright", shared)), false, `nothing at .mergewright/${shared}`);
  assert.deepEqual(commandsIntegrations.SYNC_EXCLUSIONS, [".git", ".mergewright/worktrees", ".mergewright/local"]);

  const p = hubPair();
  await as("alpha", at(0), () => openHub(new Project(p.a)).take());
  const seen = await as("beta", at(1), () => openHub(new Project(p.b)).observe());
  assert.deepEqual(JSON.parse(read(p.b, ".mergewright/local/lease-seen.json")), { sha: seen.sha, firstSeen: at(1) }, "one record, not keyed by host");
  assert.equal(fs.existsSync(path.join(p.b, ".mergewright", "lease-seen.json")), false);
});

test("items an older runtime queued in .mergewright/queue/ stay there until the owner runs 'mw queue adopt'", () => {
  const dir = newProject();
  const old = path.join(dir, ".mergewright", "queue");
  fs.mkdirSync(old, { recursive: true });
  const item = { kind: "notify", created: new Date().toISOString(), summary: "notify: from the old layout", payload: { subject: "s", body: "b" }, attempts: 0 };
  fs.writeFileSync(path.join(old, "20261001-000000000Z-notify-abc.json"), JSON.stringify(item));
  let r = mw(dir, ["queue"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /the queue is empty/);
  assert.deepEqual(fs.readdirSync(old), ["20261001-000000000Z-notify-abc.json"]);
  r = mw(dir, ["queue", "adopt"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(fs.readdirSync(old), []);
  assert.deepEqual(fs.readdirSync(LOCAL(dir, "queue")), ["20261001-000000000Z-notify-abc.json"]);
  assert.match(mw(dir, ["queue"]).out, /notify: from the old layout/);
});

test("a machine that lost the lease leaves the shared run directory exactly as it was when the phase stopped (no lock is released there)", async () => {
  const dir = project();
  const pidFile = path.join(dir, ".mergewright", "agent.pid");
  setRoles(dir, { worker: { runs: "shell", command: `mkdir -p src; echo partial > src/app.txt; echo $$ > '${pidFile}'; sleep 30; echo '{}'` } });
  git(dir, "commit", "-qam", "worker on the shell");
  useScript(script());
  let atLoss: string[] | undefined;
  const hub = fakeHub({
    holder: "other-host",
    refresh: () => {
      if (!fs.existsSync(pidFile)) return;
      atLoss ??= files(runPath(dir));
      throw new Error("the lease is held by other-host");
    },
  });
  process.env.MW_HEARTBEAT_MS = "50";
  try {
    await assert.rejects(run(dir, {}, { hub }), /this machine lost the lease to other-host/);
  } finally {
    delete process.env.MW_HEARTBEAT_MS;
  }
  assert.ok(atLoss);
  assert.equal(atLoss.some((f) => f.startsWith("lock:")), false, "no lock in the shared run directory");
  assert.deepEqual(files(runPath(dir)), atLoss, "nothing in the shared run directory changed afterwards");
  assert.deepEqual(fs.readdirSync(LOCAL(dir, "locks")), [], "this machine's own lock was released");
});

// ── Every change to the hub is fenced, from any process ─────────────────────────────────

test("a process without the lease pushing the base: another machine taking the lease just before the push makes the push not land", async () => {
  const p = hubPair();
  write(p.a, "notes.txt", "a is ahead\n");
  git(p.a, "add", "notes.txt");
  git(p.a, "commit", "-qm", "a is ahead");
  const hubMain = hubRef(p.hubDir, "main");
  // The interleaving the reviewer described: A (a fresh `mw sync`, no lease) has decided to push;
  // B takes the lease; then A pushes.
  hubTestHooks.beforeUnheldPush = () => as("beta", undefined, () => openHub(new Project(p.b)).take({ force: true })).then(() => undefined);
  let err: unknown;
  try {
    err = await as("alpha", undefined, () => openHub(new Project(p.a)).sync()).then(() => undefined, (e: unknown) => e);
  } finally {
    delete hubTestHooks.beforeUnheldPush;
  }
  assert.equal(hubRef(p.hubDir, "main"), hubMain, "A's base did not land while B holds the lease");
  assert.ok(err instanceof MwError, String(err));
  assert.equal(err.code, "hub/lease-lost");
  assert.match(err.message, /this machine \(alpha\) no longer holds the lease on hub 'hub': beta took it/);
  assert.equal((await openHub(new Project(p.b)).observe()).lease?.host, "beta", "B's lease is untouched");
});

test("the same race without a test seam: B takes the lease while A's push is on its way to the hub, and the hub applies nothing of A's", async () => {
  const p = hubPair();
  write(p.a, "notes.txt", "a is ahead\n");
  git(p.a, "add", "notes.txt");
  git(p.a, "commit", "-qm", "a is ahead");
  const hubMain = hubRef(p.hubDir, "main");
  // The hub's pre-receive hook runs after A's push reached the hub and before any ref moves; there,
  // B (a separate `mw` process on the other machine) takes the lease over.
  const arm = path.join(path.dirname(p.hubDir), "armed");
  const done = path.join(path.dirname(p.hubDir), "done");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(path.join(p.hubDir, "hooks", "pre-receive"), `#!/bin/sh
if grep -q ' refs/heads/main$' && [ -f ${q(arm)} ] && [ ! -f ${q(done)} ]; then
  touch ${q(done)}
  cd ${q(p.b)} && env -i PATH="$PATH" HOME="$HOME" MW_HOST=beta MW_ENV_FILE=/dev/null ${q(process.execPath)} ${q(MW)} lease take --force > /dev/null 2>&1
fi
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(arm, "");
  const err = await as("alpha", undefined, () => openHub(new Project(p.a)).sync()).then(() => undefined, (e: unknown) => e);
  assert.ok(fs.existsSync(done), "B took the lease during A's push");
  assert.equal(hubRef(p.hubDir, "main"), hubMain, "A's base did not land");
  assert.ok(err instanceof MwError && err.code === "hub/lease-lost", String(err));
  assert.equal((await openHub(new Project(p.b)).observe()).lease?.host, "beta");
});

test("an unfenced push is gone: a process without the lease takes it, pushes fenced, and releases it unless this host held it before", async () => {
  const p = hubPair();
  write(p.b, "notes.txt", "b is ahead\n");
  git(p.b, "add", "notes.txt");
  git(p.b, "commit", "-qm", "b is ahead");
  // Nobody holds the lease: B takes it for the push and gives it back.
  assert.equal((await as("beta", undefined, () => openHub(new Project(p.b)).sync())).action, "pushed");
  assert.equal(hubRef(p.hubDir, "main"), git(p.b, "rev-parse", "main"));
  assert.equal(hubRef(p.hubDir, LEASE_REF), "", "the lease taken for the push was released");
  // Another process of this host holds the lease: the push continues it (moving it, as every fenced
  // push does) and leaves it in place.
  assert.equal(mw(p.b, ["lease", "take"], { MW_HOST: "beta" }).code, 0);
  const taken = hubRef(p.hubDir, LEASE_REF);
  git(p.b, "branch", "card/X");
  await as("beta", undefined, () => openHub(new Project(p.b)).pushBranch("card/X"));
  assert.equal(hubRef(p.hubDir, "card/X"), git(p.b, "rev-parse", "card/X"));
  assert.notEqual(hubRef(p.hubDir, LEASE_REF), taken, "the branch was pushed in one atomic push with a new lease commit");
  assert.equal((await openHub(new Project(p.b)).observe()).lease?.host, "beta", "the same host's lease is kept");
  // Another host holds a fresh lease: refused, naming it, and nothing changes.
  await assert.rejects(as("alpha", undefined, () => openHub(new Project(p.a)).deleteBranch("card/X")), /beta \(pid \d+\) holds the lease/);
  assert.equal(hubRef(p.hubDir, "card/X"), git(p.b, "rev-parse", "card/X"));
});

// ── A forge merge stops when the lease is lost ──────────────────────────────────────────

test("a forge merge whose lease is lost mid-request records nothing and requests no merge", async () => {
  const requests: string[] = [];
  const ctl = new AbortController();
  let merged = false;
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const pr = { number: 7, head: { ref: "card/DEMO-4" }, base: { ref: "main" }, mergeable: true, state: merged ? "closed" : "open", merged, merge_commit_sha: merged ? "abc123" : null };
    if (req.method === "GET" && req.url?.includes("/pulls?")) {
      // A slow lookup; the heartbeat finds the lease gone while it runs.
      setTimeout(() => ctl.abort(), 50);
      setTimeout(() => { if (!res.destroyed) reply(200, []); }, 400);
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/pulls")) return reply(201, pr);
    if (req.method === "GET" && req.url?.endsWith("/pulls/7")) return reply(200, pr);
    if (req.method === "POST" && req.url?.endsWith("/pulls/7/merge")) { merged = true; return reply(200, {}); }
    reply(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { dir, project: p } = projectWith({ git: { base: "main", hub: "none", forge: { kind: "gitea", url, repo: "me/demo", token_env: "MW_TEST_FORGE_TOKEN" } } });
    process.env.MW_TEST_FORGE_TOKEN = "tok";
    const req: MergeRequest = { card: "DEMO-4", branch: "card/DEMO-4", base: "main", title: "t", body: "b", signal: ctl.signal };
    const err = await integrationsFor(p).forgeMerge(req).then((sha) => new Error(`merged as ${sha}`), (e: unknown) => e);
    assert.ok(err instanceof MwError && err.code === "merge/failed", String(err));
    assert.match(err.message, /stopped: this machine lost the lease/);
    await new Promise((r) => setTimeout(r, 450)); // let the slow answer arrive, in case anything waits for it
    assert.equal(fs.existsSync(path.join(dir, ".mergewright", "runs", "DEMO-4", "forge.json")), false, "no pull request recorded");
    assert.deepEqual(requests.filter((r) => !r.startsWith("GET /api/v1/repos/me/demo/pulls?")), [], "no pull request created, no merge requested");
  } finally {
    delete process.env.MW_TEST_FORGE_TOKEN;
    server.closeAllConnections();
    server.close();
  }
});

test("the engine passes the merge phase's lease signal to the forge", async () => {
  const dir = project();
  useScript(script());
  let signal: AbortSignal | undefined;
  const integ: Integrations = { ...fakeIntegrations(), async forgeMerge(req) { signal = req.signal; return undefined; } };
  const s = await run(dir, {}, { integrations: integ });
  assert.equal(s.status, "done", s.reason);
  assert.ok(signal instanceof AbortSignal, "the forge got an abort signal");
  assert.equal(signal.aborted, false);
});

// ── Artifacts are content-addressed ─────────────────────────────────────────────────────

test("a crash between writing an artifact and saving the state does not block the run", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "gate" });
  // The planner's next brief is being written when the process dies, before the state is saved.
  const s0 = state(dir);
  const store = stateModule.artifactStore(runPath(dir), s0, () => { throw new Error("killed before the state was saved"); });
  assert.throws(() => store.put("brief", { ...JSON.parse(read(runPath(dir), "brief.json")), summary: "a newer brief" }), /killed/);
  const s = await run(dir, { until: "review" });
  assert.equal(s.status, "running", s.reason);
  assert.deepEqual(phases(s), ["brief:ok", "implement:ok", "gate:ok"]);
  assert.equal(JSON.parse(read(runPath(dir), "brief.json")).summary, "Add the app file.", "the brief the state records is the one in use");
});

// ── No offline runs on a shared project ─────────────────────────────────────────────────

test("run, work, approve, retry and abort refuse --offline on a project with a hub; sync --offline and a project without a hub are unaffected", () => {
  const p = hubPair({ cardExtra: "risk: high\n" });
  const env = { MW_MOCK_SCRIPT: useScript(script()), MW_HOST: "alpha" };
  let r = mw(p.a, ["run", ID], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(state(p.a).reason, "go");
  assert.equal(mw(p.a, ["lease", "release"], env).code, 0);
  const before = files(runPath(p.a));
  // These commands no longer take --offline at all; it is a usage error naming 'mw sync --offline'.
  const refusal = /does not take --offline: only 'mw sync --offline' works without the hub/;
  for (const args of [["run", ID, "--offline"], ["work", "--offline"], ["approve", ID, "go", "--offline"], ["retry", ID, "--offline"], ["abort", ID, "--offline"], ["abort", ID, "--force", "--offline"]]) {
    r = mw(p.a, args, env);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}${r.err}`);
    assert.match(r.err, refusal, args.join(" "));
  }
  assert.deepEqual(files(runPath(p.a)), before, "no run state changed");
  assert.equal(hubRef(p.hubDir, LEASE_REF), "", "no lease was taken");
  r = mw(p.a, ["sync", "--offline"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /offline: did not contact the hub/);

  // A project without a hub never contacts one: the flag is refused there too, and the plain run works.
  const single = project();
  r = mw(single, ["run", ID, "--offline", "--until", "gate"], { MW_MOCK_SCRIPT: useScript(script()) });
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, refusal);
  r = mw(single, ["run", ID, "--until", "gate"], { MW_MOCK_SCRIPT: useScript(script()) });
  assert.equal(r.code, 0, r.err);
});

// ── Worktrees are never destroyed in place ──────────────────────────────────────────────

test("the worktree replaced by a symbolic link to the main checkout between its check and the clean-up: the main checkout is untouched", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "gate" });
  write(WT(dir), "src/app.txt", "leftover of an interrupted phase\n");
  ownerEdit(dir);
  const main = git(dir, "rev-parse", "main");
  const real = path.join(tmpDir("mw-moved-"), "worktree");
  // Between the check of the worktree and what is done to its leftovers, another process replaces
  // the worktree directory with a symbolic link to the main checkout.
  const base = fakeHub();
  const hub: Hub = {
    ...base,
    async fetchBranch(b) {
      fs.renameSync(WT(dir), real);
      fs.symlinkSync(dir, WT(dir));
      return base.fetchBranch(b);
    },
  };
  const s = await run(dir, { until: "review" }, { hub });
  ownerWorkIntact(dir, main);
  assert.equal(read(real, "src/app.txt"), "leftover of an interrupted phase\n", "the real worktree's leftovers were not touched either");
  assert.equal(s.status, "running", s.reason);
  const [aside] = discarded(dir);
  assert.ok(aside && fs.lstatSync(aside).isSymbolicLink(), "the link itself was moved aside");
  assert.ok(fs.lstatSync(WT(dir)).isDirectory(), "a fresh worktree replaced it");
  assert.equal(git(WT(dir), "symbolic-ref", "--short", "HEAD"), `card/${ID}`);
});

test("the same race at the move itself (test seam): the link is moved, never followed", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "gate" });
  ownerEdit(dir);
  const main = git(dir, "rev-parse", "main");
  const real = path.join(tmpDir("mw-moved-"), "worktree");
  const hooks = gitops.gitopsTestHooks;
  hooks.beforeDiscard = (wt) => {
    fs.renameSync(wt, real);
    fs.symlinkSync(dir, wt);
  };
  try {
    const s = await abort(new Project(dir), ID, { force: true }, { hub: fakeHub(), integrations: fakeIntegrations() });
    assert.equal(s.status, "aborted");
  } finally {
    delete hooks.beforeDiscard;
  }
  ownerWorkIntact(dir, main);
  const [aside] = discarded(dir);
  assert.ok(aside && fs.lstatSync(aside).isSymbolicLink());
  assert.equal(fs.readlinkSync(aside), dir);
});

test("on losing the lease nothing is done to the worktree; its leftovers wait for the next run", async () => {
  const dir = project();
  const pidFile = path.join(dir, ".mergewright", "agent.pid");
  setRoles(dir, { worker: { runs: "shell", command: `mkdir -p src; echo partial > src/app.txt; echo untracked > src/new.txt; echo $$ > '${pidFile}'; sleep 30; echo '{}'` } });
  git(dir, "commit", "-qam", "worker on the shell");
  useScript(script());
  const hub = fakeHub({ holder: "other-host", refresh: () => { if (fs.existsSync(pidFile)) throw new Error("the lease is held by other-host"); } });
  process.env.MW_HEARTBEAT_MS = "50";
  try {
    await assert.rejects(run(dir, {}, { hub }), /lost the lease/);
  } finally {
    delete process.env.MW_HEARTBEAT_MS;
  }
  assert.equal(read(WT(dir), "src/app.txt"), "partial\n");
  assert.equal(read(WT(dir), "src/new.txt"), "untracked\n");
  assert.equal(git(dir, "rev-parse", `card/${ID}`), git(dir, "rev-parse", "main"), "nothing was committed");
});

test("abort --force moves the worktree aside (uncommitted work kept); entries older than seven days are removed at run start, a link without following it", async () => {
  const dir = project();
  useScript(script());
  await run(dir, { until: "gate" });
  write(WT(dir), "src/wip.txt", "uncommitted\n");
  const s = await abort(new Project(dir), ID, { force: true }, { hub: fakeHub(), integrations: fakeIntegrations() });
  assert.equal(s.status, "aborted");
  const [aside] = discarded(dir);
  assert.ok(aside, "the worktree was moved aside, not deleted");
  assert.equal(read(aside, "src/wip.txt"), "uncommitted\n");
  assert.equal(fs.existsSync(WT(dir)), false);
  // An old entry that is a link to the main checkout: removing it must not follow it.
  const old = LOCAL(dir, "discarded", "DEMO-9-2026-01-01T00-00-00-000Z");
  fs.symlinkSync(dir, old);
  const recent = LOCAL(dir, "discarded", `DEMO-8-${new Date(Date.now() - 6 * 86_400_000).toISOString().replace(/:/g, "-").replace(".", "-")}`);
  fs.mkdirSync(recent);
  await run(dir, { until: "implement" });
  assert.equal(fs.readdirSync(LOCAL(dir, "discarded")).includes(path.basename(old)), false, "the old entry was removed");
  assert.ok(fs.existsSync(recent), "a six-day-old entry is kept");
  assert.ok(fs.existsSync(path.join(dir, "mergewright.yaml")), "the link was not followed");
  assert.equal(git(dir, "status", "--porcelain"), "");
});

// ── A flow without a worktree cannot have a writing role ────────────────────────────────

test("a writing role in a flow with 'worktree: false' is blocked even on a clean checkout, and nothing is committed", async () => {
  const dir = project({ cardExtra: "flow: direct\n" });
  write(dir, "flows/direct.flow.yaml", "id: direct\ndescription: Work directly on the base branch.\nworktree: false\nphases:\n  - id: implement\n    role: worker\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "direct flow");
  useScript(script());
  const main = git(dir, "rev-parse", "main");
  const s = await run(dir);
  assert.equal(s.status, "blocked");
  assert.match(s.reason!, /'worktree: false'.*Run 'mw check'/);
  assert.equal(counters(dir).worker, undefined);
  assert.equal(git(dir, "rev-parse", "main"), main);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

// ── Reflection re-checks memory immediately before it writes ────────────────────────────

test("an owner's memory edit made after the first check (here, while the reflector reruns) is never overwritten", async () => {
  const dir = project();
  const long = `# State\n\n${Array.from({ length: 200 }, (_, n) => `- line ${n}`).join("\n")}\n`;
  useScript(script({
    reflector: [
      { output: reflection({ state: long }) },
      { writes: { "memory/STATE.md": "# State\n\nThe owner's edit, saved meanwhile.\n" }, output: reflection() },
    ],
  }));
  const s = await run(dir);
  assert.equal(s.status, "blocked", s.reason);
  assert.match(s.reason!, /memory\/ has uncommitted changes \(memory\/STATE\.md\)/);
  assert.equal(read(dir, "memory/STATE.md"), "# State\n\nThe owner's edit, saved meanwhile.\n");
  assert.equal(subjects(dir)[0], `${ID}: Card ${ID}`, "no memory commit");
  assert.equal(git(dir, "status", "--porcelain"), "M memory/STATE.md");
});

test("applyReflection computes everything, then calls the guard, then writes; a guard that throws leaves every file as it was", () => {
  const dir = newProject();
  const p = new Project(dir);
  const before = files(path.join(dir, "memory"));
  let seen: string[] | undefined;
  const guard = () => { seen = files(path.join(dir, "memory")); throw new MwError("memory/dirty", "memory/ changed"); };
  const r = reflection({ decisions: [{ title: "Use X", body: "Because." }] }) as unknown as memory.Reflection;
  assert.throws(() => (memory.applyReflection as (...a: unknown[]) => unknown)(p, ID, "Card", r, { guard }), /memory\/ changed/);
  assert.deepEqual(seen, before, "nothing was written before the guard ran");
  assert.deepEqual(files(path.join(dir, "memory")), before, "nothing was written after it refused");
});

// ── Smaller items ───────────────────────────────────────────────────────────────────────

test("mw abort --force takes over a lease another machine holds and says so; plain mw abort is refused naming the holder", async () => {
  const p = hubPair();
  useScript(script());
  await as("alpha", at(0), () => runCard(new Project(p.a), ID, { until: "gate" }));
  mirror(p.a, p.b);
  const env = (now: string) => ({ MW_HOST: "beta", MW_NOW: now });
  let r = mw(p.b, ["abort", ID], env(at(4)));
  assert.equal(r.code, 1);
  assert.match(r.err, /alpha \(pid \d+\) holds the lease/);
  assert.equal(state(p.b).status, "running");
  r = mw(p.b, ["abort", ID, "--force"], env(at(4)));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /took the lease over from alpha/);
  assert.match(r.out, /DEMO-1 aborted: .*its branch was deleted/);
  assert.equal(state(p.b).status, "aborted");
  assert.equal(hubRef(p.hubDir, `card/${ID}`), "", "the hub's card branch was deleted, fenced by beta's lease");
  assert.equal((await openHub(new Project(p.b)).observe()).lease?.host, "beta");
});

test("mw config set refuses a value that makes a role invalid, and the file never holds it", () => {
  const dir = newProject();
  const original = read(dir, "mergewright.yaml");
  const r = mw(dir, ["config", "set", "roles.worker", "{runs: shell}"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /role 'worker' has 'runs: shell' and needs a 'command'/);
  assert.equal(read(dir, "mergewright.yaml"), original);
  assert.equal(mw(dir, ["config", "set", "roles.worker", "{runs: shell, command: my-agent}"]).code, 0);
  assert.match(read(dir, "mergewright.yaml"), /command: my-agent/);
});

test("mw memory add lesson and decision are the owner's; the MCP template offers its example to the worker and the reviewer", () => {
  const dir = newProject();
  for (const args of [["memory", "add", "lesson", "--topic", "t", "--title", "T", "--body", "B"], ["memory", "add", "decision", "--title", "T", "--body", "B"]]) {
    const r = mw(dir, args, { MW_ROLE: "worker" });
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, /is done by the owner, not from inside a card run/);
  }
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.match(read(PACKAGE_ROOT, "template/mcps/README.md"), /^roles: \[worker, reviewer\]$/m);
});

test("a worktree moved aside loses its git pointer, so commands inside the copy cannot reach a live worktree", async () => {
  const { discardWorktree } = await import("../src/engine/gitops.ts");
  const helpers = await import("./engine-helpers.ts");
  const dir = helpers.project();
  helpers.useScript(helpers.script());
  await helpers.run(dir, { until: "gate" });
  const { Project } = await import("../src/project.ts");
  const to = discardWorktree(new Project(dir), "DEMO-1")!;
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  assert.equal(fsm.existsSync(pathm.join(to, ".git")), false);
  assert.equal(fsm.readdirSync(to).filter((n) => n.startsWith(".git.discarded-")).length, 1, "the pointer was renamed to a unique name");
  assert.equal(fsm.existsSync(pathm.join(to, "src")), true, "the files are kept");
});

// ── Runtime git runs no repository hooks and carries no service secrets ──
test("a hook a worker installed does not run under the runtime, and git never sees service credentials", async () => {
  const util = await import("../src/util.ts");
  const helpers = await import("./helpers.ts");
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  const dir = helpers.newProject();
  const out = pathm.join(helpers.tmpDir(), "hook-ran");
  const hooks = pathm.join(dir, ".git", "hooks");
  fsm.mkdirSync(hooks, { recursive: true });
  for (const h of ["post-commit", "prepare-commit-msg", "pre-commit", "post-checkout"]) {
    fsm.writeFileSync(pathm.join(hooks, h), `#!/bin/sh\nenv > "${out}"\n`, { mode: 0o755 });
  }
  util.markSecretEnv("MW_T_SERVICE_PASSWORD_FROM_FILE");
  process.env.MW_T_SERVICE_PASSWORD_FROM_FILE = "hunter2";
  process.env.MW_T_API_TOKEN = "tok";
  try {
    helpers.write(dir, "a.txt", "x\n");
    util.git(dir, ["add", "a.txt"]);
    util.git(dir, ["commit", "-q", "-m", "runtime commit"]);
    assert.equal(fsm.existsSync(out), false, "no hook ran for a runtime commit");
    const env = util.gitEnv();
    assert.equal(env.MW_T_SERVICE_PASSWORD_FROM_FILE, undefined);
    assert.equal(env.MW_T_API_TOKEN, undefined);
    assert.equal(env.PATH, process.env.PATH);
    // The owner's own git still runs the hook: only the runtime is shielded.
    helpers.write(dir, "b.txt", "y\n");
    helpers.git(dir, "add", "b.txt");
    helpers.git(dir, "commit", "-q", "-m", "owner commit");
    assert.equal(fsm.existsSync(out), true);
  } finally {
    delete process.env.MW_T_SERVICE_PASSWORD_FROM_FILE; delete process.env.MW_T_API_TOKEN;
  }
});
