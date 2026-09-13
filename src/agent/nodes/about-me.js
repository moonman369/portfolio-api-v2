"use strict";

// The about_me branch: retrieve the documents that ground the answer, and nothing else.
// `generate` turns them into prose.
//
// The whole pipeline — decompose -> per-sub-query (plan -> semantic/keyword/metadata
// arms -> RRF) -> union -> rank -> rerank — lives in `retrieval/`, where the eval
// scripts and Phase 7's tools reach it too. This node's job is to supply the models,
// call it, and map the result onto state.
//
// It is composed as an LCEL RunnableSequence rather than one opaque call so Phase 4's
// `.streamEvents()` feed shows named steps instead of a single "about_me" blob. The node
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
function createAboutMeNode(deps = {}) {
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
      }).withConfig({ runName: "about_me.prepare" }),

      RunnableLambda.from(async function retrieveDocuments({ query, models, config }) {
        if (!query) {
          return { documents: [], failedArms: [] };
        }
        return run(query, { models, config });
      }).withConfig({ runName: "about_me.retrieve" }),

      // Only `documents`: the answer belongs to `generate`, which is what lets
      // stats_and_docs reuse this node alongside the stats one.
      RunnableLambda.from(function toState(result) {
        if (result.failedArms?.length) {
          console.warn("agent.about_me.degraded", { failedArms: result.failedArms });
        }
        return { documents: result.documents ?? [] };
      }).withConfig({ runName: "about_me.to_state" }),
    ],
    // Deliberately unnamed. A runnable named exactly `about_me` is indistinguishable
    // from the graph node of that name in `.streamEvents()`, which made the feed report
    // every start and end for this node twice. The three steps above carry the names.
  );

  return async function aboutMe(state, config) {
    return chain.invoke(state, config);
  };
}

module.exports = { createAboutMeNode, resolveQuery };
