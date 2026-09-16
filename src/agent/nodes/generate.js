"use strict";

// The single exit node. Every branch converges here before END.
//
// When a branch already produced an answer — the templated and agentic ones do —
// `generate` records it on the transcript unchanged. Otherwise it synthesizes from
// whatever context the branch gathered: retrieved documents, a stats payload, or both
// at once for the mixed route.

const { AIMessage, SystemMessage } = require("@langchain/core/messages");
const { getConfig } = require("../../config");
const { getModel } = require("../models");
const { recentMessages } = require("../state");
const { sanitizeForPrompt } = require("../../retrieval/rank");
const {
  GENERATE_SYSTEM_PROMPT,
  buildStatsContext,
  buildDocumentContext,
  buildDateContext,
  NO_DOCUMENTS_CONTEXT,
} = require("../prompts");

/**
 * Context blocks, in the order the model sees them.
 *
 * Documents are sanitized here rather than upstream so `state.documents` keeps the full
 * ranked records for the API response and the Phase 4 feed, while the prompt only ever
 * sees the safe view — impact_score and the rest never reach the model.
 */
function buildContextBlocks(state, { now } = {}) {
  const blocks = [buildDateContext(now)];

  const documentContext = buildDocumentContext(sanitizeForPrompt(state.documents));
  if (documentContext) {
    blocks.push(documentContext);
  }

  const statsContext = buildStatsContext(state.statsPayload);
  if (statsContext) {
    blocks.push(statsContext);
  }

  // Only when there was genuinely nothing: a stats-only turn has no documents by
  // design and must not be told its documents are missing.
  const retrievedNothing = !documentContext && !statsContext;
  if (retrievedNothing) {
    blocks.push(NO_DOCUMENTS_CONTEXT);
  }

  return blocks;
}

function createGenerateNode(deps = {}) {
  return async function generate(state) {
    // Every branch converges here, and `route` still holds this turn's value, so this is
    // the one place that can hand the next turn's router what it was. `previousRoute` is
    // outside PER_TURN_RESET, so it survives into the next turn on this session.
    const carry = { previousRoute: state.route ?? null };

    if (state.finalAnswer) {
      return { ...carry, messages: [new AIMessage(state.finalAnswer)] };
    }

    const { moonmind } = deps.config ?? getConfig();
    const model = deps.model ?? getModel("response");
    const history = recentMessages(state.messages, moonmind.historyMaxMessages);

    const prompt = [
      new SystemMessage(GENERATE_SYSTEM_PROMPT),
      ...history,
      // Context goes after the history so it sits closest to the question being answered.
      ...buildContextBlocks(state, deps).map((block) => new SystemMessage(block)),
    ];

    const response = await model.invoke(prompt);

    const answer = typeof response?.content === "string" ? response.content.trim() : "";
    if (!answer) {
      throw new Error("Response model returned empty content");
    }

    return { ...carry, finalAnswer: answer, messages: [new AIMessage(answer)] };
  };
}

module.exports = { createGenerateNode, buildContextBlocks };
