// External services (docs/design/engine.md section 7). Every method is a successful no-op when its
// service is not configured, and never throws because a service is down: the undelivered item goes
// to this machine's queue (.mergewright/local/queue/) and `mw queue flush` retries it. Only forgeMerge throws (MwError
// merge/conflict | merge/failed), because the engine needs its answer.
import fs from "node:fs";
import path from "node:path";
import type { CoreIntegrations, DocsSyncOutcome, Integrations, LessonRecord, ServiceIntegrations } from "./engine/types.ts";
import { errMessage, HttpError, lessonId } from "./integrations/common.ts";
import { forgeMerge, type ForgeSettings } from "./integrations/forge.ts";
import { deliverNotify, type NotifyPayload } from "./integrations/notify.ts";
import { PartialDelivery, Queue, type Deliver, type DeliverContext, type DeliveryCounts, type FlushOptions, type FlushResult } from "./integrations/queue.ts";
import { usageGate, type UsageSettings } from "./integrations/usage.ts";
import { locksDir, REPO_LOCK } from "./engine/registry.ts";
import { localDir, type Project } from "./project.ts";
import { decisionRecords, lessonRecords } from "./memory.ts";
import { activeExports } from "./packages/loader.ts";
import type { MemorySession, MemoryStore } from "./packages/api.ts";
import { git, MwError } from "./util.ts";

/** Every integration's settings, resolved from the config (undefined = not configured). */
export interface IntegrationSettings {
  notify?: string;
  usage: UsageSettings;
  forge?: ForgeSettings;
}

export function integrationSettings(project: Project): IntegrationSettings {
  const c = project.config;
  return {
    notify: c.report?.command?.trim() || undefined,
    usage: {
      command: c.usage?.command?.trim() || undefined,
      pauseAtPct: c.usage?.pauseAtPct ?? 85,
      resumeBelowPct: c.usage?.resumeBelowPct ?? 80,
      localDir: localDir(project),
      cwd: project.root,
    },
    forge: c.git.forge.kind === "none" ? undefined : { kind: c.git.forge.kind, url: c.git.forge.url, repo: c.git.forge.repo, tokenEnv: c.git.forge.tokenEnv },
  };
}

/**
 * Deliver a queued item's records one at a time (queue kind: the name of the package whose memory store it is). A record the service
 * already holds with the same text (same `lesson_id`; an earlier write that timed out may have landed)
 * is skipped. After each record the claimed item is rewritten with the rest (`ctx.progress`), so a
 * delivery cut short never sends a record twice. The first error stops the item: a `PartialDelivery`
 * keeps the records not yet delivered, with the counts `mw queue flush` reports.
 */
async function deliverRecords(
  lessons: LessonRecord[],
  ctx: DeliverContext,
  svc: { present: (l: LessonRecord) => Promise<boolean>; store: (l: LessonRecord) => Promise<unknown>; summary: (rest: LessonRecord[]) => string },
): Promise<DeliveryCounts> {
  const counts: DeliveryCounts = { total: lessons.length, delivered: 0, present: 0 };
  for (let i = 0; i < lessons.length; i++) {
    const l = lessons[i]!;
    try {
      if (await svc.present(l)) counts.present++;
      else {
        await svc.store(l);
        counts.delivered++;
      }
    } catch (e) {
      const rest = lessons.slice(i);
      throw new PartialDelivery(errMessage(e), { lessons: rest }, svc.summary(rest), counts);
    }
    const rest = lessons.slice(i + 1);
    if (rest.length) ctx.progress({ lessons: rest }, svc.summary(rest));
  }
  return counts;
}

/** How each queued kind of the core is delivered. Each throws to keep its item queued. Packages add theirs (`flushQueue`). */
export function deliverers(project: Project): Record<string, Deliver> {
  const s = integrationSettings(project);
  const missing = (what: string) => async () => { throw new Error(`${what} is not configured`); };
  const { notify } = s;
  return {
    notify: notify ? (p) => deliverNotify(notify, localDir(project), project.root, p as NotifyPayload) : missing("report.command"),
  };
}

/** Hits one outside source (a package's `search` or `searchDocs`) gave for a query, or why it gave none. */
export interface RemoteHits {
  name: string;
  hits: string[];
  error?: string;
}

