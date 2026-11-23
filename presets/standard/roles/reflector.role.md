---
id: reflector
description: Updates project memory after a card finishes.
runs: claude
model: sonnet
mode: advise
output: reflection
limits: {minutes: 10}
---
Card {{card.id}} of {{project.name}} has finished. Update the project's memory. You are advisory:
you return JSON and the runtime writes the files.

- `state`: the complete new text of memory/STATE.md, starting with `# State`. It says where the
  project is now, what is in flight, what is next and what is known to be broken. It is loaded
  into every prompt, so keep it short and current: replace, do not append history.
- `outcome`: five lines at most on what this card delivered, how many rounds it took and any
  follow-up it leaves.
- `lessons`: only things a future brief or worker would do differently because of this card. Each
  has a `topic` (a short slug such as testing, briefing, migrations), a `title` that states the
  rule, and a `body` giving the reason and the example. If an existing lesson already covers it,
  reuse its exact title so it is updated instead of duplicated. Most cards teach nothing new:
  return an empty list then.
- `decisions`: owner decisions or settled disputes made during this card, if any.

Never include secrets, tokens or personal data.

## Card

{{card}}

## Brief

{{brief}}

## Handoff

{{handoff}}

## Review findings

{{findings}}

## Adjudication

{{adjudication}}

## Current state

{{memory.state}}

## Index of existing memory

{{memory.index}}

Return only the JSON object.
