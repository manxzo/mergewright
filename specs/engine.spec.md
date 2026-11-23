---
id: engine
title: Engine locking, processes, transcripts and deliveries
status: accepted
owner: maintainers
---

How the engine shares the base checkout with the MCP server, cleans up the processes it starts,
keeps what agents print private, and keeps optional services off the paths that hold the lock or
the lease (specification 8.1, 8.4, 8.6, 8.8, 8.9, 10, 12.5).

### REQ-engine-001 One repository lock for every base-checkout write
- priority: must
- rev: 1
- AC-1: Given the engine's `memory.update` creating follow-up cards and an MCP writing tool such as `mw_card_new` on the same machine, when both allocate a card id at the same time, then each allocation happens under the repository lock after re-reading `cards/`, and the two cards get distinct ids.
- AC-2: Given the engine commits project memory or follow-up cards on the base checkout, when it writes, then it holds the repository lock, taken after the run lock and the lease (order: run lock, lease, repository lock), and releases it before any delivery to an external service.
- AC-3: Given an MCP writing tool waiting for the repository lock while a run's `memory.update` holds it, when the run releases it, then the tool proceeds and neither side deadlocks or times out within `repoLockTiming.waitMs`.

### REQ-engine-002 Follow-up cards are journaled
- priority: must
- rev: 1
- AC-1: Given an approving adjudication with three follow-ups, when the run stops after the first follow-up card was written and is then resumed, then `memory.update` creates the other two and the run ends with exactly three follow-up cards.
- AC-2: Given a follow-up being created, when its card is written, then the run state records `{index, title, id}` for it before the next one starts, and the journal is marked done only after the last.
- AC-3: Given a follow-up refused by card creation, when the run resumes, then it is not tried again: the journal records it as skipped with the warning, and the other follow-ups are kept.

### REQ-engine-003 A cancelled MCP write never commits
- priority: must
- rev: 1
- AC-1: Given a locked MCP tool call queued on the server's mutex behind another call, when the client cancels it before it holds the lock, then it writes no file, makes no commit and takes no lease.
- AC-2: Given a locked tool call that already holds the lock, when it is cancelled before its write, then it checks the abort signal, stops before writing and commits nothing.

### REQ-engine-004 Process groups are reaped on every exit
- priority: must
- rev: 1
- AC-1: Given a gate script that starts `sleep 300 &` and exits 0, when `runGate()` returns, then no process of the gate's process group is alive and the gate's outcome is the one its exit code and summary give.
- AC-2: Given a harness CLI that exits normally and leaves a child running in its process group, when `runCli()` returns, then the group was sent TERM, then KILL after the grace period, and a survivor is recorded through `reapOrRecord()` as on timeout or abort.
- AC-3: Given a command that exits with no child left, when it closes, then its result is returned without waiting for the grace period.

### REQ-engine-005 Run folders and transcripts are private
- priority: must
- rev: 1
- AC-1: Given a run, when its folder under `.mergewright/runs/` and its stream, exchange, prompt and gate log files are created, then the folder has mode 0700 and the files mode 0600, whatever the process umask.
- AC-2: Given a run folder left with wider modes by an earlier runtime, when that run is resumed, then the runtime narrows the folder and its files to 0700 and 0600 before writing.

### REQ-engine-006 Secrets never reach the synced run folder
- priority: must
- rev: 1
- AC-1: Given a fake agent or gate that prints the value of a variable named by any configured `key_env` or MCP `env`/`headers` reference, when its streams, saved exchange and gate log are written, then the value appears nowhere on disk and `[redacted]` stands in its place, also when the value is split across two output chunks.
- AC-2: Given a Claude role with MCP servers whose `env` or `headers` resolve to secret values, when the harness writes its `--mcp-config` file, then the file is created outside `.mergewright/runs/` (under `.mergewright/local/`, mode 0600) and is removed when the phase ends.
- AC-3: Given a Codex role with MCP servers whose `env` or `headers` resolve to secret values, when Codex is spawned, then the values are not in its command-line arguments.

### REQ-engine-007 Raw streams are pruned
- priority: should
- rev: 1
- AC-1: Given `trace.raw_days` (default 14) and raw stdout and stderr streams older than that in the folders of finished runs, when `mw work` starts a pass, then it deletes those streams and keeps `state.json`, the artifacts and the audit trail.
- AC-2: Given a run that is in progress, waiting or blocked, when pruning runs, then its streams are kept whatever their age.

