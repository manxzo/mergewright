# board-4ga

Mirrors each MergeWright card's live status to a [4ga Boards](https://github.com/RARgames/4gaBoards)
board. Card files stay the source of truth; the board is a view, and changes made on it do not flow
back.

**Not verified against a live instance.** This package was written from the 4ga Boards source at
commit `538edfc3e85b174529c2c65cd289e3cc5d3cf88e` (its routes, controllers and authentication
policy; the project has no API documentation) and has been tested only against a fake server built
from those shapes. It has not been run against a running 4ga Boards. The test
`test/packages-board-4ga.test.ts` has a live case for that: `MW_LIVE=1 MW_4GA_URL=... MW_4GA_BOARD=...
MW_4GA_CLIENT_ID=... MW_4GA_CLIENT_SECRET=...`.

## Setup

1. In 4ga Boards, create an API client for a user who is an editor of the board, with the
   permissions `boards.show`, `lists.create`, `cards.create` and `cards.update` (or `*`). Keep its
   id and secret.
2. `mw add board-4ga`, then set `packages.board-4ga.url` (the server, e.g. `http://192.0.2.10:3000`)
   and `packages.board-4ga.board` (the board's id: the number in its address, `/boards/<id>`).
3. Put the id and secret in `BOARD_4GA_CLIENT_ID` and `BOARD_4GA_CLIENT_SECRET`
   (`~/.config/mergewright/env`), or name other variables with `client_id_env` and
   `client_secret_env`. They are never read from `mergewright.yaml`, and their values are redacted.
4. `mw doctor` shows whether the board answers.

## What it does

- Each card is a 4ga card named `[<CARD-ID>] <title>`, found again by that prefix (on any machine;
  nothing is stored per machine). It is placed in the list of its status, and the list is created
  at the end of the board when the board has none of that name (matched without regard to case):

  | Status | List |
  |---|---|
  | `todo`, `ready`, anything else | Backlog |
  | `in_progress`, `running` | In progress |
  | `review`, `waiting`, `blocked` | Review |
  | `done`, `aborted` | Done (created as a completed list, so 4ga marks its cards done) |

- On each status change the card is moved now; when the board does not answer, the status is
  queued (kind `board-4ga`) and `mw queue flush` delivers it, or drops it when the card's status has
  changed since. A newer status replaces a queued one. Without the id or secret set, the mirror
  records one note and queues nothing.
- `mw board-4ga mirror` and `mw work` (the `reconcile`) bring the board level with every card; a
  title change renames the card. `mw work` prints a line only when something changed or failed.
- The `board-4ga` check of `mw doctor`.

## What it does not do

- It never deletes or archives a 4ga card, and does not mirror a card file that was deleted.
- It adds no comments, labels, members or due dates, and no MCP tools.
- It does not sign in with a password (`POST /api/access-tokens`): the API client is the
  non-interactive way the source offers.

## What may break

- The API is undocumented upstream; the request and response shapes are read from the controllers
  and may change in any release.
- The whole board is read for each status (`GET /api/boards/:id` returns every card with its
  tasks and attachments), and 4ga checks the client secret with bcrypt on every request: fine for a
  project board, slow for a very large one.
- A card renamed on the board so that its name no longer starts with `[<CARD-ID>] ` is not found
  again, and a new one is created.
