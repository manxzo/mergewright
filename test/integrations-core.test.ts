// Integrations: queue, notify, the unconfigured no-op contract, and the CLI commands.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { integrationsFor } from "../src/integrations.ts";
import { fillArgs, HttpError, httpJson, MAX_RESPONSE_BYTES, splitCommand } from "../src/integrations/common.ts";
import { Queue } from "../src/integrations/queue.ts";
import { mw, tmpDir } from "./helpers.ts";
import { deadUrl, FIXTURES, projectWith, q, queueFiles, queueItems } from "./fixtures/integrations/support.ts";

test("command templates split without a shell and placeholders never re-split", () => {
  assert.deepEqual(splitCommand(`hermes send --to telegram --subject {subject} --file {file} -q`), ["hermes", "send", "--to", "telegram", "--subject", "{subject}", "--file", "{file}", "-q"]);
  assert.deepEqual(splitCommand(`a "b c" 'd "e"' f\\ g "" $(rm)`), ["a", "b c", 'd "e"', "f g", "", "$(rm)"]);
  assert.throws(() => splitCommand(`a "b`), /unclosed/);
  assert.deepEqual(fillArgs(["--subject", "{subject}", "x{file}y", "{other}"], { subject: "two words; rm -rf /", file: "/f" }), ["--subject", "two words; rm -rf /", "x/fy", "{other}"]);
});

test("the queue writes one JSON file per item and flush retries in order, keeping failures", async () => {
  const work = tmpDir();
  const qu = new Queue(work); // the folder that holds queue/ (.mergewright/local in a project)
  qu.add("a", "first", { n: 1 });
  qu.add("b", "second", { n: 2 });
  qu.add("a", "third", { n: 3 });
  qu.add("zzz", "unknown kind", {});
  const files = fs.readdirSync(path.join(work, "queue")).sort();
  assert.equal(files.length, 4);
  for (const f of files) assert.match(f, /^\d{8}-\d{9}Z-[a-z0-9_-]+-[a-z0-9]+\.json$/);
  assert.ok(!files.some((f) => f.startsWith(".")), "no temp files left behind");
  const seen: number[] = [];
  const results = await qu.flush({
    a: async (p) => { seen.push((p as { n: number }).n); },
    b: async (p) => { seen.push((p as { n: number }).n); throw new Error("service down"); },
  });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(results.map((r) => [r.summary, r.ok]), [["first", true], ["second", false], ["third", true], ["unknown kind", false]]);
  const left = qu.list();
  assert.deepEqual(left.map((x) => x.item.summary), ["second", "unknown kind"]);
  assert.equal(left[0]!.item.attempts, 1);
  assert.equal(left[0]!.item.lastError, "service down");
  assert.equal(qu.drop((it) => it.kind === "zzz"), 1);
  assert.equal(qu.list().length, 1);
});

test("with nothing configured every integration is a successful no-op that queues nothing", async () => {
  const { dir, project } = projectWith();
  const i = integrationsFor(project);
  await i.notify("s", "b");
  assert.deepEqual(await i.recall("anything", 5), []);
  await i.remember([{ topic: "t", title: "x", body: "y" }]);
  await i.docsSync(["docs/a.md"], []);
  assert.deepEqual(await i.usageOk(), { ok: true, detail: "no usage guard configured" });
  await i.mirrorCard("DEMO-1", "t", "in_progress");
  assert.equal(await i.forgeMerge({ card: "DEMO-1", branch: "card/DEMO-1", base: "main", title: "t", body: "b" }), undefined);
  assert.equal(fs.existsSync(path.join(dir, ".mergewright", "local", "queue")), false);
});

function notifyProject() {
  const script = path.join(FIXTURES, "fake-notify.mjs");
  return projectWith({ report: { command: `${q(process.execPath)} ${q(script)} --subject {subject} --file {file}` } });
}

