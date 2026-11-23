// No tracked file may name a private host, address or path. Today's hits are recorded in
// test/scrub-allowlist.txt as path:count and may only go down (npm run scrub:update).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ALLOWLIST, GENERIC, countHits, readAllowlist, scan } from "./scrub.ts";

test("the generic patterns catch private addresses, .lan names and home paths, not placeholders", () => {
  const hit = (s: string) => countHits(s, GENERIC);
  // Built by concatenation so this file's own text does not match.
  for (const s of ["10." + "1.2.3", "172." + "20.0.5", "192." + "168.1.10", "100." + "101.2.3", "nas" + ".lan", "/home/" + "jane/x"]) {
    assert.equal(hit(s), 1, s);
  }
  for (const s of ["172.32.0.1", "100.63.0.1", "192.0.2.1", "203.0.113.5", "v1.10.2.3.4", "/home/user/x", "/home/me/x", "the plan", "x.language"]) {
    assert.equal(hit(s), 0, s);
  }
});

test("the scrub test's own sources do not trip it", () => {
  for (const f of ["test/scrub.ts", "test/scrub.test.ts", "scripts/scrub-update.ts"]) {
    assert.equal(countHits(fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), GENERIC), 0, f);
  }
});

test("no tracked file has more private-detail hits than its allowlisted count", () => {
  const allowed = readAllowlist();
  const hits = scan();
  const over: string[] = [];
  for (const [file, n] of hits) {
    const max = allowed.get(file) ?? 0;
    if (n > max) over.push(`${file}: ${n} hits, ${max} allowed`);
  }
  assert.deepEqual(over, [], `New private details (a host, address, path or private term) in tracked files. Remove them; the allowlist (${ALLOWLIST}) may only shrink.\n${over.join("\n")}`);
  if (process.env.MW_SCRUB_STRICT === "1") {
    const loose: string[] = [];
    for (const [file, max] of allowed) {
      const n = hits.get(file) ?? 0;
      if (max > n) loose.push(`${file}: ${max} allowed, ${n} found`);
    }
    assert.deepEqual(loose, [], `The allowlist is higher than reality. Run: MW_SCRUB_TERMS=<terms file> npm run scrub:update\n${loose.join("\n")}`);
  }
});
