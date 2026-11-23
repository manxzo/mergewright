# __PROJECT__

This repository is a **MergeWright** project. Every agent that works here, whatever its vendor or
role, starts by reading this file.

## Read first, in this order

1. `memory/STATE.md`: where the project is right now.
2. `memory/RULES.md`: standing rules for this project.
3. `memory/INDEX.md`: one line per lesson, decision and finished card. Open only what is relevant.
4. Your brief, if you were given one. The brief is the boundary of your work.

## Where things are

| Folder | Holds | File form |
|---|---|---|
| `specs/` | What the product must do: requirements with ids | `<id>.spec.md` |
| `cards/` | Units of work, each pointing at the requirements it implements | `<ID>.card.md` |
| `roles/` `flows/` `gates/` `mcps/` | Who does what, in which order, with which checks and tools | overrides of the preset |
| `memory/` | What the project knows about itself | changed only with `mw memory` |
| `docs/` | Decisions (`adr/`) and how-to guides (`guides/`) | markdown |

`mw check` validates all of it. `mw trace` shows requirement → card → test. `mw status` shows the cards.

## Rules for anyone changing files

- **Stay in scope.** Write only to the paths your card or brief lists. Specs, rules, roles, flows,
  gates and config are protected: propose a change (`mw spec propose`), do not edit them.
- **The gate decides.** `gates/default.gate.sh` must pass before a card is done. Never weaken or
  skip a check to make it pass; report the failure.
- **Link tests to requirements** with a comment: `@req REQ-<spec>-<nnn>`.
- **Update the documentation you invalidate** in the same card, and list it in your handoff.
- **No secrets** in the repository, in cards, in memory or in commit messages.
- **Stop and report** when the brief conflicts with a requirement, when the work needs something
  outside your scope, or when you are about to run out of budget. A clear block report is a good
  outcome; a guess is not.

## Project notes

<!-- Stack, how to run it locally, conventions. Keep this short; details belong in docs/guides/. -->
