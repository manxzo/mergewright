#!/usr/bin/env node
// Fake `kanban` CLI (shapes copied from kanban 0.1.70): state in $FAKE_KANBAN_STATE,
// every call appended to its `calls`. $FAKE_KANBAN_DOWN=1 behaves like a CLI with no runtime.
import fs from "node:fs";
const stateFile = process.env.FAKE_KANBAN_STATE;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { tasks: [], calls: [], next: 1 };
const argv = process.argv.slice(2);
state.calls.push(argv);
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const print = (v, code = 0) => { save(); process.stdout.write(JSON.stringify(v, null, 2) + "\n"); process.exit(code); };
if (process.env.FAKE_KANBAN_DOWN === "1") print({ ok: false, error: "Task command failed at http://127.0.0.1:3484: fetch failed" }, 1);
const [group, cmd] = argv;
if (group !== "task") print({ ok: false, error: `unsupported: ${argv.join(" ")}` }, 1);
const workspacePath = opt("--project-path") ?? process.cwd();
// $FAKE_KANBAN_PATHS (paths joined by ":"): the only projects the board knows, like a real runtime.
const known = process.env.FAKE_KANBAN_PATHS;
if (known && !known.split(":").includes(workspacePath)) print({ ok: false, error: `Task command failed at http://127.0.0.1:3484: Project ${workspacePath} is not added to Kanban yet.` }, 1);
if (cmd === "list") {
  const column = opt("--column");
  const col = column === "done" ? "trash" : column;
  const tasks = state.tasks
    .filter((t) => (col ? t.column === col : t.column !== "trash"))
    .map((t) => ({ id: t.id, prompt: t.prompt, column: t.column, baseRef: "main", session: null })); // no title, like the real CLI
  print({ ok: true, workspacePath, column: column ?? null, tasks, dependencies: [], count: tasks.length });
}
if (cmd === "create") {
  const t = { id: `t${state.next++}`, title: opt("--title"), prompt: opt("--prompt"), column: "backlog" };
  state.tasks.push(t);
  print({ ok: true, task: { ...t, workspacePath, baseRef: "main" } });
}
if (cmd === "trash" || cmd === "done") {
  const t = state.tasks.find((x) => x.id === opt("--task-id"));
  if (!t) print({ ok: false, error: `Task command failed at http://127.0.0.1:3484: Task "${opt("--task-id")}" was not found` }, 1);
  t.column = "trash";
  print({ ok: true, workspacePath, task: { id: t.id, column: "trash" } });
}
print({ ok: false, error: `unsupported in fake: ${cmd}` }, 1);
