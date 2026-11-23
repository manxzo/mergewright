// Regression tests for the lease at stop points, delegation prompts, memory and search.
//   1. `mw run` / `mw approve` returning with the run waiting at a stop point release the lease
//      (kept only with --keep-lease, then as the owner's hold).
//   2. mw_delegate takes a `card`: the role's prompt gets that card's full context, as its brief phase
//      would; without one, {{card}} and {{requirements}} say there is no card.
//   3. Every card phase and delegation has memory/STATE.md and memory/RULES.md in its prompt.
//   4. `mw check --strict` says how many errors are promoted warnings.
//   5. mw_mem0_add stores verbatim by default; an inference that stored nothing says so.
//   6. Text docs search: hits sorted by relevance, a 160-character snippet from the source's text.
//   7. mw doctor: a `local` line, the kanban board on another machine, a notebook not created yet.
//   8. An idempotent Letta push lists the archive once instead of searching per record; mem0 does not
//      search when its listing is complete.
//   9. `mw memory prune --service mem0|letta --match TEXT`.
// Only long-standing symbols are imported statically, so a missing newer one fails its own test
// instead of the whole file.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { main } from "../src/cli.ts";
import { doctor } from "../src/commands-integrations.ts";
import { pushMemory } from "../src/integrations.ts";
import { loadPackages } from "../src/packages/loader.ts";
import { callTool, packageTools, TOOLS } from "../src/mcpserver/server.ts";
import type { ToolContext } from "../src/mcpserver/tool.ts";
import { addLesson } from "../src/memory.ts";
import { Project } from "../src/project.ts";
import { brief, hubPair, project, script, useScript } from "./engine-helpers.ts";
import { mockServer, projectWith, type Mock, type Recorded } from "./fixtures/integrations/support.ts";
import { git, kanbanConfig, lettaConfig, mem0Config, notebookConfig, mw, newProject, read, SPEC, tmpDir, write } from "./helpers.ts";

process.env.MW_ENV_FILE = "/dev/null";

const mocks: Mock[] = [];
after(async () => { for (const m of mocks) await m.close(); });
async function mock(route: (r: Recorded) => { status?: number; body?: unknown } | undefined): Promise<Mock> {
  const m = await mockServer(route);
  mocks.push(m);
  return m;
}

function ctxFor(dir: string): ToolContext {
  return { root: dir, project: () => new Project(dir), signal: new AbortController().signal, log: () => undefined };
}

async function call(dir: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  // The core's tools, then those of the project's enabled packages (mw_mem0_* come from the mem0 package).
  const tool = TOOLS.find((t) => t.name === name) ?? (await packageTools(new Project(dir))).find((t) => t.name === name);
  assert.ok(tool, `the tool ${name} exists`);
  const cwd = process.cwd();
  try {
    const r = await callTool(tool, args, ctxFor(dir));
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  } finally {
    process.chdir(cwd);
  }
}

/** Run `mw ARGS` in this process (so in-process mock servers answer), in `dir`. */
async function mwIn(dir: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const cwd = process.cwd();
  const lines: string[] = [];
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
  process.chdir(dir);
  try {
    const code = await main(args, (l = "") => lines.push(l));
    return { code, out: lines.join("\n"), err: errs.join("\n") };
  } finally {
    console.error = origErr;
    process.chdir(cwd);
  }
}

// ── 1. The lease while a run waits at a stop point ──

