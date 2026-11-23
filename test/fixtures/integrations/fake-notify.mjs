#!/usr/bin/env node
// Fake report command: appends {args, body} to $FAKE_NOTIFY_LOG, then exits with $FAKE_NOTIFY_EXIT.
import fs from "node:fs";
const args = process.argv.slice(2);
const i = args.indexOf("--file");
const file = i >= 0 ? args[i + 1] : undefined;
const body = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
const code = Number(process.env.FAKE_NOTIFY_EXIT ?? 0);
if (code === 0) fs.appendFileSync(process.env.FAKE_NOTIFY_LOG, JSON.stringify({ args, body, file }) + "\n");
else process.stderr.write("fake notify: delivery failed\n");
process.exit(code);
