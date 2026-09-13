"use strict";

// Ranking, sanitizing and the rerank fallbacks. No model, no network.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  rankDocuments,
  sanitizeForPrompt,
  rerankDocuments,
  normalizeOrder,
} = require("../../src/retrieval/rank");

const CONFIG = Object.freeze({
  retrieval: {
    minSemanticScore: 0,
    impactWeight: 0,
    verifiedWeight: 0,
    rerankCandidates: 20,
  },
});

const opts = { config: CONFIG };

// ---------------------------------------------------------------------------
// Deterministic ranking
// ---------------------------------------------------------------------------

test("orders by rrf score descending and respects the limit", () => {
  const ranked = rankDocuments(
    [
      { id: "a", rrf_score: 0.01 },
      { id: "b", rrf_score: 0.03 },
      { id: "c", rrf_score: 0.02 },
    ],
    2,
    opts,
  );

  assert.deepEqual(ranked.map((d) => d.id), ["b", "c"]);
  assert.equal(ranked[0].score, 0.03);
});

test("ties break by id, so ordering is stable", () => {
  const ranked = rankDocuments(
    [
      { id: "zebra", rrf_score: 0.01 },
      { id: "alpha", rrf_score: 0.01 },
    ],
    5,
    opts,
  );

  assert.deepEqual(ranked.map((d) => d.id), ["alpha", "zebra"]);
});

test("boosts are inert at the default weights", () => {
  const ranked = rankDocuments(
    [
      { id: "a", rrf_score: 0.01, metadata: { impact_score: 100, verified: true } },
      { id: "b", rrf_score: 0.02, metadata: { impact_score: 0, verified: false } },
    ],
    5,
    opts,
  );

  assert.deepEqual(ranked.map((d) => d.id), ["b", "a"], "retrieval order is untouched");
  assert.equal(ranked[0].boost_score, 0);
});

test("the impact boost can overturn retrieval order once weighted", () => {
  const ranked = rankDocuments(
    [
      { id: "low-impact", rrf_score: 0.02, metadata: { impact_score: 0 } },
      { id: "high-impact", rrf_score: 0.01, metadata: { impact_score: 100 } },
    ],
    5,
    { ...opts, impactWeight: 0.05 },
  );

  assert.deepEqual(ranked.map((d) => d.id), ["high-impact", "low-impact"]);
});

test("impact_score is normalized to 0..1 and clamped", () => {
  const [ranked] = rankDocuments([{ id: "a", rrf_score: 0, metadata: { impact_score: 50 } }], 1, {
    ...opts,
    impactWeight: 1,
  });

  assert.equal(ranked.boost_score, 0.5);

  const [clamped] = rankDocuments([{ id: "a", rrf_score: 0, metadata: { impact_score: 500 } }], 1, {
    ...opts,
    impactWeight: 1,
  });
  assert.equal(clamped.boost_score, 1);
});

test("missing or null scores contribute nothing rather than NaN", () => {
  const [ranked] = rankDocuments([{ id: "a", metadata: { impact_score: null } }], 1, {
    ...opts,
    impactWeight: 1,
    verifiedWeight: 1,
  });

  assert.equal(ranked.score, 0);
  assert.ok(Number.isFinite(ranked.score));
});

test("the semantic gate drops weak matches when enabled", () => {
  const documents = [
    { id: "strong", rrf_score: 0.01, semantic_score: 0.8 },
    { id: "weak", rrf_score: 0.02, semantic_score: 0.2 },
  ];

  assert.equal(rankDocuments(documents, 5, opts).length, 2, "disabled by default");
  assert.deepEqual(
    rankDocuments(documents, 5, { ...opts, minSemanticScore: 0.5 }).map((d) => d.id),
    ["strong"],
  );
});

test("the gate drops metadata-only hits, which have no semantic score", () => {
  const ranked = rankDocuments([{ id: "meta-only", rrf_score: 0.05 }], 5, {
    ...opts,
    minSemanticScore: 0.1,
  });

  assert.deepEqual(ranked, []);
});

