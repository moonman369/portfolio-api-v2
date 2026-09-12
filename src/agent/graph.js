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

/**
 * Wrap a node so a throw becomes a graceful answer instead of a failed run.
 * Logs with node/runId/sessionId, records `error`, and lets flow continue to
 * `generate`, which passes the answer through.
 */
function withErrorBoundary(name, node) {
  return async function guarded(state, config) {
    try {
      return await node(state, config);
    } catch (error) {
      console.error("agent.node.failed", {
        node: name,
        runId: config?.configurable?.runId ?? null,
        sessionId: state?.sessionId ?? null,
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
  const selectNode = (state) => routeFromState(state, { topicChangeConfidence: threshold });

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

module.exports = { buildGraph, routeFromState, withErrorBoundary, ROUTE_TO_NODE };
