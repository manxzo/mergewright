# Engine design (contract for implementers)

> **Status of this document.** This is the original design contract, written before the engine,
> the hub and the integrations were built. It is kept as the record of what was agreed and why.
> The implementation departed from it in places, mostly to close races and crash windows that
> review found. The reference is [`docs/specification.md`](../specification.md): where the two
> differ, the specification is right.

This is the agreed design for running a card through a flow, coordinating two machines, and
talking to external services. Stages 1 and 2 (conventions, parsers, `check`, `trace`, managed
updates) are built and tested; read `src/` before writing anything. Interfaces named here are
frozen in `src/engine/types.ts`.

Principle that decides every doubt: **models produce files in defined formats; only the runtime
performs side effects** (commits, merges, pushes, card and memory changes, notifications).

## 1. Run state

One run per card, stored in `.mergewright/runs/<CARD>/` (git-ignored working data):

| File | Content |
|---|---|
| `state.json` | `RunState` (see types): flow id, phase index, round, status, approvals, history, vars |
| `brief.json` `handoff.json` `findings.json` `adjudication.json` `reflection.json` `gate.json` | Latest artifact of each kind, validated against `schemas/output.*.schema.json` |
| `phases/<n>-<phase>[-<role>].prompt.md` and `.output.txt` | Exactly what was sent and received, for audit |
| `gate-logs/` | Gate step logs |
| `<label>.<harness>.stdout` and `.stderr` | Raw agent output; `mw work` deletes them once the run is `done` or `aborted` and they are older than `trace.raw_days`, holding the card's run lock and skipping a card whose lock a live process holds |
| `lock` | `{pid, host, started}`; a second `mw run` for the same card refuses while the pid is alive on this host |

`status`: `running` | `waiting` (stop point, needs `mw approve`) | `blocked` (needs the owner) |
`done` | `aborted`. `mw run` on a `waiting` run re-prints what it waits for; on `blocked` it
retries the blocked phase (the owner fixed something); on `done` it says so.

A card file's `status` field changes only once, to `done`, inside the squash commit (section 5).
Until then the live status is the run state; `mw status` shows run state when a run exists, except
that a `running` run no live process drives reads `queued`.

## 2. The loop

```
load or create state; acquire lock; hub.prepare() (lease + sync, section 8); ensure worktree
while phase := flow.phases[state.phase]:
    vars := compute (section 3)
    if phase.when and not eval(phase.when, vars): record "skipped"; advance; continue
    for stop in stopsOf(phase):              # declared, plus `conditions` on a merge phase and,
                                             # for a high/critical card, `go` and `merge`
        if eval(stop.when, vars) and "<phase.id>:<stop.ask>" not in approvals:
            status = waiting; save; notify; return
    for n in phase.needs: the artifact that phase produced must exist, else blocked
    outcome, detail := execute(phase)            # section 4
    record history entry {phase, role(s), outcome, seconds, usage, detail}
    if outcome == ok: advance
    else route by (phase.on[outcome] or "stop"):
        "continue"  -> advance
        "stop"      -> status = blocked (reason = detail); save; notify; return
        "remediate" -> if round >= max_rounds: blocked ("remediation budget spent")
                       else round += 1; state.remediation = detail; state.phase = index(flow.remediate.phase)
        <phase id>  -> state.phase = index(that phase)
    save state after every phase
when phases are exhausted: status = done; remove worktree if the branch was merged; notify
```

`max_rounds` = `flow.remediate.max_rounds` ?? `config.limits.rounds`. `--until <phase>` stops
before that phase with status `running`. `--dry-run` prints the phases that would run, with each
role's harness and model and the rendered prompt sizes (estimated tokens), and executes nothing.

## 3. Condition variables

| Variable | Value |
|---|---|
| `risk` | The higher of the card's risk (or `config.risk.default`) and `brief.risk` when a brief exists |
| `kind` | Card kind |
| `deep_review` | `card.deep_review` or `brief.deep_review` |
| `round` | 0 on the first pass, +1 per remediation |
| `findings.total`, `findings.blocking` | From the latest `findings.json`; absent before a review ran |
| `gate.ok` | From the latest `gate.json`; absent before a gate ran |
| `gate.skipped`, `gate.skipped_names` | The latest gate's steps marked `skipped` (count, names); absent before a gate ran |
| `adjudication.conditions`, `adjudication.follow_ups` | Counts from the latest adjudication when it approves; absent otherwise |

