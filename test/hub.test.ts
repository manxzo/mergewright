// The hub layer: a bare repository stands in for the hub, two clones for the two machines.
// File sync is simulated by copying working files between the clones (never `.git`).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hubFor, hubTestHooks, LEASE_REF, LEASE_SEEN_FILE, openHub } from "../src/hub.ts";
import { Project } from "../src/project.ts";
import { git, MW, mw, newProject, read, tmpDir, write } from "./helpers.ts";


interface Pair { hubDir: string; a: string; b: string }

/** A project on clone `a` pushed to a bare hub, and clone `b` of the hub (the second machine). */
function pair(): Pair {
  const tmp = tmpDir("mw-hub-");
  const hubDir = path.join(tmp, "hub.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", hubDir);
  const a = newProject();
  write(a, "mergewright.yaml", read(a, "mergewright.yaml").replace(/hub: none\b/, "hub: hub"));
  git(a, "commit", "-qam", "use the hub");
  git(a, "remote", "add", "hub", hubDir);
  git(a, "push", "-q", "hub", "main");
  const b = path.join(tmp, "b");
  git(tmp, "clone", "-q", "-o", "hub", hubDir, b);
  identity(b);
  return { hubDir, a, b };
}

function identity(dir: string): void {
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
}

/** What the file-sync tool does: make `to`'s working files equal to `from`'s, leaving `.git` and `.mergewright/local` alone. */
function mirror(from: string, to: string): void {
  const walk = (root: string): Map<string, string> => {
    const out = new Map<string, string>();
    const visit = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === ".git") continue;
        const full = path.join(dir, e.name);
        if (path.relative(root, full) === path.join(".mergewright", "local")) continue; // per machine
        if (e.isDirectory()) visit(full);
        else out.set(path.relative(root, full), full);
      }
    };
    visit(root);
    return out;
  };
  const src = walk(from);
  for (const [rel, full] of src) {
    const dst = path.join(to, rel);
    const content = fs.readFileSync(full);
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(content)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content);
    fs.chmodSync(dst, fs.statSync(full).mode);
  }
  for (const [rel, full] of walk(to)) if (!src.has(rel)) fs.rmSync(full);
}

const hub = (dir: string) => openHub(new Project(dir));
const head = (dir: string, ref = "HEAD") => git(dir, "rev-parse", ref);
const hubHead = (p: Pair, ref = "main") => git(p.hubDir, "rev-parse", ref);
const status = (dir: string) => git(dir, "status", "--porcelain");
const commit = (dir: string, msg: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", msg);
};

/** Run `fn` as machine `host`, optionally at time `now` (ISO). */
async function as<T>(host: string, fn: () => Promise<T>, now?: string): Promise<T> {
  const prev = { host: process.env.MW_HOST, now: process.env.MW_NOW };
  process.env.MW_HOST = host;
  if (now) process.env.MW_NOW = now;
  else delete process.env.MW_NOW;
  try {
    return await fn();
  } finally {
    if (prev.host === undefined) delete process.env.MW_HOST; else process.env.MW_HOST = prev.host;
    if (prev.now === undefined) delete process.env.MW_NOW; else process.env.MW_NOW = prev.now;
  }
}

const T0 = "2026-10-05T10:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

// ── Sync table ──

test("sync: equal histories do nothing", async () => {
  const p = pair();
  const r = await hub(p.b).sync();
  assert.equal(r.action, "none");
  assert.match(r.detail, /level with the hub/);
  assert.equal(head(p.b), hubHead(p));
});

test("sync: a machine behind adopts the hub's history once file sync delivered the files, and ends clean", async () => {
  const p = pair();
  write(p.a, "README.md", "changed on a\n");
  commit(p.a, "edit on a");
  git(p.a, "commit", "-q", "--allow-empty", "-m", "second");
  assert.equal((await hub(p.a).sync()).action, "pushed");
  mirror(p.a, p.b);
  assert.notEqual(status(p.b), "", "before adopt, b sees the synced files as local edits");
  const r = await hub(p.b).sync();
  assert.equal(r.action, "adopted");
  assert.match(r.detail, /adopted 2 commit\(s\)/);
  assert.equal(head(p.b), head(p.a));
  assert.equal(status(p.b), "");
});

