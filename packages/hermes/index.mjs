// Hermes for MergeWright (package API v1): the `hermes` harness, and `mw hermes init|status|remove`,
// which register this project's MCP server in Hermes's config and install the `mergewright` skill
// (SKILL.md next to this file). Hermes resolves MCP servers from its config only (`mcp_servers:` in
// $HERMES_HOME/config.yaml), one entry per project, carrying the project path. See README.md.
//
// The harness runs the CLI through host.agent, so the runtime's timeout, abort, output capture,
// redaction and the shared table of transient and quota failures apply as to the built-in harnesses.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_NAME = "mergewright";
/** The skill `mw hermes init` installs: the one this package ships. */
export const SKILL_FILE = fileURLToPath(new URL("SKILL.md", import.meta.url));

// ── The harness ─────────────────────────────────────────────────────────────────────────────

/** The argv (without the executable), the prompt being in `promptFile`. */
export function hermesArgs(req, promptFile) {
  // --ignore-rules: the prompt is self-contained, so no AGENTS.md/SOUL.md/memory/skill injection.
  // -t todo: the smallest toolset that has no terminal, file, web or MCP tools (a toolset name also
  // stops Hermes spawning its MCP servers). Hermes has no read-only file toolset, so read-mode
  // roles get no file access either; a role can widen it with `args: [-t, ...]` (last -t wins).
  const args = ["chat", "-Q", "--oneshot", "--ignore-rules", "-t", "todo", "--query-file", promptFile];
  if (req.role.model) args.push("-m", req.role.model);
  if (req.role.provider) args.push("--provider", req.role.provider);
  if (req.limits.turns !== undefined) args.push("--max-turns", String(req.limits.turns));
  args.push("--source", "tool"); // keep these runs out of the owner's session list
  args.push(...req.role.args);
  return args;
}

/** `-Q` prints the final response followed by session information (`session_id: ...`). Keep only the response. */
export function hermesReply(stdout) {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && (!lines[lines.length - 1].trim() || /^\s*(session[ _]id|session)\s*[:=]/i.test(lines[lines.length - 1]))) lines.pop();
  return lines.join("\n").trim();
}

function harness(host) {
  return {
    async run(req) {
      if (req.mode === "write") {
        return { ok: false, text: "", seconds: 0, error: "the hermes harness is advisory only; it cannot run a write-mode role" };
      }
      const a = host.agent;
      const args = hermesArgs(req, a.saveText(req, "hermes.prompt.md", req.prompt));
      const home = host.env("HERMES_HOME");
      const r = await a.run({ name: "hermes", cmd: "hermes", args, req, env: home ? { HERMES_HOME: home } : {} });
      const failed = a.failedRun("hermes", r);
      if (failed) return failed;
      const text = hermesReply(r.stdout);
      if (r.timedOut) return a.timeoutResult("hermes", r, req.limits.minutes, text);
      if (r.code !== 0) return a.exitFailure("hermes", r, { text }); // REQ-harness-001: classified by the shared table
      if (!text) return { ok: false, text: "", seconds: r.seconds, error: "hermes returned an empty reply" };
      return { ok: true, text, seconds: r.seconds };
    },
  };
}

// ── Hermes's config and the skill ───────────────────────────────────────────────────────────

/**
 * Lock timing for config edits; tests shorten them. A lock is stale only when the process it names is
 * gone or it has not been refreshed for `staleMs`; a holder running the `hermes` CLI (up to 180 s)
 * refreshes its lock's mtime every `refreshMs`.
 */
export const configLock = { staleMs: 300_000, waitMs: 10_000, refreshMs: 20_000, guardStaleMs: 300_000 };
/**
 * Test seams: called just before an edit takes the lock, just before the new file is moved into
 * place, and just before a stale lock is taken over (between deciding it is stale and moving it).
 */
export const testHooks = {};

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}

