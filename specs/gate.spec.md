---
id: gate
title: Gate evidence and required steps
status: accepted
owner: maintainers
---

How the runtime turns a gate's exit code and JSON summary into the evidence a card merges on
(specification 4.6 and 8.3).

### REQ-gate-001 Required steps must be present and pass
- priority: must
- rev: 1
- AC-1: Given `gate.required` names a step, when the gate exits 0 and its JSON has no step of that name, then the gate fails with `gate/required-missing` and the phase outcome is `block` with no remediation round spent.
- AC-2: Given `gate.required` names a step, when the JSON lists that step twice, then the gate fails with `gate/required-missing` naming the duplicate.
- AC-3: Given `gate.required` names a step, when the gate exits 0 and that step reports `ok: false`, then the gate fails and the detail names the step.
- AC-4: Given `gate.required` names a step reported `skipped`, when the gate finishes, then the outcome stays `block` with `gate/required-skipped` as today.

### REQ-gate-002 Missing or malformed gate JSON fails closed when steps are required
- priority: must
- rev: 1
- AC-1: Given a non-empty `gate.required`, when the gate exits 0 and writes no JSON, then the gate fails with `gate/required-missing` instead of a synthetic passing step.
- AC-2: Given a non-empty `gate.required`, when the gate exits 0 and writes JSON that does not parse or lacks a `steps` list, then the gate fails and the detail says the summary is malformed.
- AC-3: Given an empty `gate.required`, when the gate writes no JSON, then the exit code alone decides, as specification 4.6 states.

### REQ-gate-003 Well-formed steps
- priority: should
- rev: 1
- AC-1: Given a gate JSON step without a string `name` or a boolean `ok`, when the runtime reads the summary, then that step is reported as malformed in the gate's warnings and does not satisfy a required step.
- AC-2: Given a step with an optional `tests` object of counts, when the runtime stores the gate artifact, then the counts are kept unchanged.

### REQ-gate-004 The tree that lands is the tree that was gated
- priority: should
- rev: 1
- AC-1: Given a gate artifact that records its base commit, when the base moved before the merge and the squash tree differs from the card branch tree, then the gate runs again on the squash tree in a temporary worktree before merging.
- AC-2: Given the re-run gate fails, when the merge is attempted, then the card does not merge and the run remediates with the reason "rebuild on the new base".
- AC-3: Given the base did not move, when the card merges, then the gate is not run again.

### REQ-gate-005 Gate requirements are checked before a card is taken
- priority: must
- rev: 1
- AC-1: Given `gate.requires` in `mergewright.yaml` (a list of entries, each a command name, an `env:NAME`, or a `path:/abs/or/~/path`), when `mw doctor` runs, then it reports every entry as present or missing with the reason.
- AC-2: Given a missing entry, when `mw work` or `mw run` would start a card, then no phase runs: the card is reported as not eligible with the missing entries and the remedy, and `mw work --dry-run` shows the same.
- AC-3: Given a project without `gate.requires`, when it runs, then nothing changes.

### REQ-gate-006 A failed test step is triaged before a remediation round is spent
- priority: should
- rev: 1
- AC-1: Given a gate test step that fails, when the runtime can parse the failing test identifiers from the step log (pytest, vitest and node:test formats), then it re-runs that step once; if the step passes, the gate continues and the run records a `flaky` warning naming the tests.
- AC-2: Given the step fails again, when the failing tests also fail on the card's base commit (run in a scratch worktree of the base, same gate step, same environment), then the run is `blocked` with `gate/pre-existing-failure` naming the tests and a suggested follow-up card, and no remediation round is charged to the card.
- AC-3: Given the failing tests pass on the base, when the gate fails, then the remediation round proceeds as today, and its prompt names the failing tests.
- AC-4: Given `gate.triage: off`, when a test step fails, then the behaviour is exactly today's.
