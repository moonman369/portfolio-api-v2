"use strict";

// Fusion and arm selection. Pure logic plus a fake Mongo collection — no network.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fuseByRRF,
  buildMetadataQuery,
  buildKeywordQuery,
  searchAllArms,
  normalizeDocument,
} = require("../../src/retrieval/search");

const CONFIG = Object.freeze({
  mongo: { vectorCollection: "docs", vectorIndex: "vector_index", vectorField: "embedding" },
  retrieval: {
    numCandidates: 150,
    rrfK: 60,
    candidateLimit: 30,
    rrfWeights: { semantic: 1, keyword: 1, metadata: 0.5 },
    keywordEnabled: true,
  },
});

const doc = (id, extra = {}) => ({ id, title: `doc ${id}`, content_full: "c", ...extra });

// ---------------------------------------------------------------------------
// RRF
// ---------------------------------------------------------------------------

test("rrf score is the weighted sum of reciprocal ranks", () => {
  const fused = fuseByRRF([{ source: "semantic", documents: [doc("a"), doc("b")] }], { k: 60 });

  // rank 1 -> 1/61, rank 2 -> 1/62
  assert.equal(fused[0].rrf_score, Number((1 / 61).toFixed(8)));
  assert.equal(fused[1].rrf_score, Number((1 / 62).toFixed(8)));
});

test("a document found by two arms accumulates score from both", () => {
  const fused = fuseByRRF(
    [
      { source: "semantic", documents: [doc("a")] },
      { source: "metadata", documents: [doc("a")] },
    ],
    { k: 60, weights: { semantic: 1, metadata: 0.5 } },
  );

  assert.equal(fused.length, 1);
  assert.equal(fused[0].rrf_score, Number((1 / 61 + 0.5 / 61).toFixed(8)));
  assert.deepEqual(fused[0].retrieval_sources, { semantic: 1, metadata: 1 });
});

test("per-arm weights change the contribution", () => {
  const weighted = fuseByRRF([{ source: "metadata", documents: [doc("a")] }], {
    k: 60,
    weights: { metadata: 0.5 },
  });
  const unweighted = fuseByRRF([{ source: "metadata", documents: [doc("a")] }], { k: 60 });

  assert.ok(weighted[0].rrf_score < unweighted[0].rrf_score);
});

test("the raw semantic score is carried through untouched", () => {
  const fused = fuseByRRF([{ source: "semantic", documents: [doc("a", { score: 0.87 })] }], {
    k: 60,
  });

  assert.equal(fused[0].semantic_score, 0.87);
});

test("a metadata-only hit gets semantic_score 0", () => {
  const fused = fuseByRRF([{ source: "metadata", documents: [doc("a")] }], { k: 60 });

  assert.equal(fused[0].semantic_score, 0);
});

test("the copy carrying content wins over a contentless one", () => {
  const fused = fuseByRRF(
    [
      { source: "metadata", documents: [{ id: "a", title: "thin", content_full: null }] },
      { source: "semantic", documents: [{ id: "a", title: "rich", content_full: "prose" }] },
    ],
    { k: 60 },
  );

  assert.equal(fused[0].content_full, "prose");
  assert.equal(fused[0].title, "rich");
});

test("documents without an id, and malformed result sets, are skipped", () => {
  const fused = fuseByRRF(
    [
      { source: "semantic", documents: [null, { title: "no id" }, doc("a")] },
      null,
      { source: "keyword" },
    ],
    { k: 60 },
  );

  assert.deepEqual(fused.map((d) => d.id), ["a"]);
});

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

test("metadata query filters on domain and subcategory", () => {
  const query = buildMetadataQuery({
    filters: { domain: ["skills"] },
    subcategories: ["backend"],
    entities: { dates: {} },
  });

  assert.deepEqual(query.$and[0], { "metadata.domain": { $in: ["skills"] } });
  assert.deepEqual(query.$and[1], { "metadata.subcategory": { $in: ["backend"] } });
});

test("metadata query adds caller-supplied equality filters", () => {
  const query = buildMetadataQuery({ filters: { domain: [] }, entities: { dates: {} } }, {
    verified: true,
    blank: "",
    missing: null,
  });

  assert.deepEqual(query.$and, [{ "metadata.verified": true }]);
});

