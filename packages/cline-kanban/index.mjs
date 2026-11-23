// Cline Kanban for MergeWright (package API v1): a mirror of card status on a Kanban board through the
// `kanban` CLI (observed: kanban 0.1.70), and thin MCP tools over `kanban task ...`.
//
// What the CLI can and cannot do (read from its --help and its bundled source):
// - Every `kanban task ...` command talks to a running Kanban runtime (default http://127.0.0.1:3484,
//   env KANBAN_RUNTIME_HOST/PORT). Without one it prints `{"ok": false, "error": "... fetch failed"}`
//   and exits 1.
// - `task list` prints `{ok, workspacePath, column, tasks: [{id, prompt, column, ...}], count}`; tasks
//   carry no title, so a card is recognised by the `[<CARD-ID>] ` prefix this mirror puts at the start
//   of both the title and the prompt. The trash column is listed only on request.
// - `task create` always creates in backlog. `task trash` moves a task to the trash/done column.
// - `task start` creates a worktree and launches an agent session; the mirror never calls it.
// - No command moves a task to review, and `hooks ingest` only moves tasks with a live agent session.
//   So without a session in_progress and review cannot be shown: such a move is not queued (retrying
//   cannot help), a queued one is dropped with a message, and the board machine's reconcile
//   (`mw cline-kanban mirror`, `mw work`) reports it, `mw work` only when what it reports changes.
// - A board runs on one machine and knows a project by that machine's path (`path`). A machine where
//   the board does not answer for that path never queues a status: the run records a note, and the
//   board machine brings the board level with every card (`mirrorAll`).
//
// The CLI runs without a shell (host.exec, an argument list); every tool argument is checked against
// the tool's schema first, and the CLI (commander) takes the word after an option as its value even
// when it starts with '-', so no argument can be read as another option.
import fs from "node:fs";
import path from "node:path";

const TIMEOUT_MS = 30_000;
const KIND = "cline-kanban";

/** Card or run status -> board column. */
export function columnFor(status) {
  switch (status) {
    case "in_progress":
    case "running":
      return "in_progress";
    case "review":
    case "waiting":
    case "blocked":
      return "review";
    case "done":
    case "aborted":
      return "trash";
    default:
      return "backlog"; // todo, ready, anything unknown
  }
}

export const prefix = (cardId) => `[${cardId}] `;
const errText = (e) => (e instanceof Error ? e.message : String(e));
const tasksOf = (doc) => (Array.isArray(doc.tasks) ? doc.tasks : []);

