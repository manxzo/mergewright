// Tool group "memory": the project's own memory (memory/ in the repository) and the memory stores of
// enabled packages. These are the "self-update memory" tools: lessons and decisions and the current
// state (a package such as mem0 or letta brings its own free-memory tools).
import { describeCounts, describeDelivery, enqueueMemory, memoryServices, pushMemory, searchRemoteLessons, type MemoryService } from "../../integrations.ts";
import { addDecision, addLesson, searchMemory, setState, writeIndex } from "../../memory.ts";
import { CARD_ID, redactSecrets, slugify } from "../../util.ts";
import { insideProject, writeAndCommit } from "../repo.ts";
import { searchData } from "../data.ts";
import { need, num, S, schema, str, withData, type ToolDef } from "../tool.ts";

export const tools: ToolDef[] = [
  {
    name: "mw_memory_add",
    description: "Record a lesson (memory/lessons/<topic>.md; same title replaces the old entry) or a decision (memory/decisions/) in the project's memory, commit what it wrote (with memory/INDEX.md) alone as 'memory: <title>' on the base branch, and queue it for each memory store of an enabled package (such as mem0): the reply says it is queued; the delivery runs once the repository lock and the lease are released, or, when this machine keeps the lease, at the next queue flush after this process ends ('mw queue' lists what still waits). Secrets are blanked.",
    write: true,
    locked: true,
    inputSchema: schema({
      kind: S.oneOf(["lesson", "decision"], "what to record"),
      topic: S.str("lesson topic, e.g. testing (lessons only)"),
      title: S.str("one line"),
      body: S.str("the lesson or decision, with its reason"),
      card: { type: "string", pattern: CARD_ID.source, description: "card id it came from, e.g. DEMO-3" },
    }, ["kind", "title", "body"]),
    handler: async (a, ctx) => {
      const project = ctx.project();
      const kind = need(a, "kind");
      const title = need(a, "title").trim().replace(/\s+/g, " ");
      const body = redactSecrets(need(a, "body")).trim();
      const card = str(a, "card");
      let done = "";
      let topic: string;
      let file = "";
      if (kind === "lesson") {
        topic = slugify(need(a, "topic"));
        file = `memory/lessons/${topic}.md`;
        insideProject(project, file, "memory/path");
      } else {
        topic = "decision";
        insideProject(project, "memory/decisions/x.md", "memory/path");
      }
      insideProject(project, "memory/INDEX.md", "memory/path");
      // Branch, git identity and repository lock are checked before anything is written; a failed
      // commit puts every file back (spec section 12.5).
      const committed = writeAndCommit(project, {
        branchCode: "memory/branch", what: "memory", subject: `memory: ${title}`,
        files: kind === "lesson" ? [file, "memory/INDEX.md"] : ["memory/INDEX.md"],
        dirs: kind === "lesson" ? [] : ["memory/decisions"],
      }, () => {
        if (kind === "lesson") {
          done = `lesson ${addLesson(project, { topic, title, body, card })} in memory/lessons`;
        } else {
          file = addDecision(project, { title, body, card });
          done = `created ${file}`;
        }
        writeIndex(project);
        return [file, "memory/INDEX.md"];
      });
      done += `\n${committed}`;
      // REQ-engine-008: under the lock the record only goes into this machine's queue; the transaction
      // delivers it (idempotently by lesson id, as `mw memory add` does) once it has released the lock
      // and the lease, or leaves it for the next flush when this machine keeps the lease.
      if (memoryServices(project).length) {
        const q = enqueueMemory(project, [{ topic, title, body, card }]);
        ctx.deliverAfterRelease?.(q.files);
        // The transaction (repoTransaction) adds the line saying when they are delivered.
        const queued = q.deliveries.filter((d) => !d.failed);
        if (queued.length) done += `\n${queued.map(describeDelivery).join(", ")}`;
        // A queue item that could not be written: the commit stands, and nothing claims a delivery.
        for (const d of q.deliveries.filter((x) => x.failed)) {
          done += `\nthe lesson is committed to memory/, but it could not be put in this machine's delivery queue for ${d.service} (${d.error ?? "unknown error"}); run 'mw memory push' to send it to ${d.service}`;
        }
      }
      return done;
    },
  },
  {
    name: "mw_memory_push",
    description: "Push every lesson and/or decision file in memory/ to the memory stores of enabled packages (such as mem0), or to one of them. Idempotent: a record a service already holds with the same text (same lesson id) is not sent again; a service that is down gets the rest queued on this machine. Returns counts per service (stored, already present, queued, failed).",
    write: true,
    inputSchema: schema({
      lessons: S.bool("push the lessons (with decisions false or absent and lessons absent too: both)"),
      decisions: S.bool("push the decisions"),
      service: S.str("only this service: an enabled package's name, e.g. mem0 (default: every one)"),
    }),
    handler: async (a, ctx) => {
      const r = await pushMemory(ctx.project(), { lessons: a.lessons === true, decisions: a.decisions === true, only: str(a, "service") as MemoryService | undefined });
      return [`${r.records} record(s) in memory/`, ...r.deliveries.map(describeCounts)].join("\n");
    },
  },
  {
    name: "mw_memory_search",
    result: "SearchData",
    description: "Search the project's memory (lessons, decisions, outcomes) and the lessons of each enabled package that searches memory (labelled by its name, e.g. 'mem0').",
    inputSchema: schema({ query: S.str("words to look for"), limit: S.int("at most this many hits from each (default 5)") }, ["query"]),
    handler: async (a, ctx) => {
      const project = ctx.project();
      const query = need(a, "query");
      const limit = num(a, "limit") ?? 5;
      const hits = searchMemory(project, query, limit);
      const local = hits.map((h) => ({ file: h.file, title: h.title, text: h.text }));
      const remote = await searchRemoteLessons(project, query, limit);
      const shown = (r: { name: string; hits: string[]; error?: string }) => (r.error ? `${r.name} did not answer: ${r.error}` : r.hits);
      return withData("SearchData", { project: local, ...Object.fromEntries(remote.map((r) => [r.name, shown(r)])) }, searchData(query, hits, remote));
    },
  },
  {
    name: "mw_memory_state",
    description: "Replace memory/STATE.md: where the project is now (starts with a '# ' heading; at most memory.state_max_lines lines). Not a history. Commits the file alone as 'memory: state' on the base branch.",
    write: true,
    locked: true,
    inputSchema: schema({ text: S.str("the whole new STATE.md") }, ["text"]),
    handler: (a, ctx) => {
      const project = ctx.project();
      const text = redactSecrets(need(a, "text"));
      insideProject(project, "memory/STATE.md", "memory/path");
      const committed = writeAndCommit(project, { branchCode: "memory/branch", what: "memory", files: ["memory/STATE.md"], subject: "memory: state" }, () => {
        setState(project, text);
        return ["memory/STATE.md"];
      });
      return `memory/STATE.md replaced\n${committed}`;
    },
  },
];
