# MergeWright

MergeWright runs a team of AI coding agents through a fixed, checkable process. Every piece of work
is a card. A card is briefed, implemented on its own branch, checked by the project's own gate,
reviewed by a model from a different vendor, adjudicated when the review found problems, merged,
and remembered.

Use it when running one agent CLI by hand stops being enough: when you want the agent's work
scoped, gated and reviewed by another model before it reaches your main branch, and want the next
card to start from what the last one learned.

It is a framework in the sense that a web framework is one: fixed conventions, where the place and
the format of a file carry meaning, and a runtime (`mw`) that reads those files and acts on them.
It standardises the development process (specs, cards, roles, flows, gates, memory, documentation),
not the product: product code can be in any language and any layout.

```
card -> brief -> implement -> gate -> review -> adjudicate -> merge -> reflect -> docs sync
        planner   worker      gate.sh  reviewers adjudicator   mw       reflector   mw
```

The complete reference is [docs/specification.md](docs/specification.md).

## The idea

- **The model advises; the runtime acts.** Agents return files in defined formats: a brief, a
  handoff, review findings, an adjudication, a reflection. Only `mw` commits, merges, pushes,
  changes cards and memory, and sends notifications. No agent holds a merge token, and every path
  a writing agent touched is checked against its card's scope.
- **Different vendors check each other.** In the shipped preset, Claude implements and OpenAI's
  Codex models review, so one model's blind spots are not repeated by its reviewer.
- **The project's own gate decides.** One executable per project, in any language, with one
  contract: exit 0 when every check passes. Nothing merges past a failing gate, and when the base
  branch moved since the gate ran, the gate runs again on the merged tree before anything lands.
- **Memory is files.** Current state, standing rules, lessons, decisions and card outcomes are
  markdown in the repository. A small part is in every prompt; the rest is searched on demand. A
  reflection after every card keeps it current.
- **Documentation stays true.** The brief names the documents a card must update, and the reviewer
  checks they were updated.
