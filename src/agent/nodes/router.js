"use strict";

// The router: one structured-output classification per turn, with a deterministic
// fallback. It only ever writes `route`, `routeConfidence` and `slots` — the decision
// about which node that maps to belongs to `routeFromState` in graph.js.

const { z } = require("zod");
const { SystemMessage } = require("@langchain/core/messages");
const { getConfig } = require("../../config");
const { getModel } = require("../models");
const { ROUTES, ACTION_ROUTES, recentMessages } = require("../state");
const { ROUTER_SYSTEM_PROMPT } = require("../prompts");

// Flat on purpose: models fill a flat object far more reliably than a nested one.
// `which` is lifted into `slots` before it reaches state.
const RouterOutputSchema = z.object({
  route: z.enum(ROUTES),
  confidence: z.number().min(0).max(1),
  which: z.enum(["github", "leetcode", "both"]).nullable(),
  cancelsActiveFlow: z.boolean(),
});

// Where an unusable classification lands. about_me is the safe default: it is the most
// common intent, it is grounded in retrieved documents, and it cannot cause a side
// effect. Refusing instead would contradict the old pipeline's explicit rule that
// MoonMind never answers with a generic refusal.
const LOW_CONFIDENCE_ROUTE = "about_me";

function toSlots({ route, which }) {
  // `which` is only meaningful for the two stats routes; drop it everywhere else so a
  // stray value can't influence a later node.
  const usesWhich = route === "stats" || route === "stats_and_docs";
  return usesWhich && which ? { which } : {};
}

/**
 * Apply the low-confidence rule.
 *
 * Below the threshold the turn is redirected to about_me. Action routes are covered by
 * the same rule for a second reason: book_catchup and send_mail have side effects, so
 * they must never be reached by a guess.
 */
function applyConfidenceFloor(route, confidence, minConfidence) {
  if (confidence >= minConfidence) {
    return route;
  }
  return ACTION_ROUTES.includes(route) || route !== LOW_CONFIDENCE_ROUTE
    ? LOW_CONFIDENCE_ROUTE
    : route;
}

/**
 * @param {object} [deps]
 * @param {object} [deps.model] Injected model; tests pass a fake with withStructuredOutput.
 */
function createRouterNode(deps = {}) {
  return async function router(state) {
    const { moonmind } = getConfig();
    const model = deps.model ?? getModel("router");

    const history = recentMessages(state.messages, moonmind.historyMaxMessages);
    const messages = [new SystemMessage(ROUTER_SYSTEM_PROMPT), ...history];

    let output;
    try {
      output = await model
        .withStructuredOutput(RouterOutputSchema, { name: "route" })
        .invoke(messages);
    } catch (error) {
      // Deterministic fallback: a malformed or failed classification must not take the
      // turn down with it, and must not land on a route with side effects.
      console.warn("agent.router.fallback", {
        sessionId: state.sessionId,
        reason: error?.message,
      });
      return {
        route: LOW_CONFIDENCE_ROUTE,
        routeConfidence: 0,
        slots: {},
      };
    }

    const route = applyConfidenceFloor(
      output.route,
      output.confidence,
      moonmind.routerMinConfidence,
    );

    return {
      route,
      routeConfidence: output.confidence,
      slots: { ...toSlots(output), cancelsActiveFlow: output.cancelsActiveFlow === true },
    };
  };
}

module.exports = { createRouterNode, RouterOutputSchema, LOW_CONFIDENCE_ROUTE };