test("sync: a genuine local edit survives adopt as a modification", async () => {
  const p = pair();
  write(p.a, "README.md", "changed on a\n");
  commit(p.a, "edit on a");
  await hub(p.a).sync();
  mirror(p.a, p.b);
  write(p.b, "AGENTS.md", read(p.b, "AGENTS.md") + "\nlocal note on b\n");
  const r = await hub(p.b).sync();
  assert.equal(r.action, "adopted");
  assert.equal(status(p.b), "M AGENTS.md");
  assert.match(read(p.b, "AGENTS.md"), /local note on b/);
  assert.equal(read(p.b, "README.md"), "changed on a\n");
});

test("sync: an untracked file the hub commit adds, already present with identical content, ends clean", async () => {
  const p = pair();
  write(p.a, "src/new.txt", "brand new\n");
  git(p.a, "add", "src/new.txt");
  git(p.a, "commit", "-qm", "add a file");
  await hub(p.a).pushBase();
  mirror(p.a, p.b);
  assert.equal(status(p.b), "?? src/");
  assert.equal((await hub(p.b).sync()).action, "adopted");
  assert.equal(status(p.b), "");
  assert.equal(git(p.b, "ls-files", "src/new.txt"), "src/new.txt");
});

test("sync: a machine ahead pushes; an empty hub receives the base branch", async () => {
  const p = pair();
  write(p.b, "README.md", "from b\n");
  commit(p.b, "edit on b");
  const r = await hub(p.b).sync();
  assert.equal(r.action, "pushed");
  assert.match(r.detail, /pushed 1 commit\(s\)/);
  assert.equal(hubHead(p), head(p.b));

  const empty = path.join(tmpDir("mw-hub-"), "empty.git");
  git(p.b, "init", "-q", "--bare", "-b", "main", empty);
  git(p.b, "remote", "set-url", "hub", empty);
  const r2 = await hub(p.b).sync();
  assert.equal(r2.action, "pushed");
  assert.match(r2.detail, /had no 'main'/);
  assert.equal(git(empty, "rev-parse", "main"), head(p.b));
});

test("sync: diverged histories stop with an error naming both commits and change nothing", async () => {
  const p = pair();
  write(p.a, "README.md", "a\n");
  commit(p.a, "work on a");
  await hub(p.a).sync();
  write(p.b, "AGENTS.md", "b\n");
  commit(p.b, "work on b");
  const before = head(p.b);
  await assert.rejects(hub(p.b).sync(), (e: Error) => {
    assert.match(e.message, /diverged/);
    assert.ok(e.message.includes(before.slice(0, 7)) && e.message.includes(head(p.a).slice(0, 7)), e.message);
    assert.match(e.message, /work on a/);
    return true;
  });
  assert.equal(head(p.b), before);
  assert.equal(hubHead(p), head(p.a));
});

test("sync: an unreachable hub is an error unless offline; a checkout off the base branch is refused", async () => {
  const p = pair();
  git(p.b, "remote", "set-url", "hub", path.join(tmpDir("mw-hub-"), "gone.git"));
  await assert.rejects(hub(p.b).sync(), (e: Error) => {
    assert.match(e.message, /cannot reach the hub 'hub'.*then try again\.$/s);
    assert.doesNotMatch(e.message, /--offline/, "offline work is not offered on a project with a hub");
    return true;
  });
  await assert.rejects(hub(p.b).prepare(), /cannot reach the hub/);
  const off = await hub(p.b).sync({ offline: true });
  assert.equal(off.action, "none");
  assert.match(off.detail, /offline/);
  await assert.rejects(hub(p.b).prepare({ offline: true }), /shares its state through the hub 'hub'/);

  git(p.a, "checkout", "-q", "-b", "other");
  await assert.rejects(hub(p.a).sync(), /on branch 'other'.*Check out 'main'/s);
  git(p.a, "remote", "remove", "hub");
  git(p.a, "checkout", "-q", "main");
  await assert.rejects(hub(p.a).sync(), /no remote of that name/);
});


