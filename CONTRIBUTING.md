# Contributing to MergeWright

Thanks for taking the time. Bug reports, fixes, documentation and new packages are all welcome.

## Before you start

- For a bug, open an issue with the command you ran, what you expected and what happened.
  `mw version` and `mw doctor` output help a lot. Remove secrets first.
- For a larger change, open an issue to discuss it before writing code. The engine's behaviour is
  specified in [docs/specification.md](docs/specification.md); a change in behaviour changes the
  specification in the same pull request.
- A service integration belongs in a package, not in the core. See
  [docs/packages.md](docs/packages.md).

## Setting up

You need Node 24 or later and git, on Linux or macOS.

```bash
git clone https://github.com/manxzo/mergewright && cd mergewright
npm ci
npm run typecheck
npm test
```

There is no build step in a checkout: `bin/mw.js` runs the TypeScript in `src/` directly.
`scripts/demo-project.sh <dir>` makes a small project to try the command, the terminal UI and the
GUI on, with a simulated agent.

## Rules for code

These are the short form of [AGENTS.md](AGENTS.md), which agents working in this repository read.

- TypeScript uses erasable syntax only: no enums, no parameter properties, no namespaces. Imports
  use the `.ts` extension, and type-only imports use `import type`.
- No new npm dependencies without discussing it first. The runtime depends on `ajv` and `yaml` only.
- Tests are hermetic: temporary directories, no network, agents simulated by the `mock` and `shell`
  harnesses. A test that needs a real service or agent CLI is skipped unless `MW_LIVE=1`.
- One regression test per behaviour change, in the style of `test/helpers.ts`.
- Messages to people are plain, complete sentences that say what happened and what to do next.
- Never commit a secret, and never print one: name the environment variable that holds it.

## Pull requests

- Keep a pull request to one change. Say what it does and how you checked it.
- `npm run typecheck` and `npm test` must pass. CI runs both on Linux and macOS.
- By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
