"use strict";

// Ranking, sanitizing, and the optional LLM rerank.
//
// `rankDocuments` is carried over near-verbatim under ARCHITECTURE.md §3 — deterministic
// scoring the old service's tests already pinned.
//
// Models are INJECTED, never imported. `getModel` lives in agent/, and agent/ sits above
// retrieval/ in the dependency chain, so importing it here would be an upward import.
// The caller supplies the model; without one the LLM stage falls back to its
// deterministic path, which is the behaviour it must have on failure anyway.

const { z } = require("zod");
const { getConfig } = require("../config");

function toScore(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampUnit(value) {
  if (value < 0) return 0;
  return value > 1 ? 1 : value;
}

/**
 *   boost = impactWeight * (impact_score / 100) + verifiedWeight * (verified ? 1 : 0)
 *
 * `impact_score` is authored per document (0-100) and normalized so both weights live on
 * the same scale. Both default to 0, so this is inert until deliberately configured.
 *
 * Scale note: RRF compresses hard — the whole retrieval signal spans ~0.005 across 30
 * results — so a weight that looks small is not necessarily weak. The repo's own docs
 * disagree on the usable band; re-measure before raising either above 0.
 */
function computeBoost(document, weights) {
  const impact = clampUnit(toScore(document?.metadata?.impact_score) / 100);
  const verified = document?.metadata?.verified === true ? 1 : 0;
  return weights.impact * impact + weights.verified * verified;
}

/**
 * Gate on absolute similarity, apply the editorial boost, order, take top N.
 *
 * Note the gate drops metadata-only hits once enabled: they have no semantic score, so
 * they score 0. That is the old behaviour, preserved.
 */
function rankDocuments(documents = [], limit = 5, options = {}) {
  const { retrieval } = options.config ?? getConfig();

  const minSemanticScore = options.minSemanticScore ?? retrieval.minSemanticScore;
  const weights = {
    impact: options.impactWeight ?? retrieval.impactWeight,
    verified: options.verifiedWeight ?? retrieval.verifiedWeight,
  };

  const gated =
    minSemanticScore > 0
      ? documents.filter((document) => toScore(document.semantic_score) >= minSemanticScore)
      : documents;

  return [...gated]
    .map((document) => {
      const retrievalScore = toScore(document.rrf_score);
      const boost = computeBoost(document, weights);

      return {
        ...document,
        // Kept apart so a log can show how much of the position came from retrieval
        // versus the editorial boost.
        retrieval_score: retrievalScore,
        boost_score: Number(boost.toFixed(8)),
        score: Number((retrievalScore + boost).toFixed(8)),
      };
    })
    .sort((left, right) => {
      if ((right.score ?? 0) !== (left.score ?? 0)) {
        return (right.score ?? 0) - (left.score ?? 0);
      }
      return String(left.id).localeCompare(String(right.id));
    })
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

// Everything else in `metadata` stays out of the prompt. `impact_score` is excluded
// deliberately: it is an editorial knob and the answer must never quote it.
const SAFE_METADATA_FIELDS = Object.freeze([
  "domain",
  "subcategory",
  "organization",
  "proficiency_level",
  "verified",
  "date_start",
  "date_end",
  "completion_year",
  "is_active",
]);

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const safe = {};
  SAFE_METADATA_FIELDS.forEach((field) => {
    const value = metadata[field];
    if (value !== undefined && value !== null && value !== "") {
      safe[field] = value;
    }
  });

  const links = metadata.external_links;
  if (links && typeof links === "object" && !Array.isArray(links)) {
    const entries = Object.entries(links).filter(
      ([key, value]) => key?.trim() && typeof value === "string" && value.trim(),
    );
    if (entries.length > 0) {
      safe.external_links = Object.fromEntries(entries);
    }
  }

  return Object.keys(safe).length > 0 ? safe : undefined;
}

/** Reduce a ranked document to what the answer prompt is allowed to see. */
function sanitizeForPrompt(documents) {
  if (!Array.isArray(documents)) {
    return [];
  }

  return documents
    .filter((document) => document && typeof document === "object")
    .map((document) => {
      const sanitized = {
        title: document.title || "Untitled",
        content: document.content_full || document.summary_for_embedding || "",
        tags: Array.isArray(document.tags) ? document.tags.filter(Boolean) : [],
      };

      const metadata = sanitizeMetadata(document.metadata);
      if (metadata) {
        sanitized.metadata = metadata;
      }
      return sanitized;
    });
}

// ---------------------------------------------------------------------------
// LLM rerank — optional, best effort
// ---------------------------------------------------------------------------

const MAX_RERANK_CONTENT_CHARS = 900;

const RerankSchema = z.object({
  order: z.array(z.number().int().min(0)).describe("candidate indices, best first"),
});

function truncate(value, max = MAX_RERANK_CONTENT_CHARS) {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function buildCandidates(documents) {
  return documents.map((document, index) => ({
    index,
    title: document.title || "Untitled",
    content: truncate(document.content_full || document.summary_for_embedding),
    tags: Array.isArray(document.tags) ? document.tags.slice(0, 12) : [],
  }));
}

/** Keep valid, in-range, unseen indices; append anything the model dropped. */
function normalizeOrder(order, count) {
  const seen = new Set();
  const cleaned = [];

  (order ?? []).forEach((value) => {
    const index = Number(value);
    if (Number.isInteger(index) && index >= 0 && index < count && !seen.has(index)) {
      seen.add(index);
      cleaned.push(index);
    }
  });
  for (let index = 0; index < count; index += 1) {
    if (!seen.has(index)) {
      cleaned.push(index);
    }
  }

  return cleaned;
}

/**
 * Second-stage rerank over the top fused candidates.
 *
 * Any failure — and a missing model counts as one — returns the input order, sliced.
 * Retrieval never breaks because of this stage.
 *
 * @param {{ model?: object }} [deps] `model` must be injected by the caller; see the
 *   note at the top of this file about why it is not imported.
 */
async function rerankDocuments({ query, documents, limit }, deps = {}) {
  const { retrieval } = deps.config ?? getConfig();

  if (!Array.isArray(documents) || documents.length <= 1) {
    return Array.isArray(documents) ? documents.slice(0, limit) : [];
  }

  const pool = documents.slice(0, retrieval.rerankCandidates);

  if (!deps.model) {
    console.warn("retrieval.rerank_skipped", { reason: "no model supplied by the caller" });
    return pool.slice(0, limit);
  }

  try {
    const result = await deps.model
      .withStructuredOutput(RerankSchema, { name: "rerank" })
      .invoke([
        {
          role: "system",
          content: [
            "You are a precise relevance ranker for a retrieval system.",
            "Given a query and numbered candidate documents, order the candidates from",
            "most to least relevant to answering it. Use only the provided content.",
            "Return every candidate index exactly once, best first.",
          ].join(" "),
        },
        { role: "user", content: JSON.stringify({ query, candidates: buildCandidates(pool) }) },
      ]);

    return normalizeOrder(result?.order, pool.length)
      .map((index) => pool[index])
      .slice(0, limit);
  } catch (error) {
    console.warn("retrieval.rerank_fallback", { message: error?.message });
    return pool.slice(0, limit);
  }
}

module.exports = {
  rankDocuments,
  sanitizeForPrompt,
  rerankDocuments,
  normalizeOrder,
  SAFE_METADATA_FIELDS,
};
