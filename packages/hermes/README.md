# The hermes package

The official `hermes` package connects MergeWright and the Hermes agent both ways:

- **Hermes as the owner's assistant.** `mw mcp serve` is an MCP server (stdio, protocol 2025-06-18)
  that gives an assistant the whole MergeWright workflow as tools: delegation to sub-agents of
  other models, cards, runs, documentation, memory, and the tools of enabled packages.
  `mw hermes init` registers it with Hermes in one step and installs the `mergewright` skill
  (`SKILL.md` in this package).
- **Hermes as a harness.** A role can say `runs: hermes` (advisory only: `mode: advise` or `read`),
  and `mw_delegate` accepts `runs: hermes`. See "The hermes harness" below.

Install it in the project first; it was part of the core before:

```sh
mw add hermes             # shows what the package provides, asks, installs and enables it
```

Without it, `mw check` refuses a role with `runs: hermes` and `mw hermes` says to run
`mw add hermes`. The design is in [docs/design/tooling.md](../../docs/design/tooling.md),
sections 3 and 4; the package API in [docs/packages.md](../../docs/packages.md).

## Initialise

Run this inside the project, once per project and machine:

```sh
mw hermes init            # or --shared to put the skill in the shared skills folder (below)
hermes mcp test mergewright-<project>
```

`init` does three things:

1. Registers the server as `mergewright-<project name>` (`--name` to choose another name). The
   command is the `mw` on PATH (else this runtime: `node .../bin/mw.js`) with
   `mcp serve --project <absolute project root>`, so the server never guesses the project from a
   working directory. When the `hermes` CLI is on PATH this goes through `hermes mcp add` (Hermes
   connects to the server and enables all its tools), after the same backup; otherwise the entry is added under
   `mcp_servers:` in `$HERMES_HOME/config.yaml` (default `~/.hermes`), after a backup
   `config.yaml.bak-<time>` and without touching any other line of the file. Edits hold the lock
   file `config.yaml.mw-lock` (taken over, by moving it aside and creating a new one, only when its process is gone or it
   has not been refreshed for 300 s; a holder waiting on the `hermes` CLI refreshes it every 20 s,
   and a process removes the lock only while it still holds its own) and are
   applied to the config as read under the lock, so `init` in two projects at once keeps both
   entries. If the file changes between that read and the write (Hermes itself saving), nothing
   is written, the backup is kept, and the command says so: run it again.
