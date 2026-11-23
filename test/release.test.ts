// Release tooling: scripts/install-binary.sh against a fake release served on loopback, and (with
// MW_RELEASE_TEST=1, because it builds the 120 MB binary) scripts/build-binary.sh followed by
// scripts/clean-machine-test.sh on what it built.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { tmpDir } from "./helpers.ts";

const script = (name: string) => path.join(PACKAGE_ROOT, "scripts", name);
const asset = `mw-${process.platform}-${process.arch}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Run a command without blocking the event loop (the fake release server lives in this process). */
function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

/** Serve `files` (name -> content) on loopback; 404 for anything else. */
async function release(files: Record<string, string>): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const name = (req.url ?? "").replace(/^\//, "");
    if (Object.hasOwn(files, name)) res.end(files[name]);
    else { res.statusCode = 404; res.end("not found"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const haveTools = spawnSync("sh", ["-c", "command -v curl || command -v wget"]).status === 0;
const supported = ["linux-x64", "linux-arm64"].includes(`${process.platform}-${process.arch}`);

test("install-binary.sh installs the asset for this machine after checking SHA256SUMS, and says when the folder is not on PATH", { skip: !haveTools || !supported }, async () => {
  const body = "#!/bin/sh\necho fake mw\n";
  const srv = await release({ [asset]: body, SHA256SUMS: `${sha256("other")}  mw-linux-riscv\n${sha256(body)}  ${asset}\n` });
  try {
    const dir = path.join(tmpDir(), "bin");
    const r = await run("sh", [script("install-binary.sh")], { MW_BASE_URL: srv.url, MW_INSTALL_DIR: dir });
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.readFileSync(path.join(dir, "mw"), "utf8"), body);
    assert.ok(fs.statSync(path.join(dir, "mw")).mode & 0o100, "mw is executable");
    assert.match(r.out, new RegExp(`installed ${asset} at .*/bin/mw`));
    assert.match(r.out, /is not on PATH/);
    assert.deepEqual(fs.readdirSync(dir), ["mw"], "no temporary file is left behind");
  } finally {
    srv.close();
  }
});

test("install-binary.sh refuses to install on a checksum mismatch, a missing entry or a missing asset", { skip: !haveTools || !supported }, async () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ [asset]: "tampered", SHA256SUMS: `${sha256("original")}  ${asset}\n` }, /checksum of .* does not match SHA256SUMS.*nothing was installed/],
    [{ [asset]: "x", SHA256SUMS: `${sha256("x")}  mw-other-os\n` }, /SHA256SUMS has no entry for/],
    [{ SHA256SUMS: "" }, /could not download/],
  ];
  for (const [files, message] of cases) {
    const srv = await release(files);
    try {
      const dir = path.join(tmpDir(), "bin");
      const r = await run("sh", [script("install-binary.sh")], { MW_BASE_URL: srv.url, MW_INSTALL_DIR: dir });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, message);
      assert.equal(fs.existsSync(path.join(dir, "mw")), false, "nothing was installed");
    } finally {
      srv.close();
    }
  }
});

test("the built binary passes the clean-machine test (MW_RELEASE_TEST=1)", { skip: process.env.MW_RELEASE_TEST !== "1" && "slow: builds the binary; set MW_RELEASE_TEST=1" }, () => {
  const build = spawnSync("bash", [script("build-binary.sh")], { cwd: PACKAGE_ROOT, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const bin = path.join(PACKAGE_ROOT, "build", asset);
  const sums = fs.readFileSync(path.join(PACKAGE_ROOT, "build", "SHA256SUMS"), "utf8");
  assert.equal(sums, `${createHash("sha256").update(fs.readFileSync(bin)).digest("hex")}  ${asset}\n`);
  const r = spawnSync("bash", [script("clean-machine-test.sh"), bin], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /^FAIL/m);
  assert.match(r.stdout, /all steps passed/);
});

// A shell whose `sh` is not bash refuses bash-only syntax; there the gate must see what `bash -n` misses.
const strictSh = spawnSync("sh", ["-n", "-c", "function f() { :; }"]).status !== 0;

test("the gate checks scripts/install-binary.sh with sh -n, not only bash -n", { skip: !strictSh && "sh here accepts bash syntax" }, () => {
  const dir = tmpDir("mw-gate-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(PACKAGE_ROOT, "gates", "default.gate.sh"), path.join(dir, "gate.sh"));
  const gate = () => spawnSync("bash", ["gate.sh"], { cwd: dir, env: { ...process.env, MERGEWRIGHT_GATE_KINDS: "lint", MERGEWRIGHT_GATE_JSON: path.join(dir, "out", "gate.json") }, encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "scripts", "install-binary.sh"), "#!/bin/sh\nfunction f() { :; }\n");
  const bad = gate();
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /syntax error \(sh\): scripts\/install-binary\.sh/);
  fs.writeFileSync(path.join(dir, "scripts", "install-binary.sh"), "#!/bin/sh\nf() { :; }\n");
  assert.equal(gate().status, 0);
});
