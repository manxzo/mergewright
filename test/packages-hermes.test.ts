// The official hermes package (packages/hermes), installed with `mw add hermes --yes`: `mw hermes
// init|status|remove` against a scratch HERMES_HOME and HOME, with no `hermes` on PATH (the config is
// edited through the yaml document API), and what a project without the package is told. The harness
// is tested in harness.test.ts and req/harness.test.ts, the config lock in
// regressions-hermes-config, regressions-delegation and regressions-locking.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { addPackage, codes, mw, newProject, tmpDir, write } from "./helpers.ts";

const HERMES_SKILL_FILE = path.join(PACKAGE_ROOT, "packages", "hermes", "SKILL.md");

const CONFIG = `# Hermes configuration (owner's comments must survive)
model:
  default: some-model   # the default chat model
mcp_servers:
  # a remote server
  jira-mcp:
    url: https://mcp.example.com/mcp
    auth: oauth
  ssh-mcp:
    command: npx
    args:
      - '@aiondadotcom/mcp-ssh'
display:
  skin: default
`;

/** A PATH with node, git and sh but neither hermes nor mw. */
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

function setup(withConfig = true) {
  const dir = newProject();
  addPackage(dir, "hermes");
  const home = tmpDir("mw-home-");
  const hermesHome = path.join(home, ".hermes");
  fs.mkdirSync(hermesHome, { recursive: true });
  if (withConfig) fs.writeFileSync(path.join(hermesHome, "config.yaml"), CONFIG, { mode: 0o600 });
  // No SSH agent (`mw hermes init` writes one into the entry when there is): an empty runtime directory.
  const env = { HOME: home, HERMES_HOME: hermesHome, PATH: barePath(), SSH_AUTH_SOCK: "", XDG_RUNTIME_DIR: tmpDir("mw-run-") };
  const config = () => fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8");
  const backups = () => fs.readdirSync(hermesHome).filter((f) => f.startsWith("config.yaml.bak-"));
  return { dir, home, hermesHome, env, config, backups };
}

test("init registers the server and installs the skill; idempotent; comments and other entries kept; a backup is made", () => {
  const s = setup();
  const r = mw(s.dir, ["hermes", "init"], s.env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /MCP server 'mergewright-demo': registered in the config: .*mw\.js mcp serve --project /);
  assert.match(r.out, /backup of the previous config: .*config\.yaml\.bak-/);
  assert.match(r.out, /hermes mcp test mergewright-demo/);
  const text = s.config();
  for (const keep of ["# Hermes configuration (owner's comments must survive)", "# the default chat model", "# a remote server", "jira-mcp:", "'@aiondadotcom/mcp-ssh'", "display:"]) assert.ok(text.includes(keep), keep);
  assert.match(text, /  mergewright-demo:\n    command: .*node.*\n    args:\n      - .*bin\/mw\.js\n      - mcp\n      - serve\n      - --project\n      - .*\n    enabled: true\n/);
  assert.ok(text.includes(`- ${s.dir}`));
  assert.equal(text.replace(/  mergewright-demo:\n( {4}.*\n)+/, ""), CONFIG, "every other byte is unchanged");
  assert.equal(s.backups().length, 1);
  assert.equal(fs.readFileSync(path.join(s.hermesHome, s.backups()[0]!), "utf8"), CONFIG, "the backup is the old file");
  assert.equal(fs.statSync(path.join(s.hermesHome, "config.yaml")).mode & 0o777, 0o600, "permissions kept");
  const skill = path.join(s.hermesHome, "skills", "mergewright", "SKILL.md");
  assert.equal(fs.readFileSync(skill, "utf8"), fs.readFileSync(HERMES_SKILL_FILE, "utf8"));
  assert.match(fs.readFileSync(skill, "utf8"), /^---\nname: mergewright\ndescription: .*\nversion: .*\nauthor: .*\nplatforms: .*\nmetadata:\n  hermes:\n    tags: \[.*\]\n    category: .*\n---\n/);

  // Again: nothing changes, no new backup.
  const again = mw(s.dir, ["hermes", "init"], s.env);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /already registered/);
  assert.match(again.out, /skill 'mergewright': up to date/);
  assert.equal(s.config(), text);
  assert.equal(s.backups().length, 1);

  // A changed entry is updated in place; keys added by hand stay.
  fs.writeFileSync(path.join(s.hermesHome, "config.yaml"), text.replace("    enabled: true\n", "    enabled: true\n    timeout: 300\n").replace(/command: .*node.*/, "command: /old/mw"));
  assert.equal(mw(s.dir, ["hermes", "init"], s.env).code, 0);
  assert.match(s.config(), /mergewright-demo:\n    command: .*node.*\n[\s\S]*timeout: 300/);
  assert.equal(s.backups().length >= 2, true);

  const st = mw(s.dir, ["hermes", "status"], s.env);
  assert.equal(st.code, 0, st.err);
  assert.match(st.out, /MCP server 'mergewright-demo' in .*config\.yaml: .*mcp serve --project/);
  assert.match(st.out, /skill: up to date: .*\.hermes\/skills\/mergewright\/SKILL\.md/);
  assert.match(st.out, /skill: not installed: .*\.hermes\/shared-skills\/mergewright\/SKILL\.md/);
  assert.match(st.out, /hermes CLI is not on PATH/);
});

