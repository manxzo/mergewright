// Rewrites test/scrub-allowlist.txt from the current hits. Refuses to raise any count.
// Needs MW_SCRUB_TERMS, so the private list counts too; without it every count would drop falsely.
import fs from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { ALLOWLIST, formatAllowlist, readAllowlist, scan } from "../test/scrub.ts";

if (!process.env.MW_SCRUB_TERMS) {
  console.error("Set MW_SCRUB_TERMS to the private terms file, for example MW_SCRUB_TERMS=~/.config/mergewright/scrub-terms npm run scrub:update.");
  process.exit(2);
}
const file = path.join(PACKAGE_ROOT, ALLOWLIST);
const old = readAllowlist();
const hits = scan();
const raised = [...hits].filter(([f, n]) => fs.existsSync(file) && n > (old.get(f) ?? 0));
if (raised.length) {
  console.error(`Not updated: these files have more hits than allowed. Remove the private details instead.\n${raised.map(([f, n]) => `${f}: ${n} hits, ${old.get(f) ?? 0} allowed`).join("\n")}`);
  process.exit(1);
}
fs.writeFileSync(file, formatAllowlist(hits));
const total = [...hits.values()].reduce((a, b) => a + b, 0);
console.log(`${ALLOWLIST}: ${hits.size} files, ${total} hits.`);
