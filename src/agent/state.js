"use strict";

// The graph's state schema and the route vocabulary it is built around.
//
// LLD §3 names: sessionId, rawQuery, messages, route, routeConfidence, slots,
// documents, statsPayload, searchResults, pendingConfirmation, summary.
// Three fields are added by this rebuild (see docs/PROGRESS.md, Deviations 2):
//   finalAnswer — a branch that already produced an answer; `generate` passes it through
//   error       — what the error boundary records when a node throws
//   activeFlow  — the sticky multi-turn action a session is currently inside

const { Annotation, messagesStateReducer } = require("@langchain/langgraph");

/**
 * The seven labels (ARCHITECTURE.md §4). Collapsed from ten in Phase 7.
 *
 * What merged, and why the count dropped:
 *   about_me + complex          -> knowledge    (the boundary was never real)
 *   tech_web + complex tool use -> agent        (four tools, one factory call)
 *   book_catchup + send_mail    -> action       (branches on slots.action)
 *   stats_and_docs              -> stats        (branches on slots.withDocuments)
 *   list_capabilities           -> capabilities (renamed only)
 *
 * `greeting` carries over unchanged from Phase 6.5. Anything a checkpointed thread still
 * holds under an old name is translated by LEGACY_ROUTE_MAP below.
 */
const ROUTES = Object.freeze([
  "greeting",
  "knowledge",
  "stats",
  "agent",
  "action",
  "refusal",
  "capabilities",
]);

/** Routes that perform a side effect, and so must never be reached by a guess. */
const ACTION_ROUTES = Object.freeze(["action"]);

/**
 * Old route names still sitting in checkpointed threads, and where they go now.
 *
 * Not hypothetical: when Phase 7 landed, 20 live threads carried values written under the
 * ten-label taxonomy and the newest of them held `tech_web`. A thread whose stored route
 * no longer exists would otherwise fall straight to `refusal` — the exact failure Phase
 * 6.5 spent a session removing.
 *
 * `tech_web` deliberately maps to ITSELF rather than to `agent`: the node still exists and
 * still works, while `agent` is a stub until Phase 8. Routing a legacy web question to a
 * "not available yet" stub would be a regression, not a migration.
 *
 * `greeting` is already current and needs no entry.
 */
const LEGACY_ROUTE_MAP = Object.freeze({
  about_me: "knowledge",
  complex: "knowledge",
  stats_and_docs: "stats",
  book_catchup: "action",
  send_mail: "action",
  list_capabilities: "capabilities",
  tech_web: "tech_web",
});

/** Nodes kept in the graph for a legacy route that has no current label of its own. */
const LEGACY_NODES = Object.freeze(["tech_web"]);

/** Translate a route written under the old taxonomy. Current names pass through. */
function resolveLegacyRoute(route) {
  if (!route || ROUTES.includes(route)) {
    return route;
  }
  return LEGACY_ROUTE_MAP[route] ?? route;
}

/**
 * The slots an old route carried implicitly in its name.
 *
 * `stats_and_docs` meant "stats, with documents". Collapsed into a label plus a slot, a
 * thread carrying the old name has to be handed the slot back or a mixed question loses
 * half its answer. Applied to `previousRoute`, which — unlike `route` — survives the
 * per-turn reset and so is where a legacy value actually reaches this taxonomy.
 */
function restoreLegacySlots(previousRoute, slots = {}) {
  if (previousRoute === "stats_and_docs" && slots.withDocuments === undefined) {
    return { ...slots, withDocuments: true };
  }
  return slots;
}

/**
 * Routes an unsure turn may inherit from the previous one.
 *
 * Deliberately excludes the action routes (a guess must never cause a side effect) and
 * the templated ones: inheriting `refusal` is how a single refusal turns into a session
 * of them, and inheriting `greeting` or `capabilities` would answer a real question
 * with a pleasantry.
 */
const INHERITABLE_ROUTES = Object.freeze(
  ROUTES.filter(
    (route) =>
      !ACTION_ROUTES.includes(route) && !["refusal", "greeting", "capabilities"].includes(route),
  ),
);

/** Last-write-wins channel. Most per-turn fields want exactly this. */
function lastValue(defaultValue) {
  return Annotation({
    reducer: (_previous, next) => next,
    default: () => defaultValue,
  });
}

const State = Annotation.Root({
  sessionId: lastValue(null),
  rawQuery: lastValue(""),
  // The only accumulating channel: appends, and merges updates by message id.
  messages: Annotation({ reducer: messagesStateReducer, default: () => [] }),

  route: lastValue(null),
  routeConfidence: lastValue(0),
  slots: lastValue({}),

  documents: lastValue([]),
  statsPayload: lastValue(null),
  searchResults: lastValue([]),
  // A per-stage retrieval trace (ids/titles only), populated only when
  // `MOONMIND_RETRIEVAL_DEBUG` is on. See ARCHITECTURE.md and retrieval/index.js.
  retrievalDebug: lastValue(null),

  pendingConfirmation: lastValue(null),
  activeFlow: lastValue(null),
  summary: lastValue(null),
  // The route the PREVIOUS turn took. Written by `generate` (the one node every branch
  // converges on) and deliberately absent from PER_TURN_RESET, so the router can read it
  // after `route` itself has been cleared for this turn. It is what lets a refinement
  // like "no, just the link" inherit the route of the exchange it is refining.
  previousRoute: lastValue(null),

  finalAnswer: lastValue(null),
  error: lastValue(null),
});

/**
 * Fields `runTurn` clears on every turn. Without this the checkpointer would carry the
 * previous turn's documents, stats and answer into the next one on the same session.
 * Everything absent from this list — messages, slots, pendingConfirmation, activeFlow,
 * summary, previousRoute — is meant to persist.
 */
const PER_TURN_RESET = Object.freeze({
  route: null,
  routeConfidence: 0,
  documents: [],
  statsPayload: null,
  searchResults: [],
  retrievalDebug: null,
  finalAnswer: null,
  error: null,
});

/** The tail of the conversation that is safe to replay to a model. */
function recentMessages(messages, limit) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return limit > 0 && messages.length > limit ? messages.slice(-limit) : messages;
}

module.exports = {
  State,
  ROUTES,
  ACTION_ROUTES,
  INHERITABLE_ROUTES,
  LEGACY_ROUTE_MAP,
  LEGACY_NODES,
  resolveLegacyRoute,
  restoreLegacySlots,
  PER_TURN_RESET,
  recentMessages,
};
