// A MergeWright project on disk: its config and every file the conventions give meaning to.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { Diagnostics } from "./diagnostics.ts";
import type { Risk } from "./expr.ts";
import { parseCard, type Card } from "./model/card.ts";
import { parseFlow, type Flow } from "./model/flow.ts";
import { parseMcp, type Mcp } from "./model/mcp.ts";
import { checkRole, parseRole, type Role } from "./model/role.ts";
import { parseSpec, type Requirement, type Spec } from "./model/spec.ts";
import { PRESET_DIR, SPEC_VERSION } from "./paths.ts";
import { validateIssues } from "./schemas.ts";
import { enabledPackages, packageHarnesses, type EnabledPackage } from "./packages/registry.ts";
import { listFiles, MwError, readIfExists, readText, toPosix } from "./util.ts";

export const CONFIG_FILE = "mergewright.yaml";
/** Diagnostic codes for a config file that did not load as written (the load fell back to defaults). */
/**
 * Settings of services that left the core for a package: each is refused (REQ-config-002 reports it like
 * any schema problem) with how to move it, instead of "unknown field".
 */
export const MOVED_TO_PACKAGES: { key: string; present(raw: Raw): boolean; detail: string }[] = [
  {
    key: "memory.mem0",
    present: (raw) => !!raw.memory && typeof raw.memory === "object" && "mem0" in raw.memory,
    detail: "is no longer read: mem0 is now a package. Run 'mw add mem0', move these settings (url, user, key_env, write_timeout_ms) to packages.mem0 in mergewright.yaml, and delete memory.mem0",
  },
  {
    key: "memory.letta",
    present: (raw) => !!raw.memory && typeof raw.memory === "object" && "letta" in raw.memory,
    detail: "is no longer read: Letta is now a package. Run 'mw add letta', move these settings (url, agent, key_env, model, embedding, embedding_endpoint, embedding_dim, write_timeout_ms) to packages.letta in mergewright.yaml, and delete memory.letta",
  },
  {
    key: "docs.notebook",
    present: (raw) => !!raw.docs && typeof raw.docs === "object" && "notebook" in raw.docs,
    detail: "is no longer read: Open Notebook is now a package. Run 'mw add open-notebook', move these settings (url, name, key_env) to packages.open-notebook in mergewright.yaml, and delete docs.notebook",
  },
  {
    key: "cards.mirror",
    present: (raw) => !!raw.cards && typeof raw.cards === "object" && raw.cards.mirror === "kanban",
    detail: "is 'kanban', which is no longer read: the Kanban mirror is now the cline-kanban package. Run 'mw add cline-kanban' and delete cards.mirror",
  },
  {
    key: "cards.kanban_path",
    present: (raw) => !!raw.cards && typeof raw.cards === "object" && "kanban_path" in raw.cards,
    detail: "is no longer read: the Kanban mirror is now the cline-kanban package. Run 'mw add cline-kanban', move this setting to packages.cline-kanban.path in mergewright.yaml, and delete cards.kanban_path",
  },
];
export const CONFIG_LOAD_CODES = ["config/yaml", "config/schema"];
/** Runtime working data: never committed, never authoritative. */
export const WORK_DIR = ".mergewright";
/**
 * Inside WORK_DIR, what belongs to one machine: run locks, the lease observation, the integration
 * queue, temporary files, the usage flag and discarded worktrees. `.mergewright/runs/` is the only
 * part of WORK_DIR the machines share; this folder must be excluded from file sync.
 */
export const LOCAL_DIR = "local";

/** `<root>/.mergewright/local`: this machine's own working data (see LOCAL_DIR). */
export function localDir(project: { readonly root: string }): string {
  return path.join(project.root, WORK_DIR, LOCAL_DIR);
}
/** Folders whose contents the conventions define. */
export const RESERVED_DIRS = ["specs", "cards", "roles", "flows", "gates", "mcps", "memory", "docs"] as const;