/** Ask one outside source; a failure becomes its `error`, never a throw. */
export async function remoteHits(name: string, f: () => Promise<string[]>): Promise<RemoteHits> {
  try {
    return { name, hits: await f() };
  } catch (e) {
    return { name, hits: [], error: errMessage(e) };
  }
}

/**
 * The semantic stores' lessons for a query (`mw memory search`): every enabled package's `search`, in the
 * order mergewright.yaml lists them, each labelled by its name; hits, or why there are none.
 */
export async function searchRemoteLessons(project: Project, query: string, limit: number): Promise<RemoteHits[]> {
  return Promise.all(await packageSearches(project, query, limit));
}

/** Every enabled package's `search` for a query, in the order mergewright.yaml lists them (memory search). */
export async function packageSearches(project: Project, query: string, limit: number): Promise<Promise<RemoteHits>[]> {
  const fromPackages = (await activeExports(project)).filter((p) => typeof p.exports.search === "function");
  return fromPackages.map((p) => remoteHits(p.name, () => p.exports.search!(query, limit)));
}

/** A memory store's name: the name of a package that provides `remember` (e.g. `mem0`, `letta`). */
export type MemoryService = string;

/** A memory store as the delivery code sees it: its queue kind (`service`), a summary prefix and a session per batch. */
interface Store {
  service: MemoryService;
  /** Prefix of a queued item's summary, e.g. "mem0 (demo)". */
  label: string;
  open(): MemorySession;
}

function lessonSummary(label: string, lessons: LessonRecord[]): string {
  return `${label}: ${lessons.length} lesson(s): ${lessons.map((l) => l.title).join("; ")}`;
}

/** The names of the packages that provide a memory store, from their manifests (nothing is loaded). */
function packageStoreNames(project: Project): string[] {
  return project.packages.filter((p) => !p.error && p.manifest?.exports?.includes("remember")).map((p) => p.name);
}

/** Every store: the loaded packages' (`remember`). */
async function allStores(project: Project): Promise<Store[]> {
  const names = new Set(packageStoreNames(project));
  const fromPackages = (await activeExports(project)).flatMap(({ name, exports: ex }) => {
    const r = ex.remember;
    return r && typeof r.open === "function" && names.has(name) ? [{ service: name, label: typeof r.label === "string" && r.label ? r.label : name, open: () => r.open() }] : [];
  });
  return fromPackages;
}

/** The stores by name, for `mw memory prune`: the package's own `prune`, if it has one. */
export async function packageStore(project: Project, name: string): Promise<MemoryStore | undefined> {
  return (await activeExports(project)).find((p) => p.name === name)?.exports.remember;
}

/** The deliverer of a store's queue kind: one record at a time (`deliverRecords`). */
function recordDeliverer(st: Store): Deliver {
  return async (p, ctx) => {
    const session = st.open();
    return deliverRecords((p as { lessons: LessonRecord[] }).lessons, ctx, {
      present: (l) => session.present(l),
      store: (l) => session.store(l),
      summary: (rest) => lessonSummary(st.label, rest),
    });
  };
}

/** The loaded packages' deliverers: their own, and one for each memory store's kind (its name). */
async function packageDeliverers(project: Project): Promise<Record<string, Deliver>> {
  const out: Record<string, Deliver> = {};
  for (const { exports: ex } of await activeExports(project)) Object.assign(out, ex.deliverers ?? {});
  for (const st of await allStores(project)) out[st.service] ??= recordDeliverer(st);
  return out;
}

/** What `storeMemory` did with one service's records. */
export interface ServiceDelivery {
  service: MemoryService;
  /** Inserted now. */
  stored: number;
  /** The service already holds the record with this text (same lesson id); nothing sent. */
  present: number;
  /**
   * Queued on this machine: the service did not answer (`error` says why), or the records were recorded
   * under the repository lock to be delivered after it (`enqueueMemory`); `mw queue flush` delivers them.
   */
  queued: number;
  /** Refused by the service (it answered with an error); not queued. */
  failed: number;
  /** The first error, when anything was queued or failed (never holds a secret: it is the HTTP error line). */
  error?: string;
}

