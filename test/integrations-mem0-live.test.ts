// Live test of the mem0 package against a real self-hosted mem0 server. Runs only with MW_LIVE=1,
// MW_MEM0_URL (the server) and MW_MEM0_KEY (its API key, never printed). Everything is stored in a
// throwaway namespace that the test deletes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { flushQueue, integrationsFor } from "../src/integrations.ts";
import { lessonId } from "../src/integrations/common.ts";
import { mem0Config } from "./helpers.ts";
import { projectWith, queueItems } from "./fixtures/integrations/support.ts";

const URL_ = process.env.MW_MEM0_URL ?? "";
const skip = process.env.MW_LIVE !== "1" ? "set MW_LIVE=1 to run" : !URL_ || !process.env.MW_MEM0_KEY ? "set MW_MEM0_URL and MW_MEM0_KEY to run" : false;

/** Key names with value types, recursively: the shape of a reply without its content. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
  return v === null ? "null" : typeof v;
}

test("live mem0 package: remember and flush two lessons, recall one, delete the namespace", { skip }, async (t) => {
  const ns = `mw-test-${Math.random().toString(36).slice(2, 10)}`;
  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${URL_}${path}`, { ...init, headers: { "content-type": "application/json", "X-API-Key": process.env.MW_MEM0_KEY! } });
    return (await res.json()) as { results?: { metadata?: unknown }[] };
  };
  const { dir, project } = projectWith(mem0Config({ url: URL_, user: ns, key_env: "MW_MEM0_KEY" }));
  try {
    await integrationsFor(project).remember([
      { topic: "testing", title: "Gate before merge", body: "Always run the project gate before merging a card branch.", card: "DEMO-1" },
      { topic: "git", title: "Squash merges", body: "Squash-merge card branches so the base history stays one commit per card." },
    ]);
    // REQ-engine-008: remember only queues; the flush delivers.
    assert.equal(queueItems(dir).length, 1, "remember queued one item");
    await flushQueue(project, { budgetMs: Infinity });
    assert.deepEqual(queueItems(dir), [], "the flush delivered (nothing left queued)");

    const hits = await integrationsFor(project).recall("run the gate before merging", 1);
    t.diagnostic(`recall returned ${hits.length} line(s); first starts with: ${JSON.stringify(hits[0]?.slice(0, 20))}`);
    assert.equal(hits.length, 1);
    assert.match(hits[0]!, /^Gate before merge: Always run the project gate/);

    const search = await api("/search", { method: "POST", body: JSON.stringify({ query: "squash", filters: { user_id: ns }, top_k: 2 }) });
    t.diagnostic(`POST /search reply shape: ${JSON.stringify(shape(search))}`);
    assert.deepEqual(search.results?.[0]?.metadata, { topic: "git", title: "Squash merges", project: "demo", lesson_id: lessonId("demo", { topic: "git", title: "Squash merges" }) });
  } finally {
    await api(`/memories?user_id=${encodeURIComponent(ns)}`, { method: "DELETE" });
    const left = await api(`/memories?user_id=${encodeURIComponent(ns)}&top_k=1`);
    assert.equal(left.results?.length ?? 0, 0, "namespace emptied");
  }
});
