// Regression tests for Hermes driving a hub-backed project through the MCP server.
//   1. MCP servers Hermes starts have no SSH agent: git finds one in the runtime directory, `mw hermes
//      init` writes SSH_AUTH_SOCK into the server entry, `mw doctor` reports the agent.
//   2. The hub's error text keeps git's last three lines, without a doubled period.
//   3. mw_approve and mw_run_start report a detached `mw` that fails at once as an error.
//   4. mw_spec_get, mw_req_get and mw_card_get return the acceptance criteria.
//   5. Follow-up cards get the documentation paths, risk medium and pass `mw check --strict`.
//   6. The automatic documentation scope leaves protected paths out; check warns card/scope-protected.
//   7. describeRun says a run a live process holds is running.
//   8. This host's lease left by a dead process is stale: shown as such, taken over by the next taker.
//   9. Letta's chat model is a required setting, and mw doctor shows the agent's handle.
// Only long-standing symbols are imported statically, so a missing newer one fails its own test
// instead of the whole file.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { check } from "../src/check.ts";
import { newCard } from "../src/cards.ts";
import { doctor } from "../src/commands-integrations.ts";
import { describeRun } from "../src/engine/run.ts";
import { processIdentity } from "../src/engine/procid.ts";
import { openHub } from "../src/hub.ts";
import { callTool, TOOLS } from "../src/mcpserver/server.ts";
import type { ToolContext } from "../src/mcpserver/tool.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { Project } from "../src/project.ts";
import { gitEnv } from "../src/util.ts";
import { adjudication, finding, findings, lockPath, project, run, script, useScript } from "./engine-helpers.ts";
import { addPackage, git, lettaConfig, mw, newProject, patchConfig, read, SPEC, tmpDir, write } from "./helpers.ts";


const servers: (net.Server | http.Server)[] = [];
const children: number[] = [];
after(() => {
  for (const s of servers) s.close();
  for (const pid of children) { try { process.kill(pid); } catch { /* gone */ } }
});

/** A runtime directory holding a listening unix socket at `rel` (an "agent" that hangs up at once). */
async function runtimeDirWithSocket(rel = "ssh-agent.socket"): Promise<{ dir: string; sock: string }> {
  const dir = fs.mkdtempSync(path.join("/tmp", "mw11-"));
  const sock = path.join(dir, rel);
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  const server = net.createServer((c) => c.destroy());
  await new Promise<void>((r) => server.listen(sock, r));
  servers.push(server);
  return { dir, sock };
}

async function withEnv<T>(vars: Record<string, string | undefined>, f: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    return await f();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function ctxFor(dir: string): ToolContext {
  return { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined };
}

async function call(dir: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, `the tool ${name} exists`);
  const cwd = process.cwd();
  try {
    const r = await callTool(tool, args, ctxFor(dir));
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  } finally {
    process.chdir(cwd);
  }
}

/** A PATH with git and sh but neither hermes nor mw. */
function barePath(): string {
  const bin = tmpDir("mw-path-");
  for (const tool of ["git", "sh", "bash", "env"]) {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      const f = path.join(dir, tool);
      if (fs.existsSync(f)) { fs.symlinkSync(f, path.join(bin, tool)); break; }
    }
  }
  return bin;
}

// ── 1. SSH agent ──

test("with SSH_AUTH_SOCK unset, gitEnv finds the agent socket in $XDG_RUNTIME_DIR", async () => {
  const { dir, sock } = await runtimeDirWithSocket();
  await withEnv({ SSH_AUTH_SOCK: undefined, XDG_RUNTIME_DIR: dir }, () => {
    assert.equal(gitEnv().SSH_AUTH_SOCK, sock);
  });
  const other = await runtimeDirWithSocket("keyring/ssh");
  await withEnv({ SSH_AUTH_SOCK: undefined, XDG_RUNTIME_DIR: other.dir }, () => {
    assert.equal(gitEnv().SSH_AUTH_SOCK, other.sock, "the keyring's socket");
  });
  const empty = fs.mkdtempSync(path.join("/tmp", "mw11-"));
  fs.writeFileSync(path.join(empty, "ssh-agent.socket"), "not a socket");
  await withEnv({ SSH_AUTH_SOCK: undefined, XDG_RUNTIME_DIR: empty }, () => {
    assert.equal(gitEnv().SSH_AUTH_SOCK, undefined, "a plain file is not an agent");
  });
  await withEnv({ SSH_AUTH_SOCK: "/run/given.sock", XDG_RUNTIME_DIR: dir }, () => {
    assert.equal(gitEnv().SSH_AUTH_SOCK, "/run/given.sock", "a set SSH_AUTH_SOCK wins");
  });
});