/** One line per service, e.g. "stored in mem0" or "queued for letta (down: ...)". */
export function describeDelivery(d: ServiceDelivery): string {
  const parts: string[] = [];
  if (d.stored) parts.push(`stored in ${d.service}`);
  if (d.present) parts.push(`already in ${d.service}`);
  if (d.queued) parts.push(d.error ? `queued for ${d.service} (down: ${d.error})` : `queued for ${d.service}`);
  if (d.failed) parts.push(`failed in ${d.service} (${d.error ?? "refused"})`);
  return parts.join(", ") || `nothing for ${d.service}`;
}

const recordKey = (project: string, l: LessonRecord) => `${lessonId(project, l)}\0${l.body.replace(/\s+/g, " ").trim()}`;

/** A service that answered with an error about this item (4xx other than 408/429): retrying will not help. */
const refused = (e: unknown) => e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;

/** The kinds whose records `waiting` (queue items) already hold, by record key. */
function waitingRecords(project: Project, queue: Queue, service: MemoryService): Set<string> {
  return new Set(queue.list().filter((q) => q.item.kind === service).flatMap((q) => ((q.item.payload as { lessons?: LessonRecord[] } | undefined)?.lessons ?? []).map((x) => recordKey(project.config.name, x))));
}

/**
 * REQ-engine-008: record lessons and decisions for the semantic stores (packages) in
 * this machine's queue, without a request: the delivery half of `storeMemory` runs later, from the
 * queue (`deliverers`). Synchronous, so it is safe under the repository lock and the lease. A record
 * already waiting in the queue for a service is not queued again. Each item is held for this process
 * (`holdPid`, `holdStart`), so no other flush delivers it while the lock or the lease is still held;
 * the holder's transaction clears the hold only once it released both (`deliverQueued`), and otherwise
 * the hold lasts as long as the holder process, whose end leaves a hold nobody honours. Called through
 * `storeMemory` under the lock (no transaction takes the files), the hold likewise lasts until the
 * process ends. A service whose item could not be written counts its records as failed (`error`
 * says why), with no file. Returns what was recorded per service and the item files written, for
 * `deliverQueued` once the lock and the lease are released. The reflect phase (`remember`) records
 * its files in `reflected`; this process's `flushQueue`, reached only after the lease is released,
 * clears their holds first.
 */
export function enqueueMemory(project: Project, records: LessonRecord[], opts: { only?: MemoryService } = {}): { deliveries: ServiceDelivery[]; files: string[] } {
  const queue = queueFor(project);
  const deliveries: ServiceDelivery[] = [];
  const files: string[] = [];
  const one = (service: MemoryService, label: string) => {
    try {
      const waiting = waitingRecords(project, queue, service);
      const rest = records.filter((x) => !waiting.has(recordKey(project.config.name, x)));
      // Held for this process until its transaction has released the lock and the lease (`Queue.unhold`);
      // strict, so a queue that cannot be written is reported as failed, never as queued.
      if (rest.length) files.push(queue.add(service, lessonSummary(label, rest), { lessons: rest }, undefined, { hold: true, strict: true }));
      deliveries.push({ service, stored: 0, present: 0, queued: records.length, failed: 0 });
    } catch (e) {
      deliveries.push({ service, stored: 0, present: 0, queued: 0, failed: records.length, error: errMessage(e) });
    }
  };
  // Synchronous: a package's store is known from its manifest, so nothing of it runs under the lock.
  for (const service of packageStoreNames(project)) if (opts.only === undefined || opts.only === service) one(service, service);
  return { deliveries, files };
}

/** True when this process holds the project's repository lock (`.mergewright/local/locks/repo.lock`). */
function underRepoLock(project: Project): boolean {
  try {
    return (JSON.parse(fs.readFileSync(path.join(locksDir(project), REPO_LOCK), "utf8")) as { pid?: unknown }).pid === process.pid;
  } catch {
    return false;
  }
}

/**
 * Store lessons and decisions in the semantic stores (packages), idempotently: a record
 * the service already holds with the same text (same `lesson_id`) is not sent again. Each service is
 * handled on its own. When a service does not answer, the records not yet stored are queued exactly as
 * the reflect phase queues them (kind: the package's name, delivered by its store), skipping any already
 * waiting in the queue; a record the service refuses counts as failed and the rest continue.
 * `mw memory add`, `mw memory push` and `mw_memory_push` use this; they hold no lock. REQ-engine-008:
 * called while this process holds the repository lock, it only records the records in the queue
 * (`enqueueMemory`) and sends nothing; the locked `mw_memory_add` calls `enqueueMemory` itself and has
 * its transaction deliver them after the lock and the lease are released.
 */