test("sync: staged changes make adopt refuse, and nothing moves", async () => {
  const p = pair();
  write(p.a, "README.md", "from a\n");
  commit(p.a, "edit on a");
  await hub(p.a).sync();
  write(p.b, "AGENTS.md", "staged on b\n");
  git(p.b, "add", "AGENTS.md");
  const before = head(p.b);
  await assert.rejects(hub(p.b).sync(), (e: Error & { code?: string }) => {
    assert.equal(e.code, "hub/staged");
    assert.match(e.message, /staged changes.*Commit or unstage first/s);
    return true;
  });
  assert.equal(head(p.b), before, "the branch did not move");
  assert.equal(git(p.b, "diff", "--cached", "--name-only"), "AGENTS.md", "the staged change is still staged");
  assert.equal(read(p.b, "AGENTS.md"), "staged on b\n");
});

test("sync: the branch moves only from the HEAD that was checked (compare-and-swap)", async () => {
  const p = pair();
  write(p.a, "README.md", "from a\n");
  commit(p.a, "edit on a");
  await hub(p.a).sync();
  let local = "";
  hubTestHooks.beforeAdoptUpdate = () => {
    git(p.b, "commit", "-q", "--allow-empty", "-m", "commit between check and update");
    local = head(p.b);
  };
  try {
    await assert.rejects(hub(p.b).sync(), /moved on this machine .*commit between check and update.*nothing was changed/s);
  } finally {
    delete hubTestHooks.beforeAdoptUpdate;
  }
  assert.equal(head(p.b), local);
  // Without interference the same adopt works and leaves the working files as they are.
  const q = pair();
  write(q.a, "README.md", "from a\n");
  commit(q.a, "edit on a");
  await hub(q.a).sync();
  write(q.b, "untracked.txt", "mine\n");
  assert.equal((await hub(q.b).sync()).action, "adopted");
  assert.equal(head(q.b), head(q.a));
  assert.equal(read(q.b, "untracked.txt"), "mine\n");
  assert.equal(fs.existsSync(path.join(q.b, "README.md")), false, "File sync has not delivered it yet, and adopt does not write it");
  assert.equal(status(q.b), "D README.md\n?? untracked.txt", "the index follows the hub, the working files are untouched");
});

// ── Lease ──

test("lease: take, refresh, release", async () => {
  const p = pair();
  const h = hub(p.a);
  assert.equal(await as("alpha", () => h.lease()), undefined);
  await as("alpha", () => h.prepare(), at(0));
  const l1 = await h.lease();
  assert.equal(l1?.host, "alpha");
  assert.equal(l1?.time, at(0));
  assert.equal(l1?.pid, process.pid);
  const sha1 = git(p.hubDir, "rev-parse", LEASE_REF);
  assert.equal(git(p.hubDir, "rev-parse", `${LEASE_REF}^{tree}`), "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "the lease commit has the empty tree");
  await as("alpha", () => h.refresh(), at(3));
  assert.equal((await h.lease())?.time, at(3));
  assert.notEqual(git(p.hubDir, "rev-parse", LEASE_REF), sha1);
  await as("alpha", () => h.prepare(), at(4)); // prepare by the holder refreshes
  await as("alpha", () => h.release());
  assert.equal(await h.lease(), undefined);
  assert.equal(git(p.hubDir, "for-each-ref", "refs/mergewright/"), "");
  await as("alpha", () => h.release()); // nothing held: a no-op
});

test("lease: a fresh lease held by the other machine blocks prepare; release by a non-holder leaves it", async () => {
  const p = pair();
  await as("alpha", () => hub(p.a).prepare(), at(0));
  await assert.rejects(as("beta", () => hub(p.b).prepare(), at(4)), (e: Error) => {
    assert.match(e.message, /alpha \(pid \d+\) holds the lease/);
    assert.match(e.message, /4 min ago/);
    assert.match(e.message, /mw lease take --force/);
    return true;
  });
  await as("beta", () => hub(p.b).release());
  assert.equal((await hub(p.b).lease())?.host, "alpha");
  await assert.rejects(as("beta", () => hub(p.b).refresh(), at(4)), /beta\) no longer holds the lease.*alpha took it/s);
});