## 4. Executing a phase

A phase has a `gate`, or a `role` (optionally `also` roles and an `action` that consumes the
role's output), or only an `action`.

**Gate phase.** Run the gate executable with cwd = the worktree (or the project root when the flow
has `worktree: false`), env `MERGEWRIGHT_GATE_JSON=<run>/gate.json`, `MERGEWRIGHT_GATE_LOGS`,
`MERGEWRIGHT_BASE=<base branch>`, timeout `config.limits.minutes`. Exit 0 = `ok`; otherwise
`fail`, with detail = the failing steps and the last 40 lines of each failing step's log. A gate
that writes no JSON still counts by exit code (`gate.json` is then synthesised).

**Role phase.** For the phase's role and each `also` role whose `when` is true (run sequentially):

1. Render the role prompt (section 6) and save it.
2. Run the harness (`HarnessRequest` → `HarnessResult`).
3. If the role's output is not `text`: extract JSON from the reply (`extractJson`), validate
   against the output schema. If invalid, retry **once**, appending the validation errors to the
   prompt. Still invalid → outcome `fail` with detail naming the errors.
4. Save the artifact. Findings from several reviewers are merged into one `findings.json`, each
   finding's id prefixed with its reviewer's role id (`reviewer:R-01`).
5. Outcome by output kind:
   - `brief`: `ready: false` → `block` (detail = blockers). `scope` not inside the card's scope →
     `block`. Otherwise `ok`.
   - `handoff` (write-mode role): first the runtime commits (below). `status: blocked` → `block`.
     Scope violation → `fail`. Otherwise `ok`.
   - `findings`: always `ok` (later phases read `findings.blocking`).
   - `adjudication`: `approve` → `ok`, `reject` → `reject` (detail = instructions + accepted
     finding texts), `block` → `block`.
   - `reflection`: `ok` (then the phase's `memory.update` action applies it).
   - `text`: `ok`.
   A harness that fails outright (non-zero, timeout, no output) → `fail`.
   A **transient** failure (REQ-harness-001..003) is not final: `classified()` in
   `src/engine/harness/transient.ts` is the one table every harness (`codex`, `claude`, `local`,
   a package's through `host.agent`, and `exitFailure()` in `proc.ts`) marks its result with: capacity or overload, HTTP 429
   or 5xx, a provider request timeout, a reset connection. Quota and session limits are checked
   first and come back as `quota` (with the stated reset time), never transient; a 429 is a quota
   only when `quotaResetAt()` reads a real reset time from it ("try again later" stays transient; a clock
   time is read in the zone the provider states, such as `(Europe/Berlin)`, `UTC` or `GMT`, through
   `Intl.DateTimeFormat`, and in this machine's zone when none or an unknown one is stated); authentication
   errors, a missing CLI, missing output, scope violations and the runtime's own `limits.minutes`
   kill are never classified. `invokeRole()` wraps step 2-3 (the attempt with its one schema retry)
   in an outer loop: a transient attempt is tried again on the same model after an abortable wait
   (5 s, 15 s, 45 s; base `MW_TRANSIENT_BACKOFF_MS`) up to `limits.transient_retries` (default 2),
   then once on the role's `fallback_model` (role file, overridden by `roles.<id>.fallback_model`).
   These attempts spend no remediation round and no schema retry; usage sums every attempt; the
   phase record's `model` is the model that answered and the history detail counts the retries.
   When the last attempt is also transient the phase is `block` with `harness/transient`, naming each
   model and the last error. The wait listens to the phase signal, so a stop or a lost lease ends it
   and no attempt follows. Every attempt, the first included (transient retry, fallback, schema retry
   too), checks the signal and then asks `refusedAttempt()`: a recorded quota for the harness, a
   refusal of the usage guard (`usageGuard(integrations, [role.runs])`, the engine's and `mw_delegate`'s,
   asked for a role on a paid harness, whatever its mode), or a signal that fired while the guard was asked ends the
   invocation with `quota`, `usagePause` or a stop, and starts no attempt. A refused first attempt is
   `notStarted`: `rolePhase()` then pauses for usage before the role ran and asks nothing itself, so
   the guard is asked once per attempt. `delegate()` maps every `usagePause`, a refused schema retry's
   included, through one helper (`usageRefusal()`) to the same message and code (`delegate/usage`) as
   its own refusal before the first attempt. A `quota` result records the reset time in
   `.mergewright/local/usage-limits/<harness>/` (`src/engine/quota.ts`; one folder per harness and
   one record file per report, each written atomically, with no lock; readers take the latest reset
   across the records, so concurrent or slow reports never lose a later reset or another harness's
   limit; a report removes passed records and records strictly earlier than one it read, never the
   latest) and pauses the run for usage
   (`waiting`, reason `usage`) without a round; until the reset, a phase that would start a role on
   that harness pauses at once, `mw_delegate` is refused with `delegate/usage`, and `mw work`'s pass check
   (`activeQuotas()` in `src/work.ts`) takes no new card.

**After a write-mode role**, in the worktree: `git add -A`; if anything is staged, commit with
message `<CARD>: <handoff.summary first line, max 72 chars>` (or `<CARD>: work in progress (<phase>)`
when there is no valid handoff). Then check scope: every path in
`git diff --name-only <base>...HEAD` must match the effective scope (the brief's `scope` when a
brief exists, else the card's), and a path matching `config.protected` must also match the card's
`allow_protected`. `cards/<CARD>.card.md` is always exempt (the runtime edits it). A violation is
outcome `fail` with detail listing the offending paths and telling the worker to revert them.
After any phase that created commits, `hub.pushBranch(branch)`.

**Actions.**
- `merge`: section 5.
- `memory.update`: apply `reflection.json` with `applyReflection` in the **main checkout**, then
  commit only `memory/` on the base branch (`<CARD>: update project memory`), `hub.pushBase()`,
  and `integrations.remember(lessons)`, which only queues them (`enqueueMemory`, one item per memory store an enabled package provides, e.g. the `mem0` and `letta` packages, held for this
  process, no request); this process's `flushQueue` after the card (between cards in
  `mw work`; after the release in `mw run` and `mw approve`) clears those holds first and
  delivers them. A store whose item could not be written makes `remember` throw, and `safely` records it as a
  warning. An over-long state (MwError `memory/too-long`) → rerun
  the role once with the error appended; still too long → apply everything except the state, and
  record a warning in history. Never blocks the run.
- `docs.sync`: `integrations.docsSync(changed, deleted)` for files of the merge matching
  `config.docs.paths`. Failures are queued by the integration, never an outcome other than `ok`.
- `notify`: `integrations.notify(...)`.

## 5. Worktree, branch, merge

- Branch `card/<CARD>`, worktree `.mergewright/worktrees/<CARD>`, created from the base branch
  (`hub.fetchBranch` first: if the hub already has `card/<CARD>`, start from it; that is how a
  second machine continues a card). An existing directory that is not a registered worktree of
  this repository (a synced copy from another machine) is removed and recreated.
- `mw run` requires the main checkout to be on the base branch.
- **Merge** (forge `none`): in the worktree, set `status: done` in `cards/<CARD>.card.md`
  (creating the edit as part of the branch) and commit. The same step runs before a forge merge.
  REQ-engine-010: `markCardDone()` in `src/engine/actions.ts` (shared by the local and
  the forge merge) reads the card file with `mergeCardText()` in `src/engine/gitops.ts`; only when it
  is absent in the worktree (ENOENT, a branch made before the project used MergeWright) is it taken
  from the base branch by `showOnBase()` (`git show refs/heads/<base>:cards/<CARD>.card.md`, the one
  base read, also used by the scope check), written into the worktree with `status: done` (the
  `cards/` folder is created) and committed as the runtime commit. Any other failure to read, write
  or commit it, and a base without the card, throws `PhaseBlocked` (`merge/card-file`), naming the
  file and `mw run <CARD> --from merge`. `PhaseBlocked` is not routable: the loop in
  `src/engine/run.ts` records it as the phase's `block` outcome and ends the run through `block()`
  whatever the phase's `on` says, so the lock and lease are released as for every blocked run. When the branch forked before the card
  was on the base, both sides add the card file, so the squash below meets an add/add conflict on it;
  `squashTree()` in `src/engine/gitops.ts` resolves that one case in favour of the branch (the blob is
  put into the merged tree with `git mktree`), but only when the card file is the sole conflicted
  path, the conflict is `add/add`, and the branch's text is the base's text with `status: done`.
  Every other conflict keeps the message below. The re-gate squash (section 8a) and the check of a
  recorded merge on resume build the tree the same way, so they agree with the merge. The scope
  check (`runtimeCardEdit()`) compares a card file the fork point lacks with the base's. The merge
  evidence (`markDoneOnly()` in `src/engine/run.ts`) does not, so a retry after such a branch got
  its card commit asks for `--from gate`. Then build a squash commit without
  touching any checkout: `git merge-tree --write-tree <base> <branch>` (conflict → outcome `fail`,
  detail = conflicted paths, so the flow can remediate), `git commit-tree <tree> -p <base>` with
  message `<CARD>: <card title>` plus a body (brief summary, reviewers, rounds). Then, if the base
  branch is checked out in a worktree (normally the main checkout): `git merge --ff-only <commit>`
  there (git refuses if local edits would be overwritten → outcome `fail`, nothing lost);
  otherwise `git update-ref`. Then `hub.pushBase()`, delete the card branch locally and
  `hub.deleteBranch`, remove the worktree. Record the commit in state (`merged`).
- Forge `gitea`/`github` (integration, section 7): push the branch, open or find the PR, merge it
  by squash through the API, then fetch and fast-forward the base. Same outcome mapping. Then the
  forge check (section 8a): the forge's commit must have the re-gated base as its first
  parent and the gated tree plus only the card's status line, or the run blocks.
- `mw abort <CARD>`: status `aborted`, remove the worktree, keep the branch unless `--force`.

## 6. Prompt variables

`renderPrompt(role.prompt, values)`. Every value is plain text or markdown; absent = empty string.

| Variable | Content |
|---|---|
| `project.name`, `project.description` | From config |
| `card` | The card: id, title, kind, risk, scope, depends, then allow_protected, docs and implements (each only when the card sets it), then its body |
| `card.id` `card.title` `card.kind` `card.risk` `card.scope` | Single values (`scope` comma-separated) |
| `requirements` | For each implemented requirement: `### id title`, priority, rev, criteria lines |
| `brief` | `brief.json` rendered as short markdown (summary, approach, scope, acceptance, guards, docs) |
| `handoff` | Rendered markdown of `handoff.json` |
| `findings` | One line per finding: id, severity, blocking, file:line, title, then detail |
| `gate` | Pass/fail per step; for failures the last 40 log lines |
| `adjudication` | Verdict, summary, instructions |
| `diff` | `git diff <base>...HEAD` preceded by `--stat`, clipped to `config.limits.diff_chars` with `clip()` |
| `changed` | `git diff --name-only <base>...HEAD`, one per line |
| `memory.state` `memory.rules` `memory.index` | The three always-loaded files |
| `memory.recall` | Up to 5 hits from `searchMemory(card title + requirement titles + scope)` plus `integrations.recall`, as `- title: first paragraph` |
| `round` | Remediation round number |
| `remediation` | The detail that sent the run back (gate failure, scope violation, adjudication instructions); "(first pass)" on round 0 |
| `protected` | `config.protected`, comma-separated |
| `branch`, `base` | Branch names |
| `docs` | Card `docs` plus brief `docs`, comma-separated, or "(none listed)" |

Token discipline: nothing else is injected. A role that does not use a variable does not pay for it.

## 7. Harnesses and integrations

`Harness.run(req)` (see types). The registry (`src/engine/harness/index.ts`) maps `runs:` to an
implementation. All harnesses: run in `req.cwd`, enforce `req.limits.minutes` as a hard timeout,
write nothing outside `req.runDir` themselves, and receive a **minimal environment** (PATH, HOME,
USER, LANG, TERM, TMPDIR, XDG_RUNTIME_DIR, plus `req.env`, which carries `MW_ROLE`, `MW_CARD`,
`MW_MODE`, `MW_RUN_DIR` and any variables an MCP server needs).

| `runs` | Command | Notes |
|---|---|---|
| `mock` | none | Scripted replies and file edits for tests: env `MW_MOCK_SCRIPT` points at a JSON file `{ "<role>": [ {"writes": {"path": "content"}, "deletes": ["path"], "output": <object or string>, "fail": true?}, ... ] }`. Call n of a role uses entry n (the last entry repeats). Counters live in `<runDir>/mock-counters.json`. |
| `shell` | `sh -c <role.command>` | Prompt on stdin; stdout is the reply. Env adds `MW_PROMPT_FILE`, `MW_OUTPUT_SCHEMA` (path), `MW_MCP_CONFIG` (path, when servers apply). The escape hatch for any other agent CLI. |
| `claude` | `claude -p --model <m> --output-format json [--json-schema <schema>] --permission-mode dontAsk --allowedTools ... --disallowedTools ... [--max-turns n] [--mcp-config f --strict-mcp-config]` | Prompt as the final argument. Reply = `.structured_output` if present, else `.result`. `write`: Read Edit Write MultiEdit Grep Glob LS TodoWrite Bash + `mcp__<id>`; `read`: Read Grep Glob LS; `advise`: none. Always disallow `Bash(sudo:*)`, `Bash(ssh:*)`, `Bash(scp:*)`, `Bash(git push:*)`, `Bash(git merge:*)`, `Bash(claude:*)`, `Bash(codex:*)`, `Bash(hermes:*)`, `Bash(mw run:*)`, `Bash(mw approve:*)`, `Bash(mw spec accept:*)`. Usage from `.usage` / `.total_cost_usd`. |
| `codex` | `codex exec -s <read-only|workspace-write> -C <cwd> --ephemeral --skip-git-repo-check [--output-schema f] [-m model] -o <file> [-c mcp overrides] -` | Prompt on stdin; reply = the `-o` file. `advise` and `read` use `read-only`. `CODEX_HOME` = a per-run home holding only a copy of `auth.json` (`prepareCodexHome`), so the owner's global `AGENTS.md`, hooks, rules, skills and memories never reach the agent. Usage = tokens of `turn.completed`; no price. |
| `local` | HTTP POST `<endpoint>/chat/completions` | OpenAI-compatible; `model` = role.profile ?? role.model; `response_format` json_schema when a schema is given; falls back to `config.local_models.fallback` when the endpoint is unreachable. Advisory only. |
| a package's | what the package runs | A harness id an installed package declares (`hermes`, from the `hermes` package). Advisory only; never given the project's MCP servers; it runs its CLI through `host.agent`, so the timeout, capture, redaction and failure table above apply; a thrown error is a failed, classified result. |

`role.args` are appended to the command. `Integrations` (see types) is one object the engine
receives; every method must be safe to call when its service is not configured (no-op) and must
never throw for a service being down (queue under `.mergewright/local/queue/` and return). The
service integrations behind `recall`, `remember`, `docsSync` and `mirrorCard` are packages now
(`mem0`, `letta`, `open-notebook`, `cline-kanban`). Exception:
the Kanban mirror (the `cline-kanban` package) queues nothing on a machine where the board does not answer; `mirrorCard` returns a
one-line note the run records once, and the board machine reconciles (`reconcileBoard`). `docsSync`
returns what it did (`none`, `sent`, `queued`, `failed`) so the `docs.sync` phase can say so.

## 8. Two machines, one repository state

The design assumes two checkouts of one project on two machines:

- A file-sync tool chosen by the owner replicates working files both ways. **`.git` is excluded**
  from it, so each machine has its own git metadata.
- History travels through the **hub**: a git remote (config `git.hub`, for example a bare
  repository on one of the machines). A machine whose files arrived by file sync **adopts** the
  matching history with `git fetch hub` + `git reset --mixed hub/<base>` (only when its HEAD is an
  ancestor of the hub's: never discards local commits). After adopt, `git status` is clean, and
  genuine local edits remain as modifications.

`hub.sync()` implements that, for the base branch in the main checkout:

| Local vs hub | Action |
|---|---|
| equal | nothing |
| local behind (ancestor) | mixed reset to hub |
| local ahead | push |
| diverged | stop with an error naming both commits; the owner resolves |
| hub unreachable | error unless `--offline` |

**Lease.** Only one machine drives a project at a time. The lease is a git ref on the hub,
`refs/mergewright/lease`, pointing at a commit whose message is JSON `{host, pid, time}`.
Taking or refreshing it is a compare-and-swap push
(`git push --force-with-lease=refs/mergewright/lease:<expected> hub <new>:refs/mergewright/lease`),
so two machines can never both win. A lease older than `config.limits.lease_minutes` may be taken
over. `hub.prepare()` (called by `mw run`) = take or refresh the lease, then `sync()`. While a run
is in progress the engine refreshes the lease at each phase boundary. With `git.hub: none` there
is no lease and no sync (single-machine project).

A machine taking over a card: `hub.fetchBranch("card/<CARD>")`, recreate the worktree from it,
read `.mergewright/runs/<CARD>/state.json` (replicated by file sync), continue from
`state.phase`. Work a worker had not finished when its machine stopped is redone from the start
of that phase.

## 8a. Staying safe across crashes and long phases

Two rules added after review; both are requirements, not options.

**Lease heartbeat.** A phase can run for `limits.minutes` (90 by default) while a lease goes stale
after `limits.lease_minutes` (10). So refreshing only at phase boundaries would let a second
machine take over while the first is still working. While any phase is executing, the engine
refreshes the lease on a timer, every `lease_minutes / 3` minutes. That requires every long
operation (harness, gate) to run without blocking the event loop (asynchronous child processes,
never `spawnSync`). If a refresh fails because the lease is no longer ours, the engine aborts the
running agent through `HarnessRequest.signal`, discards that phase's result, performs **no**
commit or push, and stops with status `blocked`, reason "this machine lost the lease to <host>".
Before any push, the engine refreshes the lease first.

**Idempotent phases.** State is saved after a phase, so a crash between a phase's side effects and
that save makes the phase run again on resume. Every phase must therefore be safe to repeat:

- Role and gate phases only produce artifacts and commits in the card's own branch; repeating
  them costs time, nothing else.
- `merge`: save `state.pendingMerge = <squash commit>` before moving the base branch. On entry,
  if `pendingMerge` is set and is an ancestor of (or equal to) the base branch, the merge already
  happened: skip straight to the remaining clean-up (push the base, delete the branch, remove the
  worktree), each of which must tolerate already being done. If `merged` is already set, the
  phase is `ok` at once.
  The re-gate of a moved base (`regateSquash`) runs before `pendingMerge` is saved, in a
  temporary worktree that `withTempWorktree` removes in a `finally`. It moves no ref and saves no
  state, so a failed, blocked or crashed re-gate leaves the base, the card branch and `state.json`
  as they were, and a resumed merge simply re-gates again.
- `merge` through a forge: the forge builds its own squash on whatever its base is
  when the API call lands, which can differ from the base the runtime gated (and re-gated,
  REQ-gate-004) if the forge's base moved outside the lease. After the sync puts the forge's commit
  on the local base, `forgeMismatch()` in `src/engine/actions.ts` reads its first parent and tree
  with git and compares them with the expected base (the `base` that `regateSquash()` reports, the
  base commit its squash was built on; `onto`, the base head the merge evidence judged against, when
  no re-gate ran) and the expected tree (`git merge-tree --write-tree <base> <pushed head>`, the
  gated tree plus the runtime's status line). The expected tree is tied to the gated tree:
  `forgeCheck()` runs `git diff-tree -r --name-only <gated tree> <expected tree>`, where the
  gated tree is the tree `regateSquash()` reports for its squash, or `git merge-tree --write-tree
  <base> <judged head>` when no re-gate ran, the judged head being the branch head read before the
  re-gate. The output may be empty or only the card file (`card.file`, compared as a normalised
  repo-relative path). Any other path, a gated tree that is missing or unknown to git, or a failed
  command sets the expected tree to null, so `forgeMismatch()` blocks as for any mismatch. The reason,
  with the extra paths, is kept as `expected.untied` and appended to the problem text. Expected and
  actual base and tree go to
  `runs/<CARD>/forge-check.json` either way. The expected pair is written there first (`ok: false`,
  `commit: null`, `pushedHead` the branch head after the status commit) before the branch is pushed
  and the forge is asked to merge, because a forge merge is a remote side effect whose answer can be
  lost. On the next fresh attempt `savedForgeCheck()` (called before the re-gate) keeps a record with
  no commit and the same `pushedHead` and returns its expectation: the re-gate and `forgeCheck()` are
  skipped (the base may already hold the forge's squash), `forgeMerge()` finds the merged pull
  request by the number in `forge.json` and returns its commit, and that commit is checked against
  the original expectation. An unreadable record, or one with a null expected value, blocks through
  `forgeUnchecked()` before the forge is called. Any other record is stale and removed. The retry
  depends on the hub's copy of the card branch: `pruneFinished()` in `src/engine/run.ts` removes the
  local worktree and branch at the start of the run because the base says the card is done, and
  `ensureWorktree()` makes them again from the hub; without it, `mergeEvidence()` refuses (block).
  When `forgeMerge()` returns undefined (no forge), the record is removed, and if it was a saved one
  `merge()` starts over so the local path re-gates. Once the forge names its commit the record is
  rewritten (still `commit: null`) before `pendingMerge` and `pendingMergeHead` are saved, so a run
  that stops between that save and the check takes the resume path. `forgeUnchecked()` keeps
  `pushedHead` too, so running a card again after `merge/no-commit` checks the commit the forge then
  names against the first expectation. `pendingMergeProblem()` runs
  `forgeMismatch()` from the recorded expectation after its generic checks
  (`uncheckedForgeMerge()`; an unreadable record or a null expected value fails), so both callers get
  it: the resumed `merge()` (which calls the generic part, `recordedMergeProblem()`, and then the
  same check once) and `mw run --from` in `src/engine/run.ts`, which only marks a recorded merge as
  merged when `pendingMergeProblem()` returns nothing, and otherwise sets it aside with a warning that
  quotes the mismatch. A passing check rewrites the record with `ok: true`. A fresh merge attempt
  removes a stale record from an earlier attempt first; but when the record names a forge commit that failed its check and is on the base
  (`failedForgeMerge()`), the fresh attempt blocks at once with the recorded problem, so
  `--from merge` after a mismatch blocks rather than merging again. A mismatch clears `pendingMerge`
  and `pendingMergeHead` (`setAside()` in `merge()`, run.ts for `--from`; otherwise the resume path,
  which accepts any commit whose tree is its own parent merged with the head, would finish the merge
  silently on the next run), adds a `forge merge check: ...` warning, and returns `block` naming both
  pairs; `merged` is never set.
  A forge that reports the pull request merged but names no merge commit throws
  `merge/no-commit` from `src/integrations/forge.ts` (an empty answer is treated alike), which
  blocks in the same way with the actual pair unknown. Rerunning a mismatched card blocks again on
  the recorded failed check. A pre-call refusal (forge base head differs from
  the local base) is not made: the integration does not read forge branch heads, and the base could
  still move after such a read, so the check is after the fact only.
- `memory.update`: `applyReflection` is idempotent (a lesson with the same title is updated, a
  decision with the same title from the same card is overwritten, state and outcome are
  replaced), and the commit is skipped when nothing changed.
- `docs.sync` and `notify` may repeat; receivers must tolerate a duplicate.

## 9. Commands (engine)

| Command | Behaviour |
|---|---|
| `mw run <CARD> [--approve a,b] [--until PHASE] [--dry-run] [--offline]` | Start or continue the run. Prints one line per phase: `brief      ok    (planner, 41s)`. Exit 0 when the run is done or waiting, 1 when blocked or failed. |
| `mw approve <CARD> <word>` | Record the approval and continue the run. |
| `mw abort <CARD> [--force]` | See section 5. |
| `mw status [--json]` | Every card: id, status (run state when a run exists; `queued (...)` for a `running` run no process drives), flow, phase it is at, title. |
| `mw sync [--offline]` | `hub.sync()`. |
| `mw lease [show|take|release]` | Inspect or change the lease. |

## 10. Tests required

End-to-end tests drive real git repositories in temp directories with the `mock` harness (and
`shell` where useful), through both the functions and the `mw` command:

1. Happy path through the `standard` flow: brief → implement → gate → review → (adjudicate
   skipped) → merge → reflect. Assert: squash commit on base with the card file `status: done`,
   worktree and branch gone, memory updated and committed, artifacts present, history correct.
2. Gate fails once, then passes after remediation (round 1). Budget exhaustion → `blocked`.
3. Blocking finding → adjudicate `reject` → remediate → approve → merge.
4. Stop point: a `high` risk card waits for `go`, then for `merge`, in every flow (the runtime adds
   them where the flow does not declare them); `mw approve` continues.
5. Scope violation (worker writes outside scope; writes a protected path) → `fail` → remediate.
6. Brief `ready: false` → blocked with the blockers; brief scope outside the card's → blocked.
7. Invalid role output → one retry → fail. A transient harness failure → retries on the same
   model, then the role's `fallback_model`, else `block` with `harness/transient` (`test/req/harness.test.ts`).
8. Resume: kill between phases (use `--until`), run again, it continues without redoing phases.
9. Merge conflict with base → `fail`; local edit in the main checkout that the merge would
   overwrite → `fail` with nothing lost.
10. `spike` flow: no merge, branch kept. `quick` flow. `--dry-run` executes nothing.
11. Hub (bare repo + two clones standing in for two machines): sync table above, lease
    compare-and-swap (two takers, one wins), stale takeover, and a card started on clone A and
    finished on clone B.