export async function storeMemory(project: Project, records: LessonRecord[], opts: { only?: MemoryService } = {}): Promise<ServiceDelivery[]> {
  if (underRepoLock(project)) return enqueueMemory(project, records, opts).deliveries;
  const queue = queueFor(project);
  const out: ServiceDelivery[] = [];
  const run = async (st: Store) => {
    const service = st.service;
    const d: ServiceDelivery = { service, stored: 0, present: 0, queued: 0, failed: 0 };
    out.push(d);
    let session: MemorySession;
    try {
      session = st.open();
    } catch (e) {
      d.error = errMessage(e);
      d.failed = records.length;
      return;
    }
    for (let i = 0; i < records.length; i++) {
      const l = records[i]!;
      try {
        if (await session.present(l)) { d.present++; continue; }
        await session.store(l);
        d.stored++;
      } catch (e) {
        d.error ??= errMessage(e);
        if (refused(e)) { d.failed++; continue; }
        // Down: queue this record and the rest (never one already waiting), then stop asking this service.
        const waiting = waitingRecords(project, queue, service);
        const rest = records.slice(i).filter((x) => !waiting.has(recordKey(project.config.name, x)));
        if (rest.length) queue.add(service, lessonSummary(st.label, rest), { lessons: rest }, errMessage(e));
        d.queued += records.length - i;
        break;
      }
    }
  };
  for (const st of await allStores(project)) if (opts.only === undefined || opts.only === st.service) await run(st);
  return out;
}

/** The names of the memory stores this project has (the enabled packages that provide one). */
export function memoryServices(project: Project): MemoryService[] {
  return packageStoreNames(project);
}

/**
 * `mw memory push` / `mw_memory_push`: every lesson and/or decision file in memory/ to the configured
 * semantic stores (or the one named), through `storeMemory` (so a second push stores nothing new).
 */
export async function pushMemory(project: Project, opts: { lessons?: boolean; decisions?: boolean; only?: MemoryService } = {}): Promise<{ records: number; deliveries: ServiceDelivery[] }> {
  const names = memoryServices(project);
  if (opts.only && !names.includes(opts.only)) {
    throw new MwError(`${opts.only}/not-configured`, `${opts.only} is not a memory store of this project (no enabled package of that name provides one)`);
  }
  if (!names.length) throw new MwError("memory/no-service", "no memory service is configured (install a package that provides one, e.g. 'mw add mem0' or 'mw add letta')");
  const both = !opts.lessons && !opts.decisions;
  const records = [...(both || opts.lessons ? lessonRecords(project) : []), ...(both || opts.decisions ? decisionRecords(project) : [])];
  return { records: records.length, deliveries: records.length ? await storeMemory(project, records, { only: opts.only }) : [] };
}

/** "mem0: 3 stored, 2 already present, 0 queued, 0 failed" */
export function describeCounts(d: ServiceDelivery): string {
  return `${d.service}: ${d.stored} stored, ${d.present} already present, ${d.queued} queued, ${d.failed} failed${d.error ? ` (${d.error})` : ""}`;
}

/** This machine's queue (`.mergewright/local/queue/`). */
export function queueFor(project: Project): Queue {
  return new Queue(localDir(project));
}

/**
 * The shared queue folder an older runtime wrote (`.mergewright/queue/`). It is file-synced, so both
 * machines see the same items, so they are never moved in automatically (each
 * machine would deliver its copy). `mw doctor` reports them and the owner runs `mw queue adopt` on one
 * machine.
 */
export function legacyQueueDir(project: Project): string {
  return path.join(project.workDir, "queue");
}

/** Items an older runtime left in the shared queue folder (claimed ones included). */
export function legacyQueueItems(project: Project): string[] {
  try {
    return fs.readdirSync(legacyQueueDir(project)).filter((n) => !n.startsWith(".") && (n.endsWith(".json") || /\.json\.claimed-\d+$/.test(n)));
  } catch {
    return [];
  }
}

