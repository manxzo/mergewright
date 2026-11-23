# MergeWright Specification 0.1

This document defines what a MergeWright project is: which files it contains, where they live,
what each field means, and what the `mw` runtime does with them. It is written so that a person
or an agent can build a conforming project without reading the runtime's source code.

Status of this document: it describes specification version `0.1`, and everything in it is
implemented and tested unless a sentence says otherwise. Where an integration has been tested only
against a simulated service, section 10 says so.

## Contents

1. [Purpose, principles and conformance](#1-purpose-principles-and-conformance)
2. [Project layout](#2-project-layout)
3. [The configuration file: `mergewright.yaml`](#3-the-configuration-file-mergewrightyaml)
4. [File types](#4-file-types)
   1. [Specs](#41-specs)
   2. [Cards](#42-cards)
   3. [Roles](#43-roles)
   4. [Flows](#44-flows)
   5. [The condition language](#45-the-condition-language)
   6. [Gates](#46-gates)
   7. [MCP servers](#47-mcp-servers)
5. [Presets](#5-presets)
6. [Tracing](#6-tracing)
7. [Managed updates](#7-managed-updates)
8. [Running a card](#8-running-a-card)
9. [Two machines, one repository state](#9-two-machines-one-repository-state)
10. [Integrations](#10-integrations)
11. [Command reference](#11-command-reference)
12. [The MCP server](#12-the-mcp-server)
13. [The terminal UI](#13-the-terminal-ui)
14. [Installing](#14-installing)
15. [Packages](#15-packages)
16. [The GUI: `mw ui`](#16-the-gui-mw-ui)
- [Appendix A: Diagnostic codes](#appendix-a-diagnostic-codes)
- [Appendix B: Role output schemas](#appendix-b-role-output-schemas)
- [Appendix C: Versioning and `mw upgrade`](#appendix-c-versioning-and-mw-upgrade)

## Terms

| Term | Meaning |
|---|---|
| Project | A folder (normally a git repository) with a `mergewright.yaml` file at its root. |
| Owner | The person responsible for the project. The owner accepts spec changes, answers stop points and controls protected files. |
| Agent | An AI model session started by the runtime to perform one role in one phase. |
| Runtime | The `mw` command. It reads the project's files, validates them, and performs every side effect (commits, merges, memory and card changes, notifications). |
| Spec | A file of requirements for one area of the product (`specs/<id>.spec.md`). |
| Requirement | One numbered statement of what the product must do, with acceptance criteria. Its id looks like `REQ-auth-001`. |
| Card | One unit of work (`cards/<ID>.card.md`). A card usually implements one or more requirements. |
| Role | A kind of agent: which tool runs it, which model, what it may do, what it must return, and its prompt (`roles/<id>.role.md`). |
| Harness | The program that runs a role's agent, for example the Claude Code CLI or the Codex CLI. A role names its harness in `runs:`. |
| Flow | An ordered list of phases that a card goes through (`flows/<id>.flow.yaml`). |
| Phase | One step of a flow: a role, a gate, an action, or a role followed by an action. |
| Gate | An executable that runs the project's own checks and reports pass or fail (`gates/<id>.gate.sh`). |
| Artifact | A JSON file a phase produces: brief, handoff, findings, adjudication, reflection, or gate result. |
| Preset | A named, shipped set of roles, flows and gates that a project inherits. The only preset in 0.1 is `standard`. |
| Base branch | The branch that cards merge into (`git.base`, normally `main`). |
| Hub | A git remote that carries history between two machines that share working files (section 9). |
| Protected path | A path an agent may not change unless its card grants it (`protected` in the config). |

## 1. Purpose, principles and conformance

### 1.1 Purpose

MergeWright is a framework for building software with a team of AI agents. It is a framework in
the sense that a web framework is one: it fixes conventions, where the location and the format of
a file carry meaning, and it ships a runtime that reads those files and acts on them.

MergeWright standardises the development process, not the product. It defines how requirements,
units of work, agent roles, pipelines, quality checks, tool servers, project memory and
documentation are written down and connected. It says nothing about the product's language,
framework or source layout: product code lives wherever the project wants it, and the only
contact between the two is the gate (section 4.6), the `scope` of a card (section 4.2) and the
`@req` comments in tests (section 6).

Every piece of work is a card. A card is briefed, implemented in its own branch, checked by the
project's gate, reviewed independently, adjudicated when the review found problems, merged, and
remembered.

### 1.2 Principles

These five principles decide every rule in this document.

1. **The model advises; the runtime acts.** Agents produce files in defined formats: a brief, a
   handoff, findings, an adjudication, a reflection. Only the runtime performs side effects:
   it commits, merges, pushes, edits cards and memory, and sends notifications. No agent holds a
   merge token. An agent that can write files writes them only in its card's worktree, and the
   runtime checks every path it touched against the card's scope afterwards.
2. **Different vendors check each other.** The agent that implements a card and the agents that
   review it should come from different model vendors, so that one model's blind spots are not
   repeated by its reviewer. The `standard` preset implements with Claude and reviews with
   OpenAI's Codex models.
3. **The project's own gate decides.** Whether a change is good enough to merge is decided by an
   executable the project owns and can read, not by an agent's opinion. A review can block a
   merge; nothing can merge a change that fails the gate.
4. **Memory is files.** What the project knows about itself (current state, standing rules,
   lessons, decisions, outcomes of finished cards) is kept as markdown in the repository, under
   version control, changed only through defined operations. A small part is loaded into every
   prompt; the rest is read on demand. External memory services are optional mirrors.
5. **Documentation stays true.** Keeping documentation current does not depend on anyone
   remembering. The brief names the documents a card must update, the reviewer checks that they
   were updated, and the runtime synchronises the merged documents to the documentation service.

### 1.3 Conformance

A project conforms to this specification when `mw check`, run anywhere inside the project,
reports no errors. Warnings do not affect conformance unless `mw check --strict` is used, which
counts every warning as an error.

`mw check` validates every file whose place and name give it meaning (sections 2 to 4), the
references between files (a card's requirements, a flow's roles and gates, a role's MCP servers),
the memory files (section 7.2), the trace (section 6) and every proposed spec change (section 7.3).
Every problem it can report has a stable code, listed in Appendix A.

## 2. Project layout

### 2.1 The root

A project is the folder that contains `mergewright.yaml`. The runtime finds it by walking up from
the current directory, so every `mw` command works from any subfolder.

```
<project>/
├── mergewright.yaml                 configuration (section 3)
├── AGENTS.md                        the file every agent reads first
├── CLAUDE.md                        "@AGENTS.md", so Claude Code reads the same file
├── specs/
│   ├── <id>.spec.md                 requirements (section 4.1)
│   └── changes/
│       └── CHG-<n>-<slug>.change.md proposed spec changes (section 7.3)
├── cards/
│   └── <PREFIX>-<n>.card.md         units of work (section 4.2)
├── roles/<id>.role.md               project roles; override the preset (section 4.3)
├── flows/<id>.flow.yaml             project flows; override the preset (section 4.4)
├── gates/<id>.gate.sh               project gates; override the preset (section 4.6)
├── mcps/<id>.mcp.yaml               MCP servers offered to roles (section 4.7)
├── memory/                          project memory (section 7.2)
│   ├── STATE.md                     always loaded: where the project is now
│   ├── RULES.md                     always loaded: standing rules (owner-controlled)
│   ├── INDEX.md                     always loaded: generated index of the folders below
│   ├── lessons/<topic>.md
│   ├── decisions/<date>-<slug>.md
│   └── outcomes/<CARD>.md
├── docs/
│   ├── adr/                         architecture decision records
│   └── guides/                      how to run, test, deploy and operate the product
├── .mergewright/                    runtime working data, never committed (section 2.4)
└── ...                              the product's own source, in any layout
```

### 2.2 Reserved folders

The following top-level folders are reserved: their contents are defined by this specification.
Product code must not live in them, and `@req` comments inside them are not counted by the trace
(section 6).

| Folder | Holds | File name form |
|---|---|---|
| `specs/` | Specs; proposals in `specs/changes/` | `<id>.spec.md`; `CHG-<n>-<slug>.change.md` |
| `cards/` | Cards | `<ID>.card.md` |
| `roles/` | Roles that add to or replace the preset's | `<id>.role.md` |
| `flows/` | Flows that add to or replace the preset's | `<id>.flow.yaml` |
| `gates/` | Gate executables | `<id>.gate.sh` |
| `mcps/` | MCP server definitions | `<id>.mcp.yaml` |
| `memory/` | Project memory | fixed names, see section 7.2 |
| `docs/` | Decision records and guides | free-form markdown |

Only files directly inside `specs/`, `cards/`, `roles/`, `flows/`, `gates/` and `mcps/` are read
(subfolders are not searched, except `specs/changes/`). In those six folders, and in
`specs/changes/` (`.change.md`), `memory/lessons/`, `memory/decisions/` and `memory/outcomes/`
(`.md`), a file whose name does not end with the folder's suffix is reported as a warning
(`layout/stray-file`) and ignored. `README.md` and `.gitkeep` are allowed in every reserved
folder.

### 2.3 Names

| Thing | Form | Rule |
|---|---|---|
| Spec, role, flow, MCP server, phase, gate id | `^[a-z][a-z0-9-]*$` | Lower case letters, digits and hyphens, starting with a letter. |
| Card id | `<PREFIX>-<n>`, matching `^[A-Z][A-Z0-9]{0,9}-[0-9]+$` | The prefix is `cards.prefix` from the config. Numbers are assigned in order by `mw card new`. |
| Requirement id | `REQ-<spec id>-<nnn>` | Three or more digits. The middle part must be the id of the spec that defines it. |
| Change id | `CHG-<n>` | Assigned in order by `mw spec propose`. |

A file's name must match the id inside it: the spec with `id: auth` is `specs/auth.spec.md`, the
card `SHOP-12` is `cards/SHOP-12.card.md`, the role `worker` is `roles/worker.role.md`, and so on.
A gate's id is its file name without `.gate.sh`.

### 2.4 What is committed

Everything in the project is committed to git except `.mergewright/` and the files a file-sync
tool leaves behind (section 9): hidden `.*.tmp` files (a file it is still copying; the runtime's
own atomic writes use the same form) and `*.sync-conflict-*` (the other machine's copy when both
changed a file). `mw init` adds the lines `.mergewright/`, `.*.tmp` and `*.sync-conflict-*` to
`.gitignore`. The runtime never commits such a file, whether or not `.gitignore` names them: the merge refuses (outcome `fail`) a card branch that
commits one, and the runtime's own commits (the work-in-progress commit at an abort, the reflect
phase's memory commit, the commits of the MCP tools that write, documentation writes) leave them
out. They are not counted either: not as project files (a conflict copy in `memory/lessons/` is not
a lesson), not as uncommitted changes of a worktree or of `memory/`, not by the scope check, and not
as stray files; `mw check` warns (`sync/temp-file`) for each one git tracks.

`.mergewright/` holds working data that belongs to one checkout and is never authoritative:

| Path | Content |
|---|---|
| `.mergewright/runs/<CARD>/` | The run state and artifacts of a card (section 8.1). Shared between machines (file-synced), so it is private (folders 0700, files 0600) and holds no secret value: streams, saved exchanges and gate logs are redacted before they are written (section 10.4). |
| `.mergewright/local/scratch/<CARD>/` | Files that hold resolved secrets or unredacted output for one phase, such as the `--mcp-config` file of a `claude` role (section 4.7), the reply file a `codex` agent writes (section 8.6) and the JSON summary and step logs a gate writes (`gate-<gate>/`, section 8.3): mode 0600 in a 0700 folder, removed when the phase ends. Never file-synced. |
| `.mergewright/worktrees/<CARD>/` | The git worktree in which a card's agents work on this machine (section 8.4). |
| `.mergewright/local/locks/<CARD>.lock` | This machine's lock on a card's run (section 8.7). |
| `.mergewright/local/locks/<CARD>.orphans` | Process groups a run of the card could not stop; the card does not run on this machine while any of their processes is alive (section 8.7). |
| `.mergewright/local/lease-seen.json` | When this machine first saw the other machine's current lease (section 9.3). |
| `.mergewright/local/queue/` | Requests to external services that could not be delivered yet (section 10). |
| `.mergewright/local/usage-paused` | Present while the usage guard holds new work back (section 10.7). |
| `.mergewright/local/usage-limits/<harness>/` | The reset times of quota or session limits a harness reported, one record file per report; the latest counts (section 8.3). |
| `.mergewright/local/tmp/` | Short-lived files, such as a notification body. |
| `.mergewright/local/delegate/<time>-<label>-<random>/` | The prompt, output schema and reply of one agent delegated through the MCP server (section 12.4). |
| `.mergewright/local/runs/<CARD>.log` | The output of a card run the MCP server started in the background (section 12.3). |
| `.mergewright/local/discarded/<CARD>-<UTC time>/` | Worktrees moved aside instead of being deleted, kept for seven days (section 8.4). |
| `.mergewright/gate.json` | Where a gate writes its result when run by hand, outside a card run. |

When two machines share the project's working files (section 9), `.mergewright/runs/` is the only
part of `.mergewright/` they share, so a second machine can continue a run. Everything that belongs
to one machine is under `.mergewright/local/`. Three paths are never file-synced: git metadata
(`.git`), card worktrees (`.mergewright/worktrees`) and `.mergewright/local`. Items an older
runtime left in the old shared `.mergewright/queue/` are not delivered from there and are not moved
automatically (both machines would deliver their copy): `mw doctor` reports them, and the owner runs
`mw queue adopt` on one machine. Other files an older runtime left directly under `.mergewright/`
are ignored.

### 2.5 AGENTS.md and CLAUDE.md

`AGENTS.md` is the entry point for every agent of any vendor. `mw init` writes a version that
tells agents to read `memory/STATE.md`, `memory/RULES.md` and `memory/INDEX.md` first, explains
the folders, and states the rules for changing files (stay in scope, the gate decides, link tests
to requirements, update the documentation you invalidate, no secrets, stop and report rather than
guess). The project adds its own notes at the end. A missing `AGENTS.md` is a warning
(`layout/agents`). `CLAUDE.md` contains the single line `@AGENTS.md`, which makes Claude Code load
the same file.

### 2.6 Shipped files outside the project

A project holds only its own files. The runtime brings everything else with it and finds it
through its package root, which is the checkout it runs from, the folder of the installed npm
package, or, for the single executable, the folder it unpacks its embedded files into on first use
(`~/.cache/mergewright/sea-<hash>/`, or under `MW_SEA_DIR`). The three install forms carry the
same files (`package.json` `files`; the asset manifest of `scripts/build-binary.sh`).

| Path in the package | Content | Used by |
|---|---|---|
| `schemas/` | The JSON Schemas of every file type and role output | every command |
| `presets/` | The shipped presets (section 5) | every command |
| `template/` | What `mw init` writes into a project | `mw init` |
| `packages/` | The official packages (section 15), installed only by `mw add <name>` | `mw add` |
| `src/ui/web/` | The GUI's page: HTML, CSS and ES modules | `mw ui` (section 16) |
| `ops/mw-work@.service` | The systemd unit for unattended work | `scripts/install-service.sh` |
| `scripts/install-service.sh` | Installs the `mw-work@` systemd unit from `ops/` | the owner (section 14) |

## 3. The configuration file: `mergewright.yaml`

The configuration is a YAML mapping at the project root. Only `mergewright` and `name` are
required; every other key has a default. Unknown keys are errors (`config/schema`). If the file
is not valid YAML or fails its schema (`config/yaml`, `config/schema`), the project is loaded with
the defaults for everything except `mergewright` and `name`, so a typo in one key (say
`limits.turns`) would also drop `git.hub` and `agents.sandbox` to their defaults. Such a project is
read, never acted on, until the file is fixed:

- Read-only commands and MCP tools still answer from this load. `mw check`, `mw doctor` and
  `mw status` (and the tools `mw_check`, `mw_doctor` and `mw_status`) also report the errors:
  `mw check` as its `config/*` diagnostics, `mw doctor` as a `config PROBLEM` line, `mw status` as
  a note above its table (on standard error with `--json`), and `mw_status` by answering
  `{ config_errors, cards }` instead of the bare card list. The other read-only commands and tools
  answer without listing them.
- Everything that would act on the defaults refuses with `config/invalid` before it writes a file,
  takes the lock or the lease, creates a worktree, commits or starts a phase: `mw run` and the
  engine's start of a run (fresh or resumed), `mw work`, `mw approve`, `mw retry`, `mw abort`,
  `mw sync`, `mw lease take|release`, the writing subcommands of `mw card` (all but `lint`),
  `mw memory` (all but `show` and `search`), `mw spec` (all but `list`), `mw eject`,
  `mw mcp add|remove`, `mw queue flush|adopt`,
  a moved command such as `mw hermes` when the package that has it is not loaded (section 15.4; an
  invalid config enables no package), the matching actions of the
  terminal UI, every MCP tool that writes (section 12.2), and `mw_delegate` and
  `mw_review`, which write a run folder and run an agent. The refusal lists every schema error, one
  per line as `<key path>: <message>` (for example `limits.turns: must be integer` or
  `limits.typo: unknown field`; a YAML error has `mergewright.yaml` as its path), and says to fix the
  file and run `mw check`.
- The file can change while a command waits (a hub sync, file sync, an edit), so it is checked again
  as it is then: a run once its start has taken the lease and adopted the hub, before anything of
  the run is written (the lease is handed back); a committing MCP tool once it holds the repository
  lock and has adopted the hub, right before it writes; and `mw work` at each pass, before it touches
  the board, the queue, the lease, the usage guard or the hub, and again after the pass's hub sync.
  A pass that finds the file invalid does nothing: without `--watch` the command stops with a
  failing exit code; with it, it says so once and looks again after the interval.
- `mw config set` and `unset` stay available to repair the file: they write only a result that
  passes the schema (section 7.5).

Edit it by hand or with `mw config set <key> <value>`, which validates the result before writing
and keeps comments and layout (section 7.5).

### 3.1 Keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mergewright` | string, `"0.1"` | required | The specification version the project targets (Appendix C). Write it quoted. |
| `name` | id (`^[a-z][a-z0-9-]*$`) | required | The project's name. Appears in prompts as `{{project.name}}`. |
| `description` | string | `""` | One line about the product. Appears in prompts as `{{project.description}}`. |
| `extends` | string | `standard` | The preset whose roles, flows, gates and MCP servers the project inherits (section 5). |
| `cards.prefix` | `^[A-Z][A-Z0-9]{0,9}$` | the first four letters of `name`, upper case, or `CARD` when `name` has no letters | Prefix of every card id. |
| `cards.default_flow` | id | `standard` | The flow a card runs when it names none and its kind has no flow of its own (section 4.2). |
| `cards.mirror` | `none` | `none` | Kept for older configs. The value `kanban` of earlier versions is refused (`config/schema`): the Kanban mirror is the `cline-kanban` package (section 10.5), and the message says to run `mw add cline-kanban`. |
| `cards.kanban_path` | (removed) | none | No longer read: it is `packages.cline-kanban.path` (section 10.5). A config that still has it fails with `config/schema`, and `mw config set` refuses it, saying to run `mw add cline-kanban` and move it. |
| `agents.sandbox` | `auto` \| `off` \| `required` | `auto` | Whether write phases need the agent sandbox (section 8.6). `MW_SANDBOX` in the environment (for example in `~/.config/mergewright/env`) overrides it per machine; `off` says the host is isolated. |
| `git.base` | string | `main` | The base branch cards are merged into. |
| `git.hub` | string | `none` | The git remote that holds the shared repository state between machines, or `none` for a single machine (section 9). |
| `git.forge.kind` | `none`, `gitea` or `github` | `none` | `none` merges locally; the others merge through a pull request on the forge (section 10.6). |
| `git.forge.url` | string | none | Base URL of the forge. |
| `git.forge.repo` | string | none | Repository on the forge, as `owner/name`. |
| `git.forge.token_env` | string | `GITEA_TOKEN` or `GITHUB_TOKEN`, by kind | Name of the environment variable that holds the forge token. Never the token itself. |
| `protected` | list of globs | see below | Paths an agent may not write unless its card lists them in `allow_protected`. |
| `risk.default` | `low`, `medium`, `high` or `critical` | `medium` | The risk of a card that does not state one. |
| `risk.deep_review` | list of strings | `[concurrency, auth, transactions, caching, migrations, payments]` | Subjects that call for a deep review: a card with a tag naming one of them (compared ignoring case) gets `deep_review` (section 4.5). |
| `limits.rounds` | integer ≥ 0 | `2` | Remediation rounds a run may use when its flow sets no `remediate.max_rounds`. |
| `limits.turns` | integer ≥ 1 | `60` | Agent turns per role invocation when the role sets none. |
| `limits.minutes` | integer ≥ 1 | `90` | Wall-clock limit per role invocation and per gate run, when the role sets none. |
| `limits.diff_chars` | integer ≥ 1000 | `60000` | The longest diff placed into a prompt; longer diffs are clipped in the middle. |
| `limits.lease_minutes` | integer ≥ 1 | `10` | Age after which another machine may take over the lease (section 9.3). |
| `limits.transient_retries` | integer 0 to 10 | `2` | Attempts again on the same model after a transient harness failure (capacity, overload, HTTP 429 or 5xx, a provider request timeout, a reset connection), with a growing wait (5 s, 15 s, 45 s, ...); then the role's `fallback_model` gets one attempt (section 8.3). These attempts spend no remediation round and no schema retry. |
| `limits.phase_visits` | integer ≥ 1 | `6` | How often a run may enter any one phase, by any route (next phase, `remediate`, a named route in `on`); one entry more blocks the run (section 8.2). |
| `trace.tests` | list of globs | `["**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/test_*.*", "**/*Test.*", "**/*Tests.*", "**/tests/**", "**/test/**", "**/__tests__/**", "**/spec/**"]` | Files that count as tests when they carry an `@req` comment (section 6): by name (`x.test.ts`, `x_test.go`, `test_x.py`, `x.spec.js`, `XTest.java`) or by folder. |
| `trace.ignore` | list of globs | `[]` | Files whose `@req` comments are not counted at all (fixtures, vendored code). |
| `trace.require_tests` | `none`, `must` or `should` | `must` | Which finished requirements must have a test: `must` requirements only, `must` and `should`, or none. |
| `trace.require_implements` | boolean | `true` | When true, a card of kind `feature` must name at least one requirement. |
| `trace.raw_days` | integer ≥ 0 | `14` | Days the raw standard output and error streams of a finished run (`done` or `aborted`) are kept. At the start of each pass `mw work` deletes older ones (by modification time); `state.json`, the artifacts, the saved exchanges and the gate logs are kept, and a run that is `running`, `waiting` or `blocked`, or whose state cannot be read, is not touched (section 8.1). |
| `gate.env` | list of environment variable names | `[]` | Variables gates may see, for example `DATABASE_URL`. Gates otherwise get a minimal environment (section 4.6). |
| `gate.required` | list of gate step names | `[]` | Steps that must run and pass: each must appear exactly once in the gate's JSON summary with `ok: true`. One marked `skipped` fails the gate (`gate/required-skipped`); one absent, listed twice or malformed, or a summary that is missing or malformed, fails it with `gate/required-missing`; in both cases the phase blocks. One that reports `ok: false` fails the gate (sections 4.6 and 8.3). |
| `memory.state_max_lines` | integer ≥ 10 | `150` | Line cap of `memory/STATE.md`. |
| `memory.rules_max_lines` | integer ≥ 10 | `100` | Line cap of `memory/RULES.md`. |
| `memory.mem0` | (removed) | none | No longer read: mem0 is the `mem0` package (section 10.2). A config that still has it fails with `config/schema`, and the message says to run `mw add mem0` and move the settings to `packages.mem0`. |
| `memory.letta` | (removed) | none | No longer read: Letta is the `letta` package (section 10.9). A config that still has it fails with `config/schema`, and the message says to run `mw add letta` and move its settings to `packages.letta`. |
| `docs.paths` | list of globs | `["docs/**", "README.md"]` | The project's documentation: what reviewers check and what is synchronised to the documentation service. |
| `docs.exclude` | list of globs | `[]` | Files under `docs.paths` that are not synchronised (the `docs.sync` action and a package's full resynchronisation such as `mw open-notebook sync --all`), left out without a message; for example `["docs/product/**"]`. |
| `docs.notebook` | (removed) | none | No longer read: Open Notebook is the `open-notebook` package (section 10.3). A config that still has it fails with `config/schema`, and the message says to run `mw add open-notebook` and move its settings to `packages.open-notebook`. |
| `roles.<role id>` | mapping | `{}` | Per-role overrides without copying the role file: any of `runs`, `model`, `fallback_model`, `provider`, `profile`, `command` (section 5.3). |
| `roles.<role id>.fallback_model` | string | the role file's | The role's alternate model on the same harness, tried once after `limits.transient_retries` (section 8.3); it overrides the role file's `fallback_model`, and an empty string removes it. |
| `local_models.endpoint` | string | none | Base URL of an OpenAI-compatible server for roles with `runs: local` (section 10.8). |
| `local_models.fallback` | string | none | Base URL of a second OpenAI-compatible server, tried when the endpoint is unreachable or answers with a server error. |
| `local_models.key_env` | string | none | Name of the environment variable that holds the local server's API key. |
| `report.command` | string | none | Command run to notify the owner. `{subject}` is replaced by the subject and `{file}` by the path of a file holding the message body (section 10.1). |
| `usage.command` | string | none | Command that reports subscription usage for the usage guard; it prints a JSON object with `max_used` (section 10.7). Without it there is no guard. |
| `usage.pause_at_pct` | number | `85` | Usage percentage at which new work on a paid harness pauses. |
| `usage.resume_below_pct` | number | `80` | Usage percentage below which paused work resumes. |
| `packages.<name>` | mapping | none | Enables the installed package `<name>` and holds its own settings, checked against the schema its manifest gives (`config/package` when they do not fit). `mw add` writes the entry, `mw remove` deletes it (section 15). |

The default `protected` list is:

```yaml
protected: ["specs/*.spec.md", memory/RULES.md, mergewright.yaml, "roles/**", "flows/**",
            "gates/**", "mcps/**", "docs/adr/**", AGENTS.md, CLAUDE.md]
```

Setting `protected` replaces this list; it does not add to it. Copy the defaults when you extend
it. Spec change proposals (`specs/changes/`) are deliberately not protected, so agents can propose
changes; `memory/STATE.md` is not protected, because the runtime rewrites it.

Secrets never appear in the configuration. Every key that needs a secret names an environment
variable (`*_env`) instead. The defaults that depend on the forge kind or on the project's `name`,
and the `*_env` defaults, are applied by the integrations when their section is present; they are
not written into the file.

### 3.2 Example

A complete configuration that uses every section. It passes `mw check`.

```yaml
mergewright: "0.1"
name: shop
description: "Online shop: catalogue, cart and checkout."
extends: standard

cards:
  prefix: SHOP
  default_flow: standard
  mirror: none

git:
  base: main
  hub: hub
  forge: {kind: gitea, url: "https://git.example.com", repo: acme/shop, token_env: GITEA_TOKEN}

protected:
  - "specs/*.spec.md"
  - memory/RULES.md
  - mergewright.yaml
  - "roles/**"
  - "flows/**"
  - "gates/**"
  - "mcps/**"
  - "docs/adr/**"
  - AGENTS.md
  - CLAUDE.md
  - "db/migrations/**"

risk:
  default: medium
  deep_review: [concurrency, auth, payments]

limits: {rounds: 2, turns: 60, minutes: 90, diff_chars: 60000, lease_minutes: 10, phase_visits: 6}

gate:
  env: [DATABASE_URL]

trace:
  tests: ["tests/**", "**/*_test.go"]
  ignore: ["tests/fixtures/**"]
  require_tests: must
  require_implements: true

memory:
  state_max_lines: 150
  rules_max_lines: 100

docs:
  paths: ["docs/**", README.md]

packages:                         # installed with `mw add mem0`, `mw add letta`, `mw add open-notebook` (section 15)
  mem0: {url: "http://services.example.com:8888", user: shop, key_env: MEM0_API_KEY}
  letta: {url: "http://services.example.com:8283", agent: mergewright, key_env: LETTA_SERVER_PASSWORD}
  open-notebook: {url: "http://services.example.com:5055", name: shop, key_env: NOTEBOOK_KEY}

roles:
  worker: {model: sonnet}
  reviewer-deep: {model: gpt-5.6-sol}

local_models: {endpoint: "http://gpu.example.com:8080/v1", key_env: LOCAL_LLM_KEY}

report:
  command: "notify-owner --subject {subject} --body-file {file}"

usage:
  pause_at_pct: 85
  resume_below_pct: 80
```

### 3.3 Mistakes `mw check` catches

| Code | Mistake |
|---|---|
| `config/yaml` | The file is not valid YAML, or is not a mapping. |
| `config/schema` | A required key is missing, a key is unknown, or a value has the wrong type or form. |
| `config/version` | `mergewright` names a version this runtime does not implement. |
| `config/preset` | `extends` names a preset that does not exist. |
| `config/role-override` | `roles.<id>` overrides a role that neither the project nor the preset defines. |
| `config/package` | `packages.<name>` enables a package that is not installed in this checkout, whose manifest is invalid or names another package, or whose settings its schema refuses (section 15). |

## 4. File types

### 4.1 Specs

A spec states what one area of the product must do, as a list of requirements with stable ids
and acceptance criteria in a fixed form. Specs are protected: once written, they change through
proposals (section 7.3), which keep the history of each requirement in a revision number.

#### Front matter

A spec is a markdown file that starts with a YAML front matter block between two `---` lines.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | id | yes | The spec's id. The file must be `specs/<id>.spec.md`, and every requirement id in it starts with `REQ-<id>-`. |
| `title` | string | yes | Human title. |
| `status` | `draft`, `accepted` or `deprecated` | yes | The spec's state. `deprecated` makes every requirement in it deprecated, whatever its own status line says. `draft` and `accepted` are for people. |
| `grammar` | `feature` | no | The requirement grammar. `feature` is the only grammar and the default. |
| `owner` | string | no | Who answers questions about this spec. |

#### Requirement grammar

After the front matter comes free markdown. A requirement is a block that starts with a heading
of exactly this form:

```
### REQ-<spec id>-<nnn> <title>
```

Three `#` characters, the id (three or more digits), one space, and a title. Inside the block, the
runtime reads these lines; a line may start with `-` or `*`:

| Line | Required | Meaning |
|---|---|---|
| `- priority: must`, `should` or `could` | yes | How much the requirement matters. |
| `- rev: <n>` | no; written by the runtime | The revision, a positive whole number. Absent means 1. Do not write or change it by hand: `mw spec accept` maintains it. |
| `- status: active` or `deprecated` | no; written by the runtime | Absent means `active`. Deprecated requirements stay in the file so their ids are never reused. |
| `- AC-<n>: Given ..., when ..., then ...` | see below | One acceptance criterion. The text must contain the words "given", "when" and "then", in that order (any case). Criterion ids are unique within the requirement. |

A requirement whose priority is `must` or `should` and which is active needs at least one
acceptance criterion. A `could` requirement may have none, and so may a deprecated one.

Any other text inside the block (paragraphs, lists, deeper headings `####` to `######`) is part
of the requirement, for people. The block ends at the next requirement heading or at the next
heading of level one to three. Text inside code fences (```` ``` ```` or `~~~`) is ignored
entirely, so examples of requirements can be quoted safely.

Requirement ids are unique across the whole project, and are never reused: a requirement that is
no longer wanted is deprecated, not deleted.

#### Example

`specs/checkout.spec.md`, after one accepted change (`CHG-1`). It passes `mw check`.

```markdown
---
id: checkout
title: Checkout
status: accepted
owner: payments team
---

How a customer pays for the contents of the cart. Prose like this paragraph is allowed
anywhere and is not part of any requirement.

### REQ-checkout-001 Pay with a saved card
- priority: must
- rev: 2
- AC-1: Given a signed-in customer with a saved card, when they confirm the order, then the card is charged exactly once.
- AC-2: Given a charge the bank declines, when the customer confirms the order, then the order stays open and the customer sees the reason.

A charge is "exactly once" even when the customer presses the button twice.

### REQ-checkout-002 Pay by bank transfer
- priority: should
- rev: 2
- status: deprecated
- AC-1: Given an order, when the customer chooses bank transfer, then the payment details are shown.

Deprecated by CHG-1: The payment provider no longer offers transfers.

### REQ-checkout-003 Gift wrapping
- priority: could
```

#### Mistakes `mw check` catches

| Code | Mistake |
|---|---|
| `spec/front-matter` | The file does not start with a valid front matter block. |
| `spec/schema` | A front matter field is missing, unknown or has the wrong value. |
| `spec/file-name` | The file name is not `<id>.spec.md`. |
| `spec/duplicate` | Two spec files use the same id. |
| `spec/req-heading` | A heading starts with `REQ-` but is not a valid requirement heading (wrong level, fewer than three digits, no title). |
| `spec/req-prefix` | A requirement id does not start with `REQ-<this spec's id>-`. |
| `spec/duplicate-req` | A requirement id is defined twice, in the same file or in two files. |
| `spec/priority` | The priority line is missing or has a value other than `must`, `should` or `could`. |
| `spec/rev` | The `rev` line is not a positive whole number. |
| `spec/status` | The `status` line is not `active` or `deprecated`. |
| `spec/no-criteria` | An active `must` or `should` requirement has no acceptance criteria. |
| `spec/criterion-form` | A criterion does not read "Given ..., when ..., then ...". |
| `spec/criterion-id` | A bullet looks like a criterion but is not written `- AC-<n>: ...`. |
| `spec/duplicate-criterion` | Two criteria of one requirement have the same id. |
| `spec/unclosed-fence` (warning) | A code fence is opened and never closed, so the rest of the file is ignored. |

### 4.2 Cards

A card is one unit of work, small enough for one agent to implement in one session. It says what
to build (the requirements it implements), why, where the agent may write, and how risky it is.

#### Front matter

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `id` | card id | yes | | The card's id; the file is `cards/<id>.card.md`. It must start with `cards.prefix`. |
| `title` | string | yes | | One line saying what the card delivers. |
| `status` | `todo`, `ready`, `in_progress`, `review`, `blocked` or `done` | yes | | See "Status" below. |
| `kind` | `feature`, `fix`, `chore`, `docs` or `spike` | no | `feature` | What kind of work it is. The kind can choose the flow. |
| `implements` | list of requirement ids | no | `[]` | The requirements this card implements. Required (non-empty) for a `feature` when `trace.require_implements` is true. |
| `revs` | mapping of requirement id to integer | no; managed | each requirement at rev 1 | The revision of each requirement the card was written against. `mw card new` and `mw card ack` write it. |
| `flow` | id | no | chosen by kind | The flow to run. |
| `risk` | `low`, `medium`, `high` or `critical` | no | `risk.default` | Drives stop points (`high` and `critical` wait for `go` and `merge` in every flow, section 8.5) and deep review in the shipped flows. |
| `deep_review` | boolean | no | `false` | Asks for a deep review regardless of risk. |
| `scope` | list of globs | see below | `[]` | The only paths the card's agents may write. |
| `depends` | list of card ids | no | `[]` | Cards that must be finished first. |
| `docs` | list of paths | no | `[]` | Documents this card must update. Given to the worker and the reviewer. |
| `tags` | list of strings | no | `[]` | Free labels. A tag that names a subject in `risk.deep_review` (for example `payments`) asks for the deep review. |
| `allow_protected` | list of globs | no | `[]` | Protected paths the owner lets this card write. Only the owner adds entries here. |

#### Body

The markdown after the front matter is given to every agent that works on the card. It must have
a non-empty `## Why` section. `mw card new` also writes an `## Out of scope` section, which is
recommended: it tells the worker what not to touch. Without `--out-of-scope` it holds the scaffold
text `(what this card must not touch)`, which lint reports until it is replaced (`None` when nothing
needs saying). An optional `## Acceptance` section lists what must be true when the card is done,
one criterion per item; `mw card new --acceptance` writes it. Any other sections are free.

#### Choosing the flow

A card runs the flow named in its `flow` field. Without one, a `docs` card runs the `docs` flow
and a `spike` card runs the `spike` flow when those flows exist; every other card runs
`cards.default_flow`. The `quick` flow is used only when a card names it.

#### Scope

`scope` lists, as globs relative to the project root, every path the card's agents may create,
change or delete. A card that is not `done` and whose flow contains a phase with a writing role
(`mode: write`) must have a non-empty scope. After each writing phase the runtime compares every
changed path with the scope and rejects the work if any path falls outside it (section 8.4). When
a brief exists, a path must also match the brief's `scope`: the brief can narrow the card's scope
but never widen it. A path that matches `protected` must also match `allow_protected`. Nothing is
exempt: an agent that edits the card file itself fails the check. The runtime's own change to the
card (its `status` line, at the merge) is the only edit of the card file the check accepts.

A change usually makes some documentation stale, and the planner refuses a card whose documentation
must change outside its scope. So `mw card new` adds the project's `docs.paths` globs to a scope it
is given (those the scope does not already cover), leaving out any that is itself a protected path
or names one (`AGENTS.md` when it is protected): a card gets a protected path only through
`allow_protected`. `--no-docs` leaves the scope as given, and a card
created without a scope gets none (`mw check` then reports `card/scope`). `mw check` warns
(`card/scope-protected`) about a card that is not done whose scope names a protected path (a glob
that is one, or whose paths match one) that `allow_protected` does not grant: a change there would
be refused. `mw check` warns
(`card/scope-docs`) about a `todo` or `ready` card whose scope covers none of `docs.paths` while the
project has documentation paths: a scope covers a documentation path when one of its globs matches
that path, or lies inside it (a scope of `docs/guides/**` covers part of `docs/**`). The warning is
harmless for a card that changes no documented behaviour.

#### Status

The card file's `status` is the card's recorded state. The owner sets it while planning (`todo`,
`ready`, `blocked`). While a card is being run, its live state is held in the run state (section
8.1) and shown by `mw status`; the runtime changes the file's `status` only once, to `done`, inside
the commit that merges the card. `in_progress` and `review` exist for projects that track cards by
hand or on a board.

#### Lint: is the card ready?

`mw check` checks that a card is well formed; lint checks that it is ready to run, so an unready
card is caught before the planner sees it. `mw card lint <ID>` and the MCP tool `mw_card_lint`
(section 12.3) run the same check and report the same findings, each with a code, a severity and a
message. Lint only reads: it writes no file, commit or memory.

| Code | Severity | Finding |
|---|---|---|
| `lint/placeholder` | error | `## Out of scope` still holds the scaffold text `mw card new` wrote. An explicit `None` passes. |
| `lint/why-empty` | error | `## Why` is missing, empty, or still holds the scaffold text `mw card new` wrote. |
| `lint/no-acceptance` | error | The card has no `## Acceptance` criteria and implements no requirement. |
| `lint/scope-empty` | error | The card has no `scope` globs. |
| `lint/scope-protected` | error | A `scope` glob covers a protected path that `allow_protected` does not grant: either the glob lies inside a protected glob (`roles/a.md` beside `roles/**`), or a protected glob lies inside it (`roles/**` inside `**`). The message names the protected globs. A documentation path from `docs.paths` (such as `docs/**`, which `mw card new` adds) is checked only the first way, so it may stand beside a protected path beneath it (`docs/adr/**`). |
| `lint/output-outside-scope` | error | A path named in `## Acceptance` or in `docs` is covered by no `scope` glob; the message names the path. In `## Acceptance` a path is a word with a directory part and a file extension (`src/cards.ts`), or the same, or a directory glob (`docs/**`), in backticks. In backticks a path with a directory part needs no extension (`bin/mw`, `docs/guide`, `src/engine/`) when it ends in `/` or its first directory is at the project root, and a name without a directory (`README.md`, `Dockerfile`) counts when a file of that name is at the project root. Codes such as `lint/placeholder` are not paths. |
| `lint/depends-open` | warning | A card in `depends` is not `done` (or does not exist). A warning, because `mw work` already waits for a card's dependencies. |
| `lint/stale` | error | A requirement the card implements has a revision other than the one `revs` records. Review the card, then `mw card ack <ID>`. |

Only a card without lint errors becomes `ready`: `mw card status <ID> ready`, `mw_card_set_status`
with `ready`, and `mw card new --status ready` (or `mw_card_new` with `status: ready`) refuse a card
with errors (`card/not-ready`, the message lists the codes) before anything is written or
committed. A fresh run (`mw run`, including `mw run --dry-run`, `mw work`, `mw_run_start` on a card with no run, or whose run was
aborted) lints the card again before the lock, the lease or any phase, and refuses it the same
way. On a project with a hub it lints the card once more after adopting the hub's history, as the
adopted files hold it, still before anything of the run is written and before any phase; resuming a
run in progress does not lint. Lint does not replace the planner's judgement of the
card; it removes the mistakes that need no judgement.

#### Example

`cards/SHOP-12.card.md`. It passes `mw check` (with `SHOP-11` present and the spec from 4.1).

```markdown
---
id: SHOP-12
title: Charge a saved card at checkout
kind: feature
status: todo
implements: [REQ-checkout-001]
revs: {REQ-checkout-001: 2}
flow: standard
risk: high
deep_review: true
scope: ["src/checkout/**", "tests/checkout/**", "db/migrations/**", "docs/guides/payments.md"]
depends: [SHOP-11]
docs: [docs/guides/payments.md]
tags: [payments]
allow_protected: ["db/migrations/**"]
---

## Why

Customers with a saved card abandon checkout when they have to type it again.

## Out of scope

Refunds, and any change to how cards are stored (SHOP-11 did that).

## Notes

The provider's idempotency key is the order id.
```

#### Mistakes `mw check` catches

| Code | Mistake |
|---|---|
| `card/front-matter` | The file does not start with a valid front matter block. |
| `card/schema` | A field is missing, unknown or has the wrong value. |
| `card/file-name` | The file name is not `<id>.card.md`. |
| `card/why` | The body has no `## Why` section, or it is empty. |
| `card/duplicate` | Two files use the same card id. |
| `card/prefix` | The id does not start with `cards.prefix` followed by `-`. |
| `card/unknown-requirement` | `implements` names a requirement no spec defines. |
| `card/no-requirement` | A `feature` card implements nothing while `trace.require_implements` is true. Use `chore`, `fix`, `docs` or `spike` for work with no requirement. |
| `card/depends` | `depends` names the card itself or a card that does not exist. |
| `card/cycle` | Dependencies form a cycle. |
| `card/unknown-flow` | The card's flow (named or chosen by kind) does not exist. |
| `card/scope` | The card is not done, its flow writes files, and it has no `scope`. |
| `card/scope-docs` (warning) | A `todo` or `ready` card's scope covers none of `docs.paths`, while the project has documentation paths, so the card cannot update the documentation its change makes stale. |
| `card/scope-protected` (warning) | A card that is not done names a protected path in its scope without granting it in `allow_protected`. |
| `card/stale` (warning) | A requirement the card implements has a higher revision than the card's `revs` records. Review the card, then run `mw card ack <ID>`. |
| `card/deprecated-requirement` (warning) | A card that is not done implements a deprecated requirement. |

### 4.3 Roles

A role defines one kind of agent: the harness that runs it, the model, what it may do, which
artifact it must return, its limits, its tools, and its prompt. The preset supplies eight roles
(section 5.1); a project adds roles, or replaces a preset role, by writing `roles/<id>.role.md`.

#### Front matter

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | id | yes | The role's id; the file is `roles/<id>.role.md`. |
| `description` | string | no | One line, shown by `mw roles`. |
| `runs` | `claude`, `codex`, `local`, `shell` or `mock`, or a harness id an installed and enabled package declares (section 15; `hermes`, from the official `hermes` package) | yes | The harness (see below). |
| `model` | string | no | The model, in the harness's own naming (`opus`, `gpt-5.6-terra`). Absent means the harness's default. |
| `fallback_model` | string | no | An alternate model on the same harness (`gpt-5.6-sol` for the shipped `reviewer`). When the role's model fails transiently and `limits.transient_retries` are spent, the role runs once more on this model (section 8.3). `roles.<id>.fallback_model` in the config overrides it. For `local`, it is the alternate profile. |
| `provider` | string | no | The model provider, for harnesses that choose between providers (a package's, such as `hermes`). |
| `profile` | string | for `local`, this or `model` | The local model profile (section 10.8). |
| `command` | string | for `shell` | The shell command that runs the agent. |
| `mode` | `advise`, `read` or `write` | yes | What the agent may do (see below). |
| `output` | `brief`, `handoff`, `findings`, `adjudication`, `reflection` or `text` | yes | What the agent must return (Appendix B). |
| `limits.turns` | integer ≥ 1 | no | Most agent turns per invocation. Default `limits.turns` from the config. |
| `limits.minutes` | integer ≥ 1 | no | Hard wall-clock limit per invocation. Default `limits.minutes` from the config. |
| `mcps` | list of MCP server ids | no | MCP servers this role asks for by name (section 4.7). |
| `args` | list of strings | no | Extra arguments appended to the harness command. |

**Modes.** `advise`: the agent gets no tools and only answers. `read`: the agent may read the
worktree but not change it. `write`: the agent may change files in the card's worktree; the
runtime commits its work and checks the scope. Only the `claude`, `codex`, `shell` and `mock`
harnesses can change files, so only they may have `mode: write`.

**Harnesses.** Each harness runs one kind of agent program. The details of each command line are
part of the engine (section 8.6).

| `runs` | Program | Can write |
|---|---|---|
| `claude` | Claude Code CLI in print mode | yes |
| `codex` | Codex CLI, `codex exec` | yes |
| `local` | An OpenAI-compatible HTTP endpoint (`local_models.endpoint`); advisory only | no |
| `shell` | Any command (`command`), prompt on standard input, reply on standard output | yes |
| `mock` | Scripted replies, for tests | yes |
| a package's id | The harness an enabled package provides (section 15), such as `hermes` (the Hermes agent, one-shot chat) from the official `hermes` package; advisory only | no |

#### Prompt

The markdown after the front matter is the prompt template. It must not be empty. Placeholders
written `{{name}}` (spaces inside the braces are allowed) are replaced with the values below when
the role runs; a value that does not exist yet (for example `{{findings}}` before any review)
becomes an empty string. Every placeholder must be one of these names:

| Placeholder | Content |
|---|---|
| `{{project.name}}` | `name` from the config. |
| `{{project.description}}` | `description` from the config. |
| `{{card}}` | The card: id, title, kind, risk, scope and dependencies, then the lines `allow_protected` (the owner's grant), `docs` (paths to update) and `implements` (requirement ids), each only when the card sets it, then its body. |
| `{{card.id}}` | The card id. |
| `{{card.title}}` | The card title. |
| `{{card.kind}}` | The card kind. |
| `{{card.risk}}` | The card's effective risk. |
| `{{card.scope}}` | The scope globs, comma-separated. |
| `{{requirements}}` | For each requirement the card implements: `### <id> <title>`, its priority, revision and criteria. |
| `{{brief}}` | The current brief, as short markdown: summary, approach, scope, acceptance, guards, documents. |
| `{{handoff}}` | The worker's latest handoff, as markdown. |
| `{{findings}}` | One line per review finding (id, severity, blocking, file and line, title), then its detail. |
| `{{gate}}` | Pass or fail per gate step; for failed steps, the last 40 lines of the log as the runtime copied them into the gate result when the gate finished (redacted; no log file is read when the prompt is rendered); then any warnings about logs the runtime refused. |
| `{{adjudication}}` | The verdict, summary and instructions. |
| `{{diff}}` | `git diff <base>...HEAD`, preceded by its `--stat`, clipped to `limits.diff_chars`. |
| `{{changed}}` | The paths changed on the card's branch, one per line. |
| `{{memory.state}}` | `memory/STATE.md`. |
| `{{memory.rules}}` | `memory/RULES.md`. |
| `{{memory.index}}` | `memory/INDEX.md`. |
| `{{memory.recall}}` | Up to five memory entries relevant to the card (section 7.2), plus hits from the semantic stores (enabled packages such as `mem0` and `letta`, in the order `packages:` lists them), as `- title: first paragraph`. |
| `{{round}}` | The remediation round, 0 on the first pass. |
| `{{remediation}}` | Why the run was sent back (gate failure, scope violation, adjudication instructions); `(first pass)` on round 0. |
| `{{protected}}` | The `protected` globs, comma-separated. |
| `{{branch}}` | The card's branch, `card/<ID>`. |
| `{{base}}` | The base branch. |
| `{{docs}}` | The card's `docs` plus the brief's `docs`, comma-separated, or `(none listed)`. |

Every placeholder above is available to every role, the adjudicator included; a role pays only for
those its prompt uses. The `adjudicator` role of the standard preset (`presets/standard/roles/adjudicator.role.md`)
uses these, so a project that rewrites that role can start from them:

| Placeholder | What the adjudicator gets |
|---|---|
| `{{card.id}}`, `{{project.name}}`, `{{round}}` | Which card, which project, and the remediation round. |
| `{{brief}}` | The brief the findings are judged against (what the brief allows is a ground for rejecting a finding). |
| `{{gate}}` | The gate result, including the steps that did not run. |
| `{{handoff}}` | The worker's latest handoff. |
| `{{findings}}` | The review findings; their ids are the ids the verdict must use. |
| `{{changed}}` | The paths changed on the branch. |
| `{{base}}` | The base branch the diff is taken against. |
| `{{diff}}` | `git diff <base>...HEAD` with its `--stat`, clipped to `limits.diff_chars`, so the adjudicator can confirm each finding against the change itself. |

Nothing else is injected into a prompt, with one exception: the project's state and
rules are in every prompt, of a card phase and of a delegation (section 12.3, `mw_delegate`). A
role whose prompt places neither `{{memory.state}}` nor `{{memory.rules}}` gets the one it lacks
appended, under "## Where the project is now (memory/STATE.md)" and "## Project rules
(memory/RULES.md)" (each only when the file has text), so what an agent says about the project's
state is grounded in those files. Otherwise a role pays, in tokens, only for the placeholders it uses.
Roles that return JSON should end their prompt by asking for only the JSON object: the runtime
validates the reply against the output schema (Appendix B).

#### Example

`roles/security-reviewer.role.md`. It passes `mw check` (with the MCP server `docs` from 4.7).

```markdown
---
id: security-reviewer
description: Reviews payment changes for security defects.
runs: codex
model: gpt-5.6-sol
mode: read
output: findings
limits: {minutes: 30}
mcps: [docs]
args: ["-c", "model_reasoning_effort=high"]
---
You are an independent security reviewer for {{project.name}}. Review the change for card
{{card.id}} ({{card.title}}, risk {{card.risk}}). You are read-only: never modify anything.

Look for: secrets in code or logs, missing authorisation checks, card data that leaves the
payment provider, and charges that can happen twice.

A finding is `blocking` only if the card should not merge with it. Ids are S-01, S-02, and so on.

## Brief

{{brief}}

## Requirements

{{requirements}}

## Diff against {{base}}

{{diff}}

Return only the JSON object.
```

#### Mistakes `mw check` catches

| Code | Mistake |
|---|---|
| `role/front-matter` | The file does not start with a valid front matter block. |
| `role/schema` | A field is missing, unknown or has the wrong value; for `runs`, an id that is neither built in nor declared by an enabled package. For an id that was built in and is now an official package's (`hermes`), the message says to run `mw add <package>`. |
| `role/file-name` | The file name is not `<id>.role.md`. |
| `role/mode` | `mode: write` on a harness that cannot change files (`local`, or a package's). |
| `role/command` | `runs: shell` without a `command`. |
| `role/profile` | `runs: local` with neither `profile` nor `model`. |
| `role/prompt` | The prompt (the text after the front matter) is empty. |
| `role/placeholder` | The prompt uses a placeholder that is not in the table above. |
| `role/unknown-mcp` | `mcps` names a server that does not exist. |
| `role/mcp-unsupported` (warning) | A role that runs on `local` or on a package's harness is given MCP servers (by its `mcps` or by a server's `roles` list naming it); those harnesses cannot use them, so they are ignored. A server offered with `roles: all` does not count. |

The checks `role/mode`, `role/command` and `role/profile` are made on the role file and again after
the configuration's `roles.<id>` overrides are applied (section 5.3), so an override cannot create
an invalid role.

### 4.4 Flows

A flow is a pipeline written as data: the ordered phases a card goes through, the conditions
under which phases run or wait for the owner, and where each kind of failure leads.

#### Fields

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `id` | id | yes | | The flow's id; the file is `flows/<id>.flow.yaml`. |
| `description` | string | no | `""` | Shown by `mw flows`. |
| `worktree` | boolean | no | `true` | Whether the card gets its own branch and worktree. A flow with `worktree: false` runs in the project root and can neither merge nor use writing roles. |
| `phases` | list of phases (at least one) | yes | | The phases, in order. |
| `remediate.phase` | phase id | with `remediate` | | The phase a run goes back to when an outcome is routed to `remediate`. |
| `remediate.max_rounds` | integer ≥ 0 | no | `limits.rounds` | How many times a run may be sent back before it stops. |

Each phase:

| Field | Type | Meaning |
|---|---|---|
| `id` | id, required | Unique within the flow. Used by `needs`, `on`, `remediate.phase`, `--until` and approvals. |
| `role` | role id | The role that runs in this phase. |
| `also` | list of `{role, when}` | Additional roles that run in the same phase, one after another, each only when its optional `when` condition is true. Allowed only on a role phase. |
| `gate` | gate id | The gate this phase runs. A gate phase has no role and no action. |
| `action` | `merge`, `memory.update`, `docs.sync` or `notify` | A runtime action, alone or after the phase's role. |
| `needs` | list of phase ids | Earlier phases whose artifact must exist before this phase runs. |
| `when` | condition | The phase runs only when the condition is true; otherwise it is skipped. |
| `stop` | `{when: <condition>, ask: <word>}`, or a list of them | When a condition is true, the run waits for the owner to approve with its `<word>` before this phase (section 8.5). A list is checked in order; the run waits at the first true one not yet approved. A flow can add stop points but not remove or weaken the ones the runtime adds: a merge phase always has `conditions`, and a card of risk `high` or `critical` waits for `go` and `merge` in every flow (section 8.5). |
| `on` | mapping from `fail`, `reject` or `block` to a target | Where each non-`ok` outcome leads. |

#### Phase kinds

| Kind | Fields | What happens |
|---|---|---|
| Role phase | `role`, optionally `also` | The role (and each `also` role whose condition holds) runs and returns its artifact. |
| Gate phase | `gate` | The gate runs in the worktree. |
| Action phase | `action` | The runtime performs the action. |
| Role and action | `role` and `action` | The role runs, then the action consumes its output. `memory.update` must be used this way, with a role whose output is `reflection`. |

The four actions:

| Action | What the runtime does |
|---|---|
| `merge` | Squash-merges the card's branch into the base branch, with the card file's `status` set to `done` in the same commit (section 8.4). A merge phase always has the stop point `{when: "adjudication.conditions > 0", ask: conditions}` before any it declares, even when its flow does not name it (section 8.5). |
| `memory.update` | Applies the phase role's reflection to `memory/`, makes a `todo` card for each follow-up of an approving adjudication (section 8.3), and commits both together on the base branch (section 7.2). |
| `docs.sync` | Sends the merged documentation files matching `docs.paths` to the documentation service (section 10.3). Its detail names the changed files it did not consider because they are outside `docs.paths` (section 10.3). |
| `notify` | Notifies the owner (section 10.1). |

#### Outcomes and routing

Every executed phase ends with one of four outcomes:

| Outcome | Meaning |
|---|---|
| `ok` | The phase succeeded. The run moves to the next phase. |
| `fail` | Something did not work: the gate failed, the agent's output was invalid, the worker wrote outside its scope, the merge conflicted. |
| `reject` | An adjudicator rejected the change with instructions to fix it. |
| `block` | The work cannot continue without the owner: the brief is not ready, the worker reported itself blocked, the adjudicator blocked the card. |

Section 8.3 lists exactly which outcome each kind of phase produces. A non-`ok` outcome is routed
by the phase's `on` map; an outcome the map does not list goes to `stop`. The targets are:

| Target | Effect |
|---|---|
| `stop` | The run becomes `blocked` with the outcome's detail as the reason, and the owner is notified. |
| `continue` | The outcome is ignored and the run moves to the next phase. |
| `remediate` | The run goes back to `remediate.phase` with the outcome's detail as `{{remediation}}`, and the round number goes up by one. When the rounds are used up, the run becomes `blocked` ("remediation budget spent"). The flow must have a `remediate` block. |
| a phase id | The run jumps to that phase. The round number does not change. |

#### Example

`flows/careful.flow.yaml`. It passes `mw check` (with the role from 4.3).

```yaml
id: careful
description: Standard flow plus a lint gate, a security reviewer and a notification.
worktree: true
phases:
  - id: brief
    role: planner
  - id: implement
    role: worker
    needs: [brief]
    stop: {when: "risk >= high", ask: go}
    on: {fail: remediate, block: stop}
  - id: lint
    gate: lint
    on: {fail: implement}
  - id: gate
    gate: default
    on: {fail: remediate}
  - id: review
    role: reviewer
    also:
      - {role: security-reviewer, when: "deep_review or risk >= high"}
  - id: adjudicate
    role: adjudicator
    when: "findings.blocking > 0 or risk >= high"
    on: {reject: remediate}
  - id: merge
    action: merge
    stop:
      - {when: "adjudication.conditions > 0", ask: conditions}
      - {when: "risk >= high", ask: merge}
  - id: reflect
    role: reflector
    action: memory.update
  - id: docs
    action: docs.sync
  - id: tell
    action: notify
remediate:
  phase: implement
  max_rounds: 3
```

Read it as: the planner writes a brief; a high-risk card waits for the owner's `go`; the worker
implements; a lint failure goes straight back to the worker without spending a round, a test
failure costs a round; the routine reviewer always runs and the security reviewer joins for deep
or high-risk changes; the adjudicator runs when there is a blocking finding or the card is high
risk, and a rejection costs a round; an approval with conditions waits for `conditions`, and a
high-risk card waits for `merge`; then memory and documentation are updated and the owner is told.

#### Mistakes `mw check` catches

| Code | Mistake |
|---|---|
| `flow/yaml` | The file is not valid YAML. |
| `flow/schema` | A field is missing, unknown or has the wrong value (including an `on` key other than `fail`, `reject`, `block`). |
| `flow/file-name` | The file name is not `<id>.flow.yaml`. |
| `flow/duplicate-phase` | Two phases have the same id. |
| `flow/empty-phase` | A phase has no role, no gate and no action. |
| `flow/gate-phase` | A gate phase also has a role or an action. |
| `flow/also` | `also` on a phase without a role. |
| `flow/needs` | `needs` names a phase that is not earlier in the flow. |
| `flow/condition` | A `when`, `stop.when` or `also.when` condition is not valid (section 4.5). |
| `flow/remediate` | `remediate.phase` is not a phase of the flow, or an `on` entry targets `remediate` and the flow has no `remediate` block. |
| `flow/on-target` | An `on` entry targets something that is neither a phase nor `remediate`, `stop` or `continue`. |
| `flow/unknown-role` | A phase or `also` entry names a role that does not exist. |
| `flow/unknown-gate` | A phase names a gate that does not exist. |
| `flow/action-input` | `memory.update` is used in a phase without a role, or with a role whose output is not `reflection`. |
| `flow/merge` | A `merge` action in a flow with `worktree: false`. |
| `flow/write` | A role with `mode: write` (the phase's role or an `also` role) in a flow with `worktree: false`. |

### 4.5 The condition language

Flow conditions (`when`, `stop.when`, `also[].when`) are written in a small expression language.
It has no functions, no arithmetic and no access to anything but the variables below, so a flow
can never run code.

#### Grammar

```
expr   := or
or     := and ("or" and)*
and    := unary ("and" unary)*
unary  := "not" unary | "(" expr ")" | cmp
cmp    := VARIABLE [ OP LITERAL ]
OP     := "==" | "!=" | ">=" | "<=" | ">" | "<"
```

`not` binds tightest, then `and`, then `or`. Literals are written bare, without quotes: a risk
level, a whole number, `true`, `false`, or a word such as `docs`.

#### Variables

| Variable | Type | Value |
|---|---|---|
| `risk` | risk | The higher of the card's risk (or `risk.default`) and the brief's `risk` once a brief exists. |
| `kind` | text | The card's kind. |
| `deep_review` | yes/no | True when the card's `deep_review` is true, when one of the card's `tags` names a subject listed in `risk.deep_review`, or when the brief's `deep_review` is true. |
| `round` | number | The remediation round: 0 on the first pass, one more after each remediation. |
| `findings.total` | number | The number of findings in the latest review. Unknown before a review ran. |
| `findings.blocking` | number | The number of blocking findings in the latest review. Unknown before a review ran. |
| `gate.ok` | yes/no | Whether the latest gate passed. Unknown before a gate ran. |
| `gate.skipped` | number | How many steps of the latest gate did not run (`skipped` in its result, section 4.6). Unknown before a gate ran. |
| `gate.skipped_names` | list of names | The names of those steps. `== <name>` is true when the list holds the name, `!= <name>` when it does not. Unknown before a gate ran. |
| `adjudication.conditions` | number | The number of `conditions` of the latest adjudication when its verdict is `approve` (Appendix B.4). Unknown before an adjudication, and for `reject` or `block`. |
| `adjudication.follow_ups` | number | The number of `follow_ups` of that approving adjudication. |
| `always` | yes/no | Always true. |
| `never` | yes/no | Always false. |

#### Rules

- A yes/no variable may stand alone (`deep_review`) or be compared with `true` or `false` using
  `==` or `!=`.
- `risk` compares by rank, `low < medium < high < critical`, with all six operators. Its literal
  must be one of the four levels.
- Numbers compare with all six operators; the literal must be a whole number.
- Text (`kind`) compares only with `==` and `!=`.
- A list of names (`gate.skipped_names`) compares only with `==` (it holds the name) and `!=` (it
  does not).
- A comparison with a variable whose value is not known yet is false, whatever the operator. A
  yes/no variable that is not known yet is false when it stands alone. So
  `findings.blocking > 0` is false before any review, and so is `findings.blocking == 0`; and
  `not gate.ok` is true before any gate ran.

#### Examples

| Condition | True when |
|---|---|
| `risk >= high` | The card or its brief is high or critical risk. |
| `deep_review or risk >= high` | A deep review was asked for, or the risk is high or more. |
| `findings.blocking > 0 or risk >= high` | The review found a blocking problem, or the card is risky. |
| `kind == docs and round == 0` | A docs card on its first pass. |
| `gate.skipped > 0` | The latest gate left a step out. |
| `gate.skipped_names == db_api` | The latest gate did not run its `db_api` step. |
| `adjudication.conditions > 0` | The adjudicator approved on conditions. |
| `not (gate.ok == true)` | No gate has passed yet. |
| `never` | Never: a way to switch a phase off without deleting it. |

`mw check` reports `flow/condition` for: an unknown variable; a number, risk or text variable
used without a comparison; a literal of the wrong type (`risk >= extreme`, `round > two`); an
ordering operator on text or yes/no values; a missing value or `)`; extra tokens; and any
character outside the language.

### 4.6 Gates

A gate is the project's own definition of "good enough to merge". It is any executable file in
`gates/` named `<id>.gate.sh`; flows refer to it by id. The name ends in `.sh` by convention, but
any executable works (a shell script that calls `make`, `npm`, `cargo`, `pytest` or anything
else).

#### The contract

A gate:

1. Runs in the directory it is started in: the card's worktree during a run, or the project root
   for a flow with `worktree: false`. It must not depend on being started from anywhere else.
2. Exits `0` when every check passes and non-zero otherwise. The exit code alone decides the
   outcome.
3. Writes a JSON summary to the path in the environment variable `MERGEWRIGHT_GATE_JSON` (when
   that variable is unset, to `.mergewright/gate.json`):

   ```json
   {"ok": true, "steps": [{"name": "pytest", "kind": "test", "ok": true, "seconds": 12, "log": "/path/to/pytest.log"}]}
   ```

   `ok` is the overall result; each step has a name, a kind (`lint`, `types`, `test`, `build`,
   `security` or another word), its result, its duration in seconds and the path of its log.
   A gate that writes no JSON still counts by its exit code; the runtime then writes a summary
   itself. That holds only while `gate.required` is empty: when it names steps, the gate fails
   closed. A gate that exits 0 but writes no JSON, JSON that does not parse, or JSON without a
   boolean `ok` and a `steps` list fails with `gate/required-missing` (the detail says the summary is
   missing or malformed), and no passing step is made up for it. Each step needs a string `name` and
   a boolean `ok`; a step without them is reported as malformed in the result's `warnings`, is
   dropped from the stored steps and satisfies no required step, even when its name matches. Other
   fields a step carries (such as a `tests` object of counts) are kept unchanged.

   A step the gate did not run (a tool or a variable it needs is missing on this machine) is
   reported with `"skipped": true` and a `"reason"` (or with the reason as the value of
   `skipped`), for example `{"name": "db_api", "kind": "test", "ok": true, "skipped": true,
   "reason": "DATABASE_URL not set"}`. The runtime keeps `skipped: true` and the reason (its first
   line, at most 200 characters, credentials redacted). A skipped step does not change the exit
   code's verdict, but it is never silent: the gate's detail ends with "NOT run: <name> (<reason>)",
   the prompts that show the gate (`{{gate}}`: the reviewers and the adjudicator) list it as
   "Gate steps NOT run: ...", flows can test it (`gate.skipped`, `gate.skipped_names`), and a step
   named in `gate.required` that was skipped fails the gate (`gate/required-skipped`, section 8.3).
   Every step `gate.required` names must appear in the summary exactly once, well formed, not
   skipped and with `ok: true`: a required step that is absent or listed twice fails the gate with
   `gate/required-missing`, and one that reports `ok: false` fails it even when the gate exited 0. The
   shipped default gate has a helper for it: `skip <kind> <name> <reason>`.
4. Writes step logs under the directory in `MERGEWRIGHT_GATE_LOGS` (default: `gate-logs/` next to
   the JSON file). During a run, each step's `log` must be a regular file whose real path lies
   inside that directory. When the gate finishes, the runtime copies each such log redacted into
   the run directory's `gate-logs/` (section 8.3), points `log` at the copy and copies the end of it
   (bounded, credentials redacted) into the step as `tail`; a `log` that names anything else (a
   path outside the folder, a symbolic link, a folder, a missing file) is dropped from the step and
   a warning is added to the result. Prompts and failure details use these copies, never the log
   files, so a log changed afterwards changes nothing.
5. Leaves no background process behind. The gate runs in a process group of its own, and when its
   main process exits, however it exits, the runtime ends the rest of that group before it reads the
   result: nothing when the group is already gone (no wait), otherwise SIGTERM, a grace period of
   5 seconds, then SIGKILL. A process that survives even that is recorded and handled as in
   section 8.7. So a child the gate started (`sleep 300 &`, a server, a watcher) cannot change the
   worktree after the gate passed. Reaping never changes the outcome: that still comes from the
   exit code and the summary alone. A gate that needs a service must start and stop it itself
   within its run; a tool that daemonises out of the gate is stopped, by design.

The runtime also sets `MERGEWRIGHT_BASE` to the base branch, so a gate can examine only the
change (the shipped security gate does). A gate run is limited to `limits.minutes`.

When the runtime stores a gate's result as the run's `gate` artifact, it adds the commit the gate
judged (`head`) and the base commit the gate ran against (`base`): the commit of the base branch the
judged tree builds on, that is where the card branch left the base (`git merge-base <base> <head>`;
for a flow with `worktree: false`, the judged commit itself). The merge compares `base` with the base
it merges onto and runs the gate again on the merged tree when the base has moved (section 8.4,
REQ-gate-004). An artifact without `base` (written by an older runtime) is read as before;
its base counts as moved.

A gate runs code that a worker may have changed, so it gets a minimal environment, not the
runtime's: the basic variables a program needs (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR` and
similar), every `MERGEWRIGHT_*` variable, and only the variables the owner lists in `gate.env`.
Integration secrets loaded by the runtime never reach a gate. A gate's output and log tails that
go into a prompt are passed through the same credential redaction as reflections (section 7.2). The shipped
default gate also honours `MERGEWRIGHT_GATE_KINDS=lint,test`, which runs only the steps of those
kinds (the `lint` and `test` gates use it); that variable is a convention of the shipped gates, not
part of the contract.

A gate must be executable (`chmod +x`). Never weaken a gate to make a card pass: a failing gate is
reported, and the flow decides whether to remediate.

`mw init` copies the preset's `default` gate into `gates/default.gate.sh`, because every project
is expected to make its gate its own. As shipped, it detects common stacks (a `make check`
target, Node, Python, Rust, Go, shell scripts) and runs their standard checks, and it fails when
no check applies, so a project cannot pass a gate that checks nothing.

#### Example

`gates/default.gate.sh` for a Python project. It passes `mw check`.

```bash
#!/usr/bin/env bash
# Gate for the shop: lint, then tests. Contract: exit 0 only when every step passes,
# and write the JSON summary to $MERGEWRIGHT_GATE_JSON.
set -uo pipefail
OUT=${MERGEWRIGHT_GATE_JSON:-.mergewright/gate.json}
LOGS=${MERGEWRIGHT_GATE_LOGS:-$(dirname "$OUT")/gate-logs}
mkdir -p "$LOGS" "$(dirname "$OUT")"
steps=(); failed=0

step() {  # step <kind> <name> <command...>
  local kind=$1 name=$2; shift 2
  local log="$LOGS/$name.log" t0=$SECONDS ok=true
  "$@" >"$log" 2>&1 || { ok=false; failed=1; }
  steps+=("{\"name\":\"$name\",\"kind\":\"$kind\",\"ok\":$ok,\"seconds\":$((SECONDS - t0)),\"log\":\"$log\"}")
}

step lint ruff ruff check .
step test pytest python3 -m pytest -q

ok=true; [ $failed = 0 ] || ok=false
(IFS=,; printf '{"ok":%s,"steps":[%s]}\n' "$ok" "${steps[*]}") > "$OUT"
exit $failed
```

#### Mistakes `mw check` catches

| Code | Mistake |
|---|---|
| `gate/not-executable` | A gate file is not executable. |
| `flow/unknown-gate` | A flow names a gate that does not exist. |
| `layout/stray-file` (warning) | A file in `gates/` does not end with `.gate.sh`. |

### 4.7 MCP servers

An MCP server gives agents extra tools (documentation search, a browser, an issue tracker). Each
server is described once, in `mcps/<id>.mcp.yaml`, and the runtime turns that description into
whatever each harness understands.

#### Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | id | yes | The server's id; the file is `mcps/<id>.mcp.yaml`. |
| `description` | string | no | Shown by `mw mcps`. |
| `transport` | `stdio` or `http` | yes | `stdio`: a local process the agent starts. `http`: a remote server. |
| `command` | string | for `stdio` | The program to start. |
| `args` | list of strings | no | Its arguments. |
| `url` | string | for `http` | The server's URL. |
| `env` | mapping of name to string | no | Environment for a `stdio` server. |
| `headers` | mapping of name to string | no | HTTP headers for an `http` server. |
| `roles` | `all`, or a list of role ids | no | The roles that get this server without asking for it. Absent: only roles that name it in their `mcps`. |
| `enabled` | boolean | no | `false` switches the server off for every role. Default `true`. |

#### Which roles get a server

A role gets every enabled server that either offers itself to the role (`roles: all`, or the
role's id in `roles`) or that the role asks for by name (its `mcps` list). `mw mcp show <role>`
prints the resulting list and configuration, with every resolved `env` and `headers` value hidden.

#### Secrets

Secrets are never written into an MCP file. In `env` and `headers`, any entry whose name contains
`key`, `token`, `secret`, `password`, `passwd`, `auth`, `credential`, `cookie`, `session`, `bearer`
or `signature` (in any case), and any entry whose value starts with `Bearer `, `Basic ` or
`Token ` followed by text, must have a value that is exactly an environment reference, `${NAME}`,
or `Bearer ${NAME}`. The list is deliberately broad: a false alarm only asks for an environment
reference. References of
the form `${NAME}` are allowed in every value and are replaced from the environment when a role
starts. If a referenced variable is not set, the role does not start (`mcp/env`). The variables a
server references are also passed through to the agent process, for servers that read them
directly.

#### Per-harness wiring

| Harness | How servers are given to the agent |
|---|---|
| `claude` | A generated `mcpServers` JSON file, passed with `--mcp-config <file> --strict-mcp-config`, so the agent gets exactly the role's servers and none of the user's own. The servers' tools are allowed as `mcp__<id>`. The file holds resolved values, so it is written to this machine's unsynced `.mergewright/local/scratch/<CARD>/` (mode 0600, folder 0700), never into the run directory, and removed when the phase ends, however it ends; a run of the card removes what a hard-killed run left there before it starts an agent. |
| `codex` | `-c` overrides: `mcp_servers.<id>.command`, `.args`, `mcp_servers.<id>.env_vars` for `stdio`; `mcp_servers.<id>.url`, `.env_http_headers` for `http`. Only the command, its arguments and the URL go on the command line; no `env` or header value does, whether it is literal or comes from a `${NAME}` reference. Every such value is passed in the Codex process's environment and named in the overrides: `mcp_servers.<id>.env_vars` lists the `env` keys (the variable has the key's name), and `mcp_servers.<id>.env_http_headers` maps each header to a variable `MW_MCP_<ID>_<HEADER>`. Two servers of one role that give one `env` key different values are refused (`mcp/env`). |
| `shell` | The path of the generated `mcpServers` JSON file in the environment variable `MW_MCP_CONFIG`; the file is written and removed as for `claude`. |
| a package's | None: the engine passes a package harness no servers (`hermes` uses the ones in Hermes's own configuration). `mw check` warns (`role/mcp-unsupported`). |
| `local` | None: the local harness is a plain chat endpoint. `mw check` warns (`role/mcp-unsupported`). |

#### Example

`mcps/docs.mcp.yaml`, a remote server offered to two roles:

```yaml
id: docs
description: Search the project's documentation notebook.
transport: http
url: http://services.example.com:5055/mcp
headers:
  Authorization: "Bearer ${NOTEBOOK_TOKEN}"
roles: [worker, reviewer]
```

`mcps/browser.mcp.yaml`, a local server offered to every role but currently switched off:

```yaml
id: browser
description: Headless browser for checking pages.
transport: stdio
command: npx
args: ["-y", "@playwright/mcp", "--headless"]
env:
  PLAYWRIGHT_BROWSERS_PATH: /opt/browsers
roles: all
enabled: false
```

Both pass `mw check`. The first could also be created with
`mw mcp add docs --url http://services.example.com:5055/mcp --header 'Authorization=Bearer ${NOTEBOOK_TOKEN}' --roles worker,reviewer --description "Search the project's documentation notebook."`.

#### Mistakes `mw check` catches

| Code | Mistake |
|---|---|
| `mcp/yaml` | The file is not valid YAML. |
| `mcp/schema` | A field is missing, unknown or has the wrong value. |
| `mcp/file-name` | The file name is not `<id>.mcp.yaml`. |
| `mcp/command` | `transport: stdio` without a `command`. |
| `mcp/url` | `transport: http` without a `url`. |
| `mcp/literal-secret` | A secret-looking `env` or `headers` entry (by name, or by a `Bearer`, `Basic` or `Token` value) holds a literal value instead of an environment reference. |
| `mcp/unknown-role` | `roles` names a role that does not exist. |
| `role/unknown-mcp` | A role's `mcps` names a server that does not exist. |

## 5. Presets

A preset is a shipped set of roles, flows, gates and MCP servers. A project names one in
`extends` and inherits all of it. Version 0.1 ships one preset, `standard`. It has no MCP servers.

### 5.1 The `standard` preset

Roles:

| Role | `runs` | Model | Mode | Output | Limits | Job |
|---|---|---|---|---|---|---|
| `planner` | `claude` | `sonnet` | `advise` | `brief` | 15 min | Turns a card into the brief that bounds the worker: narrowest scope, verbatim acceptance criteria, guards, documents, risk, whether it is ready. A card whose change would make a document outside the card's scope wrong is refused (`ready: false`, naming the path the owner must add to the scope). |
| `worker` | `claude` | `opus` | `write` | `handoff` | 60 turns, 90 min | Implements the card inside its brief, links tests with `@req`, updates the listed documents, runs the gate. When the work needs a path outside its scope (a document its change makes wrong included), it does not touch it: it finishes what is in scope and hands off `blocked`, naming the path. |
| `docs-writer` | `claude` | `sonnet` | `write` | `handoff` | 40 turns, 45 min | Writes or corrects documentation for a `docs` card, checking every statement against the code; runs the format check and the tests touching the changed files before handing off, and the whole gate again in a remediation round. |
| `reviewer` | `codex` | `gpt-5.6-terra` | `read` | `findings` | 30 min | Routine independent review of the diff against the criteria. Finding ids `R-nn`. |
| `reviewer-deep` | `codex` | `gpt-5.6-sol` | `read` | `findings` | 30 min | Deep review: concurrency, transactions, caching, authentication, data loss, load, contracts. Finding ids `D-nn`. |
| `redteam` | `codex` | `gpt-6-astra` | `read` | `findings` | 30 min | Asks how the change could fail in production despite passing its gates. Finding ids `X-nn`. The `standard` flow adds it to the review when `risk >= critical`. |
| `adjudicator` | `claude` | `sonnet` | `advise` | `adjudication` | 15 min | Decides which findings are real and whether the card is approved, sent back with instructions, or blocked. |
| `reflector` | `claude` | `sonnet` | `advise` | `reflection` | 10 min | Rewrites the project state and records the outcome, lessons and decisions after a card. |

The worker runs on Claude and the reviewers on Codex, so that different vendors check each other.
The planner, adjudicator and reflector are advisory and run on Claude (`sonnet`), so a new project
needs only the Claude Code and Codex CLIs. Which agent and model fill each role is a project
decision: `roles.<id>` in `mergewright.yaml` (section 5.3) changes it, for example `runs: codex`, or `runs: hermes` once the `hermes` package is
installed (section 15).

Flows:

| Flow | Phases | Remediation | Use |
|---|---|---|---|
| `standard` | `brief` (planner), `implement` (worker, needs brief, stops for `go` when `risk >= high`), `gate` (default), `review` (reviewer, plus reviewer-deep when `deep_review or risk >= high`, plus redteam when `risk >= critical`), `adjudicate` (when `findings.blocking > 0 or risk >= high`), `merge` (stops for `conditions` when the adjudicator approved on conditions, then for `merge` when `risk >= high`), `reflect` (reflector + `memory.update`, which also makes the adjudicator's follow-ups cards), `docs` (`docs.sync`) | to `implement`, 2 rounds; implement and gate failures and rejections remediate | Every card by default. |
| `quick` | `implement`, `gate`, `review`, `adjudicate` (when `findings.blocking > 0`), `merge`, `reflect`, `docs` (`docs.sync`); the same stop points | to `implement`, 1 round | Small low-risk cards. No brief: the card's own scope is the boundary. Chosen only by `flow: quick`. |
| `docs` | `write` (docs-writer), `gate`, `review`, `adjudicate` (when `findings.blocking > 0`), `merge` (stops for `conditions`), `reflect` (reflector + `memory.update`), `sync` (`docs.sync`) | to `write`, 2 rounds; write and gate failures and rejections remediate | Cards of kind `docs`. The docs-writer runs the project's format check and the tests touching the files it changed before handing off, and in a remediation round re-runs the whole gate (`gates/<id>.gate.sh`) when the script is available. |
| `spike` | `explore` (worker), `reflect` | none | Cards of kind `spike`: explore on a branch and report. Never merges; the branch is kept for reading. |

The stop points listed are the ones the flows declare. Whatever the flow, the runtime also stops a
card of risk `high` or `critical` for `go` before its first writing phase and for `merge` before its
merge phase (section 8.5), so the `docs` flow waits for both and the `spike` flow for `go`.

Gates:

| Gate | Checks |
|---|---|
| `default` | Detects the stack and runs its lint, type, test and build steps; fails when nothing applies. Copied into every project by `mw init`. |
| `lint` | Only the `lint` steps of the default gate (the project's `gates/default.gate.sh` when present). |
| `test` | Only the `test` steps of the default gate. |
| `security` | Scans the lines the change adds for secrets (needs only git), then runs `npm audit`, `pip-audit` or `cargo audit` when available. |

### 5.2 Overriding and `mw eject`

Project files override preset files of the same id: a project's `roles/worker.role.md` replaces
the preset's `worker` role entirely, and so on for flows, gates and MCP servers. There is no
merging of fields between the two; the project's file is the whole definition. Files with new
ids add to the preset's.

`mw eject <role|flow|gate|mcp> <id>` copies a preset file into the project so it can be changed.
It refuses when the project already has that file. An ejected gate stays executable. `mw roles`,
`mw flows`, `mw gates` and `mw mcps` show each item's origin: `project` or the preset's name.

### 5.3 Per-role overrides in the configuration

To change only how a role runs, without copying its file, set `roles.<id>` in `mergewright.yaml`:

```yaml
roles:
  worker: {model: sonnet}
  reviewer: {runs: shell, command: "my-agent --json"}
```

The keys `runs`, `model`, `provider`, `profile` and `command` replace the role's values. Other
role fields (mode, output, limits, MCP servers, prompt) need an ejected role file. An override of
a role that does not exist is an error (`config/role-override`). The checks of section 4.3
(`role/mode`, `role/command`, `role/profile`) are made again on the overridden role and reported
against `mergewright.yaml`: an override that, for example, moves a writing role to `local` is an
error.

## 6. Tracing

Tracing connects each requirement to the cards that implement it and the tests that verify it:

```
requirement (specs/)  ->  cards that implement it (cards/, implements:)  ->  tests that reference it (@req)
```

### 6.1 The `@req` comment

A test is linked to a requirement with a plain comment that works in any language:

```python
# @req REQ-checkout-001
def test_charges_saved_card_once():
    ...
```

The marker is `@req`, optionally followed by spaces or a colon, then one or more requirement ids
separated by spaces or commas: `// @req REQ-auth-001, REQ-auth-002`. The comment syntax around it
does not matter.

The runtime searches the project with `git grep`, including untracked files and honouring
`.gitignore`; outside a git repository it walks the folder tree, skipping `.git`, `node_modules`,
`.mergewright`, `dist`, `build`, `target`, `.venv`, `venv`, `__pycache__`, `.next` and `.cache`, and
files over 2 MB. In both cases it ignores the reserved folders (section 2.2), `.mergewright/`, and
paths matching `trace.ignore`.

A reference counts as a test when its file matches `trace.tests`. A reference in any other file
is recorded but does not verify anything. Globs use Node's `path.matchesGlob` rules, and a glob
ending in `/**` also matches everything below that folder.

### 6.2 Coverage

Each requirement has one coverage state:

| State | Condition |
|---|---|
| `deprecated` | The requirement is deprecated. |
| `unplanned` | No card implements it. |
| `planned` | Cards implement it, but none is `done`. |
| `built` | At least one implementing card is `done`, and no test references it. |
| `verified` | At least one implementing card is `done`, and at least one test references it. |

`mw trace` prints one line per requirement (id, coverage, priority, cards with their status,
number of tests, title), then any reference to an unknown requirement, then a summary.
`mw trace --json` prints the same as JSON: a `requirements` list (id, title, priority, rev,
coverage, cards, tests as `file:line`) and a `dangling` list.

### 6.3 What `mw check` enforces

- Every `@req` comment must name a requirement that exists (`trace/unknown-requirement`).
- When `trace.require_tests` is `must`, every `built` requirement of priority `must` is an error
  (`trace/untested`): a finished card delivered it, and no test proves it. With `should`, the same
  applies to `should` requirements too. With `none`, nothing is required.

## 7. Managed updates

Some files change only through defined operations, so that their form stays valid and their
history stays meaningful: memory, specs (through change proposals), the managed fields of cards,
and the configuration. This section defines each operation. Every operation here is built and
available as an `mw` command.

### 7.1 Who may do what

| Change | Owner | Agent in a run | Runtime |
|---|---|---|---|
| Write product code inside the card's scope | yes | yes, in the card's worktree | commits it |
| Write a protected path | yes | only when the card's `allow_protected` matches | |
| Propose a spec change (`mw spec propose`) | yes | yes | |
| Accept a spec change (`mw spec accept`) | yes, from the main checkout | refused | |
| Reject a spec change (`mw spec reject`) | yes | refused | |
| Replace `memory/STATE.md` (`mw memory state`) | yes | refused: returns a reflection | applies the reflection (`memory.update`) |
| Add lessons and decisions (`mw memory add`) | yes | refused: agents report what they learned in their handoff, and the reflection files it | applies the reflection |
| Change `memory/RULES.md` | yes, by hand | no (protected) | |
| Change a card's `status` to `done` | yes | no | inside the merge commit |
| Change a card's `revs` (`mw card ack`) | yes | refused | |
| Change `mergewright.yaml` (`mw config set`, `unset`) | yes | refused (and protected) | |
| Copy a preset file (`mw eject`), add or remove an MCP server (`mw mcp add`, `remove`) | yes | refused (and protected) | |
| Change roles, flows, gates by hand | yes | no (protected) | |
| Merge, push, approve a stop point | approve only | no | merges and pushes |

"Agent in a run" is recognised in two ways: the command runs inside a card worktree
(`.mergewright/worktrees/`), or the environment variable `MW_ROLE` is set, which the runtime sets
for every agent process. `mw spec accept` refuses in both cases; `mw spec reject`,
`mw card ack`, `mw memory state`, `mw memory add lesson` and `decision`, `mw config set` and `unset`, `mw eject`, `mw mcp add` and
`mw mcp remove` refuse when `MW_ROLE` is set (code `owner-only`), telling the agent to put what it
needs in its handoff. So do `mw tui`, the `hermes` package's `mw hermes` and every tool of the MCP server that writes
(section 12.2). The Claude harness additionally forbids its agents most `mw` commands and
every git command that changes history, branches or configuration (section 8.6).

### 7.2 Memory

#### Layout

```
memory/
├── STATE.md                   always loaded; where the project is now; capped
├── RULES.md                   always loaded; standing rules; owner-controlled; capped
├── INDEX.md                   always loaded; generated; one line per file below
├── lessons/<topic>.md         on demand; one "## Title" entry per lesson
├── decisions/<date>-<slug>.md on demand; one owner decision or settled dispute per file
└── outcomes/<CARD>.md         on demand; what a finished card delivered
```

The three always-loaded files are the only memory placed into prompts by default
(`{{memory.state}}`, `{{memory.rules}}`, `{{memory.index}}`). Everything else is read on demand:
an agent opens a file when its index line is relevant, and `{{memory.recall}}` brings in the
few entries that match the card. `mw memory show` prints the always-loaded memory and estimates
its size in tokens.

#### Caps

`STATE.md` may have at most `memory.state_max_lines` lines (default 150) and `RULES.md` at most
`memory.rules_max_lines` (default 100), because both are paid for in every prompt. A file over its
cap is an error (`memory/too-long`), and so is a missing file (`memory/missing`). Replacing the
state with text over the cap is refused and changes nothing. The state must start with a `# `
heading.

#### File forms

A lesson file holds the lessons of one topic. Its name is the topic as a slug. Each lesson is a
`## ` section whose title states the rule, followed by the reason and the metadata lines the
runtime adds:

```markdown
# Payments

## Pass the order id as the idempotency key

SHOP-12 charged a card twice in a test when the key was a random value. The order id is stable across retries.

- added: 2026-10-05
- card: SHOP-12
```

Adding a lesson whose title matches an existing one (ignoring case, spacing and punctuation)
replaces that entry in place instead of adding a second one, so lessons are updated rather than
piled up. Every other entry of the file is kept as it is. `## ` lines inside code fences are text,
not entries.

A decision file is named `<date>-<slug of title>.md` (a suffix `-2`, `-3` is added when the name
is taken). Recording a decision with the same title for the same card again replaces that card's
file instead of creating a second one, so a repeated reflection does not duplicate decisions:

```markdown
# Saved cards stay with the provider

- date: 2026-10-05
- card: SHOP-11

We never store card numbers. The provider holds them; we keep its token.
```

An outcome file is named after the card: `# <CARD> <title>`, a `- finished: <date>` line, and the
outcome text.

#### The index

`memory/INDEX.md` is generated and must not be edited by hand. It has three sections:

```markdown
# Index

<!-- Generated by `mw memory index` from the files in memory/. Do not edit. -->

## Lessons
- lessons/payments.md: Pass the order id as the idempotency key

## Decisions
- decisions/2026-10-05-saved-cards-stay-with-the-provider.md: Saved cards stay with the provider

## Outcomes
- outcomes/SHOP-12.md: Charge a saved card at checkout
```

A lesson line lists all lesson titles of the file, separated by `; `. Every `mw memory` command
that adds an entry regenerates the index; `mw memory index` regenerates it explicitly. When the
index does not match the files, `mw check` warns (`memory/index-stale`).

#### Search

`mw memory search <words>` (and `{{memory.recall}}`) ranks lessons, decisions and outcomes by
keyword: the query is split into words of three or more characters, common words are dropped,
and each word scores 3 when it appears in an entry's title and 1 when it appears in its text.
The best five entries are returned. When a semantic store is configured (an enabled package such as
`mem0`, section 10.2, or Letta, section 10.9), its hits are added to the recall.

`mw docs search <words>` applies the same ranking to the documentation: each tracked file matching
`docs.paths` and not `docs.exclude` is one entry, its title the file's first `# ` heading (else its
first non-empty line), its text the whole file. Symbolic links, files over 1 MB and files holding a
NUL byte are skipped. There is no index: the files are read on each search.

#### The semantic stores

The memory stores of enabled packages (such as `mem0`, section 10.2, and `letta`, section 10.9) are
mirrors of the lessons and decisions in `memory/`. A store's name is its package's name. They are
used in the order `packages:` lists them. Besides the reflect phase (below), two owner commands reach them:

- `mw memory add lesson|decision` writes the entry, regenerates the index, then stores the entry in
  each configured store and prints where it went, for example `stored in mem0, queued for letta
  (down: ...)`. A decision is stored like a lesson with the topic `decision`. A store that does not
  answer gets the entry queued on this machine, as the reflect phase queues lessons (kind: the
  store's name, e.g. `mem0` or `letta`; `mw queue flush` delivers them). The MCP tool `mw_memory_add` runs under the
  repository lock (section 12.5), so it never waits for a store there: it records the entry in this
  machine's queue for each configured store and replies that it is queued; the delivery, through the
  same deliverers and as idempotent, starts once the transaction has released the lock and the lease;
  when this machine keeps the lease (a run of it is active), the entry stays held for the server's
  process and the next queue flush after that process ends delivers it, and the reply says so
  (section 12.5, REQ-engine-008).
- `mw memory push [--lessons] [--decisions] [--service NAME]` (and `mw_memory_push`) sends
  every lesson and every decision in `memory/` (both kinds when neither flag is given) to every
  configured store, or to the one named, and prints per store how many were stored, already
  present, queued and failed. It is how a project whose memory predates its stores (a migration)
  fills them. Exit 1 when a store refused a record.
- `mw memory prune --service NAME --match TEXT [--dry-run]` (owner) deletes from that store
  (an enabled package whose store can delete records, such as `mem0` or `letta`) the records of
  this project (mem0: its namespace; Letta: its agent's archive) whose text contains TEXT
  (case-sensitive, at least 3 characters; in mem0 a lesson's title, kept in its metadata, counts as
  part of its text), and prints each one it deleted (id and the start of its text) and the count;
  `--dry-run` prints what it would delete. It is for
  leftovers of tests and wrong entries; `memory/` is not touched.

Both are idempotent. Every record has the stable id of section 10.2 (`lesson_id`, from project,
topic and title); a store that already holds a record with that id and the same text (ignoring
spacing) is not sent it again, and a record already waiting in the queue is not queued twice. mem0
is asked with one listing of the namespace (`top_k` 1000, the most mem0 allows) and, only when that listing was cut
short, a search filtered on the `lesson_id` for what it lacks; Letta with one
listing of the agent's archive, paginated (`GET /v1/agents/{id}/archival-memory?limit=500&after=`),
checked locally by the `lesson_id:<id>` tag and the text, and with a search restricted to that tag
per record only when the server gives no listing. Queue replay, one record at a time, asks the same
way once per queued item. A lesson whose text
changed is stored again (the store then holds both versions; the files stay the source of truth).
The file's own metadata lines (`- added:`, `- date:`, `- card:`) are not part of the stored text;
the card becomes metadata. A store that answers with an error for one record (HTTP 4xx) counts it
as failed and the rest continue; a store that does not answer gets that record and the rest queued.

#### Reflection

After a card, the reflector role returns a reflection (Appendix B): the complete new state, the
card's outcome, zero or more lessons and zero or more decisions. The runtime applies it in this
order: it replaces `STATE.md` (validated first, so a state over the cap changes nothing at all),
writes `outcomes/<CARD>.md`, adds each lesson to `lessons/<topic>.md` and each decision to a new
decision file (both tagged with the card), and regenerates the index. The model writes no files
itself. Before anything is written, everything that looks like a credential (private keys, cloud
and forge tokens, `Bearer` tokens, `api_key: ...`, `password = ...` and similar assignments) is
replaced with `[redacted]`: a secret a worker happened to see is never written into memory.

In a run, the `memory.update` action does this in the main checkout. If `memory/` has uncommitted
changes there (the owner's edits), nothing is applied and the outcome is `block`, naming the files:
commit or discard them and run the card again. The card is already merged at that point, so nothing
is lost. Otherwise the action computes every new file, checks `memory/` once more immediately
before writing (an edit made in the meantime blocks it the same way, and nothing is written), then
writes all the files in one step, commits exactly the files it wrote (never the whole folder) on the base branch with the message `<CARD>: update project memory`, pushes the base
branch to the hub, and records the card's lessons in this machine's queue, one item per configured
semantic store (kind: the store's name, section 10), without sending anything: the run still holds
its lock and the lease (REQ-engine-008). Each item is held for the `mw` process that recorded it
(section 10), so no other flush delivers it while that process holds the lock and the lease. The
queue retry that `mw run` and `mw approve` make after the lease is released, and that `mw work`
makes between cards (section 8.9), first releases the holds of these items, and only these, then
delivers them. If the state is too long, the reflector is asked
once more with the error appended (after the usage guard of section 10.7, when the reflector is on
a paid harness: while usage is too high it is not asked again, a warning names the usage detail,
and the update goes on as below); if the second state is still too long, everything except the
state is applied and a warning is recorded in the run history. Any other problem applying the
reflection becomes a warning, not a failure.

### 7.3 Spec change proposals

Specs are protected. A spec changes through a proposal file that anyone (including an agent) may
write and only the owner may accept. Accepting it rewrites the spec, raises the revision of every
requirement it touches, and lists the cards that were written against the old revision.

#### The change file

A proposal lives in `specs/changes/` and is named `CHG-<n>-<slug>.change.md` (or
`CHG-<n>.change.md`). Front matter:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `CHG-<n>` | yes | The change id. |
| `spec` | spec id | yes | The spec it changes. One proposal changes one spec. |
| `status` | `proposed`, `accepted` or `rejected` | yes | Written as `proposed`; the runtime changes it. |
| `summary` | string | yes | One line. |
| `by` | string | no | Who proposed it (the role id when an agent proposed it). |
| `date` | `YYYY-MM-DD` | no | When it was proposed. |
| `accepted` | `YYYY-MM-DD` | no; written by the runtime | When it was accepted. |
| `rejected` | `YYYY-MM-DD` | no; written by the runtime | When it was rejected. |
| `reason` | string | no; written by the runtime | Why it was rejected. |

The body is markdown divided into `## ` sections. A `## Why` section explaining the change is
expected; it and any other section whose heading is not an operation are free text. HTML comments
are ignored. The operations are:

| Section heading | Content | Effect when accepted |
|---|---|---|
| `## modify REQ-<spec>-<nnn>` | Exactly one requirement block, in the spec grammar, with the same id as the heading. | Replaces the whole requirement block (heading, lines and any prose up to the end of the block). Its revision becomes the old revision plus one. A deprecated requirement stays deprecated. |
| `## add` | Exactly one requirement block with a new id. | Appended at the end of the spec, at revision 1. |
| `## deprecate REQ-<spec>-<nnn>` | Optional text: the reason. | The requirement keeps its text, gets `- status: deprecated` and the old revision plus one, and the line `Deprecated by CHG-<n>: <first line of the reason>` is added after it. |

`rev` and `status` lines written inside a `modify` or `add` block are ignored: only the runtime
sets them. A proposal may contain any number of operations, but each requirement may appear in only
one of them. Accepting writes the spec and the proposal together: either both change or neither
does.

#### Example

`specs/changes/CHG-2-limit-charge-retries.change.md`, against the spec in section 4.1. It passes
`mw check`.

```markdown
---
id: CHG-2
spec: checkout
status: proposed
summary: Limit charge retries and add a receipt
by: planner
date: 2026-10-05
---

## Why

A declined card was retried without limit during SHOP-12, and customers asked for receipts.

## modify REQ-checkout-001
### REQ-checkout-001 Pay with a saved card
- priority: must
- AC-1: Given a signed-in customer with a saved card, when they confirm the order, then the card is charged exactly once.
- AC-2: Given a charge the bank declines, when the customer confirms the order, then the order stays open and the customer sees the reason.
- AC-3: Given three declined charges for one order, when the customer confirms again, then no charge is attempted.

## add
### REQ-checkout-004 Email a receipt
- priority: should
- AC-1: Given a paid order, when the charge succeeds, then the customer receives a receipt by email.

## deprecate REQ-checkout-003
Gift wrapping moved to the fulfilment spec.
```

After `mw spec accept CHG-2`, `REQ-checkout-001` is at `- rev: 3` with three criteria (its old
closing paragraph is gone, because `modify` replaces the whole block), `REQ-checkout-003` reads
`- rev: 2`, `- status: deprecated` followed by `Deprecated by CHG-2: Gift wrapping moved to the
fulfilment spec.`, `REQ-checkout-004` is appended, the proposal's status is `accepted` with
today's date, and the command reports `SHOP-12` as a stale card.

#### Commands

- `mw spec propose <spec> --summary <text> [--file <body.md>] [--by <who>]` creates the next
  `CHG-<n>` file. With `--file`, the body is taken from that file and the proposal is validated
  first: an invalid proposal is refused and nothing is written. Without `--file`, a skeleton with
  commented examples is written, and `mw check` reports it as empty (`change/empty`) until it has
  operations. `--by` defaults to the value of `MW_ROLE`.
- `mw spec accept <CHG>` applies a proposed change. It is refused inside a card worktree or when
  `MW_ROLE` is set, for a change that is not `proposed`, and for a change that is not valid against
  the current specs. It prints the requirements changed and the stale cards.
- `mw spec reject <CHG> [--reason <text>]` marks a proposed change `rejected` with the date and
  reason. The spec does not change.
- `mw spec list` lists the specs (id, status, number of requirements, title) and the changes.

#### Mistakes `mw check` catches

`mw check` validates the form of every change file, and checks proposed changes (not accepted or
rejected ones) against the specs as they are now.

| Code | Mistake |
|---|---|
| `change/front-matter` | The file does not start with a valid front matter block. |
| `change/schema` | A front matter field is missing, unknown or has the wrong value. |
| `change/file-name` | The file name does not start with `<id>-` and is not `<id>.change.md`. |
| `change/op` | An operation is malformed: `deprecate` without a requirement id; `modify` without an id, or with a block for a different requirement; a `modify` or `add` that does not contain exactly one requirement block; an `add` whose id already exists (the message names the next free id); a `modify` or `deprecate` of a requirement that is not in the spec; a requirement that appears in more than one operation of the same change. |
| `change/empty` | A proposed change has no operations. |
| `change/unknown-spec` | `spec` names a spec that does not exist. |
| `change/<spec code>` | A requirement block inside an operation breaks the spec grammar. The code is the spec code with `change/` in place of `spec/`, for example `change/criterion-form` or `change/priority`. |

### 7.4 Card revisions and `mw card ack`

A card records, in `revs`, the revision of each requirement it implements at the time it was
written. `mw card new` fills it in. When an accepted change raises a requirement's revision above
what a card recorded, `mw check` warns that the card is stale (`card/stale`). The owner (or a
planner, in a new card) reviews the card against the new requirement, edits it if needed, and
runs `mw card ack <ID>`, which sets `revs` to the current revisions and removes the warning.
Agents cannot acknowledge (`owner-only`).

`mw card new --title <title> [--kind K] [--implements REQ,...] [--scope glob,...] [--risk R]
[--flow F] [--depends ID,...] [--why <text>]` creates the next card number with status `todo`, the
recorded revisions, a `## Why` section (with the given text or a placeholder) and an
`## Out of scope` section. It refuses requirements that do not exist, and, when
`trace.require_implements` is true, a card of kind `feature` (the default kind) without
`--implements`, with the message `mw check` gives for `card/no-requirement` and nothing written;
`--kind chore`, `fix`, `docs` or `spike` need no requirement. (`mw_card_new` does not refuse it; `mw
check` reports such a card.)

`mw card new` and `mw card status <ID> todo|ready` write the card file and leave committing it to
the owner; `mw card status` says that the file is not committed. With `--commit` (REQ-cards-006)
either command commits the card file alone on the base branch, in the same transaction the MCP card
tools use (section 12.5): the repository lock and, on a project with a hub, the lease, the hub's
history adopted first and the commit pushed to the hub fenced by the lease. The commit subject is
the runtime's own, `card: <ID> <title>` for a new card and `card: <ID> <status>` for a status. The
command refuses, before anything is written, a status other than `todo` or `ready` (`card/status`),
a card with lint errors for `ready` (`card/not-ready`), a checkout that is not on the base branch
(`card/branch`), git without an identity (`git/identity`) and an index that holds staged changes to
any other file (`card/staged`). The confirmation line names the commit and, on a project with a hub,
says that it is on the hub; it replaces the not-committed warning. `mw card status --commit` sets a
blocked or aborted run of the card aside only after the card file is committed, still under the
lock and the lease, so a commit that fails restores the card file and its index entry and leaves the
run, its record, its worktree and its branch as they were. If setting the run aside fails after the
commit, the commit is still pushed and the error says that the card is already committed.

### 7.5 Configuration

`mw config get <key>` prints a value (dotted keys: `limits.rounds`, `roles.worker`).
`mw config set <key> <value>` parses the value as YAML, so `3`, `true`, `[a, b]` and `{k: v}`
keep their types, validates the whole resulting file against the schema, then loads the project
as it would be with the new file, in memory, and refuses the change when that adds any `role/*` or
`config/*` error that `mw check` would report (for example a role override with `runs: shell` and no
`command`). Only then is the file written, keeping comments and layout; a refused change never
reaches the disk. `mw config unset <key>` removes a key the same way, and then every map the removal
left empty, up to and including the top-level key (unsetting `roles.reviewer.model` when it was the
reviewer's only override removes `roles.reviewer`, and `roles` when nothing else is in it); comments
are kept, and `mw config get` of a removed parent prints `(not set)`.
`mergewright.yaml` is protected: agents do not change it.

## 8. Running a card

This section describes how `mw run` takes a card through its flow, the commands around it
(`mw approve`, `mw abort`, `mw status`), and `mw work`, which runs ready cards unattended.

### 8.1 Run state

A card has at most one run. Its state lives in `.mergewright/runs/<CARD>/`:

| File | Content |
|---|---|
| `state.json` | The run state: flow, index of the next phase, round, how often each phase was entered (`visits`, section 8.2), status and reason, approvals given, history, warnings, branch, worktree, the merge in progress (`pendingMerge`) and the branch head it was built from (`pendingMergeHead`), the merged commit and whether its clean-up is unfinished (`cleanupPending`), the SHA-256 of every artifact as the runtime wrote it, and how write-mode Claude agents were confined (`sandbox`: `off (isolated host)`, `on`, or `unavailable: <why>`; section 8.6); the conditions the run waited on at the stop point `conditions` (`conditions`) and the follow-up cards made after the merge (`followUps`, section 8.3). |
| `artifacts/<kind>-<sha256>.json` | Every artifact (brief, handoff, findings, adjudication, reflection, gate) by its content, written once and never changed. The one `state.json` names by hash is the one that counts. |
| `brief.json`, `handoff.json`, `findings.json`, `adjudication.json`, `reflection.json`, `gate.json` | A plain copy of the current artifact of each kind, for people to read. It decides nothing. |
| `phases/<n>-<phase>-<role>.prompt.md` and `.output.txt` | Exactly what was sent to each agent and what came back, for audit (`-retry` for the second attempt). |
| `gate-logs/` | Each gate's JSON summary (`<gate>.gate.json`), its full output (`<gate>.out.log`) and its step logs. The summary and step logs are redacted copies the runtime makes when the gate has ended; the gate itself writes them in `.mergewright/local/scratch/<CARD>/gate-<gate>/` (section 8.3). |
| `<label>.<harness>.stdout` and `.stderr` | The raw standard output and error of each agent CLI, written as they arrive. Deleted by `mw work` once the run is finished and they are older than `trace.raw_days` (section 3.1). |
| `<label>.codex.reply`, `<label>.prompt.txt` | The redacted copy of the reply a `codex` agent wrote (Codex itself writes it in `.mergewright/local/scratch/<CARD>/`, section 8.6), and the prompt a `shell` agent was given. |
| `forge.json` | The pull request opened for the card, when merging through a forge (section 10.6). |

The run directory and every folder in it are mode 0700, and every file the runtime writes in it
mode 0600, whatever the process umask: `state.json`, the artifacts and their plain copies, the
schema files, the streams, exchanges, prompts, reply files and gate logs. The runtime sets the mode
explicitly after it creates each one; files it replaces whole (`state.json`, artifacts) are written
to a temporary file created 0600 and renamed into place. When a run starts or continues, before it writes anything, the runtime narrows a
run directory that an earlier runtime left wider (folders to 0700, files to 0600; symbolic links
inside are not followed). A file the runtime writes in place (a stream or a gate log) is never
written through a symbolic link: a link at its path is removed and a fresh 0600 file is made, and the
open does not follow links. A run directory, or a folder the runtime writes into, that is itself a
symbolic link (or not a folder) is refused with `run/unsafe-path` before anything is created,
narrowed or listed through it. The streams, the saved exchanges, the prompts, the reply files and the gate's log and
step logs are redacted before they reach disk (section 10.4). Files that hold resolved secrets on
purpose never go here (section 4.7).

The run directory is shared between machines (section 9). The lock that says which process runs
the card is not: it is `.mergewright/local/locks/<CARD>.lock` (section 8.7).

The run's status is one of:

| Status | Meaning | `mw run` on it |
|---|---|---|
| `running` | Phases are being executed, or the run was stopped with `--until` or interrupted. | Continues from the recorded phase. |
| `waiting` | A stop point needs the owner's approval (reason: the word), or the usage guard paused the run (reason `usage`, section 10.7). | For a stop point, does nothing unless `--approve` grants the word. For a usage pause, continues. |
| `blocked` | The run needs the owner: a phase routed to `stop`, the remediation budget is spent, a phase reached `limits.phase_visits`, or a safety check refused to continue. The reason says which. | Retries the blocked phase, on the assumption that the owner fixed something. |
| `done` | Every phase has run. | Does nothing. |
| `aborted` | `mw abort` stopped it. | Starts a new run from the first phase, with the old run's files removed. |

Each history entry records the phase, the roles that ran, the outcome (`ok`, `fail`, `reject`,
`block`, `skipped` or `waiting`), a one-line detail, the round, the start time, the duration and
token usage (in total and per harness), and for a phase that ran roles, the harness and the model
each role ran with (`harness` and `model`, by role id; the model is `[<provider>/]<model>`, a `local`
role's profile, or `default` when the role names none and the harness picks its own).

Token usage (`usage`, and per harness `usageBy`) holds `inputTokens`, `outputTokens` and, when the
harness reports a price, `costUsd`. `inputTokens` is all input together. A harness that reports how
its input splits also records the parts and its turns: Claude records `freshInputTokens`
(`input_tokens`), `cacheWriteTokens` (`cache_creation_input_tokens`), `cacheReadTokens`
(`cache_read_input_tokens`) and `turns` (`num_turns`), each only when its result reports it, and
`inputTokens` stays the sum of the three. A harness that reports only totals (Codex) records no
split: the fields are absent, never 0. A run's totals per harness (`mw status`, section 11.1) sum
each field over the phases that reported it and leave it out when none did, so runs recorded before
the split load and print as before.

The run's artifacts are trusted only as the runtime wrote them. Within one `mw run` process every
decision uses the copy held in memory after validation, never a re-read of a file. Each artifact is
written first under its content hash in `artifacts/`, then its hash is recorded in `state.json` (that
one atomic write decides), then the plain copy is written. When a later process continues the run,
it loads each artifact by the hash recorded in `state.json`: a missing or mismatched hash-named file
makes the run `blocked` with "run files were changed outside the runtime" and the list of files,
while a plain copy that differs is simply rewritten. A crash between the first write and the state
save leaves an unreferenced file, and the phase runs again. A run written by an older runtime, with
plain files only, is read as before, checked against the recorded hashes.

### 8.2 The run loop

```
(no writes yet) read the run state; a done run, or one waiting for an approval not granted, stops here
require the main checkout to be on the base branch
take the run lock (this registers the run on this machine, section 8.7)
refuse while processes an earlier run of the card left behind are alive (section 8.7); release the lock
take or refresh the hub lease and sync the base branch (section 9); refused: release the lock
read the run state again; record a granted approval
--from PHASE: go back to that phase, starting a new generation (section 8.10)
fresh run: clear old run files    continued run: load the artifacts by hash (section 8.1)
move aside the worktrees of cards that are done on the base branch (section 9.4), and discarded
worktrees older than seven days
ensure the card's worktree, level with the hub's copy of its branch (section 8.4)
while there is a phase at state.phase:
    stop here if it is the --until phase
    refresh the lease (a lost lease stops the run, section 8.8)
    compute the condition variables (section 4.5)
    if the phase has `when` and it is false: record "skipped"; move to the next phase
    for each stop point of the phase, in order (a merge phase always has `conditions` first; a
        high or critical card also has `go` and `merge`, section 8.5):
        if its condition is true and "<phase>:<word>" was not approved:
            status = waiting; save; notify; return
    for each phase in `needs`: its artifact must exist, otherwise the run is blocked
    if the phase was entered limits.phase_visits times in this run: blocked, naming the phase and the count
    execute the phase (section 8.3), refreshing the lease on a timer -> outcome and detail
    count the entry, unless the phase paused for usage
    record the history entry; push the card branch when the phase created commits
    if the outcome is ok: move to the next phase
    otherwise route it by the phase's `on` map (default stop):
        continue   -> move to the next phase
        stop       -> status = blocked, reason = detail; save; notify; return
        remediate  -> if round >= max rounds: blocked ("remediation budget spent")
                      else round + 1; remediation = detail; go to remediate.phase
        <phase id> -> go to that phase
    save the state
when no phase is left: status = done; move the worktree aside if the branch was merged; notify
```

The maximum number of rounds is `remediate.max_rounds`, or `limits.rounds` when the flow does not
set it. Rounds count only `remediate` routes; a named route in `on` (for example a `lint` phase whose
failure goes back to `implement`) has no round budget, so the run also counts how often it enters
each phase, whatever the route, in `visits` in its state (by phase id). An entry is counted and
saved before the phase starts, so a phase that is stopped, crashes or is killed part-way keeps its
count when the run is resumed. When a phase was entered
`limits.phase_visits` times (6 by default), the next entry is not started: the run is blocked with
a reason that names the phase and the count, for example "phase 'implement' was entered 6 time(s) in
this run, the limit (limits.phase_visits: 6), so entry 7 was not started". A phase that pauses for
usage before any of its roles ran gives its count back, since it runs again as the same entry; once one of
its roles ran (an `also` role meeting the pause after the first role, say), the phase was entered
and the entry counts, because its roles run again on resume. The counts are saved with the run, so
`mw run <CARD>` on such a run blocks again at once. Raising `limits.phase_visits` keeps the saved
counts: going from 2 to 3 allows one more entry, and the run then blocks at entry 4. Only
`mw run <CARD> --from <phase>` (section 8.10) clears the counts. `mw run`, `mw work`, `mw approve`, `mw retry` and `mw abort` do not take `--offline`, on any
project: passing it is a usage error (exit 2) that names `mw sync --offline`, the only command that
works without the hub. A project with a hub needs the hub to run a card, because the other machine
could be running the same card; a project without one never contacts a hub. `mw run --until <phase>`
stops before that phase and leaves the status `running`; a phase
that is not in the flow is a usage error. `mw run --dry-run` prints the phases that would run from
where the run is, with each role's harness, model and the estimated size of its prompt in tokens,
and the current value of each condition, including the stop points the runtime adds for the card's
risk (named as such, section 8.5); it executes nothing, writes nothing and does not contact
the hub. `mw run` prints one line per phase, for example `brief      ok      (planner, 41s)`, then
a sentence saying where the run is and what to do next. It exits 1 when the run ends blocked and
0 otherwise.

The integrations are told what happens: the owner is notified when a run waits, pauses for usage,
is blocked or is done, and the Kanban mirror (section 10.5) receives every change of the run's
status.

### 8.3 Executing a phase

**Gate phase.** The gate runs in the card's worktree (the project root for `worktree: false`),
with the environment of section 4.6, `MERGEWRIGHT_GATE_JSON` pointing at
`<gate>.gate.json` and `MERGEWRIGHT_GATE_LOGS` at a scratch folder of this machine
(`.mergewright/local/scratch/<CARD>/gate-<gate>/`, mode 0700, never file-synced), `MERGEWRIGHT_BASE`
set to the base branch, and `limits.minutes` as its timeout. Its full output goes, redacted as it
arrives, to `gate-logs/<gate>.out.log` in the run directory. When the gate has ended, and before
anything of it is read, the runtime copies the summary and every regular file in the scratch folder
into `gate-logs/` redacted (section 10.4) and mode 0600; symbolic links are not copied. A step `log`
that names a copied file is pointed at its copy, and the scratch folder is removed however the gate
ended. So the gate never writes into the file-synced run directory itself. Exit 0 is `ok`. Any other exit (or a timeout) is `fail`, with a detail
that names the failing steps and gives the last 40 lines of each failing step's log, with
credentials redacted. The exit code decides even when the JSON says otherwise, with one exception:
when a step `gate.required` names was skipped, the gate fails (its `ok` is false) and the phase's
outcome is `block`, not `fail`, with a detail that starts with `gate/required-skipped` and names the
step and its reason. The worker cannot make a missing variable or tool appear, so no remediation
round is spent; the owner makes the step runnable (for a variable: set it and list it in `gate.env`)
or removes it from `gate.required`, then runs the card again. The required steps also fail closed
when the gate exits 0: a required step the JSON summary does not list, lists more than once, or lists
only as a malformed step (no string `name` or no boolean `ok`), and a summary that is missing,
does not parse or has no `steps` list, fail the gate with a detail that starts with
`gate/required-missing` and says which; the phase's outcome is `block` and no remediation round is
spent, because the gate script is the owner's. A required step that reports `ok: false` fails the
gate even when it exited 0; that is an ordinary `fail` whose detail names the step, and the worker
gets a remediation round. With an empty `gate.required` none of this applies and the exit code alone
decides. Skipped steps are named in the detail
either way, in the form "NOT run: <step> (<reason>)" (for `gate/required-skipped` too). The runtime copies the
log tails into the result (section 4.6), adds the commit the gate judged (`head`: the card branch's
head), and stores it as the `gate` artifact. A review phase likewise records in its `findings`
artifact the head it reviewed.

**Role phase.** The phase's role and then each `also` role whose condition holds run one after
another. Before every attempt of a role on a paid harness (every one but `local`, `shell` and `mock`: `claude`, `codex` and any a package provides), whatever its
mode, the usage guard is asked once (section 10.7); when it says no, the run pauses (status `waiting`,
reason `usage`) before the role, and no agent starts. No attempt starts once the stop or lost-lease
signal (section 8.8) has fired, the first one included. For each role:

1. The prompt is rendered (section 4.3) and saved.
2. The harness runs the agent. A write-mode role works in the card's worktree. A role that cannot
   change files works in the card's worktree while it exists, and in the main checkout once the
   card is merged and its worktree is gone (the reflection phase runs then).
3. For any output other than `text`, the runtime takes the structured reply the harness returned,
   or else extracts the JSON object from the reply (the whole reply, else the last fenced `json`
   block, else the last fenced block, else the outermost `{...}`), and validates it against the
   output schema. An adjudication that satisfies the schema is then checked against the run's
   `findings` artifact (the adjudication rules below); what those rules find counts as validation
   errors. If it is invalid, the agent is asked once more, with the validation errors
   appended to the prompt. This validation retry (after a schema or adjudication check failure) is
   a paid attempt like every other: the usage guard is asked before it (section 10.7), and when it
   says no the retry does not start, no agent starts, no round is spent and the run pauses for usage
   (status `waiting`, reason `usage`); `mw_delegate` and `mw_review` report that refusal as
   `delegate/usage`, with the same message as a refusal before their first attempt. If it is still invalid, the outcome is `fail` and the detail names the
   errors (for an adjudication, the unknown ids among them).
4. The artifact is stored. Findings from several reviewers are merged into one `findings.json`,
   and each finding id is prefixed with its reviewer's role id (`reviewer:R-01`).
5. The outcome follows from the output kind:

| Output | Outcome |
|---|---|
| `brief` | `block` when `ready` is false (detail: the blockers); otherwise `ok`. A brief whose scope is wider than the card's is harmless: both scopes apply (section 8.4). |
| `handoff` | The runtime first commits the work (section 8.4). Then `fail` when the reply was not a valid handoff, `block` when the handoff's status is `blocked`, `fail` on a scope violation, otherwise `ok`. |
| `findings` | Always `ok`; later phases read `findings.blocking`. |
| `adjudication` | `approve` is `ok`; `reject` is `reject` (detail: the instructions and the accepted findings); `block` is `block`. An approval may carry `conditions` (what must be done before the merge: the run then stops at the stop point `conditions` before the merge, section 8.5) and `follow_ups` (work for later: the `memory.update` action after the merge makes each a card, below); the detail counts them. |
| `reflection` | `ok`; the phase's `memory.update` action then applies it. |
| `text` | `ok`. |

**Adjudication rules.** After schema validation, an adjudication is invalid when (REQ-adjudication-001
to 003):

- an id in `accepted` or `rejected` names no finding in the `findings` artifact (the error lists the
  unknown ids and the ids that exist; no findings artifact counts as no findings). An id is the
  finding's full id (`reviewer:R-01`), or its id without the reviewer prefix (`R-01`) when that fits
  exactly one finding; a short id that fits several is invalid too;
- a blocking finding (`blocking: true`) is in neither `accepted` nor `rejected`;
- the verdict is `approve` and `accepted` holds a blocking finding. An approval rejects every
  blocker, each with its reason; one that does is valid;
- the `findings` artifact holds more than one finding with the same full id (no decision on that id
  can tell a blocker from a non-blocker, so the findings must be reviewed again).

These rules apply to every verdict and take the one retry of step 3, never a second: a reply still
invalid gives `fail`. The same check runs again before the merge (section 8.4, "Merge evidence").

A harness that fails outright (non-zero exit, timeout, no output) gives `fail`. A role whose MCP
servers need an environment variable that is not set gives `block`.

**Transient harness failures** (REQ-harness-001 to 003). A failure whose message says the model is
at capacity or overloaded ("Selected model is at capacity", `overloaded_error`), reports HTTP 429 or
a 5xx status, or reports a provider request timeout or a reset connection is transient: one table of
patterns (`src/engine/harness/transient.ts`) classifies the failures of every harness (section 8.6).
Invalid or missing output, an authentication error, a missing CLI, a scope violation and the
runtime's own `limits.minutes` kill are never transient. A transient attempt is tried again on the
same model after a growing wait (5 s, then 15 s, then 45 s), up to `limits.transient_retries` times
(default 2). If they are spent, a role with a `fallback_model` (section 4.3) runs once more on it, on
the same harness. These attempts spend no remediation round and do not use step 3's one schema
retry (a schema retry spent before a transient attempt stays spent). Usage sums every attempt,
failed ones included; the phase record's `model` names the model that answered, and the history
detail ends with how the role got its answer, for example `(reviewer: 2 transient retries, answered
by its fallback_model 'gpt-5.6-sol')`. When the last attempt also fails transiently the phase's
outcome is `block` with a detail that starts with `harness/transient` and names each model tried and
the last error; no remediation round is spent. A stop or a lost lease (section 8.8) ends a wait at
once, and no further attempt starts; a signal that fires while the usage guard is being asked stops
the attempt that would follow too. Every attempt (the first, a transient retry, the `fallback_model`,
the schema retry) asks the usage guard (section 10.7) first, under the rule above; if it refuses, no
attempt starts and the run pauses for usage without spending a round (`mw_delegate` is refused with
`delegate/usage`, its first attempt included). `mw_delegate` and `mw_review` run their role the same way.

**Quota and session limits.** A failure that says the account is out of usage ("You've hit your
session limit · resets 3pm" from Claude, "You've hit your usage limit ... try again at 3:05 PM" or an
HTTP 429 that states a reset time from Codex) is checked before the transient table and is never
retried. A 429 counts as a quota only when its text states a real reset time (a clock time, a date or
a duration, such as "try again at 3:05 PM" or "try again in 2 hours"); "try again later" or "retry
shortly" is transient. A clock time is taken as its next occurrence; when the provider states a time
zone after it ("resets 3pm (Europe/Berlin)", or a bare `UTC` or `GMT`), the time, the date and "the
next day" are read in that zone, and this machine's time zone is the fallback when none is stated or
the name is unknown.
The run pauses for usage (status `waiting`, reason `usage`, section 10.7) and spends no remediation
round; the history detail names the reset time. The reset time is kept per harness in this
machine, one folder per harness (`.mergewright/local/usage-limits/<harness>/`) holding one record
file per report, each written atomically; the latest reset across the records counts, so no report
overwrites another and the later reset time always wins, even when runs report at once; until it passes, no role on that harness starts on
this machine: a phase that would run one pauses for usage at once, `mw_delegate` is refused with
`delegate/usage`, and `mw work` takes no new card (it waits, or with no `--watch` stops, as for high usage).
A message that states no reset time pauses this run only.

A write-mode role in a flow with `worktree: false` is not supported: it would work in the main
checkout among the owner's own edits, and what it changed could not be told apart from them. The
engine blocks such a phase, pointing at `mw check`, which reports it as `flow/write`.

**Action.** The action runs after the phase's role, if any: `merge` (section 8.4),
`memory.update` (section 7.2), `docs.sync` (section 10.3), `notify` (section 10.1). Documentation
sync and notification failures are queued and never change the outcome from `ok`. The
`docs.sync` detail also names the changed files it left out because they are outside `docs.paths`
(section 10.3), so a `docs` card whose files the notebook does not index says so in its history.

**Follow-ups.** The `memory.update` action also turns each follow-up of an approving adjudication
into a card in the main checkout, committed together with the reflection (`<CARD>: update project
memory, add follow-up cards <IDs>`; without a reflection, `<CARD>: add follow-up cards <IDs>`): kind
from the follow-up (default `chore`), status `todo`, the follow-up's `risk` or else `medium`,
a scope made of the follow-up's `scope` or else the parent's, without protected
paths, plus the project's `docs.paths` it does not cover that are not protected (as `mw card new`
adds them, section 4.2), so the card passes `mw check --strict`; tag `follow-up`, and the body
"Follow-up from <CARD> adjudication: <why>". The ids are recorded in the run state (`followUps`) as each card is
made, so the phase run again makes none twice, and the phase's detail names them. A follow-up whose
card cannot be made is a warning of the run. A flow without a `memory.update` phase makes no
follow-up cards.

### 8.4 Worktree, branch, commits, scope and merge

**Branch and worktree.** A card works on the branch `card/<CARD>` in the worktree
`.mergewright/worktrees/<CARD>`. Worktrees belong to one machine: they are never file-synced, and a
card branch travels between machines only through the hub. At every run start the runtime first
fetches the card branch from the hub and fast-forwards the local branch to it (a local branch that
has diverged from the hub's stops the run). A missing worktree is created from the branch, which is
created from the base branch when it does not exist. An existing worktree is reused, after the
check below, and when the moved-aside copy of an earlier worktree could not be detached from git
(below), the fresh worktree gets a new git administrative name rather than reusing the old one. Anything else at the worktree path (a copy left by file sync, a symbolic link, a
directory git does not list, a worktree that fails the check), and a worktree whose branch moved
forward under uncommitted leftovers of an interrupted phase (the other machine continued the card,
so that phase is redone), is moved aside and a fresh worktree is made from the branch.

**Nothing is destroyed in place.** A check followed by a reset, a clean or a delete at the same path
can be raced, so the runtime never does that. A worktree that is no longer needed or must be
replaced, in every case (a finished or merged card, an abort, leftovers, anything in the way), is
renamed to `.mergewright/local/discarded/<CARD>-<UTC time>`: a rename moves a symbolic link itself
and can never empty the main checkout. `git worktree remove` is not used, so every file is kept,
ignored files included. The moved copy is then detached from git, so that git commands run inside it
cannot act on a later worktree of the same name: a `.git` pointer file is renamed to a unique
`.git.discarded-<UTC time>`, and a `.git` symbolic link is removed. When the pointer cannot be
detached, its git administrative entry is retired instead (re-pointed at the copy with
`git worktree repair`, its HEAD detached), so it is never reused; otherwise `git worktree prune`
is run. Entries of `discarded/` older than seven days are removed at the start of a run.

Before anything is moved into, or removed from, `.mergewright/local/discarded/`, its real path must
be exactly `<real project root>/.mergewright/local/discarded`: a symbolic link at that folder or
above it would send moves and the clean-up elsewhere. When the check fails, nothing is moved or
removed: a move stops with `worktree/move-failed`, and the clean-up is skipped with a warning
(`worktree/discard-unsafe`). When a worktree cannot be moved, the run stops `blocked` and nothing is
deleted.

**The worktree check.** Before the runtime reuses a worktree or commits in it, it verifies that the path is a real directory and not a symbolic
link, that its canonical path is exactly `<root>/.mergewright/worktrees/<CARD>`, that git reports
that directory as its top level, that its git directory lies inside the main repository's
`.git/worktrees/`, and that it has `card/<CARD>` checked out. A commit in a worktree that fails
the check does not happen: the phase is `blocked` and says which check failed (the next run moves
the worktree aside).

**Commits.** After a writing role finishes, the runtime stages everything in the worktree and, if
anything changed, commits it with the message `<CARD>: <first line of the handoff summary, at most
72 characters>`, or `<CARD>: work in progress (<phase>)` when there is no valid handoff. Agents
never commit. After any phase that created commits, the card branch is pushed to the hub.

**Scope.** Every path the card's branch changed since it left the base branch
(`git diff --no-renames --name-only <base>...HEAD`, so a rename counts as a delete plus an add)
must match the card's `scope` when it has one, and the brief's `scope` when a brief exists with
one; an empty brief scope inherits the card's. A path that matches `protected` must also match the
card's `allow_protected`. Nothing is exempt, the card file included; the only accepted edit of the
card file is the runtime's own `status: done` change. A violation is outcome `fail`, with a detail
listing the offending paths and telling the worker to revert them, so that a flow with
`on: {fail: remediate}` sends the work back.

**Merge without a forge** (`git.forge.kind: none`):

1. The worktree must be clean: uncommitted changes there were never checked, so they give outcome
   `fail` with the list of files. The scope check is run again on the whole branch.
2. The run must hold a passing gate result and a review recorded for the branch head it is about
   to merge (see "Merge evidence" below); otherwise the outcome is `block`.
   **Re-gate on a moved base** (REQ-gate-004). When the gate artifact's `base` (section 4.6) is not
   the current base commit (or is not recorded), the runtime squashes the branch head onto the base
   as in step 4 (a commit no ref points to; nothing moves) and, when that commit's tree differs from
   the tree of the branch head, runs the gate of the flow's gate phase again on it. This happens
   before the runtime changes the branch, so a failed re-gate leaves the base branch, the main
   checkout and the card branch as they were. The gate runs in a temporary worktree with the squash
   commit checked out on a detached HEAD, under `.mergewright/local/regate/`, which is removed (with
   `git worktree remove --force`) whether the gate passes, fails or throws; no branch is made. The
   re-gate is the same gate run as the gate phase's, with `gate.required` and its checks, and its
   logs go to `.mergewright/runs/<CARD>/regate/gate-logs/`; the stored `gate` artifact is not
   changed. When it passes, the merge goes on and the squash commit merges as built (the card branch
   is never rebased); the tree that lands differs from the gated one only by the runtime's status
   line of step 3. When it fails, nothing merges: the outcome is `fail` and the run goes to the
   flow's remediation phase (whatever the merge phase's `on` says; a flow without `remediate` stops)
   with a remediation that starts "rebuild on the new base" and ends with the re-run's gate detail
   and logs. A required step that is missing or did not run blocks, as in the gate phase. A squash
   that conflicts is not re-gated; step 4 reports the conflict. With an unmoved base, or a squash
   tree equal to the branch tree, the gate does not run again. The lease keeps merges serial, so one
   re-gate per merge is enough.
3. In the worktree, the runtime sets the `status:` line of `cards/<CARD>.card.md` to `done` and
   commits only that file, as `<CARD>: mark done`. When the branch's tree has no card file (a branch
   made before the project used MergeWright), the runtime takes the card file from the base branch,
   where the cards are the source of truth, writes it into the worktree with `status: done` and
   commits it the same way (REQ-engine-010). Any other failure to read, write or commit the card
   file, and a base branch without it, ends the run `blocked` with `merge/card-file`, a message that
   names the file and the remedy `mw run <CARD> --from <merge phase>`; no route in the merge phase's
   `on` can carry the run past it, and the lock and lease are released as for every blocked run.
4. It builds the squash commit without touching any checkout: `git merge-tree --write-tree` of
   base and branch (a conflict is outcome `fail` with the conflicted paths as detail, so the flow
   can remediate). One conflict is resolved: when the branch forked before the card file reached
   the base, step 3 adds the card file on the branch while the base added it too. When the card
   file is the only conflicted path, the conflict is add/add and the branch's text is the base's
   text with `status: done`, the branch's text is taken. Any other conflict, or another kind of
   conflict on the card file, is reported as above. The re-gate of step 2 and the check of a recorded
   merge below build the tree the same way. Then `git commit-tree` on top of the base, with the message
   `<CARD>: <card title>` and a body with the brief's summary, the reviewers, the number of rounds,
   and the card and flow.
   If the base moved between step 2 and this point (only by hand: the lease keeps merges serial),
   the outcome is `fail` and nothing merges.
5. It records the squash commit (`pendingMerge`) and the branch head it squashed
   (`pendingMergeHead`) in the run state before moving anything. Then, if
   the base branch is checked out (normally in the main checkout), it fast-forwards it there with
   `git merge --ff-only`; git refuses if local edits would be overwritten, which is outcome `fail`
   with nothing lost. Otherwise it moves the branch reference with a compare-and-swap
   `git update-ref`.
6. It records the merged commit with `cleanupPending`, then cleans up: pushes the base branch to the
   hub, moves the worktree aside, deletes the card branch locally and on the hub, and clears
   `cleanupPending`.

Every step is safe to repeat (section 8.8).

**Merge evidence.** For each kind of check the flow has before its merge phase (a gate phase; a review
phase, that is one whose roles return findings), the run must hold that check's artifact recorded for
the commit about to be merged, and the gate must have passed. The runtime's own commit marking the
card done, directly on top of the judged commit, does not count as a change. Which of those phases
apply is read from the run history, never from a `when` condition evaluated against the stored
artifacts: a phase is exempt only when its latest history entry is the runtime's own `skipped`
record and no phase with a write-mode role has run since; a phase with no record, or one that ran,
needs its evidence. The base commit the gate ran against is compared with the base the squash is
built on (step 2 above). This holds whatever the run state says about the run's
position or approvals: without a separate operating-system user or a working sandbox, a worker runs
as the same user as the runtime and could edit `state.json` (and read the secrets file), but such an
edit cannot merge ungated or unreviewed code. The refusal names the phase to go back to with
`mw run <CARD> --from <PHASE>`. When the flow has an adjudication phase before the merge, the
recorded adjudication must also be an approval that keeps the adjudication rules, unless the run
history shows that the runtime skipped that phase (its `when` condition was false) after the latest
passing review and has not run it since; whether the phase applies is never judged again from the
stored findings, which whoever can write the run's files could replace. When the runtime skipped
it, an adjudication still recorded is from an earlier round and is not checked. In a flow without
an adjudication phase, a recorded adjudication is checked all the same. The recorded adjudication
that is checked must be an approval that keeps the adjudication rules (section 8.3) against the recorded findings; the merge
is refused (fail closed) when the adjudication or the findings are missing, are not objects of the
expected shape (a findings list of objects with string ids; a verdict and lists of ids) or do not
satisfy their schemas, when the verdict is not `approve`, or when the approval names an unknown id, leaves a blocker
undecided, accepts a blocker or relies on a repeated finding id (REQ-adjudication-003). The refusal names the adjudication phase to
run again.

**A recorded merge already on the base.** When the merge phase starts and the recorded
`pendingMerge` is already part of the base branch (a merge interrupted after the base moved), the
state file's word is not taken for it. The commit is accepted as the card's merge only when all of
these hold:

- its tree equals the tree `git merge-tree --write-tree <its parent> <pendingMergeHead>` produces,
  with the card file's add/add conflict resolved as in step 4 (trees are compared, not commits, so a
  forge's own commit passes too);
- its parent is on the base branch;
- the merge evidence holds for `pendingMergeHead`.

Then only the clean-up is done. Otherwise the run is `blocked` with "the recorded merge does not
match the card's work" and the reason; nothing is cleaned up, and the branch and worktree are kept.
The remedy is `mw run <CARD> --from <merge phase>`, which sets the recorded merge aside and merges
the card's checked work afresh (section 8.10). A merge recorded without `pendingMergeHead` (by an
older runtime) never passes, so it blocks the same way.

**Merge through a forge** (`gitea` or `github`): steps 1 to 3 as above (including the re-gate on
a moved base, on the squash the runtime builds locally; the forge builds its own squash of the same
branch and base), then the runtime pushes
the branch, opens (or finds) the pull request and squash-merges it through the forge's API
(section 10.6), and records the forge's commit (`pendingMerge`) with the branch head it pushed
(`pendingMergeHead`). It then syncs the base branch with the hub and requires the forge's commit to be on
the local base branch before any clean-up; otherwise the run is `blocked` and the branch and
worktree are kept.

**The forge check**. The forge builds its own squash on whatever its base is when the
API call lands, so before anything is cleaned up the runtime reads the forge's commit with git (it is
on the local base after the sync) and compares it with what was gated:

- its first parent must be the expected base: the base commit the re-gate of step 2 built its squash
  on, or, when no re-gate ran, the base commit the merge evidence judged against (the local base head
  when the merge started);
- its tree must be the expected tree: the pushed branch head (the gated tree plus the runtime's
  status line of step 3) merged onto that base, as `git merge-tree --write-tree` produces it.

Expected and actual base commit and tree are recorded, with the forge's commit and the result, in the
run's merge evidence, `.mergewright/runs/<CARD>/forge-check.json`. The expected pair is written
there (with `ok: false`, no commit yet, and the branch head pushed for the merge) before the forge is
asked to merge, because the forge may merge and its answer still be lost (a crash, a dropped
connection). When the card runs again and the merge finds a record without a commit for the same
branch head, it neither re-gates nor rebuilds the expectation from the base as it is then (which may
already hold the forge's squash): the forge is asked again, finds the pull request it already merged
by its recorded number (section 10.6), and the commit it names is checked against the expectation
recorded before the first call. A record that cannot be read, or has an unknown expected base or
tree, blocks that retry before the forge is asked. Any other record (one naming a commit, or one
for another branch head) is stale and is removed, so the merge is gated and checked afresh. The
retry needs the card's branch: the start of the next run removes a finished card's local worktree
and branch, and makes them again from the hub's copy of the branch; when the hub no longer has it,
the merge evidence refuses the merge, which blocks. With no forge configured, the record is removed
when the forge integration declines the merge, and a record left by an interrupted attempt is
dropped and the merge starts over, re-gate included; local merges keep no record. The record is
rewritten once the forge names its commit, before that commit is recorded as the pending merge,
so a run that stops between recording the commit and checking it runs the same check on resume, from
the recorded expectation: a resumed forge merge is finished only when the check passes (an unreadable
record or an unknown expected base or tree blocks), and the record is then rewritten with the actual
pair and `ok: true`. This holds for both ways of resuming: `mw run <CARD>`, and `mw run <CARD> --from
<phase>`, which accepts a recorded merge as finished only when the same check passes and otherwise
sets it aside with a warning that names the mismatch. On a match the merge goes
on as before. On a mismatch the card is not completed: the recorded merge is set aside (so a later run
cannot accept the forge's commit as a finished merge), the run is `blocked` for the owner with a
message that names the expected and the actual base commit and tree, the same line is added to the
run's warnings (`forge merge check: ...`), and the branch and worktree are kept. The ungated commit
is already on the base: the owner checks it (runs the gate on it, reverts it if it fails) and closes
the card by hand; running the card again, also with `--from`, blocks again with the recorded
mismatch while the forge's commit is on the base. A forge that
reports the pull request as merged but returns no merge commit (error `merge/no-commit`, or an empty
answer) blocks the run the same way, with the actual base and tree recorded as unknown; it is never
taken for a match or a success. Gate artifacts written by an older runtime have no `base`; they are
re-gated (step 2) and the expected base is the one the re-gate built on, so they are checked like any
other.

The runtime does not refuse a forge merge in advance when the forge's base head differs from the
local base: the forge integration does not read the forge's branch heads, and the base could still
move between such a read and the merge, so the check is made after the fact only.

The clean-up is the same.

**A flow with `worktree: false`** has no branch: its work is already on the base branch. The
merge-evidence rule applies, judged against the base branch's head: the run must hold a passing gate
and a review recorded for the commit the base branch points to, otherwise the outcome is `block`
(so a commit made on the base branch between the review and the merge blocks it until the checks
run again). Then the merge action only sets the card's `status: done`, commits that file and pushes
the base branch. A failure to read, write or commit the card file blocks with `merge/card-file` as in
step 3 above.

**Abort.** `mw abort <CARD>` takes the hub lease (when the project has a hub; refused, naming the
holder, while another machine holds a fresh one) and the run lock. Uncommitted work in the card's
worktree is first committed to the card branch as `<CARD>: work in progress (abort)` and pushed, so
the branch holds everything; then the worktree is moved aside and the branch kept.
`mw abort <CARD> --force` is for stopping a card whatever else is happening: it takes the lease over
even from another machine (and says so; that machine stops at its next lease check), moves the
worktree aside to `.mergewright/local/discarded/` with its uncommitted work, and deletes the branch
locally and on the hub. Either way the status becomes `aborted`. A run that is done, or that another
process on this machine is running, cannot be aborted.

While a process recorded in the card's orphans file (`.mergewright/local/locks/<CARD>.orphans`,
section 8.7) is alive, it may still be writing into the worktree, so the worktree is never moved from
under it: `mw abort <CARD> --force` is refused (`run/orphans-alive`) before anything changes, and a
plain `mw abort <CARD>` sets the status to `aborted` but leaves the worktree and the branch as they are,
commits nothing, and says which process group is alive and how to stop it. Once it is gone, a further
`mw abort <CARD>` moves the worktree aside as usual.

### 8.5 Stop points and approvals

A phase with `stop: {when: <condition>, ask: <word>}` makes the run wait before that phase when the
condition is true, until the owner approves with that word. Approvals are recorded as
`<phase id>:<word>`, so `go` given for one phase does not approve another phase that asks for
`go`. The owner approves with `mw approve <CARD> <word>`, which continues the run with that
approval for the stop point it waits at, or in advance with `mw run <CARD> --approve go,merge`,
which grants those words to any phase that asks for them. `mw approve` refuses a run that is not
waiting for an approval, and a word other than the one the run waits for.

**Minimum stops by risk.** A card of risk `high` or `critical` waits for `go` and `merge` in every
flow, not only in the shipped `standard` and `quick` flows: the runtime gives the flow's first phase
whose role (or one of its `also` roles) has `mode: write` the stop point
`{when: "risk >= high", ask: go}`, and the merge phase `{when: "risk >= high", ask: merge}` after
`conditions`. A flow with no merge phase (the shipped `spike`) gets `go` only. The runtime decides
this from the card's own `risk` (or `risk.default`) and the flow definition, never from a stored
artifact such as the brief. Only the target phase's own stop points count: a word the target phase
already declares is not doubled there, and its condition becomes `(<declared>) or risk >= high`.
Stop points declared on other phases, earlier or later, with or without a `when` condition, keep
their own place and condition and never stand in for the target's, because routing (`on` outcomes,
`--from`, a false `when`) can pass them by. A flow that declares `go` on an earlier phase and has a
writing phase later therefore waits for `go` at both; `--approve go` grants every phase that asks
for it. A flow can add stop points (or stop more cards) and never remove or weaken these; the
shipped `standard` and `quick` flows declare both on the target phases, so they wait once per word
as before. Cards of risk `low` or `medium` get only the stop points their flow declares (the
shipped `docs` and `spike` flows declare none besides `conditions`). `mw run <CARD> --dry-run` lists
these stop points with the phase they hold and says which were added because of the card's risk.

**Conditions.** When the adjudicator approves with `conditions` (Appendix B.4), the run stops
before the merge at the stop point `conditions`, whatever the card's risk: the shipped flows declare
it (`{when: "adjudication.conditions > 0", ask: conditions}`, first in the merge phase's list), and
the runtime adds it to any merge phase that does not, and moves it ahead of the phase's other stop
points (which keep their order) when a flow lists it later. The run state records the conditions
(`conditions`), the notification and `mw run`'s closing sentence list them ("<what> (how: <how>)"),
and `mw_run_status` returns them. The owner meets them (on the card's branch, or wherever they
apply), then approves with `mw approve <CARD> conditions` (or `mw_approve`), which continues to the
merge, stopping again for `merge` when the card's risk asks for it. `--approve conditions` grants it
in advance like any word; the shipped `mw work --approve go,merge` does not.

### 8.6 Harnesses

Every harness runs in the request's working directory, enforces the time limit as a hard timeout
(and stops its agent at once when the run is stopped, section 8.8), and writes nothing outside the
run directory itself, except the machine-local files that hold secrets for one phase: the MCP
config of a `claude` or `shell` role and the reply file of a `codex` agent in
`.mergewright/local/scratch/<CARD>/`, and the per-run Codex home (below), all removed when the phase
ends (section 4.7). What it writes into the run directory
is private and redacted (sections 8.1 and 10.4): standard output and error are streamed through the
redactor, which holds back the last characters of each chunk (one fewer than the longest secret)
until the next chunk or the end shows how they go on, so a value split across two chunks is still
replaced; what it holds back is written, redacted, on every way out (normal exit, failure, timeout,
stop). An agent CLI runs in a process group of its own. When its main process
exits, normally, on timeout or when stopped, the harness ends the rest of the group before it
returns the result: when no process of the group is left it returns at once; otherwise it sends
SIGTERM to the group, waits up to the grace period (5 seconds), sends SIGKILL, and a group that
survives that is recorded and handled as in section 8.7. A tool the agent left running in the
background therefore cannot change the worktree after the phase. The result (exit code, output,
timeout) does not change because of this; the gate (section 4.6) is reaped the same way. A harness keeps at most the last 8 MB of an agent's standard output and of
its standard error in memory; HTTP replies over 20 MB are refused.

The agent process receives a minimal environment, not the caller's: the variables a program needs
to run (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, `XDG_RUNTIME_DIR` and similar, plus the
harnesses' own configuration folders such as `CLAUDE_CONFIG_DIR` and `CODEX_HOME`),
`GIT_TERMINAL_PROMPT=0`, the run's variables `MW_ROLE`, `MW_CARD` and `MW_MODE`, `MW_RUN_DIR` for
roles that cannot write (a write-mode agent is not told where the run's files are), and the
variables the role's MCP servers reference. Other secrets in the caller's environment do not reach
the agent. A role's `args` are appended to the command. Each harness also keeps the owner's
personal configuration (user-level settings, plugins, other MCP servers) out of the agent, so a run
depends only on the project's files.

For Codex this needs more than `--ignore-user-config`, which skips `config.toml` but not the rest of
the Codex home: global instructions (`AGENTS.md`, `AGENTS.override.md`), hooks, rules, skills and
memories are read from `$CODEX_HOME` (default `~/.codex`) regardless. So every `codex` run gets
its own Codex home, `.mergewright/local/codex-home/<card>/<label>/` (machine-local and never
file-synced, unlike the run directory, so the login never reaches the other machine), holding only
a copy of the owner's `auth.json` (mode 600; nothing else is needed to authenticate, checked against
codex-cli 0.155.1 under a ChatGPT login). The copy is removed when the run ends; if Codex refreshed
the login during the run and the owner's own `auth.json` did not change meanwhile, the refreshed
file is copied back first, so a rotated refresh token is not lost. Its content is never logged.
A run killed hard (SIGKILL, power loss) never removes its copy, so every run, once it holds its run
lock, removes each `.mergewright/local/codex-home/<card>/` whose card has no run lock held by another
live process on this machine, and records one warning line per folder removed. The check of each
folder's run lock and its removal happen under the run registry's guard (section 8.7), so no run of
that card can register in between.

| `runs` | Command and behaviour |
|---|---|
| `claude` | `claude -p --output-format json` with the project's settings only, `--model <m>`, `--json-schema <schema>` when an output schema applies, the tools of the mode as `--allowedTools`, the forbidden commands as `--disallowedTools`, `--mcp-config <f>` when servers apply, always `--strict-mcp-config`, the sandbox settings for a write-mode role (below), `--permission-mode dontAsk` and `--max-turns <n>`. The prompt goes on standard input. The reply is the structured output when present, else the result text. Tools: `write` gets Read, Edit, Write, MultiEdit, Grep, Glob, LS, TodoWrite and Bash; `read` gets Read, Grep, Glob and LS; `advise` gets none; MCP servers add `mcp__<id>`. Token usage and cost are read from the reply. |
| `codex` | `codex exec --json -s <read-only or workspace-write> -C <dir> --ephemeral --skip-git-repo-check --ignore-user-config [--output-schema <f>] [-m <model>] -o <file> [MCP -c overrides] -`, prompt on standard input; the reply is the `-o` file, which is in `.mergewright/local/scratch/<CARD>/` (created empty with mode 0600 before Codex starts, so Codex never writes an unredacted reply into the run directory); when Codex has ended the harness reads it, keeps a redacted copy as `<label>.codex.reply` in the run directory and removes it, however the phase ended. `advise` and `read` use the read-only sandbox; `write` uses the workspace-write sandbox, which confines the agent's writes to the worktree. `CODEX_HOME` is the run's own Codex home (above). Token usage is read from the `turn.completed` event; Codex reports no price, so its usage is shown as tokens only. |
| `local` | HTTP POST to `<local_models.endpoint>/chat/completions` (OpenAI-compatible), with `model` set to the role's `profile`, else its `model`, and a JSON schema response format when an output schema applies; `Authorization: Bearer` from `local_models.key_env` when set. When the endpoint is unreachable or answers with a server error, the same request goes to `local_models.fallback`. Advisory only. |
| `shell` | `sh -c "<command> <args>"`, prompt on standard input and in the file named by `MW_PROMPT_FILE`; the reply is standard output. The environment adds `MW_OUTPUT_SCHEMA` (a path, when a schema applies) and `MW_MCP_CONFIG` (a path to a file created readable only by its owner, when servers apply). This is the way to run any other agent program. |
| `mock` | No program: for tests. `MW_MOCK_SCRIPT` names a JSON file `{"<role>": [{"writes": {"path": "content"}, "deletes": ["path"], "output": <object or string>, "fail": true, "delay": <ms>}, ...]}`. Call n of a role uses entry n, and the last entry repeats. |
| a package's | What the package runs (section 15.3): for `hermes`, `hermes chat -Q --oneshot` with the prompt from a file (section 15.4). Advisory only. The engine passes it no MCP servers, and an error it throws becomes a failed result classified as below. A package runs its CLI through `host.agent`, so the process group, the hard timeout, abort, the capped output and the redacted output files are the runtime's, as for `claude` and `codex`. |

**Transient failures.** The `codex`, `claude` and `local` harnesses, and a package's (through `host.agent`), mark a failed result
`transient`, or `quota` with the reset time the message states, through one shared classification
(`src/engine/harness/transient.ts`), never a copy of its own: Codex on the message of its
`turn.failed` or `error` event (or the last lines of standard error when there is none), Claude on
the result it reports as an error (`API Error: 529 ... overloaded_error`), a package's CLI (Hermes)
on its exit error and the end of its standard error, `local` on the HTTP status and error of the last endpoint tried
(a reset connection to every endpoint is transient too; an unreachable one is not). The order is:
quota and session limits first (never transient, even with a 429 that states a reset time; a 429
without one is transient), then authentication errors and a
missing CLI (never transient), then the transient table. A run the runtime itself killed at
`limits.minutes`, an aborted run, a missing CLI and missing output are never classified. What the
engine does with a transient or quota result is section 8.3. `MW_TRANSIENT_BACKOFF_MS` replaces the
5000 ms base of the wait (tests set a few milliseconds).

**Confining write-mode Claude agents.** A write-mode Claude agent can run its shell commands in Claude
Code's sandbox, which lets them write only inside the working directory and the temporary
directory, never retries a command outside the sandbox, fails at start rather than run unconfined,
and allows network access only to common source forges and package registries. On Linux the
sandbox needs `bwrap` (bubblewrap) and `socat`, and a system that allows a nested unprivileged user
namespace; the runtime tries that once per machine (the probe) before relying on it. The probe
fails when a tool is missing, when the system refuses the namespace (as Ubuntu's default AppArmor
policy does), or when `MW_CLAUDE_SANDBOX=off` is set; `MW_CLAUDE_SANDBOX=on` skips the trial.

What happens then is the **sandbox policy**: `agents.sandbox` in `mergewright.yaml`, overridden per
machine by the environment variable `MW_SANDBOX` (same values; it can be set in the secrets file,
section 10.4, or in the `mw-work@` service unit). An unknown `MW_SANDBOX` value is a usage error.

| Policy | Behaviour |
|---|---|
| `auto` (default) | The sandbox is used when the probe says it works. Otherwise the agent runs unconfined, and the run records and prints one warning naming the reason, once per run however many write phases follow. |
| `off` | The host is isolated already (a disposable virtual machine, say). The probe never runs, nothing is warned, and the run state records `sandbox: off (isolated host)` once, at the start of the run. |
| `required` | A write phase does not start without a working sandbox: when one of its writing roles runs on `claude` and the probe fails, or on `shell` (which has no sandbox), the run is `blocked` before the phase, with a reason naming `run/sandbox-required`. |

The run state's `sandbox` field says what happened (section 8.1). The policy concerns the `claude`
harness's shell sandbox: `codex` write roles always use Codex's own workspace-write sandbox, `local`
and package harnesses cannot write, and `mock` is for tests. `mw doctor` prints the effective policy, where it
comes from, and the probe's result on this machine.

**Forbidden commands.** Claude agents are always refused these shell commands: `sudo`, `ssh`,
`scp`; `git push`, `merge`, `commit`, `reset`, `checkout`, `switch`, `stash`, `rebase`, `config`,
`worktree`, `branch`, `remote` and `update-ref`; starting `claude`, `codex` or `hermes` (another agent CLI); and every
`mw` command except `mw check`, `mw trace`, `mw memory search`, `mw docs` and `mw spec propose`.

### 8.7 Resume and the run lock

The run state is saved after every phase, so a run that stops for any reason (a stop point, a
block, `--until`, a crash, the machine switching off) continues with `mw run <CARD>` from the
phase it had reached, without redoing finished phases. Work an agent had not finished when its
process stopped is redone from the start of that phase.

Only one process runs a card at a time. The lock lives in `.mergewright/local/locks/<CARD>.lock`,
which is never file-synced: a machine that lost the lease can release its own lock without touching
anything the other machine sees. The lock is written completely under a temporary name and then
published under its real name with `link()`, which fails when the name exists, so no process ever
sees a half-written lock and of two processes starting at once exactly one gets it.

A lock names its process by pid and, where `/proc` exists, by the process start time (field 22 of
`/proc/<pid>/stat`); the guard and the orphans record below carry the same identity. A recorded
process counts as alive only while a process with that pid exists, is not a zombie (state `Z`), and
started at the recorded time: a pid the operating system has given to another process counts as
dead. Without `/proc`, and for a record written without a start time, the pid alone decides. A
lock whose process is no longer alive, or an unreadable one, is replaced.

Taking a lock and reclaiming a stale one happen under a short-lived guard (a `.guard` folder created
with `mkdir` next to the locks), so two processes cannot both judge the same lock stale and both win
(`run/registry-busy` when the guard stays taken for more than 35 seconds). The guard holds an owner
record: the holder's pid, its start time and a nonce naming this holding. A holder that waits while
holding it (on the hub, for example) refreshes the guard's modification time every 10 seconds.
Another process reclaims the guard only when its owner process is gone, or when its modification
time is older than 30 seconds (the holder has stopped making progress); a guard without an owner
record is judged by its age alone. A holder removes the guard only while the owner record still
names its own nonce.

The locks folder is this machine's registry of active runs. A run takes its lock before it takes the
hub lease, and releases it when it ends; a machine that is then refused the lease releases its lock
and has written nothing under `.mergewright/runs/`. Every automatic release of the lease (by
`mw run` and `mw approve` when their run ends, by `mw retry`, by `mw work` running out of work, by a
process that took the lease only for one push)
happens under the same guard, and only when no other run of this machine is registered: a run that
starts meanwhile keeps the lease it relies on. An explicit `mw lease release` by the owner is not
affected.

**Stopping a run at once.** A stop signal (Ctrl-C or `SIGTERM`) to `mw run` or `mw approve` aborts the
active phase: its agent's or gate's process group is ended, the command waits for the group to be
gone, saves nothing of that phase, prints how to continue, and exits with 130. A further signal only
repeats that it is stopping. `mw run <CARD>` then does that phase again.

A process group that is still alive after SIGTERM and SIGKILL (a process stuck on a hung disk or
network mount, say), whether the phase was stopped or timed out, is not left behind silently. The
runtime keeps killing it for up to two minutes (`MW_REAP_MS` sets another limit, for tests), while
the lease is still refreshed. When the group is gone in time, the command goes on as before.
Otherwise it ends with the error `run/orphans`, naming the process group and its pids, and exits 1,
not 130; the phase's result is not recorded. The group, with the pid and start time of each of its
processes, is written to `.mergewright/local/locks/<CARD>.orphans`. While any recorded process is
alive, the card does not start on this machine: `mw run`, `mw approve`, `mw retry` and `mw work`
refuse it (`run/orphans-alive`) after taking the run lock and before taking the lease. Zombies do not
count as alive. A record whose processes are all gone is removed at the next start. `mw abort`
consults the record too: while a recorded process is alive it leaves the worktree in place, and
refuses `--force` with `run/orphans-alive` (section 8.4).

### 8.8 Crash safety and long phases

Three rules keep a run safe when a machine crashes, a phase runs long, or the other machine takes
over. They are requirements of the engine, not options.

**Lease heartbeat.** A phase may run for `limits.minutes` (90 by default), while a lease may be
taken over after `limits.lease_minutes` (10). So while any phase is executing, the engine
refreshes the lease (section 9.3) on a timer, every `lease_minutes / 3` minutes, and it refreshes
the lease before every push.

**A machine that lost the lease writes nothing shared.** `.mergewright/runs/` is replicated between
the machines, so when the project has a hub, files under it are written only while this process
holds the lease. If a refresh shows that another machine now holds the lease, the engine stops the
running agent, discards that phase's result, makes no commit and no push, saves nothing, does
nothing to the worktree, prints what happened and exits with an error (code `lease/lost`). What the
phase left in this machine's worktree is dealt with the next time this machine works on the card
(it is moved aside, section 8.4). A merge through a forge stops too: the forge integration checks
the same signal before recording the pull request and before requesting the merge. The new holder's run state stays
authoritative.

**Every phase is safe to repeat.** The state is saved after a phase, so a crash between a phase's
side effects and that save makes the phase run again on resume:

- Role and gate phases only produce artifacts and commits on the card's own branch; repeating them
  costs time, nothing else.
- `merge` records the squash commit it is about to install (`pendingMerge`) before it moves the
  base branch. On entry, if that commit is already part of the base branch and passes the check in
  section 8.4 ("A recorded merge already on the base"), the merge has happened and only the clean-up
  is done; a commit that fails the check blocks the run. If the merged commit is recorded with `cleanupPending`, the
  clean-up is finished; each of its steps tolerates being already done. If the merge is recorded
  and clean, the phase is `ok` at once.
- `memory.update` is idempotent: a lesson with the same title is updated, a decision with the same
  title from the same card is overwritten, the state and the outcome are replaced, and the commit
  is skipped when nothing changed.
- `docs.sync` and `notify` may repeat; their receivers tolerate a duplicate.

### 8.9 Unattended work: `mw work`

`mw work` runs the cards the owner has marked `ready`, one after another, without anyone watching.
It is how a machine keeps working while the owner is away.

**Eligibility.** A card is picked up only when all of these hold:

- the card file says `status: ready` (the owner's signal; `todo` cards are never picked up);
- the card file is committed, with no local changes (the merge marks it done in a commit, which
  git would refuse over local edits);
- its run is not `blocked`, not `aborted`, not `done`, and not waiting for an approval (a run paused
  for usage is eligible, and so is an interrupted one);
- no other process on this machine is running it;
- every card it depends on exists and is done (by its run, or by its card file).

A card that is already merged (its file says `done`) but whose run has not finished its flow (the
machine stopped between the merge and the end of the flow, say before the reflection) is not done:
it is continued first, whatever its status line or dependencies say, unless that run is blocked or
waits for an approval, in which case it is listed with the reason. `mw status` shows such a card as
`done (run unfinished)`.

Interrupted and usage-paused runs are continued first, then new cards start, each group in card id
order. A card is taken at most once per pass; a card that failed with an error is not taken again in
the same session.

**Each pass.** Before taking a card, `mw work` reloads the project from disk and checks three
things: the hub lease (when another machine holds it and this machine may not take it over yet,
section 9.3, it waits), the usage guard (asked only when the project has a role on a paid harness;
when usage is too high, it waits), and a sync of the base branch with the hub (so cards and specs
that arrived from the other machine are seen). Then it runs the next eligible card exactly like
`mw run`, with the approval words given by `--approve`, and prints one summary line per card. Only
then does it retry the integration queue (section 10), bounded by the flush's time budget and the
per-kind breaker, so a service that does not answer never holds up a card (REQ-engine-009). The
retry runs between cards, after a card has ended and before the next one starts, with the lease
still held by this machine: on a project with a hub the lease stays with this machine between passes
that run cards, and a lease that only this process keeps never holds the queue back
(REQ-engine-012). A pass without a card (nothing eligible) releases the lease and then retries the
queue, also when the release failed (the hub did not answer: the lease is still this process's own);
a pass that must wait retries it too. The retry waits for two things on this machine, and only for
these: a run that is inside its merge phase (from entering that phase until the run ends or blocks;
another `mw` process's run counts), and a run that another `mw` process has registered (its run lock
is held by that live process, which keeps the lease for it). While either holds, the pass
skips the retry, says so in one line, and a later pass (or the end of the command) retries it; the
items it would have sent, and this process's reflection items, are left untouched. A retry never runs
inside a card's run or under the
repository lock. This retry, like the one of `mw run` and `mw approve`, is what delivers the lessons a
card's reflect phase recorded: the `memory.update` action only queues them for the semantic stores and
sends nothing while the card's lock and the lease are held (REQ-engine-008). The items are held by
this process until its own retry after the card, which releases their holds just before it flushes,
so a flush by another process skips them until then.

**Ending.** Without `--watch`, `mw work` stops when no card is eligible, when `--max N` cards have
run, or when the hub or usage guard says to wait. With `--watch` it never stops by itself: when
there is nothing to do, or it must wait, it says so once and looks again every `--interval`
seconds (default 60). When it runs out of eligible work it releases the hub lease, so the other
machine can take over at once, unless another run of this machine is registered (section 8.7); a
release that fails is reported, and the lease then expires by itself.
(`mw run` too releases the lease when it returns with its run done, blocked, aborted or waiting at
a stop point; section 9.3.) At the end it prints how many cards
are done, waiting and blocked, and, for every ready card left behind, why.

A first interrupt signal (Ctrl-C or `SIGTERM`) lets the current card finish, takes no new card,
releases the lease and exits 0. A second one aborts the current card's active phase as `mw run` does
(section 8.7): `mw work` waits for that phase's process group to be gone and exits with 130, and the
card continues from its last finished phase next time. When a process group of the current card's
run survives every attempt to kill it (section 8.7), `mw work` takes no further card, releases the
lease, and ends with that error (`run/orphans`, exit 1, also after a second signal). A card refused
because processes of an earlier run are still alive (`run/orphans-alive`) counts as failed with an
error, and the other cards go on. Otherwise `mw work` exits 1 when a card ended blocked or failed
with an error, or when the hub stopped the work, and 0 otherwise.

`mw work --dry-run` prints which cards would run, in order (and whether each starts or continues),
and why every other card that is not done would not. It runs nothing and does not contact the hub.

**Queued runs (REQ-engine-014).** A run's state says `running` from the moment a process takes it
until it is done, waits, blocks or is aborted; a process that died, a run stopped with `--until`
and a run set back by `mw retry` leave `running` with no process behind it. Such a run is
*queued*: `mw status` and `mw work --dry-run` print it as `queued ('mw work' or 'mw run <ID>'
resumes it at '<phase>')`, where `<phase>` is the phase its state records (it continues there; no
`--from` is needed). One function (`runDrive`, `src/engine/driver.ts`) decides it for both, and for
the summary of `mw_run_status`: the run is `running` while a live process of this machine holds the
card's run lock (section 8.7: the pid and its recorded start time, so a reused pid is a dead driver,
and an unreadable lock is no driver), or when its state names another host (that machine's
processes cannot be seen from here). Reading the status writes neither the run state, the lock nor
the lease. When the card of a queued run would not run (its status is not `ready`, it waits for a
dependency, or its card file has uncommitted changes), `mw work --dry-run` still lists it under "not
eligible" with its reason and adds the same label in brackets, `[queued (...)]`.

**As a service.** The MergeWright repository ships `ops/mw-work@.service`, a systemd unit that runs
`mw work --watch --interval 60` for one project, restarts it on failure, and stops it with
`SIGTERM` to `mw work` only (`KillMode=mixed`), allowing up to 4 hours (`TimeoutStopSec`) for the
current card to finish. The instance name is
the project's folder name. The unit is a template: `__USER__` and `__HOME__` stand for the user
it runs as and that user's home, so it runs in `__HOME__/workspace/<name>` with `__HOME__/.local/bin`
on `PATH`. `scripts/install-service.sh` fills them in for the user who runs it through sudo:

```bash
sudo scripts/install-service.sh work <name>   # for ~/workspace/<name>: install, enable, restart
journalctl -u mw-work@<name> -f               # watch it
```

The service never answers a stop point by itself: high-risk cards wait for `mw approve`.

### 8.10 Sending a card back: `--from` and `mw retry`

When a card is blocked and the owner has fixed the cause (for example widened the card's scope
because the planner refused it for a document outside it, or corrected a spec), the run usually
should not just retry the phase that blocked: it should go back to an earlier phase, often the
brief. Two commands do that:

- `mw run <CARD> --from <PHASE>` sets the run back to that phase and continues running from there,
  on this machine.
- `mw retry <CARD> [--from <PHASE>]` sets the run back to that phase and stops there without running
  anything, then releases the hub lease (unless another run of this machine is registered; a failed
  release is reported and the command exits 1), so that whichever machine runs `mw work` picks the
  card up (it is eligible again once it is no longer blocked). Without `--from` it goes back to the flow's
  `remediate.phase`, or to the first phase when the flow has none.

Going back starts a new generation of the run. A merge that was interrupted after recording its
commit (`pendingMerge`) is reconciled first. When that commit is already on the base branch and
passes the same check as a resumed merge (section 8.4, "A recorded merge already on the base"; the
merge evidence is judged on the run's artifacts as the runtime wrote them), the run is marked merged
and the rewind is refused (`run/merged`; `mw run <CARD>` finishes the clean-up). A recorded commit on
the base branch that fails the check is not the card's merge: it is set aside with a run warning
saying why, and the rewind goes ahead. A recorded commit that never reached the base branch is
cleared. In both of these cases the merge is built again later from the redone work. Approvals for
the target phase and every later phase are dropped, so their stop points ask again, and the artifacts
those phases produced are no longer used for conditions, `needs` or prompts (their hash-named files
stay in `artifacts/`, and the history keeps every entry). Going back sets the status to `running` and
clears the block reason and the remediation detail.
When the target is the remediation phase or a phase before it, the round counter goes back to 0,
so the card gets its fix rounds back; a later target keeps the count. Going back always clears the
phase-visit counts (`limits.phase_visits`, section 8.2). Both are refused once the card
is merged (`run/merged`: make a new card for further changes), and for a phase the flow does not
have (a usage error). Both take the hub lease like any run; neither takes `--offline` (a usage
error naming `mw sync --offline`, section 8.2).

## 9. Two machines, one repository state

With `git.hub: none` (the default) none of this section applies: the project runs on one machine,
and `mw sync` and `mw lease` say so. `mw init` sets `git.hub` only when the repository has a remote
named `hub`; another remote (such as `origin`, often a public forge) is never used as the hub unless
the owner names it.

### 9.1 The arrangement

A project can be driven from two machines, for example a laptop while it is in use and a server
when the laptop is off, with these rules:

- **Working files are shared by a file-sync tool** of the owner's choice, both ways. Of `.mergewright/`, only
  `.mergewright/runs/` is shared, so run state follows the work.
- **Three paths are never shared.** The file-sync tool's ignore list on both machines must contain
  these lines:

  ```
  .git
  .mergewright/worktrees
  .mergewright/local
  ```

  Each machine has its own git metadata, its own card worktrees, and its own `.mergewright/local/`:
  run locks, the record of when it first saw the other machine's lease, the integration queue,
  temporary files, the usage flag and discarded worktrees. Half-synced worktree files would
  otherwise leak into commits, and a shared queue could be delivered twice. An older
  `.mergewright/lease-seen.json` line is no longer needed. Items an older runtime left in the
  shared `.mergewright/queue/` are moved into one machine's queue only by `mw queue adopt`, run on
  one machine (section 10).
  `mw doctor` checks these lines in the folder's `.stignore` when the project is inside a synced
  folder (one with a `.stfolder` marker) and has a hub.
- **History travels through the hub**, a git remote named in `git.hub` (for example a bare
  repository on the server). Card branches and the base branch travel only there.

### 9.2 Sync and adopt

Because files arrive by file sync while history arrives through the hub, a machine can hold the
newest files with older git metadata. It **adopts** the hub's history: it moves its base branch to
the hub's commit and resets the index to match, without touching working files. After adopting,
`git status` is clean, and genuine local edits remain as modifications. Adopt happens only when the
local branch is an ancestor of the hub's, so it never discards a local commit.

Adopt is a compare-and-swap. It refuses when the index holds staged changes (`hub/staged`: commit or
unstage first). It reads the branch, and moves it with
`git update-ref <branch> <hub commit> <commit it read>`, which fails if the branch moved in the
meantime (`hub/head-moved`: nothing was changed, run `mw sync` again); only then is the index reset
with `git read-tree`.

`mw sync` (and every `mw run`) brings the base branch in the main checkout level with the hub:

| Local branch compared with the hub | Action |
|---|---|
| Equal | Nothing. |
| Behind (an ancestor) | Adopt. |
| Ahead | Push. |
| Diverged | Stop with an error naming both commits; nothing is changed and the owner resolves it. |
| The hub has no base branch yet | Push. |
| Hub unreachable | Error. `mw sync --offline` contacts nothing and changes nothing. `mw sync` is the only command that accepts `--offline`; the commands that run or change cards refuse it as a usage error (section 8.2). |

Sync works only when the main checkout is on the base branch. Git is never allowed to wait for a
password or host-key prompt: a hub that would need one is reported as unreachable. After a successful `mw sync`, the worktrees on this machine of cards that are done on the
base branch are removed (section 9.4).

### 9.3 The lease

Only one machine drives a project at a time. The lease is a git reference on the hub,
`refs/mergewright/lease`, pointing at a commit whose message is the JSON `{host, pid, time}`, plus
`started` (the process's start time, where `/proc` gives it) and `kept: true` for a lease the owner
holds on purpose (`mw lease take`, or `--keep-lease` at the end of a run). A
machine is named by its host name, or by `MW_HOST` when that is set. Taking or refreshing the lease
is a compare-and-swap push (`git push --force-with-lease`), so two machines can never both win.

**Takeover.** The two machines' clocks may disagree, so a lease held by another machine is not
judged stale by its own timestamp alone. This machine may take it over when either:

- it has seen the same lease commit, unchanged, for at least `limits.lease_minutes` by its own clock
  (the time it first saw that commit is kept in `.mergewright/local/lease-seen.json`), or
- the lease's own timestamp is older than three times `limits.lease_minutes`.

An unreadable lease counts as expired. Otherwise a take is refused (`hub/lease-held`) with the time
until takeover is allowed; `mw lease take --force` takes it over at once, for when the other
machine is known to have stopped.

**Fencing.** Every change to the hub, from any process, is one atomic push that also moves the
lease, guarded by the lease commit the process last wrote: pushing a card branch or the base
branch, and deleting a branch. If another machine has taken the lease in the meantime, the hub
applies nothing and the process stops with `hub/lease-lost`. A process that does not hold the lease
and needs to push (`mw sync` when the base branch is ahead, `mw abort` deleting a branch) first takes
the lease by compare-and-swap (refused with `hub/lease-held`, naming the holder, while another
machine holds one that may not be taken over yet), pushes fenced by it, and releases it again,
unless this machine held it before (another `mw` process here is driving the project and keeps it)
or another run of this machine registered meanwhile (section 8.7). When that release fails although
the push landed, the command says so ("the push landed, but the lease taken for it could not be
released"); the lease then expires by itself, or `mw lease release` removes it.
A lease moved by another `mw` process on the same machine still counts as this machine's, unless it
is stale here (below). When the
hub refuses a fenced push three times for another reason, the process stops with `hub/push-refused`
and nothing has changed on the hub. There is no unfenced push to the hub anywhere in the runtime.

**During a run.** `mw run` takes or refreshes the lease and then syncs; during the run the lease is
refreshed at every phase boundary, on a timer while a phase runs, and before every push
(section 8.8). When `mw run` or `mw approve` returns with the run `done`, `blocked`, `aborted` or
`waiting` (at a stop point, or paused for usage), it releases the lease, so the unattended `mw work`
on the other machine can go on at once; it keeps it when `--keep-lease` is given (then as a `kept`
lease, the owner's hold) or when another run of this machine is registered (checked under the
registry's guard, section 8.7). A waiting run does not need the lease: its stop point
is in the run state, and whichever machine answers it (`mw approve`) takes the lease again. A lease that is not
this machine's is left alone, and a release that fails is reported (the lease then expires by
itself) without changing the exit code. `mw work` releases the lease when it runs out of work, and
`mw lease release` hands over at once.

**A stale lease of this machine**. A lease that names this machine is stale here when
the process that wrote it is gone (its pid, and the recorded start time, so a reused pid does not
count), it is not `kept` and no run of this machine is registered (section 8.7); a run waiting at a
stop point or paused does not hold it. A process that left one behind (a crash, an `mw approve` that failed) no longer
pins the project to this machine: `mw lease show` says the lease is stale, `mw lease release`
releases it (no `--force` needed, as for any lease of this machine), and the next taker here (`mw
run`, `mw work`, `mw sync`, a committing MCP tool) takes it over as its own, with a warning, so one
that took it only for a single change releases it again afterwards.

**Commands.** `mw lease show` prints who holds the lease and how long ago it was refreshed by the
holder's clock; for another machine's lease, how long until this machine may take it over; for
this machine's lease, that it is stale when it is (above), else a reminder that it is kept until
released. `mw lease take` takes the lease (as `kept`) when it is free or may be taken over, or
refreshes it when this machine holds it; `--force` takes over a lease that is still fresh. `mw lease release` deletes the lease when this machine holds it,
and leaves another machine's lease in place (exit 1).

### 9.4 Taking over a card, and cleaning up

A machine that continues a card started elsewhere fetches `card/<CARD>` from the hub, brings its own
worktree level with it (creating it if needed, and setting aside obsolete leftovers as described in
section 8.4), reads `.mergewright/runs/<CARD>/state.json` (which file sync already delivered), and
continues from the phase recorded there.

A card finished on one machine leaves a worktree and a local branch on the other. At the start of
every run, and after every successful `mw sync`, the runtime removes them: for every worktree under
`.mergewright/worktrees/` whose card file on the base branch says `status: done`, it runs the
worktree check (section 8.4), requires the worktree to be clean, moves it to
`.mergewright/local/discarded/` (kept seven days) and deletes the local `card/<CARD>` branch. A worktree that fails the check or has uncommitted changes is kept, with a
message saying why.

## 10. Integrations

Integrations connect a project to external services. Every integration is optional: a project
with none configured works completely, and a service that is configured but down never blocks a
merge. Each integration does nothing when its section of the configuration is absent. When a
configured service cannot be reached, the request is written to this machine's queue,
`.mergewright/local/queue/` (one JSON file per item, oldest first), and the run continues;
`mw queue` lists the waiting items and `mw queue flush` retries them (`mw run` and `mw approve`
also retry them once the run has returned and the lease has been released, and `mw work` between
cards, section 8.9; a run itself never does, under its lock and the lease). When `mw run` or
`mw approve` keeps the lease (`--keep-lease`, another run of this machine, a failed release), the
queue is not retried and the command says that the next queue flush retries it. `mw work` and
`mw queue flush` never wait for a lease that only this process keeps (REQ-engine-012), whether it was
kept between cards or because its release failed. Both wait while a run of this machine is inside its
merge phase (its run lock is held by a live process and its state is `running` at the flow's `merge`
phase; it counts from entering that phase until the run ends or blocks): `mw work` skips that flush
and retries at its next safe point, and `mw queue flush` says which card it waits for, looks again
every two seconds, and flushes once no run of this machine is merging. `mw work` also skips the
flush while another `mw` process of this machine has a run registered (that process keeps the
lease, section 8.9). `mw queue flush` is the owner's request and does not look at the lease or at
other processes' runs: items another
process still holds (below) stay skipped as `held`, so the reflection items of a run another
process keeps the lease for are not delivered by it. The queue is per machine and never file-synced, so the two
machines never see the same item and retrying needs no lease. Items an older runtime left in the
shared `.mergewright/queue/` are not delivered from there: `mw doctor` reports them, and
`mw queue adopt`, run on one machine only, moves them into that machine's queue (the moved items
then disappear from the other machine through file sync). Only the forge merge reports failure to the engine, because the
engine needs its answer.

Queue replay is exact. Before delivering an item, a flush claims it by renaming it to
`<name>.claimed-<pid>`, so two flushes on the same machine never deliver the same item; a failed delivery renames it back, and a claim older than ten minutes (its process died) is
released. An item that was partly delivered (some lessons stored, others not) is rewritten with only
what remains. Items of records (kind: a package store's name, such as `mem0` or `letta`) are delivered one record at a time: before
sending a record the flush checks whether the service already holds it (same `lesson_id`, same
text; a write that timed out may still have landed) and skips it if so, and after each record the
claimed item is rewritten with the records left, so a delivery cut short by a timeout, a crash or
Ctrl-C never sends a record twice. The first error stops that item, which keeps the records not yet
delivered; the flush goes on with the next item. A deliverer may also drop an item that must not be delivered any more (a Kanban
status the card has since left, section 10.5); `mw queue flush` then removes it and says why.

An item recorded under the repository lock by a locked MCP tool (section 12.5) is held for the
process that recorded it: the item names it (`holdPid`, the process id; `holdSince`, an ISO time for
people reading the queue; and, where `/proc` exists, `holdStart`, the process's start time from
`/proc/<pid>/stat`), the only change to the item format apart from the breaker's file. A hold lasts as
long as that process: while a process with that id exists (also one of another user) and, when
`holdStart` is recorded, still has that start time, no flush delivers the item, however old the hold
is; it is skipped like an item skipped by the budget (no request, the file and its attempt count
untouched; `mw queue flush` lists it as kept). A different start time means the id was reused by
another process, and the hold is ignored. When the holder's transaction has released both the lock and
the lease, it clears the hold (rewriting the item atomically) and delivers the item; when it keeps the
lease, the hold stays until the process ends. An item whose holder has stopped is delivered by the
next flush like any other.

Flushes are bounded (REQ-engine-009). A flush has a time budget of 20 seconds: no item starts once
it is spent, and a request still in flight then is cut. A command a delivery runs (the notify
`report.command`, the `kanban` CLI) cannot be interrupted that way, so in a flush it is given at most
what is left of the budget (at least a quarter of a second) instead of its own limit; a command not
started before the budget is spent is not run. An item cut by the budget, request or command, counts
one attempt (its error says the budget ran out) and keeps what it had not delivered (a kanban item is
kept, not dropped as unreachable), and the items not reached stay queued untouched, byte for byte.
Each kind (`notify`, and each package's kinds such as `mem0`, `letta`, `open-notebook` and `cline-kanban`) has a breaker:
when its deliveries time out twice in a row (a request or a command that timed out on its own limit,
not one cut by the budget), the kind is skipped without a request for ten minutes, and then tried again (one
more timeout opens it again); a success, or any other error, resets the count, and a kind's breaker
never affects another kind. Items skipped by the budget or a breaker are not touched: their attempt
counts are neither raised nor reset. The breaker's state is kept on this machine only, in
`.mergewright/local/queue/.breaker` (a dot file, never taken for an item), so it and every item's
attempt count survive a restart. Each outcome is read, applied and written (to a temporary file,
then renamed) while holding `.mergewright/local/queue/.breaker.lock`, created exclusively with its
owner's token (process id and a random tag), so two flushes of this machine (two processes, or a
background delivery beside `mw work`) never lose each other's outcomes. A lock older than five
seconds was left by a process that stopped and is removed, but only if it is still the same lock
(token and modification time) when it is moved aside. An owner removes the lock only while it holds
its token, and writes only while it still owns the lock; one that lost it takes it again and reads
the state again. Within a flush, the wait for that lock ends at the flush's own deadline (an outcome
may always try for a moment): when the lock is still taken then, that one outcome is not recorded in
the breaker (best effort under contention), while the item's own file, with its attempt count, is
written as usual. `mw queue flush`, run by the owner, has no budget (its commands keep their own
limits, 60 seconds for notify) and tries kinds
whose breaker is open too (their outcomes still update the breaker).

`mw integrations` (also `mw doctor`) shows, for each integration, whether it is configured, whether
its service answers, and whether the environment variables it needs are set; it never prints a
secret. It also has a `sync` line: when the project is inside a synced folder (one with a `.stfolder`
marker) and has a hub, it checks that the folder's `.stignore` (following `#include` lines) contains the three exclusions of
section 9.1, and names any missing line as a problem. It exits 1 when there is such a problem. For
each enabled package it prints a line when the package did not load, and one line per check the
package provides (`<check>  ok|NOT ok  <detail> (package <name>)`).

| Integration | Configured by | Status |
|---|---|---|
| Notifications | `report.command` | Built and tested; not yet verified with a live messaging service |
| Semantic memory (mem0) | the `mem0` package, `packages.mem0` | Built and tested; the core integration it replaces was verified against a live server |
| Agent memory (Letta) | the `letta` package, `packages.letta` | Built and tested; the core integration it replaces was verified against a live Letta server |
| Documentation (Open Notebook) | the `open-notebook` package, `packages.open-notebook`, and `docs.paths` | Built and tested; the core integration it replaces had sync and search verified against a live server |
| Kanban mirror | the `cline-kanban` package, `packages.cline-kanban` | Built and tested, with the limits in 10.5; the core integration it replaces was verified against a live Kanban runtime |
| Documentation (OpenNoteLM) | the `notebook-opennotelm` package, `packages.notebook-opennotelm`, and `docs.paths` | Built and tested against a fake server only: written from the upstream source (section 15.6), not yet run against a live instance |
| Board mirror (4ga Boards) | the `board-4ga` package, `packages.board-4ga` | Built and tested against a fake server only: written from the upstream source (section 15.5), not yet run against a live instance |
| Forge merge (Gitea, GitHub) | `git.forge` | Experimental: tested only against simulated servers, and `mw doctor` says so |
| Usage guard | `usage` | Built and tested; not yet verified against a live usage source |
| Local model tier | `local_models`, roles with `runs: local` | Harness built and tested; verified live against a llama.cpp server (`mw_delegate` with `runs: local`, key from `local_models.key_env`) |

The engine calls the integrations at fixed points: notifications when a run waits, is blocked,
pauses for usage or is done, and at `notify` actions; recall (enabled packages) when building
`{{memory.recall}}`; remember (package stores: queued only, delivered by the queue retry after the card: `mw work` between cards, `mw run` and `mw approve` after the lease is released) and documentation sync at the `memory.update` and `docs.sync` actions; the usage guard
before each write-mode role; the card mirrors of packages (`mirrorCard`) whenever a card's live status changes, and their `reconcile` when `mw work` starts and finishes; the forge at
`merge`.

### 10.1 Notifications

With `report.command` set, the runtime writes the message body to a temporary file and runs the
command, after replacing `{subject}` with the subject and `{file}` with the file's path. The
command is split into arguments like a shell would (quotes group, a backslash escapes) but no
shell runs it, so substituted values are never re-split or interpreted. It runs from the project
root and must finish within 60 seconds; a failure queues the notification. Any messaging tool (a
chat bot, mail, a desktop notifier) fits behind that command.

### 10.2 Semantic memory: the `mem0` package

The memory files in `memory/` are the project's memory (section 7.2). mem0 holds the same lessons
as searchable facts, so that recall can find relevant lessons by meaning rather than by keyword.
mem0 is no longer part of the core: it is the official package `packages/mem0` (section 15),
installed with `mw add mem0`, which uses only the package API. The core setting `memory.mem0` of
earlier versions is refused (`config/schema`, section 3.1): run `mw add mem0`, move its settings to
`packages.mem0` unchanged, and delete `memory.mem0`.

| Setting (`packages.mem0.`) | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | Base URL of the mem0 server. |
| `user` | string | the project's `name` | The mem0 user id (namespace) under which this project's memories are stored. |
| `key_env` | variable name | `MEM0_API_KEY` | The environment variable that holds the API key; the package declares it as its secret, so its value is redacted (section 10.4). |
| `write_timeout_ms` | integer ≥ 1 | `180000` | Timeout of one write (`POST /memories`), in milliseconds. Reads keep 10 s. |

- `memory.update` queues each new lesson for mem0 (kind `mem0`, section 10) and sends nothing
  during the run (REQ-engine-008); the queue retry after the card (section 8.9) stores it under the
  project's namespace (`packages.mem0.user`), with its topic, title, card and project as metadata.
  Lessons are stored as written, with mem0's own inference off, so what a lesson says never depends
  on which model processed it. A lesson already waiting in the queue is not queued again; those
  already stored are not sent twice.
- When building `{{memory.recall}}`, the runtime adds mem0's best hits for the card's title,
  requirement titles and scope, as `title: first paragraph`, to the keyword hits from `memory/`.
  When mem0 does not answer, recall simply has no extra hits.
- The API key is sent in the `X-API-Key` header, from the variable named by `key_env`.
- Timeouts depend on the call: the probe, the listing and searches give up after 10 seconds; a write
  (`POST /memories`) after `write_timeout_ms` (default 180 seconds), because the server embeds every
  write (and, with inference, runs a model over it), which takes seconds per lesson when idle and
  much longer under load.
- Each lesson carries a stable id in its metadata (`lesson_id`, the SHA-256 of project, topic and
  title), so a duplicate delivery can be recognised. The reflect phase only queues lessons. Queue
  replay delivers a queued item one lesson at a time and looks each up first
  (section 10), so neither a partial delivery nor a write that timed out but landed is stored twice;
  `mw memory add` and `mw memory push` look them up too (section 7.2, "The semantic stores").
- It provides the MCP tools `mw_mem0_add` and `mw_mem0_search` (section 12.3), the `mem0` check of
  `mw doctor`, and the store `mw memory push|prune --service mem0` use.
- mem0 is a mirror: deleting it loses nothing, because the files are the source of truth.

### 10.3 Documentation: the `open-notebook` package

Open Notebook provides retrieval and question-answering over each project's documentation. It
does not hold agent memory. It is no longer part of the core: it is the official package
`packages/open-notebook` (section 15), installed with `mw add open-notebook`, which uses only the
package API. The core setting `docs.notebook` of earlier versions is refused (`config/schema`,
section 3.1): run `mw add open-notebook`, move its settings to `packages.open-notebook` unchanged, and
delete `docs.notebook`. The core keeps the documentation itself (`docs.paths`, `docs.exclude`, the
`docs.sync` action and `mw docs search`) and hands the files to every enabled package that mirrors
documentation (`docsSync`, section 15.3), reading them for it as git blobs (`host.docs`).

| Setting (`packages.open-notebook.`) | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | Base URL of the Open Notebook API (`/api` is added when missing). |
| `name` | string | the project's `name` | The notebook that holds this project's documentation. It is created when missing. |
| `key_env` | variable name | `OPEN_NOTEBOOK_PASSWORD` | The environment variable that holds the Open Notebook password; the package declares it as its secret, so its value is redacted (section 10.4). |

Each project has one notebook (`name`), created on first use; each documentation file is one text
source in it, titled with the file's path in the repository.

Documentation is kept current in three places, so that it does not depend on anyone remembering:

1. **The worker is told.** The brief's `docs` field lists the documents the card must update,
   chosen by the planner from the paths the card touches, and the card's own `docs` adds to it.
   The worker's handoff reports the documents it updated in `docs_updated`.
2. **The reviewer checks.** The reviewer's prompt makes a change in behaviour without a change to
   its listed documents a finding, blocking when the brief named the document.
3. **The runtime synchronises.** The `docs.sync` action takes the files changed and deleted by the
   merge that match `docs.paths`. Files are read as git blobs of the merged commit, never from the
   working tree, and the batch names that commit, so a batch replayed from the queue sends exactly
   what the commit held. A symbolic link (or anything that is not a file in that commit) is skipped
   with a warning, and so is a binary file: one whose extension is `pdf`, `png`, `jpg`, `jpeg`,
   `gif`, `webp`, `svg`, `ico`, `bmp`, `zip`, `gz`, `tgz`, `woff`, `woff2`, `ttf`, `otf`, `mp3`,
   `mp4`, `mov`, `wav`, `docx`, `pptx` or `xlsx`, or whose first 8 KB contain a NUL byte. A binary
   file is never sent to the notebook, which takes text sources only; the action's detail and
   `mw open-notebook sync --all` count the skipped files. Files matching `docs.exclude` are left out
   without a warning. Before delivery, every path, queued ones included, must be a plain path inside
   the repository (no `..`, no leading `/`) and match `docs.paths`; others are refused with a
   warning. For each path, the old source with that title is removed and, when the file exists in
   the commit, a new source is added with its text. When the notebook does not answer, the batch is
   queued on this machine (kind `open-notebook`) and the queue retry sends it. A full
   resynchronisation, `mw open-notebook sync --all`, rebuilds the notebook from the tracked files of the last commit, so the
   notebook can always be reproduced and is never the only copy of anything.
   `docs.paths` stays the index of the notebook: a file outside it is never synced, but the
   action's detail names the changed (or deleted) files of the merge it did not consider because
   they are outside `docs.paths` (every such file of a `docs` card; files ending in `.md`, `.mdx`,
   `.markdown`, `.rst`, `.adoc` or `.txt` of any other card; not the files `docs.exclude` names nor
   the files of the reserved folders of section 2.2 other than `docs/`, nor `.mergewright/`), at
   most five by name, as "not synced: apps/api/evals/README.md is outside docs.paths (...)", so the
   owner can widen `docs.paths`.

The package also provides `mw open-notebook ask <question>` (an answer written from the notebook's
sources with the server's default chat model), its hits in `mw docs search` and `mw_docs_search`
(labelled `open-notebook`; by meaning, or plain text with `--text`, sorted by relevance, each with a
snippet of at most 160 characters around the query), the MCP tools `mw_docs_ask` and `mw_docs_sync`
(section 12.3), and the `docs` check of `mw doctor` (whether the server answers, how many notebooks
it has, and whether the project's exists yet: a project never synced has none, which is no fault).
Agents can also query the notebook during their work through Open Notebook's MCP server, defined
like any other server in `mcps/` (the `docs` example in section 4.7). The password is sent as
`Authorization: Bearer`, from the variable named by `key_env`.

### 10.4 Secrets

Secrets live outside every repository and outside every synchronised folder, in environment
variables. Every `mw` command first reads the per-machine file `~/.config/mergewright/env` (or the
file named by `MW_ENV_FILE`): lines of `NAME=value`, optionally preceded by `export`, with `#`
comments; a variable already set in the environment wins. Keep that file readable only by its
owner (mode `0600`).
The configuration and MCP files name environment variables and never contain values (sections 3
and 4.7). Nothing secret goes into `.mergewright/`, `memory/`, card files, mem0, Letta, the notebook or any package's service;
queue entries and command output name variables, never their values, and URLs in messages have
their credentials and query strings removed. Text a model wrote is passed through credential
redaction before it is stored in memory (section 7.2), and so are gate outputs before they go into a
prompt (section 4.6). Gates and agents get minimal environments, so a secret loaded for an
integration does not reach them. Advisory agents never receive a token.

The run directory is file-synced to the other machine (section 8.1), so what the runtime writes
there is redacted first: agent streams, saved exchanges and prompts, reply files, the gate's log, its
summary and step logs and the gate detail. Nothing writes there unredacted first: agents and gates
write their own files (the Codex reply, the gate summary and step logs) in this machine's unsynced
scratch folder, and the runtime copies them in redacted (sections 8.3, 8.6). The redactor replaces with `[redacted]` the values of every configured
credential variable (the `key_env` of `local_models`, every
secret an enabled package declares (section 15), and `git.forge.token_env`, or both of its defaults
`GITHUB_TOKEN` and `GITEA_TOKEN` when it is not set) and of every variable the project's
MCP servers reference in `env` or `headers`, of every literal value those `env` and `headers` hold,
together with the resolved values a role's servers get;
values shorter than six characters are not replaced, as they would blank out ordinary words. Then it
applies the credential-shape redaction used for memory. A value split across two output chunks is
replaced too (section 8.6). The engine also redacts the text, error and parsed reply of every harness
result at the one point where it receives it, so the run state (`error`, history detail, block
reason, warnings) and notifications never carry such a value, whichever harness produced it. The
values themselves are never logged or put in a message. Resolved
MCP values never reach the run directory or a command line (section 4.7).

Git commands the runtime runs get a minimal environment too, built up rather than filtered from the
runtime's own: the base variables an agent gets (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
`LANG`, `LC_ALL`, `TERM`, `TMPDIR`, `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, where set) and `GIT_TERMINAL_PROMPT=0`; from the runtime's environment,
every `GIT_*` variable, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `LANG` and `LC_*`, but never one loaded
from the secrets file; and exactly the variables the runtime passes for that one command. Nothing
else reaches git or a program git starts, such as a `core.sshCommand` a worker wrote into the
repository's configuration, and repository hooks never run under the runtime
(`-c core.hooksPath=/dev/null`). Every runtime git command also runs with `--literal-pathspecs`
(a global option, before the subcommand): a path the runtime names, such as a card file called
`cards/*.card.md`, selects that one file and is never expanded as a pattern. Proxy and certificate
variables (`http_proxy`, `HTTPS_PROXY`, `no_proxy`, `SSL_CERT_FILE` and the like) do not reach
runtime git either: configure git itself (`http.proxy`, `http.sslCAInfo`) instead.

### 10.5 Kanban mirror: the `cline-kanban` package

Card files are the source of truth. With the official package `cline-kanban` (section 15, installed
with `mw add cline-kanban`), each card's id, title and live status is mirrored to a Cline Kanban board
through the `kanban` command-line tool, so the owner can watch the work on a board. The board is a
view: changes made on the board do not flow back into card files. Each card appears as a task whose
title starts with `[<CARD-ID>] `. The mirror is no longer part of the core: `cards.mirror: kanban`
and `cards.kanban_path` of earlier versions are refused (section 3.1); run `mw add cline-kanban` and
move `cards.kanban_path` to `packages.cline-kanban.path`.

| Setting (`packages.cline-kanban.`) | Type | Default | Meaning |
|---|---|---|---|
| `path` | string, an absolute path | the project root | The project's path as the Kanban board knows it: the checkout on the machine where the board runs. |

| Status | Column |
|---|---|
| `todo`, `ready`, anything else | backlog |
| `in_progress`, `running` | in progress |
| `review`, `waiting`, `blocked` | review |
| `done`, `aborted` | trash (done) |

The tool can create a task (in the backlog) and move it to the trash, but it moves a task to "in
progress" or "review" only through an agent session that Kanban itself started, which MergeWright
never does. Retrying such a move cannot help, so it is never queued: the run records the one-line
warning "kanban: the CLI cannot move tasks to in_progress or review (only a Kanban agent session
does), ..." once, and the board machine's reconcile (`mw cline-kanban mirror`, `mw work`, below) reports
the card. A queued item of that kind (left by an older runtime) is dropped, with that reason, at its
first delivery attempt instead of being retried. Without the `kanban` tool on the path the mirror
does nothing.

A board runs on one machine and knows the project by that machine's path, `packages.cline-kanban.path`
(default: the project root). A status is mirrored only from a machine where the board answers for
that path (the `kanban task list` of the path succeeds). Elsewhere (the Kanban server is down or not
reachable from this machine, or does not know the path) nothing is queued, since such an item could
never be delivered there: the run records the one-line warning "kanban: mirror skipped on <host>
(board not reachable here); the board machine reconciles" once and continues. The board machine
catches up with `mw cline-kanban mirror`, which brings the board level with every card's live status (the
run's status when a card has a run, else the card file's) and is idempotent; `mw work` does the same
once before it takes cards and once after it ran some (the package's `reconcile`), when the board answers.
`mw work` prints the reconcile's line only when the cards the board cannot show right (a card in
`running`, `waiting`, `blocked` or `review` that only an agent session can move) differ from those
it last printed on this machine (remembered in `.mergewright/local/packages/cline-kanban/reported`), so an
unattended `mw work --watch` does not repeat it in its journal; `mw cline-kanban mirror` always prints
every card. The reconcile also drops a queued Kanban item of such a card.
A card that is done (or aborted) and has no task on the board, because it ran on a machine where
the board did not answer, is created and then moved to the trash, so the board keeps the history of
every card; `mw cline-kanban mirror` reports it as "created and closed".
`mw queue flush` drops a queued Kanban item (kind `cline-kanban`) whose target status differs from the card's current
status (the run's status when the card has a run, else the card file's: the item is stale and the
reconcile shows the current one), one that this machine cannot deliver because the board does not
answer here, and one whose column only an agent session can reach (above). The package also
provides the `kanban` check of `mw doctor` (whether the board answers for the path and how many
tasks it shows; on a machine where `path` does not exist, that the board is on another machine) and
the MCP tools of section 12.3 (group kanban). A Kanban board
grants terminal and repository access to anyone who reaches it, so it must be served only on a
private network, with its passcode enabled, and never exposed publicly.

### 10.6 Forge

With `git.forge.kind` set to `gitea` or `github`, the merge goes through a pull request (section
8.4): the runtime finds the open pull request from the card branch to the base branch or opens
one, then squash-merges it through the forge's API and records the resulting commit.
`git.forge.repo` is `owner/name`; Gitea needs `git.forge.url`, while GitHub defaults to
`https://api.github.com`. The token comes from the variable named by `token_env`.

The merge is verified, so that a retry never merges twice and a doubtful merge is never trusted:

- the pull request's number is saved in the run directory (`forge.json`) before the merge is
  requested;
- a retry looks that pull request up by number, open or closed: one that is already merged counts
  as success, and one that was closed without merging stops the run with instructions;
- success needs the forge to report the pull request as merged, with a merge commit; a pull request
  reported merged without one gives `merge/no-commit`, which blocks the run (section 8.4, the forge
  check);
- the engine then requires that commit to be on the local base branch after syncing with the hub,
  with the re-gated base as its first parent and the gated tree (section 8.4, the forge check).

A pull request that cannot be merged because of conflicts is reported as a conflict, any other
refusal as a failed merge; the engine treats both as outcome `fail`. With `kind: none`, the runtime
merges locally and no forge is contacted. The forge integration is experimental: it has been
tested only against simulated servers.

### 10.7 Usage guard

Subscription models have usage windows. With `usage.command` set, before every attempt of a role on
a paid harness (every one but `local`, `shell` and `mock`: `claude`, `codex` and any a package provides; a read-mode reviewer as much as a writing worker;
section 8.3), the in-invocation validation retry after a schema or adjudication check failure
included, before `mw_delegate` or `mw_review` starts an agent on one (section 12.4), and at each
pass of `mw work` before it takes a card when the project has a role on a paid harness (section 8.9), the runtime runs that command, which prints a JSON object such as `{"max_used": 72.5}`: the highest
usage across the windows that matter, as a percentage (a value of 1 or less is read as a fraction,
so `0.725` means 72.5%). When usage reaches `usage.pause_at_pct`, the run pauses and the owner is
notified; it stays paused until usage falls below `usage.resume_below_pct`, so it does not
flap around a single threshold. A refusal before any attempt, the first, a transient retry, the
`fallback_model` or the validation retry, starts no agent and pauses the run for usage (status
`waiting`, reason `usage`) without spending a round; `mw_delegate` and `mw_review` report it as
`delegate/usage`. The paused state is kept in `.mergewright/local/usage-paused`, per machine.
A reading at or above `usage.pause_at_pct` writes the file again even when it exists, always as a
new file (written under a temporary name and renamed into place). A reading below
`usage.resume_below_pct` clears it by compare-and-remove. The clear and the writer of a high reading
hold one exclusive lock, `usage-paused.lock` (created with an exclusive create; it holds the owner's
pid, the time and a random value), so a clear and a high reading never interleave. Under the lock the
clear reads the flag again and compares what it finds (content, modification time and inode) with
what this reading saw when it began. If it is the same, the flag is unlinked. If it differs, another
process wrote or renewed the pause meanwhile, so the flag stays and the guard says another reading
kept the pause. If the flag is already gone, another process cleared it. A busy lock is tried a few
times over about 50 milliseconds; a lock that cannot be taken keeps the run paused, removes nothing
and writes nothing, and the guard's detail says why. A writer of a high reading whose tries run out
therefore returns paused without having written the flag: that reading is not recorded, and the next
high reading writes it. A lock is released only while it is still the
holder's own. After writing its owner and right before it acts, the holder reads its lock again. A
holder that stalled between creating the lock and writing its owner may have had the lock taken over
as stale meanwhile, so when the lock no longer has the holder's own inode and content, the holder does
nothing (it neither clears nor writes), leaves the other holder's lock alone, and the run stays paused
with the reason that the pause lock was lost. A lock is stale only when its owner process is gone and it is older than a grace period
of 2 seconds, never by age alone; a lock with no readable owner (a crash between creating and writing
it) is stale only after 60 seconds. Recovery of a stale lock is serialised through a second exclusive
file, `usage-paused.lock.recover`, which is never taken over, and a caller recovers at most once per
attempt to take the lock. Holding the recovery file, the recoverer reads the lock again and goes on
only if it is still the lock it judged stale (same inode and content) and still stale. It never
unlinks `usage-paused.lock` by its path, because a holder that stalled between creating the lock and
writing its owner could resume after that last check and write its owner into the very file about to
be removed. Instead the recoverer renames the lock aside, in one atomic step, to a unique name in the
same folder (`usage-paused.lock.stale.<pid>.<random>`), and compares the moved file's inode and
content with the lock it judged stale. Only on a match is the moved file removed. Otherwise the moved
file is a live holder's lock, and the recoverer puts it back with a hard link, which never replaces a
lock that another process took meanwhile, and then removes the moved name. The recovery file is always
removed afterwards. If the lock is gone before the rename, or the recovery file is busy, the caller
simply tries the lock again. Four failures keep the caller paused: the rename fails; the moved stale
file cannot be removed; a live lock cannot be put back (its moved file is then kept under its
`.stale.*` name); or a live lock is put back but its moved-aside name cannot be removed (the restored
lock stays in place and the `.stale.*` file is kept). In each case the recoverer removes nothing more,
the caller's clear or write does not run, and the guard's detail says why; the owner removes any
leftover `.stale.*` file by hand. Nothing is renamed to clear the pause, so no `usage-paused.clearing.*`
file is made.
Files of that name left by an older version are adopted: when there are any, the guard takes the
lock before it reads the flag, restores the newest to the flag path when no flag is live and removes
the rest, and until it can do so the guard counts as paused and says why. The guard also runs before
the reflector is asked again in `memory.update` (section 7.2). A command
that fails, times out (30 seconds) or prints `"max_used": null` is a failed reading. Without a
pause, a failed reading does not pause anything: the guard lets work through and says why in its
detail. While paused, a failed reading keeps the pause, and the detail says "usage reading failed"
and why; only a successful reading below `usage.resume_below_pct` lifts it. Roles on `local`,
`mock` and `shell`, and gates and actions, are never held back by the guard. Run `mw run <CARD>`
again to continue a paused run.

### 10.8 Local model tier

Roles with `runs: local` use an OpenAI-compatible server (for example `llama-server`, Ollama or
vLLM) at `local_models.endpoint`, selecting the model by the role's `profile` (or `model`). The
tier is optional by design, because the hardware that runs it may not always be available:

- `local_models.fallback` names a second server for when the first is unreachable or failing,
  typically a smaller always-available model.
- Local roles are advisory only, and nothing in the merge path needs them.

Typical profiles are `fast` (memory extraction, documentation questions, reflection drafts),
`coder` (agentic coding when subscription quota is spent) and `heavy` (long runs and second-opinion
reviews). Benchmark any local model on your own hardware before relying on it.

### 10.9 Agent memory: the `letta` package

Letta (a self-hosted agent server with archival memory) is a semantic store like mem0 (section 10.2):
a mirror of the files in `memory/`, delivered and queued on its own, so one store being down never
holds back another. Letta is no longer part of the core: it is the official package `packages/letta`
(section 15), installed with `mw add letta`, which uses only the package API. The core setting
`memory.letta` of earlier versions is refused (`config/schema`, section 3.1): run `mw add letta`, move
its settings to `packages.letta` unchanged, and delete `memory.letta`.

| Setting (`packages.letta.`) | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | Base URL of the Letta server. |
| `agent` | string | `mergewright` | Agent name prefix: the project's agent is `<agent>-<name>`. |
| `key_env` | variable name | `LETTA_SERVER_PASSWORD` | The environment variable that holds the server password; the package declares it as its secret, so its value is redacted (section 10.4). |
| `model` | string | required | Chat model handle the agent is created with (`openai-proxy/<model>` is Letta's OpenAI provider pointed at an OpenAI-compatible server; `ollama/<model>` the Ollama provider). |
| `embedding` | string | required | Embedding model the agent is created with: the model name served at `embedding_endpoint`, or, with no endpoint, a Letta handle such as `ollama/<model>`. |
| `embedding_endpoint` | string | none | OpenAI-compatible embeddings endpoint as the Letta server reaches it. With it the agent is created with an explicit `embedding_config`; without it `embedding` is sent as a handle. |
| `embedding_dim` | integer ≥ 1 | `1024` | Dimensions of the embedding model at `embedding_endpoint`. |
| `write_timeout_ms` | integer ≥ 1 | `60000` | Timeout of one write (archival insert, agent creation), in milliseconds. Reads (health, agent lookup, listing, search) keep 30 s. |

- Each project has one Letta agent, named `<agent>-<name>` (for example `mergewright-shop`), created
  on first use with the models `model` and `embedding`. Its id is cached per machine in the
  package's folder of `.mergewright/local/` (`packages/letta/letta-agent.json`); another machine
  finds the same agent by name. When the cached agent no longer exists, it is found or created again.
- `memory.update` queues each new lesson for Letta (kind `letta`) and sends nothing during the run
  (REQ-engine-008); the queue retry after the card (section 8.9) inserts it into the agent's archival
  memory as `<title>`, a blank line and the body. An archival passage holds only text and tags, so the
  metadata the mem0 package sends is stored as tags: `mergewright`, `lesson`, `topic:<topic>`,
  `project:<name>`, `lesson_id:<id>` (the same id as section 10.2) and `card:<id>`. A lesson that
  could not be stored stays queued; those already stored are not sent twice.
- When building `{{memory.recall}}`, the package adds Letta's best archival hits, as
  `title: first paragraph`. When Letta does not answer, recall simply has no extra hits from it.
  Its hits appear in `mw memory search` and `mw docs search` (and their tools), labelled `letta`.
- The password is sent as `Authorization: Bearer`, from the variable named by `key_env`.
- Timeouts depend on the call: health, agent lookup, listing and search give up after 30 seconds; a
  write after `write_timeout_ms` (default 60 seconds). Inserts are usually fast, but each embeds its
  text, which can stall while the GPU is busy.
- A batch of records (a queued item, `mw memory add`, `mw memory push`) is checked against one
  listing of the archive (by the `lesson_id:` tag and text), with a search per record only when the
  server gives no listing; a record already there is skipped.
- It provides the MCP tools `mw_letta_add` and `mw_letta_search` (section 12.3), the store
  `mw memory push|prune --service letta` use, and the `letta` check of `mw doctor`: Letta's version,
  whether the project's agent exists yet, the model handles and whether the password variable is
  set; the check never creates an agent. It names the chat model handle the agent will be created
  with (`packages.letta.model` or the default) and, when the agent exists and Letta reports its
  handle, the handle it uses, flagged `NOT <configured>` when the two differ.

The server routes used (Letta 0.16.8): `GET /v1/health/` (no password), `GET /v1/agents/?name=`,
`POST /v1/agents/`, `POST /v1/agents/{id}/archival-memory`,
`GET /v1/agents/{id}/archival-memory?limit=&ascending=&after=`,
`GET /v1/agents/{id}/archival-memory/search?query=&top_k=` and
`DELETE /v1/agents/{id}/archival-memory/{passage}`.

## 11. Command reference

`mw` is also installed as `mergewright`. Every command listed is built and tested. Flags are
written `--flag value` or `--flag=value`; a flag given twice collects both values; list flags
(`--implements`, `--scope`, `--depends`, `--roles`, `--approve`) also accept comma-separated
values. `--help` prints the help and `--version` the version, with any command. Before any command
runs, the per-machine secrets file is read (section 10.4).

Exit codes: `0` success; `1` failure (an error, or `mw check` found errors); `2` a usage error (an
unknown command, a missing argument) or `mw tui` without an interactive terminal. Errors are printed as one line, `mw: <message>`.

Only `mw sync` takes `--offline`. `mw run`, `mw work`, `mw approve`, `mw retry` and `mw abort`
refuse it on every project, with a usage error naming `mw sync --offline` (section 8.2).

Commands marked "owner" in the tables are refused inside a card run, that is when `MW_ROLE` is set
(code `owner-only`; `mw spec accept` also refuses inside a card worktree, code
`change/owner-only`). Section 7.1 explains why.

### 11.1 Project

| Command | Behaviour |
|---|---|
| `mw init [dir] [--name N] [--prefix P] [--example]` | Makes `dir` (default: the current folder) a project. Adds every missing template file and never overwrites one; safe to repeat. The name defaults to the folder name as a slug; the prefix to the first four letters of the name. In a git repository, the base branch is taken from `origin/HEAD` or the current branch, and the hub is the remote named `hub` when there is one, else `none`. Copies the preset's default gate to `gates/default.gate.sh`, appends `.mergewright/`, `.*.tmp` and `*.sync-conflict-*` to `.gitignore` (the lines missing from it), and generates `memory/INDEX.md`. `--example` adds an example spec and card. |
| `mw check [--strict] [--json]` | Validates the project (section 1.3). Prints one line per problem, `<file>:<line>: <error\|warning>: <message> [<code>]`, then a summary (`N error(s), M warning(s)`). `--strict` counts warnings as errors: their lines keep the `warning:` prefix and the summary reads `N error(s) (M of them warnings promoted by --strict)`. `--json` prints `{"ok": bool, "diagnostics": [{severity, code, file, line, message}]}`. Exit 1 when there are errors. |
| `mw trace [--json]` | Requirement to cards to tests (section 6.2). |
| `mw status [<ID>] [--json]` | Every card, or only card `<ID>` (an unknown id is an error): id, status (the run status when a run exists; `done (run unfinished)` for a merged card whose run has not finished its flow; `queued ('mw work' or 'mw run <ID>' resumes it at '<phase>')` for a `running` run no process drives, section 8.9, REQ-engine-014), flow, the phase it is at, title, and under a card whose agents reported usage a line `usage: <summary>`. `--json` adds the run's reason and, when agents reported any, its usage per harness (`usage.byHarness`, `usage.summary`, e.g. "Claude $0.42; Codex 1,500 in / 75 out tokens"): a harness that reports a price (Claude) by its cost in dollars, one that does not (Codex; a package's harness when it reports tokens) by its tokens only; a package's harness is named by its id. A harness that reported neither is left out. Each harness's totals carry `inputTokens` (all input) and, when its phases reported them (section 8.1), `freshInputTokens`, `cacheWriteTokens`, `cacheReadTokens` and `turns`; the summary then shows cached (cache-write + cache-read) and fresh input separately, e.g. "Claude $1.52 (input 54 fresh, 1,452,430 cached: 73,426 written, 1,379,004 read; 41 turns)". A harness that reported only totals has no split fields and no split in the summary. `mw run`, `mw approve` and `mw work` print the same summary after a run. `--json` also lists, when roles ran, the harness and model each role last ran with (`agents`: `[{role, harness, model}]`, section 8.1). |
| `mw upgrade` | Migrates the project to this runtime's specification version (Appendix C). |
| `mw version` | Prints the package version, the specification version, and where the runtime comes from: "installed from commit X" (a copy made by `scripts/install.sh`), "running from a checkout" (the package folder is a git checkout), or "installed from the npm package <version>". |
| `mw help` | Prints the command summary. |

### 11.2 Work

| Command | Behaviour |
|---|---|
| `mw card new --title T [--kind K] [--implements REQ,..] [--scope glob,..] [--risk R] [--flow F] [--depends ID,..] [--why W] [--out-of-scope TEXT] [--acceptance TEXT]... [--tags a,b] [--status todo\|ready] [--no-docs] [--commit]` | Creates the next card (section 7.4), with status `todo` or, with `--status ready`, `ready` (picked up by `mw work`); any other status is refused (`card/status`). `--out-of-scope` is the text of `## Out of scope` in place of the scaffold; each `--acceptance` is one item of a `## Acceptance` list. `--tags` goes to the frontmatter `tags:`. A given scope also gets the project's `docs.paths` globs unless `--no-docs` (section 4.2). A `feature` card without `--implements` is refused while `trace.require_implements` is true (section 7.4). With `--status ready` the card is linted as it would be written, and a card with lint errors is refused (`card/not-ready`) with no file written (section 4.2). With `--commit` the card file is committed alone on the base branch as `card: <ID> <title>` and, on a project with a hub, pushed fenced by the lease (section 7.4, REQ-cards-006); without it nothing is committed. |
| `mw card lint <ID> [--json]` | Lints the card (section 4.2): one line per finding (`<severity> <code>: <message>`) and a summary, or with `--json` the object `{id, ok, findings: [{code, severity, message}]}` that `mw_card_lint` returns. Exit 1 when any finding is an error, else 0. Writes nothing. |
| `mw card ack <ID>` (owner) | Records that the card was reviewed against the current revisions of its requirements. |
| `mw card status <ID> todo\|ready [--commit]` (owner) | Moves a `todo` or `ready` card to the other status (any other status is refused, `card/status`) without committing, like `mw card new`, and says that the file is not committed. With `--commit` it commits the card file alone on the base branch as `card: <ID> <status>` and, on a project with a hub, pushes it fenced by the lease (section 7.4, REQ-cards-006); the confirmation names the commit in place of the warning. A file that already has the status is still committed when it differs from the last commit. Setting `ready` is refused for a card with lint errors (`card/not-ready`, section 4.2) before anything is written or a run is set aside. A run of the card that is `blocked` is first (with `--commit`, only once the card file is committed, so a failed commit leaves the run as it was) aborted as `mw abort` does (uncommitted work committed to the branch, the worktree moved aside, the branch kept), and the record of a `blocked` or `aborted` run is moved to `.mergewright/local/discarded/<ID>-run-<time>` (kept seven days), so the card file, `mw status` and the board show one status and `mw work` can take the card again. The board is told the new status. |
| `mw run <ID> [--approve a,b] [--from PHASE] [--until PHASE] [--dry-run] [--keep-lease]` | Starts or continues the card's run (section 8). A fresh run of a card with lint errors, a dry run too, is refused (`card/not-ready`, section 4.2) before any phase; a run in progress is continued without linting. `--from` first sends the run back to that phase (section 8.10). Prints one line per phase, then where the run is. When it returns with the run done, blocked, aborted or waiting at a stop point, releases the lease unless `--keep-lease` is given or another run of this machine needs it (section 9.3). Exit 1 when the run ends blocked or with an error (including `run/orphans`, section 8.7), 130 when stopped by a signal (section 8.7), else 0. |
| `mw retry <ID> [--from PHASE]` | Sends a blocked card back to a phase (default: the flow's remediation phase, else its first) without running anything, and releases the lease so `mw work` on either machine picks it up (section 8.10). Use it after fixing what blocked the card. |
| `mw work [--approve a,b] [--max N] [--watch] [--interval SECONDS]` | Runs every eligible `ready` card unattended, in order (section 8.9). |
| `mw work --dry-run` | Shows which cards would run, and why the others would not; a run no process drives reads as in `mw status` (`queued (...)`, REQ-engine-014). Runs nothing. |
| `mw approve <ID> <word> [--keep-lease]` | Continues a run waiting at a stop point for that word (section 8.5): `go` and `merge` in the shipped flows, `conditions` when the adjudicator approved on conditions to be met before the merge. Exit codes and the lease as for `mw run`. |
| `mw abort <ID> [--force]` | Stops the run, keeping uncommitted work as a commit on the branch, and moves the worktree aside to `.mergewright/local/discarded/`; `--force` keeps the uncommitted work only in that moved copy, deletes the branch, and takes over a lease another machine holds (section 8.4). While a process in the card's orphans record is alive, `--force` is refused (`run/orphans-alive`) and a plain abort leaves the worktree in place and reports the process (sections 8.4 and 8.7). |
| `mw sync [--offline]` | Brings the main checkout level with the hub, then removes finished cards' worktrees (section 9). `--offline` does nothing. |
| `mw lease [show\|take [--force]\|release]` | Inspects or changes the lease (section 9.3). `show` is the default. |

### 11.3 Managed updates

| Command | Behaviour |
|---|---|
| `mw memory show` | Prints the always-loaded memory and its estimated size in tokens. |
| `mw memory index` | Regenerates `memory/INDEX.md`. |
| `mw memory search <words> [--limit N]` | Keyword search over lessons, decisions and outcomes (default 5 hits), then the hits of each enabled package that searches memory, each line labelled with the store's name (`mem0:`, `letta:`). |
| `mw memory add lesson --topic T --title T --body B [--card ID]` (owner) | Adds or updates a lesson, then regenerates the index, then stores it in each configured store (packages such as mem0 and letta, in the order `packages:` lists them; queued when one is down; not sent again when the store already holds it) and prints where it went (section 7.2). Credentials in the body are redacted. |
| `mw memory add decision --title T --body B [--card ID]` (owner) | Writes a dated decision file, then regenerates the index, then stores it like a lesson (topic `decision`). |
| `mw memory prune --service NAME --match TEXT [--dry-run]` (owner) | `NAME` is an enabled package with a memory store (e.g. `mem0`, `letta`). Deletes the store's records of this project whose text contains TEXT, printing each one (section 7.2). |
| `mw memory push [--lessons] [--decisions] [--service NAME]` (owner) | Sends every lesson and decision in `memory/` (or only those named) to every configured store, or to the one named, idempotently; prints per store the counts stored, already present, queued and failed (section 7.2). Exit 1 when a store refused a record. |
| `mw memory state [--file F]` (owner) | Replaces `STATE.md` with the file's text, or with standard input; refused over the cap. |
| `mw spec list` | Lists specs and change proposals. |
| `mw spec propose <spec> --summary S [--file F] [--by WHO]` | Creates a change proposal (section 7.3). |
| `mw spec accept <CHG>` (owner) | Applies a proposal. |
| `mw spec reject <CHG> [--reason R]` (owner) | Rejects a proposal. |
| `mw config get <key>` | Prints a configuration value. |
| `mw config set <key> <value>` (owner) | Sets a value after validating the result: the schema, and no new `role/*` or `config/*` error (section 7.5). |
| `mw config unset <key>` (owner) | Removes a key, validated the same way, and the parent maps it left empty (section 7.5). |

### 11.4 Services

| Command | Behaviour |
|---|---|
| `mw doctor` (also `mw integrations`) | For each core integration (notifications, the usage guard, the forge): configured or not, reachable or not, and whether its environment variables are set; for each enabled package, a line naming it when it did not load, else one line per check it provides, `<name> ok|NOT ok <detail> (package <package>)` (for example the `kanban` check of `cline-kanban` says "board on another machine (packages.cline-kanban.path=...); mirrored from there" where that path does not exist, and the `docs` check of `open-notebook` says "notebook 'X' not created yet (the first docs sync creates it)"); a `local` line for `local_models.endpoint`: `GET <endpoint>/models` with the key from `local_models.key_env`, listing the model ids (aliases) it serves, or "not configured"; plus the sandbox policy for write-mode Claude agents with where it comes from and the probe's result on this machine (section 8.6); a `git` line: whether git has an identity to commit with (`git var GIT_COMMITTER_IDENT` and `GIT_AUTHOR_IDENT` succeed; when not, the fix: `git config user.name` and `git config user.email`), the current and base branch, and whether the hub's remote exists when `git.hub` names one; when `/etc/systemd/system/mw-work@.service` exists and `systemctl` is on PATH, a `systemd` line with `systemctl is-active mw-work@<project folder name>` (skipped silently otherwise); an `ssh` line: the SSH agent socket git would use (`SSH_AUTH_SOCK`, else one found in the runtime directory) and how many keys it holds (`ssh-add -l`, counted, never listed), or `agent: none found`; the file-sync exclusions check, and items left in the old shared queue (section 10). A missing hub remote is reported on the `git` line but is not counted (the commands that need it refuse with `hub/no-remote`). Exit 1 when the exclusions check finds a problem, `MW_SANDBOX` has an unknown value, or git has no identity. |
| `mw add <name \| path> [--yes]` (owner) | Installs a package (section 15): an official one by name, or a package folder by path. Shows its name, version, source, what it provides, the settings and environment variables it reads, and that it runs with your rights, then asks; `--yes` answers for you, and without a terminal and without `--yes` it refuses (`package/consent`). Copies it to `.mergewright/packages/<name>/` and enables it as `packages.<name>` in `mergewright.yaml`, then names the settings it still needs. |
| `mw remove <name>` (owner) | Deletes the package's files and its `packages.<name>` entry. |
| `mw packages` | Lists the installed and enabled packages: version, enabled or not, and whether it loaded (with what it provides) or why not. |
| `mw <command>` | A command an enabled package provides (section 15), when the name is not a built-in command. |
| `mw queue [list]` | Lists undelivered integration items, oldest first, with their age and last error. |
| `mw queue flush` | Waits first while a run of this machine is inside its merge phase (one line names the card; REQ-engine-012, section 10); it does not look at the lease, and items another `mw` process still holds stay skipped as `held`. Then it retries every queued item, oldest first, going on to the next when one fails; delivered items are removed, and items that must not be delivered any more (a stale Kanban status, section 10.5) are dropped with the reason. One line per item: `delivered`, `dropped` or `kept`, its kind and summary; for record items (Letta, package stores such as mem0) the record counts, e.g. `delivered  mem0  ... (45 delivered, 2 already present)`, or, when the item stopped on an error, `kept  mem0  ... (3 of 47 delivered, 44 remaining): <error>` (the item now holds only the 44). A last line totals the items and, for record items, the records. Exit 1 only when items remain and nothing (no item, no record) could be delivered in this run; otherwise 0. |
| `mw cline-kanban mirror` (the `cline-kanban` package; `mw cards mirror` now says to use it) | Brings the Kanban board level with every card's live status; idempotent. Run it on the machine where the board runs (section 10.5). Exit 1 when the board does not answer here for `cards.kanban_path`. |
| `mw queue adopt` | Moves items an older runtime left in the shared `.mergewright/queue/` into this machine's queue. Run it on one machine only. Exit 1 when some could not be moved (the same name is already queued). |
| `mw open-notebook sync --all` (the `open-notebook` package) | Rebuilds the documentation notebook from every tracked file matching `docs.paths` and not `docs.exclude`, as it is in the last commit; symbolic links and binary files are skipped, each with a message naming it, and counted in the summary (section 10.3). |
| `mw docs search <words> [--limit N] [--text]` | Ranks the project's documentation files by keyword, as `mw memory search` ranks memory (section 7.2), without any service. Prints `<path>: <heading or first line> (score N)` and, indented, the first line holding a query word, best first (default 5 hits), or "nothing in the documentation matches". Then the hits of each enabled package that searches documentation or memory (section 15), in the order `packages:` lists them, such as the notebook of the `open-notebook` package (by meaning; `--text` for its plain text search; its score with two decimals), each line labelled with the package's name (`mem0:`, `open-notebook:`); a source that does not answer gives one line saying so. |
| `mw open-notebook ask <question>` (the `open-notebook` package) | Asks the documentation notebook a question. `mw docs sync` and `mw docs ask` now say to use the package's command. |

### 11.5 Building blocks

| Command | Behaviour |
|---|---|
| `mw roles` | Lists every role: id, origin, harness, mode, model, output, description. |
| `mw flows` | Lists every flow: id, origin, phases. |
| `mw gates` | Lists every gate and where it comes from. |
| `mw mcps` (or `mw mcp list`) | Lists every MCP server: id, origin, transport, whether enabled, roles. |
| `mw eject <role\|flow\|gate\|mcp> <id>` (owner) | Copies a preset file into the project (section 5.2). |
| `mw mcp add <id> (--command CMD [--arg A]... \| --url URL) [--env K=V]... [--header K=V]... [--roles a,b\|all] [--description D] [--force]` (owner) | Writes `mcps/<id>.mcp.yaml`. `--command` takes the program and its arguments as one string; `--arg` adds more. The file is validated (including the secrets rule and the role names) before it is written; `--force` replaces an existing file. |
| `mw mcp remove <id>` (owner) | Deletes `mcps/<id>.mcp.yaml`. |
| `mw mcp show <role>` | Prints the servers the role gets and their configuration, with every `env` and `headers` value hidden. Fails when a referenced environment variable is not set. |

### 11.6 Assistants and installation

| Command | Behaviour |
|---|---|
| `mw tui` (owner) | Opens the terminal UI (section 13): the board, approvals and packages, and the roles, configuration and MCP servers. It needs an interactive terminal: when standard input or output is not one, it exits 2 (code `tui/no-tty`) and names the commands to use instead (`mw config set`, `mw config unset`, `mw mcp add\|remove`, `mw doctor`). It writes `mergewright.yaml`, `mcps/` and ejected preset files only through the functions behind those commands, and acts on cards only through the MCP tools (section 12). Exit 0 when quit. |
| `mw ui [--port N] [--no-open]` | Starts the GUI's server for the project around the current folder on `127.0.0.1` (section 16), prints the sign-in link and opens it in the browser (`xdg-open`, or `open` on macOS), unless `--no-open` is given, there is no display or the opener is not installed. Without `--port` it takes port 7341, or a free one when 7341 is taken; with `--port N` it takes N or fails (`ui/port`); `--port 0` takes a free one. Runs until Ctrl-C or SIGTERM; exit 0 then. |
| `mw mcp serve [--project DIR]` | Runs the MergeWright MCP server for the project at `DIR` (default: the project around the current folder) over standard input and output, until the client closes the input (section 12). Standard output carries only protocol messages; everything else goes to standard error. Exit 0 when the input ends; 1 when there is no project. |

## 12. The MCP server

`mw mcp serve` gives an MCP client, typically the owner's assistant (Hermes, through the `hermes` package), the MergeWright
workflow as tools: delegation to agents of other models, cards, runs, documentation, memory, the
Kanban board and the owner's project operations. One server process serves one project, named
when it starts; it loads the project's files afresh for every call, so it sees changes made between
calls. The server is built and tested; delegation to Claude in `advise` mode, documentation sync
and the mem0 tools (then in the core) have been verified live through Hermes, and `mw_docs_write`, delegation to Codex
and the Kanban write tools have not yet been exercised against the live services.

### 12.1 Transport

- JSON-RPC 2.0 over standard input and output, one JSON message per line (the MCP stdio
  transport). Standard output carries only protocol messages; log lines go to standard error.
- Protocol version `2025-06-18`. A client that asks for `2025-03-26` or `2024-11-05` is answered
  with that version; any other request is answered with `2025-06-18`.
- Methods: `initialize` (server `mergewright`, the `tools` capability, and instructions that name
  the project and its rules), `ping`, `tools/list` and `tools/call`. `initialize` comes first and
  once: before it only `ping` is answered, and any other request is refused with `-32600` without
  running; a second `initialize` is refused the same way. Notifications get no reply;
  `notifications/cancelled` aborts the named call, which then gets no reply either. Batches are
  refused. Requests are handled concurrently and answered as they finish.
- Protocol errors carry the JSON-RPC codes: `-32700` for a line that is not JSON (the server keeps
  reading), `-32600` for a message that is not a request, `-32601` for an unknown method, `-32602`
  for an unknown tool.
- A tool's arguments are validated against its input schema before it runs; a missing required
  argument or an unknown one is refused. Ids in arguments (cards, phases, flows, specs, MCP servers,
  approval words) must have the form of an id, so none can be read as an option of the command it
  reaches. A tool that fails answers with a tool result marked
  `isError` whose text says what to do. An unexpected error (not one of the runtime's own) answers
  with a generic `isError` text, and its stack goes to standard error only. Nothing a tool does
  stops the server.
- **Structured results.** Beside its text, a tool may return `data`, a JSON object of a declared
  shape: the types in `src/mcpserver/results.ts`, versioned by `RESULTS_VERSION` (now 1); a field
  is never renamed, removed or given another meaning without raising it. The text never changes
  because of it: it stays the contract for clients that read text. The server adds the data as the
  result's `structuredContent` (with `resultsVersion`) only when the client asked for it, by
  `capabilities.experimental.structuredContent: true` in `initialize`, and the protocol version in
  use is `2025-06-18`; other clients get exactly the text. A refusal may carry data too: a card that
  cannot be set (or created) ready because of lint errors answers `card/not-ready` with
  `{lint: {id, ok, findings}}`. In the tables below, the tools that return data name its type.
  Inside the runtime, `callToolStructured(name, args, ctx)` returns `{text, data, isError}` and
  `listTools(project)` lists every tool with its input schema, whether it writes and its data type;
  both may be called concurrently (`mw` commands a tool runs in process go one at a time, because
  they work from the process's working directory).
- Every result is scrubbed before it is sent: the values of the project's credential variables
  (the local model key, the forge token, `GITHUB_TOKEN`, `GITEA_TOKEN`, and every secret an enabled
  package declares, such as the mem0 key, the Letta password and the Open Notebook password) become `[redacted]`, and anything shaped like a credential is redacted as memory
  text is (section 10.4).

### 12.2 Authority

The server runs as the owner: its tools do what the owner's `mw` commands do, through the same
functions. When `MW_ROLE` is set, that is when the server was started inside a card run, every tool
marked "write" below refuses with the `owner-only` message (section 7.1); the other tools still
answer. No tool merges, pushes or commits product code: a change to the product is a card, and it
runs through its flow (section 8).

### 12.3 Tools

The core has 31 tools in seven groups; each enabled package may add its own (section 15), listed
after them with "(package <name>)" at the end of their description, and never under a name the core
uses. Their names are a stable contract: clients and the Hermes skill (the `hermes` package)
call them by name, so a name is never changed or reused within a specification version. In the
tables, arguments before the semicolon are required.

**delegate**: agents of other models, outside any card (section 12.4).

| Tool | Arguments | Does |
|---|---|---|
| `mw_delegate` | `task`; `role`, `runs` (`claude`, `codex`, `local`, `mock`, or a harness an enabled package provides, such as `hermes`), `model`, `provider`, `minutes`, `mode` (`advise`, `read`), `output` (`text`, `findings`, `brief`, `adjudication`), `cwd`, `label`, `card` | Runs one agent on the task: a project or preset role named by `role`, or an ad-hoc role (`runs` with an optional `model` and `provider`; it defaults to `advise` and `text`). With `card` (a card id) the role's placeholders are rendered with that card's full context exactly as its brief phase would (`{{card}}`, `{{requirements}}` with acceptance criteria, `{{memory.*}}`, `{{docs}}`; run artifacts are empty); without it, `{{card}}` and `{{requirements}}` read "(none: not a card; the task text is the whole request)". The task is appended under "## Task", and the prompt includes `memory/STATE.md` and `memory/RULES.md` (section 6). Returns the output (text, or the validated object), token usage, seconds and the run folder. |
| `mw_review` | `range` (default `HEAD`: the uncommitted changes) or `diff`; `deep`, `role`, `runs`, `model`, `provider`, `minutes`, `focus` | Reviews `git diff <range>` or the given diff with the `reviewer` role, with `reviewer-deep` when `deep` is true, or with another findings role, in `read` mode. Returns findings (Appendix B.3). An empty diff is refused (`review/empty`), and so is a range that starts with `-`. |

**cards**

| Tool | Arguments | Does |
|---|---|---|
| `mw_cards_list` | `status` | The cards (id, title, kind, status, requirements, scope, dependencies), optionally only those with one status. |
| `mw_card_get` | `id` | Data `CardData`: the card's board row, front matter, body sections, scope, dependencies and lint result. The card file's text; `requirements`: each requirement the card implements as `mw_req_get` returns it (acceptance criteria included); and, when the card has run, its run's status, flow, phase, round, reason and merge. |
| `mw_card_new` (write) | `title`; `kind`, `implements`, `scope`, `risk`, `flow`, `depends`, `why`, `out_of_scope`, `acceptance` (a list), `tags`, `status` (`todo` or `ready`, default `todo`), `no_docs` | Data `CardChangeData`: the new card's board row. Creates the next card with status `todo` (or `ready`), as `mw card new` does (section 7.4), and commits its file alone as `card: <ID> <title>` (section 12.5). `out_of_scope` and `acceptance` fill the sections as `--out-of-scope` and `--acceptance` do. As on the command line, a `feature` card without `implements` is refused while `trace.require_implements` is true (`card/no-requirement`), and a card created `ready` must pass lint (`card/not-ready`, section 4.2); nothing is written or committed then. `no_docs` is only for a card that must not touch documentation; by default it is not passed, and the project's `docs.paths` join the scope. |
| `mw_card_lint` | `id` | Data `LintData`. Lints the card (section 4.2) and returns what `mw card lint <ID> --json` prints: `{id, ok, findings: [{code, severity, message}]}`; `ok` is false when any finding is an error. Read-only. |
| `mw_card_set_status` (write) | `id`, `status` (`todo` or `ready`) | Data `CardChangeData`; a lint refusal carries `{lint}`. Moves a card between `todo` and `ready` and commits its file alone as `card: <ID> <status>` (section 12.5). Every other status belongs to the runtime (`card/status`). `ready` is refused for a card with lint errors (`card/not-ready`, section 4.2) before anything is written, committed or set aside. As `mw card status` does, a `blocked` run of the card is aborted first (branch kept) and a `blocked` or `aborted` run's record is moved aside, also when the file already has the status asked for; the board is told the status. |
| `mw_status` | none | Data `StatusData`: every card's board row (id, title, kind, board status `todo`, `ready`, `running`, `queued`, `waiting`, `blocked`, `done` or `aborted`, the status as printed, card and run status, flow, phase, risk, reason, `ask`: the approval word the owner is asked for at a stop point, usage, agents) and the config's errors. The text is what `mw status --json` prints; when `mergewright.yaml` fails its schema, `{ config_errors, cards }`: the errors as `<key path>: <message>` and that list (section 3). |

**runs**: a run can take an hour, so the tools that start one return within seconds, without waiting for it to finish.

| Tool | Arguments | Does |
|---|---|---|
| `mw_run_start` (write) | `id`; `approve`, `from`, `until` | Data `StartedData` (command, pid, log, finished, the card's row). Starts `mw run <ID>` with those flags as a detached process in the project root, without `MW_ROLE`, and returns its process id and log file, `.mergewright/local/runs/<ID>.log`. It waits up to 10 seconds: a process that exits non-zero meanwhile is an error (`run/failed`) with the end of its log; once the run state is written (or rewritten) the reply adds where the run is (`now`); otherwise it says the run continues in the background. |
| `mw_run_status` | `id`; `log_lines` (default 20) | Data `RunData`: the flow's phases (done, current, stop words), the phases done, the current phase, rounds and their limit, history, and the run folder's files with name, kind, size and time (what `mw_run_file` reads). The run's status, summary (for a `running` run that a live process of this machine holds: "<ID> is running: phase <phase> (round N) since <time> on <host> (process <pid>)"; with no such process, "stopped before '<phase>'"; for a run whose state names another host, "<ID> is running: phase <phase> (round N) since <time> on <host>", REQ-engine-014), flow, phase, round, reason, approvals, the conditions it waits on (`conditions`) and the follow-up cards it made (`follow_ups`) when there are any, history (each entry with its roles' `harness` and `model`, and its `usage` and `usageBy`), `agents` (the harness and model each role last ran with), `usage` (the totals of `mw status --json`, or null), warnings, and the end of its background log; `not started` when the card has no run. |
| `mw_approve` (write) | `id`, `word` | Data `StartedData`. Checks that the run waits for that word (`run/not-waiting`, `run/wrong-word`), then starts `mw approve <ID> <word>` in the background, like `mw_run_start`, and waits up to 20 seconds: a process that exits non-zero is an error (`run/failed`) with the end of its log; once the run has left that stop point (another status, reason or phase) the reply gives its new status and phase (`now`); otherwise it says the run continues in the background, with the pid and log. The words are those of section 8.5, `conditions` included. |
| `mw_retry` (write) | `id`; `from`, `run` | `mw retry` (section 8.10). With `run`, it then starts `mw run <ID>` in the background exactly as `mw_run_start` does, and returns within seconds. Data `RetryData`: the card's row, the phase it was put back to, and what was started (or null). |
| `mw_abort` (write) | `id`; `force` | `mw abort`, with `--force` when asked (section 8.4). Data `CardChangeData`. |

**docs**: the repository is the source of truth; a documentation service (the `open-notebook` package) may be its index (section 10.3).

| Tool | Arguments | Does |
|---|---|---|
| `mw_docs_write` (write) | `path`, `content`; `title` | Writes one documentation file, commits it alone and syncs it to every package that mirrors documentation (section 12.5). |
| `mw_docs_search` | `query`; `limit` (default 5), `text` | Data `SearchData`. `mw docs search`: `project`, the ranked files as `[{file, title, score, text}]` (`text` is the first matching line), then the hits of each package that searches documentation or memory, under its name (e.g. `open-notebook`); a source that does not answer gives a line saying so instead of its hits. |
| `mw_docs_ask` (the `open-notebook` package) | `question` | `mw open-notebook ask`. |
| `mw_docs_sync` (write; the `open-notebook` package) | `paths` or `all` | Sends the named documentation files, or with `all` every tracked one (minus `docs.exclude`), as they are in the last commit; a named path that is not tracked is removed from the notebook. Symbolic links and binary files are skipped. Returns `synced`, `skipped`, `removed` and `warnings`. |

**memory**: the project's memory (section 7.2) and the semantic stores (packages such as mem0, section 10.2, and letta, section 10.9).

| Tool | Arguments | Does |
|---|---|---|
| `mw_memory_add` (write) | `kind` (`lesson` or `decision`), `title`, `body`; `topic` (required for a lesson), `card` (a card id) | Adds a lesson or a decision as `mw memory add` does, regenerates the index, commits the entry's file and `memory/INDEX.md` alone as `memory: <title>` (section 12.5), and, when a semantic store is configured (Letta, or a package's), records the entry in this machine's queue for each and replies at once that it is queued (`queued for mem0, queued for letta`, then either `the delivery starts now, in the background, after the repository lock and the lease were released ...` or, when this machine keeps the lease, `... the items stay held for this process, and the next queue flush after it ends (mw work, mw run, mw approve or mw queue flush) delivers them ...`). The delivery starts after the transaction released the lock and the lease (section 12.5), as `mw queue flush` delivers (idempotent; a store that does not answer keeps the item queued). Credentials in the body are redacted. |
| `mw_memory_push` (write) | `lessons`, `decisions`, `service` (a package store's name, e.g. `mem0`) | `mw memory push`: every lesson and decision file to the configured stores, idempotently; returns the counts per store. |
| `mw_memory_search` | `query`; `limit` (default 5) | Data `SearchData` (`hits` with file, title, score and text; `sources`, each outside source's hits or error). Keyword search of `memory/` (`project`), plus the lessons of each enabled package that searches memory, under its name (e.g. `mem0`, `letta`); a store that does not answer gives a line saying so. |
| `mw_memory_state` (write) | `text` | Replaces `memory/STATE.md`, as `mw memory state` does, and commits it alone as `memory: state` (section 12.5). |
| `mw_letta_add` (write; the `letta` package) | `text`; `tags` | Inserts free text, as written and with credentials redacted, into the archival memory of the project's Letta agent (created on first use), tagged `mergewright`, `project:<name>` and the given tags. |
| `mw_letta_search` (the `letta` package) | `query`; `limit` (default 5), `tags` | Searches that archival memory by meaning, optionally only passages with any of `tags`; returns id, content, tags and timestamp. |

**kanban** (the `cline-kanban` package): thin wrappers over the Kanban CLI, `kanban task <command> ... --project-path <path>`,
where the path is `packages.cline-kanban.path` (default: the project root). The CLI runs without a shell,
each argument is one argument of it, and an option's value is never read as another option.
They act on the board's own tasks, not on the card mirror of section 10.5. They need the `kanban`
command on the path and a Kanban runtime reachable from the machine the server runs on
(`KANBAN_RUNTIME_HOST`, `KANBAN_RUNTIME_PORT`, default 127.0.0.1:3484); every failure is
`cline-kanban/failed` with a sentence saying which.

| Tool | Arguments | Does |
|---|---|---|
| `mw_kanban_list` | `column` (`backlog`, `in_progress`, `review`, `done`, `trash`) | The board's tasks, optionally of one column. |
| `mw_kanban_get` | `task_id` | One task, searched in every column. |
| `mw_kanban_create` (write) | `title`; `prompt` (default: the title), `base_ref`, `agent_id`, `plan_mode` | Creates a task in the backlog. |
| `mw_kanban_update` (write) | `task_id`; `title`, `prompt`, `base_ref`, `agent_id`, `plan_mode` | Changes a task. |
| `mw_kanban_done` (write) | `task_id` | Moves a task to the done (trash) column and cleans up its workspace. |
| `mw_kanban_delete` (write) | `task_id` | Deletes a task for good. |
| `mw_kanban_link` (write) | `task_id`, `linked_task_id` | Makes the first task wait on the second while both are in the backlog. |
| `mw_kanban_start` (write) | `task_id` | Starts a task: Kanban makes a worktree and launches its own agent session on it. Not for cards, which start with `mw_run_start`. |

**project**: the owner's operations.

| Tool | Arguments | Does |
|---|---|---|
| `mw_check` | none | What `mw check --json` prints. |
| `mw_trace` | none | Data `TraceData` (each requirement's id, title, priority, rev, status, spec, coverage, cards and tests). Requirement to cards to tests, with each requirement's coverage (section 6.2), and dangling `@req` comments. |
| `mw_doctor` | none | `mw doctor`'s report: key variable names, never values. |
| `mw_spec_list` | none | Data `SpecListData`. The specs with their requirements, and the change proposals. |
| `mw_spec_get` | `id` (spec id) | Data `SpecData`. One spec: id, title, status, file, and every requirement with id, title, priority, rev, status, spec, file, `acceptance_criteria` (`[{id, text}]`, the full text) and `cards` implementing it (`[{id, title, status}]`). `spec/unknown` for an unknown spec. |
| `mw_req_get` | `id` (requirement id) | Data `RequirementData`. One requirement, in the form `mw_spec_get` gives each. `spec/unknown-requirement` for an unknown id. |
| `mw_spec_propose` (write) | `spec`, `summary`; `body`, `by` (default `assistant`) | Creates a change proposal as `mw spec propose` does (section 7.3); without `body`, a skeleton to fill in. |
| `mw_roles` | none | Every role, with the ids `mw_delegate` takes. Data `RolesData` (each role's harness, model, fallback model, provider, mode and output). |
| `mw_mcp_add` (write) | `id`; `command` and `args`, or `url`; `env`, `headers`, `description`, `force` | Writes `mcps/<id>.mcp.yaml` as `mw mcp add` does, with the same checks, and always with `roles: []`: no role gets the server until the owner attaches it (`mw mcp add --roles`, the terminal UI, or the file). |

**views**: read-only views a board needs.

| Tool | Arguments | Does |
|---|---|---|
| `mw_run_file` | `id`, `name` | One file of the card's run folder by its path there, as `mw_run_status` lists it (`brief.json`, `gate-logs/test.log`, `phases/...`): its text, at most 1 MB, scrubbed like every result. A name with `..`, `.`, a leading `/` or a backslash is refused (`run/file-path`), and so is one that leads outside the folder through a symbolic link; a missing file is `run/no-file`. Data `RunFileData` (kind, size, text, whether it was cut, and the parsed value of a `.json` file). |
| `mw_packages` | `checks` | What `mw packages` prints. Data `PackagesData`: each installed or enabled package's version, description, whether it is installed, enabled and loaded, why not, what it provides, the settings its manifest requires that are not given, the names of the environment variables it reads, and (`checks: true`) the result of each of its health checks as `mw doctor` reports them (`checks` is null otherwise); `available` lists the official packages embedded in the runtime that are not installed (name, version, description, exports), each installed by `mw add <name>`. |
| `mw_settings` | none | The settings a UI shows, as JSON. Data `SettingsData`: name, card prefix, base branch, default flow and risk, the flows with their phases and stop words, the roles with harness and model, `gate.required`, `docs.paths`, the enabled packages and the config's errors. |

### 12.4 Delegation

`mw_delegate` and `mw_review` run one agent outside any card, through the same harnesses, minimal
environment, time limit and output validation (one retry when the object is invalid) as a card
phase (sections 8.3 and 8.6). These rules hold for every delegated agent:

1. **It advises or reads.** Its mode is `advise` or `read`. A role whose mode is `write` is refused
   (`delegate/write`): work that changes files is a card (`mw_card_new`, then `mw_run_start`). The
   harnesses are `claude`, `codex`, `local`, `mock` and those of enabled packages (`hermes`, with
   its package) (`delegate/harness` otherwise; the tool's `runs` argument is a pattern, not a list,
   so a package's id passes it).
2. **Only the role's essentials.** The role runs with its `runs`, `model`, `provider`, `profile`,
   `mode`, `output`, `limits` and `prompt` only. Its `args` and `command` are dropped, because
   harness arguments can widen what an agent may do; they serve the card phases the owner
   configured.
3. **No MCP servers.** No MCP server is wired into a delegated agent, whatever its role lists.
4. **`advise` runs nowhere.** An `advise` agent starts in an empty folder made with `mkdtemp` under
   the system temporary folder, outside the project, with the harness's no-tools setting; the folder
   is removed when the agent ends.
5. **`read` runs in the project.** A `read` agent starts in the project root, or in `cwd` inside
   it, with the harness's read-only setting, as a card's read phase does (Claude Code gets only its
   read tools, Codex runs with `-s read-only`, local models and the `hermes` package's harness get no tools). `cwd` and the
   project root are both resolved to their real paths; `cwd` must be an existing folder inside the
   real project root, so a symbolic link cannot lead out of it (`delegate/cwd`).
6. **No operating-system sandbox.** Nothing below the harness confines a `read` agent: it can read
   whatever the owner's account can read. This is the same boundary as a card's read phases; an
   allowlist sandbox needs unprivileged user namespaces, which AppArmor refuses on the machines the
   project runs on.
7. **One folder per call.** Each call gets its own folder, made with `mkdtemp` as
   `.mergewright/local/delegate/<time>-<label>-XXXXXX`, which holds its prompt, output schema and
   reply, so simultaneous calls with the same label never share a file.
8. **`MW_ROLE` is set** in the delegated process, as for a card's agent, so the owner's `mw`
   commands refuse inside it.
9. **The usage guard applies.** Before an agent on a paid harness (every one but `local`, `shell` and `mock`)
   starts, the usage guard is asked, as before a card's role (section 10.7). While it says no, the
   call is refused with reason `usage` (`delegate/usage`) before anything is made; the message says
   usage is too high and to try again later. `local` and `mock` delegations are not held back.

The prompt is the role's prompt with the project's placeholders filled (values that belong to a
card run are replaced by the task), followed by the task when the prompt has no `{{card}}`, and by
a line that says whether the agent may read files. An ad-hoc role with a structured output also
gets the output schema in its prompt. An agent that fails is reported as `delegate/failed`, naming
its folder.

### 12.5 Writes

The tools that change the repository (`mw_docs_write`, `mw_memory_add`, `mw_memory_state`,
`mw_card_new`, `mw_card_set_status`, `mw_spec_propose` and `mw_mcp_add`) take one lock inside the
server process, so they run one at a time and two concurrent calls never interleave their writes
to a file or to the memory index. Every file the runtime replaces is written to a temporary file
and renamed; the temporary name carries the process id, a per-process counter and a random suffix,
so two writes never share one. Every path a tool reads or writes in the project (a card file, a
documentation file, a memory file) is resolved to its real path, and one that a symbolic link leads
outside the project's real root is refused.

Every tool that commits (`mw_card_new`, `mw_card_set_status`, `mw_memory_add`, `mw_memory_state`
and `mw_docs_write`) runs its whole validate, write and commit sequence as one transaction:

- Besides the server's own lock, it holds the cross-process repository lock
  `.mergewright/local/locks/repo.lock`, so another MCP server, or any other process that takes that
  lock, never interleaves with it on this checkout. The lock has a run lock's format and stale rules
  (section 8.7): the holder's pid, host, time and process start time, published with `link()` under
  the registry's guard, and replaced when its process is gone. A tool waits up to ten seconds for
  another live holder, then refuses (`repo/locked`) without writing. The lock registers no run: it
  never keeps the lease for anyone.
- On a project with a hub (`git.hub` set) the tool takes part in the shared-state protocol of
  section 9, before it validates anything: this machine must hold the lease. When nobody holds it,
  the tool takes it; when this machine already holds it (a run here, say), it is kept; when another
  machine holds it, fresh or not, the tool refuses (`lease/held`, naming that machine) and writes
  nothing (the owner takes it over with `mw lease take` when that machine has stopped). Then the base
  branch adopts the hub's history exactly as `mw sync` does (section 9.2), so a card id or a file
  is decided on the shared history; the next card id also counts the card files the base branch's
  last commit holds, so a card adopted before file sync delivered its file is never minted again.
  After the commit, the base branch is pushed to the hub fenced by the lease (section 9.3), and the
  lease taken for the change is released unless a run of this machine is registered
  (`releaseUnlessBusy`, section 9.3). The reply says that the commit is on the hub.
- Nothing inside the transaction waits for an external service (REQ-engine-008). A tool that stores
  something in a service (`mw_memory_add`: the entry for the semantic stores) only records the delivery in
  this machine's queue (section 10) under the lock, and its reply says the delivery is queued. When
  the transaction has released both the repository lock and the lease (on a project without a hub,
  the lock alone), the items it recorded are delivered in the background, bounded like every flush,
  and the reply says the delivery starts now; the reply does not wait for it, and a delivery that
  fails leaves the item queued with its attempt count raised, for the next flush. When this machine
  keeps the lease (it held the lease before, a run of this machine is registered, or the release
  failed), nothing is sent: the items stay queued, untouched and held for the transaction's process,
  and the reply says that they stay held for this process and that the next queue flush after it ends
  (`mw work`, `mw run`, `mw approve` or `mw queue flush`) delivers them. The items are held for that
  process (section 10) until the transaction has released the lock and the lease, or else until the
  process ends, so no flush, in this process or another (`mw work`, `mw queue flush`), delivers them
  under the lock or the lease. An item
  recorded this way survives the server stopping before the delivery, and `mw mcp serve` waits for the
  deliveries it started before it ends. When the item cannot be written to the queue (a full or
  read-only disk), the entry stays committed and the reply does not say queued: it says that the entry
  is committed to `memory/` but could not be put in the delivery queue for that service, with the
  error, and that `mw memory push` sends it; no delivery is started for that service.

Within that transaction, `mw_card_new`, `mw_card_set_status`, `mw_memory_add` and `mw_memory_state`
commit what they wrote:

- Before it writes anything, the tool checks that the commit can be made: the main checkout is on
  the base branch (`card/branch`, `memory/branch`, `docs/branch`), git has an identity to commit
  with (`git var GIT_COMMITTER_IDENT` and `GIT_AUTHOR_IDENT` succeed; `git/identity` otherwise, naming
  the fix `git config user.name` / `git config user.email`), and this process holds the repository
  lock (`repo/unlocked`, a defect: the transaction above always takes it). Any of them failing
  refuses the call with nothing written and nothing staged.
- A card tool refuses a card whose file is not named `<id>.card.md` (`card/file-mismatch`, the
  same problem `mw check` reports as `card/file-name`) before it changes anything: a file named,
  say, `cards/*.card.md` is never handed to git. Runtime git treats every path as a literal path in
  any case (section 10.4).
- The tool writes its files, then runs `git add` and `git commit --only` on exactly those files:
  the card file (`card: <ID> <title>`, `card: <ID> <status>`); the lesson or decision file and
  `memory/INDEX.md` (`memory: <title>`); `memory/STATE.md` (`memory: state`). White space in the
  subject is collapsed and it is cut at 72 characters. Changes the owner staged for other files
  stay staged and out of the commit; content equal to the committed file commits nothing.
- The tool saves the content and the index entry of every file it may write before writing (for
  a decision, every file of `memory/decisions/`). A write or a commit that still fails puts every
  file back as it was: its content restored (a file the tool created is removed) and its index entry
  restored (a file that was not staged is unstaged). The error (`mcp/commit` for the commit) says
  that nothing was kept.
- The reply names the commit; on a project with a hub it also says the commit is on the hub (or,
  without one, that it stays in this checkout).

`mw_docs_write` writes documentation on the owner's authority, under these rules:

- `path` is a plain repository-relative path (no `..`, no leading `/`) that matches `docs.paths`
  (`docs/path`), and is not a protected path (`docs/protected`; `docs/adr/**` is protected by
  default).
- Neither the file nor any folder above it is a symbolic link (`docs/path`).
- The main checkout is on the base branch (`docs/branch`), because documentation is committed
  there.
- Holding the write lock (and within the transaction above), the tool checks the branch and the path again and that the file has not
  changed since it was validated (`docs/changed` otherwise: nothing is written, and the caller reads
  the file again and retries); then, under the same preconditions and with the same restoration
  on failure as the tools above (git identity, repository lock), it writes the content (with a
  final newline), and commits that one file alone with the message `docs: <title>` (`title` defaults to the path; white space is
  collapsed and the subject cut at 72 characters). Content equal to the file's commits nothing.
- The commit is then synced to every package that mirrors documentation, as the `docs.sync` action
  does (section 10.3). When one does not answer, the sync is queued on this machine and
  `mw queue flush` retries it; when no such package is enabled, nothing is synced. On a project with a hub, the commit is pushed
  to the hub as above and the reply says so.

### 12.6 Registering the server

**Hermes.** The official `hermes` package registers the server with Hermes in one step,
`mw hermes init` (section 15.4).

**Other clients.** The server works with any MCP client that starts stdio servers. Claude Code
and Codex register it with their own commands, for example
`claude mcp add mergewright -- mw mcp serve --project /path/to/project`; they do not get the
Hermes skill.

## 13. The terminal UI

`mw tui` is the owner's full-screen view of the project in the terminal: the board, the approvals
waiting for the owner, the packages, the roles and their models, the configuration and the MCP
servers. It changes the same files as the CLI, through the same functions: configuration, roles and
MCP servers through the functions behind `mw config set`, `mw eject` and `mw mcp add|remove`; the
board, the approvals and the packages through the tool layer the MCP server and the browser GUI use
(`callToolStructured`, section 12; the tools `mw_status`, `mw_card_get`, `mw_run_status`,
`mw_card_set_status`, `mw_retry`, `mw_approve`, `mw_packages`), so the three show the same data in
the same words. It needs an interactive terminal (exit 2 without one, section 11.6), and it refuses
inside a card run (`owner-only`). It is built and tested through its state machine and renderer,
without a terminal.

The screen has a header (project name, specification version, the eight screens), a list on the
left, the detail of the selected row on the right, a message line and the key help. The board,
the packages and their health checks are read when the TUI starts, after every action, and on `p`.

| Screen | Shows | Edits |
|---|---|---|
| Overview | Project name, specification version and root; the local model endpoint and notifications as `mw doctor` probes them; cards by status; how many cards wait for the owner | nothing |
| Roles | Every role: origin (preset or project), `runs`, `provider`, `model`, `profile`, `mode`, `output`; values set in `mergewright.yaml` are marked | `runs`, `provider`, `model` and `profile`, written as `roles.<id>.<field>` (section 5.3); `e` ejects the role |
| Models | What the picker offers per harness: Claude aliases and full ids, Codex models, and the local endpoint's live model list (`GET <local_models.endpoint>/models`), or a fixed fallback list when it does not answer. A package harness (such as `hermes`) has no list: its `model` and `provider` are free text | nothing |
| Config | Every `cards`, `git`, `risk`, `limits`, `trace`, `local_models` and `report` key with the value in the file (or the default), its type and the schema's description; a URL is shown without user, password or query string | any of those keys; a value is YAML (`3`, `true`, `[a, b]`), and "(unset)" removes the key |
| Packages | Each installed package: version, description, enabled and loaded or why not, what it exports, settings it still needs, the *names* of the variables it reads, and its health checks as `mw doctor` reports them. Then each official package that is not installed, with what it exports and the command that installs it, `mw add <name>` | nothing: installing is `mw add`, run in a terminal, which shows the package's source and exports and asks first |
| MCPs | Every server: origin, transport, command or URL, roles, and the *names* of its `env` variables and headers | `a` adds one (the fields of `mw mcp add`), Enter changes its roles, `d` removes it (after `y`), `e` ejects a preset server |
| Board | The cards of `mw status` in the GUI's seven columns (To do, Ready, Running, Queued, Waiting for you, Blocked, Done; an aborted run is under Done). One column at a time: a line under the header names every column with its count, the current one in brackets, so the board fits 80 columns. Enter opens a card: its facts, its sections (the brief), its run (summary, round, approvals given, phases, conditions of approval, warnings) and the list of its run files | `r` sets a To do card ready (`mw_card_set_status`; a lint refusal is shown); `R` retries a blocked or aborted card from its flow's default phase and starts the run (`mw_retry` with `run`), after `y`; `a` approves, as on Approvals |
| Approvals | The cards waiting at a stop point, each with the word asked for (`go`, `conditions`, `merge`, or another a flow names); a card paused for usage is not listed | `a` shows what it approves (card, word, phase, flow, risk, and the run's summary and conditions when the card is open), and `y` applies it (`mw_approve`, as `mw approve <id> <word>`); the message line then gives the card's new state |

The picker lists the catalogue's choices for the field, filtered as you type, and always accepts
what was typed as free text. `mw approve` has no refusal word: to stop a run waiting for approval,
use `mw abort` (or the GUI's Abort).

| Key | Does |
|---|---|
| Tab, Shift-Tab, 1 to 8 | Next or previous screen, or jump to one |
| Left, Right | Change screen, or move between the list and the fields; on the Board, change column |
| Up, Down | Move in the list, the fields or the picker; scroll an opened card (PageUp, PageDown by ten) |
| Enter | Edit the selected field (opens the picker); in the picker, stage the choice; on Board and Approvals, open the card |
| Esc | Back: close the picker, the form or the opened card, leave the fields |
| `s` | Save every staged change |
| `e` | Eject the selected role or MCP server |
| `a`, `d` | Add or remove an MCP server; on Board and Approvals, `a` approves (after `y`) |
| `r`, `R` | Board: set ready; retry (after `y`) |
| `p` | Probe the services again and re-read the board and the packages (running their checks) |
| `?` | Help |
| `q` | Quit; asks first when changes are staged and not saved |
| Ctrl-C | Quit without asking |

**Writes.** Changes are staged, marked `* unsaved`, until `s`. Every configuration change is then
written by `setConfig`, the function behind `mw config set`, with the same validation (section 7.5):
the schema, then the project re-checked in memory for new `role/*` and `config/*` errors. A refused
value is not written, `mergewright.yaml` stays exactly as it was, the validator's message is shown,
and the change stays staged to be corrected. MCP servers are added, changed and removed by the
functions behind `mw mcp add` and `mw mcp remove`, with the same checks (unknown roles, secrets
written into the file); ejecting uses `mw eject`'s function. Board actions are not staged: they go
to the tool layer when asked (approve and retry after `y`), with its checks and locks. Writes run
one after another, in the order of the keys that asked for them. Quitting stops reading keys, waits
until every write already asked for has finished, shows a failure if one occurs, and only then
exits, so a confirmed save is never lost by quitting. Changes that were staged but never saved are
dropped.

**Secrets.** The TUI never shows a secret value. For MCP servers it shows only the names of `env`
variables and headers, and in the add form the part after `=` is masked; for packages it shows the
names of the variables they read; URLs are shown without user, password or query string, and a URL
is not put back into the input when its key is edited. What the tool layer returns is already
scrubbed of credentials (section 12). A literal secret in an MCP server's `env` or headers is
refused, as by `mw mcp add`.

## 14. Installing

MergeWright needs git, one agent CLI and either Node 24 or newer or the single executable. It
installs in one of three forms, which carry the same files (section 2.6): `scripts/install.sh`
copies the committed runtime of a checkout to `~/.local/share/mergewright` and puts `mw` on the
path, `npm i -g` installs the package, and `scripts/build-binary.sh` builds the single executable.
`scripts/install-service.sh` installs the `mw-work@` systemd unit for unattended work. The guide is
`docs/install.md`.

Never automated: the logins (`claude`, `codex login`, and `hermes setup` when Hermes is used),
`mw add hermes` and `mw hermes init` in each project Hermes drives, and the AppArmor decision that bubblewrap sandboxes need (section 8.6). No script changes
system security settings or adds a sudoers rule.

## 15. Packages

A package adds a service integration, a harness, commands, MCP tools or checks to a project without
changing the core. The core runs alone; packages are what a project adds when it wants them. The
package API is **experimental**: it may change in any release, and a package states the version it
is written for (`apiVersion`, now `1`); a runtime refuses a package written for another version.
The guide to writing one, with a complete example, is `docs/packages.md`.

### 15.1 Installing, enabling and removing

`mw add <name | path> [--yes]` installs a package: by name, an official package (shipped in the
runtime's `packages/` folder, section 2.6, so no network is needed); by path, a package folder on
this machine. Before it copies anything it shows the package's name, version, description, source,
what it provides (its manifest's `exports` and `harnesses`), the settings and environment variables
it reads, and its entry and API version, and asks for confirmation, because **a package runs with
the user's rights** whenever MergeWright loads it. `--yes` answers yes; without a terminal and
without `--yes` it refuses (`package/consent`). It copies the folder (links as the files they point
to, without `.git`) to `.mergewright/packages/<name>/`, which is not committed, and, when the package
is not yet enabled, adds `packages.<name>: {}` to `mergewright.yaml`, keeping its comments; then it
names any settings the package still requires. Each checkout installs its packages itself.

`packages.<name>` in `mergewright.yaml` enables the package and holds its settings; its absence
disables it (the files may stay installed). `mw remove <name>` deletes both. `mw packages` lists
every installed or enabled package with its version, whether it is enabled, and whether it loaded
(and what it provides) or why not. `mw add` and `mw remove` are owner commands (section 7.1).

`mw check` reads the manifests of the enabled packages without running any package code. An enabled
package that is not installed here, has an invalid manifest, calls itself by another name, or whose
settings its `config` schema refuses is a `config/package` error. A package that fails to load or
whose `activate` throws is reported once on standard error and skipped: it never stops a run or a
command that does not need it.

### 15.2 The manifest

A package is a folder with `mergewright-package.yaml`, checked against
`schemas/package.schema.json`, and an ES module entry:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Lower-case letters, digits and `-`; the folder name under `.mergewright/packages/`, the key under `packages:`, and the prefix of its queue kinds. |
| `version` | yes | The package's own version, shown by `mw add` and `mw packages`. |
| `description` | yes | One line. |
| `apiVersion` | yes | The package API version it is written for (`1`). |
| `entry` | yes | The entry module, relative to the folder: `.mjs` or `.js` (an ES module), or an erasable `.ts` when Node can strip types. |
| `exports` | no | What `activate` returns, for `mw add` to show before anything runs: any of `deliverers`, `recall`, `search`, `searchDocs`, `remember`, `docsSync`, `mirrorCard`, `reconcile`, `harness`, `commands`, `tools`, `checks`. A memory store (`remember`) is found from this list without loading the package. |
| `harnesses` | no | The harness ids it provides; only these are accepted in `runs:` (and by `mw_delegate`) and from `activate`. |
| `config` | no | A JSON Schema for its settings under `packages.<name>`. |
| `secrets` | no | Environment variables it reads: a name, or `{config: <setting>, default: <name>}` for a variable a setting may rename (as `key_env`). These reach the package, and their values are redacted from tool output and run folders (section 10.4). |
| `env` | no | Other environment variables the package reads, which are not secrets (a tool's home folder); `host.env` reads only these and `secrets`. Not redacted. |

### 15.3 What a package may provide

The entry exports `activate(host)`, which returns an object with any of these parts (all optional;
the types are in `src/packages/api.ts`):

- `deliverers`: handlers of queued items by kind, `<name>` or `<name>:<anything>` only; they run in
  `mw queue flush` and every queue retry with the core's semantics (section 10).
- `recall(query, limit)` and `search(query, limit)`: `title: text` lines added to `{{memory.recall}}`
  and to `mw memory search` / `mw_memory_search` and `mw docs search` / `mw_docs_search`, labelled with the
  package's name. `searchDocs(query, limit, {text})` replaces `search` in the documentation search
  for a package that searches documentation rather than memory (`text`: plain text search).
- `remember`: a memory store (`label`, `open()` giving a session with `present` and `store`, and an
  optional `prune`). The core queues the reflect phase's lessons for it (kind `<name>`), delivers
  them one record at a time, and uses it for `mw memory add|push` and `mw memory prune --service <name>`.
- `docsSync(changed, deleted, commit)`: called with the documentation files a merge changed and
  deleted and the commit to read them from (the `docs.sync` action, `mw_docs_write`); it returns
  `sent`, `queued`, `failed` or `none`.
- `mirrorCard(cardId, title, status)`: called whenever a card's live status changes; it may return a
  one-line note the run records once.
- `reconcile(when)`: called by `mw work` before it takes cards and after it finished some, to bring an
  outside view of the cards level with them; it may return one line, which `mw work` prints.
- `harness`: harnesses by id, each listed under `harnesses` in the manifest. `runs:` in a role file
  or under `roles.<id>` accepts these ids once the package is installed and enabled; such a harness
  is advisory (it cannot have `mode: write`).
- `commands`: `mw <command>` subcommands, for names the core does not use.
- `tools`: MCP tools named `mw_<lowercase>`, served by `mw mcp serve` after the core's (a name the
  core uses is left out); `write: true` tools are refused inside a card run.
- `checks`: one-line health checks that `mw doctor` runs.

A part the package may not provide (another package's queue kind, an undeclared harness, a tool
not named `mw_*`) is left out with a note. A package never imports MergeWright's own files; it gets
everything through `host`: the project's root and name, its own settings, this machine's folder for
it (`.mergewright/local/packages/<name>/`), the documentation files as git blobs of a commit
(`docs`: the tracked files of `docs.paths`, HEAD, and a blob reader that refuses paths outside
`docs.paths` and skips links and binary files), commands run without a shell (`exec`, bounded by a
queue flush's budget, and `which`), this machine's name, every card with its live status (`cards`),
a log line, the delivery
queue (its own kinds only), JSON over HTTP with a timeout (a request body sent as JSON, or as
multipart/form-data with `form`, for a file upload), the runtime's error classes, reading
files inside the project (`package/outside` for any other path), its declared secrets, a YAML
parser, redaction, and the stable lesson id.

The official packages are in `packages/`: `mem0` (section 10.2), `letta` (section 10.9),
`open-notebook` (section 10.3), `cline-kanban` (section 10.5), `hermes` (section 15.4),
`board-4ga` (section 15.5) and `notebook-opennotelm` (section 15.6).

**What a harness gets.** A harness runs its agent CLI through `host.agent`: `run` starts the
command in the request's folder with the runtime's minimal environment (section 10.4) plus the
request's and the harness's variables, in its own process group, stopped at `limits.minutes`
(SIGTERM, then SIGKILL) or on abort, with the output kept in memory capped and streamed in full,
redacted, to private files in the run folder; `saveText` writes a private, redacted file there (a
prompt); `failedRun`, `timeoutResult` and `exitFailure` turn the run into a result, the last
marking it transient or quota through the shared table (section 8.6). The engine passes a package
harness no MCP servers (`role/mcp-unsupported` warns about servers offered to its roles), turns an
error it throws into a failed, classified result, and counts it as a paid harness for the usage
guard (section 10.7). The host also gives `exec` an `input` for standard input, the YAML library's
`parseDocument` and `isMap` (edits that keep comments), how to start this runtime
(`selfCommand`), the SSH agent socket (`sshAgent`), and process identity (`process.identity`,
`process.alive`: pid and start time, as pids are reused). The manifest's `env` lists variables that
are not secrets which `host.env` may read too; they are not redacted.

### 15.4 The hermes package

The official `hermes` package was part of the core before. Until it is installed and enabled,
`runs: hermes` is a `role/schema` error and `mw hermes` a usage error, each saying to run
`mw add hermes` (an invalid `mergewright.yaml` enables no package, so `mw hermes` then refuses with
`config/invalid`). It has no settings, reads `HERMES_HOME`, `MW_HERMES_SHARED_SKILLS` and `MW_ROLE`
(manifest `env`), and provides:

- the harness `hermes`: `hermes chat -Q --oneshot --ignore-rules -t todo --query-file <prompt file>`
  with `[-m <model>] [--provider <p>] [--max-turns <n>] --source tool` and the role's `args`, so no
  project rules files and a minimal tool set (no terminal, file, web or MCP tools; a role can
  widen it through `args`). Advisory only (it refuses `mode: write`); the reply is standard output
  without the trailing session lines; Hermes reports no usage. `HERMES_HOME` reaches the agent when set.
- the commands below, refused inside a card run (`MW_ROLE` set);
- two `mw doctor` checks, `hermes skill` and `hermes shared skill`: `NOT ok` (a warning, not
  counted as a problem) when an installed copy of the skill differs from the package's, with the
  `mw hermes init [--shared]` that updates it.

| Command | Does |
|---|---|
| `mw hermes init [--shared] [--name N]` (owner) | Registers the project's MCP server with Hermes and installs the `mergewright` skill (below). The entry is `mergewright-<project name>`, or `N` (letters, digits, `-` and `_`). It is written under `mcp_servers` in `$HERMES_HOME/config.yaml` (default `~/.hermes/config.yaml`), through `hermes mcp add` when that CLI is on the path, else by editing the file, after a backup and under a lock. The skill goes to `$HERMES_HOME/skills/mergewright/SKILL.md`, or with `--shared` to the shared skills folder (`MW_HERMES_SHARED_SKILLS`, default `$HERMES_HOME/shared-skills`). Safe to repeat. Exit 1 when the entry ends up disabled (Hermes could not start the server when it was added). |
| `mw hermes status [--name N]` (owner) | Shows the entry, the SSH agent socket it gives the server (`env.SSH_AUTH_SOCK`, and this shell's when it differs) and, for both skill locations, whether the skill is installed and matches this package's. Writes nothing. Exit 1 when the entry is not registered. |
| `mw hermes remove [--shared] [--name N]` (owner) | Removes the entry (`hermes mcp remove`, or an edit of the file with the same backup and lock), and the skill from the location `--shared` selects when no other MergeWright entry remains in the config. Exit 0, also when nothing was registered. |

`mw hermes init`, run inside the project once per project and machine, does three things:

1. It registers the server as `mergewright-<project name>` (or `--name`). The entry's command is
   the `mw` on the path, else this runtime (`node <package>/bin/mw.js`, or the single executable),
   with the arguments `mcp serve --project <absolute project root>`, so the server never guesses the
   project from a working folder. When the `hermes` CLI is on the path, the entry is added through
   `hermes mcp add`. Otherwise, or when that did not register it, the runtime edits
   `$HERMES_HOME/config.yaml` itself: a new entry is inserted at the end of the `mcp_servers` map
   (or a new map at the end of the file), so every other line stays as it was, and an existing
   entry is updated in place, keeping comments and keys added by hand. Before writing, it copies the
   file to `config.yaml.bak-<time>`; the file keeps its permissions (a new one is made with mode
   `0600`). The edit holds an exclusive lock file, `config.yaml.mw-lock` (created only if absent;
   one whose process is gone, or not refreshed for 300 seconds, is stale). A stale lock is judged
   and moved aside only under the takeover guard `config.yaml.mw-lock.takeover` (created only if
   absent, holding the pid and process start time; itself stale after 300 seconds or when its
   process is gone), and only if, right before the rename, the lock file is still the same file
   (inode) with the same content as judged; a lock another process put in its place is left alone
   and waited for. A file moved aside that turns out to be another holder's lock is put back; when a
   third process holds the lock by then, it is never deleted but left under its
   `config.yaml.mw-lock.stale-*` name, with a warning naming it. The edit re-reads the configuration
   under the lock, and refuses,
   keeping the backup, when the file changed between that read and the rename. A configuration
   that is not valid YAML is refused. Hermes starts the server without the login
   session's environment, so the entry gets `env: {SSH_AUTH_SOCK: <path>}` when an
   SSH agent socket is found at init time (`SSH_AUTH_SOCK`, else the first socket of
   `ssh-agent.socket`, `keyring/ssh`, `openssh_agent`, `gcr/ssh` in `$XDG_RUNTIME_DIR`, or in
   `/run/user/<uid>` when that is unset); with none, no `env` is written and a note says so. The
   socket path is not a secret.
2. It installs the skill from the package's `SKILL.md` as
   `$HERMES_HOME/skills/mergewright/SKILL.md`, or with `--shared` in the shared skills folder, one a
   file-sync tool can carry to another machine: `MW_HERMES_SHARED_SKILLS`, default
   `$HERMES_HOME/shared-skills`
   (refused when the package lacks the file). The skill tells Hermes the workflow, which
   tool to use when, and the rules.
3. It prints what it did and the check to run, `hermes mcp test <name>`. Hermes loads the tools in
   a new session or after `/reload-mcp`.

Running it again changes nothing unless the project moved, the runtime moved or the package changed. `mw hermes remove`
removes the entry (through `hermes mcp remove`, or by cutting its lines from the file, with the
same backup and lock) and removes the skill only when no other MergeWright entry is left. The Hermes
configuration holds no secret: the server reads the service keys (a package's, such as the notebook password) from the
secrets file, like every `mw` command (section 10.4).


### 15.5 The board-4ga package

The official `board-4ga` package mirrors each card's id, title and live status to a board of
[4ga Boards](https://github.com/RARgames/4gaBoards), as `cline-kanban` does for a Kanban board
(section 10.5): card files stay the source of truth, and the board is a view. It was written from
the 4ga Boards source at commit `538edfc3e85b174529c2c65cd289e3cc5d3cf88e` (the project has no API
documentation) and has been tested only against a fake server; it has not been run against a live
instance.

| Setting (`packages.board-4ga.`) | Type | Default | Meaning |
|---|---|---|---|
| `url` | string, required | none | The 4ga Boards server; `/api` is added when missing. |
| `board` | string of digits, required | none | The board's id. |
| `client_id_env`, `client_secret_env` | variable names | `BOARD_4GA_CLIENT_ID`, `BOARD_4GA_CLIENT_SECRET` | The variables holding the id and secret of a 4ga API client (sent as `X-Client-Id` and `X-Client-Secret`). Both are declared secrets (section 10.4). |

The API client belongs to a user who is an editor of the board and needs the permissions
`boards.show`, `lists.create`, `cards.create` and `cards.update`. Each MergeWright card is one 4ga card
named `[<CARD-ID>] <title>`, found again by that prefix, in the list of its status: Backlog (`todo`,
`ready`, anything else), In progress (`in_progress`, `running`), Review (`review`, `waiting`,
`blocked`) and Done (`done`, `aborted`). A list missing from the board is created at its end (Done as
a completed list); an existing one is matched by name without regard to case. A status change moves
the card at once; when the board does not answer, the status is queued (kind `board-4ga`), a newer
status replaces it, and `mw queue flush` drops it when the card has left that status. Without the id
or secret set, the run records "4ga: mirror skipped (...)" once and nothing is queued.
`mw board-4ga mirror` and `mw work` (the package's `reconcile`) bring the board level with every card
and rename a card whose title changed; `mw work` prints a line only when a card changed or failed.
The package also provides the `board-4ga` check of `mw doctor`. It never deletes or archives a 4ga
card and adds no comments or MCP tools.

### 15.6 The notebook-opennotelm package

The official `notebook-opennotelm` package mirrors the documentation to one notebook of
[OpenNoteLM](https://github.com/daozen/opennotelm), as `open-notebook` does for Open Notebook
(section 10.3: the same `docsSync`, queue and blob reading). It was written from the OpenNoteLM
source at commit `c709bfa0c31641f3aecca468c8be16ebee01a353` (the project has no API documentation)
and has been tested only against a fake server; it has not been run against a live instance.

| Setting (`packages.notebook-opennotelm.`) | Type | Default | Meaning |
|---|---|---|---|
| `url` | string, required | none | The OpenNoteLM server; `/api` is added when missing. Its host must be in OpenNoteLM's `ALLOWED_HOSTS`. |
| `name` | string | the project's name | The notebook's title; the first sync creates it. |

OpenNoteLM has no authentication, so the package declares no secret. Each documentation file is one
source uploaded as a multipart file (`host.http.json` with `form`) named after its repository path
with `%` and `/` escaped (`docs%2Fguide.md`; `.txt` is added to a name that does not end in `.md`,
`.markdown` or `.txt`). A changed file is uploaded again only when its bytes differ from its source's
SHA-256 checksum, before the old source is deleted; a deleted file's source is deleted. A batch the
server does not answer is queued with its commit (kind `notebook-opennotelm`). A file the server
refuses (a 4xx answer other than 408 and 429) and an empty file are reported and not retried; a file
whose bytes equal a source OpenNoteLM already holds is attached as that source, with a warning.
`mw notebook-opennotelm sync --all` sends every tracked documentation file of the last commit and
uploads only those that changed. The package also provides the `opennotelm` check of `mw doctor`.
It provides no `searchDocs` and no ask: OpenNoteLM has no search endpoint, and its chat writes into
the notebook's stored conversation through a background job. It does not wait for the background
ingest of an upload.

## 16. The GUI: `mw ui`

`mw ui` serves a small page in the browser over the same operations as the MCP server (section
12): a board of the cards by status, a card's detail with its run and run files, specs and trace,
search over memory and documentation, and the packages and settings. The page is plain HTML, CSS
and ES modules in `src/ui/web/`, with no framework, no build step and no request to any other
host; it is shipped like `schemas/` and `presets/` (section 2.6). Only
the owner uses it, on the machine the project is on: there are no accounts and no remote access.

**Binding.** The server listens on `127.0.0.1` only, never on another interface (`ui/not-loopback`
for any other address), on port 7341 by default or the port `--port` gives (section 11.6).

**Token.** Each start makes a random access token of 256 bits. The link printed (and opened) is
`http://127.0.0.1:<port>/?token=<token>`. A `GET /` with the right token answers `303` to `/` and
sets the cookie `mw_ui_<port>=<token>; HttpOnly; SameSite=Strict; Path=/`, so the token leaves the
address bar. Every other request, static files included, needs that cookie or the header
`Authorization: Bearer <token>`; tokens are compared in constant time. Without one the answer is
`401`: a plain page saying to open the link the terminal printed (and, for `/api/`, a JSON error).
A new start makes a new token; the old link stops working.

**Checks on every request**, in this order:

1. The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, else `403` (a page on
   another name that resolves to this machine sends its own name: DNS rebinding).
2. The token, as above.
3. A request that changes state is a `POST` with `Content-Type: application/json` (`415`
   otherwise, so a plain HTML form cannot send one); an `Origin` header, when present, must be the
   server's own origin (`http://127.0.0.1:<port>` or `http://localhost:<port>`), else `403`. The
   body is at most 1 MB (`413`, and the connection is closed) and must be a JSON object (`400`).
4. Methods other than `GET`, `HEAD` and `POST` get `405`.

Every answer carries `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src
'self'; ...; frame-ancestors 'none'` (no inline script or style), `X-Content-Type-Options:
nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `Cache-Control: no-store`.
Static files are served from a list of the page folder's files made at start, looked up by the
request's path as a whole; a path is never joined to a folder, so anything else, `..` included, is
`404`.

**API.**

| Route | Answer |
|---|---|
| `GET /api/tools` | `{tools: [...]}`: every tool as `listTools` describes it: name, description, input schema, whether it writes, the name of its data type in `src/mcpserver/results.ts` (`RESULTS_VERSION`), and the package that provides it. |
| `POST /api/tool/<name>` | The body is the tool's arguments. The answer is always `200` with `{text, data, isError}`: the tool's text, its data (or `null`) and whether it failed. A refusal is `isError: true` with its data when it has some (setting a card ready that fails lint gives `{lint}`, `card/not-ready`); invalid arguments and an unknown tool are refusals too. Write tools are refused inside a card run exactly as over MCP (section 12.2). Non-2xx answers belong to the checks above. |
| `GET /api/events` | A server-sent event stream: `event: hello` at once, then `event: changed` with `{"count": n}` whenever a card file under `cards/` or anything under `.mergewright/runs/` changed (by `fs.watch`, and a poll every 3 seconds for what it misses, debounced), and a `: heartbeat` comment every 20 seconds. The page then fetches what it shows again; the stream carries no project data. The watchers run only while a client is connected, and the stream ends when the server stops. |

The page reads only these routes and the shapes of `results.ts`. Card and run content is written
by agents and treated as untrusted: it is put into the page as text nodes only, and Markdown is
rendered by the page's own renderer, which builds elements from a short list of tags and keeps only
`http`, `https`, `mailto` and `#` links.

## Appendix A: Diagnostic codes

Every problem `mw check` reports has a stable code. Errors make the project non-conforming;
warnings do not, except under `--strict`.

### A.1 Configuration and layout

| Code | Severity | Meaning |
|---|---|---|
| `config/yaml` | error | `mergewright.yaml` is not valid YAML or not a mapping. |
| `config/schema` | error | A config key is missing, unknown, or has a wrong value. Until it is fixed, commands that write, commit or run refuse with `config/invalid` (section 3; A.7). |
| `config/version` | error | The project targets a specification version this runtime does not implement. |
| `config/preset` | error | `extends` names an unknown preset. |
| `config/role-override` | error | `roles.<id>` overrides a role that does not exist. |
| `config/package` | error | `packages.<name>` enables a package that is not installed here (run `mw add <name>`), whose manifest is invalid or names another package, or whose settings fail its schema (section 15). |
| `layout/stray-file` | warning | A file in `specs/`, `specs/changes/`, `cards/`, `roles/`, `flows/`, `gates/`, `mcps/`, `memory/lessons/`, `memory/decisions/` or `memory/outcomes/` has the wrong suffix and is ignored. |
| `layout/agents` | warning | `AGENTS.md` is missing. |
| `sync/temp-file` | warning | Git tracks a file-sync temporary file (`.*.tmp`) or conflict copy (`*.sync-conflict-*`); remove it with `git rm --cached` and keep both patterns in `.gitignore` (section 2.4). |

### A.2 Specs

| Code | Severity | Meaning |
|---|---|---|
| `spec/front-matter` | error | Missing or invalid front matter. |
| `spec/schema` | error | A front matter field is missing, unknown or invalid. |
| `spec/file-name` | error | The file is not named `<id>.spec.md`. |
| `spec/duplicate` | error | Two specs share an id. |
| `spec/req-heading` | error | A `REQ-` heading is not in the form `### REQ-<spec>-<nnn> Title`. |
| `spec/req-prefix` | error | A requirement id does not belong to its spec. |
| `spec/duplicate-req` | error | A requirement id is defined twice (in one file or across files). |
| `spec/priority` | error | Missing priority, or a value other than must, should, could. |
| `spec/rev` | error | `rev` is not a positive whole number. |
| `spec/status` | error | A requirement status other than active or deprecated. |
| `spec/no-criteria` | error | An active must or should requirement has no acceptance criteria. |
| `spec/criterion-form` | error | A criterion does not read "Given ..., when ..., then ...". |
| `spec/criterion-id` | error | A criterion-like bullet is not written `- AC-<n>: ...`. |
| `spec/duplicate-criterion` | error | Two criteria of one requirement share an id. |
| `spec/unclosed-fence` | warning | An unclosed code fence hides the rest of the file. |

### A.3 Spec changes

| Code | Severity | Meaning |
|---|---|---|
| `change/front-matter` | error | Missing or invalid front matter. |
| `change/schema` | error | A front matter field is missing, unknown or invalid. |
| `change/file-name` | error | The file is not named `<id>-<slug>.change.md` or `<id>.change.md`. |
| `change/op` | error | A malformed or inapplicable operation (section 7.3). |
| `change/empty` | error | A proposed change has no operations. |
| `change/unknown-spec` | error | The change targets a spec that does not exist. |
| `change/req-heading`, `change/req-prefix`, `change/duplicate-req`, `change/priority`, `change/rev`, `change/status`, `change/no-criteria`, `change/criterion-form`, `change/criterion-id`, `change/duplicate-criterion` | error | The requirement block inside an operation breaks the rule of the spec code with the same name (section 4.1). |
| `change/unclosed-fence` | warning | An unclosed code fence inside an operation. |

### A.4 Cards

| Code | Severity | Meaning |
|---|---|---|
| `card/front-matter` | error | Missing or invalid front matter. |
| `card/schema` | error | A field is missing, unknown or invalid. |
| `card/file-name` | error | The file is not named `<id>.card.md`. |
| `card/why` | error | No non-empty `## Why` section. |
| `card/duplicate` | error | Two cards share an id. |
| `card/prefix` | error | The id does not start with `cards.prefix`. |
| `card/unknown-requirement` | error | `implements` names an unknown requirement. |
| `card/no-requirement` | error | A feature card implements nothing (with `trace.require_implements`). |
| `card/depends` | error | A dependency on itself or on an unknown card. |
| `card/cycle` | error | A dependency cycle. |
| `card/unknown-flow` | error | The card's flow does not exist. |
| `card/scope` | error | An unfinished card in a writing flow has no scope. |
| `card/scope-docs` | warning | A `todo` or `ready` card's scope covers none of `docs.paths` (when the project has documentation paths). |
| `card/scope-protected` | warning | A card that is not done names a protected path in its scope that `allow_protected` does not grant. |
| `card/stale` | warning | The card was written against an older revision of a requirement. |
| `card/deprecated-requirement` | warning | An unfinished card implements a deprecated requirement. |

Card lint (`mw card lint`, `mw_card_lint`; section 4.2) reports these codes. They are not `mw
check` diagnostics; the errors stop a card from becoming `ready` and a fresh run from starting.

| Code | Severity | Meaning |
|---|---|---|
| `lint/placeholder` | error | `## Out of scope` still holds the scaffold text `mw card new` wrote (`None` passes). |
| `lint/why-empty` | error | `## Why` is empty or still the scaffold text. |
| `lint/no-acceptance` | error | No `## Acceptance` criteria and no requirement in `implements`. |
| `lint/scope-empty` | error | No `scope` globs. |
| `lint/scope-protected` | error | A `scope` glob covers a protected path `allow_protected` does not grant, or a protected path lies inside a `scope` glob that is not a documentation path (section 4.2). |
| `lint/output-outside-scope` | error | A path named in `## Acceptance` or `docs` is covered by no `scope` glob. |
| `lint/depends-open` | warning | A dependency is not `done`. |
| `lint/stale` | error | An implemented requirement's revision differs from the one in `revs`. |

### A.5 Roles, flows, gates and MCP servers

| Code | Severity | Meaning |
|---|---|---|
| `role/front-matter` | error | Missing or invalid front matter. |
| `role/schema` | error | A field is missing, unknown or invalid; `runs` names a harness that is neither built in nor declared by an enabled package. |
| `role/file-name` | error | The file is not named `<id>.role.md`. |
| `role/mode` | error | `mode: write` on a harness that cannot write (in the role file, or after a config override). |
| `role/command` | error | `runs: shell` without `command` (likewise). |
| `role/profile` | error | `runs: local` without `profile` or `model` (likewise). |
| `role/prompt` | error | Empty prompt. |
| `role/placeholder` | error | Unknown `{{placeholder}}`. |
| `role/unknown-mcp` | error | The role names an unknown MCP server. |
| `role/mcp-unsupported` | warning | A role on `local` or on a package's harness is given MCP servers it cannot use. |
| `flow/yaml` | error | Not valid YAML. |
| `flow/schema` | error | A field is missing, unknown or invalid. |
| `flow/file-name` | error | The file is not named `<id>.flow.yaml`. |
| `flow/duplicate-phase` | error | Two phases share an id. |
| `flow/empty-phase` | error | A phase with no role, gate or action. |
| `flow/gate-phase` | error | A gate phase that also has a role or an action. |
| `flow/also` | error | `also` on a phase with no role. |
| `flow/needs` | error | `needs` names a phase that is not earlier. |
| `flow/condition` | error | An invalid condition. |
| `flow/remediate` | error | An invalid `remediate.phase`, or `remediate` used without a `remediate` block. |
| `flow/on-target` | error | An `on` target that is not a phase, `remediate`, `stop` or `continue`. |
| `flow/unknown-role` | error | A phase uses an unknown role. |
| `flow/unknown-gate` | error | A phase uses an unknown gate. |
| `flow/action-input` | error | `memory.update` without a role whose output is `reflection`. |
| `flow/merge` | error | `merge` in a flow with `worktree: false`. |
| `flow/write` | error | A writing role (phase or `also`) in a flow with `worktree: false`. |
| `gate/not-executable` | error | A gate file is not executable. |
| `mcp/yaml` | error | Not valid YAML. |
| `mcp/schema` | error | A field is missing, unknown or invalid. |
| `mcp/file-name` | error | The file is not named `<id>.mcp.yaml`. |
| `mcp/command` | error | A `stdio` server without `command`. |
| `mcp/url` | error | An `http` server without `url`. |
| `mcp/literal-secret` | error | A secret written into the file instead of an environment reference. |
| `mcp/unknown-role` | error | `roles` names an unknown role. |

### A.6 Memory and tracing

| Code | Severity | Meaning |
|---|---|---|
| `memory/missing` | error | `memory/STATE.md` or `memory/RULES.md` is missing. |
| `memory/too-long` | error | `STATE.md` or `RULES.md` exceeds its line cap. |
| `memory/index-stale` | warning | `memory/INDEX.md` does not match the memory files (run `mw memory index`). |
| `trace/unknown-requirement` | error | An `@req` comment names an unknown requirement. |
| `trace/untested` | error | A finished requirement of a required priority has no test. |

### A.7 Command errors

Commands that refuse to act print `mw: <message>` and exit 1 (2 for usage errors). These are not
diagnostics of the project's files, but they have codes too:

| Code | Raised when |
|---|---|
| `usage` | Unknown command, missing argument, or invalid flag combination (exit 2). |
| `owner-only` | A command reserved to the owner was run, or an MCP tool that writes was called, inside a card run (`MW_ROLE` set; sections 7.1 and 12.2). |
| `no-project` | No `mergewright.yaml` in the current folder or above. |
| `no-card` | The named card does not exist. |
| `card/title`, `card/unknown-requirement`, `card/no-requirement` | `mw card new` or `mw_card_new` without a title, with an unknown requirement, or (with `trace.require_implements`) a `feature` card without `--implements` (`implements`). |
| `memory/too-long`, `memory/state-form`, `memory/lesson-form`, `memory/decision-form`, `memory/outcome-form` | A memory operation with a state over the cap or without a `# ` heading, or an entry without its required parts. |
| `change/unknown`, `change/unknown-spec`, `change/summary`, `change/status`, `change/invalid`, `change/owner-only` | A spec change command on an unknown change or spec, without a summary, on a change that is no longer proposed, on an invalid change, or `accept` from inside a run. |
| `config/invalid` | `mw config set` or `unset` would make the configuration invalid; or a command or MCP tool that writes, commits or runs was refused because `mergewright.yaml` is not valid YAML or fails its schema (section 3). The message lists every schema error on a line of its own as `<key path>: <message>`. |
| `eject/kind`, `eject/preset`, `eject/unknown`, `eject/exists` | `mw eject` of an unknown kind or id, without a preset, or onto an existing file. |
| `mcp/exists`, `mcp/invalid`, `mcp/unknown`, `mcp/unknown-role`, `mcp/env` | `mw mcp` on an existing or unknown server, an invalid definition, an unknown role, or an unset environment variable. |
| `upgrade` | No migration exists from the project's version. |
| `schema`, `json`, `git` | A shipped schema cannot be loaded, a JSON file is corrupt, or a git command failed. |
| `hub/no-remote`, `hub/unreachable`, `hub/not-on-base`, `hub/diverged`, `hub/push-rejected`, `hub/lease-held`, `hub/lease-lost`, `hub/lease-race`, `hub/branch-busy`, `hub/branch-diverged`, `hub/delete-rejected` | Hub errors (section 9): the hub remote does not exist or does not answer; the checkout is not on the base branch; the base branch has diverged from the hub; the hub refused a push; another machine holds a fresh lease, took it over, or changed it at the same moment; a card branch is checked out elsewhere, has diverged from the hub's copy, or could not be deleted on the hub. |
| `hub/staged`, `hub/head-moved` | Adopt refused: the index holds staged changes, or the base branch moved while adopting (section 9.2). |
| `lease/lost` | This machine lost the lease during a run; the phase was discarded and nothing was saved (section 8.8). |
| `worktree/unsafe` | A card worktree failed the worktree check (section 8.4). |
| `worktree/move-failed` | A worktree could not be moved aside to `.mergewright/local/discarded/`, the discard folder failed its real-path check, or a moved copy could not be detached from git (section 8.4). Nothing was deleted. |
| `worktree/discard-unsafe` | The discard folder failed its real-path check, so old discarded worktrees were not removed (reported as a run warning). |
| `hub/offline` | `offline` asked for through the programming interface (`runCard`, `work`, `abort`, the hub's `prepare`) on a project with a hub. The command line no longer produces it: the commands that run cards refuse `--offline` as a usage error (section 8.2). |
| `hub/push-refused` | The hub refused a fenced push three times for a reason other than the lease; nothing changed on the hub (section 9.3). |
| `hub/release-refused` | The hub refused to delete the lease ref (check its receive settings, such as `receive.denyDeletes`). |
| `run/merged` | `--from` or `mw retry` on a card that is already merged, including one whose interrupted merge had already reached the base branch (section 8.10). |
| `run/stopped` | The owner stopped the run with a signal; the active phase was abandoned and nothing of it saved (section 8.7). The command exits 130. |
| `run/registry-busy` | Another `mw` process on this machine kept the run registry's guard for more than 35 seconds (section 8.7). |
| `run/orphans` | A process group the run started was still alive after SIGTERM, SIGKILL and two more minutes of attempts; it is named in the message and recorded in `.mergewright/local/locks/<CARD>.orphans`. The command exits 1, and `mw work` takes no further card (sections 8.7 and 8.9). |
| `run/orphans-alive` | The card was not started, or `mw abort --force` was refused, because a process recorded in its orphans file is still alive (sections 8.4 and 8.7). |
| `run/sandbox-required` | The sandbox policy is `required` and a write phase's role would run unconfined (the Claude sandbox does not work on this machine, or the role runs on `shell`); the run is `blocked` before that phase, with this code in its reason (section 8.6). |
| `gate/required-skipped` | A gate's result marked a step that `gate.required` names as skipped; the gate failed and the phase blocked (sections 4.6 and 8.3). It starts the block reason; it is not an error of a command. |
| `gate/required-missing` | A gate exited 0, but its result did not show a step that `gate.required` names exactly once and well formed (the step is absent, listed twice or malformed), or the gate wrote no JSON summary or a malformed one while `gate.required` is not empty; the gate failed and the phase blocked without spending a remediation round (sections 4.6 and 8.3). It starts the block reason; it is not an error of a command. |
| `harness/transient` | A role failed transiently (at capacity, overloaded, HTTP 429 or 5xx, a provider request timeout, a reset connection) on its model after `limits.transient_retries` retries, and on its `fallback_model` when it has one; the phase blocked without spending a remediation round, and the detail names each model tried and the last error (sections 8.3 and 8.6). It starts the block reason, and is the error code of `mw_delegate` and `mw_review` in the same case. |
| `memory/dirty` | `memory/` gained uncommitted changes between the reflection's first check and its writes; nothing was written and the phase is blocked (section 7.2). |
| `merge/conflict`, `merge/failed` | The forge could not merge the pull request because of conflicts, or for another reason (section 10.6). |
| `run/locked`, `run/no-git`, `run/no-base`, `run/not-on-base`, `run/none`, `run/done`, `run/not-waiting`, `run/wrong-approval`, `run/no-flow`, `run/no-role`, `harness/unknown` | Run loop errors (section 8): the card is being run by another process; the project is not a git repository, has no base branch, or the main checkout is not on it; there is no run, or it is already done; an approval for a run that is not waiting, or with a word it does not ask for; the card's flow or a phase's role does not exist; a role names an unknown harness. |
| `run/file-path`, `run/no-file` | `mw_run_file` (section 12.3): the name is not a plain path inside the card's run folder, or leads outside it through a symbolic link; there is no such file. |
| `docs/git` | Listing documentation files outside a git repository. |
| `open-notebook/failed` | A tool of the `open-notebook` package failed, for example because the notebook did not answer. |
| `tui/no-tty` | `mw tui` without an interactive terminal (exit 2; section 11.6). |
| `delegate/no-role`, `delegate/write`, `delegate/harness`, `delegate/role`, `delegate/cwd`, `delegate/usage`, `delegate/failed` | Delegation (section 12.4): an unknown role; a role with mode `write`; a harness delegation does not use; a role that fails its checks after the overrides; a `cwd` that is not an existing folder inside the real project root; the usage guard is paused and the role runs on a paid harness (reason `usage`); the agent failed or returned no valid output (the message names its folder). |
| `review/empty` | `mw_review` found nothing to review: the diff is empty. |
| `card/status` | `mw_card_set_status` or `mw card status` on a card that is neither `todo` nor `ready`, or asking for another status. |
| `card/staged` | `mw card new --commit` or `mw card status --commit` found staged changes to other files in the index; nothing was written. Commit or unstage them, then try again. |
| `card/not-ready` | `mw card status <ID> ready`, `mw_card_set_status` with `ready`, `mw card new --status ready`, `mw_card_new` with `status: ready`, or a fresh run (`mw run`, `mw work`, `mw_run_start`) refused a card with lint errors; the message lists the `lint/*` codes, and nothing was written or committed (section 4.2). |
| `run/wrong-word`, `run/spawn` | `mw_approve` with a word the run does not wait for; a background `mw run` or `mw approve` could not be started. |
| `docs/path`, `docs/protected`, `docs/branch`, `docs/changed` | `mw_docs_write` refused: the path is not a plain path matching `docs.paths`, or goes through a symbolic link; the path is protected; the main checkout is not on the base branch; the file changed while the write waited for the lock, and nothing was written (section 12.5). |
| `<package>/failed` | A package's tool or store failed, e.g. `mem0/failed` when mem0 did not answer; the message is the package's. |
| `package/consent`, `package/api-version`, `package/unknown`, `package/manifest`, `package/no-manifest` | `mw add` refused: no `--yes` and no terminal to ask in; the package is written for another package API version; no official package of that name (or `mw remove` of a package that is not there); the folder's `mergewright-package.yaml` is missing or invalid, or names an entry it does not have (section 15). |
| `package/outside`, `package/queue-kind` | A package asked to read a file outside the project, or to queue an item of a kind that is not its own (section 15). |
| `letta/failed` | A tool of the `letta` package failed, for example because Letta did not answer. |
| `cline-kanban/failed` | A tool of the `cline-kanban` package failed: no `kanban` command on the path, a Kanban command that failed (including no reachable runtime), or an unknown task id. |
| `mcp/no-project`, `mcp/command` | `mw mcp serve` for a project folder that does not exist; a command a tool runs in-process failed, and its output is the message (the diagnostic `mcp/command` of A.5 is a different problem with the same code). |
| `card/branch`, `memory/branch` | An MCP card or memory tool, or `mw card new --commit` or `mw card status --commit`, was called with the checkout not on the base branch; nothing was written. |
| `card/path`, `memory/path` | An MCP card or memory tool found that a path leads outside the project's real root (a symlink, for example). |
| `mcp/commit` | An MCP tool's commit failed after its preconditions passed; every file it wrote was restored to its previous content and index entry (a new file removed), so nothing was kept (section 12.5). |
| `git/identity` | A committing MCP tool was called while git has no identity in the checkout (`git var GIT_COMMITTER_IDENT` or `GIT_AUTHOR_IDENT` fails); nothing was written. Set `git config user.name` and `git config user.email` (section 12.5). |
| `repo/unlocked` | A committing MCP write was attempted without holding the repository lock (a defect; the tools always take it); nothing was written (section 12.5). |
| `repo/locked` | A committing MCP tool waited ten seconds for the repository lock `.mergewright/local/locks/repo.lock` held by another live process; nothing was written (section 12.5). |
| `lease/held` | A committing MCP tool on a project with a hub found the lease held by another machine (named in the message); nothing was written (section 12.5). |
| `card/file-mismatch` | An MCP card tool was asked for a card whose file is not named `<id>.card.md`; nothing was changed (section 12.5). |

## Appendix B: Role output schemas

A role's `output` names the artifact it must return. Every field listed is required unless marked
otherwise, and no other fields are allowed. The schemas are in `schemas/output.<kind>.schema.json`
in the MergeWright package. A `text` output has no schema.

### B.1 `brief` (planner)

| Field | Type | Meaning |
|---|---|---|
| `summary` | string | What the card delivers. |
| `approach` | string | What to build and in what order, naming the code to reuse. |
| `scope` | list of strings | Path globs the worker may write. Both this and the card's scope apply, so a wider brief scope cannot widen what the card allows. |
| `acceptance` | list of strings | The acceptance criteria, copied verbatim, plus any the card adds. |
| `guards` | list of strings | Predictable defects stated as rules. |
| `docs` | list of strings | Documents the worker must update. |
| `risk` | `low`, `medium`, `high` or `critical` | The planner's risk assessment. The effective risk is the higher of this and the card's. |
| `deep_review` | boolean | Whether the change needs a deep review. |
| `ready` | boolean | False when the card cannot be implemented as written. |
| `blockers` | list of strings | Why it is not ready. |

### B.2 `handoff` (worker, docs-writer)

| Field | Type | Meaning |
|---|---|---|
| `status` | `done` or `blocked` | Whether the work is finished or the worker stopped. |
| `summary` | string | What changed; its first line becomes the commit message. |
| `changed` | list of strings | Files changed. |
| `verified` | list of strings | What was verified, and how. |
| `not_done` | list of strings | What is not done. |
| `docs_updated` | list of strings | Documents updated. |
| `notes` | string | Anything the next person must know. |

### B.3 `findings` (reviewers)

| Field | Type | Meaning |
|---|---|---|
| `summary` | string | The review in a few sentences. |
| `findings` | list of findings | Empty when the change is sound. |

Each finding:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique within the review (`R-01`). Prefixed with the role id when reviews are merged. |
| `severity` | `low`, `medium`, `high` or `critical` | How bad it is. |
| `blocking` | boolean | True when the card must not merge with it. |
| `file` | string or null | The file concerned. |
| `line` | integer or null | The line concerned. |
| `title` | string | One line. |
| `detail` | string | What is wrong and why it matters. |
| `suggestion` | string or null | How to fix it. |

### B.4 `adjudication` (adjudicator)

| Field | Type | Meaning |
|---|---|---|
| `verdict` | `approve`, `reject` or `block` | Approve the change, send it back, or stop for the owner. |
| `summary` | string | The reasoning in brief. |
| `accepted` | list of strings | Ids of findings accepted as real. |
| `rejected` | list of `{id, reason}` | Findings rejected, each with its reason. |
| `instructions` | string | For `reject`: exactly what the worker must change. |
| `conditions` | list of `{what, how}`, optional | With `approve`: what must be done before the merge (`what`) and how (`how`). The run stops at the stop point `conditions` before the merge (section 8.5). Ignored with `reject` or `block`. |
| `follow_ups` | list of `{title, why, scope?, kind?, risk?}`, optional | Work that should follow the card; after the merge each becomes a `todo` card (section 8.3). `scope` is a list of path globs (default: the parent card's), `kind` one of `feature`, `fix`, `chore`, `docs`, `spike` (default `chore`), `risk` one of `low`, `medium`, `high`, `critical` (default `medium`). |

A harness with strict structured output (Codex) is given the schema with the optional fields
required and nullable; the runtime drops the nulls it returns for them before validating.

Beyond the schema, in a card phase (section 8.3, "Adjudication rules"): every id in `accepted` and
`rejected` must name a finding of the run's `findings` artifact (its full id, or its id without the
reviewer prefix when that fits one finding only); every blocking finding must be in `accepted` or
`rejected`; with `approve`, `accepted` holds no blocking finding; and the findings artifact must not
repeat a full id. A reply that breaks a rule is
asked for once more with the errors, then the phase fails; a stored approval that breaks one is not
merged (section 8.4). `mw_delegate` (section 12.3) checks only the schema: it has no findings artifact.

### B.5 `reflection` (reflector)

| Field | Type | Meaning |
|---|---|---|
| `state` | string | The complete new `memory/STATE.md`, starting with a `# ` heading, within the cap. |
| `outcome` | string | What the card delivered, in at most five lines. |
| `lessons` | list of `{topic, title, body}` | `topic` is a slug (`^[a-z][a-z0-9-]*$`); `title` states the rule; `body` gives the reason. Reusing an existing title updates that lesson. |
| `decisions` | list of `{title, body}` | Owner decisions or settled disputes. |

### B.6 Gate result

The gate result (`gate.json`) is not a role output and has no schema file. A gate writes the form
given by the gate contract (section 4.6): `{"ok": bool, "steps": [{"name", "kind", "ok", "seconds",
"log"}]}`, a step that did not run with `"skipped": true` and its `"reason"`. The `gate` artifact the
runtime stores adds to it:

| Field | Meaning |
|---|---|
| `head` | The commit the gate judged (the card branch's head). The merge requires it to be the commit merged (section 8.4). |
| `steps[].tail` | The end of the step's log, copied when the gate finished: at most the last 40 lines (read from at most the last 256 KB), credentials redacted. Prompts use this copy. |
| `warnings` | Logs the runtime refused (outside the gate-log folder, not a regular file, missing); such a step's `log` is removed. Also malformed steps (no string `name` or no boolean `ok`), which are removed from `steps`. |

The `ok` field is the exit code's verdict, whatever the gate wrote, except that a step
`gate.required` names that is skipped, absent, listed twice, malformed or failing makes it false, as
does a missing or malformed summary while `gate.required` is not empty. Other step fields (such as
`tests` counts) are kept as the gate wrote them. The runtime likewise adds `head`,
the commit reviewed, to the `findings` artifact (B.3) it stores.

## Appendix C: Versioning and `mw upgrade`

This document is specification version `0.1`. Every project declares the version it targets in
the required `mergewright` key of its configuration. A runtime implements exactly one
specification version, printed by `mw version` (for example
`mergewright 0.1.0 (specification 0.1)`); the package version and the specification version are
separate numbers.

When a project targets a version the runtime does not implement, `mw check` reports
`config/version` (and `config/schema`, because the key's allowed values are the implemented
version). The JSON schemas carry the version in their identifiers
(`https://mergewright.dev/schemas/0.1/<type>`).

`mw upgrade` migrates a project's files from the version it targets to the runtime's version. When the project is already on the runtime's version, it reports
that there is nothing to migrate. Version 0.1 is the first version, so no migrations exist yet;
`mw upgrade` refuses (`upgrade`) for any other version. Each later version of this specification
will list what changed and what its migration does.
