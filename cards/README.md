# Cards

One file per unit of work, named `<ID>.card.md`. Create them with `mw card new`.

```markdown
---
id: MW-1
title: Sign in with email and password
kind: feature             # feature | fix | chore | docs | spike
status: todo              # todo | ready | in_progress | review | blocked | done
implements: [REQ-auth-001]
risk: medium
scope: [src/auth/**, tests/auth/**]
---
## Why
## Out of scope
```

Run a card with `mw run <ID>`.