/**
 * REQ-engine-008: the queue items the reflect phase (`remember`) wrote in this process, held for it
 * (`enqueueMemory`) so no other flush delivers them while its lock and lease are held. Kept per project,
 * keyed by that project's queue directory (`queueFor(project).dir`): `flushQueue(project)` releases
 * only its own project's holds (never an MCP transaction's, never another project's) before it flushes.
 */
const reflected = new Map<string, Set<string>>();

/** The flush budget `flushQueue` gives by default (FLUSH_BUDGET_MS). Mutable for tests only. */
export const queueTiming: { budgetMs?: number } = {};

/**
 * Retry every queued item in order; delivered items are deleted. The queue is this machine's own, so
 * this needs no lease: the other machine never sees these items. Bounded by a time budget and the
 * per-kind breaker (`Queue.flush`, REQ-engine-009); `mw queue flush` passes `budgetMs: Infinity` and
 * `breaker: false`, because the owner asked for every item now.
 */
export async function flushQueue(project: Project, opts: FlushOptions = {}): Promise<FlushResult[]> {
  // Every caller reaches this only after the lease is released, so the reflect phase's items are ours now.
  const queue = queueFor(project);
  const own = reflected.get(queue.dir);
  if (own) {
    reflected.delete(queue.dir);
    // Defensive: only files in this project's own queue directory are released.
    releaseHolds(project, [...own].filter((f) => path.dirname(f) === queue.dir));
  }
  // A package delivers its kinds unless the core has a deliverer of the same kind (the core's wins).
  const core = deliverers(project);
  const merged: Record<string, Deliver> = { ...core };
  for (const [kind, d] of Object.entries(await packageDeliverers(project))) if (!(kind in core)) merged[kind] = d;
  return queue.flush(merged, { budgetMs: queueTiming.budgetMs, ...opts });
}

const inFlight = new Set<Promise<void>>();

/**
 * REQ-engine-008: clear this process's hold on the queue items `files` (`enqueueMemory`), once the
 * transaction that recorded them has ended; they are then plainly queued for any flush. Never throws.
 */
export function releaseHolds(project: Project, files: string[]): void {
  if (files.length) queueFor(project).unhold(files);
}

/**
 * REQ-engine-008: deliver the queue items `files` (written under the repository lock, `enqueueMemory`)
 * in the background, once the lock and the lease are released; nobody awaits it. Their holds are
 * cleared first (`releaseHolds`), and `only` would override them anyway. Bounded like every
 * flush; an error leaves the items queued (with their attempt counts) and is written to standard error,
 * never thrown. `settleDeliveries` waits for it.
 */
export function deliverQueued(project: Project, files: string[]): void {
  if (!files.length) return;
  releaseHolds(project, files);
  const p: Promise<void> = (async () => {
    try {
      for (const r of await flushQueue(project, { only: files })) {
        if (!r.ok && !r.skipped) process.stderr.write(`mw: ${r.dropped ? "dropped" : "kept"} queued ${r.kind} item (${r.summary}): ${r.error}\n`);
      }
    } catch (e) {
      process.stderr.write(`mw: delivering queued items failed: ${errMessage(e)}; they stay queued for 'mw queue flush'\n`);
    }
  })().finally(() => inFlight.delete(p));
  inFlight.add(p);
}

/** How many background deliveries of this process (`deliverQueued`) are running now. */
export function deliveriesInFlight(): number {
  return inFlight.size;
}

/** Wait until every background delivery of this process (`deliverQueued`) has ended. */
export async function settleDeliveries(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}

/** The part every project has: notifications, the usage guard and the forge merge. */
function coreIntegrations(project: Project, s: IntegrationSettings, queue: Queue): CoreIntegrations {
  return {
    async notify(subject, body) {
      if (!s.notify) return;
      try {
        await deliverNotify(s.notify, localDir(project), project.root, { subject, body });
      } catch (e) {
        queue.add("notify", `notify: ${subject}`, { subject, body } satisfies NotifyPayload, errMessage(e));
      }
    },

    async usageOk() {
      try {
        return usageGate(s.usage);
      } catch (e) {
        return { ok: true, detail: `usage guard could not run: ${errMessage(e)}` };
      }
    },

    async forgeMerge(req) {
      if (!s.forge) return undefined;
      return forgeMerge(s.forge, req, path.join(project.workDir, "runs", req.card));
    },
  };
}

