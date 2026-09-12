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
 * The eight routes from LLD §2, plus `stats_and_docs`.
 *
 * The old regex router had a third state the LLD's taxonomy cannot express: a mixed
 * query ("my github stats and my projects") answered from stats AND portfolio documents
 * at once. Rather than a second branch point outside `routeFromState`, it gets its own
 * route whose node composes the `stats` and `about_me` nodes.
 */
const ROUTES = Object.freeze([
  "about_me",
  "stats",
  "stats_and_docs",
  "tech_web",
  "complex",
  "refusal",
  "book_catchup",
  "send_mail",
  "list_capabilities",
]);

/** Routes that perform a side effect, and so must never be reached by a guess. */
const ACTION_ROUTES = Object.freeze(["book_catchup", "send_mail"]);

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

  pendingConfirmation: lastValue(null),
  activeFlow: lastValue(null),
  summary: lastValue(null),

  finalAnswer: lastValue(null),
  error: lastValue(null),
});

/**
 * Fields `runTurn` clears on every turn. Without this the checkpointer would carry the
 * previous turn's documents, stats and answer into the next one on the same session.
 * Everything absent from this list — messages, slots, pendingConfirmation, activeFlow,
 * summary — is meant to persist.
 */
const PER_TURN_RESET = Object.freeze({
  route: null,
  routeConfidence: 0,
  documents: [],
  statsPayload: null,
  searchResults: [],
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

module.exports = { State, ROUTES, ACTION_ROUTES, PER_TURN_RESET, recentMessages };