test("'mw run' and 'mw approve' returning with the run waiting release the lease; --keep-lease keeps it as the owner's", () => {
  const env = (s: string) => ({ MW_MOCK_SCRIPT: s, MW_HOST: "alpha" });
  const noHolder = /no machine holds the lease/;
  let p = hubPair({ cardExtra: "risk: high\n" });
  const sc = useScript(script());
  let r = mw(p.a, ["run", "DEMO-1"], env(sc));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /waiting before 'implement' for approval 'go'/);
  assert.match(r.out, /released the lease/);
  assert.match(mw(p.a, ["lease", "show"], env(sc)).out, noHolder);
  r = mw(p.a, ["approve", "DEMO-1", "go"], env(sc));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /waiting before 'merge' for approval 'merge'/);
  assert.match(mw(p.a, ["lease", "show"], env(sc)).out, noHolder, "approve took the lease and released it again");

  // --keep-lease while waiting: held, and as the owner's hold (never stale once this process ends).
  p = hubPair({ cardExtra: "risk: high\n" });
  r = mw(p.a, ["run", "DEMO-1", "--keep-lease"], env(sc));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /waiting before 'implement'/);
  const show = mw(p.a, ["lease", "show"], env(sc)).out;
  assert.match(show, /lease held by alpha/);
  assert.doesNotMatch(show, /stale/);
});

// ── 2 and 3. mw_delegate with a card; state and rules in every prompt ──

