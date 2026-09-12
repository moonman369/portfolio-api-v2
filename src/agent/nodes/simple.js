"use strict";

// The nodes that need no model call, plus the stubs standing in for routes that land in
// later phases. Each returns only the keys it changes.

const { REFUSAL_ANSWER, NOT_IMPLEMENTED_ANSWER, buildCapabilitiesAnswer } = require("../prompts");

/** Canned decline. The router already decided; there is nothing to ask a model. */
async function refusal() {
  return { finalAnswer: REFUSAL_ANSWER };
}

/** Templated from the route enum, so it cannot drift from what the graph can do. */
async function listCapabilities() {
  return { finalAnswer: buildCapabilitiesAnswer() };
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

module.exports = { refusal, listCapabilities, makeStubNode };