test("mw hermes init writes the agent socket into the server entry; status says which", async () => {
  const { dir: runtime, sock } = await runtimeDirWithSocket();
  const proj = newProject();
  addPackage(proj, "hermes");
  const home = tmpDir("mw-home-");
  const hermesHome = path.join(home, ".hermes");
  fs.mkdirSync(hermesHome, { recursive: true });
  const env = { HOME: home, HERMES_HOME: hermesHome, PATH: barePath(), SSH_AUTH_SOCK: "", XDG_RUNTIME_DIR: runtime };
  const r = mw(proj, ["hermes", "init"], env);
  assert.equal(r.code, 0, r.err);
  const config = fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8");
  assert.match(config, new RegExp(`  mergewright-demo:\\n[\\s\\S]*    env:\\n      SSH_AUTH_SOCK: ${sock.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\n`));
  assert.match(r.out, new RegExp(`SSH_AUTH_SOCK=${sock}`));
  assert.match(mw(proj, ["hermes", "init"], env).out, /already registered/, "idempotent");
  const st = mw(proj, ["hermes", "status"], env);
  assert.match(st.out, new RegExp(`ssh agent: the entry sets SSH_AUTH_SOCK=${sock}`));

  // Without any agent: no env, and a note says so.
  const bare = fs.mkdtempSync(path.join("/tmp", "mw11-"));
  const proj2 = newProject();
  addPackage(proj2, "hermes");
  const r2 = mw(proj2, ["hermes", "init"], { ...env, XDG_RUNTIME_DIR: bare, HERMES_HOME: path.join(home, ".hermes2") });
  assert.equal(r2.code, 0, r2.err);
  assert.doesNotMatch(fs.readFileSync(path.join(home, ".hermes2", "config.yaml"), "utf8"), /SSH_AUTH_SOCK/);
  assert.match(r2.out, /no SSH agent was found/);
});

test("mw doctor reports the ssh agent, or none found", async () => {
  const { dir, sock } = await runtimeDirWithSocket();
  const p = new Project(newProject());
  const lines: string[] = [];
  await withEnv({ SSH_AUTH_SOCK: undefined, XDG_RUNTIME_DIR: dir }, () => doctor((l = "") => lines.push(l), p));
  const line = lines.find((l) => l.startsWith("ssh "));
  assert.ok(line, `an ssh line in:\n${lines.join("\n")}`);
  assert.match(line, new RegExp(`agent: ${sock}`));
  const empty = fs.mkdtempSync(path.join("/tmp", "mw11-"));
  const none: string[] = [];
  await withEnv({ SSH_AUTH_SOCK: undefined, XDG_RUNTIME_DIR: empty }, () => doctor((l = "") => none.push(l), p));
  assert.match(none.find((l) => l.startsWith("ssh ")) ?? "", /agent: none found/);
});

// ── 2. Hub error text ──

test("an unreachable hub's error keeps git's last three lines and no doubled period", async () => {
  const dir = newProject();
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace(/hub: none\b/, "hub: hub"));
  git(dir, "commit", "-qam", "use the hub");
  git(dir, "remote", "add", "hub", "ssh://mw-test.invalid/repo.git");
  await withEnv({ GIT_SSH_COMMAND: "false" }, async () => {
    await assert.rejects(openHub(new Project(dir)).sync(), (e: Error) => {
      assert.match(e.message, /cannot reach the hub 'hub'/);
      assert.match(e.message, /Could not read from remote repository\. \| Please make sure you have the correct access rights \| and the repository exists\. Check that/);
      assert.doesNotMatch(e.message, /\.\./);
      return true;
    });
  });
});

