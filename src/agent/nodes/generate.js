"use strict";

// The single exit node. Every branch converges here before END.
//
// When a branch already produced an answer — every branch does today — `generate` just
// records it on the transcript. Full synthesis from retrieved documents and a stats
// payload lands in Phase 3b; the pass-through contract does not change then.

const { AIMessage, SystemMessage } = require("@langchain/core/messages");
const { getConfig } = require("../../config");
const { getModel } = require("../models");
const { recentMessages } = require("../state");
const { GENERATE_SYSTEM_PROMPT } = require("../prompts");

function createGenerateNode(deps = {}) {
  return async function generate(state) {
    if (state.finalAnswer) {
      return { messages: [new AIMessage(state.finalAnswer)] };
    }

    const { moonmind } = getConfig();
    const model = deps.model ?? getModel("response");
    const history = recentMessages(state.messages, moonmind.historyMaxMessages);

    const response = await model.invoke([
      new SystemMessage(GENERATE_SYSTEM_PROMPT),
      ...history,
    ]);

    const answer = typeof response?.content === "string" ? response.content.trim() : "";
    if (!answer) {
      throw new Error("Response model returned empty content");
    }

    return { finalAnswer: answer, messages: [new AIMessage(answer)] };
  };
}

module.exports = { createGenerateNode };