test("lease: a stale lease is taken over, and the old holder's refresh then throws", async () => {
  const p = pair();
  await as("alpha", () => hub(p.a).prepare(), at(0));
  await as("beta", () => hub(p.b).observe(), at(1)); // beta first sees alpha's lease
  const r = await as("beta", () => hub(p.b).prepare(), at(11)); // unchanged for 10 min by beta's clock
  assert.equal(r.action, "none");
  assert.equal((await hub(p.b).lease())?.host, "beta");
  await assert.rejects(as("alpha", () => hub(p.a).refresh(), at(12)), /no longer holds the lease.*beta took it 1 min ago/s);
  await assert.rejects(as("alpha", () => hub(p.a).prepare(), at(12)), /beta \(pid \d+\) holds the lease/);
  // A forced takeover of a fresh lease, then the other side has lost it.
  await as("alpha", () => hub(p.a).take({ force: true }), at(13));
  await assert.rejects(as("beta", () => hub(p.b).refresh(), at(14)), /no longer holds the lease/);
});

test("lease: two takers from the same observed state, exactly one wins", async () => {
  for (const start of ["empty", "stale"] as const) {
    const p = pair();
    if (start === "stale") await as("gamma", () => hub(p.a).prepare(), at(0));
    const ha = hub(p.a);
    const hb = hub(p.b);
    const seenA = await as("alpha", () => ha.observe(), at(5));
    const seenB = await as("beta", () => hb.observe(), at(5));
    assert.equal(seenA.sha, seenB.sha);
    await as("alpha", () => ha.take({ observed: seenA }), at(20));
    await assert.rejects(as("beta", () => hb.take({ observed: seenB }), at(20)), /changed while this machine \(beta\) was taking it/, start);
    assert.equal((await ha.lease())?.host, "alpha");
  }
});

test("lease: two `mw lease take` processes racing, exactly one wins", async () => {
  const p = pair();
  const runTake = (cwd: string, host: string) =>
    new Promise<number>((resolve) => {
      const c = spawn(process.execPath, [MW, "lease", "take"], { cwd, env: { ...process.env, MW_HOST: host }, stdio: "ignore" });
      c.on("exit", (code) => resolve(code ?? 1));
    });
  const codes = await Promise.all([runTake(p.a, "alpha"), runTake(p.b, "beta")]);
  assert.deepEqual([...codes].sort(), [0, 1]);
  assert.equal((await hub(p.a).lease())?.host, codes[0] === 0 ? "alpha" : "beta");
});

test("lease: refresh is repeatable; once another host takes over, refresh throws and pushes are refused", async () => {
  const p = pair();
  const h = hub(p.a);
  await as("alpha", () => h.prepare(), at(0));
  for (let i = 1; i <= 5; i++) await as("alpha", () => h.refresh(), at(i));
  assert.equal((await h.lease())?.time, at(5));
  git(p.a, "branch", "card/Z");
  await as("alpha", () => h.pushBranch("card/Z"));
  await as("beta", () => hub(p.b).take({ force: true }), at(6));
  const lost = /this machine \(alpha\) no longer holds the lease on hub 'hub': beta took it/;
  await assert.rejects(as("alpha", () => h.refresh(), at(7)), lost);
  write(p.a, "late.txt", "late\n");
  commit(p.a, "after losing the lease");
  const hubMain = hubHead(p);
  await assert.rejects(as("alpha", () => h.pushBase(), at(7)), lost);
  await assert.rejects(as("alpha", () => h.pushBranch("card/Z"), at(7)), lost);
  await assert.rejects(as("alpha", () => h.deleteBranch("card/Z"), at(7)), lost);
  assert.equal(hubHead(p), hubMain, "nothing was pushed");
  assert.equal(git(p.hubDir, "branch", "--list", "card/Z").trim(), "card/Z");
});

test("lease: a new process on the same host continues the lease", async () => {
  const p = pair();
  const env = { MW_HOST: "alpha", MW_NOW: at(0) };
  assert.equal(mw(p.a, ["lease", "take"], env).code, 0);
  const h = hub(p.a);
  await as("alpha", () => h.refresh(), at(1)); // another pid wrote it: still ours
  await as("alpha", () => h.prepare(), at(2));
  const r = mw(p.a, ["lease", "take"], { ...env, MW_NOW: at(3) });
  assert.match(r.out, /lease refreshed by alpha/);
  git(p.a, "branch", "card/W");
  await as("alpha", () => h.pushBranch("card/W"), at(4)); // the ref moved, but to a lease of this host
  await as("alpha", () => h.refresh(), at(4));
  assert.equal((await h.lease())?.pid, process.pid);
});