// ── 3. mw_approve and mw_run_start wait for the detached process ──

/** Hold card DEMO-1's run lock with a live process other than this one (a `sleep`). */
function holdLock(dir: string): number {
  const child = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  child.unref();
  children.push(child.pid!);
  const id = processIdentity(child.pid!);
  fs.mkdirSync(path.dirname(lockPath(dir)), { recursive: true });
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: child.pid, host: os.hostname(), started: new Date().toISOString(), ...(id.started ? { procStart: id.started } : {}) }));
  return child.pid!;
}

test("mw_approve whose detached 'mw approve' fails returns an error with the log's end", async () => {
  useScript(script());
  const dir = project({ cardExtra: "risk: high\n" });
  const s = await run(dir);
  assert.equal(s.status, "waiting", s.reason);
  holdLock(dir);
  const r = await call(dir, "mw_approve", { id: "DEMO-1", word: s.reason! });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /failed \(exit 1\)/);
  assert.match(r.text, /DEMO-1 is (already )?being run by/);
});

test("mw_run_start whose detached 'mw run' fails at once returns an error", async () => {
  useScript(script());
  const dir = project();
  holdLock(dir);
  const r = await call(dir, "mw_run_start", { id: "DEMO-1" });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /DEMO-1 is (already )?being run by/);
});

// ── 4. Requirements and their acceptance criteria ──