test("notify runs the report command with the subject as one argument and the body in a temp file it then removes", async () => {
  const log = path.join(tmpDir(), "notify.log");
  process.env.FAKE_NOTIFY_LOG = log;
  process.env.FAKE_NOTIFY_EXIT = "0";
  const { dir, project } = notifyProject();
  await integrationsFor(project).notify("DEMO-1 waiting: approve merge", "# Body\n\nline two\n");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; body: string; file: string });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args.slice(0, 2), ["--subject", "DEMO-1 waiting: approve merge"]);
  assert.equal(calls[0]!.body, "# Body\n\nline two\n");
  assert.ok(calls[0]!.file.startsWith(path.join(dir, ".mergewright", "local", "tmp")));
  assert.equal(fs.existsSync(calls[0]!.file), false, "temp file removed");
  assert.deepEqual(queueFiles(dir), []);
});

test("a failing notify is queued, listed by 'mw queue', and delivered by 'mw queue flush'", async () => {
  const log = path.join(tmpDir(), "notify.log");
  process.env.FAKE_NOTIFY_LOG = log;
  process.env.FAKE_NOTIFY_EXIT = "3";
  const { dir, project } = notifyProject();
  await integrationsFor(project).notify("DEMO-2 blocked", "why");
  const items = queueItems(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "notify");
  assert.deepEqual(items[0]!.payload, { subject: "DEMO-2 blocked", body: "why" });
  assert.match(items[0]!.lastError ?? "", /exited 3/);
  assert.deepEqual(fs.readdirSync(path.join(dir, ".mergewright", "local", "tmp")), [], "temp file removed even on failure");

  const listed = mw(dir, ["queue"], { FAKE_NOTIFY_LOG: log, FAKE_NOTIFY_EXIT: "3" });
  assert.equal(listed.code, 0);
  assert.match(listed.out, /^notify\s+\d+s\s+notify: DEMO-2 blocked/m);
  const stillDown = mw(dir, ["queue", "flush"], { FAKE_NOTIFY_LOG: log, FAKE_NOTIFY_EXIT: "3" });
  assert.equal(stillDown.code, 1);
  assert.match(stillDown.out, /0 delivered, 1 still queued/);
  assert.equal(queueItems(dir)[0]!.attempts, 1);
  const flushed = mw(dir, ["queue", "flush"], { FAKE_NOTIFY_LOG: log, FAKE_NOTIFY_EXIT: "0" });
  assert.equal(flushed.code, 0, flushed.err);
  assert.match(flushed.out, /1 delivered, 0 still queued/);
  assert.deepEqual(queueFiles(dir), []);
  assert.match(fs.readFileSync(log, "utf8"), /DEMO-2 blocked/);
  assert.match(mw(dir, ["queue"]).out, /the queue is empty/);
});

test("'mw integrations' (and 'mw doctor') reports each integration without printing secrets", async () => {
  const dead = await deadUrl();
  const { dir } = projectWith({
    packages: { mem0: { url: dead, user: "team-ns", key_env: "MW_TEST_SECRET_KEY" }, "open-notebook": { url: dead, name: "Docs NB" }, "cline-kanban": {} },
    report: { command: "definitely-not-a-command-xyz --subject {subject}" },
    git: { forge: { kind: "gitea", url: dead, repo: "me/demo", token_env: "MW_TEST_SECRET_TOKEN" } },
  });
  const secret = "sk-super-secret-value-123";
  // An empty PATH: no report command and no kanban CLI (this machine may have a real one).
  const env = { MW_TEST_SECRET_KEY: secret, MW_TEST_SECRET_TOKEN: secret, PATH: tmpDir("mw-empty-path-") };
  for (const cmd of ["integrations", "doctor"]) {
    const r = mw(dir, [cmd], env);
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.includes(secret) && !r.err.includes(secret), "secret printed");
    assert.match(r.out, /^notify\s+configured\s+command 'definitely-not-a-command-xyz' NOT found/m);
    assert.match(r.out, /^mem0\s+NOT ok\s+NOT reachable .*namespace 'team-ns', MW_TEST_SECRET_KEY set \(package mem0\)$/m);
    assert.match(r.out, /^docs\s+NOT ok\s+NOT reachable .*notebook 'Docs NB', OPEN_NOTEBOOK_PASSWORD NOT set \(package open-notebook\)$/m);
    assert.match(r.out, /^usage\s+not configured/m);
    assert.match(r.out, /^kanban\s+NOT ok\s+the kanban CLI is not on PATH \(the mirror is a no-op\)/m);
    assert.match(r.out, /^forge\s+configured, NOT reachable .*gitea me\/demo, MW_TEST_SECRET_TOKEN set; experimental: not verified against a live forge$/m);
    assert.match(r.out, /^sync\s+not inside a synced folder$/m);
    assert.match(r.out, /^queue\s+empty/m);
  }
});

