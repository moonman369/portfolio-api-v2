"use strict";

// The nodes that need no model call. Each returns only the keys it changes.
// (The last stub, `action`, was replaced by nodes/action.js in Phase 10.)

const {
  REFUSAL_ANSWER,
  buildCapabilitiesAnswer,
  buildGreetingAnswer,
} = require("../prompts");

/** Canned decline. The router already decided; there is nothing to ask a model. */
async function refusal() {
  return { finalAnswer: REFUSAL_ANSWER };
}

/** Templated from the route enum, so it cannot drift from what the graph can do. */
async function listCapabilities() {
  return { finalAnswer: buildCapabilitiesAnswer() };
}

/**
 * A greeting, and one line inviting a question. Not the capability menu — that is
 * `capabilities`, and answering "Hey" with it is the bug this node exists to fix.
 *
 * The conversation length picks which greeting, so a second "hey" in a session reads
 * differently without the answer becoming non-deterministic.
 */
async function greeting(state) {
  return { finalAnswer: buildGreetingAnswer(state?.messages?.length ?? 0) };
}

module.exports = { refusal, listCapabilities, greeting };
