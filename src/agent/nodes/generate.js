"use strict";

// The single exit node. Every branch converges here before END.
//
// When a branch already produced an answer — the templated and stubbed ones do —
// `generate` just records it on the transcript. Otherwise it synthesizes from whatever
// context the branch gathered. Retrieved documents join the context in Phase 3b; the
// pass-through contract does not change then.

const { AIMessage, SystemMessage } = require("@langchain/core/messages");
const { getConfig } = require("../../config");
const { getModel } = require("../models");
const { recentMessages } = require("../state");
const { GENERATE_SYSTEM_PROMPT, buildStatsContext } = require("../prompts");

function createGenerateNode(deps = {}) {
  return async function generate(state) {
    if (state.finalAnswer) {
      return { messages: [new AIMessage(state.finalAnswer)] };
    }

    const { moonmind } = getConfig();
    const model = deps.model ?? getModel("response");
    const history = recentMessages(state.messages, moonmind.historyMaxMessages);

    const prompt = [new SystemMessage(GENERATE_SYSTEM_PROMPT), ...history];

    // Context goes after the history so it sits closest to the question being answered.
    const statsContext = buildStatsContext(state.statsPayload);
    if (statsContext) {
      prompt.push(new SystemMessage(statsContext));
    }

    const response = await model.invoke(prompt);

    const answer = typeof response?.content === "string" ? response.content.trim() : "";
    if (!answer) {
      throw new Error("Response model returned empty content");
    }

    return { finalAnswer: answer, messages: [new AIMessage(answer)] };
  };
}

module.exports = { createGenerateNode };
