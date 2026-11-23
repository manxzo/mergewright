---
id: cards
title: Card lint and readiness admission
status: accepted
owner: maintainers
---

What makes a card ready to run (specification 4.2).

### REQ-cards-001 Card lint codes
- priority: must
- rev: 1
- AC-1: Given a card whose `## Out of scope` still holds the scaffold text `mw card new` wrote, when `mw card lint <ID>` runs, then it reports `lint/placeholder`; an explicit `None` passes.
- AC-2: Given a card with an empty `## Why`, no acceptance criteria and no linked requirement, or an empty scope, when it is linted, then it reports `lint/why-empty`, `lint/no-acceptance` and `lint/scope-empty` respectively.
- AC-3: Given a card whose `## Acceptance` or `docs` names a path no scope glob covers, when it is linted, then it reports `lint/output-outside-scope` naming the path.
- AC-4: Given a card that depends on a card not `done`, or implements a requirement whose revision moved, when it is linted, then it reports `lint/depends-open` or `lint/stale`.

### REQ-cards-002 Lint is available from the CLI and the MCP server alike
- priority: must
- rev: 1
- AC-1: Given any card, when `mw card lint <ID> --json` and the read-only MCP tool `mw_card_lint` are called, then both return the same list of codes and messages.
- AC-2: Given a card with lint errors, when `mw card lint <ID>` runs, then it exits non-zero and writes nothing.

### REQ-cards-003 Only lint-clean cards become ready
- priority: must
- rev: 1
- AC-1: Given a card with a lint error, when `mw card status <ID> ready`, `mw_card_set_status` or `mw card new --status ready` is used, then the change is refused with the lint codes and no file or commit is written.
- AC-2: Given a `ready` card that has since gained a lint error, when a fresh run starts, then `start()` refuses it before any phase runs.

### REQ-cards-004 Card creation fills the sections lint checks
- priority: should
- rev: 1
- AC-1: Given `mw card new` with `--out-of-scope` and `--acceptance`, when the card is written, then those sections hold the given text instead of the scaffold.
- AC-2: Given a feature card created through `mw_card_new` with no requirement while `trace.require_implements` is true, when the tool runs, then it is refused as the CLI refuses it.

### REQ-cards-005 A card's scope can be widened from a handoff without a wasted round
- priority: must
- rev: 1
- AC-1: Given a planner or worker handoff, when it needs paths outside the card's scope, then the handoff carries them in a structured `needs_scope` list (globs with a one-line reason each) and the run's `blocked` reason, `mw status` and the `mw work` journal print them with the remedy.
- AC-2: Given `mw card scope add <ID> <glob>...`, when it runs, then the globs are added to the card file (refusing protected paths unless `allow_protected` grants them), the card is linted, and the command prints the retry to run.
- AC-3: Given `cards.scope_widening: planner` in the project config (default `ask`), when the planner's brief carries `needs_scope` whose globs lie under the card's existing top-level directories and are not protected, then the runtime widens the card itself, records it in the run and the card's Notes, and continues to implement without stopping.

### REQ-cards-006 Card status changes can be committed in the same step
- priority: should
- rev: 1
- AC-1: Given `mw card status <ID> ready --commit` (also `todo`, and `mw card new --commit`), when it runs, then the card file is committed on the base branch with the runtime's own message and, when the project has a hub, pushed with the usual fence; without `--commit` the behaviour is today's.
