"use strict";

// `retrieve()` — the single entry point into retrieval.
//
// decompose -> per-sub-query (plan -> search arms -> RRF) -> union -> rank -> rerank.
// The knowledge node calls this; Phase 8's semantic_search and metadata_filter
// tools call the same function, not copies of it.
//
// Models are injected by the caller (see the note in rank.js): agent/ sits above
// retrieval/, so this layer never imports getModel. With no models supplied every LLM
// stage takes its deterministic fallback and retrieval still works.

const { getConfig } = require("../config");
const { decomposeQuery, planQuery } = require("./plan");
const { searchAllArms } = require("./search");
const { rankDocuments, rerankDocuments, sanitizeForPrompt } = require("./rank");

/**
 * Union the fused results of several sub-queries, deduping by id.
 *
 * A document relevant to several sub-questions accumulates RRF score, which is the
 * point. Keeps the highest semantic score and the copy that actually carries content.
 */
function unionDocuments(groups) {
  const merged = new Map();

  groups.forEach((documents) => {
    (documents ?? []).forEach((document) => {
      if (document?.id == null) {
        return;
      }

      const id = String(document.id);
      const existing = merged.get(id);
      if (!existing) {
        merged.set(id, { ...document });
        return;
      }

      const richer = !existing.content_full && document.content_full ? document : existing;
      merged.set(id, {
        ...richer,
        rrf_score: (existing.rrf_score ?? 0) + (document.rrf_score ?? 0),
        semantic_score: Math.max(existing.semantic_score ?? 0, document.semantic_score ?? 0),
        retrieval_sources: {
          ...(existing.retrieval_sources ?? {}),
          ...(document.retrieval_sources ?? {}),
        },
      });
    });
  });

  return [...merged.values()];
}

/** Reduce a document list to `{id, title}` — never the content. */
function idTitle(documents = []) {
  return documents.map((document) => ({ id: document.id, title: document.title }));
}

/**
 * Trace every stage of the pipeline for one call. Ids and titles only — never full
 * documents — so this is safe to hand back over HTTP (see `http/chat.js`, behind
 * `MOONMIND_RETRIEVAL_DEBUG`) and to log from `scripts/retrieval-ab.js`.
 */
function buildDebugTrace({ perSubquery, unioned, ranked, documents }) {
  return {
    arms: perSubquery.flatMap((entry, subqueryIndex) =>
      (entry.armHits ?? []).map(({ source, hits }) => ({
        subquery: subqueryIndex,
        source,
        hits,
      })),
    ),
    // Sorted by rrf_score for readability — the raw fusion order is insertion order,
    // which says nothing about relevance on its own.
    fused: [...unioned]
      .sort((left, right) => (right.rrf_score ?? 0) - (left.rrf_score ?? 0))
      .map((document) => ({ id: document.id, title: document.title, rrfScore: document.rrf_score ?? 0 })),
    ranked: ranked.map((document) => ({ id: document.id, title: document.title, score: document.score ?? 0 })),
    reranked: idTitle(documents),
  };
}

/**
 * Retrieve documents for a query.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {object} [options.models] `{ decompose, intent, rerank }` — any may be omitted,
 *   in which case that stage takes its deterministic fallback.
 * @param {object} [options.metadata] Extra equality filters on `metadata.<key>`.
 * @param {number} [options.limit] How many documents to return.
 * @param {object} [options.config] Injected config, for tests.
 * @param {object} [options.collection] Injected Mongo collection, for tests.
 * @param {object} [options.embedder] Injected embedder, for tests.
 * @param {boolean} [options.debug] Include a per-stage trace (ids/titles only) under
 *   `debug` in the result — per-arm hits, the RRF-fused order, the post-ranker order and
 *   the post-rerank order. Off by default; costs one extra sort over data already fetched.
 * @returns {Promise<{documents, sanitized, subqueries, plans, arms, failedArms, debug?}>}
 */
async function retrieve(query, options = {}) {
  const config = options.config ?? getConfig();
  const { retrieval } = config;
  const models = options.models ?? {};
  const searchDeps = {
    config,
    collection: options.collection,
    embedder: options.embedder,
  };

  const subqueries = await decomposeQuery(query, { config, model: models.decompose });

  const perSubquery = await Promise.all(
    subqueries.map(async (subquery) => {
      const plan = await planQuery(subquery, { config, model: models.intent });

      if (!plan.requires_retrieval) {
        return { plan, documents: [], arms: [], failed: [] };
      }

      const result = await searchAllArms(
        {
          query: subquery,
          plan,
          metadata: options.metadata ?? {},
          limit: retrieval.candidateLimit,
        },
        searchDeps,
      );
      return { plan, ...result };
    }),
  );

  const unioned =
    subqueries.length > 1
      ? unionDocuments(perSubquery.map((entry) => entry.documents))
      : (perSubquery[0]?.documents ?? []);

  const finalLimit = options.limit ?? retrieval.finalDocumentLimit;

  // When reranking, keep a wider pool for the reranker to reorder; otherwise ranking
  // straight to the final limit is enough.
  const rankLimit = retrieval.rerankEnabled
    ? Math.max(retrieval.rerankCandidates, finalLimit)
    : finalLimit;

  const ranked = rankDocuments(unioned, rankLimit, { config });

  const documents = retrieval.rerankEnabled
    ? await rerankDocuments(
        { query, documents: ranked, limit: finalLimit },
        { config, model: models.rerank },
      )
    : ranked.slice(0, finalLimit);

  const result = {
    documents,
    sanitized: sanitizeForPrompt(documents),
    subqueries,
    plans: perSubquery.map((entry) => entry.plan),
    arms: perSubquery.flatMap((entry) => entry.arms ?? []),
    failedArms: perSubquery.flatMap((entry) => entry.failed ?? []),
  };

  if (options.debug) {
    result.debug = buildDebugTrace({ perSubquery, unioned, ranked, documents });
  }

  return result;
}

module.exports = { retrieve, unionDocuments, buildDebugTrace };