/** The removable services: semantic memory, the documentation mirror and the card board. */
function serviceIntegrations(project: Project, s: IntegrationSettings, queue: Queue): ServiceIntegrations {
  return {
    async recall(query, limit) {
      if (limit <= 0 || !query.trim()) return [];
      // Each enabled package's hits, in the order mergewright.yaml lists them; a service that does not
      // answer adds nothing.
      const from = async (f: () => Promise<string[]>) => { try { return await f(); } catch { return []; } };
      const packages = (await activeExports(project)).filter((p) => typeof p.exports.recall === "function");
      const fromPackages = await Promise.all(packages.map((p) => from(() => p.exports.recall!(query, limit))));
      return [...new Set(fromPackages.flat().filter((x): x is string => typeof x === "string"))];
    },

    async remember(lessons) {
      if (!lessons.length) return;
      // REQ-engine-008: the reflect phase runs under the card's lock and the lease, so the lessons are
      // only queued (kind: the package's name, one item per store) and nothing is sent here.
      // The items are held for this process until its own flush after the lease is released
      // (`flushQueue` clears this project's holds in `reflected`), so no other flush delivers them
      // earlier. Each store is queued on its own; one whose item could not be written is reported by the
      // error (the caller, `memoryUpdate`, records it as a warning and the phase goes on).
      const { deliveries, files } = enqueueMemory(project, lessons);
      if (files.length) {
        const own = reflected.get(queue.dir) ?? new Set<string>();
        for (const f of files) own.add(f);
        reflected.set(queue.dir, own);
      }
      const failed = deliveries.filter((d) => d.failed);
      if (failed.length) throw new Error(failed.map((d) => `${d.failed} lesson(s) for ${d.service} were not queued (${d.error})`).join("; "));
    },

    async docsSync(changed, deleted, commit) {
      // Each enabled package that mirrors documentation gets the same files; one that throws is reported and skipped.
      const mirrors = (await activeExports(project)).filter((x) => typeof x.exports.docsSync === "function");
      if (!mirrors.length) return "none";
      let c: string;
      try {
        // The batch names its commit, so a retry from the queue sends what that commit held.
        c = commit ?? git(project.root, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();
      } catch (e) {
        process.stderr.write(`mw: docs: not sent, because the commit to read them from is unknown: ${errMessage(e)}\n`);
        return "failed";
      }
      const outcomes: (DocsSyncOutcome | void)[] = [];
      for (const p of mirrors) {
        try {
          outcomes.push(await p.exports.docsSync!(changed, deleted, c));
        } catch (e) {
          process.stderr.write(`mw: ${p.name}: docs not sent: ${errMessage(e)}\n`);
          outcomes.push("failed");
        }
      }
      return outcomes.find((o) => o && o !== "none") ?? "none";
    },

    async mirrorCard(cardId, title, status) {
      const notes: (string | void)[] = [];
      for (const p of (await activeExports(project)).filter((x) => typeof x.exports.mirrorCard === "function")) {
        try {
          notes.push(await p.exports.mirrorCard!(cardId, title, status));
        } catch (e) {
          notes.push(`${p.name}: status not mirrored: ${errMessage(e)}`);
        }
      }
      const said = notes.filter((n): n is string => typeof n === "string" && !!n);
      return said.length ? said.join("; ") : undefined;
    },
  };
}

/**
 * Every enabled package's `reconcile` (`mw work`, before taking cards and after finishing): the lines
 * they returned, in the order mergewright.yaml lists them. One that throws gives a line saying so.
 */
export async function reconcilePackages(project: Project, when: string): Promise<string[]> {
  const lines: string[] = [];
  for (const p of (await activeExports(project)).filter((x) => typeof x.exports.reconcile === "function")) {
    try {
      const line = await p.exports.reconcile!(when);
      if (typeof line === "string" && line) lines.push(line);
    } catch (e) {
      lines.push(`${p.name}: could not reconcile: ${errMessage(e)}`);
    }
  }
  return lines;
}

/** One object for the engine: the core's own behaviour composed with the services. */
export function integrationsFor(project: Project): Integrations {
  const s = integrationSettings(project);
  const queue = queueFor(project);
  return { ...coreIntegrations(project, s, queue), ...serviceIntegrations(project, s, queue) };
}