export interface Config {
  version: string;
  name: string;
  description: string;
  extends: string;
  /** `mirror` is always "none": a board mirror is a package now (MOVED_TO_PACKAGES). */
  cards: { prefix: string; defaultFlow: string; mirror: "none" };
  git: { base: string; hub: string; forge: { kind: "none" | "gitea" | "github"; url?: string; repo?: string; tokenEnv?: string } };
  protected: string[];
  /** Environment variable names gates are allowed to see; `required`: step names that must not be skipped. */
  gate: { env: string[]; required: string[] };
  risk: { default: Risk; deepReview: string[] };
  limits: { rounds: number; turns: number; minutes: number; diffChars: number; leaseMinutes: number; phaseVisits: number; transientRetries: number };
  trace: {
    tests: string[]; ignore: string[]; requireTests: "none" | "must" | "should"; requireImplements: boolean;
    /** REQ-engine-007: days the raw stdout and stderr streams of a finished run are kept (`trace.raw_days`). */
    rawDays: number;
  };
  memory: {
    stateMaxLines: number;
    rulesMaxLines: number;
  };
  docs: { paths: string[]; exclude: string[] };
  /** `roles.<id>` as written (`fallback_model` becomes the role's `fallbackModel` when applied). */
  roles: Record<string, Partial<Pick<Role, "runs" | "model" | "provider" | "profile" | "command">> & { fallback_model?: string }>;
  localModels?: { endpoint?: string; fallback?: string; keyEnv?: string };
  report?: { command?: string };
  usage?: { command?: string; pauseAtPct?: number; resumeBelowPct?: number };
  /** `sandbox`: how write-mode Claude agents are confined (spec 8.6); `MW_SANDBOX` overrides it per machine. */
  agents: { sandbox: "auto" | "off" | "required" };
  /** `packages.<name>`: the enabled packages and each one's own settings, as written (EXPERIMENTAL). */
  packages: Record<string, unknown>;
}

export const DEFAULT_PROTECTED = [
  "specs/*.spec.md", "memory/RULES.md", CONFIG_FILE, "roles/**", "flows/**", "gates/**", "mcps/**", "docs/adr/**", "AGENTS.md", "CLAUDE.md",
];
/** Files that count as tests: by name (`x.test.ts`, `x_test.go`, `test_x.py`, `x.spec.js`) or by folder. */
export const DEFAULT_TEST_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/test_*.*", "**/*Test.*", "**/*Tests.*", "**/tests/**", "**/test/**", "**/__tests__/**", "**/spec/**"];

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Apply defaults to a parsed (and schema-checked) config file. */
export function normalizeConfig(raw: Raw): Config {
  const prefix = raw.cards?.prefix ?? (String(raw.name ?? "CARD").replace(/[^a-zA-Z]/g, "").slice(0, 4).toUpperCase() || "CARD");
  return {
    version: String(raw.mergewright ?? ""),
    name: String(raw.name ?? ""),
    description: String(raw.description ?? ""),
    extends: raw.extends ?? "standard",
    cards: { prefix, defaultFlow: raw.cards?.default_flow ?? "standard", mirror: "none" },
    git: {
      base: raw.git?.base ?? "main",
      hub: raw.git?.hub ?? "none",
      forge: { kind: raw.git?.forge?.kind ?? "none", url: raw.git?.forge?.url, repo: raw.git?.forge?.repo, tokenEnv: raw.git?.forge?.token_env },
    },
    protected: raw.protected ?? DEFAULT_PROTECTED,
    gate: { env: raw.gate?.env ?? [], required: raw.gate?.required ?? [] },
    risk: { default: raw.risk?.default ?? "medium", deepReview: raw.risk?.deep_review ?? ["concurrency", "auth", "transactions", "caching", "migrations", "payments"] },
    limits: {
      rounds: raw.limits?.rounds ?? 2,
      turns: raw.limits?.turns ?? 60,
      minutes: raw.limits?.minutes ?? 90,
      diffChars: raw.limits?.diff_chars ?? 60000,
      leaseMinutes: raw.limits?.lease_minutes ?? 10,
      phaseVisits: raw.limits?.phase_visits ?? 6,
      transientRetries: raw.limits?.transient_retries ?? 2,
    },
    trace: { tests: raw.trace?.tests ?? DEFAULT_TEST_GLOBS, ignore: raw.trace?.ignore ?? [], requireTests: raw.trace?.require_tests ?? "must", requireImplements: raw.trace?.require_implements ?? true, rawDays: raw.trace?.raw_days ?? 14 },
    memory: {
      stateMaxLines: raw.memory?.state_max_lines ?? 150,
      rulesMaxLines: raw.memory?.rules_max_lines ?? 100,
    },
    docs: {
      paths: raw.docs?.paths ?? ["docs/**", "README.md"],
      exclude: raw.docs?.exclude ?? [],
    },
    roles: raw.roles ?? {},
    localModels: raw.local_models ? { endpoint: raw.local_models.endpoint, fallback: raw.local_models.fallback, keyEnv: raw.local_models.key_env } : undefined,
    report: raw.report,
    usage: raw.usage ? { command: raw.usage.command, pauseAtPct: raw.usage.pause_at_pct, resumeBelowPct: raw.usage.resume_below_pct } : undefined,
    agents: { sandbox: raw.agents?.sandbox ?? "auto" },
    packages: raw.packages ?? {},
  };
}

