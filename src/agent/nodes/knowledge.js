"use strict";

// The knowledge branch: retrieve the documents that ground the answer, and nothing else.
// `generate` turns them into prose.
//
// Phase 7 renamed this from `about_me` and widened what reaches it — the questions that
// used to be `complex` ("how has Ayan upskilled in AI since 2023") now land here too. The
// pipeline is unchanged: they are answered from retrieval alone, which is enough for
// trend questions because the corpus carries date metadata. Since Phase 9 it also asks for
// the one-per-turn escalation to `agent` when retrieval cannot answer — see
// `escalationReason` below. It only asks; the graph decides and counts.
//
// The whole pipeline — decompose -> per-sub-query (plan -> semantic/keyword/metadata
// arms -> RRF) -> union -> rank -> rerank — lives in `retrieval/`, where the eval
// scripts and Phase 8's tools reach it too. This node's job is to supply the models,
// call it, and map the result onto state.
//
// It is composed as an LCEL RunnableSequence rather than one opaque call so Phase 4's
// `.streamEvents()` feed shows named steps instead of a single "knowledge" blob. The node
// itself stays a plain async function, per ARCHITECTURE.md §4.

const { RunnableLambda, RunnableSequence } = require("@langchain/core/runnables");
const { getConfig } = require("../../config");
const { getModel } = require("../models");
const { retrieve } = require("../../retrieval");
const { recentMessages } = require("../state");

/** The question to retrieve against: the turn's query, or the last thing the user said. */
function resolveQuery(state) {
  if (typeof state.rawQuery === "string" && state.rawQuery.trim()) {
    return state.rawQuery.trim();
  }

  const history = recentMessages(state.messages, 1);
  const last = history[history.length - 1];
  return typeof last?.content === "string" ? last.content.trim() : "";
}

/**
 * Phrases that mean the question needs something the portfolio cannot hold: where the
 * market is, what is latest, how things stand today. Retrieval can say what Ayan built;
 * only the web can say how that compares with now. `MOONMIND_ESCALATION_TERMS` appends.
 *
 * Kept to phrases that rarely describe Ayan's own history. "industry" alone is not here —
 * "his industry experience" is a portfolio question — but "the industry" is. Known cost:
 * "latest" also catches "his latest project", which then takes the (slower) agent path;
 * the agent answers it from the document tools, so the answer is right, just later.
 */
const ESCALATION_TERMS = Object.freeze([
  "market",
  "the industry",
  "industry trends",
  "industry standard",
  "latest",
  "today",
  "nowadays",
  "these days",
  "in demand",
  "trend",
  "trends",
  "trending",
  "state of the art",
  "cutting edge",
]);

/** One case-insensitive, word-bounded pattern per phrase; any run of spaces matches. */
function compileTerms(terms) {
  return terms
    .map((term) => String(term).trim())
    .filter(Boolean)
    .map((term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      return new RegExp(`\\b${escaped}\\b`, "i");
    });
}

/**
 * Why this question should hop to `agent`, or null. Deterministic — no model call:
 *
 *   - `weak_retrieval`: the pool's best semantic score is under
 *     `MOONMIND_ESCALATION_MIN_TOP_SCORE`. Measured (docs/evals/retrieval-floor.md): the
 *     nothing-should-match probes top out at 0.828 and every real question starts at
 *     0.850, so 0.84 splits them. One known miss: "underwater basket weaving" scores
 *     0.854 because the About document matches Ayan's name alone.
 *   - `needs_current`: the question asks for framing from outside the portfolio.
 */
function escalationReason({ query, topSemanticScore, moonmind }) {
  const floor = moonmind.escalationMinTopScore ?? 0;
  if (floor > 0 && (Number(topSemanticScore) || 0) < floor) {
    return "weak_retrieval";
  }

  const patterns = compileTerms([...ESCALATION_TERMS, ...(moonmind.escalationTerms ?? [])]);
  if (patterns.some((pattern) => pattern.test(query ?? ""))) {
    return "needs_current";
  }

  return null;
}

/**
 * Only the models the enabled stages actually need. Each is optional in `retrieval/` —
 * an absent one takes that stage's deterministic fallback — so the flags decide what
 * gets built, and nothing is constructed for a stage that is switched off.
 */
function resolveModels(retrieval, overrides = {}) {
  if (overrides.models) {
    return overrides.models;
  }

  return {
    intent: getModel("intent"),
    decompose: retrieval.decomposeEnabled ? getModel("decompose") : undefined,
    rerank: retrieval.rerankEnabled ? getModel("rerank") : undefined,
  };
}

/**
 * @param {object} [deps] Injected for tests: `retrieve`, `models`, `config`.
 */
function createKnowledgeNode(deps = {}) {
  const run = deps.retrieve ?? retrieve;

  const chain = RunnableSequence.from(
    [
      RunnableLambda.from(function prepare(state) {
        const config = deps.config ?? getConfig();
        return {
          query: resolveQuery(state),
          models: resolveModels(config.retrieval, deps),
          config,
        };
      }).withConfig({ runName: "knowledge.prepare" }),

      RunnableLambda.from(async function retrieveDocuments({ query, models, config }) {
        if (!query) {
          return { documents: [], failedArms: [], query, config };
        }
        const result = await run(query, { models, config, debug: config.retrieval.debugEnabled });
        return { ...result, query, config };
      }).withConfig({ runName: "knowledge.retrieve" }),

      // `documents`, the optional debug trace, and whether to escalate: the answer belongs
      // to `generate` (or to `agent`, on a hop), which is what lets the stats node reuse
      // this one for a mixed question. `stats` keeps only `documents` from it, so an
      // escalation asked for inside a mixed question goes nowhere — the accepted
      // limitation recorded in PROGRESS.md Decisions, 2026-09-23.
      RunnableLambda.from(function toState({ query, config, ...result }) {
        if (result.failedArms?.length) {
          console.warn("agent.knowledge.degraded", { failedArms: result.failedArms });
        }

        const reason = escalationReason({
          query,
          topSemanticScore: result.topSemanticScore,
          moonmind: config.moonmind,
        });
        if (reason) {
          console.log("agent.knowledge.escalate", { reason, topSemanticScore: result.topSemanticScore ?? 0 });
        }

        return {
          documents: result.documents ?? [],
          retrievalDebug: result.debug ?? null,
          escalate: reason !== null,
          escalationReason: reason,
        };
      }).withConfig({ runName: "knowledge.to_state" }),
    ],
    // Deliberately unnamed. A runnable named exactly `knowledge` is indistinguishable
    // from the graph node of that name in `.streamEvents()`, which made the feed report
    // every start and end for this node twice. The three steps above carry the names.
  );

  return async function knowledge(state, config) {
    return chain.invoke(state, config);
  };
}

module.exports = { createKnowledgeNode, resolveQuery, escalationReason, ESCALATION_TERMS };