test("remove leaves the config as it was apart from the entry, and removes the skill", () => {
  const s = setup();
  assert.equal(mw(s.dir, ["hermes", "init", "--name", "mw-demo"], s.env).code, 0);
  assert.match(s.config(), /  mw-demo:\n/);
  const r = mw(s.dir, ["hermes", "remove", "--name", "mw-demo"], s.env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /MCP server 'mw-demo' removed from the config/);
  assert.match(r.out, /skill removed: /);
  assert.equal(s.config(), CONFIG);
  assert.equal(fs.existsSync(path.join(s.hermesHome, "skills", "mergewright")), false);
  assert.match(mw(s.dir, ["hermes", "remove", "--name", "mw-demo"], s.env).out, /was not registered/);
  assert.equal(mw(s.dir, ["hermes", "status", "--name", "mw-demo"], s.env).code, 1);
});

test("--shared installs the skill in the shared skills folder ($HERMES_HOME/shared-skills, or MW_HERMES_SHARED_SKILLS); remove --shared never deletes it, and says how to", () => {
  const s = setup(false);
  const other = newProject();
  addPackage(other, "hermes");
  fs.writeFileSync(path.join(other, "mergewright.yaml"), fs.readFileSync(path.join(other, "mergewright.yaml"), "utf8").replace(/^name: .*$/m, "name: other"));
  assert.equal(mw(s.dir, ["hermes", "init", "--shared"], s.env).code, 0);
  assert.equal(mw(other, ["hermes", "init", "--shared"], s.env).code, 0);
  const shared = path.join(s.hermesHome, "shared-skills", "mergewright", "SKILL.md");
  assert.ok(fs.existsSync(shared));
  assert.equal(fs.statSync(path.join(s.hermesHome, "config.yaml")).mode & 0o777, 0o600, "a new config is private");
  assert.match(s.config(), /mergewright-demo:[\s\S]*mergewright-other:/);
  const r = mw(s.dir, ["hermes", "remove", "--shared"], s.env);
  assert.match(r.out, /kept the skill .*: Hermes still has mergewright-other/);
  assert.ok(fs.existsSync(shared));
  const last = mw(other, ["hermes", "remove", "--shared"], s.env);
  assert.match(last.out, /note: kept the shared skill folder .*shared-skills\/mergewright: other machines may use it\. .*rm -r '/);
  assert.ok(fs.existsSync(shared), "the shared skill is never removed: other machines use it");
  assert.doesNotMatch(s.config(), /mcp_servers/);
  const elsewhere = path.join(tmpDir("mw-shared-"), "skills");
  assert.equal(mw(s.dir, ["hermes", "init", "--shared"], { ...s.env, MW_HERMES_SHARED_SKILLS: elsewhere }).code, 0);
  assert.ok(fs.existsSync(path.join(elsewhere, "mergewright", "SKILL.md")), "MW_HERMES_SHARED_SKILLS names the folder");
});

test("inside a card run, mw hermes is refused", () => {
  const s = setup();
  const r = mw(s.dir, ["hermes", "init"], { ...s.env, MW_ROLE: "worker" });
  assert.equal(r.code, 1);
  assert.match(r.err, /done by the owner/);
  assert.equal(s.config(), CONFIG);
});

test("with hermes on PATH, init uses 'hermes mcp add', and falls back to the config when it did not register the server", () => {
  const s = setup();
  const bin = barePath();
  const log = path.join(bin, "hermes.log");
  fs.writeFileSync(path.join(bin, "hermes"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\necho "Failed to connect"\n`, { mode: 0o755 });
  const r = mw(s.dir, ["hermes", "init"], { ...s.env, PATH: bin });
  assert.equal(r.code, 0, r.err);
  const call = fs.readFileSync(log, "utf8").trim();
  assert.match(call, /^mcp add mergewright-demo --command \S+ --args \S*bin\/mw\.js mcp serve --project \S+$/);
  assert.match(r.out, /note: 'hermes mcp add' did not register the server \(Failed to connect\); edited the config instead/);
  assert.match(r.out, /registered in the config/);
  assert.match(s.config(), /mergewright-demo:/);
});

test("without the package, 'runs: hermes' and 'mw hermes' say to run 'mw add hermes'; with it, both work and mw help names only the MCP server", () => {
  const out = mw(tmpDir(), ["help"]).out;
  assert.match(out, /mw mcp serve \[--project DIR\]/);
  assert.doesNotMatch(out, /hermes/i, "the core's help no longer names Hermes");
  const dir = newProject();
  write(dir, "roles/helper.role.md", "---\nid: helper\nruns: hermes\nmode: advise\noutput: text\n---\nHelp with {{card}}.\n");
  const r = mw(dir, ["check"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /'runs: hermes' is a harness of the official package 'hermes' now, which is not installed and enabled here; run 'mw add hermes' to use it/);
  const cmd = mw(dir, ["hermes", "status"]);
  assert.equal(cmd.code, 2);
  assert.match(cmd.err, /'mw hermes' is a command of the official package 'hermes' now, which is not installed and enabled here; run 'mw add hermes' to use it/);
  addPackage(dir, "hermes");
  assert.deepEqual(codes(dir, "error"), [], "with the package the role is valid");
  write(dir, "mcps/docs.mcp.yaml", "id: docs\ntransport: http\nurl: http://x/mcp\nroles: [helper]\n");
  assert.deepEqual(codes(dir, "warning"), ["role/mcp-unsupported"], "a package harness is not given the project's MCP servers");
  fs.rmSync(path.join(dir, "mcps", "docs.mcp.yaml"));
  write(dir, "roles/helper.role.md", "---\nid: helper\nruns: hermes\nmode: write\noutput: handoff\n---\nDo {{card}}.\n");
  assert.deepEqual(codes(dir, "error"), ["role/mode"], "a package harness is advisory: no write mode");
  const p = mw(dir, ["packages"]);
  assert.match(p.out, /^hermes +0\.1\.0 +enabled +loaded, provides harness, commands, checks$/m);
});
