---
id: usage
title: Usage accounting and spend caps
status: accepted
owner: maintainers
---

What the runtime records about agent usage and how it bounds spend (specification 8.1, 10.7).

### REQ-usage-001 Usage split into fresh, cache-write and cache-read input
- priority: must
- rev: 1
- AC-1: Given a Claude result reporting `input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`, when the harness parses it, then `Usage` carries `freshInputTokens`, `cacheWriteTokens` and `cacheReadTokens` with those values and `inputTokens` stays their sum.
- AC-2: Given a Claude result reporting `num_turns`, when the harness parses it, then `Usage.turns` holds that number.
- AC-3: Given a harness that reports only a total input count, when its usage is stored, then the split fields are absent rather than zero.

### REQ-usage-002 Reports show the split
- priority: must
- rev: 1
- AC-1: Given a run whose phases reported split usage, when `usageTotals()` sums them, then the totals carry fresh, cache-write, cache-read and turns per harness next to the input sum.
- AC-2: Given such a run, when `mw status <ID> --json` and the MCP run status are read, then they include the split fields.
- AC-3: Given such a run, when `mw status <ID>` prints its usage line, then it shows cached and fresh input separately.

### REQ-usage-003 A failed usage reading keeps a pause
- priority: should
- rev: 1
- AC-1: Given the usage guard has paused new work, when the usage command fails or prints `max_used: null`, then the pause stays in place and the detail says the reading failed.
- AC-2: Given the guard is not paused, when the usage command fails, then work continues as specification 10.7 states.

### REQ-usage-004 Paid roles and delegation are guarded
- priority: should
- rev: 1
- AC-1: Given the usage guard is paused, when any role on a paid harness (not only write-mode roles) or `mw_delegate` is about to start, then it waits or is refused with reason `usage`.

### REQ-usage-005 Phase-visit limit
- priority: should
- rev: 1
- AC-1: Given `limits.phase_visits` (default 6), when a run enters the same phase more often than that through named backward routes, then the run blocks naming the phase and the count.
