"use strict";

// The single model factory. No other module constructs a chat model.
//
// Roles map to the per-role env vars resolved in config.js, so switching the reranker
// to a cheaper model is one variable and no code change.

const { ChatOpenAI } = require("@langchain/openai");
const { getConfig } = require("../config");

const ROLES = Object.freeze(["router", "intent", "decompose", "rerank", "response", "agent"]);

// Every role runs at temperature 0: four of them drive control flow and must be
// reproducible, and the old service used 0 at all its call sites too.
const TEMPERATURE = 0;

const cache = new Map();

function createModel(role) {
  const { openai, moonmind } = getConfig();
  const model = moonmind.models[role];

  return new ChatOpenAI({
    model,
    temperature: TEMPERATURE,
    apiKey: openai.apiKey,
    timeout: openai.timeoutMs,
    configuration: { baseURL: openai.baseUrl },
  });
}

/**
 * The chat model for a role, memoized. Throws on an unknown role rather than silently
 * handing back a default, so a typo fails loudly at first use.
 */
function getModel(role) {
  if (!ROLES.includes(role)) {
    throw new Error(`Unknown model role '${role}'. Expected one of: ${ROLES.join(", ")}`);
  }
  if (!cache.has(role)) {
    cache.set(role, createModel(role));
  }
  return cache.get(role);
}

/** Drop memoized models. Used by tests that change the environment. */
function resetModels() {
  cache.clear();
}

module.exports = { getModel, resetModels, ROLES };
