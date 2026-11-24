# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/manxzo/mergewright/security/advisories/new).
Include what you found, how to reproduce it, and the output of `mw version`.

You should get a first answer within a week. Once a fix is released, the advisory is published and
you are credited unless you prefer otherwise.

## Supported versions

MergeWright is at 0.x. Only the latest release receives fixes.

## What to keep in mind

- MergeWright runs agent programs and the project's own gate script with your rights. A project's
  `mergewright.yaml`, roles, flows and gates are code you choose to run.
- A package runs with your rights whenever MergeWright loads it. `mw add` shows what a package
  provides and asks before installing it; install only packages you trust.
- `mw ui` listens on 127.0.0.1 only and needs the per-start token in the link it prints. Anyone who
  has that link can act as you until the server stops.
- Secrets belong in `~/.config/mergewright/env`, never in the repository. Agent and gate output is
  redacted of the configured secret values before it is written to the run folders.