2. Installs the `mergewright` skill (this package's `SKILL.md`) into `~/.hermes/skills/mergewright/`.
   The skill tells Hermes the workflow, which tool to use when, and the rules.
3. Prints what it did and the check to run. Running it again changes nothing unless the project
   moved, the runtime moved or the package was updated.

Hermes starts the server without the login session's environment, so it has no `SSH_AUTH_SOCK`,
and on a project whose hub is reached over SSH every tool that touches the hub would fail ("cannot
reach the hub"). Two things cover this. `init` writes the agent socket it finds into
the entry as `env: {SSH_AUTH_SOCK: <path>}`: `SSH_AUTH_SOCK` when it is set, else the first socket of
`ssh-agent.socket`, `keyring/ssh`, `openssh_agent`, `gcr/ssh` in `$XDG_RUNTIME_DIR` (or
`/run/user/<uid>` when that is unset); with none it says so and writes no `env`. And every git
command the runtime runs without `SSH_AUTH_SOCK` looks for the same sockets itself. `mw hermes
status` prints the socket the entry sets (and this shell's, when they differ), and `mw doctor`
prints an `ssh` line: `agent: <path> (N keys; ...)`, or `agent: none found`.

After a package update the installed skill may be older than the shipped one. `mw doctor` prints a
`hermes skill` and a `hermes shared skill` line; when a copy (`~/.hermes/skills/mergewright/SKILL.md`
or `~/.hermes/shared-skills/mergewright/SKILL.md`) differs from the package's, its line says
`NOT ok`, names the copy and says "run 'mw hermes init [--shared]' to update it", which rewrites
it. Inside a card run (`MW_ROLE` set) `mw hermes` refuses: changing the Hermes configuration is
the owner's.

`config.yaml` may be a symbolic link (to a synced folder, say): MergeWright follows it, so the
backup sits next to the real file and the edit replaces that file, not the link.

`mw hermes status` shows the entry, the SSH agent socket it gives the server, and where the skill is installed. `mw hermes remove` removes the
entry (after a backup, through `hermes mcp remove` when the CLI is on PATH) and, when no other
MergeWright project is registered, the skill in `~/.hermes/skills`. `mw hermes remove --shared`
never deletes the shared skill folder, because other machines may use it: it prints the folder's
path and the `rm -r` to run by hand once no machine needs it.

The shared skills folder is for a skills folder that several machines share, kept in step by a
file-sync tool of your choice. It is `$HERMES_HOME/shared-skills` (`~/.hermes/shared-skills`) unless
the environment variable `MW_HERMES_SHARED_SKILLS` names another folder; point Hermes at it as one
of its skills folders. Start a new Hermes session
(or `/reload-mcp`) after either. The secrets the server needs (the keys of enabled packages such as mem0, letta and open-notebook)
come from `~/.config/mergewright/env`, as for every `mw` command; the Hermes config holds none.

## What Hermes then has

31 core tools in seven groups (plus those of enabled packages). Every tool name starts with `mw_`; Hermes shows them prefixed with the
server name. Results are text or JSON; an error is a tool result with `isError` and a message that
says what to do, never a dropped connection. Secret values are blanked from every result.

| Group | Tools | Example |
|---|---|---|
| delegate | `mw_delegate`, `mw_review` | `mw_review {"range": "main..feature", "deep": true}`: Codex GPT-5.6 Sol (`reviewer-deep`) reviews the diff and returns findings |
| cards | `mw_cards_list`, `mw_card_get`, `mw_card_new`, `mw_card_set_status`, `mw_status` | `mw_card_new {"title": "Retry failed uploads", "kind": "fix", "scope": ["src/upload/**"]}` |
| runs | `mw_run_start`, `mw_run_status`, `mw_approve`, `mw_retry`, `mw_abort` | `mw_run_start {"id": "DEMO-4"}` returns the pid at once; `mw_run_status {"id": "DEMO-4"}` follows it |
| docs | `mw_docs_write`, `mw_docs_search`, `mw_docs_ask` and `mw_docs_sync` (with the open-notebook package) | `mw_docs_write {"path": "docs/guides/uploads.md", "content": "# Uploads\n...", "title": "Uploads guide"}` commits `docs: Uploads guide` and syncs it to Open Notebook |
| memory | `mw_memory_add`, `mw_memory_push`, `mw_memory_search`, `mw_memory_state`, `mw_mem0_add` and `mw_mem0_search` (with the mem0 package), `mw_letta_add` and `mw_letta_search` (with the letta package) | `mw_memory_add {"kind": "lesson", "topic": "testing", "title": "Fake the clock", "body": "..."}` writes `memory/lessons/testing.md` and the index, commits them as `memory: Fake the clock`, and stores the lesson in mem0 and Letta when configured; `mw_letta_search {"query": "how do we test the clock"}` searches the project's Letta agent |
| kanban (with the cline-kanban package) | `mw_kanban_list`, `mw_kanban_get`, `mw_kanban_create`, `mw_kanban_update`, `mw_kanban_done`, `mw_kanban_delete`, `mw_kanban_link`, `mw_kanban_start` | `mw_kanban_create {"title": "Renew the TLS certificate"}` |
| project | `mw_check`, `mw_trace`, `mw_doctor`, `mw_spec_list`, `mw_spec_get`, `mw_req_get`, `mw_spec_propose`, `mw_roles`, `mw_mcp_add` | `mw_spec_propose {"spec": "auth", "summary": "Lock accounts after 5 failures", "body": "## add\n### REQ-auth-009 ..."}` |
| views | `mw_run_file`, `mw_packages`, `mw_settings` | `mw_run_file {"id": "DEMO-4", "name": "brief.json"}` returns the run's brief |

Notes on each group:

- **delegate.** `mw_delegate` takes a `task` and either a `role` id (any project or preset role,
  see `mw_roles`) or an ad-hoc role (`runs`: claude, codex, hermes or local, plus `model` and
  `provider`). `output` is `text` or a structured kind (`findings`, `brief`, `adjudication`), which
  is validated against its schema with one retry, as in a card phase. With `card` (a card id) the
  role's prompt is rendered with that card's full context, as its brief phase would see it (the
  card, its requirements with their acceptance criteria, memory, docs): `role: planner, card:
  DEMO-1` checks a card before it is readied; without `card`, `{{card}}` and `{{requirements}}`
  read "(none: not a card; the task text is the whole request)". Every delegation, like every card
  phase, has the project's `memory/STATE.md` and `memory/RULES.md` in its prompt, so what it says
  about the project's state is grounded in them. The run's prompt and reply
  are kept under `.mergewright/local/delegate/<time>-<label>-XXXXXX/`, a folder of its own for
  every call (two calls at once never share one). `mw_review` reviews
  `git diff <range>` (default: uncommitted changes) or a given diff with `reviewer` (GPT-5.6 Terra),
  `reviewer-deep` with `deep: true`, or another `role`/`model`.
- **cards.** `mw_card_new` adds the project's `docs.paths` to the card's scope; its `no_docs` is
  only for a card that must not touch documentation, and the skill never passes it otherwise.
  `mw_card_new` and `mw_card_set_status` commit the card file alone (`card: <ID> <title>`,
  `card: <ID> ready`) on the base branch, and refuse, writing nothing, on a checkout that is not on
  it, or when git has no identity to commit with (`git/identity`: set `git config user.name` and
  `git config user.email`; `mw doctor` shows it on its `git` line). Changes the owner has staged for
  other files stay staged and out of the commit. If the commit still fails, the file is put back as
  it was and unstaged (`mcp/commit` says nothing was kept). On a project with a hub, the tool takes
  part in the lease protocol and the commit lands on the hub. The same holds for the memory and
  docs tools below.
- **runs.** A run can take an hour, so `mw_run_start` and `mw_approve` start `mw run` / `mw approve`
  in the background (output in `.mergewright/local/runs/<ID>.log`). They wait a little for it:
  `mw_approve` up to 20 s, `mw_run_start` up to 10 s. A process that exits non-zero
  in that time is an error carrying the end of its log; `mw_approve` returns the run's new phase
  once the run has left the stop point, `mw_run_start` where the run is once its state is written;
  otherwise the reply says the run continues in the background, with its pid and log. When that
  `mw run` or `mw approve` returns with the run waiting at a stop point, it releases the lease:
  the stop point is in the run state, and the `mw approve` that answers it, on
  either machine, takes the lease again.
- **requirements.** `mw_spec_get <spec>` returns every requirement of a spec, `mw_req_get <REQ id>`
  one, each with its title, priority, rev, status, acceptance criteria (full text) and the cards
  implementing it; `mw_card_get` adds a `requirements` section with the criteria of what the card
  implements. Read them before readying a card.
- **docs.** The repository is the source of truth; Open Notebook is its index. `mw_docs_write`
  accepts only paths under `docs.paths`, refuses protected paths (`docs/adr/**` by default) and a
  checkout that is not on the base branch, commits the one file, and queues the notebook sync on
  this machine when the notebook is down (`mw queue flush` retries it).
- **project.** `mw_mcp_add` writes the server with `roles: []`: no role gets it until the owner
  attaches it (`mw mcp add ... --roles`, the TUI's MCPs screen, or the `roles:` line of the file).
  Which roles run a server, with which credentials, is a separate trust decision.
- **Concurrent calls.** The tools that change the repository (`mw_docs_write`, `mw_memory_add`,
  `mw_memory_state`, `mw_card_new`, `mw_card_set_status`, `mw_spec_propose`, `mw_mcp_add`) run one at
  a time. `mw_docs_write` refuses, writing nothing, when the file changed while it waited.
- **memory.** `mw_memory_add` and `mw_memory_state` change the project's `memory/` folder and
  commit the files they wrote alone (`memory: <title>`, with `memory/INDEX.md`; `memory: state`),
  under the same rules as the card tools; `mw_memory_add` also stores the entry in each configured store
  (packages such as mem0 and letta) (not again when a store already holds it) and says where it went.
  `mw_memory_push` sends every lesson and decision in `memory/` to the stores, idempotently, and
  returns the counts per store (stored, already present, queued, failed). `mw_mem0_*` (with the mem0 package) read and write free memories in mem0 (the project's namespace
  unless `user` is given; `mw_mem0_add` stores the text verbatim unless `infer: true`, and says so
  when mem0's extraction stored nothing); `mw_letta_*` (with the letta package) do the same in the archival memory of the project's Letta
  agent (`<packages.letta.agent>-<project>`, created on first use).
- **kanban.** Thin wrappers over `kanban task ...` with the project's path as the board knows it
  (`packages.cline-kanban.path`, default the project root) as the workspace; they come with the
  cline-kanban package. The
  board's runtime must be reachable from the machine the server runs on (`KANBAN_RUNTIME_HOST`,
  `KANBAN_RUNTIME_PORT`; default 127.0.0.1:3484); otherwise the tools answer with that error.

## Hermes on a Claude Code login

Hermes can borrow the machine's Claude Code login instead of a login of its own. In Hermes's
`config.yaml`:

```yaml
model:
  provider: claude-code
  default: claude-sonnet-5
```

With `auth.adopt_external_logins` (on by default) Hermes then reads `~/.claude/.credentials.json`,
the file `claude login` writes, and needs no `hermes auth login`. Two things to know:

- `openai-codex` does not reuse `~/.codex/auth.json`: a Codex provider needs Hermes's own login.
- `hermes auth status anthropic` says "logged out" even while the borrowed login works: check with
  a real query (`hermes chat -Q --oneshot "say ok"`) instead.

Whatever the model, run Hermes with `-t mergewright-<project>` for MergeWright work, so only this
project's tools load and unrelated MCP servers do not start.

## Readying cards

The skill tells Hermes to check a card before `mw_card_set_status <id> ready` (or `mw_card_new`
with `status: ready`), because `mw work` then starts it unattended:

- everything the work needs is in the card or the repository (no number, credential, external
  value or owner decision only the owner has);
- every acceptance criterion can be met inside the card's `scope`;
- no protected path is needed unless the card lists it in `allow_protected`.

When unsure, Hermes asks the planner first (`mw_delegate` with `role: planner`, `card: <ID>`,
mode `advise`, output `brief`, so the planner sees the card's requirements and acceptance
criteria) and readies the card only when the brief says `ready: true`; when the planner would
refuse, it reports the blockers to the owner instead. Setting a card back to `todo` or `ready`
while its run is blocked or aborted aborts that run (branch kept) and moves its record aside to
`.mergewright/local/discarded/<ID>-run-<time>`, so the card file, `mw_status` and the board agree.

A run can stop at `conditions` before the merge: the adjudicator approved, on conditions to meet
first (`mw_run_status` lists them, and they are in the notification). Hermes reports them; the
owner meets them and approves (`mw approve <ID> conditions`, or `mw_approve` when the owner says
so). Follow-ups the adjudicator names become `todo` cards after the merge (the reflect phase's
detail names them).

## Hermes on a machine without a login

Hermes can drive the tools with a small local model when the machine has no subscription login
(a remote development box, say, with Ollama on another machine of the network). Three things make it work:

1. **A user-defined provider** in Hermes's `config.yaml`, pointing at Ollama's OpenAI-compatible
   endpoint:

   ```yaml
   providers:
     ollama-lan:
       name: ollama-lan
       api: http://HOST:11434/v1
       transport: chat_completions
       default_model: qwen3.5:9b-64k
       models:
         qwen3.5:9b-64k:
           context_length: 65536
   ```

2. **A 64k context on the Ollama side.** Ollama's `/v1` endpoint silently truncates every request
   to the model's `num_ctx`, 2048 tokens by default, which cuts off the tool list and the system
   prompt without an error. Make a model tag with the larger context, on the Ollama host:

   ```bash
   printf 'FROM qwen3.5:9b\nPARAMETER num_ctx 65536\n' > Modelfile
   ollama create qwen3.5:9b-64k -f Modelfile
   ```

   or start the Ollama server with `OLLAMA_CONTEXT_LENGTH=65536` (then every model gets it). The
   `context_length` in the provider block only tells Hermes what to expect; it does not change
   Ollama.

3. **Only this project's tools.** Run Hermes with `-t mergewright-<project>` so it loads only this
   server's toolset; a small model picks the wrong tool more often the more tools it sees.

A 9B model is usable for this but not reliable: it misnames tools and drops arguments. Name the
tools exactly in the prompt (`call mw_card_set_status with {"id": "LL-100", "status": "ready"}`),
one step at a time, and check each reply. Delegation (`mw_delegate`, `mw_review`) and anything
long are better left to a machine with a subscription model.

## What the assistant can and cannot do

The server runs as the owner, but it is not the owner: it can do the owner's routine paperwork,
start the work, and nothing that only the owner decides.

| | Tools | Notes |
|---|---|---|
| Reads | `mw_cards_list`, `mw_card_get`, `mw_status`, `mw_run_status`, `mw_docs_search`, `mw_docs_ask`, `mw_memory_search`, `mw_mem0_search`, `mw_letta_search`, `mw_kanban_list`, `mw_kanban_get`, `mw_check`, `mw_trace`, `mw_doctor`, `mw_spec_list`, `mw_spec_get`, `mw_req_get`, `mw_roles`, `mw_run_file`, `mw_packages`, `mw_settings` | Change nothing. Paths stay inside the project: a symbolic link that leads out of it is refused. |
| Advice | `mw_delegate`, `mw_review` | Delegated agents advise or read; they never write (see below). |
| Writes that commit | `mw_card_new`, `mw_card_set_status`, `mw_memory_add`, `mw_memory_state`, `mw_docs_write` | Each commits the files it wrote, alone, on the base branch, and refuses on another branch. On a project with a hub it holds the lease (refused with `lease/held` while the other machine drives), adopts the hub first and pushes the commit to it. |
| Writes the owner finishes | `mw_spec_propose` (the owner accepts with `mw spec accept`), `mw_mcp_add` (written with `roles: []`; the owner attaches it to roles), `mw_run_start`, `mw_approve`, `mw_retry`, `mw_abort` (a run stops where its flow asks the owner), `mw_docs_sync`, `mw_memory_push`, `mw_mem0_add`, `mw_letta_add`, `mw_kanban_*` writes | They start or prepare work; the decisions stay the owner's. |
| Never | merge, push, take or release a lease, change product code, `mw config set`, attach an MCP server to a role, accept a spec change | Product changes are cards and go through their flow; merging happens there, at the stop point the owner approves. Inside a card run (`MW_ROLE` set) every write above refuses too. |

## The delegation rule

Delegated agents only advise or read. `mode: advise` starts the agent in an empty folder made for
it in the system temp folder, outside the project, and removed afterwards, with the harness's
no-tools setting (Claude Code gets no tools; Codex runs with `-s read-only`); `mode: read` starts it
in the project (or `cwd`, which must resolve, through any symbolic link, to a folder inside the
project) and changes nothing (Claude Code gets only its read tools, Codex runs with `-s read-only`,
Hermes and local models get no tools at all). A delegated run never gets MCP servers, whatever the
role lists, and never the role's extra harness arguments (`args`) or `command`: those can widen
what the agent may do and are for the card phases the owner configured.

**The limit.** These boundaries are the harnesses' own settings and the starting folder; there is
no OS-level sandbox. Bubblewrap cannot create a user namespace on these machines (AppArmor), so a
read-mode delegate can read what the owner's account can read, inside or outside the project (a
Codex read-only sandbox blocks writes, not reads), and an advise-mode Codex delegate could still
read files by absolute path. Do not delegate to a model you would not let read your home folder;
an allowlist sandbox is an open owner decision ([design/engine.md](design/engine.md), known
problems).
A role with `mode: write` is refused: work that changes files is a card (`mw_card_new`, then
`mw_run_start`), so scope, gate, review and merge evidence apply to it. "The model advises, the
runtime acts" ([design/engine.md](design/engine.md), section 1).

The delegated process gets `MW_ROLE` set, like an agent in a card phase, so the `mw` commands that
are the owner's refuse inside it. The server itself runs as the owner; started inside a card run
(`MW_ROLE` set), every tool that writes refuses with the `owner-only` message.

## Claude Code and Codex

The server works with any MCP client. Register it the same way, with the project's absolute path:

```sh
claude mcp add mergewright -- mw mcp serve --project /path/to/project
codex mcp add mergewright -- mw mcp serve --project /path/to/project
```

Claude Code's `--scope project` writes the entry to the project's `.mcp.json` instead of your user
settings. Neither client gets the Hermes skill; point it at this page or at this package's
`SKILL.md`.

## The hermes harness

`runs: hermes` runs one Hermes query per phase:
`hermes chat -Q --oneshot --ignore-rules -t todo --query-file <run folder>/<label>.hermes.prompt.md`,
then `-m <model>`, `--provider <provider>` and `--max-turns <turns>` when the role sets them,
`--source tool` (keeps these runs out of the owner's session list), and the role's `args`. The
prompt is self-contained (`--ignore-rules`: no AGENTS.md, memory or skill injection). `-t todo` is
the smallest toolset without terminal, file, web or MCP tools, so even a `read` role gets no file
access; a role widens it with `args: [-t, ...]` (the last `-t` wins). Hermes uses the MCP servers in
its own configuration, never the project's: `mw check` warns about servers offered to a role on
this harness, and the engine gives a package harness none. The reply is the output without the
trailing `session_id:` lines. Hermes reports no token usage. `HERMES_HOME` reaches the agent when it
is set.

The runtime keeps its protections for this harness as for the built-in ones (the package runs the
CLI through `host.agent`): the hard timeout of `limits.minutes` (the process group stopped), abort,
the output streamed redacted to `<label>.hermes.stdout|stderr` in the run folder, and the shared
table that marks a failure transient (retried) or a quota (the run pauses for usage). It counts as a
paid harness for the usage guard.

Providers Hermes chooses between (`--provider`): `openai-codex`, `anthropic`, `openrouter`, `nous`,
`custom`. On a ChatGPT login it runs the Codex models (`gpt-6-astra-900k`, `gpt-6-astra`,
`gpt-5.6-sol`, `gpt-5.6-terra`); `claude-opus-5-5` and `claude-sonnet-5-5` through `anthropic`.