// ── Lease: clock skew ──

/** This machine's own record (`.mergewright/local/lease-seen.json`, never file-synced). */
const seenRecord = (dir: string) => JSON.parse(read(dir, `.mergewright/local/${LEASE_SEEN_FILE}`)) as { sha: string; firstSeen: string };

test("lease skew: a holder whose clock is far behind but who keeps refreshing is never taken over", async () => {
  const p = pair();
  const ha = hub(p.a);
  const hb = hub(p.b);
  // alpha's clock is 9 minutes behind beta's: every lease it writes looks 9 minutes old to beta,
  // and older still by the time beta looks again.
  for (let m = 0; m <= 30; m += 3) {
    await as("alpha", async () => { if (m === 0) await ha.prepare(); else await ha.refresh(); }, at(m - 9));
    await assert.rejects(as("beta", () => hb.prepare(), at(m + 2)), (e: Error) => {
      assert.match(e.message, /alpha \(pid \d+\) holds the lease.*11 min ago by its own clock.*take the lease over in 10 min/s);
      return true;
    });
  }
  assert.equal((await hb.lease())?.host, "alpha");
});

test("lease skew: a dead holder's lease, seen unchanged for lease_minutes by this machine's clock, is taken over", async () => {
  const p = pair();
  // alpha's clock is an hour ahead: its lease never looks old to beta by its timestamp.
  await as("alpha", () => hub(p.a).prepare(), at(60));
  const sha = git(p.hubDir, "rev-parse", LEASE_REF);
  // A record an older runtime kept in the shared folder, keyed by host: ignored, and left alone.
  const old = JSON.stringify({ beta: { sha, firstSeen: at(-100) } });
  write(p.b, `.mergewright/${LEASE_SEEN_FILE}`, old);
  await assert.rejects(as("beta", () => hub(p.b).prepare(), at(0)), /alpha \(pid \d+\) holds the lease.*take the lease over in 10 min/s);
  assert.deepEqual(seenRecord(p.b), { sha, firstSeen: at(0) }, "one record, this machine's own");
  assert.equal(read(p.b, `.mergewright/${LEASE_SEEN_FILE}`), old);
  await assert.rejects(as("beta", () => hub(p.b).prepare(), at(9)), /take the lease over in 1 min/);
  assert.equal(seenRecord(p.b).firstSeen, at(0), "the first sight is kept while the lease is unchanged");
  await as("beta", () => hub(p.b).prepare(), at(10));
  assert.equal((await hub(p.b).lease())?.host, "beta");
  await assert.rejects(as("alpha", () => hub(p.a).refresh(), at(61)), /alpha\) no longer holds the lease.*beta took it/s);
});

test("lease skew: a refreshed lease restarts the observation", async () => {
  const p = pair();
  const ha = hub(p.a);
  await as("alpha", () => ha.prepare(), at(0));
  await assert.rejects(as("beta", () => hub(p.b).prepare(), at(1)));
  await as("alpha", () => ha.refresh(), at(8));
  await assert.rejects(as("beta", () => hub(p.b).prepare(), at(11)), /take the lease over in 10 min/, "a new lease commit: seen for 0 min");
  assert.equal(seenRecord(p.b).firstSeen, at(11));
});

test("lease skew: a lease whose own timestamp is three times lease_minutes old is taken over at first sight", async () => {
  const p = pair();
  await as("alpha", () => hub(p.a).prepare(), at(0));
  await assert.rejects(as("beta", () => hub(p.b).prepare(), at(29)), /take the lease over in 1 min/);
  const q = pair();
  await as("alpha", () => hub(q.a).prepare(), at(0));
  assert.equal(fs.existsSync(path.join(q.b, ".mergewright", "local", LEASE_SEEN_FILE)), false);
  await as("beta", () => hub(q.b).prepare(), at(30));
  assert.equal((await hub(q.b).lease())?.host, "beta");
});

// ── Lease: every hub mutation respects it ──

