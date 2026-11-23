// Entry point of the single-executable build (scripts/build-binary.sh). In a single executable
// process.argv[1] is the executable itself, so the user's arguments start at index 2.
import { main } from "./cli.ts";

void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
