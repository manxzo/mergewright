---
id: adjudication
title: Consistent adjudications
status: accepted
owner: maintainers
---

What an adjudication must say to be accepted (specification 8.3, Appendix B.4).

### REQ-adjudication-001 Finding ids must exist
- priority: must
- rev: 1
- AC-1: Given an adjudication whose `accepted` or `rejected` lists name a finding id the findings artifact does not contain, when it is validated, then it is invalid and the agent is asked once more with the error.
- AC-2: Given the retry is still invalid, when the phase ends, then its outcome is `fail` with the unknown ids in the detail.

### REQ-adjudication-002 Every blocking finding is decided
- priority: must
- rev: 1
- AC-1: Given findings with blocking entries, when an adjudication leaves one of them in neither `accepted` nor `rejected`, then it is invalid and retried once, then `fail`.

### REQ-adjudication-003 Approve cannot accept a blocker
- priority: must
- rev: 1
- AC-1: Given an adjudication with decision `approve` that lists a blocking finding in `accepted`, when it is validated, then it is invalid, retried once, then the outcome is `fail`.
- AC-2: Given a stored approval that accepts a blocker, when `mergeEvidence()` checks it before the merge, then the merge is refused.
- AC-3: Given an approval that rejects every blocker with a reason, when it is validated, then the phase outcome is `ok`.

### REQ-adjudication-004 The adjudicator sees the diff
- priority: should
- rev: 1
- AC-1: Given the shipped adjudicator role, when its prompt is rendered, then it contains the card's diff against the base, clipped to `limits.diff_chars`.