test("fencing: each push by the holder also moves the lease; after a takeover the whole atomic push is refused", async () => {
  const p = pair();
  const h = hub(p.a);
  await as("alpha", () => h.prepare(), at(0));
  const lease0 = git(p.hubDir, "rev-parse", LEASE_REF);
  git(p.a, "branch", "card/F");
  await as("alpha", () => h.pushBranch("card/F"), at(2));
  const lease1 = git(p.hubDir, "rev-parse", LEASE_REF);
  assert.notEqual(lease1, lease0, "the push was also a heartbeat");
  assert.equal((await h.lease())?.time, at(2));
  assert.equal(git(p.hubDir, "rev-parse", "card/F"), head(p.a, "card/F"));

  await as("beta", () => hub(p.b).take({ force: true }), at(3));
  const leaseB = git(p.hubDir, "rev-parse", LEASE_REF);
  const hubCard = git(p.hubDir, "rev-parse", "card/F");
  const hubMain = hubHead(p);
  write(p.a, "late.txt", "late\n");
  commit(p.a, "after losing the lease");
  git(p.a, "branch", "-f", "card/F", "main");
  const lost = (e: Error & { code?: string }) => {
    assert.equal(e.code, "hub/lease-lost");
    assert.match(e.message, /this machine \(alpha\) no longer holds the lease on hub 'hub': beta took it/);
    return true;
  };
  await assert.rejects(as("alpha", () => h.pushBranch("card/F"), at(4)), lost);
  await assert.rejects(as("alpha", () => h.pushBase(), at(4)), lost);
  await assert.rejects(as("alpha", () => h.sync(), at(4)), lost);
  await assert.rejects(as("alpha", () => h.deleteBranch("card/F"), at(4)), lost);
  assert.equal(git(p.hubDir, "rev-parse", "card/F"), hubCard, "the branch on the hub did not move");
  assert.equal(hubHead(p), hubMain);
  assert.equal(git(p.hubDir, "rev-parse", LEASE_REF), leaseB, "beta's lease is untouched");
});

test("fencing: a branch the hub refuses does not move the lease either", async () => {
  const p = pair();
  const ha = hub(p.a);
  git(p.b, "commit", "-q", "--allow-empty", "-m", "b only");
  git(p.b, "push", "-q", "hub", "main:card/G");
  await as("alpha", () => ha.prepare(), at(0));
  const lease0 = git(p.hubDir, "rev-parse", LEASE_REF);
  git(p.a, "commit", "-q", "--allow-empty", "-m", "a only");
  git(p.a, "branch", "card/G");
  await assert.rejects(as("alpha", () => ha.pushBranch("card/G"), at(1)), /hub refused 'card\/G' because it has commits this machine does not have/);
  assert.equal(git(p.hubDir, "rev-parse", LEASE_REF), lease0);
  await as("alpha", () => ha.refresh(), at(2)); // still the holder
});

test("lease: a process that does not hold the lease changes nothing on the hub while another host holds it", async () => {
  const p = pair();
  git(p.a, "branch", "card/U");
  await hub(p.a).pushBranch("card/U"); // nobody holds the lease: an ordinary push
  await as("alpha", () => hub(p.a).prepare(), at(0));
  write(p.b, "b.txt", "b\n");
  commit(p.b, "b is ahead");
  git(p.b, "branch", "card/V");
  const lease = git(p.hubDir, "rev-parse", LEASE_REF);
  const hubMain = hubHead(p);
  const hb = hub(p.b);
  const held = /another machine is driving this project: alpha \(pid \d+\) holds the lease.*changed nothing on the hub.*mw lease take --force/s;
  await assert.rejects(as("beta", () => hb.sync(), at(4)), held);
  await assert.rejects(as("beta", () => hb.pushBase(), at(4)), held);
  await assert.rejects(as("beta", () => hb.pushBranch("card/V"), at(4)), held);
  await assert.rejects(as("beta", () => hb.deleteBranch("card/U"), at(4)), held);
  assert.equal(hubHead(p), hubMain);
  assert.equal(git(p.hubDir, "branch", "--list", "card/*"), "card/U");
  assert.equal(git(p.hubDir, "rev-parse", LEASE_REF), lease);
  // The same host (another process there): allowed.
  await as("alpha", () => hub(p.b).pushBranch("card/V"), at(4));
  assert.equal(git(p.hubDir, "rev-parse", "card/V"), head(p.b, "card/V"));
  // A stale lease (three times lease_minutes by its own timestamp) no longer blocks.
  assert.equal((await as("beta", () => hb.sync(), at(31))).action, "pushed");
  assert.equal(hubHead(p), head(p.b));
});

