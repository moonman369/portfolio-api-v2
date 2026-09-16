"use strict";

// The router: one structured-output classification per turn, with a deterministic
// fallback. It only ever writes `route`, `routeConfidence` and `slots` — the decision
// about which node that maps to belongs to `routeFromState` in graph.js.

const { z } = require("zod");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");
const { getConfig } = require("../../config");
const { getModel } = require("../models");
const { ROUTES, INHERITABLE_ROUTES, recentMessages } = require("../state");
const { ROUTER_SYSTEM_PROMPT, buildRouterContext, CANNED_DEAD_ENDS } = require("../prompts");

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
 * Below the threshold the classification is discarded. What replaces it is the previous
 * turn's route when there is a safe one — an unsure turn in the middle of an exchange is
 * far more likely to be continuing it than starting something new, and this is what stops
 * a terse follow-up from landing on `refusal`. Otherwise it falls to about_me, which is
 * the most common intent, is grounded in retrieved documents, and has no side effects.
 *
 * Note this only covers the UNSURE case. The failure that prompted it came back at
 * confidence 1.00, which no floor catches; the conversation context and the prompt rules
 * are what address that. This is the safety net under them, not the fix.
 */
function applyConfidenceFloor(route, confidence, minConfidence, previousRoute) {
  if (confidence >= minConfidence) {
    return route;
  }
  return INHERITABLE_ROUTES.includes(previousRoute) ? previousRoute : LOW_CONFIDENCE_ROUTE;
}

const isAiMessage = (message) =>
  (message?.getType?.() ?? message?._getType?.()) === "ai";

/**
 * The history the router is allowed to see.
 *
 * Strips MoonMind's own canned dead-ends — the refusal, the error answer, the
 * not-implemented stub. `generate` appends every answer to `messages`, so those strings
 * come back round as input on the next turn and the router reads them as precedent: it
 * sees that it refused, and refuses again. Two refused asks in one session was enough to
 * turn "Ayan's resume" from about_me@0.9 into refusal@1.0, and a confidence of 1.0 means
 * the low-confidence floor never catches it either.
 *
 * Prompt wording cannot fix this. An explicit "earlier refusals are not precedent" rule
 * was measured against the same poisoned history and still produced refusal 4 times out
 * of 4; removing these messages produced about_me 4 out of 4. The contamination is in the
 * input, so the input is what has to change.
 *
 * Real answers stay: they are what lets the router resolve "what about that?" against
 * whatever was just discussed.
 */
function routerHistory(messages) {
  return messages.filter(
    (message) => !(isAiMessage(message) && CANNED_DEAD_ENDS.has(String(message.content).trim())),
  );
}

/**
 * Split the conversation into the message being classified and the turns behind it.
 *
 * The latest human message is pulled out and sent as the only real `HumanMessage`, with
 * everything before it compacted into a context block. Passing raw history instead — which
 * is what this node used to do — buried the question: measured on the session this fix
 * came from, the live message was 0.9% of the router's input and lost to 5.8KB of the
 * assistant's own prose.
 */
function splitForRouter(messages) {
  const lastHumanIndex = messages.findLastIndex((message) => !isAiMessage(message));

  if (lastHumanIndex === -1) {
    return { current: "", turns: [] };
  }

  return {
    current: String(messages[lastHumanIndex].content ?? ""),
    turns: messages.slice(0, lastHumanIndex).map((message) => ({
      role: isAiMessage(message) ? "assistant" : "user",
      text: String(message.content ?? ""),
    })),
  };
}

/**
 * @param {object} [deps]
 * @param {object} [deps.model] Injected model; tests pass a fake with withStructuredOutput.
 */
function createRouterNode(deps = {}) {
  return async function router(state) {
    const { moonmind } = getConfig();
    const model = deps.model ?? getModel("router");

    // The router's window is its own, but it can never exceed the conversation cap the
    // rest of the graph respects — one history mechanism, narrowed, not a second one.
    //
    // Dead-ends are filtered BEFORE the window is applied, so a run of refusals cannot
    // eat the budget and leave the router with no real context to resolve a follow-up
    // against. The window is N useful messages, not N messages of which some are dropped.
    const window = Math.min(moonmind.routerHistoryMessages, moonmind.historyMaxMessages);
    const history = recentMessages(routerHistory(state.messages ?? []), window);
    const { current, turns } = splitForRouter(history);
    const context = buildRouterContext({ turns, previousRoute: state.previousRoute ?? null });

    const messages = [
      new SystemMessage(ROUTER_SYSTEM_PROMPT),
      ...(context ? [new SystemMessage(context)] : []),
      new HumanMessage(current),
    ];

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
      // Confidence 0 through the same rule the unsure path uses, so a failed
      // classification mid-exchange continues that exchange rather than resetting it.
      return {
        route: applyConfidenceFloor(
          LOW_CONFIDENCE_ROUTE,
          0,
          moonmind.routerMinConfidence,
          state.previousRoute ?? null,
        ),
        routeConfidence: 0,
        slots: {},
      };
    }

    const route = applyConfidenceFloor(
      output.route,
      output.confidence,
      moonmind.routerMinConfidence,
      state.previousRoute ?? null,
    );

    return {
      route,
      routeConfidence: output.confidence,
      slots: { ...toSlots(output), cancelsActiveFlow: output.cancelsActiveFlow === true },
    };
  };
}

module.exports = {
  createRouterNode,
  RouterOutputSchema,
  LOW_CONFIDENCE_ROUTE,
  routerHistory,
  splitForRouter,
};
