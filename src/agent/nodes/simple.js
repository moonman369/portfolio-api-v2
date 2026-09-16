"use strict";

// The nodes that need no model call, plus the stubs standing in for routes that land in
// later phases. Each returns only the keys it changes.

const {
  REFUSAL_ANSWER,
  NOT_IMPLEMENTED_ANSWER,
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
 * `list_capabilities`, and answering "Hey" with it is the bug this node exists to fix.
 *
 * The conversation length picks which greeting, so a second "hey" in a session reads
 * differently without the answer becoming non-deterministic.
 */
async function greeting(state) {
  return { finalAnswer: buildGreetingAnswer(state?.messages?.length ?? 0) };
}

/**
 * Placeholder for a route whose real node arrives in a later phase. It still writes a
 * `finalAnswer`, so the turn flows through `generate` exactly like a real branch.
 */
function makeStubNode(name) {
  return async function stub() {
    // Only `finalAnswer`: `slots` uses a last-write-wins reducer, so writing it here
    // would clobber what the router extracted.
    return { finalAnswer: NOT_IMPLEMENTED_ANSWER };
  };
}

module.exports = { refusal, listCapabilities, greeting, makeStubNode };
