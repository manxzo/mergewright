# Tooling: installation, the TUI, the MCP server and the Hermes package

What each piece around the engine is for, where it lives, how it is tested, and the decisions
behind it (marked *assumption* where a choice was made without the owner). The engine itself is in
`engine.md`; this file only adds to it.

The pieces: a way to add MCP servers and configure `mw` without editing YAML by hand; a terminal UI
to change the agent and model of every role; an MCP server through which an assistant such as
Hermes can delegate to sub-agents of other models (a Codex model for review, for instance); and,
after one initialisation step in Hermes (the official `hermes` package), a tool set for
documentation, memory and, with packages, task management.

## 0. Decisions made up front

| Decision | Choice | Why |
|---|---|---|
| Memory service | The project's `memory/` folder, plus the memory stores of packages such as `mem0` and `letta` (`packages.mem0`, `packages.letta`) as optional stores. | Each store is an official package (`packages/mem0`, `packages/letta`: for Letta one agent per project, lessons in its archival memory) with its own tools (`mw_mem0_*`, `mw_letta_*`); several may be enabled. "Self-update memory" is served by `mw_memory_state`, `mw_memory_add` and the packages' add tools. |
| Dependencies | None added. The TUI and the MCP server are written against Node's own modules. | The runtime has two dependencies (`ajv`, `yaml`) and ships as a single executable; a TUI framework or an MCP SDK would add more code than they save. |
| Writes by delegated sub-agents | `mw_delegate` runs roles in `advise` or `read` mode only. Work that changes files is a card. | "The model advises, the runtime acts" (engine.md section 1). A sub-agent that wrote files outside a card would bypass scope, gate, review and merge evidence. |
| Where the Hermes package registers the server | In Hermes's own config (`mcp_servers`), one entry per project, through `hermes mcp add` when the CLI is present and by editing the YAML otherwise. | Hermes resolves MCP servers from its config only. A per-project entry carries the project path, so the server never guesses from the working directory. |
| Secrets | Configuration names a secret by its environment variable (`*_env`), never by its value; values live in the environment or in `~/.config/mergewright/env`. | Standing rule of this project: secret values are never printed. |

## 1. Installation

