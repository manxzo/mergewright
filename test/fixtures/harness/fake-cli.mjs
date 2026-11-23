#!/usr/bin/env node
// Stand-in for the claude, codex and hermes CLIs in hermetic harness tests. Each CLI name is a
// tiny sh wrapper that runs `node fake-cli.mjs <name> "$@"`. Records argv, cwd, environment and
// stdin to $FAKE_RECORD, then replies in the real CLI's output shape. $FAKE_MODE: ok (default) | text | fail | error | empty | sleep | stubborn.
import fs from "node:fs";

const name = process.argv[2];
const argv = process.argv.slice(3);
const mode = process.env.FAKE_MODE ?? "ok";
const stdin = (() => {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
})();
const after = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const extra = {};
if (name === "hermes" && after("--query-file")) extra.queryFile = fs.readFileSync(after("--query-file"), "utf8");
if (name === "claude" && after("--mcp-config")) {
  const f = after("--mcp-config");
  extra.mcpConfig = JSON.parse(fs.readFileSync(f, "utf8"));
  extra.mcpMode = fs.statSync(f).mode & 0o777;
}
if (process.env.FAKE_RECORD) {
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ name, pid: process.pid, argv, cwd: process.cwd(), env: process.env, stdin, ...extra }));
}

if (mode === "sleep") setTimeout(() => {}, 60_000);
else if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else reply();

function reply() {
  const fail = mode === "fail";
  if (name === "claude") {
    if (fail) {
      process.stderr.write("Error: something broke\n");
      process.exit(2);
    }
    if (mode === "text") {
      process.stdout.write("not json at all\n");
      return;
    }
    const schema = argv.includes("--json-schema");
    const out = {
      type: "result",
      subtype: mode === "error" ? "error_max_turns" : "success",
      is_error: mode === "error",
      duration_ms: 1234,
      num_turns: 2,
      result: mode === "empty" ? "" : schema ? "" : "plain answer",
      session_id: "00000000-0000-0000-0000-000000000000",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 },
    };
    if (schema && mode !== "empty") out.structured_output = { pong: true };
    process.stdout.write(JSON.stringify(out) + "\n");
    if (mode === "error") process.exit(1);
  } else if (name === "codex") {
    const ev = (o) => process.stdout.write(JSON.stringify(o) + "\n");
    ev({ type: "thread.started", thread_id: "t-1" });
    ev({ type: "turn.started" });
    if (fail) {
      ev({ type: "turn.failed", error: { message: "model refused" } });
      process.exit(1);
    }
    const replyText = mode === "empty" ? "" : argv.includes("--output-schema") ? '{"pong":true}' : "plain answer";
    if (mode !== "empty") fs.writeFileSync(after("-o"), replyText);
    ev({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: replyText } });
    ev({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 4, output_tokens: 9 } });
  } else if (name === "hermes") {
    if (fail) {
      process.stderr.write("hermes: provider error\n");
      process.exit(3);
    }
    if (mode === "empty") return;
    process.stdout.write('Here you go:\n```json\n{"pong": true}\n```\n\nsession_id: 20261005_120000_abcdef\n');
  }
}
