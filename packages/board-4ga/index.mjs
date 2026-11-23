// 4ga Boards (https://github.com/RARgames/4gaBoards) as a mirror of card status, for MergeWright
// (package API v1). Written from the upstream source at commit 538edfc3e85b174529c2c65cd289e3cc5d3cf88e
// (server/config/routes.js, server/api/controllers, server/api/policies/is-authenticated.js) and NOT
// run against a live 4ga Boards instance.
//
// What the API offers (read from that source):
// - Authentication: an API client (created by the owner in 4ga Boards, POST /api/api-clients) sends
//   `X-Client-Id` and `X-Client-Secret` on every request and acts as the user who created it. It needs
//   the permissions boards.show, lists.create, cards.create and cards.update (or `*`), checked per
//   action as `<controller>.<action>`; its user must be an editor of the board. No password is used.
// - GET /api/boards/:id -> {item: board, included: {lists: [{id, name, position, ...}], cards: [{id,
//   listId, name, position, ...}], ...}}: the whole board in one call.
// - POST /api/boards/:boardId/lists {position, name, isCollapsed, isCompleted} -> {item: list}. A card
//   in a list with isCompleted is marked done.
// - POST /api/lists/:listId/cards {name, position, description} -> {item: card} (position is required).
// - PATCH /api/cards/:id {listId, position, name} -> {item: card} (position is required with listId).
// - Ids are strings of digits.
//
// A MergeWright card is found again by the `[<CARD-ID>] ` prefix its 4ga card's name starts with (as
// cline-kanban does), so any machine can mirror and nothing per machine has to be kept in step.
// Every list is reachable through the API, so unlike cline-kanban every status can be shown.

const TIMEOUT_MS = 30_000;
const KIND = "board-4ga";
const GAP = 65536; // the spacing between positions of new lists and cards

/** Card or run status -> the name of its list. */
export function listFor(status) {
  switch (status) {
    case "in_progress":
    case "running":
      return "In progress";
    case "review":
    case "waiting":
    case "blocked":
      return "Review";
    case "done":
    case "aborted":
      return "Done";
    default:
      return "Backlog"; // todo, ready, anything unknown
  }
}

export const prefix = (cardId) => `[${cardId}] `;
const errText = (e) => (e instanceof Error ? e.message : String(e));
const trimSlash = (u) => String(u).replace(/\/+$/, "");
const shown = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return String(url).split("?")[0]; } };
const nextPosition = (items) => items.reduce((m, x) => Math.max(m, Number(x.position) || 0), 0) + GAP;

