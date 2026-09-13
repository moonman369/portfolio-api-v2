"use strict";

// The three retrieval arms and the fusion that combines them.
//
// `fuseByRRF` is carried over near-verbatim under ARCHITECTURE.md §3 — it is a
// deterministic algorithm the old service's tests already pinned.
//
// The `$vectorSearch` aggregation is hand-rolled rather than delegated to
// `@langchain/mongodb`, to keep the pipeline identical to the one the existing vectors
// were searched with. Swapping in MongoDBAtlasVectorSearch is a possible later
// simplification, worth doing only once parity is demonstrated.

const { getConfig } = require("../config");
const { getCollection } = require("../db");
const { getEmbedder } = require("./embedder");
const { ALLOWED_DOMAINS } = require("../documents/taxonomy");

const PROJECTION = Object.freeze({
  _id: 0,
  id: 1,
  title: 1,
  category: 1,
  tags: 1,
  summary_for_embedding: 1,
  content_full: 1,
  metadata: 1,
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize a hit to the shape ranking and synthesis expect.
 *
 * Unlike the old service this keeps `tags`: it projected them from Mongo and then threw
 * them away, so the reranker's tag view and the sanitizer's tag field were always empty
 * (OLD_REPO_MAP.md §10.23).
 */
function normalizeDocument(document) {
  const metadata = document.metadata ?? {};
  const domain = typeof metadata.domain === "string" ? metadata.domain : null;

  return {
    id: document.id,
    title: document.title,
    category: document.category,
    tags: Array.isArray(document.tags) ? document.tags : [],
    summary_for_embedding: document.summary_for_embedding,
    content_full: document.content_full,
    metadata: {
      ...metadata,
      domain: ALLOWED_DOMAINS.includes(domain) ? domain : null,
      subcategory: Array.isArray(metadata.subcategory)
        ? metadata.subcategory.filter((value) => typeof value === "string")
        : [],
    },
  };
}

function entityTerms(plan) {
  const entities = plan?.entities ?? {};
  return [
    ...(entities.skills ?? []),
    ...(entities.projects ?? []),
    ...(entities.certifications ?? []),
    ...(entities.organizations ?? []),
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

/** Atlas ANN search. `score` is the raw cosine score, (1 + cos) / 2 in [0, 1]. */
async function semanticSearch(query, limit, deps = {}) {
  const { mongo, retrieval } = deps.config ?? getConfig();
  const embedder = deps.embedder ?? getEmbedder();

  const queryVector = await embedder.embedQuery(query);
  const collection = deps.collection ?? (await getCollection(mongo.vectorCollection));

  const pipeline = [
    {
      $vectorSearch: {
        index: mongo.vectorIndex,
        queryVector,
        path: mongo.vectorField,
        numCandidates: Math.max(limit * 5, retrieval.numCandidates),
        limit,
      },
    },
    { $project: { ...PROJECTION, score: { $meta: "vectorSearchScore" } } },
  ];

  const results = await collection.aggregate(pipeline).toArray();
  return results.map((document) => ({
    ...normalizeDocument(document),
    score: Number(document.score),
  }));
}

/**
 * Case-insensitive regex OR across the text fields.
 *
 * The collection has no text index, so this is a collection scan. Acceptable only
 * because the collection is small, and off by default (MOONMIND_KEYWORD_ENABLED) — in
 * the old service this arm was unreachable, so leaving it off keeps behaviour
 * comparable until it is deliberately switched on.
 */
function buildKeywordQuery(query, plan) {
  const tokens = [query, ...entityTerms(plan), ...(plan?.filters?.domain ?? [])]
    .join(" ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);

  const unique = [...new Set(tokens)];
  if (unique.length === 0) {
    return {};
  }

  return {
    $or: unique.map((token) => {
      const regex = { $regex: escapeRegex(token), $options: "i" };
      return {
        $or: [
          { title: regex },
          { tags: regex },
          { content_full: regex },
          { summary_for_embedding: regex },
        ],
      };
    }),
  };
}

/** Structured filters from the plan: domain, subcategory, named entities, date range. */
function buildMetadataQuery(plan, runtimeMetadata = {}) {
  const clauses = [];
  const domains = plan?.filters?.domain ?? [];
  const terms = entityTerms(plan);
  const dates = plan?.entities?.dates ?? {};

  if (domains.length > 0) {
    clauses.push({ "metadata.domain": { $in: domains } });
  }
  if (Array.isArray(plan?.subcategories) && plan.subcategories.length > 0) {
    clauses.push({ "metadata.subcategory": { $in: plan.subcategories } });
  }
  if (terms.length > 0) {
    clauses.push({
      $or: terms.map((term) => {
        const regex = { $regex: escapeRegex(term), $options: "i" };
        return {
          $or: [
            { title: regex },
            { category: regex },
            { tags: regex },
            { "metadata.subcategory": regex },
          ],
        };
      }),
    });
  }

  if (dates.from || dates.to) {
    // Lexicographic comparison on ISO strings — correct only because they are
    // zero-padded, which the schema enforces.
    const range = {};
    if (dates.from) range.$gte = dates.from;
    if (dates.to) range.$lte = dates.to;

    clauses.push({
      $or: [
        { "metadata.date_start": range },
        { "metadata.date_end": range },
        {
          $and: [
            { "metadata.date_start": { $lte: dates.to ?? new Date().toISOString(), $ne: null } },
            { $or: [{ "metadata.date_end": null }, { "metadata.date_end": { $exists: false } }] },
          ],
        },
      ],
    });
  }

  Object.entries(runtimeMetadata ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      clauses.push({ [`metadata.${key}`]: value });
    }
  });

  return clauses.length > 0 ? { $and: clauses } : {};
}

async function runMongoQuery(query, limit, deps = {}) {
  if (!query || Object.keys(query).length === 0) {
    return [];
  }

  const { mongo } = deps.config ?? getConfig();
  const collection = deps.collection ?? (await getCollection(mongo.vectorCollection));
  const results = await collection.find(query, { projection: PROJECTION }).limit(limit).toArray();

  return results.map(normalizeDocument);
}

// ---------------------------------------------------------------------------
// Fusion — carried over near-verbatim
// ---------------------------------------------------------------------------

/**
 *   rrf_score(doc) = Σ_arm  weight_arm * 1 / (k + rank_arm(doc))     // rank is 1-based
 *
 * Rank-based rather than score-based because the arms produce scores on incomparable
 * scales — an Atlas cosine score against a Mongo filter match. The raw semantic score is
 * carried through untouched so the ranker's absolute-similarity gate still works.
 */
function fuseByRRF(resultSets = [], { k = 60, weights = {} } = {}) {
  const fused = new Map();

  resultSets.forEach((resultSet) => {
    if (!resultSet || !Array.isArray(resultSet.documents)) {
      return;
    }
    const { source, documents } = resultSet;
    const weight = typeof weights[source] === "number" ? weights[source] : 1;

    documents.forEach((document, index) => {
      if (document == null || document.id == null) {
        return;
      }

      const id = String(document.id);
      const rank = index + 1;
      const entry = fused.get(id) ?? {
        document,
        rrf_score: 0,
        semantic_score: 0,
        retrieval_sources: {},
      };

      entry.rrf_score += weight * (1 / (k + rank));
      entry.retrieval_sources[source] = rank;

      if (source === "semantic") {
        const raw = Number(document.score);
        if (Number.isFinite(raw)) {
          entry.semantic_score = Math.max(entry.semantic_score, raw);
        }
      }

      // Prefer whichever copy carries the full content, so a metadata-only hit does not
      // shadow the richer semantic-arm document.
      if (!entry.document.content_full && document.content_full) {
        entry.document = document;
      }

      fused.set(id, entry);
    });
  });

  return [...fused.values()].map((entry) => ({
    ...entry.document,
    semantic_score: entry.semantic_score,
    retrieval_sources: entry.retrieval_sources,
    rrf_score: Number(entry.rrf_score.toFixed(8)),
  }));
}

/**
 * Run the arms the plan enables and fuse them.
 * `allSettled`, not `all`: one failing arm degrades the result rather than losing the turn.
 */
async function searchAllArms({ query, plan, metadata = {}, limit }, deps = {}) {
  const config = deps.config ?? getConfig();
  const { retrieval } = config;
  const armLimit = Math.max(limit ?? retrieval.candidateLimit, 10);
  const wanted = plan?.retrieval_plan ?? { semantic: true };

  const arms = [];
  if (wanted.semantic) {
    arms.push({ source: "semantic", run: () => semanticSearch(query, armLimit, deps) });
  }
  if (wanted.keyword && retrieval.keywordEnabled) {
    arms.push({
      source: "keyword",
      run: () => runMongoQuery(buildKeywordQuery(query, plan), armLimit, deps),
    });
  }
  if (wanted.metadata) {
    arms.push({
      source: "metadata",
      run: () => runMongoQuery(buildMetadataQuery(plan, metadata), armLimit, deps),
    });
  }

  const settled = await Promise.allSettled(arms.map((arm) => arm.run()));
  const resultSets = [];
  const failed = [];

  settled.forEach((result, index) => {
    const { source } = arms[index];
    if (result.status === "fulfilled") {
      resultSets.push({ source, documents: result.value });
    } else {
      console.warn("retrieval.arm_failed", { source, message: result.reason?.message });
      failed.push({ source, message: result.reason?.message ?? "unknown error" });
    }
  });

  return {
    documents: fuseByRRF(resultSets, { k: retrieval.rrfK, weights: retrieval.rrfWeights }),
    arms: resultSets.map(({ source, documents }) => ({ source, count: documents.length })),
    failed,
  };
}

module.exports = {
  searchAllArms,
  semanticSearch,
  runMongoQuery,
  buildKeywordQuery,
  buildMetadataQuery,
  fuseByRRF,
  normalizeDocument,
};