`scripts/install.sh` copies the committed runtime of a checkout to `~/.local/share/mergewright` and
puts `mw` on PATH; the npm package and the single executable (`scripts/build-binary.sh`) are the
other install forms. `scripts/install-service.sh` installs the `mw-work@` systemd unit for
unattended work. All of it is described in [../install.md](../install.md). Tests: `bash -n` on every
script (the gate's `scripts` step) and the unit rendering in `test/req/engine.test.ts`.

## 2. The TUI (`mw tui`)

Zero-dependency, raw-mode terminal UI in `src/tui/`. Refuses to start without a TTY (exit 2,
naming the equivalent `mw config` command).

Architecture: a pure state machine. `src/tui/model.ts` holds `State` and `reduce(state, key):
{state, effects}`; `src/tui/render.ts` turns a `State` into lines of text; `src/tui/term.ts` is
the only file that touches `process.stdin`/`stdout`. Tests drive `reduce` and `render` with no
terminal.

Screens (left list, right detail; `Tab`/arrows move, `Enter` edits, `Esc` back, `q` quits,
`s` saves, `?` help):

| Screen | Shows | Edits (always through the existing managed writers) |
|---|---|---|
| Overview | project name, spec version, the local endpoint and notifications as `mw doctor` probes them, cards by status | none |
| Roles | every role with origin (preset/project), `runs`, `provider`, `model`, `profile`, `mode`, `output` | `runs`, `provider`, `model`, `profile` through `setConfig(project, "roles.<id>.<field>", v)`; `e` ejects the role (copies the preset file into `roles/`) |
| Models | the catalogue used by the picker: a static list per built-in harness (Claude aliases, Codex models) in `src/tui/catalog.ts` (a package harness such as `hermes` has no list: its `model` and `provider` are free text), plus the live tag list of a local endpoint (`GET /v1/models` on `roles.<id>.provider` or the project's local endpoint) | none; a free-text entry is always allowed |
| Config | `cards`, `git`, `risk`, `limits`, `trace`, `local_models`, `report` keys with their current value (URLs redacted) and the schema's description | `setConfig`/`unsetConfig`; invalid values are refused with the validator's message |
| Packages | `mw_packages` with `checks`: installed packages with version, exports, loaded or why not, the names of their secret variables and their health checks (as `mw doctor`); the official packages not installed | none; shows `mw add <name>`, which asks for consent in a terminal |
| MCPs | servers with transport, command/url, roles | add (same fields as `mw mcp add`), remove, change roles |
| Board | `mw_status` in the GUI's seven columns, one column at a time with every count on a strip (80 columns); an opened card is `mw_card_get` and `mw_run_status` (sections, run, run files) | set ready (`mw_card_set_status`), retry with run (`mw_retry`, after `y`), approve |
| Approvals | the waiting cards with their `ask` word | `mw_approve` after a confirmation that shows the card, word, phase and conditions; the card's new state afterwards |

Board, Approvals and Packages read and act only through `callToolStructured` (`src/mcpserver/server.ts`),
as the GUI does: the TUI holds no board logic of its own.

Every write re-runs `mw check` in memory and shows new errors before saving (what `setConfig`
already does). The TUI never prints a secret value: `env`/`headers` of an MCP show only names.

Effects run one after another in key order (`src/tui/run.ts`). Quitting (`q`, `y` after the
unsaved-changes question, or Ctrl-C) stops key handling, lets the queue drain, and only then
resolves; a write that fails during the drain is shown, reported on stderr once the terminal is
restored, and makes `mw tui` exit 1. `runTui` takes its executor and
reporter as an optional third argument, for tests.

Tests (`test/tui.test.ts`): reducer transitions for each screen (board grouping and navigation,
opening a card, the approval's confirmation, packages with and without packages installed); render
snapshots at 80 columns;
a role change through the reducer ends in `mergewright.yaml` and is visible to `Project.load()`;
an invalid limit is refused and the file is unchanged; no TTY exits 2.

## 3. The MCP server (`mw mcp serve`)

`src/mcpserver/`: `protocol.ts` (JSON-RPC 2.0 over stdio, one message per line, protocol version
`2025-06-18`: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`),
`server.ts` (dispatch, errors as `isError` tool results, never a crash), `tools/*.ts` (one file per
group, each exporting `tools: ToolDef[]` with a JSON Schema input and a handler returning text or
JSON). `mw mcp serve [--project DIR]` is the entry; `--project` defaults to the current project.

Tool groups (names are stable; they are the contract with MCP clients such as Hermes). The groups of packages are marked:

| Group | Tools | Notes |
|---|---|---|
| delegate | `mw_delegate` (task, role or harness+model, mode advise/read, output text/findings/brief/adjudication, minutes, cwd), `mw_review` (ref range or diff, model) | Runs a one-off role through `harnessFor` with the same harness settings as a card phase: `read` in the project root or a folder of it (`cwd` resolved with `realpath`, a directory inside the real project root), `advise` in an empty folder from `mkdtemp` in the system temp folder, removed afterwards, with the harness's no-tools setting. The effective role keeps only `runs`, `model`, `provider`, `profile`, `mode`, `output`, `limits` and the prompt: never the role's MCP servers, `args` or `command`. Each call gets its own run directory, `mkdtemp` of `.mergewright/local/delegate/<time>-<label>-`. `mw_review` is `mw_delegate` with the `reviewer` role and the diff of the given range. Returns the model's output, the effective model (the role's `model`, else its provider/profile) and usage (`null` when the harness reports none, as Hermes does). The `mock` harness is refused unless `MW_DELEGATE_ALLOW_MOCK=1` (tests only: with `MW_MOCK_SCRIPT` it can write in the project whatever the mode). There is no OS-level sandbox: advise mode is an empty folder plus the harness's no-tools setting, so a model with any file tool could read what the owner's account can read (`packages/hermes/README.md`, "The limit"). |
| cards | `mw_cards_list`, `mw_card_get`, `mw_card_new`, `mw_card_set_status` (todo/ready only), `mw_status` | Through `src/cards.ts` and `mw status --json`. |
| runs | `mw_run_start` (detached `mw run <ID>`, returns at once), `mw_run_status`, `mw_approve`, `mw_retry`, `mw_abort` | The server never blocks a Hermes turn on a card run. |
| docs | `mw_docs_write` (path under `docs.paths`, content; writes the file, commits with `docs:` prefix *assumption*, syncs to the documentation services of enabled packages), `mw_docs_search`; `mw_docs_ask`, `mw_docs_sync` come with the `open-notebook` package | "Writing documentation for Open Notebook" is writing it in the repository; the notebook is the index of the repository, never a second source of truth. |
| memory | `mw_memory_add` (lesson/decision; project memory plus the packages' stores), `mw_memory_push` (every lesson and decision file to those stores, idempotent), `mw_memory_search` (project index plus the packages' stores), `mw_memory_state` (replace STATE.md); `mw_mem0_add`, `mw_mem0_search` (the `mem0` package), `mw_letta_add`, `mw_letta_search` (the `letta` package) | The "self-update memory" tools. |
| kanban (the `cline-kanban` package) | `mw_kanban_list`, `mw_kanban_get`, `mw_kanban_create`, `mw_kanban_update`, `mw_kanban_done`, `mw_kanban_delete`, `mw_kanban_link`, `mw_kanban_start` | Thin wrappers over `kanban task …` (the CLI's JSON replies), in `packages/cline-kanban`. |
| project | `mw_check`, `mw_trace`, `mw_doctor`, `mw_spec_list`, `mw_spec_propose`, `mw_roles`, `mw_mcp_add` | Owner-level operations, for an assistant (such as Hermes) acting for the owner. `mw_mcp_add` takes no `roles`: it writes the server with `roles: []`; attaching it to a role is the owner's (CLI `--roles`, the TUI, the file). |

Authority: the server runs as the owner. If `MW_ROLE` is set (the server was started inside a card
run) every write tool refuses with the `owner-only` message, like the CLI.

Concurrency: tool calls run concurrently, but every tool that changes files in the repository
(`mw_docs_write`, `mw_memory_add`, `mw_memory_state`, `mw_card_new`, `mw_card_set_status`,
`mw_spec_propose`, `mw_mcp_add`; `ToolDef.locked`) runs under one in-process lock
(`src/mcpserver/mutex.ts`), in the order the calls came. `mw_docs_write` validates first, then,
holding the lock, checks again the branch, the path and that the file's content hash is what it was
at validation; otherwise it writes nothing. `writeAtomic`/`writeAllAtomic` name their temporary
files `.<name>.<pid>.<counter>.<random>.tmp`. The lock is per server
process: two servers on one checkout, or the owner's own git commands, are not serialised by it.

Tests (`test/mcpserver.test.ts`): spawn `mw mcp serve` over stdio on a scratch project with mock
roles; `initialize` → `tools/list` lists every tool with a valid schema; each group has at least one
round trip (`mw_delegate` with the mock harness, `mw_card_new` then `mw_cards_list`,
`mw_docs_write` with the notebook unreachable queues the sync, `mw_memory_add` lands in
`memory/lessons`, the cline-kanban package's tools against a fake `kanban` on PATH that records its arguments); a
malformed request gets a JSON-RPC error and the server stays up; `MW_ROLE` set refuses writes.

## 4. The Hermes package (`mw hermes init|status|remove`, `runs: hermes`)

The official package `packages/hermes` (`index.mjs`, `SKILL.md`, `README.md`), installed with
`mw add hermes`; it was core code before. Without it, `mw check` refuses `runs: hermes` and
`mw hermes` says to run `mw add hermes`. It also provides the `hermes` harness (engine.md section
7), which runs its CLI through `host.agent` (docs/packages.md).

`mw hermes init [--shared] [--name N]`, run inside a project:

1. Registers the MCP server with Hermes as `mergewright-<project name>`: `hermes mcp add <name>
   --command mw --args mcp serve --project <abs root>` when `hermes` is on PATH; otherwise adds the
   same entry under `mcp_servers` in `$HERMES_HOME/config.yaml` (default `~/.hermes`). Either way a
   timestamped backup is written first, next to the real file (a symbolic link `config.yaml` is
   resolved with `realpath` before reading, backing up and renaming, so the link stays a link). Re-running updates the entry in place.
2. Installs the Hermes skill `mergewright` from the package's `SKILL.md` into `~/.hermes/skills/
   mergewright/` (`--shared`: a skills folder that a file-sync tool shares between machines).
   The skill explains the workflow, when to use which tool, and the rules (never commit, merge or
   push by hand; cards for changes; proposals for spec changes).
3. Prints what it did and what to check (`hermes mcp test <name>`).

`mw hermes status` shows the entry and the skill; `mw hermes remove` undoes both, except that
`--shared` never deletes the shared skill folder (other machines use it): it prints its path and
the command to remove it by hand.

Every config edit (and every `hermes mcp add|remove` MergeWright runs) holds the lock file
`config.yaml.mw-lock`, created with O_EXCL and holding the pid, time and a random nonce. A lock is
stale only when its process is gone or its mtime is older than 300 s; while the `hermes` CLI runs
(up to 180 s) a small keeper process refreshes the mtime every 20 s. A stale lock is taken over by
renaming it to `config.yaml.mw-lock.stale-<pid>-<random>` and then creating the lock with O_EXCL;
the loser of that rename waits (and puts back a fresh lock it moved by mistake). A live lock is
waited for up to 10 s. A process removes the lock on the way out only while it still holds its own
nonce. Under the lock the
config is read again and the edit applied to that text, so two `mw hermes init` runs never lose an
entry. If the file's size, mtime or content hash changes between that read and the rename (Hermes
itself writing, which does not take the lock), nothing is written, the backup is kept and the
command fails saying the file changed while MergeWright was editing it.

Tests (`test/packages-hermes.test.ts`; the lock in `test/regressions-hermes-config.test.ts`, `regressions-delegation`, `regressions-locking`): with `HERMES_HOME` pointing at a scratch folder and no `hermes` on
PATH, `init` writes the entry and the skill, is idempotent, keeps other entries and comments
(edited through the `yaml` document API), makes a backup, and `remove` leaves the file as it was
apart from the entry.

## 5. Packaging

`ops/` (the service unit) and `packages/` are in the single-executable asset manifest
(`scripts/build-binary.sh` embeds every file under them), so `mw add hermes` copies the package,
skill included, from the binary as from a checkout.

## 6. Out of scope here

A web UI; running delegated sub-agents in write mode; registering the MCP server with
Claude Code or Codex (they have their own `mcp add`; the server works with any client, and the
README shows the one-line commands).