function specProject(): string {
  const dir = newProject();
  write(dir, "specs/auth.spec.md", SPEC);
  write(dir, "cards/DEMO-1.card.md", "---\nid: DEMO-1\ntitle: Sign in\nkind: feature\nstatus: todo\nimplements: [REQ-auth-001]\nrevs: {REQ-auth-001: 1}\nscope: [src/**, docs/**]\n---\n\n## Why\n\nUsers sign in.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "spec and card");
  return dir;
}

test("mw_spec_get and mw_req_get return the acceptance criteria and the implementing cards", async () => {
  const dir = specProject();
  const spec = await call(dir, "mw_spec_get", { id: "auth" });
  assert.equal(spec.isError, false, spec.text);
  const sj = JSON.parse(spec.text);
  assert.equal(sj.id, "auth");
  assert.deepEqual(sj.requirements.map((r: { id: string }) => r.id), ["REQ-auth-001", "REQ-auth-002"]);
  const one = sj.requirements[0];
  assert.equal(one.priority, "must");
  assert.equal(one.rev, 1);
  assert.equal(one.status, "active");
  assert.deepEqual(one.acceptance_criteria.map((c: { id: string }) => c.id), ["AC-1", "AC-2"]);
  assert.match(one.acceptance_criteria[0].text, /^Given a registered user, when they submit valid credentials, then a session starts\.$/);
  assert.deepEqual(one.cards, [{ id: "DEMO-1", title: "Sign in", status: "todo" }]);
  const req = await call(dir, "mw_req_get", { id: "REQ-auth-002" });
  assert.equal(req.isError, false, req.text);
  const rj = JSON.parse(req.text);
  assert.equal(rj.title, "Sign out");
  assert.equal(rj.acceptance_criteria.length, 1);
  assert.deepEqual(rj.cards, []);
  const missing = await call(dir, "mw_req_get", { id: "REQ-auth-099" });
  assert.equal(missing.isError, true);
  assert.equal((await call(dir, "mw_spec_get", { id: "nope" })).isError, true);
});

test("mw_card_get includes the requirements the card implements, with their criteria", async () => {
  const dir = specProject();
  const r = await call(dir, "mw_card_get", { id: "DEMO-1" });
  assert.equal(r.isError, false, r.text);
  const j = JSON.parse(r.text);
  assert.ok(Array.isArray(j.requirements), "a requirements section");
  assert.equal(j.requirements[0].id, "REQ-auth-001");
  assert.equal(j.requirements[0].acceptance_criteria.length, 2);
  assert.equal(TOOLS.length, 31, "37 core tools before (mw_mem0_add and mw_mem0_search moved to the mem0 package), plus mw_spec_get, mw_req_get and mw_card_lint, then mw_run_file, mw_packages and mw_settings; mw_letta_add and mw_letta_search moved to the letta package, mw_docs_ask and mw_docs_sync to the open-notebook package, the eight mw_kanban_* tools to the cline-kanban package");
});

// ── 5. Follow-up cards ──

test("follow-up cards get the documentation paths, risk medium (unless named), and pass mw check --strict", async () => {
  useScript(script({
    reviewer: [{ output: findings([finding("R-01", true)]) }],
    adjudicator: [{ output: adjudication("approve", { rejected: [{ id: "reviewer:R-01", reason: "out of scope for this card" }], follow_ups: [
      { title: "Index the orders table", why: "a slow query", scope: ["db/**"], kind: "fix" },
      { title: "Tidy the agents file", why: "it is stale", scope: ["src/**", "AGENTS.md"], risk: "high" },
    ] }) }],
  }));
  const dir = project();
  write(dir, "mergewright.yaml", read(dir, "mergewright.yaml").replace(/default: medium/, "default: low"));
  git(dir, "commit", "-qam", "risk low");
  const s = await run(dir);
  assert.equal(s.status, "done", s.reason);
  const two = parseFrontmatter(read(dir, "cards/DEMO-2.card.md"));
  assert.equal(two.data.risk, "medium", "medium, not the parent's risk");
  assert.deepEqual(two.data.scope, ["db/**", "docs/**", "README.md"]);
  const three = parseFrontmatter(read(dir, "cards/DEMO-3.card.md"));
  assert.equal(three.data.risk, "high", "the risk the follow-up names");
  assert.deepEqual(three.data.scope, ["src/**", "docs/**", "README.md"], "no protected path");
  const items = check(new Project(dir)).items.filter((d) => d.file === "cards/DEMO-2.card.md" || d.file === "cards/DEMO-3.card.md");
  assert.deepEqual(items.map((d) => `${d.code}: ${d.message}`), []);
});

// ── 6. Protected paths and the automatic scope ──

test("the automatic docs scope leaves protected paths out; check warns card/scope-protected", () => {
  const dir = newProject();
  write(dir, "mergewright.yaml", `${read(dir, "mergewright.yaml").trimEnd()}\ndocs:\n  paths: [docs/**, README.md, AGENTS.md]\n`);
  git(dir, "commit", "-qam", "docs paths");
  const id = newCard(new Project(dir), { title: "Change src", kind: "chore", scope: ["src/**"], withDocs: true });
  const card = parseFrontmatter(read(dir, `cards/${id}.card.md`));
  assert.deepEqual(card.data.scope, ["src/**", "docs/**", "README.md"]);
  write(dir, "cards/DEMO-8.card.md", "---\nid: DEMO-8\ntitle: Touch agents\nkind: chore\nstatus: todo\nscope: [src/**, AGENTS.md, docs/**]\n---\n\n## Why\n\nX.\n");
  write(dir, "cards/DEMO-9.card.md", "---\nid: DEMO-9\ntitle: Touch agents, granted\nkind: chore\nstatus: todo\nscope: [src/**, AGENTS.md, docs/**]\nallow_protected: [AGENTS.md]\n---\n\n## Why\n\nX.\n");
  const d = check(new Project(dir)).items.filter((x) => x.code === "card/scope-protected");
  assert.deepEqual(d.map((x) => x.file), ["cards/DEMO-8.card.md"]);
  assert.equal(d[0]!.severity, "warning");
  assert.match(d[0]!.message, /AGENTS\.md/);
});

// ── 7. describeRun of a running run ──

test("describeRun says a run a live process holds is running, with phase, round, time and host", async () => {
  useScript(script());
  const dir = project();
  const s = await run(dir, { until: "gate" });
  assert.equal(s.status, "running");
  const pid = holdLock(dir);
  const said = describeRun(new Project(dir), s);
  assert.match(said, new RegExp(`^DEMO-1 is running: phase gate \\(round ${s.round}\\) since ${s.updated.replace(/[.]/g, "\\.")} on ${s.host}`));
  assert.match(said, new RegExp(`process ${pid}`));
  fs.rmSync(lockPath(dir));
  assert.match(describeRun(new Project(dir), s), /stopped before 'gate'/, "no live process: stopped");
});

// ── 8. Stale lease on this host ──

function hubPair(): string {
  const tmp = tmpDir("mw-hub-");
  const hubDir = path.join(tmp, "hub.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", hubDir);
  const a = newProject();
  write(a, "mergewright.yaml", read(a, "mergewright.yaml").replace(/hub: none\b/, "hub: hub"));
  git(a, "commit", "-qam", "use the hub");
  git(a, "remote", "add", "hub", hubDir);
  git(a, "push", "-q", "hub", "main");
  return a;
}

/** Take the lease in a separate, short-lived process (as a crashed run or a one-off push leaves it). */
function takeAndExit(dir: string, host: string): void {
  const code = `const { openHub } = await import(${JSON.stringify(path.join(import.meta.dirname, "..", "src", "hub.ts"))});
const { Project } = await import(${JSON.stringify(path.join(import.meta.dirname, "..", "src", "project.ts"))});
await openHub(new Project(process.argv[1]), { warn: () => undefined }).take();`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, dir], { env: { ...process.env, MW_HOST: host }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

test("this host's lease left by a dead process is stale: shown so, released without --force, taken over by the next taker", async () => {
  const dir = hubPair();
  const host = "h11-host";
  const env = { MW_HOST: host };
  takeAndExit(dir, host);
  const show = mw(dir, ["lease", "show"], env);
  assert.equal(show.code, 0, show.err);
  assert.match(show.out, /stale/);
  assert.match(show.out, /mw lease release/);
  const rel = mw(dir, ["lease", "release"], env);
  assert.equal(rel.code, 0, rel.err);
  assert.match(rel.out, /lease released by h11-host \(it was stale/);

  takeAndExit(dir, host);
  await withEnv({ MW_HOST: host }, async () => {
    const r = await openHub(new Project(dir), { warn: () => undefined }).take();
    assert.equal(r.refreshed, false, "taken over, not refreshed: the taker owns it now");
    assert.equal(r.previous?.host, host);
    // Now held by this (live) process: not stale.
    assert.doesNotMatch(mw(dir, ["lease", "show"], env).out, /stale/);
  });

  // The owner's 'mw lease take' is a hold: not stale after that command ends.
  assert.equal(mw(dir, ["lease", "take"], env).code, 0);
  assert.doesNotMatch(mw(dir, ["lease", "show"], env).out, /stale/);
});

// ── 9. Letta ──

test("Letta's models are required settings; mw doctor shows the agent's handle and a mismatch", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/v1/health")) { res.end(JSON.stringify({ version: "0.16.8" })); return; }
    if (req.url?.startsWith("/v1/agents/")) { res.end(JSON.stringify([{ id: "agent-1", name: "mergewright-demo", llm_config: { handle: "openai-proxy/qwen3.5-9b", model: "qwen3.5-9b" } }])); return; }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const dir = newProject();
  patchConfig(dir, lettaConfig({ url }));
  const p = new Project(dir);
  const { settingsOf } = await import(pathToFileURL(path.join(PACKAGE_ROOT, "packages", "letta", "index.mjs")).href);
  const s = settingsOf(p.config.packages.letta, p.config.name);
  assert.equal(s.model, "openai-proxy/qwen3.6-35b-a3b");
  assert.equal(s.embedding, "qwen3-embedding-0.6b");
  const lines: string[] = [];
  await doctor((l = "") => lines.push(l), p);
  const line = lines.find((l) => l.startsWith("letta")) ?? "";
  assert.match(line, /using chat model handle openai-proxy\/qwen3\.5-9b, NOT openai-proxy\/qwen3\.6-35b-a3b \(packages\.letta\.model\)/);

  patchConfig(dir, lettaConfig({ url, model: "openai-proxy/qwen3.5-9b" }));
  const q = new Project(dir);
  assert.equal(settingsOf(q.config.packages.letta, q.config.name).model, "openai-proxy/qwen3.5-9b", "packages.letta.model still overrides");
  const lines2: string[] = [];
  await doctor((l = "") => lines2.push(l), q);
  assert.match(lines2.find((l) => l.startsWith("letta")) ?? "", /using chat model handle openai-proxy\/qwen3\.5-9b(?!, NOT)/);
});