- **The core runs alone.** One machine, git and one agent CLI are enough. Services such as a memory
  server or a kanban board are optional [packages](#packages).

## Install

| Way | Command | Good for |
|---|---|---|
| Released single executable | download [`scripts/install-binary.sh`](scripts/install-binary.sh), read it, run `sh install-binary.sh` | A machine without Node (Linux x64 and arm64, Apple-silicon macOS) |
| From a checkout | `git clone https://github.com/manxzo/mergewright && mergewright/scripts/install.sh` | A machine with Node 24 and git |
| npm package | `npm run build && npm pack`, then `npm i -g mergewright-0.1.0.tgz` | Any machine with Node 24 |
| Build the executable yourself | `scripts/build-binary.sh` makes `build/mw-<platform>-<arch>` (about 120 MB) and `build/SHA256SUMS` | Handing `mw` to a machine of the same platform |

The installer checks the download against the release's checksums. `mw version` says which build is
running. What `mw` needs, running it as a service, and how secrets are handled:
[docs/install.md](docs/install.md).

Running cards also needs the agent programs the roles use. The `standard` preset uses the Claude
Code CLI (`claude`) and the Codex CLI (`codex`), each with its own login. `mw check`, `mw trace`,
the GUI and every other command work without them.

## Quick start

```bash
mkdir greeter && cd greeter && git init -b main
mw init --name greeter --prefix GR
```

`mw init` makes any repository a MergeWright project. It never overwrites a file and assumes
nothing about the language. Make `gates/default.gate.sh` run your real checks (as shipped it detects
common stacks). Then write a spec, `specs/greeting.spec.md`:

```markdown
---
id: greeting
title: Greeting
status: accepted
---

### REQ-greeting-001 Greet the user by name
- priority: must
- AC-1: Given a name, when the greeting is requested, then the reply contains that name.
```

Create a card that implements it, and check the project:

```bash
mw card new --title "Greet the user by name" --implements REQ-greeting-001 \
  --scope "src/**,tests/**" --why "The product's first feature." --out-of-scope "None"
mw card lint GR-1   # says whether the card is ready to run, and why not
mw check            # ok: the project conforms to MergeWright 0.1
mw trace            # which requirement is planned, built and tested
```

Commit, then run the card:

```bash
git add -A && git commit -m "Start greeter"
mw run GR-1 --dry-run   # the phases, roles, models and prompt sizes; nothing is executed
mw run GR-1             # brief, implement, gate, review, merge, reflect
mw status
```

When the run is done, the change is one squash commit on `main`, the card file says
`status: done`, and `memory/` has been updated. A card of risk `high` or `critical` stops before
implementation and before merging; continue it with `mw approve GR-1 go` and later
`mw approve GR-1 merge`. When a card is blocked and you have fixed the cause,
`mw retry GR-1 [--from PHASE]` sends it back.

To try the interfaces without any agent CLI, `scripts/demo-project.sh <dir>` makes a small project
with cards in every state, run by a simulated agent.

## What a project looks like

```
<project>/
├── mergewright.yaml            the one config file
├── AGENTS.md                   what every agent reads first
├── specs/<id>.spec.md          requirements with stable ids and Given/when/then criteria
├── cards/<ID>.card.md          units of work: requirements, scope, risk
├── roles/ flows/ gates/ mcps/  overrides and additions to the preset
├── memory/
│   ├── STATE.md                always loaded: where the project is now
│   ├── RULES.md                always loaded: standing rules
│   ├── INDEX.md                always loaded: generated index of the folders below
│   └── lessons/ decisions/ outcomes/
├── docs/
└── .mergewright/               runtime working data: runs, worktrees, queue, packages (git-ignored)
```

## Four ways in

All four act through the same operations, so they always agree.

**The command line.** `mw help` lists every command. Beyond the quick start:

- `mw work --watch` runs every ready card whose dependencies are done, one after another, and waits
  for more. `ops/mw-work@.service` runs it as a systemd service. The unit has `KillMode=mixed`, so
  a stop or restart waits for the current card to finish; to stop at once, run
  `systemctl stop --no-block mw-work@<name>`, then
  `systemctl kill --kill-whom=main -s SIGINT mw-work@<name>`.
- `mw memory search <words>` and `mw docs search <words>` rank the memory files and the project's
  documentation by keyword. Neither needs a service.
- `mw doctor` shows what is configured and reachable on this machine.
- When a provider is overloaded, the run retries, then falls back to the role's `fallback_model`. A
  quota or session limit pauses the work until the reset time the provider states.

**The terminal UI.** `mw tui` shows the board, the approvals waiting for you and the packages, and
edits roles, models and configuration without touching YAML. It works at 80 columns.
[docs/tui.md](docs/tui.md)

**The GUI.**

```bash
mw ui              # prints a sign-in link for http://127.0.0.1:7341/ and opens it in the browser
mw ui --no-open    # only print the link
```

A board of the cards by status, live as runs move. On a card: set it ready, approve, retry, abort,
and read its run files (brief, handoff, review findings, adjudication, gate output). Also specs and
trace, one search box over memory and documentation, packages and settings. It listens on 127.0.0.1
only and needs the printed link, which holds a per-start token.

**Assistants and other MCP clients.** `mw mcp serve` is an MCP server (stdio) that gives an
assistant the whole workflow as `mw_*` tools, plus those of the enabled packages. Register it with
`<client> mcp add mergewright -- mw mcp serve --project /path/to/project`.

## Packages

Service integrations and other add-ons are packages: a folder with a `mergewright-package.yaml`
manifest and an ES module that provides any of memory recall and search, a memory store,
documentation sync, a card mirror, an agent harness, extra `mw` commands, MCP tools and
`mw doctor` checks.

```bash
mw add mem0                      # an official package, shipped with the runtime; asks before installing
mw add ./my-package --yes        # a package folder; --yes answers the question for you
mw config set packages.mem0.url http://localhost:8888
mw packages                      # what is installed and enabled, and whether it loaded
mw remove mem0
```

`mw add` shows what the package provides and reads before it asks, because a package runs with your
rights whenever MergeWright loads it. It copies the package to `.mergewright/packages/<name>/` and
enables it under `packages.<name>` in `mergewright.yaml`, which also holds its settings.

The official packages, in `packages/` and embedded in the executable:

| Package | What it adds | Checked against |
|---|---|---|
| `mem0` | Lessons and decisions in a self-hosted mem0 server, searched by meaning | A fake server in the tests |
| `letta` | The same lessons in a Letta server's archival memory, one agent per project | A fake server in the tests |
| `open-notebook` | Documentation mirrored to an [Open Notebook](https://github.com/lfnovo/open-notebook) notebook, with search and `ask` | A fake server in the tests |
| `notebook-opennotelm` | Documentation mirrored to an [OpenNoteLM](https://github.com/daozen/opennotelm) notebook | A fake server; written from the OpenNoteLM source, not yet run against a live instance |
| `cline-kanban` | Each card's live status on a Cline Kanban board | A fake `kanban` program in the tests |
| `board-4ga` | Each card's live status on a [4ga Boards](https://github.com/RARgames/4gaBoards) board | A fake server; written from the 4ga Boards source, not yet run against a live instance |
| `hermes` | The Hermes agent as a harness a role can name, and `mw hermes init` to give Hermes the MCP server | A fake `hermes` program in the tests |

Each package's settings are in its manifest and listed in section 15 of the specification. Secrets
never go in the repository: a package names the environment variable that holds one, and the value
goes in `~/.config/mergewright/env` on each machine.

The package API is experimental and versioned by `apiVersion` in the manifest (now 1): it may
change in any release. How to write a package: [docs/packages.md](docs/packages.md).

## Status

Version 0.1. "Built" means implemented and covered by the test suite. Tests that need a real
service or a real agent CLI are skipped unless `MW_LIVE=1`.

| Part | State |
|---|---|
| Conventions, parsers and schemas for every file type; `mw check`, `mw trace` | Built |
| Flow engine: run, approve, abort, retry, status; stop points, remediation, scope checks, squash merge, crash-safe resume | Built, and run end to end with real Claude Code and Codex agents |
| Unattended work: `mw work` and the systemd service | Built |
| Harnesses: `claude`, `codex`, `local` (an OpenAI-compatible endpoint), `shell`, `mock` | Built, tested with simulated programs |
| Two machines sharing one project through a git hub: `mw sync`, `mw lease` | Built, tested with real git repositories |
| Packages and the seven official ones | Built, tested against fake servers and programs; the API may change |
| Terminal UI: `mw tui` | Built, tested without a real terminal and tried by hand at 80 columns |
| GUI: `mw ui` | Built; the server and its security checks are tested; the page was checked by hand in one browser, with no automated browser test and no screen-reader check |
| Notifications, usage guard, Gitea and GitHub merge | Built, tested against simulated programs and servers only |
| Single executable | Built by the release workflow for Linux x64, Linux arm64 and Apple-silicon macOS, each tested on a machine without Node |
| macOS | The test suite and the executable pass on GitHub's macOS runner; not yet used with real agent CLIs there. Unattended work as a service is Linux-only (systemd) |
| Windows | Not supported |

## Running the tests

```bash
npm ci
npm test            # all tests, one dot each
npm run typecheck   # TypeScript, no output files
```

The tests create throwaway git repositories in the system temporary directory and need only git
and Node 24. Agents are simulated by the `mock` and `shell` harnesses, so no model is called.

## Repository layout

```
bin/mw.js                 the command; runs src/ directly from a checkout
src/                      the runtime (TypeScript, run directly by Node 24)
  model/                  parsers for specs, cards, roles, flows and MCP servers
  engine/                 the run loop, harnesses, gates, git operations
  integrations/           forge, notifications, usage guard, delivery queue
  packages/               the package mechanism and the host API (api.ts)
  mcpserver/              the tool layer shared by the MCP server, the GUI and the terminal UI
  tui/  ui/               the terminal UI and the GUI (plain HTML, CSS and ES modules)
packages/                 the official packages
schemas/                  JSON Schemas for every file type and every role output
presets/standard/         the shipped roles, flows and gates
template/                 what `mw init` writes into a project
scripts/                  install, build, service and demo scripts
test/                     the test suite
docs/                     the specification, install guide, package guide and design notes
```

This repository is itself a MergeWright project: its own `mergewright.yaml`, `specs/`, `cards/`,
`memory/` and `gates/` are at the root.

## License

MIT. See [LICENSE](LICENSE).