export function activate(host) {
  const c = host.config;
  const s = {
    url: String(c.url),
    board: String(c.board),
    idEnv: typeof c.client_id_env === "string" && c.client_id_env ? c.client_id_env : "BOARD_4GA_CLIENT_ID",
    secretEnv: typeof c.client_secret_env === "string" && c.client_secret_env ? c.client_secret_env : "BOARD_4GA_CLIENT_SECRET",
  };
  const api = (rel) => {
    const base = trimSlash(s.url);
    return `${base.endsWith("/api") ? base : `${base}/api`}${rel}`;
  };
  const credentials = () => {
    const id = host.env(s.idEnv);
    const secret = host.env(s.secretEnv);
    if (!id || !secret) throw new Error(`${!id ? s.idEnv : s.secretEnv} is not set: create an API client in 4ga Boards and put its id and secret in ${s.idEnv} and ${s.secretEnv}`);
    return { "x-client-id": id, "x-client-secret": secret };
  };
  const call = (rel, opts = {}) => host.http.json(api(rel), { headers: credentials(), timeoutMs: TIMEOUT_MS, ...opts });

  /** The board's lists and cards (one GET). */
  async function loadBoard() {
    const r = await call(`/boards/${s.board}`);
    const inc = r?.included ?? {};
    return { name: String(r?.item?.name ?? s.board), lists: Array.isArray(inc.lists) ? inc.lists : [], cards: Array.isArray(inc.cards) ? inc.cards : [] };
  }

  /** The list named `name` (case-insensitive), created at the end of the board when there is none. */
  async function ensureList(board, name) {
    const found = board.lists.find((l) => String(l.name ?? "").trim().toLowerCase() === name.toLowerCase());
    if (found) return found;
    const r = await call(`/boards/${s.board}/lists`, { method: "POST", body: { position: nextPosition(board.lists), name, isCollapsed: false, isCompleted: name === "Done" } });
    const list = r?.item;
    if (!list?.id) throw new Error(`4ga Boards created the list '${name}' without answering its id`);
    board.lists.push(list);
    return list;
  }

  /** Bring one card's 4ga card to the list of `status` (created when missing). Throws on any API error. */
  async function mirror(cardId, title, status, board) {
    const name = `${prefix(cardId)}${title}`;
    const list = await ensureList(board, listFor(status));
    const inList = () => board.cards.filter((x) => x.listId === list.id);
    const card = board.cards.find((x) => String(x.name ?? "").startsWith(prefix(cardId)));
    if (!card) {
      const r = await call(`/lists/${list.id}/cards`, { method: "POST", body: { name, position: nextPosition(inList()), description: `Mirror of MergeWright card ${cardId}; 'mw run' drives the list it is in.` } });
      if (r?.item) board.cards.push(r.item);
      return { changed: true, detail: `${cardId} created in ${list.name}` };
    }
    const patch = {};
    if (card.listId !== list.id) Object.assign(patch, { listId: list.id, position: nextPosition(inList()) });
    if (card.name !== name) patch.name = name;
    if (!Object.keys(patch).length) return { changed: false, detail: `${cardId} is in ${list.name}` };
    await call(`/cards/${card.id}`, { method: "PATCH", body: patch });
    Object.assign(card, patch);
    return { changed: true, detail: patch.listId ? `${cardId} moved to ${list.name}` : `${cardId} renamed` };
  }

  /** Every card's status on the board, the board read once; a card whose call fails is reported and the rest go on. */
  async function mirrorAll() {
    const board = await loadBoard();
    const out = [];
    for (const card of host.cards()) {
      try {
        out.push({ card: card.id, status: card.status, done: true, ...(await mirror(card.id, card.title, card.status, board)) });
      } catch (e) {
        out.push({ card: card.id, status: card.status, done: false, changed: false, detail: errText(e) });
      }
    }
    // What the board shows right now needs no queued move any more.
    const settled = new Set(out.filter((r) => r.done).map((r) => r.card));
    host.queue.drop((it) => settled.has(it.payload?.cardId ?? ""));
    return out;
  }

  function currentStatus(cardId) {
    try {
      return host.cards().find((x) => x.id === cardId)?.status;
    } catch {
      return undefined;
    }
  }

  return {
    async mirrorCard(cardId, title, status) {
      // A newer status supersedes whatever was pending for this card.
      host.queue.drop((it) => it.payload?.cardId === cardId);
      // Without credentials no call can succeed: say so once in the run instead of queueing every status.
      if (!host.env(s.idEnv) || !host.env(s.secretEnv)) return `4ga: mirror skipped (${s.idEnv} or ${s.secretEnv} is not set on ${host.machine})`;
      try {
        await mirror(cardId, title, status, await loadBoard());
      } catch (e) {
        host.queue.enqueue(KIND, `4ga: ${cardId} -> ${status}`, { cardId, title, status }, errText(e));
      }
    },
    async reconcile(when) {
      let results;
      try {
        results = await mirrorAll();
      } catch {
        return undefined; // the board does not answer: `mw doctor` says so, the queue keeps what failed
      }
      const changed = results.filter((r) => r.changed);
      const failed = results.filter((r) => !r.done);
      if (!changed.length && !failed.length) return undefined;
      return `4ga: board reconciled ${when} (${changed.length} card(s) updated${failed.length ? `; ${failed.map((r) => `${r.card}: ${r.detail}`).join("; ")}` : ""})`;
    },
    deliverers: {
      async [KIND](payload) {
        const k = payload ?? {};
        // A status the card has since left is not shown any more: the newer one (or a reconcile) wins.
        const now = currentStatus(k.cardId);
        if (now !== undefined && now !== k.status) throw new host.errors.Dropped(`stale: ${k.cardId} is now ${now}, not ${k.status}; dropped ('mw board-4ga mirror' shows the current status)`);
        await mirror(k.cardId, k.title, k.status, await loadBoard());
      },
    },
    commands: {
      /** `mw board-4ga mirror`: bring the board level with every card's status. */
      async "board-4ga"(args, out) {
        if (args._[1] !== "mirror") { host.log("use 'mw board-4ga mirror' (bring the 4ga board level with every card's status)"); return 2; }
        let results;
        try {
          results = await mirrorAll();
        } catch (e) {
          host.log(`the 4ga board did not answer: ${errText(e)}. Check packages.board-4ga.url and board, and ${s.idEnv} and ${s.secretEnv}.`);
          return 1;
        }
        for (const r of results) out(`${r.done ? "ok    " : "failed"}  ${r.card.padEnd(10)} ${r.status.padEnd(12)} ${r.detail}`);
        const failed = results.filter((r) => !r.done).length;
        out(`${results.length - failed} of ${results.length} card(s) shown right on the board${failed ? `; ${failed} failed (see above)` : ""}`);
        return failed ? 1 : 0;
      },
    },
    checks: [
      {
        name: "board-4ga",
        async run() {
          const where = `${shown(s.url)} board ${s.board}, ${s.idEnv} ${host.env(s.idEnv) ? "set" : "NOT set"}, ${s.secretEnv} ${host.env(s.secretEnv) ? "set" : "NOT set"}`;
          try {
            const b = await loadBoard();
            return { ok: true, detail: `reachable, board '${b.name}' with ${b.lists.length} list(s) and ${b.cards.length} card(s); ${where}` };
          } catch (e) {
            return { ok: false, detail: `NOT reachable (${errText(e)}); ${where}` };
          }
        },
      },
    ],
  };
}