// ── Branches ──

test("branches: push, fetch, continue on the other machine, delete", async () => {
  const p = pair();
  const ha = hub(p.a);
  const hb = hub(p.b);
  git(p.a, "branch", "card/X");
  const wtA = path.join(tmpDir("mw-wt-"), "x");
  git(p.a, "worktree", "add", "-q", wtA, "card/X");
  write(wtA, "src/x.txt", "one\n");
  git(wtA, "add", "-A");
  git(wtA, "commit", "-qm", "X: one");
  await ha.pushBranch("card/X");
  assert.equal(git(p.hubDir, "rev-parse", "card/X"), head(wtA));

  assert.equal(await hb.fetchBranch("card/missing"), false);
  assert.equal(await hb.fetchBranch("card/X"), true);
  assert.equal(head(p.b, "card/X"), head(wtA));
  assert.equal(git(p.b, "symbolic-ref", "--short", "HEAD"), "main", "fetchBranch does not check the branch out");

  // b continues the card and pushes; a (with the branch checked out in a worktree) catches up.
  const wtB = path.join(tmpDir("mw-wt-"), "x");
  git(p.b, "worktree", "add", "-q", wtB, "card/X");
  write(wtB, "src/x.txt", "two\n");
  commit(wtB, "X: two");
  await hb.pushBranch("card/X");
  assert.equal(await ha.fetchBranch("card/X"), true);
  assert.equal(head(wtA), head(wtB));
  assert.equal(read(wtA, "src/x.txt"), "two\n");

  // A branch that is not checked out anywhere moves too.
  git(p.a, "worktree", "remove", wtA);
  write(wtB, "src/x.txt", "three\n");
  commit(wtB, "X: three");
  await hb.pushBranch("card/X");
  assert.equal(await ha.fetchBranch("card/X"), true);
  assert.equal(head(p.a, "card/X"), head(wtB));

  await ha.deleteBranch("card/X");
  assert.equal(git(p.hubDir, "branch", "--list", "card/X"), "");
  await ha.deleteBranch("card/X"); // already gone: fine
  assert.equal(await hb.fetchBranch("card/X"), false);
});

test("branches: local commits the hub lacks are never clobbered", async () => {
  const p = pair();
  const ha = hub(p.a);
  const hb = hub(p.b);
  const commitOn = (dir: string, branch: string, msg: string) => {
    const wt = path.join(tmpDir("mw-wt-"), "w");
    git(dir, "worktree", "add", "-q", wt, branch);
    write(wt, `${msg}.txt`, msg);
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", msg);
    git(dir, "worktree", "remove", wt);
    return head(dir, branch);
  };
  git(p.a, "branch", "card/Y");
  commitOn(p.a, "card/Y", "a1");
  await ha.pushBranch("card/Y");
  await hb.fetchBranch("card/Y");

  // b strictly ahead: fetch keeps b's commit.
  const bAhead = commitOn(p.b, "card/Y", "b1");
  assert.equal(await hb.fetchBranch("card/Y"), true);
  assert.equal(head(p.b, "card/Y"), bAhead);

  // Both sides moved: refused, b's branch untouched, and b's push is refused too.
  commitOn(p.a, "card/Y", "a2");
  await ha.pushBranch("card/Y");
  await assert.rejects(hb.fetchBranch("card/Y"), /each have commits the other lacks.*left as it is/s);
  assert.equal(head(p.b, "card/Y"), bAhead);
  await assert.rejects(hb.pushBranch("card/Y"), /hub refused 'card\/Y'/);
});

test("hub none: disabled, every method a successful no-op", async () => {
  const dir = newProject();
  const h = hubFor(new Project(dir));
  assert.equal(h.enabled, false);
  assert.equal((await h.prepare()).action, "no-hub");
  assert.equal((await h.sync()).action, "no-hub");
  await h.refresh();
  await h.release();
  assert.equal(await h.lease(), undefined);
  assert.equal(await h.fetchBranch("card/X"), false);
  await h.pushBranch("card/X");
  await h.pushBase();
  await h.deleteBranch("card/X");
  assert.match(mw(dir, ["sync"]).out, /no hub configured/);
  assert.match(mw(dir, ["lease"]).out, /no hub is configured/);
});

