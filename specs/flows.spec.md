---
id: flows
title: Stop points every flow keeps
status: accepted
owner: maintainers
---

What a card's risk means whatever flow it runs (specification 4.4, 8.5).

### REQ-flows-001 Minimum stops by risk
- priority: must
- rev: 1
- AC-1: Given a card of risk `high` or `critical` on a flow that declares no `go` stop (the shipped `docs` or `spike` flow), when the run reaches the first phase whose role writes (`mode: write`), then it waits for `go` before that phase.
- AC-2: Given such a card on a flow whose merge phase declares no `merge` stop, when the run reaches the merge phase, then it waits for `merge`, after the `conditions` stop when that one is due.
- AC-3: Given a card of risk `low` or `medium`, when it runs the `docs` or `spike` flow, then the runtime adds no stop.
- AC-4: Given a flow that already declares these stops (the shipped `standard` and `quick` flows), when a high-risk card runs, then it waits once for each word as today; a flow can add stops but never remove the ones the runtime adds.

### REQ-flows-002 The runtime's stops are shown before the run
- priority: should
- rev: 1
- AC-1: Given a high-risk card on the `docs` flow, when `mw run <ID> --dry-run` prints the plan, then it lists the `go` and `merge` stops the runtime adds and says they come from the card's risk.
- AC-2: Given the specification's section 8.5, when this behaviour ships, then it says that a `high` or `critical` card waits for `go` and `merge` in every flow, not only in the shipped `standard` and `quick` flows.
