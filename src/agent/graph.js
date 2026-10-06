"use strict";

// Graph wiring, the routing function, and the error boundary. No business logic:
// every node is supplied by the caller, which is what lets test/agent run the whole
// graph with fakes.

const { StateGraph, START, END } = require("@langchain/langgraph");
const { getConfig } = require("../config");
const {
  State,
  ROUTES,
  LEGACY_ROUTE_MAP,
  LEGACY_NODES,
  resolveLegacyRoute,
} = require("./state");
const { ERROR_ANSWER } = require("./prompts");

/** Static route -> node name map. Every route has exactly one node. */
const ROUTE_TO_NODE = Object.freeze(
  Object.fromEntries(ROUTES.map((route) => [route, route])),
);

const FALLBACK_NODE = ROUTE_TO_NODE.refusal;

// ---------------------------------------------------------------------------
// The escalation hop: knowledge -> agent, at most once per turn
// ---------------------------------------------------------------------------

/** Hops per turn. The only escalation edge in the graph runs from `knowledge`. */
const MAX_ESCALATIONS = 1;

/**
 * Pure function: where `knowledge` goes next. `knowledge` only *asks* (`escalate`); the
 * budget is enforced here and counted by `escalationHop`, both owned by the graph, so a
 * node that asks on every call — buggy, or a test fake built to — still gets one hop.
 *
 * The graph cannot loop even without the budget: `agent`'s only edge is to `generate`,
 * so `knowledge` is never re-entered in a turn. The budget is what makes that a checked
 * property rather than a fact about today's wiring.
 */
function routeAfterKnowledge(state) {
  if (state.error) {
    return "generate";
  }
  return state.escalate === true && (state.escalations ?? 0) < MAX_ESCALATIONS
    ? "escalation"
    : "generate";
}

/**
 * The hop itself: spend the budget, hand over to `agent`. A node rather than an edge
 * side effect because edges cannot write state — and as a node it appears in the Phase 4
 * feed as its own `escalation` step, which is how you see that it fired (not `escalate`:
 * LangGraph forbids a node sharing a name with a state channel). Deliberately not
 * injectable: the budget must not be something a caller can replace.
 */
async function escalationHop(state) {
  return { escalations: (state.escalations ?? 0) + 1 };
}


/**
 * Pure function from state to the next node name.
 *
 * **The precedence order, in full** (ARCHITECTURE.md §5). Two mechanisms can hold a
 * conversation in place — Phase 6.5's previous-route inheritance and this file's
 * `activeFlow` stickiness — and Phase 7 reconciled them into one order:
 *
 *   1. `error`        — the boundary already answered; run no branch at all.
 *   2. cancel         — "never mind" ends the flow AND blocks inheritance (the router
 *                       half of this lives in `applyConfidenceFloor`). Cancel beats both.
 *   3. `activeFlow`   — a genuinely in-progress multi-turn task outranks inheritance: it
 *                       means a node is waiting on an answer, not merely that the last
 *                       turn went somewhere. Broken only by a confident topic change.
 *   4. inheritance    — applied in the router, and only when confidence is below the
 *                       floor, so it never overrides a classification the model is sure
 *                       of. By the time state arrives here it is already folded into
 *                       `route`.
 *   5. `route`        — what the router decided.
 *   6. `refusal`      — unknown and unmapped.
 *
 * Nothing sets `activeFlow` today (step 3 is dormant, kept for Phase 10's mail flow), so in
 * practice the live order is 1, 2, 4, 5, 6.
 */
function routeFromState(state, { topicChangeConfidence } = {}) {
  const { routeConfidence, slots } = state;

  // 1. The router already failed and the boundary wrote a graceful answer. Skip the
  // branch entirely — running one would overwrite that answer with its own.
  if (state.error) {
    return "generate";
  }

  // Translate anything written under the old taxonomy before comparing or dispatching.
  const route = resolveLegacyRoute(state.route);
  const activeFlow = resolveLegacyRoute(state.activeFlow);

  // 2 and 3.
  if (activeFlow && ROUTE_TO_NODE[activeFlow]) {
    const threshold = topicChangeConfidence ?? 1;
    const cancelled = slots?.cancelsActiveFlow === true;
    const changedTopic =
      route && route !== activeFlow && (routeConfidence ?? 0) >= threshold;

    if (!cancelled && !changedTopic) {
      return ROUTE_TO_NODE[activeFlow];
    }
  }

  // 5 and 6. A legacy node kept alive (tech_web) is a valid target even though no current
  // label points at it.
  return ROUTE_TO_NODE[route] ?? (LEGACY_NODES.includes(route) ? route : FALLBACK_NODE);
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
    escalate,
    escalationReason,
    escalations,
    error,
  } = update;

  if (route !== undefined) described.route = route;
  if (routeConfidence !== undefined) described.confidence = routeConfidence;
  if (slots !== undefined) described.slots = slots;
  if (activeFlow !== undefined) described.activeFlow = activeFlow;
  if (escalate === true) described.escalate = escalationReason ?? true;
  if (escalations !== undefined) described.escalations = escalations;

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

  // Legacy nodes are registered alongside the current ones so a replayed thread has
  // somewhere real to land. They have no label pointing at them.
  const branchNodes = [...ROUTES, ...LEGACY_NODES.filter((node) => nodes[node])];

  branchNodes.forEach((route) => {
    graph.addNode(route, withErrorBoundary(route, nodes[route]));
  });

  // `generate` is a destination too: a router failure skips straight to it.
  const branchTargets = {
    ...ROUTE_TO_NODE,
    ...Object.fromEntries(branchNodes.map((node) => [node, node])),
    generate: "generate",
  };
  graph.addEdge(START, "router").addConditionalEdges("router", selectNode, branchTargets);

  // Every branch goes to `generate`, except `knowledge`, which may hop to `agent` once.
  // `agent` never escalates: its only edge is the ordinary one to `generate`.
  graph.addNode("escalation", withErrorBoundary("escalation", escalationHop));
  branchNodes
    .filter((route) => route !== "knowledge")
    .forEach((route) => graph.addEdge(route, "generate"));
  graph.addConditionalEdges("knowledge", routeAfterKnowledge, {
    escalation: "escalation",
    generate: "generate",
  });
  graph.addEdge("escalation", "agent");
  graph.addEdge("generate", END);

  return graph.compile({ checkpointer });
}

module.exports = {
  buildGraph,
  routeFromState,
  routeAfterKnowledge,
  MAX_ESCALATIONS,
  withErrorBoundary,
  describeUpdate,
  debug,
  ROUTE_TO_NODE,
  // Re-exported so a reader of the routing logic finds the legacy vocabulary next to it;
  // it lives in state.js because nodes need it too.
  LEGACY_ROUTE_MAP,
  LEGACY_NODES,
};
