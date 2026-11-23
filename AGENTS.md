# MergeWright

This repository is MergeWright itself: a language- and codebase-agnostic framework for building
software with a team of AI agents. It is also a MergeWright project, so it follows its own
conventions. Every agent that works here starts by reading this file.

## Read first, in this order

1. `memory/STATE.md`: where the project is right now and what is next.
2. `memory/RULES.md`: standing rules for this repository.
3. `docs/specification.md`: what MergeWright is and how every file type works.
4. `docs/design/engine.md`: the design of the flow engine, the hub and the integrations.
5. Your card or brief, if you were given one. It is the boundary of your work.

## Layout of this repository

| Path | Holds |
|---|---|
| `src/` | The runtime (`mw`), TypeScript run directly by Node 24 |
| `schemas/` | JSON Schemas for every file type and role output |
| `presets/standard/` | Roles, flows and gates that ship with the framework |
| `packages/` | Official packages (`mem0`, `letta`, `open-notebook`, `cline-kanban`, `hermes`, `board-4ga`, `notebook-opennotelm`), installed into a project with `mw add`; the API is `src/packages/api.ts` |
| `template/` | What `mw init` writes into a new project |
| `test/` | The test suite (`node:test`), hermetic: temp directories, no network |
| `docs/` | Specification and design |
| `specs/ cards/ roles/ flows/ gates/ mcps/ memory/` | This repository as a MergeWright project |

## Checks

Run the checks before you say something works: `npm ci` (once), then `npx tsc --noEmit` and
`npm test`. The gate (`gates/default.gate.sh`) runs, in order: `install` (`npm ci --prefer-offline`,
only when `node_modules` is missing, as in a fresh card worktree), `typecheck` (`npx tsc --noEmit`),
`test` (`node --test --test-reporter=dot 'test/**/*.test.ts'` with `MW_DELEGATE_ALLOW_MOCK=1`; it
records pass/fail/skip counts), `scripts` (`bash -n scripts/*.sh`, and `sh -n scripts/install-binary.sh`) and `build` (`npm run build`).
`typecheck` and `test` are `gate.required`: a missing, skipped or failed one blocks the merge. The
full suite takes about 30-90 s.

## Coding rules

- **TypeScript is erasable-syntax-only**: no enums, no parameter properties, no namespaces; imports
  use the `.ts` extension; type-only imports use `import type`. There is no build step in a checkout.
- **No new npm dependencies** without a recorded decision (`mw memory add decision`).
- **Tests are hermetic.** Anything that needs a real service or a real agent CLI is skipped unless
  `MW_LIVE=1`, and says so.
- **One regression test per behaviour change**, written in the style of `test/helpers.ts`
  (`newProject()`, `write()`, `mw()`, temp directories, no network).
- **Requirement tests live in `test/req/`.** A test that proves a requirement carries
  `// @req REQ-<spec>-<nnn>` and goes in `test/req/<spec>.test.ts`. `@req` comments anywhere else
  in `test/`, in `src/`, fixtures, presets, schemas and the template are examples and are not
  counted (`trace.ignore` in `mergewright.yaml`). Specs are in `specs/`.
- **Messages to people are plain, complete sentences** that say what happened and what to do next.
- **No secrets** in the repository, in cards, in memory or in commit messages. Never print, log or
  commit a secret value (name the `*_env` variable instead).

## Rules for anyone changing files

- Stay inside your card's scope. Specs, rules, roles, flows, gates and config are protected:
  propose a change, do not edit them.
- The gate decides. Never weaken or skip a check to make it pass; report the failure.
- **The specification moves with the behaviour.** When a change alters behaviour that
  `docs/specification.md` or `README.md` describes, update them in the same card. The
  specification is protected: the card needs `allow_protected: [docs/specification.md]` from the
  owner. Without that grant, name the sections that must change in your handoff instead.
- **One writer per worktree.** Only the runtime's agent writes a card's worktree; other agents only
  read and review; separate work is a separate card. Never use `git stash`, `git reset` or
  `git checkout` to move work around.
- Stop and report when a brief conflicts with the specification, when the work needs something
  outside your scope, or when you are about to run out of budget.