// ── Commands ──

const engineRun = (await import("../src/engine/run.ts").catch(() => ({}))) as { pruneFinished?: unknown };

test("mw sync removes this machine's worktrees of cards the hub says are done (decision C)", { skip: typeof engineRun.pruneFinished !== "function" && "src/engine/run.ts does not export pruneFinished yet" }, () => {
  const p = pair();
  const env = { MW_HOST: "beta" };
  // b worked on DEMO-9 in a worktree; a finished it and pushed the base with the card done.
  write(p.a, "cards/DEMO-9.card.md", "---\nid: DEMO-9\ntitle: Nine\nstatus: ready\n---\n\n## Why\n\nBecause.\n");
  commit(p.a, "add DEMO-9");
  git(p.a, "push", "-q", "hub", "main");
  assert.equal(mw(p.b, ["sync"], env).code, 0);
  const wt = path.join(p.b, ".mergewright", "worktrees", "DEMO-9");
  git(p.b, "worktree", "add", "-q", "-b", "card/DEMO-9", wt);
  write(p.a, "cards/DEMO-9.card.md", read(p.a, "cards/DEMO-9.card.md").replace("status: ready", "status: done"));
  commit(p.a, "DEMO-9 done");
  git(p.a, "push", "-q", "hub", "main");
  // (No mirror: file sync does not copy .mergewright/worktrees, and the prune reads the base branch.)
  const r = mw(p.b, ["sync"], env);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /adopted 1 commit\(s\).*\nremoved the worktrees of finished cards on this machine: DEMO-9/s);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(git(p.b, "branch", "--list", "card/DEMO-9"), "");
});

test("mw sync and mw lease through the CLI", () => {
  const p = pair();
  const env = (host: string, now?: string) => ({ MW_HOST: host, ...(now ? { MW_NOW: now } : {}) });
  write(p.a, "README.md", "cli\n");
  commit(p.a, "cli edit");
  let r = mw(p.a, ["sync"], env("alpha"));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /pushed 1 commit/);
  mirror(p.a, p.b);
  r = mw(p.b, ["sync"], env("beta"));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /adopted 1 commit/);
  assert.equal(status(p.b), "");
  r = mw(p.b, ["sync", "--offline"], env("beta"));
  assert.match(r.out, /offline/);

  assert.match(mw(p.a, ["lease"], env("alpha")).out, /no machine holds the lease/);
  r = mw(p.a, ["lease", "take"], env("alpha", at(0)));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /lease taken by alpha/);
  assert.match(mw(p.a, ["lease", "take"], env("alpha", at(1))).out, /lease refreshed by alpha/);
  r = mw(p.b, ["lease", "show"], env("beta", at(3)));
  assert.match(r.out, /lease held by alpha \(pid \d+\), taken or refreshed 2 min ago by its own clock\nthis machine may take it over in 10 min unless it is refreshed/);

  r = mw(p.b, ["lease", "take"], env("beta", at(3)));
  assert.equal(r.code, 1);
  assert.match(r.err, /alpha \(pid \d+\) holds the lease.*mw lease take --force/s);
  r = mw(p.b, ["lease", "release"], env("beta", at(3)));
  assert.equal(r.code, 1);
  assert.match(r.out, /does not hold the lease; alpha/);
  r = mw(p.b, ["lease", "take", "--force"], env("beta", at(3)));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /taken over by beta from alpha/);
  assert.match(mw(p.a, ["lease", "show"], env("alpha", at(20))).out, /held by beta.*\nthis machine may take it over in 10 min/, "first sight by alpha");
  assert.match(mw(p.a, ["lease", "show"], env("alpha", at(26))).out, /may take it over in 4 min/);
  assert.match(mw(p.a, ["lease", "show"], env("alpha", at(30))).out, /held by beta.*\nit has gone stale: this machine may take it over now/);
  assert.match(mw(p.b, ["lease", "show"], env("beta", at(30))).out, /held by beta \(pid \d+, this machine\)/);
  r = mw(p.b, ["lease", "release"], env("beta"));
  assert.match(r.out, /lease released by beta/);
  assert.match(mw(p.a, ["lease", "release"], env("alpha")).out, /nothing to release/);
  assert.equal(mw(p.a, ["lease", "steal"], env("alpha")).code, 2);
});
