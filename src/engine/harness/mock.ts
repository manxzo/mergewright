// Harness 'mock': scripted replies and file edits, for tests. See docs/design/engine.md section 7.
//
// MW_MOCK_SCRIPT (in the request's env, else the process environment) names a JSON file:
//   { "<role>": [ {"writes": {"path": "content"}, "deletes": ["path"], "output": <object or string>, "fail": true?}, ... ] }
// Call n of a role uses entry n; the last entry repeats. Counters live in <runDir>/mock-counters.json.
import fs from "node:fs";
import path from "node:path";
import { readJson, writeAtomic } from "../../util.ts";
import { writePrivate } from "../private.ts";
import type { Harness } from "../types.ts";

interface Entry {
  writes?: Record<string, string>;
  deletes?: string[];
  output?: unknown;
  fail?: boolean;
  /** Milliseconds to wait before replying (to exercise heartbeats and aborts); an abort ends the wait. */
  delay?: number;
}

const harness: Harness = {
  async run(req) {
    const t0 = Date.now();
    const seconds = () => Math.round((Date.now() - t0) / 1000);
    if (req.signal?.aborted) return { ok: false, text: "", error: "stopped by the runtime", seconds: 0 };
    const scriptFile = req.env.MW_MOCK_SCRIPT ?? process.env.MW_MOCK_SCRIPT;
    if (!scriptFile) return { ok: false, text: "", error: "the mock harness needs MW_MOCK_SCRIPT to name a script file", seconds: seconds() };
    const script = readJson<Record<string, Entry[]>>(scriptFile) ?? {};
    const entries = script[req.role.id];
    if (!entries?.length) return { ok: false, text: "", error: `the mock script has no entries for role '${req.role.id}'`, seconds: seconds() };
    const countersFile = path.join(req.runDir, "mock-counters.json");
    const counters = readJson<Record<string, number>>(countersFile) ?? {};
    const n = counters[req.role.id] ?? 0;
    counters[req.role.id] = n + 1;
    writePrivate(countersFile, JSON.stringify(counters) + "\n");
    const entry = entries[Math.min(n, entries.length - 1)]!;
    if (entry.delay) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, entry.delay);
        req.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
      if (req.signal?.aborted) return { ok: false, text: "", error: "stopped by the runtime", seconds: seconds() };
    }
    for (const [rel, content] of Object.entries(entry.writes ?? {})) writeAtomic(path.join(req.cwd, rel), content);
    for (const rel of entry.deletes ?? []) fs.rmSync(path.join(req.cwd, rel), { force: true, recursive: true });
    if (entry.fail) return { ok: false, text: "", error: "the mock entry is scripted to fail", seconds: seconds() };
    const text = entry.output === undefined ? "" : typeof entry.output === "string" ? entry.output : JSON.stringify(entry.output, null, 2);
    if (!text) return { ok: false, text: "", error: "the mock entry produced no output", seconds: seconds() };
    return { ok: true, text, seconds: seconds(), usage: { inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: Math.ceil(text.length / 4) } };
  },
};
export default harness;