/** Walk up from `start` to the folder that holds mergewright.yaml. */
export function findRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export class Project {
  readonly root: string;
  readonly config: Config;
  /** Problems found while loading files (syntax and schema). Cross-file rules are added by `check`. */
  readonly diag = new Diagnostics();
  readonly presetDir: string | undefined;
  /** The enabled packages (manifests only; nothing of theirs has run). */
  readonly packages: EnabledPackage[];
  /** Harness ids the usable enabled packages contribute, by id -> package name. */
  readonly packageHarnesses: Map<string, string>;

  private _specs?: Spec[];
  private _cards?: Card[];
  private _roles?: Map<string, Role>;
  private _flows?: Map<string, Flow>;
  private _mcps?: Map<string, Mcp>;

  /** `configText` stands in for the config file's contents (to check a change before it is written). */
  constructor(root: string, opts: { configText?: string } = {}) {
    this.root = root;
    const text = opts.configText ?? readText(path.join(root, CONFIG_FILE));
    let raw: Raw = {};
    try {
      const parsed = YAML.parse(text) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Raw;
      else this.diag.error("config/yaml", CONFIG_FILE, "the config file must be a mapping of fields", 1);
    } catch (e) {
      this.diag.error("config/yaml", CONFIG_FILE, `not valid YAML: ${(e as Error).message.split("\n")[0]}`, 1);
    }
    const moved = MOVED_TO_PACKAGES.filter((m) => m.present(raw));
    const schemaProblems = validateIssues("config", raw).filter((i) => !moved.some((m) => i.key === m.key || i.key.startsWith(`${m.key}.`)));
    for (const m of moved) schemaProblems.push({ key: m.key, detail: m.detail, message: `'${m.key}' ${m.detail}` });
    for (const i of schemaProblems) this.diag.error("config/schema", CONFIG_FILE, i.message, 1, i);
    // A config that fails its schema may hold values of the wrong type; fall back to defaults for the rest of the load.
    this.config = normalizeConfig(schemaProblems.length ? { mergewright: raw.mergewright, name: typeof raw.name === "string" ? raw.name : "" } : raw);
    if (this.config.version && this.config.version !== SPEC_VERSION) {
      this.diag.error("config/version", CONFIG_FILE, `this project targets specification ${this.config.version}; this runtime implements ${SPEC_VERSION} (run 'mw upgrade')`, 1);
    }
    this.packages = enabledPackages(root, this.config.packages);
    for (const p of this.packages) if (p.error) this.diag.error("config/package", CONFIG_FILE, p.error, 1);
    this.packageHarnesses = packageHarnesses(this.packages);
    const preset = path.join(PRESET_DIR, this.config.extends);
    if (fs.existsSync(preset)) this.presetDir = preset;
    else this.diag.error("config/preset", CONFIG_FILE, `unknown preset '${this.config.extends}' (available: ${fs.existsSync(PRESET_DIR) ? fs.readdirSync(PRESET_DIR).join(", ") : "none"})`, 1);
  }

  /** Load the project that contains `start`. */
  static load(start: string = process.cwd()): Project {
    const root = findRoot(start);
    if (!root) throw new MwError("no-project", `no ${CONFIG_FILE} found in ${path.resolve(start)} or any folder above it (run 'mw init' to create a project)`);
    return new Project(root);
  }

  /** `load`, for a command that writes, commits, takes the lease or runs a phase: refused on an invalid config. */
  static loadRunnable(start: string = process.cwd()): Project {
    const project = Project.load(start);
    project.assertRunnable();
    return project;
  }

  /**
   * The config file's load errors (not valid YAML, or failing its schema), in the order they were
   * found, one line each as "<key path>: <message>" (`limits.turns: must be integer`, `limits.typo:
   * unknown field`). A YAML error, or a violation of the file as a whole, has the file's name as its
   * path. On these the load fell back to defaults for the whole config, so a read-only command
   * reports them and a writing command refuses. The one place these lines are built.
   */
  configErrors(): string[] {
    return this.diag.items
      .filter((d) => d.file === CONFIG_FILE && CONFIG_LOAD_CODES.includes(d.code))
      .map((d) => `${d.key || CONFIG_FILE}: ${d.detail ?? d.message}`);
  }

  /**
   * REQ-config-001, REQ-config-003: refuse (`config/invalid`) unless the config loaded as written. A
   * config that fails its schema is loaded with every setting at its default (git.hub none, agents.sandbox
   * auto), so a run, a write or a commit on it would silently ignore the owner's settings.
   */
  assertRunnable(): void {
    const errors = this.configErrors();
    if (!errors.length) return;
    throw new MwError("config/invalid", [
      `${CONFIG_FILE} is invalid (config/invalid), so nothing was run, written or committed. ${errors.length} error(s):`,
      ...errors.map((e) => `  ${e}`),
      `Fix ${CONFIG_FILE}, then run 'mw check' to confirm the project loads.`,
    ].join("\n"));
  }

  rel(file: string): string {
    return toPosix(path.relative(this.root, file));
  }
  abs(rel: string): string {
    return path.join(this.root, rel);
  }
  get workDir(): string {
    return path.join(this.root, WORK_DIR);
  }
  /** True when this checkout is a card worktree rather than the project's main checkout. */
  get isWorktree(): boolean {
    return toPosix(this.root).includes(`/${WORK_DIR}/worktrees/`);
  }

  specs(): Spec[] {
    if (!this._specs) {
      this._specs = [];
      for (const f of listFiles(this.abs("specs"), ".spec.md")) {
        const s = parseSpec(this.rel(f), readText(f), this.diag);
        if (s) this._specs.push(s);
      }
    }
    return this._specs;
  }

  /** Every requirement by id. When an id is defined in two files the first wins (and `check` reports it). */
  requirements(): Map<string, Requirement> {
    const out = new Map<string, Requirement>();
    for (const s of this.specs()) for (const r of s.requirements) if (!out.has(r.id)) out.set(r.id, r);
    return out;
  }

  cards(): Card[] {
    if (!this._cards) {
      this._cards = [];
      for (const f of listFiles(this.abs("cards"), ".card.md")) {
        const c = parseCard(this.rel(f), readText(f), this.diag);
        if (c) this._cards.push(c);
      }
      this._cards.sort((a, b) => cardNumber(a.id) - cardNumber(b.id) || a.id.localeCompare(b.id));
    }
    return this._cards;
  }

  card(id: string): Card {
    const c = this.cards().find((x) => x.id === id);
    if (!c) throw new MwError("no-card", `there is no card ${id} (looked for cards/${id}.card.md)`);
    return c;
  }

  /** Project files override preset files of the same name. */
  private layered<T extends { id: string }>(dir: string, suffix: string, parse: (rel: string, text: string, origin: string) => T | undefined): Map<string, T> {
    const out = new Map<string, T>();
    const layers: [string, string][] = [];
    if (this.presetDir) layers.push([path.join(this.presetDir, dir), this.config.extends]);
    layers.push([this.abs(dir), "project"]);
    for (const [folder, origin] of layers) {
      for (const f of listFiles(folder, suffix)) {
        const rel = origin === "project" ? this.rel(f) : `preset:${this.config.extends}/${dir}/${path.basename(f)}`;
        const item = parse(rel, readText(f), origin);
        if (item) out.set(item.id, item);
      }
    }
    return out;
  }

  roles(): Map<string, Role> {
    if (!this._roles) {
      this._roles = this.layered("roles", ".role.md", (rel, text, origin) => parseRole(rel, text, origin, this.diag, this.packageHarnesses));
      for (const [id, o] of Object.entries(this.config.roles)) {
        const r = this._roles.get(id);
        if (r) {
          const { fallback_model: fallback, ...rest } = o;
          Object.assign(r, rest);
          if (fallback !== undefined) r.fallbackModel = fallback; // the config's alternate overrides the role file's
          checkRole(r, CONFIG_FILE, this.diag, this.packageHarnesses);
        } else this.diag.error("config/role-override", CONFIG_FILE, `'roles.${id}' overrides a role that does not exist`, 1);
      }
    }
    return this._roles;
  }

  flows(): Map<string, Flow> {
    this._flows ??= this.layered("flows", ".flow.yaml", (rel, text, origin) => parseFlow(rel, text, origin, this.diag));
    return this._flows;
  }

  mcps(): Map<string, Mcp> {
    this._mcps ??= this.layered("mcps", ".mcp.yaml", (rel, text, origin) => parseMcp(rel, text, origin, this.diag));
    return this._mcps;
  }

  /** Gate id -> absolute path of its executable. */
  gates(): Map<string, string> {
    const out = new Map<string, string>();
    const folders = [this.presetDir ? path.join(this.presetDir, "gates") : undefined, this.abs("gates")];
    for (const folder of folders) {
      if (!folder) continue;
      for (const f of listFiles(folder, ".gate.sh")) out.set(path.basename(f, ".gate.sh"), f);
    }
    return out;
  }

  /** Which flow a card runs: its own choice, else by kind, else the project default. */
  flowFor(card: Card): string {
    if (card.flow) return card.flow;
    if (card.kind === "docs" && this.flows().has("docs")) return "docs";
    if (card.kind === "spike" && this.flows().has("spike")) return "spike";
    return this.config.cards.defaultFlow;
  }

  /**
   * Whether a card asks for the deep review: it says so itself, or one of its tags names a
   * subject the project lists under `risk.deep_review` (concurrency, auth, ...).
   */
  deepReviewOf(card: Card): boolean {
    const subjects = new Set(this.config.risk.deepReview.map((s) => s.toLowerCase()));
    return card.deepReview || card.tags.some((t) => subjects.has(t.toLowerCase()));
  }

  riskOf(card: Card): Risk {
    return card.risk ?? this.config.risk.default;
  }

  memoryFile(name: "STATE.md" | "RULES.md" | "INDEX.md"): string {
    return this.abs(path.join("memory", name));
  }
  readMemory(name: "STATE.md" | "RULES.md" | "INDEX.md"): string {
    return readIfExists(this.memoryFile(name)) ?? "";
  }
}

export function cardNumber(id: string): number {
  return Number(id.slice(id.lastIndexOf("-") + 1));
}