function delegateProject(): string {
  const dir = project({ cardExtra: "implements: [REQ-auth-001]\nrevs: {REQ-auth-001: 1}\n" });
  write(dir, "specs/auth.spec.md", SPEC);
  write(dir, "memory/STATE.md", "# State\n\nMARKER-STATE: the auth module is half done.\n");
  write(dir, "memory/RULES.md", `${read(dir, "memory/RULES.md").trimEnd()}\n- MARKER-RULE: never skip the gate.\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "spec, state and rules");
  return dir;
}

function promptOf(dir: string, text: string): string {
  const runDir = JSON.parse(text).run_dir as string;
  return fs.readFileSync(path.join(dir, runDir, "phases", "delegate.prompt.md"), "utf8");
}

test("mw_delegate with role planner and card renders the card, its requirements with criteria, memory and docs; without a card they say so", async () => {
  const dir = delegateProject();
  process.env.MW_DELEGATE_ALLOW_MOCK = "1";
  useScript(script({ planner: [{ output: brief() }] }));
  const r = await call(dir, "mw_delegate", { role: "planner", card: "DEMO-1", task: "Check this card can be done as written." });
  assert.equal(r.isError, false, r.text);
  const prompt = promptOf(dir, r.text);
  assert.match(prompt, /- id: DEMO-1\n- title: Card DEMO-1\n- kind: feature/);
  assert.match(prompt, /### REQ-auth-001 Sign in with email and password/);
  assert.match(prompt, /- AC-1: Given a registered user, when they submit valid credentials, then a session starts\./);
  assert.match(prompt, /MARKER-STATE/);
  assert.match(prompt, /MARKER-RULE/);
  assert.match(prompt, /## Task\n\nCheck this card can be done as written\./);
  assert.doesNotMatch(prompt, /\{\{/);

  const bare = await call(dir, "mw_delegate", { role: "planner", task: "Plan a sign-out button." });
  assert.equal(bare.isError, false, bare.text);
  const p2 = promptOf(dir, bare.text);
  assert.equal(p2.split("(none: not a card; the task text is the whole request)").length - 1, 2, "card and requirements");
  assert.match(p2, /## Task\n\nPlan a sign-out button\./);
  const tool = TOOLS.find((t) => t.name === "mw_delegate")!;
  assert.match(tool.description, /STATE\.md/);
  assert.match(JSON.stringify(tool.inputSchema), /"card"/);

  const unknown = await call(dir, "mw_delegate", { role: "planner", card: "DEMO-99", task: "x" });
  assert.equal(unknown.isError, true);
});

test("a role whose prompt does not place memory.state/rules still gets STATE.md and RULES.md, in a delegation and in a card phase", async () => {
  const dir = delegateProject();
  process.env.MW_DELEGATE_ALLOW_MOCK = "1";
  useScript(script());
  const r = await call(dir, "mw_delegate", { role: "reviewer", task: "Is the design sound?", mode: "advise" });
  assert.equal(r.isError, false, r.text);
  const prompt = promptOf(dir, r.text);
  assert.match(prompt, /## Where the project is now \(memory\/STATE\.md\)\n\n# State\n\nMARKER-STATE/);
  assert.match(prompt, /## Project rules \(memory\/RULES\.md\)\n\n[\s\S]*MARKER-RULE/);

  // A card run: the worker's prompt (preset worker.role.md uses neither placeholder) has both.
  const env = { MW_MOCK_SCRIPT: useScript(script()) };
  const run = mw(dir, ["run", "DEMO-1", "--until", "gate"], env);
  assert.equal(run.code, 0, run.out + run.err);
  const phases = path.join(dir, ".mergewright", "runs", "DEMO-1", "phases");
  const worker = fs.readdirSync(phases).filter((f) => /implement.*\.prompt\.md$/.test(f));
  assert.ok(worker.length, fs.readdirSync(phases).join(", "));
  const wp = fs.readFileSync(path.join(phases, worker[0]!), "utf8");
  assert.match(wp, /MARKER-STATE/);
  assert.match(wp, /MARKER-RULE/);
  // The planner places them itself: once each.
  const planner = fs.readdirSync(phases).find((f) => /brief.*\.prompt\.md$/.test(f))!;
  assert.equal(fs.readFileSync(path.join(phases, planner), "utf8").split("MARKER-STATE").length - 1, 1);
});

// ── 4. mw check --strict ──

test("'mw check --strict' keeps the warning: prefix and says how many errors are promoted warnings", () => {
  const dir = newProject();
  write(dir, "cards/DEMO-8.card.md", "---\nid: DEMO-8\ntitle: Touch agents\nkind: chore\nstatus: todo\nscope: [src/**, AGENTS.md, docs/**]\n---\n\n## Why\n\nX.\n");
  const plain = mw(dir, ["check"]);
  assert.match(plain.out, /^0 error\(s\), \d+ warning\(s\)$/m);
  const warnings = Number(/^0 error\(s\), (\d+) warning\(s\)$/m.exec(plain.out)![1]);
  assert.ok(warnings >= 1);
  const strict = mw(dir, ["check", "--strict"]);
  assert.equal(strict.code, 1);
  assert.match(strict.out, /warning: .*\[card\/scope-protected\]/);
  assert.match(strict.out, new RegExp(`^${warnings} error\\(s\\) \\(${warnings} of them warnings promoted by --strict\\)$`, "m"));
});

// ── 6. mw_mem0_add ──

test("mw_mem0_add stores verbatim by default (infer false); infer=true with nothing extracted says so", async () => {
  let reply: unknown[] = [{ id: "m1", memory: "x", event: "ADD" }];
  const m = await mock((r) => (r.method === "POST" && r.url === "/memories" ? { body: { results: reply } } : undefined));
  const { dir } = projectWith(mem0Config({ url: m.url }));
  const r = await call(dir, "mw_mem0_add", { text: "The gate runs in CI." });
  assert.equal(r.isError, false, r.text);
  assert.equal((m.requests.at(-1)!.body as { infer: boolean }).infer, false);
  reply = [];
  const r2 = await call(dir, "mw_mem0_add", { text: "Something vague.", infer: true });
  assert.equal(r2.isError, false, r2.text);
  assert.equal((m.requests.at(-1)!.body as { infer: boolean }).infer, true);
  assert.equal(r2.text, "mem0 extracted no facts from the text (infer=true); nothing stored");
  const tool = (await packageTools(new Project(dir))).find((t) => t.name === "mw_mem0_add")!;
  assert.match(JSON.stringify(tool.inputSchema), /default false/);
});

// ── 7. Docs text search ──

async function notebookMock(): Promise<Mock> {
  const body = `${"Intro words. ".repeat(60)}The lease is a git reference on the hub that one machine holds at a time. ${"More text. ".repeat(40)}`;
  return mock((r) => {
    const u = new URL(r.url, "http://x");
    if (r.method === "GET" && u.pathname === "/api/notebooks") return { body: [{ id: "notebook:1", name: "demo" }] };
    if (r.method === "POST" && u.pathname === "/api/search") {
      const b = r.body as { type: string };
      if (b.type === "text") {
        return { body: { total_count: 3, search_type: "text", results: [
          { id: "source:a", parent_id: "source:a", relevance: 6.551917552947998, title: "docs/a.md" },
          { id: "source:b", parent_id: "source:b", relevance: 11.204813003540039, title: "docs/b.md" },
          { id: "source:c", parent_id: "source:c", title: "docs/c.md" },
        ] } };
      }
      return { body: { total_count: 1, search_type: "vector", results: [{ id: "source:a", parent_id: "source:a", matches: ["the lease commit unchanged", "second"], similarity: 0.5699432396676922, title: "docs/a.md" }] } };
    }
    const s = /^\/api\/sources\/(.+)$/.exec(u.pathname);
    if (r.method === "GET" && s) return { body: { id: decodeURIComponent(s[1]!), title: "t", full_text: body } };
    return undefined;
  });
}

test("text search hits are sorted by relevance, with a 160-character snippet from the source around the query; scores with two decimals or none", async () => {
  const m = await notebookMock();
  const { dir, project: p } = projectWith({ docs: { paths: ["docs/**"] }, ...notebookConfig({ url: m.url }) });
  const ex = (await loadPackages(p)).find((x) => x.name === "open-notebook")!.exports!;
  const hits = (await ex.searchDocs!("lease", 5, { text: true })).map((l) => /^(\S+)( \(([\d.]+)\))?: (.*)$/.exec(l)!);
  assert.deepEqual(hits.map((h) => h[1]), ["docs/b.md", "docs/a.md", "docs/c.md"]);
  for (const h of hits) {
    assert.ok(h[4]!.length > 0 && h[4]!.length <= 160, `snippet of ${h[1]}: ${JSON.stringify(h[4])}`);
    assert.match(h[4]!, /lease/);
  }
  assert.equal(hits[2]![3], undefined, "no score when the API gives none");
  const out = await mwIn(dir, ["docs", "search", "--text", "lease"]);
  assert.equal(out.code, 0, out.err);
  // The notebook's hits follow the repository's own, one labelled line each (mw docs search, lane C).
  assert.match(out.out, /^open-notebook: docs\/b\.md \(11\.20\): .*lease/m);
  assert.match(out.out, /^open-notebook: docs\/c\.md: /m, "no score when the API gives none");
  const vec = await mwIn(dir, ["docs", "search", "lease"]);
  assert.match(vec.out, /^open-notebook: docs\/a\.md \(0\.57\): the lease commit unchanged$/m);
});

// ── 8. mw doctor ──

test("mw doctor has a local line, says the board is on another machine, and that the notebook is not created yet", async () => {
  process.env.MW_TEST_LLAMA_KEY = "llama-test-key-not-a-secret";
  const llama = await mock((r) => {
    if (r.headers.authorization !== "Bearer llama-test-key-not-a-secret") return { status: 401, body: { error: "key" } };
    return r.url === "/v1/models" ? { body: { object: "list", data: [{ id: "qwen3.6-35b-a3b", object: "model" }] } } : undefined;
  });
  const nb = await mock((r) => (r.url === "/api/notebooks" ? { body: [{ id: "notebook:9", name: "other" }] } : undefined));
  const { project: p } = projectWith({
    local_models: { endpoint: `${llama.url}/v1`, key_env: "MW_TEST_LLAMA_KEY" },
    docs: { paths: ["docs/**"] },
    packages: { ...kanbanConfig({ path: "/nonexistent/mw-h12/board-project" }).packages, ...notebookConfig({ url: nb.url }).packages },
  });
  const lines: string[] = [];
  await doctor((l = "") => lines.push(l), p);
  const all = lines.join("\n");
  assert.match(lines.find((l) => l.startsWith("local")) ?? "", /configured, reachable, serving qwen3\.6-35b-a3b/, all);
  assert.match(lines.find((l) => l.startsWith("local")) ?? "", /MW_TEST_LLAMA_KEY set/);
  assert.doesNotMatch(all, /llama-test-key-not-a-secret/);
  assert.match(lines.find((l) => l.startsWith("kanban")) ?? "", /^kanban\s+ok\s+board on another machine \(packages\.cline-kanban\.path=\/nonexistent\/mw-h12\/board-project\); mirrored from there \(package cline-kanban\)$/, all);
  assert.match(lines.find((l) => l.startsWith("docs")) ?? "", /notebook 'demo' not created yet \(the first docs sync creates it\)/, all);

  const none: string[] = [];
  await doctor((l = "") => none.push(l), new Project(newProject()));
  assert.match(none.find((l) => l.startsWith("local")) ?? "", /not configured/);
});

// ── 9. Idempotent pushes ──

interface Passage { id: string; text: string; tags: string[] }

async function lettaMock(): Promise<Mock & { passages: Passage[] }> {
  const passages: Passage[] = [];
  let n = 0;
  const m = await mock((r) => {
    const u = new URL(r.url, "http://x");
    const b = r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r.method === "GET" && u.pathname === "/v1/agents/") return { body: n ? [{ id: "agent-1", name: "mergewright-demo" }] : [] };
    if (r.method === "POST" && u.pathname === "/v1/agents/") { n++; return { body: { id: "agent-1", name: b.name } }; }
    if (r.method === "POST" && u.pathname === "/v1/agents/agent-1/archival-memory") {
      const p = { id: `passage-${String(passages.length + 1).padStart(4, "0")}`, text: b.text, tags: b.tags ?? [] };
      passages.push(p);
      return { body: [p] };
    }
    if (r.method === "GET" && u.pathname === "/v1/agents/agent-1/archival-memory") {
      const limit = Number(u.searchParams.get("limit") ?? 100);
      const afterId = u.searchParams.get("after");
      const start = afterId ? passages.findIndex((p) => p.id === afterId) + 1 : 0;
      return { body: passages.slice(start, start + limit) };
    }
    if (r.method === "GET" && u.pathname === "/v1/agents/agent-1/archival-memory/search") return { body: { results: [], count: 0 } };
    const d = /^\/v1\/agents\/agent-1\/archival-memory\/(.+)$/.exec(u.pathname);
    if (r.method === "DELETE" && d) {
      const i = passages.findIndex((p) => p.id === decodeURIComponent(d[1]!));
      if (i < 0) return { status: 404, body: {} };
      passages.splice(i, 1);
      return { body: {} };
    }
    return undefined;
  });
  return Object.assign(m, { passages });
}

function withLessons(dir: string, count: number): void {
  const p = new Project(dir);
  for (let i = 1; i <= count; i++) addLesson(p, { topic: "testing", title: `Lesson number ${i}`, body: `Body of lesson ${i}.` });
}

test("an idempotent Letta push lists the archive once and searches no record", async () => {
  const letta = await lettaMock();
  const { dir, project: p } = projectWith(lettaConfig({ url: letta.url }));
  withLessons(dir, 4);
  const first = await pushMemory(p);
  assert.equal(first.deliveries[0]!.stored, 4);
  const before = letta.requests.length;
  const second = await pushMemory(new Project(dir));
  assert.equal(second.deliveries[0]!.present, 4);
  assert.equal(second.deliveries[0]!.stored, 0);
  const reqs = letta.requests.slice(before);
  assert.equal(reqs.filter((r) => r.url.includes("/archival-memory/search")).length, 0, reqs.map((r) => `${r.method} ${r.url}`).join("\n"));
  assert.equal(reqs.filter((r) => r.method === "GET" && /\/archival-memory\?/.test(r.url)).length, 1, "one listing page");
  assert.equal(letta.passages.length, 4, "nothing stored twice");
});

test("a mem0 push whose listing is complete searches no record", async () => {
  const store: { id: string; memory: string; metadata: Record<string, unknown> }[] = [];
  const m = await mock((r) => {
    const u = new URL(r.url, "http://x");
    const b = r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r.method === "POST" && u.pathname === "/memories") {
      const x = { id: `m${store.length + 1}`, memory: b.messages[0].content, metadata: b.metadata };
      store.push(x);
      return { body: { results: [{ id: x.id, memory: x.memory, event: "ADD" }] } };
    }
    if (r.method === "GET" && u.pathname === "/memories") return { body: { results: store.slice(0, Number(u.searchParams.get("top_k") ?? 100)) } };
    if (r.method === "POST" && u.pathname === "/search") return { body: { results: [] } };
    return undefined;
  });
  const { dir, project: p } = projectWith(mem0Config({ url: m.url }));
  withLessons(dir, 3);
  const first = await pushMemory(p);
  assert.equal(first.deliveries[0]!.stored, 3);
  assert.equal(m.requests.filter((r) => r.url === "/search").length, 0, "the complete listing decided");
  const second = await pushMemory(new Project(dir));
  assert.equal(second.deliveries[0]!.present, 3);
  assert.equal(m.requests.filter((r) => r.url === "/search").length, 0);
});

// ── 11. mw memory prune ──

test("'mw memory prune' deletes the records whose text contains the string, in mem0 and in Letta, printing each", async () => {
  const store = [
    { id: "m1", memory: "MCP memory check 1759700000" },
    { id: "m2", memory: "The gate runs in CI." },
    { id: "m3", memory: "another MCP memory check" },
    { id: "m4", memory: "written through the MCP server", metadata: { title: "MCP memory check", lesson_id: "x" } },
  ];
  const mem0 = await mock((r) => {
    const u = new URL(r.url, "http://x");
    if (r.method === "GET" && u.pathname === "/memories") return { body: { results: store } };
    const d = /^\/memories\/(.+)$/.exec(u.pathname);
    if (r.method === "DELETE" && d) { store.splice(store.findIndex((x) => x.id === d[1]), 1); return { body: { message: "deleted" } }; }
    return undefined;
  });
  const letta = await lettaMock();
  const { dir } = projectWith({ packages: { mem0: { url: mem0.url }, letta: { url: letta.url } } });
  // Two Letta passages in the agent's archive, one matching.
  letta.passages.push({ id: "passage-0001", text: "MCP memory check from the smoke test", tags: ["mergewright"] }, { id: "passage-0002", text: "Keep this one.", tags: ["mergewright"] });

  const dry = await mwIn(dir, ["memory", "prune", "--service", "mem0", "--match", "MCP memory check", "--dry-run"]);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /^would delete m1: MCP memory check 1759700000$/m);
  assert.equal(store.length, 4, "a dry run deletes nothing");

  const r = await mwIn(dir, ["memory", "prune", "--service", "mem0", "--match", "MCP memory check"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^deleted m1: /m);
  assert.match(r.out, /^deleted m3: /m);
  assert.match(r.out, /^deleted m4: MCP memory check: written through the MCP server$/m, "a lesson's title (mem0 metadata) counts");
  assert.match(r.out, /3 record\(s\) containing 'MCP memory check' deleted from mem0 \(demo\)/);
  assert.deepEqual(store.map((x) => x.id), ["m2"]);

  const l = await mwIn(dir, ["memory", "prune", "--service", "letta", "--match", "MCP memory check"]);
  assert.equal(l.code, 0, l.err);
  assert.match(l.out, /1 record\(s\) containing 'MCP memory check' deleted from letta \(mergewright-demo\)/);
  assert.deepEqual(letta.passages.map((x) => x.text), ["Keep this one."]);

  const bad = await mwIn(dir, ["memory", "prune", "--service", "mem0", "--match", "x"]);
  assert.equal(bad.code, 2, "a match of fewer than 3 characters is refused");
});