test("retrieval and boost contributions stay separately visible", () => {
  const [ranked] = rankDocuments([{ id: "a", rrf_score: 0.02, metadata: { verified: true } }], 1, {
    ...opts,
    verifiedWeight: 0.01,
  });

  assert.equal(ranked.retrieval_score, 0.02);
  assert.equal(ranked.boost_score, 0.01);
  assert.equal(ranked.score, 0.03);
});

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

test("impact_score never reaches the prompt", () => {
  const [sanitized] = sanitizeForPrompt([
    {
      title: "T",
      content_full: "prose",
      tags: ["java"],
      metadata: { domain: "skills", impact_score: 99, verified: true },
    },
  ]);

  assert.equal(sanitized.metadata.impact_score, undefined);
  assert.equal(sanitized.metadata.domain, "skills");
  assert.equal(sanitized.metadata.verified, true);
});

test("content falls back to the summary, then to an empty string", () => {
  const [withSummary] = sanitizeForPrompt([{ title: "T", summary_for_embedding: "summary" }]);
  const [withNeither] = sanitizeForPrompt([{ title: "T" }]);

  assert.equal(withSummary.content, "summary");
  assert.equal(withNeither.content, "");
});

test("an untitled document still gets a title", () => {
  const [sanitized] = sanitizeForPrompt([{ content_full: "c" }]);

  assert.equal(sanitized.title, "Untitled");
});

test("empty metadata is omitted entirely", () => {
  const [sanitized] = sanitizeForPrompt([
    { title: "T", metadata: { organization: "", proficiency_level: null } },
  ]);

  assert.equal(sanitized.metadata, undefined);
});

test("external_links survive only when they carry a usable entry", () => {
  const [withLinks] = sanitizeForPrompt([
    { title: "T", metadata: { domain: "skills", external_links: { portfolio: "https://x" } } },
  ]);
  const [withEmpty] = sanitizeForPrompt([
    { title: "T", metadata: { domain: "skills", external_links: { portfolio: "  " } } },
  ]);

  assert.deepEqual(withLinks.metadata.external_links, { portfolio: "https://x" });
  assert.equal(withEmpty.metadata.external_links, undefined);
});

test("sanitizing tolerates junk input", () => {
  assert.deepEqual(sanitizeForPrompt(null), []);
  assert.deepEqual(sanitizeForPrompt([null, undefined]), []);
});

// ---------------------------------------------------------------------------
// Rerank fallbacks
// ---------------------------------------------------------------------------

const pool = [
  { id: "a", title: "A" },
  { id: "b", title: "B" },
  { id: "c", title: "C" },
];

test("no model means the input order, sliced", async () => {
  const result = await rerankDocuments({ query: "q", documents: pool, limit: 2 }, opts);

  assert.deepEqual(result.map((d) => d.id), ["a", "b"]);
});

test("a model failure falls back to the input order", async () => {
  const model = {
    withStructuredOutput: () => ({
      invoke: async () => {
        throw new Error("model exploded");
      },
    }),
  };

  const result = await rerankDocuments({ query: "q", documents: pool, limit: 3 }, {
    ...opts,
    model,
  });

  assert.deepEqual(result.map((d) => d.id), ["a", "b", "c"]);
});

test("a successful rerank reorders", async () => {
  const model = {
    withStructuredOutput: () => ({ invoke: async () => ({ order: [2, 0, 1] }) }),
  };

  const result = await rerankDocuments({ query: "q", documents: pool, limit: 3 }, {
    ...opts,
    model,
  });

  assert.deepEqual(result.map((d) => d.id), ["c", "a", "b"]);
});

test("zero or one document short-circuits", async () => {
  assert.deepEqual(await rerankDocuments({ query: "q", documents: [], limit: 3 }, opts), []);
  assert.deepEqual(
    (await rerankDocuments({ query: "q", documents: [pool[0]], limit: 3 }, opts)).map((d) => d.id),
    ["a"],
  );
});

test("dropped indices are appended so nothing is silently lost", () => {
  assert.deepEqual(normalizeOrder([2], 3), [2, 0, 1]);
});

test("invalid, out-of-range and duplicate indices are discarded", () => {
  assert.deepEqual(normalizeOrder([1, 1, 99, -1, "x", null], 3), [1, 0, 2]);
});

test("an absent order still returns every index", () => {
  assert.deepEqual(normalizeOrder(undefined, 3), [0, 1, 2]);
});
