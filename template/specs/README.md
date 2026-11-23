# Specs

One file per area, named `<id>.spec.md`. Requirements have stable ids and fixed-form criteria:

```markdown
---
id: auth
title: Authentication
status: accepted          # draft | accepted | deprecated
---
### REQ-auth-001 Sign in with email and password
- priority: must          # must | should | could
- AC-1: Given a registered user, when they submit valid credentials, then a session starts.
```

Specs are protected. To change one, write a proposal with `mw spec propose` and apply it with
`mw spec accept`; that bumps the requirement's revision and flags the cards written against the
old one.
