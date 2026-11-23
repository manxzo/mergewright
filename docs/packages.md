# Writing a MergeWright package

A package adds something to MergeWright without changing its core: a service integration, a
harness, `mw` commands, MCP tools or `mw doctor` checks. This guide shows how to write one. The
reference is section 15 of the specification; the exact types are in `src/packages/api.ts`.

The package API is **experimental**. It may change in any release. Your manifest says which version
it is written for (`apiVersion`, now `1`), and a runtime refuses a package written for another.

## What a package is

A folder with two files at least:

```
hello/
├── mergewright-package.yaml   the manifest (schemas/package.schema.json)
└── index.mjs                  the entry: an ES module that exports activate(host)
```

`mw add ./hello` copies the folder to `.mergewright/packages/hello/` in the project and enables it
as `packages.hello` in `mergewright.yaml`. Every time MergeWright needs a package it imports the
entry and calls `activate(host)` once per process. `activate` returns the parts the package
provides; every part is optional.

A package runs with the rights of the user who runs `mw`. `mw add` says so, shows what the manifest
declares, and asks before it installs anything.

## A minimal working example

This package greets: it adds the command `mw hello [name]`, the MCP tool `mw_hello`, a `mw doctor`
check, and recall hits from one documentation file. The test suite installs exactly these two files
and runs them (`test/packages-guide.test.ts`), so they work as written.

`hello/mergewright-package.yaml`:

```yaml
name: hello
version: 0.1.0
description: Says hello; the example package of docs/packages.md.
apiVersion: 1
entry: index.mjs
exports: [commands, tools, checks, recall]
secrets: [HELLO_TOKEN]
config:
  type: object
  additionalProperties: false
  properties:
    greeting:
      type: string
      description: The word to greet with (default Hello)
```

`hello/index.mjs`:

```js
// The example package of docs/packages.md (package API 1).
export function activate(host) {
  const greeting = typeof host.config.greeting === "string" ? host.config.greeting : "Hello";
  const greet = (name) => `${greeting}, ${name || host.project.name}!`;
  return {
    commands: {
      // `mw hello [name]`: args._[0] is the command's own name.
      hello(args, out) {
        out(greet(args._[1]));
        return 0;
      },
    },
    tools: [
      {
        name: "mw_hello",
        description: "Greets someone (default: the project).",
        inputSchema: { type: "object", additionalProperties: false, properties: { name: { type: "string" } } },
        handler: (a) => greet(typeof a.name === "string" ? a.name : ""),
      },
    ],
    checks: [
      {
        name: "hello",
        async run() {
          return { ok: true, detail: host.env("HELLO_TOKEN") ? "HELLO_TOKEN set" : "HELLO_TOKEN NOT set" };
        },
      },
    ],
    // Lines of docs/hello.md that contain the query, for {{memory.recall}}.
    async recall(query, limit) {
      const text = host.readFile("docs/hello.md") ?? "";
      return text.split("\n").filter((l) => query && l.includes(query)).slice(0, limit).map((l) => `hello.md: ${l.trim()}`);
    },
  };
}
```

Try it in a project:

```bash
mw add ./hello              # shows the manifest, asks, installs and enables it
mw config set packages.hello.greeting Hi
mw hello Alice              # Hi, Alice!
mw packages                 # hello  0.1.0  enabled  loaded, provides commands, tools, checks, recall
mw doctor                   # ... hello  ok  HELLO_TOKEN NOT set (package hello)
mw remove hello
```

## The manifest

