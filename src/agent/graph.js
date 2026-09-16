"use strict";

// Graph wiring, the routing function, and the error boundary. No business logic:
// every node is supplied by the caller, which is what lets test/agent run the whole
// graph with fakes.

const { StateGraph, START, END } = require("@langchain/langgraph");
const { getConfig } = require("../config");
const { State, ROUTES } = require("./state");
const { ERROR_ANSWER } = require("./prompts");

/** Static route -> node name map. Every route has exactly one node. */
const ROUTE_TO_NODE = Object.freeze(
  Object.fromEntries(ROUTES.map((route) => [route, route])),
);

const FALLBACK_NODE = ROUTE_TO_NODE.refusal;

/**
 * Pure function from state to the next node name.
 *
 * Sticky flows come first: while `activeFlow` is set, a slot-filling reply like
 * "Tuesday 3pm" must return to that flow rather than being re-routed on its own weak
 * classification. Two things break the stickiness — the router seeing an explicit
 * cancel, or a confident classification into a different route (a topic change).
 */
function routeFromState(state, { topicChangeConfidence } = {}) {
  const { activeFlow, route, routeConfidence, slots } = state;

  // The router already failed and the boundary wrote a graceful answer. Skip the
  // branch entirely — running one would overwrite that answer with its own.
  if (state.error) {
    return "generate";
  }

  if (activeFlow && ROUTE_TO_NODE[activeFlow]) {
    const threshold = topicChangeConfidence ?? 1;
    const cancelled = slots?.cancelsActiveFlow === true;
    const changedTopic =
      route && route !== activeFlow && (routeConfidence ?? 0) >= threshold;

    if (!cancelled && !changedTopic) {
      return ROUTE_TO_NODE[activeFlow];
    }
  }

  return ROUTE_TO_NODE[route] ?? FALLBACK_NODE;
}

// ---------------------------------------------------------------------------
// Debug tracing
// ---------------------------------------------------------------------------

/**
 * Off unless MOONMIND_DEBUG is set. Read through getConfig, which is memoized.
 *
 * Tolerates config being unavailable: `buildGraph` can be handed an explicit
 * `topicChangeConfidence` and driven with no environment at all, which is exactly what
 * `test/agent/graph.test.js` does. A tracer must never be the reason a run fails.
 */
function debugEnabled() {
  try {
    return getConfig().moonmind.debug;
  } catch {
    return false;
  }
}

function debug(event, fields) {
  if (debugEnabled()) {
    console.log(event, fields);
  }
}

const ANSWER_PREVIEW_CHARS = 140;

/**
 * Describe a node's state update for the **server log**.
 *
 * Deliberately richer than `runs.js`'s `summarizeUpdate`, which feeds the persisted run
 * feed and is a redaction whitelist. This one goes to a log the operator already sees
 * stack traces in, so it carries slot values, document ids and a slice of the answer —
 * the things you actually need to tell a bad route from a bad retrieval.
 *
 * It is still a whitelist, not a serializer. Nothing here reaches into an unknown shape:
 * an LCEL sub-step's output can carry the resolved config, API keys and all, and a blind
 * stringify would put it in the log. Add fields deliberately.
 */
function describeUpdate(update) {
  if (!update || typeof update !== "object") {
    return {};
  }

  const described = {};
  const {
    route,
    routeConfidence,
    slots,
    documents,
    statsPayload,
    searchResults,
    finalAnswer,
    activeFlow,
    error,
  } = update;

  if (route !== undefined) described.route = route;
  if (routeConfidence !== undefined) described.confidence = routeConfidence;
  if (slots !== undefined) described.slots = slots;
  if (activeFlow !== undefined) described.activeFlow = activeFlow;

  if (Array.isArray(documents)) {
    described.documents = documents.length;
    described.documentIds = documents.map((document) => document?.id).filter(Boolean);
  }
  if (Array.isArray(searchResults)) {
    described.searchResults = searchResults.length;
    described.sourceUrls = searchResults.map((result) => result?.url).filter(Boolean);
  }
  if (statsPayload) {
    described.statsSources = Object.keys(statsPayload).filter(
      (key) => statsPayload[key] != null && !Array.isArray(statsPayload[key]),
    );
    described.statsUnavailable = (statsPayload.unavailable ?? []).map((entry) => entry?.source);
  }
  if (typeof finalAnswer === "string") {
    described.answerChars = finalAnswer.length;
    described.answerPreview = finalAnswer.slice(0, ANSWER_PREVIEW_CHARS);
  }
  if (error) described.nodeError = error;

  return described;
}

/**
 * Wrap a node so a throw becomes a graceful answer instead of a failed run.
 * Logs with node/runId/sessionId, records `error`, and lets flow continue to
 * `generate`, which passes the answer through.
 *
 * Every node passes through here, which is also what makes it the one place worth
 * instrumenting: the trace below covers `/chat`, the run feed, the eval scripts and the
 * tests alike, without any node knowing about it.
 */
function withErrorBoundary(name, node) {
  return async function guarded(state, config) {
    const runId = config?.configurable?.runId ?? null;
    const startedAt = Date.now();

    debug("agent.node.start", { node: name, runId, sessionId: state?.sessionId ?? null });

    try {
      const update = await node(state, config);
      debug("agent.node.end", {
        node: name,
        runId,
        ms: Date.now() - startedAt,
        ...describeUpdate(update),
      });
      return update;
    } catch (error) {
      console.error("agent.node.failed", {
        node: name,
        runId,
        sessionId: state?.sessionId ?? null,
        ms: Date.now() - startedAt,
        message: error?.message,
        stack: error?.stack,
      });

      return {
        error: { node: name, message: error?.message ?? "unknown error" },
        finalAnswer: ERROR_ANSWER,
      };
    }
  };
}

/**
 * Compile the graph. `nodes` must supply `router`, `generate`, and one entry per route.
 * @param {{ nodes: Record<string, Function>, checkpointer?: object,
 *          topicChangeConfidence?: number }} params
 */
function buildGraph({ nodes, checkpointer, topicChangeConfidence }) {
  // Resolved once at build time, not on every routing decision.
  const threshold = topicChangeConfidence ?? getConfig().moonmind.topicChangeConfidence;
  const selectNode = (state) => {
    const target = routeFromState(state, { topicChangeConfidence: threshold });

    // The branch decision is the single most useful thing to see when an answer came
    // from the wrong place: it shows the classification AND the stickiness that may have
    // overridden it.
    debug("agent.route", {
      target,
      route: state?.route ?? null,
      confidence: state?.routeConfidence ?? 0,
      activeFlow: state?.activeFlow ?? null,
      topicChangeConfidence: threshold,
    });

    return target;
  };

  const graph = new StateGraph(State)
    .addNode("router", withErrorBoundary("router", nodes.router))
    .addNode("generate", withErrorBoundary("generate", nodes.generate));

  ROUTES.forEach((route) => {
    graph.addNode(route, withErrorBoundary(route, nodes[route]));
  });

  // `generate` is a destination too: a router failure skips straight to it.
  const branchTargets = { ...ROUTE_TO_NODE, generate: "generate" };
  graph.addEdge(START, "router").addConditionalEdges("router", selectNode, branchTargets);
  ROUTES.forEach((route) => graph.addEdge(route, "generate"));
  graph.addEdge("generate", END);

  return graph.compile({ checkpointer });
}

module.exports = {
  buildGraph,
  routeFromState,
  withErrorBoundary,
  describeUpdate,
  debug,
  ROUTE_TO_NODE,
};
