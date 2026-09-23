"use strict";

// retrieve() end to end with a fake collection and fake embedder. No network, no model.

const test = require("node:test");
const assert = require("node:assert/strict");

const { retrieve, unionDocuments } = require("../../src/retrieval");

const CONFIG = Object.freeze({
  mongo: { vectorCollection: "docs", vectorIndex: "vector_index", vectorField: "embedding" },
  retrieval: {
    numCandidates: 150,
    rrfK: 60,
    candidateLimit: 30,
    finalDocumentLimit: 10,
    rrfWeights: { semantic: 1, keyword: 1, metadata: 0.5 },
    impactWeight: 0,
    verifiedWeight: 0,
    minSemanticScore: 0,
    rerankEnabled: false,
    rerankCandidates: 20,
    decomposeEnabled: false,
    decomposeMaxSubqueries: 3,
    keywordEnabled: false,
  },
});

const hit = (id, extra = {}) => ({
  id,
  title: `doc ${id}`,
  tags: ["java"],
  content_full: `content ${id}`,
  metadata: { domain: "skills", subcategory: ["backend"], verified: true, impact_score: 50 },
  ...extra,
});

function fakeCollection(semantic = [], mongo = []) {
  return {
    aggregate: () => ({ toArray: async () => semantic }),
    find: () => ({ limit: () => ({ toArray: async () => mongo }) }),
  };
}

const embedder = { embedQuery: async () => new Array(768).fill(0.1) };

const base = (overrides = {}) => ({
  config: CONFIG,
  embedder,
  collection: fakeCollection([hit("a", { score: 0.9 }), hit("b", { score: 0.8 })]),
  ...overrides,
});

test("returns ranked documents and a sanitized view", async () => {
  const result = await retrieve("what are his backend skills?", base());

  assert.deepEqual(result.documents.map((d) => d.id), ["a", "b"]);
  assert.equal(result.sanitized.length, 2);
  assert.equal(result.sanitized[0].title, "doc a");
  assert.equal(result.sanitized[0].metadata.impact_score, undefined, "never leaks to the prompt");
});

test("ranked documents carry their scoring breakdown", async () => {
  const [top] = (await retrieve("backend skills", base())).documents;

  assert.ok(Number.isFinite(top.score));
  assert.ok(Number.isFinite(top.rrf_score));
  assert.equal(top.semantic_score, 0.9);
  assert.deepEqual(top.retrieval_sources, { semantic: 1 });
});

test("topSemanticScore is the pool's best match, measured before the gate drops anything", async () => {
  // Phase 9's weak-retrieval signal. Taken from the whole pool, so a gate that drops
  // every candidate still reports how close the best one came.
  const gated = { ...CONFIG, retrieval: { ...CONFIG.retrieval, minSemanticScore: 0.95 } };

  const result = await retrieve("q", base({ config: gated }));
  assert.equal(result.documents.length, 0, "both hits are under the 0.95 floor");
  assert.equal(result.topSemanticScore, 0.9);

  const empty = await retrieve("q", base({ collection: fakeCollection([]) }));
  assert.equal(empty.topSemanticScore, 0, "nothing matched at all");
});

test("the semantic floor drops candidates below it and keeps the rest", async () => {
  const gated = { ...CONFIG, retrieval: { ...CONFIG.retrieval, minSemanticScore: 0.85 } };
  const result = await retrieve("q", base({ config: gated }));
  assert.deepEqual(result.documents.map((d) => d.id), ["a"]);
});

test("the final limit is honoured", async () => {
  const collection = fakeCollection(
    Array.from({ length: 25 }, (_, i) => hit(`d${i}`, { score: 0.5 })),
  );

  const result = await retrieve("q", base({ collection, limit: 3 }));
  assert.equal(result.documents.length, 3);
});

test("a greeting skips retrieval entirely", async () => {
  let aggregateCalls = 0;
  const collection = {
    aggregate: () => {
      aggregateCalls += 1;
      return { toArray: async () => [] };
    },
    find: () => ({ limit: () => ({ toArray: async () => [] }) }),
  };

  const result = await retrieve("hello", base({ collection }));

  assert.equal(aggregateCalls, 0, "no vector search for small talk");
  assert.deepEqual(result.documents, []);
  assert.equal(result.plans[0].requires_retrieval, false);
});

test("works with no models supplied at all", async () => {
  const result = await retrieve("what projects has he built?", base());

  assert.deepEqual(result.subqueries, ["what projects has he built?"]);
  assert.equal(result.plans[0].domain, "projects");
  assert.ok(result.documents.length > 0);
});

test("a failing arm is reported without losing the turn", async () => {
  const collection = {
    aggregate: () => ({
      toArray: async () => {
        throw new Error("atlas down");
      },
    }),
    find: () => ({ limit: () => ({ toArray: async () => [hit("m")] }) }),
  };

  const result = await retrieve("what are his backend skills?", base({ collection }));

  assert.deepEqual(result.failedArms, [{ source: "semantic", message: "atlas down" }]);
  assert.deepEqual(result.documents.map((d) => d.id), ["m"]);
});

test("decompose fans out and the union dedupes", async () => {
  const config = {
    ...CONFIG,
    retrieval: { ...CONFIG.retrieval, decomposeEnabled: true },
  };
  const models = {
    decompose: {
      withStructuredOutput: () => ({
        invoke: async () => ({ subqueries: ["backend skills", "ai projects"] }),
      }),
    },
  };

  const result = await retrieve("backend and ai?", base({ config, models }));

  assert.deepEqual(result.subqueries, ["backend skills", "ai projects"]);
  assert.equal(result.plans.length, 2);
  // The same two documents come back for both sub-queries; the union must not duplicate.
  assert.deepEqual(result.documents.map((d) => d.id), ["a", "b"]);
});

test("rerank runs only when enabled, and its failure is absorbed", async () => {
  const config = { ...CONFIG, retrieval: { ...CONFIG.retrieval, rerankEnabled: true } };
  const models = {
    rerank: {
      withStructuredOutput: () => ({
        invoke: async () => {
          throw new Error("rerank exploded");
        },
      }),
    },
  };

  const result = await retrieve("backend skills", base({ config, models }));

  assert.deepEqual(result.documents.map((d) => d.id), ["a", "b"], "input order survives");
});

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

test("union sums rrf score across sub-queries and keeps the best semantic score", () => {
  const merged = unionDocuments([
    [{ id: "a", rrf_score: 0.01, semantic_score: 0.5, content_full: null }],
    [{ id: "a", rrf_score: 0.02, semantic_score: 0.9, content_full: "prose" }],
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].rrf_score, 0.03);
  assert.equal(merged[0].semantic_score, 0.9);
  assert.equal(merged[0].content_full, "prose", "the richer copy wins");
});

test("union merges retrieval sources and skips documents without an id", () => {
  const merged = unionDocuments([
    [{ id: "a", retrieval_sources: { semantic: 1 } }, { title: "no id" }],
    [{ id: "a", retrieval_sources: { metadata: 3 } }],
  ]);

  assert.deepEqual(merged[0].retrieval_sources, { semantic: 1, metadata: 3 });
  assert.equal(merged.length, 1);
});