### REQ-engine-008 Deliveries happen after the lock and the lease
- priority: must
- rev: 1
- AC-1: Given mem0 or Letta not answering, when `mw_memory_add` (or another locked MCP tool that stores a lesson) runs, then it records the delivery in this machine's queue under the lock, replies at once saying the delivery is queued, and the delivery is attempted only after the repository lock and the lease are released.
- AC-2: Given a delivery recorded this way, when the process stops before delivering it, then the item is still in `.mergewright/local/queue/` and the next flush delivers it.

### REQ-engine-009 Queue flushes are bounded and never hold up dispatch
- priority: must
- rev: 1
- AC-1: Given a queued item whose endpoint never answers and a `ready` card, when `mw work` makes a pass, then the card is dispatched before the queue is flushed, and the flush stops within its time budget (20 s), leaving the rest queued.
- AC-2: Given a delivery kind that timed out twice in a row, when a flush runs within the next 10 minutes, then items of that kind are skipped without a request, and after that they are tried again.
- AC-3: Given items skipped by the budget or the breaker, when the queue is listed after a restart, then every one is still there with its attempt count.

### REQ-engine-010 The merge phase handles a card branch that lacks the card file
- priority: must
- rev: 1
- AC-1: Given a card branch whose tree has no `cards/<ID>.card.md`, when the merge phase marks the card done, then the runtime takes the card file from the base branch (the cards are the source of truth there), writes it into the worktree with `status: done` and commits it as the runtime commit, and the merge completes.
- AC-2: Given any other failure to read or write the card file in the merge phase, when it happens, then the run is `blocked` with an `MwError` that names the path and the remedy (`mw run <ID> --from merge`), never an uncaught exception, and the lock and lease are released as for every blocked run.

### REQ-engine-011 A stop request lets the current card finish
- priority: must
- rev: 1
- AC-1: Given `ops/mw-work@.service`, when systemd stops or restarts the unit, then only the `mw work` main process receives the stop signal (KillMode=mixed) and the agent, gate and delivery children keep running until the card finishes, within TimeoutStopSec.
- AC-2: Given `mw work` has received SIGTERM, when the current card finishes, then the process exits 0 and the unit's Restart= policy does not treat that exit as a failure; a second SIGTERM (or SIGINT) stops the phase at once, as today.
- AC-3: Given the installer (`scripts/install.sh`) and the ops docs, when the unit file changes, then they install the new unit and the docs say that a restart waits for the card and how to stop at once.

### REQ-engine-012 Queued deliveries flush while this machine keeps the lease
- priority: must
- rev: 1
- AC-1: Given queued deliveries and a lease held by this machine, when no run on this machine is inside a merge phase, then `mw work` flushes the queue between cards and `mw queue flush` flushes it on request, within the existing budget and breaker rules (REQ-engine-008, REQ-engine-009).
- AC-2: Given a run on this machine inside its merge phase, when a flush is due, then it waits for that phase to end, never for the lease.

### REQ-engine-013 mw work runs several cards at once
- priority: should
- rev: 1
- AC-1: Given `mw work --parallel N` (config `work.parallel`, default 1), when more than one card is eligible, then up to N run at once, each driven by its own child process with the existing per-card lock and lease rules, starts staggered by at least 20 seconds, and the journal names which card each line is about.
- AC-2: Given a usage pause or a stop request, when cards are running in parallel, then no new card starts and each running card finishes or stops as today.
- AC-3: Given `ops/mw-work@.service`, when installed, then `MW_WORK_PARALLEL` in the project's env sets N.

### REQ-engine-014 mw status tells a driven run from a queued one
- priority: should
- rev: 1
- AC-1: Given a run whose recorded driver process is gone, when `mw status` prints it, then the status reads `queued` (with the phase it will resume at and how to drive it), not `running`; `mw work --dry-run` says the same.

### REQ-engine-015 Sibling processes on one machine share the machine lease
- priority: must
- rev: 1
- AC-1: Given several `mw` processes on one machine, when they heartbeat the machine lease, then a heartbeat written by a sibling process of the same machine (same host identity) is never read as a lost lease; the phase continues.
- AC-2: Given the heartbeat write races a sibling's write (compare-and-swap refused), when the refusal is read back and the lease still names this machine, then the heartbeat is retried within the lease interval and the phase continues; only a lease that names another machine stops the phase.
- AC-3: Given a phase stopped by a genuine eviction, when the run is listed, then its status reads `stopped` with the reason, not `running`, and `mw work` or `mw run <ID>` resumes it.
