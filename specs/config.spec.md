---
id: config
title: Runnable configuration
status: accepted
owner: maintainers
---

When the runtime may act on `mergewright.yaml` (specification 3, 7.5).

### REQ-config-001 Writing commands refuse an invalid configuration
- priority: must
- rev: 1
- AC-1: Given a `mergewright.yaml` that fails its schema, when `mw run`, `mw work` or `start()` is called, then it refuses with `config/invalid` listing the errors and starts no phase.
- AC-2: Given such a configuration, when a writing MCP tool such as `mw_card_new` or a committing command runs, then it refuses with `config/invalid` and writes and commits nothing.
- AC-3: Given such a configuration, when the refusal is printed, then it names each schema error with its key path.

### REQ-config-002 Read-only commands still answer
- priority: must
- rev: 1
- AC-1: Given an invalid configuration, when `mw check`, `mw doctor` or `mw status` run, then they answer using the tolerant load and report the configuration errors.

### REQ-config-003 No silent fallback for safety settings
- priority: must
- rev: 1
- AC-1: Given a typo in an unrelated key such as `limits.turns`, when the project loads, then `git.hub` and `agents.sandbox` are never silently replaced by their defaults for a run, because the run is refused.
- AC-2: Given a valid configuration, when `project.assertRunnable()` is called, then it returns without error.