test("HTTP responses over 20 MB are refused, announced or not; smaller ones are read", async () => {
  const big = MAX_RESPONSE_BYTES + 1024;
  const server = http.createServer((req, res) => {
    if (req.url === "/announced") {
      res.writeHead(200, { "content-type": "application/json", "content-length": String(big) });
      res.end(Buffer.alloc(big, 0x20));
      return;
    }
    if (req.url === "/streamed") {
      res.writeHead(200, { "content-type": "application/json" }); // chunked: no length announced
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      let sent = 0;
      const more = () => {
        while (sent < big) {
          sent += chunk.length;
          if (!res.write(chunk)) { res.once("drain", more); return; }
        }
        res.end();
      };
      more();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "x".repeat(1024 * 1024) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const p of ["/announced", "/streamed"]) {
      await assert.rejects(httpJson(url + p, { timeoutMs: 30_000 }), (e: unknown) => {
        assert.ok(e instanceof HttpError, p);
        assert.equal(e.status, 0);
        assert.match(e.message, /^GET http:\/\/127\.0\.0\.1:\d+\/\w+: the response is larger than 20 MB, so it was refused$/);
        return true;
      });
    }
    assert.equal(((await httpJson(url + "/small")) as { text: string }).text.length, 1024 * 1024);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("'mw doctor' checks the file-sync exclusions of a synced project with a hub", () => {
  const folder = tmpDir("mw-synced-");
  fs.writeFileSync(path.join(folder, ".stfolder"), "");
  const { dir } = projectWith({ git: { hub: "hub", base: "main", forge: { kind: "none" } } });
  const inside = path.join(folder, "Server", "demo");
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.cpSync(dir, inside, { recursive: true });
  const env = { PATH: tmpDir("mw-empty-path-") + path.delimiter + (process.env.PATH ?? "") };

  fs.writeFileSync(path.join(folder, ".stignore"), "// git is per machine\n(?d)node_modules\n.git\n.mergewright/local\n.mergewright/lease-seen.json\n");
  let r = mw(inside, ["doctor"], env);
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, new RegExp(`^sync\\s+PROBLEM\\s+${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.stignore is missing the line '\\.mergewright/worktrees'\\. Add it to that file on both machines`, "m"));

  fs.writeFileSync(path.join(folder, ".stignore"), "#include more-ignores\n");
  // The old '.mergewright/lease-seen.json' line is no longer required; '.mergewright/local' is.
  fs.writeFileSync(path.join(folder, "more-ignores"), "(?d).git\n/Server/demo/.mergewright/worktrees\n.mergewright/lease-seen.json\n");
  r = mw(inside, ["doctor"], env);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /is missing the line '\.mergewright\/local'\. Add it/);
  fs.writeFileSync(path.join(folder, "more-ignores"), "(?d).git\n/Server/demo/.mergewright/worktrees\n(?d).mergewright/local\n");
  r = mw(inside, ["doctor"], env);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^sync\s+exclusions in place\s+.*excludes \.git, \.mergewright\/worktrees, \.mergewright\/local$/m);

  fs.writeFileSync(path.join(folder, ".stignore"), "");
  r = mw(inside, ["doctor"], env);
  assert.match(r.out, /missing the line '\.git' and the line '\.mergewright\/worktrees' and the line '\.mergewright\/local'\. Add them/);

  const single = path.join(folder, "single");
  fs.cpSync(projectWith().dir, single, { recursive: true });
  r = mw(single, ["doctor"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^sync\s+inside a synced folder\s+.*no hub configured/m);
});