function writeAtomic(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** The holder written in the lock file, or undefined when it cannot be read. */
function lockHolder(text) {
  try {
    const v = JSON.parse(text ?? "");
    return typeof v.pid === "number" ? { pid: v.pid, nonce: typeof v.nonce === "string" ? v.nonce : undefined } : undefined;
  } catch {
    return undefined;
  }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * A small process that touches the lock every `configLock.refreshMs` while this one is blocked in a
 * long synchronous call; it stops when the lock no longer holds `nonce` or this process is gone.
 */
function startLockKeeper(file, nonce) {
  const script = `const fs = process.getBuiltinModule("node:fs");
const [f, nonce, ppid, ms] = process.argv.slice(1);
setInterval(() => {
  try { process.kill(Number(ppid), 0); } catch (e) { if (e.code !== "EPERM") process.exit(0); }
  let t = "";
  try { t = fs.readFileSync(f, "utf8"); } catch { process.exit(0); }
  if (!t.includes(nonce)) process.exit(0);
  const now = new Date();
  try { fs.utimesSync(f, now, now); } catch {}
}, Number(ms));`;
  const child = spawn(process.execPath, ["-e", script, file, nonce, String(process.pid), String(configLock.refreshMs)], { stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
  return child;
}

const lineStart = (text, i) => text.lastIndexOf("\n", i - 1) + 1;

/** The config, the skill and the server entry, for the project `host` serves. */
export function hermesTools(host) {
  const YAML = host.yaml;
  const env = (name) => host.env(name);

  function hermesHome() {
    return env("HERMES_HOME") || path.join(os.homedir(), ".hermes");
  }
  function hermesConfigFile() {
    return path.join(hermesHome(), "config.yaml");
  }
  /**
   * The skills folder `--shared` uses: one that several machines share (kept in step by a file-sync
   * tool, say). `MW_HERMES_SHARED_SKILLS` names it; the default is `$HERMES_HOME/shared-skills`.
   */
  function sharedSkillsDir() {
    return env("MW_HERMES_SHARED_SKILLS") || path.join(hermesHome(), "shared-skills");
  }
  /** Where the skill goes: Hermes's own skills, or the shared skills folder (`sharedSkillsDir`). */
  function skillFile(shared) {
    const dir = shared ? sharedSkillsDir() : path.join(hermesHome(), "skills");
    return path.join(dir, SKILL_NAME, "SKILL.md");
  }

  function entryName(name) {
    const n = name ?? `mergewright-${slugify(host.project.name)}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n)) throw new Error(`'${n}' is not a usable Hermes server name (letters, digits, - and _)`);
    return n;
  }

  /**
   * `mw mcp serve --project <root>`, started through the `mw` on PATH, else through this runtime.
   * `env: {SSH_AUTH_SOCK}` when an SSH agent was found at init time. Hermes starts the
   * server without the login session's environment, and the hub tools need the agent to reach the hub.
   */
  function serverEntry() {
    const tail = ["mcp", "serve", "--project", host.project.root];
    const sock = host.sshAgent();
    const e = sock ? { env: { SSH_AUTH_SOCK: sock } } : {};
    const mw = host.which("mw");
    if (mw) return { command: mw, args: tail, ...e };
    return { command: host.selfCommand.command, args: [...host.selfCommand.args, ...tail], ...e };
  }

  /** The entry's body as written to the config (`enabled: true`; `env` only when there is one). */
  const entryBody = (want) => ({ command: want.command, args: want.args, ...(want.env ? { env: want.env } : {}), enabled: true });

  /** True when the entry's `env` holds every variable `want` sets, with the same values (other keys may be there). */
  const sameEnv = (e, want) => {
    if (!want.env) return true;
    const have = e.env && typeof e.env === "object" ? e.env : {};
    return Object.entries(want.env).every(([k, v]) => have[k] === v);
  };

  /** The entry `name` under `mcp_servers` in Hermes's config, or undefined. */
  function readEntry(name) {
    const text = readIfExists(hermesConfigFile());
    if (text === undefined) return undefined;
    const doc = YAML.parse(text);
    return doc?.mcp_servers?.[name] ?? undefined;
  }

  /** Names of every MergeWright entry in Hermes's config. */
  function mergewrightEntries() {
    const text = readIfExists(hermesConfigFile());
    const doc = text ? YAML.parse(text) : null;
    return Object.entries(doc?.mcp_servers ?? {})
      .filter(([n, e]) => n.startsWith("mergewright") || (Array.isArray(e?.args) && e.args.includes("serve") && e.args.includes("mcp")))
      .map(([n]) => n);
  }

  const sameEntry = (e, want) =>
    !!e && e.command === want.command && JSON.stringify(e.args) === JSON.stringify(want.args) && sameEnv(e, want) && e.enabled !== false;

  function configLockFile() {
    return `${hermesConfigFile()}.mw-lock`;
  }

  /**
   * The file the config path leads to, every symbolic link resolved, so a backup copies the real file
   * and the atomic rename replaces it rather than the link. A missing file is its own path (or, for a
   * dangling link, where the link points).
   */
  function configTarget() {
    const file = hermesConfigFile();
    try {
      return fs.realpathSync(file);
    } catch {
      try {
        if (fs.lstatSync(file).isSymbolicLink()) return path.resolve(path.dirname(file), fs.readlinkSync(file));
      } catch {
        // no file at all
      }
      return file;
    }
  }

  /** `config.yaml.mw-lock.takeover`: held by the one process that may judge and move a stale config lock. */
  function takeoverGuardFile() {
    return `${configLockFile()}.takeover`;
  }

  /**
   * Take the takeover guard (`wx`), or undefined when another live process holds it. A guard whose
   * process is gone (pid and start time), or older than `configLock.guardStaleMs` by mtime, is removed,
   * and only when it still has the content judged; the caller then tries again.
   */
  function takeGuard() {
    const guard = takeoverGuardFile();
    const self = host.process.identity(process.pid);
    const mine = JSON.stringify({ pid: process.pid, ...(self.started ? { started: self.started } : {}), time: Date.now() }) + "\n";
    try {
      fs.writeFileSync(guard, mine, { flag: "wx", mode: 0o600 });
      return mine;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    try {
      const text = fs.readFileSync(guard, "utf8");
      const age = Date.now() - fs.statSync(guard).mtimeMs;
      let rec;
      try { rec = JSON.parse(text); } catch { rec = undefined; }
      const dead = typeof rec?.pid === "number" && rec.pid !== process.pid && !host.process.alive({ pid: rec.pid, started: rec.started });
      if ((age > configLock.guardStaleMs || dead) && readIfExists(guard) === text) fs.rmSync(guard, { force: true });
    } catch {
      // released meanwhile
    }
    return undefined;
  }

  /**
   * One attempt to take over the config lock `file`, which looked stale. Under the takeover guard the
   * lock is read and judged again; it is moved aside only if, right before the rename, it is still the
   * same file (inode) with the same content as judged. If what was moved turns out to be another file
   * after all (replaced in the instant before the rename), it is put back; when that fails because a
   * third process holds the lock now, the displaced file is never deleted: it is left where it was moved,
   * with a warning naming it. Returns true when the stale lock was removed (the caller then tries to
   * create its own).
   */
  function takeOver(file) {
    const mine = takeGuard();
    if (mine === undefined) return false;
    const guard = takeoverGuardFile();
    try {
      let text;
      let ino;
      let age;
      try {
        text = fs.readFileSync(file, "utf8");
        const st = fs.statSync(file);
        ino = st.ino;
        age = Date.now() - st.mtimeMs;
      } catch {
        return true; // released meanwhile: try to create ours
      }
      const holder = lockHolder(text);
      if (!(age > configLock.staleMs || (holder && holder.pid !== process.pid && !pidAlive(holder.pid)))) return false;
      testHooks.beforeTakeover?.();
      try {
        if (fs.statSync(file).ino !== ino || fs.readFileSync(file, "utf8") !== text) return false; // replaced since it was judged
      } catch {
        return true; // gone since it was judged
      }
      const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        fs.renameSync(file, aside);
      } catch {
        return false;
      }
      let same = false;
      try {
        same = fs.statSync(aside).ino === ino && fs.readFileSync(aside, "utf8") === text;
      } catch {
        same = false;
      }
      if (same) {
        fs.rmSync(aside, { force: true });
        return true;
      }
      // What was moved is not the lock judged stale: put it back, never delete it.
      try {
        fs.linkSync(aside, file);
        fs.rmSync(aside, { force: true });
      } catch {
        process.stderr.write(`mw: moved ${file} aside while taking over a stale lock, but it was another process's lock and could not be put back (a third process holds the lock now); it is kept as ${aside}. Remove it once no 'mw hermes' command runs.\n`);
      }
      return false;
    } finally {
      if (readIfExists(guard) === mine) fs.rmSync(guard, { force: true });
    }
  }

  /**
   * Run `f` holding Hermes's config lock: `config.yaml.mw-lock`, created exclusively (O_EXCL) with this
   * process's pid, the time and a random nonce. A lock whose process is gone, or older than
   * `configLock.staleMs` (by mtime), is taken over by renaming it to a unique name and then creating a
   * new one exclusively, judged and moved only under the takeover guard and only while it is still the
   * file judged (`takeOver`); a process that loses that race, or finds a live lock, waits up to
   * `configLock.waitMs`. With `keepFresh` the lock's mtime is refreshed while `f` runs. On the way out
   * the lock is removed only when it still holds this nonce (never another process's lock). Every
   * MergeWright process that edits the config takes it.
   */
  function withConfigLock(f, opts = {}) {
    const file = configLockFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const nonce = randomBytes(12).toString("hex");
    const mine = JSON.stringify({ pid: process.pid, time: Date.now(), nonce }) + "\n";
    const deadline = Date.now() + configLock.waitMs;
    for (;;) {
      try {
        fs.writeFileSync(file, mine, { flag: "wx", mode: 0o600 });
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      let text;
      let age;
      try {
        text = fs.readFileSync(file, "utf8");
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue; // released meanwhile: try again
      }
      const holder = lockHolder(text);
      if (age > configLock.staleMs || (holder && holder.pid !== process.pid && !pidAlive(holder.pid))) {
        // Judged again, and moved, only under the takeover guard.
        if (!takeOver(file)) pause(50);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`${hermesConfigFile()} is being changed by another MergeWright process (pid ${holder?.pid ?? "?"}, lock ${file}); try again in a moment, or remove the lock file if no such process runs`);
      }
      pause(50);
    }
    const keeper = opts.keepFresh ? startLockKeeper(file, nonce) : undefined;
    try {
      return f();
    } finally {
      keeper?.kill();
      if (lockHolder(readIfExists(file))?.nonce === nonce) fs.rmSync(file, { force: true });
    }
  }

  /** What the config file is now: its text (undefined when missing) and a fingerprint of size, mtime and content. */
  function snapshot(file) {
    const text = readIfExists(file);
    if (text === undefined) return { text, stamp: "absent" };
    const st = fs.statSync(file);
    return { text, stamp: `${st.size}:${st.mtimeMs}:${createHash("sha256").update(text).digest("hex")}` };
  }

  /** A timestamped copy of the config file (`<real file>.bak-<time>`), or undefined when there is none. */
  function backupConfig() {
    const file = configTarget();
    if (!fs.existsSync(file)) return undefined;
    const base = `${file}.bak-${new Date().toISOString().replace(/:/g, "-")}`;
    for (let i = 0; ; i++) {
      const backup = i ? `${base}-${i}` : base;
      try {
        fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
        return backup;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
  }

  /**
   * Edit Hermes's config, after a timestamped backup. `edit` gets the text and its parsed document and
   * returns the new text, or undefined when nothing changes. The edit is made under the config lock on
   * the file as read under that lock (so a concurrent `mw hermes init` is never lost); if the file
   * changes between that read and the rename (Hermes itself writing), nothing is written and the
   * backup is kept. A symbolic link is followed: the file it leads to is read, copied and replaced.
   */
  function editConfig(edit) {
    testHooks.beforeLock?.();
    return withConfigLock(() => {
      const file = configTarget();
      const before = snapshot(file);
      const old = before.text;
      const text = old ?? "";
      const doc = YAML.parseDocument(text);
      if (doc.errors.length) throw new Error(`${file} is not valid YAML (${doc.errors[0].message.split("\n")[0]}); fix it first`);
      const next = edit(text, doc);
      if (next === undefined || next === text) return { changed: false };
      const backup = old !== undefined ? backupConfig() : undefined;
      testHooks.beforeRename?.();
      if (snapshot(file).stamp !== before.stamp) {
        throw new Error(`${file} changed while MergeWright was editing it (Hermes or another program wrote it); nothing was written${backup ? `, and the copy from before is kept as ${backup}` : ""}. Run the command again.`);
      }
      // Keep the file's permissions (Hermes's config can hold credentials); a new one is private.
      writeAtomic(file, next, old === undefined ? 0o600 : fs.statSync(file).mode & 0o777);
      return { changed: true, backup };
    });
  }

  /** The `mcp_servers` map when it is a non-empty block map (the form text edits handle), else undefined. */
  function blockServers(doc) {
    const servers = doc.get("mcp_servers", true);
    return YAML.isMap(servers) && !servers.flow && servers.items.length && servers.range ? servers : undefined;
  }

  function entryText(name, want, indent) {
    const body = YAML.stringify({ [name]: entryBody(want) }, { lineWidth: 0 });
    return body.split("\n").filter(Boolean).map((l) => `${indent}${l}`).join("\n") + "\n";
  }

  const entryIn = (text, name) => YAML.parse(text)?.mcp_servers?.[name];

  /**
   * Add or update the entry. A new entry is spliced into the text at the end of `mcp_servers` (or a new
   * `mcp_servers` at the end of the file), so every other byte of the file stays as it was; an existing
   * entry is updated in place through the yaml document API (comments and keys added by hand stay).
   */
  function setEntryYaml(name, want) {
    return editConfig((text, doc) => {
      const cur = doc.getIn(["mcp_servers", name], true);
      if (YAML.isMap(cur) && sameEntry(cur.toJSON(), want)) return undefined;
      if (!cur) {
        const servers = blockServers(doc);
        let spliced;
        if (servers) {
          const first = servers.items[0].key.range[0];
          const at = servers.range[2];
          const indent = text.slice(lineStart(text, first), first);
          spliced = `${text.slice(0, at)}${at > 0 && text[at - 1] !== "\n" ? "\n" : ""}${entryText(name, want, indent)}${text.slice(at)}`;
        } else if (!doc.has("mcp_servers")) {
          spliced = `${text}${text && !text.endsWith("\n") ? "\n" : ""}mcp_servers:\n${entryText(name, want, "  ")}`;
        }
        if (spliced !== undefined && JSON.stringify(entryIn(spliced, name)) === JSON.stringify(entryBody(want))) return spliced;
      }
      let servers = doc.get("mcp_servers", true);
      if (!YAML.isMap(servers)) {
        servers = doc.createNode({});
        doc.set("mcp_servers", servers);
      }
      const entry = servers.get(name, true);
      if (YAML.isMap(entry)) {
        entry.set("command", want.command);
        entry.set("args", doc.createNode(want.args));
        if (want.env) {
          const e = entry.get("env", true);
          if (YAML.isMap(e)) for (const [k, v] of Object.entries(want.env)) e.set(k, v);
          else entry.set("env", doc.createNode(want.env));
        }
        entry.set("enabled", true);
      } else {
        servers.set(name, doc.createNode(entryBody(want)));
      }
      return doc.toString({ lineWidth: 0 });
    });
  }

  /** Remove the entry: its lines are cut from the text (and `mcp_servers` with it when it was the last one). */
  function removeEntryYaml(name) {
    return editConfig((text, doc) => {
      if (!doc.hasIn(["mcp_servers", name])) return undefined;
      const servers = blockServers(doc);
      const pair = servers?.items.find((p) => p.key.value === name);
      if (servers && pair && pair.value?.range) {
        const last = servers.items.length === 1;
        const top = doc.contents && YAML.isMap(doc.contents) ? doc.contents.items.find((p) => p.key.value === "mcp_servers") : undefined;
        const from = last && top ? lineStart(text, top.key.range[0]) : lineStart(text, pair.key.range[0]);
        const to = last ? servers.range[2] : pair.value.range[2];
        const cut = text.slice(0, from) + text.slice(to);
        if (entryIn(cut, name) === undefined) return cut;
      }
      const map = doc.get("mcp_servers", true);
      map.delete(name);
      if (!map.items.length) doc.delete("mcp_servers");
      return doc.toString({ lineWidth: 0 });
    });
  }

  /** `hermes mcp ...`, answering its questions (overwrite: yes; enable all tools: yes; save anyway: yes). */
  function hermesCli(args, answers) {
    const r = host.exec("hermes", args, { input: answers, timeoutMs: 180_000 });
    const output = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "").trim();
    return { ok: r.code === 0 && !r.timedOut, output };
  }

  function installSkill(shared) {
    const source = readIfExists(SKILL_FILE);
    if (source === undefined) throw new Error(`the skill file ${SKILL_FILE} is missing from this package`);
    const file = skillFile(shared);
    if (readIfExists(file) === source) return { file, changed: false };
    writeAtomic(file, source);
    return { file, changed: true };
  }

  function init(opts = {}) {
    const name = entryName(opts.name);
    const want = serverEntry();
    const notes = [];
    let how = "unchanged";
    let backup;
    if (!sameEntry(readEntry(name), want)) {
      if (host.which("hermes")) {
        const exists = readEntry(name) !== undefined;
        const r = withConfigLock(() => {
          backup = backupConfig();
          return hermesCli(["mcp", "add", name, "--command", want.command, "--args", ...want.args], exists ? "y\ny\n" : "y\n");
        }, { keepFresh: true });
        const now = readEntry(name);
        if (now && now.command === want.command && JSON.stringify(now.args) === JSON.stringify(want.args)) {
          how = "hermes";
          // 'hermes mcp add' takes no environment: the agent socket is added to its entry by a config edit.
          if (!sameEnv(now, want)) {
            const r2 = setEntryYaml(name, want);
            backup ??= r2.backup;
          }
        } else notes.push(`'hermes mcp add' did not register the server (${r.output.split("\n").slice(-2).join(" ") || "no output"}); edited the config instead`);
      }
      if (how === "unchanged") {
        const r = setEntryYaml(name, want);
        how = r.changed ? "config" : "unchanged";
        backup ??= r.backup; // the copy from before 'hermes mcp add', when that ran first
      }
    }
    const enabled = readEntry(name)?.enabled !== false;
    if (!want.env) notes.push("no SSH agent was found (SSH_AUTH_SOCK is unset and none of the usual sockets exists), so the entry has no SSH_AUTH_SOCK: on a project with a hub, start an agent and run 'mw hermes init' again, or the hub tools cannot reach a hub over SSH");
    if (!enabled) notes.push(`Hermes could not start the server when it was added, so the entry is saved disabled: run 'hermes mcp test ${name}', fix what it reports, then 'mw hermes init' again`);
    const skill = installSkill(opts.shared === true);
    return { name, entry: want, how, backup, enabled, skill: skill.file, skillChanged: skill.changed, notes };
  }

  function remove(opts = {}) {
    const name = entryName(opts.name);
    const notes = [];
    let removed = false;
    let how;
    let backup;
    if (readEntry(name) !== undefined) {
      if (host.which("hermes")) {
        withConfigLock(() => {
          backup = backupConfig();
          hermesCli(["mcp", "remove", name], "y\n");
        }, { keepFresh: true });
        if (readEntry(name) === undefined) { removed = true; how = "hermes"; }
      }
      if (!removed) {
        const r = removeEntryYaml(name);
        removed = r.changed;
        how = "config";
        backup ??= r.backup;
      }
    }
    // The skill serves every MergeWright project on this machine: it goes with the last entry. The
    // shared skill (`sharedSkillsDir`) also serves other machines: never removed.
    let skill;
    const others = mergewrightEntries().filter((n) => n !== name);
    const file = skillFile(opts.shared === true);
    if (others.length) notes.push(`kept the skill ${file}: Hermes still has ${others.join(", ")}`);
    else if (opts.shared === true) {
      if (fs.existsSync(file)) {
        const dir = path.dirname(file);
        notes.push(`kept the shared skill folder ${dir}: other machines may use it. When no machine needs it any more, remove it by hand: rm -r '${dir}'`);
      }
    } else if (fs.existsSync(file)) {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      skill = file;
    }
    return { name, removed, how, backup, skill, notes };
  }

  function status(opts = {}) {
    const name = entryName(opts.name);
    const source = readIfExists(SKILL_FILE);
    const skills = [false, true].map((shared) => {
      const file = skillFile(shared);
      const text = readIfExists(file);
      return { file, state: text === undefined ? "not installed" : text === source ? "up to date" : "differs from this package's" };
    });
    const entry = readEntry(name);
    const e = entry?.env && typeof entry.env === "object" ? entry.env : {};
    // The SSH agent socket the entry gives the server, and the one this shell would give it now.
    const sshAgent = { entry: typeof e.SSH_AUTH_SOCK === "string" ? e.SSH_AUTH_SOCK : undefined, now: host.sshAgent() };
    return { name, config: hermesConfigFile(), entry, sshAgent, skills, hermesOnPath: !!host.which("hermes") };
  }

  /**
   * The installed copy of the skill (`shared`: in the shared skills folder) when it exists
   * and differs from the one this package ships; undefined otherwise (or when the shipped one is missing).
   */
  function skillDrift(shared) {
    const source = readIfExists(SKILL_FILE);
    const file = skillFile(shared);
    const text = source === undefined ? undefined : readIfExists(file);
    return { file, installed: text !== undefined, differs: text !== undefined && text !== source };
  }

  return { init, remove, status, skillDrift, hermesConfigFile, setEntryYaml, removeEntryYaml };
}

// ── mw hermes ───────────────────────────────────────────────────────────────────────────────

function command(host, tools) {
  return (args, out) => {
    const sub = args._[1];
    const role = host.env("MW_ROLE");
    if (role) { host.log(`changing the Hermes configuration is done by the owner, not from inside a card run (role '${role}')`); return 1; }
    const name = typeof args.flags.name === "string" ? args.flags.name : undefined;
    const opts = { shared: args.flags.shared === true, name };
    try {
      if (sub === "init") {
        const r = tools.init(opts);
        const what = r.how === "unchanged" ? "already registered" : r.how === "hermes" ? "registered through 'hermes mcp add'" : "registered in the config";
        out(`MCP server '${r.name}': ${what}: ${r.entry.command} ${r.entry.args.join(" ")}`);
        if (r.entry.env?.SSH_AUTH_SOCK) out(`ssh agent for the server: SSH_AUTH_SOCK=${r.entry.env.SSH_AUTH_SOCK}`);
        if (r.backup) out(`backup of the previous config: ${r.backup}`);
        out(`skill 'mergewright': ${r.skillChanged ? "installed" : "up to date"} at ${r.skill}`);
        for (const n of r.notes) out(`note: ${n}`);
        out(`check: 'hermes mcp test ${r.name}', then start a new Hermes session (or /reload-mcp) to load the tools`);
        return r.enabled ? 0 : 1;
      }
      if (sub === "status") {
        const r = tools.status(opts);
        if (r.entry) {
          const a = Array.isArray(r.entry.args) ? r.entry.args.join(" ") : "";
          out(`MCP server '${r.name}' in ${r.config}: ${String(r.entry.command ?? r.entry.url ?? "?")} ${a}${r.entry.enabled === false ? " (disabled)" : ""}`);
        } else out(`MCP server '${r.name}': not registered in ${r.config} (run 'mw hermes init')`);
        if (r.entry) {
          out(r.sshAgent.entry
            ? `ssh agent: the entry sets SSH_AUTH_SOCK=${r.sshAgent.entry}${r.sshAgent.now && r.sshAgent.now !== r.sshAgent.entry ? ` (this shell's agent is ${r.sshAgent.now}: run 'mw hermes init' to use it)` : ""}`
            : `ssh agent: the entry sets no SSH_AUTH_SOCK, so the server finds an agent by itself or has none${r.sshAgent.now ? ` (this shell's agent is ${r.sshAgent.now}: run 'mw hermes init' to write it)` : ""}`);
        }
        for (const s of r.skills) out(`skill: ${s.state}: ${s.file}`);
        if (r.hermesOnPath && r.entry) out(`check: 'hermes mcp test ${r.name}'`);
        if (!r.hermesOnPath) out("note: the hermes CLI is not on PATH on this machine");
        return r.entry ? 0 : 1;
      }
      if (sub === "remove") {
        const r = tools.remove(opts);
        out(r.removed ? `MCP server '${r.name}' removed${r.how === "hermes" ? " through 'hermes mcp remove'" : " from the config"}` : `MCP server '${r.name}' was not registered`);
        if (r.backup) out(`backup of the previous config: ${r.backup}`);
        if (r.skill) out(`skill removed: ${r.skill}`);
        for (const n of r.notes) out(`note: ${n}`);
        return 0;
      }
    } catch (e) {
      host.log(e instanceof Error ? e.message : String(e));
      return 1;
    }
    host.log("use 'mw hermes init [--shared] [--name N]', 'mw hermes status' or 'mw hermes remove [--shared] [--name N]'");
    return 2;
  };
}

export function activate(host) {
  const tools = hermesTools(host);
  const drift = (shared) => ({
    name: shared ? "hermes shared skill" : "hermes skill",
    async run() {
      // An installed skill this package no longer ships is reported (not counted as a problem).
      const d = tools.skillDrift(shared);
      if (d.differs) return { ok: false, detail: `${d.file} differs from this package's SKILL.md; run 'mw hermes init${shared ? " --shared" : ""}' to update it` };
      return { ok: true, detail: d.installed ? `${d.file} is up to date` : `not installed at ${d.file}` };
    },
  });
  return {
    harness: { hermes: harness(host) },
    commands: { hermes: command(host, tools) },
    checks: [drift(false), drift(true)],
  };
}
