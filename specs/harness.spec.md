---
id: harness
title: Transient harness errors
status: accepted
owner: maintainers
---

What the runtime does when an agent CLI fails for a reason that is not the agent's work: the
provider is at capacity, rate-limits, answers with a server error or times out a request
(specification 8.3, 8.6). For example, a reviewer whose model is at capacity moves to the role's
alternate model rather than blocking the run.

### REQ-harness-001 Transient errors are recognised
- priority: must
- rev: 1
- AC-1: Given a Codex, Claude, Hermes or local harness failure whose error says the model is at capacity or overloaded ("Selected model is at capacity", `overloaded_error`), reports HTTP 429 or a 5xx status, or reports a provider request timeout or a reset connection, when the harness returns, then its result is marked transient.
- AC-2: Given a failure of any other kind (invalid or missing output, an authentication error, a missing CLI, a scope violation, or the runtime's own `limits.minutes` kill), when the harness returns, then it is not marked transient.
- AC-3: Given the classification, when it is tested, then one table of patterns serves every harness and is checked against fixtures holding the real messages.

### REQ-harness-002 Transient errors are retried with backoff
- priority: must
- rev: 1
- AC-1: Given a role attempt that fails transiently, when the phase runs, then the same model is tried again after a growing wait, up to `limits.transient_retries` times (default 2), and these attempts spend no remediation round and no schema retry.
- AC-2: Given a retry that succeeds, when the phase is recorded, then its usage sums every attempt and the history detail says how many transient retries it took.
- AC-3: Given the run is stopped or its lease is lost during a backoff wait, when the signal fires, then the wait ends at once and no further attempt starts.

### REQ-harness-003 The role's alternate model before the run blocks
- priority: must
- rev: 1
- AC-1: Given a role with an alternate model (`fallback_model` in the role file or in `roles.<id>` of `mergewright.yaml`, such as the reviewer's `gpt-5.6-terra` with `gpt-5.6-sol`), when its retries are exhausted on transient errors, then the role runs once more on the alternate model and the phase record names the model that answered.
- AC-2: Given a role with no alternate model, or whose alternate also fails transiently, when the retries are exhausted, then the phase blocks with `harness/transient`, naming each model tried and the last error, and no remediation round is spent.
- AC-3: Given `mw_delegate` with a role that has an alternate model, when the role fails transiently, then it retries and falls back the same way.
- AC-4: Given the shipped `reviewer` role, when its file is read, then it names an alternate model on the same harness.
