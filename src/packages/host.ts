// The `host` object a package's activate() receives (package API v1, EXPERIMENTAL; see api.ts).
import fs from "node:fs";
import path from "node:path";
import YAML, { isMap } from "yaml";
import { BUDGET_RAN_OUT, BudgetCut, commandTimeout, HttpError, httpJson, lessonId, onPath } from "../integrations/common.ts";
import { badDocPath, docBlob, trackedDocFiles } from "../integrations/docs.ts";
import { Dropped, PartialDelivery, Queue } from "../integrations/queue.ts";
import { loadState, runDir } from "../engine/state.ts";
import { exitFailure, failedRun, runCli, saveText, timeoutResult } from "../engine/harness/proc.ts";
import { isAlive, processIdentity } from "../engine/procid.ts";
import { selfCommand } from "../paths.ts";
import { hostName } from "../hub.ts";
import { localDir, type Project } from "../project.ts";
import { baseEnv, git, MwError, redactSecrets, sh, sshAuthSock } from "../util.ts";
import { API_VERSION, type HarnessRequest, type PackageHost } from "./api.ts";
import { secretNamesOf, type EnabledPackage } from "./registry.ts";

/** A queue kind belongs to package `name` when it is `name` or `name:<anything>`. */
export const ownsKind = (name: string, kind: string): boolean => kind === name || kind.startsWith(`${name}:`);

/** The real path of `rel` inside `root`, or undefined when it does not exist; throws when it leads outside. */
function inside(root: string, rel: string): string | undefined {
  const base = fs.realpathSync(root);
  const target = path.resolve(base, rel);
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    real = target;
  }
  const r = path.relative(base, real);
  if (r.startsWith("..") || path.isAbsolute(r)) throw new MwError("package/outside", `'${rel}' is outside the project, so a package may not read it`);
  return fs.existsSync(real) ? real : undefined;
}

/** Every card with its live status: its run's status when it has a readable run, else its card file's (a done card file stands). */
function liveCards(project: Project): { id: string; title: string; status: string }[] {
  return project.cards().map((card) => {
    let status: string = card.status;
    if (status !== "done") {
      try {
        status = loadState(runDir(project, card.id))?.status ?? status;
      } catch {
        // unreadable run state: the card file's status stands
      }
    }
    return { id: card.id, title: card.title, status };
  });
}

export function makeHost(project: Project, p: EnabledPackage): PackageHost {
  const docs = project.config.docs;
  const root = project.root;
  const secrets = new Set(secretNamesOf(p));
  const readable = new Set([...secrets, ...(p.manifest?.env ?? [])]);
  const self = selfCommand();
  const queue = new Queue(localDir(project));
  const mine = (kind: string) => {
    if (!ownsKind(p.name, kind)) throw new MwError("package/queue-kind", `package '${p.name}' may only queue items of kind '${p.name}' or '${p.name}:<anything>', not '${kind}'`);
  };
  return Object.freeze({
    apiVersion: API_VERSION,
    project: Object.freeze({ root, name: project.config.name }),
    config: p.config,
    localDir: path.join(localDir(project), "packages", p.name),
    log: (line: string) => { process.stderr.write(`mw: ${p.name}: ${line}\n`); },
    queue: Object.freeze({
      enqueue(kind: string, summary: string, payload: unknown, lastError?: string): string {
        mine(kind);
        return queue.add(kind, summary, payload, lastError);
      },
      drop(match: (item: { kind: string; payload: unknown }) => boolean): number {
        return queue.drop((it) => ownsKind(p.name, it.kind) && match({ kind: it.kind, payload: it.payload }));
      },
    }),
    http: Object.freeze({ json: httpJson }),
    errors: Object.freeze({ HttpError, PartialDelivery, Dropped, BudgetCut }),
    exec(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}) {
      const limit = commandTimeout(opts.timeoutMs ?? 30_000);
      const r = sh(cmd, args, { cwd: opts.cwd ?? root, timeoutMs: limit.timeoutMs, ...(opts.input === undefined ? {} : { input: opts.input }) });
      if (r.timedOut && limit.byBudget) throw new BudgetCut(`${[cmd, ...args.slice(0, 2)].join(" ")} stopped (${BUDGET_RAN_OUT})`);
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
    },
    which: (cmd: string) => onPath(cmd),
    machine: hostName(),
    cards: () => liveCards(project),
    readFile(rel: string): string | undefined {
      const f = inside(root, rel);
      if (!f || !fs.statSync(f).isFile()) return undefined;
      return fs.readFileSync(f, "utf8");
    },
    listFiles(rel: string, suffix = ""): string[] {
      const dir = inside(root, rel);
      if (!dir) return [];
      const base = fs.realpathSync(root);
      return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
        .filter((e) => e.isFile() && e.name.endsWith(suffix))
        .map((e) => path.relative(base, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
        .sort();
    },
    env(name: string): string | undefined {
      return readable.has(name) ? process.env[name] : undefined;
    },
    yaml: Object.freeze({
      parse: (text: string) => YAML.parse(text) as unknown,
      stringify: (value: unknown, options?: object) => YAML.stringify(value, options as YAML.ToStringOptions),
      parseDocument: (text: string) => YAML.parseDocument(text) as unknown,
      isMap: (node: unknown) => isMap(node),
    }),
    selfCommand: Object.freeze({ command: self.command, args: Object.freeze([...self.args]) }),
    sshAgent: () => sshAuthSock()?.path,
    process: Object.freeze({ identity: (pid: number) => processIdentity(pid), alive: (id: { pid: number; started?: string }) => isAlive(id) }),
    agent: Object.freeze({
      run: (o: { name: string; cmd: string; args: string[]; req: HarnessRequest; env?: Record<string, string>; stdin?: string }) =>
        runCli({ harness: o.name, cmd: o.cmd, args: o.args, req: o.req, env: baseEnv({ ...o.req.env, ...(o.env ?? {}) }), ...(o.stdin === undefined ? {} : { stdin: o.stdin }) }),
      saveText,
      failedRun,
      timeoutResult,
      exitFailure,
    }),
    redact(text: string): string {
      let out = text;
      for (const n of secrets) {
        const v = process.env[n];
        if (v && v.length >= 6) out = out.split(v).join("[redacted]");
      }
      return redactSecrets(out);
    },
    lessonId: (l: { topic: string; title: string }) => lessonId(project.config.name, l),
    docs: Object.freeze({
      paths: Object.freeze([...docs.paths]),
      exclude: Object.freeze([...docs.exclude]),
      files: () => trackedDocFiles(root, docs),
      head: () => git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim(),
      blob(commit: string, rel: string) {
        // A queued batch is a file anyone on this machine could have written: its paths are checked here.
        const why = badDocPath(rel, docs.paths);
        return why ? { kind: "skipped" as const, why: `${why}, so it was not sent` } : docBlob(root, commit, rel);
      },
    }),
  });
}