| Field | Meaning |
|---|---|
| `name` | Lower-case letters, digits and `-`. The folder name, the key under `packages:`, and the prefix of the package's queue kinds. |
| `version`, `description` | Shown by `mw add` and `mw packages`. |
| `apiVersion` | The package API version the entry is written for: `1`. |
| `entry` | The entry module: `.mjs`, `.js` (as an ES module) or an erasable-syntax `.ts` (needs Node with type stripping). |
| `exports` | What `activate` returns, so `mw add` can show it before anything runs. List `remember` here when you provide a memory store: the core finds stores from the manifest without loading the package. |
| `harnesses` | The harness ids the package provides. Only these are accepted from `activate` and in `runs:`. |
| `config` | A JSON Schema for the package's settings under `packages.<name>`. `mw check` reports settings that do not fit as `config/package`. |
| `secrets` | The environment variables holding secrets the package reads: a name, or `{config: key_env, default: MY_KEY}` for one a setting may rename. They reach `host.env()`, and their values are redacted from tool output and run folders. |
| `env` | Other environment variables `host.env()` may read, which are not secrets (a tool's home folder, say); they are not redacted. Any variable named in neither list reads as undefined. |

## What `activate` may return

| Part | What MergeWright does with it |
|---|---|
| `deliverers` | Handlers of queued items, by kind: `<name>` or `<name>:<anything>`. Queue an item with `host.queue.enqueue(kind, summary, payload)`; `mw queue flush` and every queue retry call your handler. Throw to keep the item queued, `host.errors.PartialDelivery` to keep only what remains, `host.errors.Dropped` to remove it. |
| `recall(query, limit)` | `title: text` lines added to a card's `{{memory.recall}}`. |
| `search(query, limit)` | Lines added to `mw memory search`, `mw docs search`, `mw_memory_search` and `mw_docs_search`, labelled with the package's name. |
| `searchDocs(query, limit, {text})` | Used instead of `search` by `mw docs search` and `mw_docs_search`, for a package that searches documentation rather than memory; `text` asks for plain text search. |
| `remember` | A memory store: `label`, `open()` returning `{present(lesson), store(lesson)}`, and an optional `prune(match, {dryRun})`. The core queues the reflect phase's lessons for it and delivers them one at a time; `mw memory add`, `mw memory push --service <name>` and `mw memory prune --service <name>` use it. |
| `docsSync(changed, deleted, commit)` | Called with the documentation files a card's merge changed and deleted, and the commit to read them from (`host.docs.blob`); return `"sent"`, `"queued"` (you queued the batch), `"failed"` or `"none"`. |
| `mirrorCard(cardId, title, status)` | Called when a card's status changes; may return a one-line note. |
| `reconcile(when)` | Called by `mw work` before it takes cards and after it finished some, to bring an outside view (a board) level with every card (`host.cards()`); may return one line to print. |
| `harness` | Harnesses by id (`{run(request)}`), each listed under `harnesses`. Roles name them in `runs:` and `mw_delegate` accepts them, once the package is installed and enabled; they are advisory (no `mode: write`). Run the agent CLI through `host.agent` (below), so the runtime's protections apply. The engine gives a package harness no MCP servers (`request.mcp` is undefined, and `mw check` warns about servers offered to its roles), turns an error it throws into a failed result classified by the shared transient and quota table, and counts it as a paid harness for the usage guard. |
| `commands` | `mw <command>` subcommands: `(args, out) => exitCode`. A name the core uses is never replaced. |
| `tools` | MCP tools for `mw mcp serve`: `name` (`mw_<lowercase>`), `description`, `inputSchema` (checked before the call), `write` (refused inside a card run), `handler(args, {signal})` returning text or a value sent as JSON. |
| `checks` | `mw doctor` lines: `{name, run()}` returning `{ok, detail}`. |

A part the package may not provide (another package's queue kind, an undeclared harness, a tool not
named `mw_*`) is left out and reported. A package that fails to load is reported once and skipped;
it never stops a command that does not need it.

## What `host` gives you

A package never imports MergeWright's own files: in the single executable they exist only inside
the bundle. Everything comes through `host`:

| Member | Gives |
|---|---|
| `apiVersion`, `project.root`, `project.name` | Which API and which project. |
| `config` | The package's settings, already checked against its `config` schema (`{}` when there are none). |
| `docs.paths`, `docs.exclude`, `docs.files()`, `docs.head()`, `docs.blob(commit, rel)` | The project's documentation, read from git: the tracked files of `docs.paths` minus `docs.exclude`, the commit HEAD names, and one file as a blob of a commit (`{kind: "file", content}`, `{kind: "missing"}`, or `{kind: "skipped", why}` for a path outside `docs.paths`, a link or a binary file). |
| `localDir` | This machine's folder for the package, `.mergewright/local/packages/<name>/`: never committed or file-synced, for caches and per-machine state. It may not exist yet. |
| `log(line)` | One line on standard error, prefixed with the package's name. Never log a secret. |
| `queue.enqueue(kind, summary, payload, lastError?)`, `queue.drop(match)` | This machine's delivery queue, for the package's own kinds. |
| `http.json(url, opts)` | JSON over HTTP with a timeout (10 s by default); errors are `host.errors.HttpError` with the status (0 for no answer). `opts.body` is sent as JSON; `opts.form` (a `FormData`) is sent as multipart/form-data instead, for a file upload: `form.append("file", new Blob([text]), "name.md")`. |
| `errors` | `HttpError`, `PartialDelivery`, `Dropped`, `BudgetCut` (thrown by `exec` when a queue flush's time budget stopped the command; rethrow it). |
| `exec(cmd, args, {cwd?, timeoutMs?, input?})`, `which(cmd)` | Run a command without a shell and wait for it (`{code, stdout, stderr, timedOut}`; default timeout 30 s, cut to what is left of a queue flush's budget; `input` goes to its standard input), and find an executable on PATH. |
| `agent.run({name, cmd, args, req, env?, stdin?})` | For a harness: run an agent CLI as the built-in harnesses do. It starts in `req.cwd` with the runtime's minimal environment plus `req.env` and `env`, in its own process group, stopped after `req.limits.minutes` (SIGTERM, then SIGKILL) or when `req.signal` aborts; the output kept in memory is capped, and the whole of it is streamed, redacted with `req.secrets`, to private files `<label>.<name>.stdout|stderr` in `req.runDir`. Resolves with `{code, signal, stdout, stderr, timedOut, aborted, missing, spawnError?, seconds}`; never throws. |
| `agent.saveText(req, suffix, content)`, `agent.failedRun(name, run)`, `agent.timeoutResult(name, run, minutes, text?)`, `agent.exitFailure(name, run, extra?)` | Write `<label>.<suffix>` in the run folder (private, redacted; a prompt file, say), and turn a run into a result: aborted or never started, timed out, or a non-zero exit marked transient or quota by the shared table. |
| `selfCommand`, `sshAgent()` | How to start this runtime (`{command, args}`, for an MCP server entry, say), and the SSH agent socket a process of this user can use. |
| `process.identity(pid)`, `process.alive({pid, started?})` | A process instance (its start time where `/proc` exists, as pids are reused), and whether it still runs. |
| `machine` | This machine's name (`MW_HOST`, else the host name). |
| `cards()` | Every card with its live status (`{id, title, status}`: its run's status when it has a readable run, else its card file's). |
| `readFile(rel)`, `listFiles(rel, suffix?)` | Files of the project; a path outside it is refused. |
| `env(name)` | The value of a variable the manifest declares under `secrets` or `env`; undefined for any other. |
| `yaml.parse`, `yaml.stringify(value, options?)`, `yaml.parseDocument`, `yaml.isMap` | The runtime's YAML library; `parseDocument` gives a yaml Document for edits that keep comments and layout. |
| `redact(text)` | The text with the declared secrets' values and anything shaped like a credential blanked. |
| `lessonId(lesson)` | The stable id of a lesson (from project, topic and title), shared by every memory store. |

## Tips

- Write the entry in plain JavaScript (`.mjs`) unless you need TypeScript; a `.ts` entry needs a Node
  that strips types. For editor hints, copy the types you use from `src/packages/api.ts`.
- Keep secrets in environment variables named in `secrets`, never in settings.
- Test a package the way `test/packages-mem0.test.ts` tests the official `mem0` one: a temporary
  project, `mw add <path> --yes`, and a fake service on loopback.
- The official packages in `packages/` are complete examples; `packages/mem0` provides recall,
  search, a memory store, tools and a check; `packages/letta` the same, with a per-machine cache in
  `host.localDir`; `packages/open-notebook` a documentation mirror (`docsSync`, a deliverer,
  `searchDocs`, a command, tools and a check); `packages/cline-kanban` a card mirror run through a
  CLI (`mirrorCard`, `reconcile`, a deliverer, a command, tools and a check, with `host.exec`);
  `packages/hermes` a harness (`runs: hermes`, through `host.agent`), a command that edits another
  tool's YAML config under a lock (`host.yaml.parseDocument`, `host.process`) and two checks.
- `packages/board-4ga` is a card mirror over HTTP (`mirrorCard`, `reconcile`, a deliverer, a command
  and a check, with two secrets). It was written from the 4ga Boards source at commit
  `538edfc3e85b174529c2c65cd289e3cc5d3cf88e` and has not been run against a live 4ga Boards instance;
  only its tests' fake server has answered it.
- `packages/notebook-opennotelm` is a documentation mirror that uploads files (`docsSync`, a
  deliverer, a command and a check, with `host.http.json`'s `form`). It was written from the
  OpenNoteLM source at commit `c709bfa0c31641f3aecca468c8be16ebee01a353` and has not been run against
  a live OpenNoteLM instance; only its tests' fake server has answered it.
