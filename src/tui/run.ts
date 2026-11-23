// The TUI loop: keys -> reduce -> effects -> settle -> draw.
import { Project } from "../project.ts";
import { loadData, type Data } from "./data.ts";
import { execute, toolLog } from "./effects.ts";
import { defaultCtx, initState, reduce, refreshEffects, settle, type Effect, type Result, type State } from "./model.ts";
import { paint, render } from "./render.ts";
import { openTerm, type Term } from "./term.ts";

/** Re-read the project; when it cannot be read, keep the last data and say why. */
function reload(root: string, last: Data): { data: Data; problem?: string } {
  try {
    return { data: loadData(new Project(root)) };
  } catch (e) {
    return { data: last, problem: (e as Error).message };
  }
}

/** What the loop calls outside itself; tests replace them. */
export interface TuiDeps {
  execute(root: string, effect: Effect): Promise<Result>;
  /** A line for the owner after the terminal is restored (a write that failed while quitting). */
  report(line: string): void;
}

const defaultDeps: TuiDeps = { execute, report: (line) => process.stderr.write(`${line}\n`) };

/**
 * Run the TUI until it quits. Quitting stops key handling, lets every effect already queued finish
 * (a confirmed save is never cut short), then resolves: 0, or 1 when a write failed on the way out,
 * after reporting it.
 */
export async function runTui(project: Project, term: Term = openTerm(), deps: TuiDeps = defaultDeps): Promise<number> {
  const root = project.root;
  const failures: string[] = [];
  try {
    let state: State = initState(loadData(project));
    const draw = () => term.draw(paint(render(state, term.columns(), term.rows())));
    let queue: Promise<void> = Promise.resolve();
    let quitting = false;
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });

    const runEffects = async (effects: Effect[]) => {
      for (const effect of effects) {
        if (effect.kind === "quit") continue; // handled by dispatch: the queue drains, then the loop ends
        const result = await deps.execute(root, effect);
        // A tool call goes through the tool layer, which reads the project afresh: nothing to re-read here.
        const changed = effect.kind !== "probe" && effect.kind !== "tool";
        const r = changed ? reload(root, state.data) : { data: state.data };
        const outcome = r.problem ? { ok: false, message: r.problem } : result;
        if (quitting && !outcome.ok && (changed || (effect.kind === "tool" && effect.into === "action"))) failures.push(`${describe(effect)}: ${outcome.message}`);
        state = settle(state, effect, outcome, r.data);
        draw();
      }
    };
    const dispatch = (key: string) => {
      if (quitting) return; // no new keys once quitting: only what is already queued still runs
      const next = reduce(state, key, defaultCtx);
      state = next.state;
      draw();
      // Effects run one after another, in key order, so a save never races the next key's save.
      if (next.effects.length) queue = queue.then(() => runEffects(next.effects));
      if (next.effects.some((e) => e.kind === "quit")) {
        quitting = true;
        // A failure of an effect queued before the quit is still shown in the TUI, and reported after.
        void queue.then(done, done);
      }
    };

    term.onKey(dispatch);
    term.onResize(draw);
    draw();
    queue = queue.then(() => runEffects([{ kind: "probe" }, ...refreshEffects(state)]));
    await finished;
    await queue.catch(() => undefined);
  } finally {
    term.restore();
  }
  for (const f of failures) deps.report(`mw tui: not saved while quitting: ${f}`);
  for (const l of toolLog.splice(0)) deps.report(l);
  return failures.length ? 1 : 0;
}

function describe(effect: Effect): string {
  switch (effect.kind) {
    case "save": return `set ${effect.key}`;
    case "eject": return `eject ${effect.what} ${effect.id}`;
    case "mcp-add": return `add mcp ${effect.spec.id}`;
    case "mcp-remove": return `remove mcp ${effect.id}`;
    case "mcp-roles": return `roles of mcp ${effect.id}`;
    case "tool": return `${effect.name} ${String(effect.args.id ?? "")}`.trim();
    default: return effect.kind;
  }
}