test("an empty plan produces an empty query, which the caller skips", () => {
  assert.deepEqual(buildMetadataQuery({ filters: { domain: [] }, entities: { dates: {} } }), {});
});

test("keyword query drops tokens of two characters or fewer", () => {
  const query = buildKeywordQuery("the rag ai pipeline", { entities: {} });
  const tokens = query.$or.map((clause) => clause.$or[0].title.$regex);

  // "ai" goes; three-character terms like "rag" are kept, which matters for this corpus.
  assert.deepEqual(tokens, ["the", "rag", "pipeline"]);
});

test("keyword query dedupes repeated tokens", () => {
  const query = buildKeywordQuery("rag rag pipeline", { entities: {} });

  assert.equal(query.$or.length, 2);
});

test("regex metacharacters in a query are escaped", () => {
  const query = buildKeywordQuery("c++ (backend)", { entities: {} });
  const tokens = query.$or.map((clause) => clause.$or[0].title.$regex);

  assert.ok(tokens.every((token) => !token.includes("(") || token.includes("\\(")));
  assert.ok(tokens.some((token) => token.includes("\\+\\+")));
});

test("normalizeDocument keeps tags, which the old pipeline dropped", () => {
  const normalized = normalizeDocument({
    id: "a",
    title: "t",
    tags: ["java", "rag"],
    metadata: { domain: "skills", subcategory: ["backend"] },
  });

  assert.deepEqual(normalized.tags, ["java", "rag"]);
});

test("normalizeDocument nulls a domain outside the vocabulary", () => {
  const normalized = normalizeDocument({ id: "a", metadata: { domain: "nonsense" } });

  assert.equal(normalized.metadata.domain, null);
});

// ---------------------------------------------------------------------------
// Arm selection and failure
// ---------------------------------------------------------------------------

function fakeCollection(results = []) {
  return {
    aggregate: () => ({ toArray: async () => results }),
    find: () => ({ limit: () => ({ toArray: async () => results }) }),
  };
}

const fakeEmbedder = { embedQuery: async () => new Array(768).fill(0.1) };

const planWith = (arms) => ({
  retrieval_plan: arms,
  filters: { domain: ["skills"] },
  subcategories: [],
  entities: { dates: {} },
});

test("only the arms the plan enables are run", async () => {
  const result = await searchAllArms(
    { query: "q", plan: planWith({ semantic: true, keyword: false, metadata: false }), limit: 10 },
    { config: CONFIG, collection: fakeCollection([doc("a")]), embedder: fakeEmbedder },
  );

  assert.deepEqual(result.arms.map((arm) => arm.source), ["semantic"]);
});

test("the keyword arm stays off unless the config flag allows it", async () => {
  const plan = planWith({ semantic: true, keyword: true, metadata: false });
  const deps = { collection: fakeCollection([doc("a")]), embedder: fakeEmbedder };

  const disabled = await searchAllArms({ query: "pipeline", plan, limit: 10 }, {
    ...deps,
    config: { ...CONFIG, retrieval: { ...CONFIG.retrieval, keywordEnabled: false } },
  });
  assert.deepEqual(disabled.arms.map((a) => a.source), ["semantic"]);

  const enabled = await searchAllArms({ query: "pipeline", plan, limit: 10 }, {
    ...deps,
    config: CONFIG,
  });
  assert.deepEqual(enabled.arms.map((a) => a.source), ["semantic", "keyword"]);
});

test("a failing arm degrades the result instead of losing the turn", async () => {
  const collection = {
    aggregate: () => ({
      toArray: async () => {
        throw new Error("atlas is down");
      },
    }),
    find: () => ({ limit: () => ({ toArray: async () => [doc("m1")] }) }),
  };

  const result = await searchAllArms(
    { query: "q", plan: planWith({ semantic: true, keyword: false, metadata: true }), limit: 10 },
    { config: CONFIG, collection, embedder: fakeEmbedder },
  );

  assert.deepEqual(result.failed, [{ source: "semantic", message: "atlas is down" }]);
  assert.deepEqual(result.documents.map((d) => d.id), ["m1"], "the healthy arm still answers");
});