export function activate(host) {
  const projectPath = typeof host.config.path === "string" && host.config.path ? host.config.path : host.project.root;
  const cwd = host.project.root;
  const available = () => !!host.which("kanban");
  const skipNote = () => `kanban: mirror skipped on ${host.machine} (board not reachable here); the board machine reconciles`;
  const sessionNote = "kanban: the CLI cannot move tasks to in_progress or review (only a Kanban agent session does), so the board shows this card's run only as backlog or done; 'mw cline-kanban mirror' reports it";

  /** Run the CLI and return its JSON reply; throws when it fails (runtime down included). In a queue flush it gets at most what is left of the flush's budget. */
  function kanban(args) {
    const r = host.exec("kanban", args, { cwd, timeoutMs: TIMEOUT_MS });
    if (r.timedOut) throw new Error(`kanban ${args[0]} ${args[1]} timed out`);
    let doc;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = undefined;
    }
    if (r.code !== 0 || !doc || doc.ok === false) {
      const why = typeof doc?.error === "string" ? doc.error : (r.stderr || r.stdout).trim().split("\n").slice(-1)[0] || `exit ${r.code}`;
      throw new Error(`kanban ${args.slice(0, 2).join(" ")}: ${why}`);
    }
    return doc;
  }

  const listActive = () => tasksOf(kanban(["task", "list", "--project-path", projectPath]));
  const listTrash = () => tasksOf(kanban(["task", "list", "--project-path", projectPath, "--column", "trash"])).map((t) => ({ ...t, column: "trash" }));

  /** Does the board answer on this machine for the project's path? `board` is what it showed. */
  function boardReachable() {
    try {
      return { ok: true, board: { active: listActive() } };
    } catch (e) {
      // A queue flush's budget ran out: the board was not asked, so the item stays queued (not dropped).
      if (e instanceof host.errors.BudgetCut) throw e;
      return { ok: false, why: errText(e) };
    }
  }

  function findCard(cardId, board) {
    const p = prefix(cardId);
    const mine = (t) => (t.title ?? "").startsWith(p) || (t.prompt ?? "").startsWith(p);
    const active = board.active.find(mine);
    if (active) return active;
    board.trash ??= listTrash();
    return board.trash.find(mine);
  }

  /** Create the card's task in backlog (title and prompt start with its prefix) and add it to `board`. */
  function create(cardId, title, board) {
    const text = `${prefix(cardId)}${title}`;
    const created = kanban(["task", "create", "--title", text, "--prompt", `${text}\n\nMirror of MergeWright card ${cardId}; 'mw run' drives its status.`, "--project-path", projectPath]);
    const card = { id: created.task?.id ?? "?", title: text, prompt: text, column: "backlog" };
    board.active.push(card);
    return card;
  }

  /** Bring the board in line with a status as far as the CLI allows. Throws when the CLI fails. */
  function mirror(cardId, title, status, board) {
    const want = columnFor(status);
    let card = findCard(cardId, board);
    if (want === "trash") {
      if (card?.column === "trash") return { done: true, detail: `${cardId} is already done` };
      // A card that finished where the board was not reachable never got a task: create one and close
      // it, so the board keeps the card's history.
      const fresh = !card;
      if (!card) card = create(cardId, title, board);
      if (card.id === "?") throw new Error(`kanban task create for ${cardId} answered without a task id, so it cannot be closed`);
      kanban(["task", "trash", "--task-id", card.id, "--project-path", projectPath]);
      const closed = card;
      board.active = board.active.filter((t) => t.id !== closed.id);
      board.trash?.push({ ...closed, column: "trash" });
      return { done: true, detail: fresh ? `${cardId} created and closed (moved to done)` : `${cardId} moved to done` };
    }
    if (!card || card.column === "trash") card = create(cardId, title, board);
    if (card.column === want) return { done: true, detail: `${cardId} is in ${want}` };
    if (want === "backlog") return { done: true, detail: `${cardId} stays in ${card.column} (the CLI cannot move a task back to backlog)` };
    return { done: false, needsSession: true, detail: `${cardId} should be in ${want} but is in ${card.column}: the kanban CLI moves tasks there only through an agent session` };
  }

  /** Every card's status on the board, the board listed once; a card whose command fails is reported and the rest go on. */
  function mirrorAll(cards, board) {
    return cards.map((c) => {
      try {
        return { card: c.id, status: c.status, ...mirror(c.id, c.title, c.status, board) };
      } catch (e) {
        return { card: c.id, status: c.status, done: false, detail: errText(e) };
      }
    });
  }

  /** One card's live status (its run's when it has one), or undefined when this checkout has no such card. */
  function currentStatus(cardId) {
    try {
      return host.cards().find((c) => c.id === cardId)?.status;
    } catch {
      return undefined;
    }
  }

  /**
   * Bring the board level with every card (idempotent). Queued moves of cards the board now shows right,
   * or that only an agent session can move (reported in the results), are dropped.
   */
  function reconcileBoard() {
    if (!available()) return { state: "off", why: "the kanban CLI is not on PATH" };
    const reach = boardReachable();
    if (!reach.ok) return { state: "unreachable", why: reach.why };
    const results = mirrorAll(host.cards(), reach.board);
    const settled = new Set(results.filter((r) => r.done || r.needsSession).map((r) => r.card));
    host.queue.drop((it) => settled.has(it.payload?.cardId ?? ""));
    return { state: "done", results };
  }

  /**
   * The line `mw work` prints after a reconcile, or undefined when the cards the board cannot show right
   * are the same as when it last printed (remembered on this machine), so an unattended service does not
   * repeat the same line in its journal.
   */
  function reconcileReport(results, when) {
    const pending = results.filter((x) => !x.done);
    const key = pending.map((x) => `${x.card}\t${x.status}\t${x.detail}`).sort().join("\n");
    const file = path.join(host.localDir, "reported");
    let last;
    try {
      last = fs.readFileSync(file, "utf8");
    } catch {
      last = undefined;
    }
    if (last === key) return undefined;
    try {
      fs.mkdirSync(host.localDir, { recursive: true });
      fs.writeFileSync(file, key);
    } catch {
      // not remembered: the line is printed again next time
    }
    return `kanban: board reconciled ${when} (${results.length - pending.length} of ${results.length} card(s) shown right${pending.length ? `; ${pending.map((x) => `${x.card}: ${x.detail}`).join("; ")}` : ""})`;
  }

  /** Run `kanban task <sub> ...` for a tool; CLI failures (runtime down included) become one-line errors. */
  function task(sub, args) {
    if (!available()) throw new Error("the kanban CLI is not on PATH on this machine (npm i -g kanban)");
    try {
      return kanban(["task", sub, ...args, "--project-path", projectPath]);
    } catch (e) {
      const m = errText(e);
      throw new Error(`${m}${/fetch failed|ECONNREFUSED/.test(m) ? " (no Kanban runtime is reachable from this machine: KANBAN_RUNTIME_HOST/PORT, default 127.0.0.1:3484)" : ""}`);
    }
  }
  /** `--flag value` pairs for the arguments that are set. */
  function flags(a, map) {
    const out = [];
    for (const [arg, flag] of Object.entries(map)) {
      const v = a[arg];
      if (typeof v === "string") out.push(flag, v);
      else if (typeof v === "boolean") out.push(flag, String(v));
    }
    return out;
  }
  const obj = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) });
  const str = (description) => ({ type: "string", description });
  const taskId = str("Kanban task id");
  const optional = {
    base_ref: str("base branch or ref of the task"),
    agent_id: { type: "string", enum: ["cline", "claude", "codex", "droid", "gemini", "opencode", "default"], description: "agent that works the task" },
    plan_mode: { type: "boolean", description: "start in plan mode" },
  };
  const optionalFlags = { base_ref: "--base-ref", agent_id: "--agent-id", plan_mode: "--start-in-plan-mode" };

  return {
    async mirrorCard(cardId, title, status) {
      if (!available()) return;
      // A newer status supersedes whatever was pending for this card.
      host.queue.drop((it) => it.payload?.cardId === cardId);
      // Only the machine where the board answers for the project's path delivers; elsewhere nothing is
      // queued (it would wait forever) and the board machine reconciles.
      const reach = boardReachable();
      if (!reach.ok) return skipNote();
      const payload = { cardId, title, status };
      try {
        const r = mirror(cardId, title, status, reach.board);
        // A column only a Kanban agent session reaches is not queued (it would be retried forever).
        if (!r.done && r.needsSession) return sessionNote;
        if (!r.done) host.queue.enqueue(KIND, `kanban: ${cardId} -> ${status} (pending)`, payload, r.detail);
      } catch (e) {
        if (e instanceof host.errors.BudgetCut) throw e;
        host.queue.enqueue(KIND, `kanban: ${cardId} -> ${status}`, payload, errText(e));
      }
    },
    async reconcile(when) {
      try {
        const r = reconcileBoard();
        return r.state === "done" ? reconcileReport(r.results, when) : undefined;
      } catch (e) {
        return `kanban: could not reconcile the board: ${errText(e)}`;
      }
    },
    deliverers: {
      async [KIND](payload) {
        if (!available()) throw new Error("the kanban CLI is not on PATH");
        const k = payload;
        // A status the card has since left is not shown any more: the newer one (or a reconcile) wins.
        // (A card this checkout does not have is delivered as queued.)
        const now = currentStatus(k.cardId);
        if (now !== undefined && now !== k.status) throw new host.errors.Dropped(`stale: ${k.cardId} is now ${now}, not ${k.status}; dropped (the board takes the current status from 'mw cline-kanban mirror')`);
        const reach = boardReachable();
        if (!reach.ok) throw new host.errors.Dropped(`${skipNote()}; dropped`);
        const r = mirror(k.cardId, k.title, k.status, reach.board);
        // A column the CLI cannot reach: retrying cannot help, the board machine's reconcile reports it.
        if (!r.done && r.needsSession) throw new host.errors.Dropped(`${r.detail}; dropped (not retried: 'mw cline-kanban mirror' and 'mw work' on the board machine report it)`);
        if (!r.done) throw new Error(r.detail);
      },
    },
    commands: {
      /** `mw cline-kanban mirror`: bring the board level with every card's status (on the board machine). */
      "cline-kanban"(args, out) {
        if (args._[1] !== "mirror") { host.log("use 'mw cline-kanban mirror' (bring the Kanban board level with every card's status)"); return 2; }
        const r = reconcileBoard();
        if (r.state === "off") { out(`kanban: nothing to mirror: ${r.why}`); return 0; }
        if (r.state === "unreachable") {
          out(`kanban: the board does not answer on this machine for ${projectPath} (${r.why}). Run 'mw cline-kanban mirror' on the machine where the board runs, or set packages.cline-kanban.path to the path the board knows.`);
          return 1;
        }
        for (const x of r.results) out(`${x.done ? "ok     " : "pending"}  ${x.card.padEnd(10)} ${x.status.padEnd(12)} ${x.detail}`);
        const pending = r.results.filter((x) => !x.done).length;
        out(`${r.results.length - pending} of ${r.results.length} card(s) shown right on the board${pending ? `; ${pending} cannot be shown by the kanban CLI yet` : ""}`);
        return 0;
      },
    },
    tools: [
      {
        name: "mw_kanban_list",
        description: "List the tasks on the project's Kanban board (optionally one column: backlog, in_progress, review, done/trash).",
        inputSchema: obj({ column: { type: "string", enum: ["backlog", "in_progress", "review", "done", "trash"], description: "only this column" } }),
        handler: (a) => task("list", flags(a, { column: "--column" })),
      },
      {
        name: "mw_kanban_get",
        description: "One task of the board by id (searched in every column, done included).",
        inputSchema: obj({ task_id: taskId }, ["task_id"]),
        handler(a) {
          for (const extra of [[], ["--column", "trash"]]) {
            const found = tasksOf(task("list", extra)).find((t) => t.id === a.task_id);
            if (found) return found;
          }
          throw new Error(`there is no task ${a.task_id} on the board`);
        },
      },
      {
        name: "mw_kanban_create",
        description: "Create a task in backlog. 'prompt' is what an agent gets when the task is started (default: the title).",
        write: true,
        inputSchema: obj({ title: str("task title"), prompt: str("task prompt"), ...optional }, ["title"]),
        handler: (a) => task("create", ["--title", a.title, "--prompt", typeof a.prompt === "string" ? a.prompt : a.title, ...flags(a, optionalFlags)]),
      },
      {
        name: "mw_kanban_update",
        description: "Change a task's title, prompt, base ref or agent.",
        write: true,
        inputSchema: obj({ task_id: taskId, title: str("new title"), prompt: str("new prompt"), ...optional }, ["task_id"]),
        handler: (a) => task("update", ["--task-id", a.task_id, ...flags(a, { title: "--title", prompt: "--prompt", ...optionalFlags })]),
      },
      {
        name: "mw_kanban_done",
        description: "Move a task to done (the trash column) and clean up its workspace.",
        write: true,
        inputSchema: obj({ task_id: taskId }, ["task_id"]),
        handler: (a) => task("trash", ["--task-id", a.task_id]),
      },
      {
        name: "mw_kanban_delete",
        description: "Permanently delete a task. Prefer mw_kanban_done; delete only what was created by mistake.",
        write: true,
        inputSchema: obj({ task_id: taskId }, ["task_id"]),
        handler: (a) => task("delete", ["--task-id", a.task_id]),
      },
      {
        name: "mw_kanban_link",
        description: "Link two tasks so that task_id waits on linked_task_id (while both are in backlog).",
        write: true,
        inputSchema: obj({ task_id: str("the task that waits"), linked_task_id: str("the task it waits on") }, ["task_id", "linked_task_id"]),
        handler: (a) => task("link", ["--task-id", a.task_id, "--linked-task-id", a.linked_task_id]),
      },
      {
        name: "mw_kanban_start",
        description: "Start a task: Kanban creates a worktree, launches an agent session on it and moves it to in_progress. Not for MergeWright cards (use mw_run_start).",
        write: true,
        inputSchema: obj({ task_id: taskId }, ["task_id"]),
        handler: (a) => task("start", ["--task-id", a.task_id]),
      },
    ],
    checks: [
      {
        name: "kanban",
        async run() {
          // The board runs on one machine; on the other, its path does not exist and the CLI's error says nothing useful.
          if (host.config.path && !fs.existsSync(projectPath)) return { ok: true, detail: `board on another machine (packages.cline-kanban.path=${projectPath}); mirrored from there` };
          if (!available()) return { ok: false, detail: `the kanban CLI is not on PATH (the mirror is a no-op); ${projectPath}` };
          try {
            return { ok: true, detail: `reachable, ${listActive().length} task(s) on the board; ${projectPath}` };
          } catch (e) {
            return { ok: false, detail: `NOT reachable (${errText(e)}); ${projectPath}` };
          }
        },
      },
    ],
  };
}
