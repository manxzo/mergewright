# `mw tui`: the terminal UI

`mw tui` opens a full-screen view of the project in the current terminal: the board, the approvals
waiting for you, the packages, the roles and their models, the config and the MCP servers. It
changes the same files as the CLI, through the same functions, and it acts on cards through the
same tools as the browser GUI (`mw ui`) and the MCP server (`callToolStructured` in
`src/mcpserver/server.ts`: `mw_status`, `mw_card_get`, `mw_run_status`, `mw_card_set_status`,
`mw_retry`, `mw_approve`, `mw_packages`), so the three use the same data and the same words. It
needs an interactive terminal; without one it exits with code 2 and names the commands to use
instead (`mw config set <key> <value>`, `mw config unset <key>`, `mw mcp add|remove`, `mw doctor`).
It is the owner's tool: inside a card run (`MW_ROLE` set) it refuses.

The screen has a header (project name, specification version, the eight screens), a list on the
left, the detail of the selected row on the right, a message line and the key help. It is made to
work at 80 columns.

## Screens

| Screen | Shows | Does |
|---|---|---|
| Overview | project name, spec version, root; the local model endpoint and notifications as `mw doctor` probes them; cards by status; how many cards wait for you | nothing |
| Roles | every role: where it comes from (preset or project), `runs`, `provider`, `model`, `profile`, `mode`, `output`; values set in `mergewright.yaml` are marked | edits `runs`, `provider`, `model`, `profile`, written as `roles.<id>.<field>`; `e` ejects the role (copies the preset file to `roles/`) |
| Models | what the picker offers per harness: Claude aliases and full ids, Codex models, and the local endpoint's live model list (`GET <local_models.endpoint>/models`), or a short fallback list (`src/tui/catalog.ts`) when it cannot be reached. A package harness such as `hermes` has no list: its `model` and `provider` are free text | nothing |
| Config | every `cards`, `git`, `risk`, `limits`, `trace`, `local_models` and `report` key with the value in the file (or the default), its type and the schema's description; URLs without user, password or query string | edits any of those keys; a value is YAML (`3`, `true`, `[a, b]`), except for a plain string key (`git.base`, `local_models.endpoint`), taken as typed; "(unset)" removes it |
| Packages | each installed package: version, description, enabled and loaded or why not, what it exports, settings it still needs, the names of the variables it reads, and its health checks as `mw doctor` reports them; then each official package not installed, with its exports and the command `mw add <name>` | nothing. Installing is `mw add <name>` in a terminal: it shows the package's source and what it provides and asks before it installs, since a package runs with your rights |
| MCPs | every server: origin, transport, command or URL, roles, and the *names* of its env variables and headers | `a` adds one (the fields of `mw mcp add`), Enter changes its roles, `d` removes it (after `y`), `e` ejects a preset server |
| Board | the cards of `mw status` in the GUI's columns: To do, Ready, Running, Queued, Waiting for you, Blocked, Done (an aborted run is under Done) | see below |
| Approvals | the cards waiting at a stop point, with the word asked for (`go`, `conditions`, `merge`, or another the flow names); a card paused for usage is not one | `a` approves, after showing what |

**Board layout.** Seven columns do not fit side by side in 80 columns, so the board shows one
column at a time: the line under the header names every column with its count, the current one in
brackets (`To do 1 [Ready 1] Running 0 ...`). Left and Right change the column, Up and Down the
card. Enter opens the card in the right pane: its facts, its sections (the brief), its run (summary,
round, approvals given, phases, conditions of approval, warnings) and the list of its run files;
Up/Down (and PageUp/PageDown) scroll it, Esc closes it.

**Actions.** `r` sets a To do card ready (`mw_card_set_status`; a lint refusal is shown in the
message line). `R` retries a blocked or aborted card from its flow's default phase and starts the
run (`mw_retry` with `run`), after `y`. `a` on a waiting card shows what it approves (the card, the
word, phase, flow and risk, and the run's summary and conditions when the card is open) and asks;
`y` runs `mw_approve`, as `mw approve <id> <word>`. After an action the message line gives the
card's new state (`DEMO-2: running`) and the board is read again. `mw approve` has no refusal: to
stop a run that waits, use `mw abort` (or Abort in the GUI).

The board, the packages and their health checks are read when the TUI starts, after an action, and
on `p`.

## Keys

| Key | Does |
|---|---|
| Tab / Shift-Tab, 1-8 | next / previous screen, or jump to one |
| Left / Right | change screen, or move between the list and the fields; on the Board, change column |
| Up / Down | move in the list, the fields or the picker; scroll an opened card |
| Enter | edit the selected field (opens the picker); in the picker, stage the choice; on Board and Approvals, open the card |
| Esc | back (close the picker, the form or the opened card, leave the fields) |
| s | save every staged change |
| e | eject the selected role or MCP server |
| a / d | add / remove an MCP server; on Board and Approvals, `a` approves (after `y`) |
| r / R | Board: set ready / retry (after `y`) |
| p | probe the services again and re-read the board and the packages |
| ? | help |
| q | quit (asks first when changes are staged and unsaved); Ctrl-C quits without asking. Either way, keys stop being handled and every write already under way finishes first; one that fails then is reported after the TUI closes, with exit code 1 |

## Writes and validation

Config changes are staged (marked `* unsaved`) until `s`. Every config change is then written with
`setConfig`, the function behind `mw config set`: the result is checked against the config schema and
the project is re-checked in memory (roles and config, as `mw check` does) before the file is
written. A refused value is not written; `mergewright.yaml` is left exactly as it was, the
validator's message is shown, and the change stays staged so you can correct it. MCP servers are
added, changed and removed by the functions behind `mw mcp add|remove` (`src/mcpadd.ts`), with the
same checks (unknown roles, secrets written into the file). Ejecting uses `mw eject`'s function.
Board actions are not staged: they go to the tool layer when asked, with its checks and locks.

## Secrets

The TUI never shows a secret value. For MCP servers it shows only the names of `env` variables and
headers; in the add form the part after `=` is masked. For packages it shows the names of the
variables they read. URLs are shown without user, password or query string, and a URL is not put
back into the input when its key is edited. Tool output is already scrubbed of credentials by the
tool layer. Write `${VAR}` references in MCP env and headers; a literal secret is refused, as by
`mw mcp add`.
