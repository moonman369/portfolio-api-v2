"use strict";

// The only API the HTTP layer uses. Everything that runs the graph — the chat route,
// the Phase 4 run feed, the eval scripts — goes through runTurn.

const crypto = require("node:crypto");
const { HumanMessage } = require("@langchain/core/messages");
const { MongoDBSaver } = require("@langchain/langgraph-checkpoint-mongodb");
const { getConfig } = require("../config");
const { getClient } = require("../db");
const { buildGraph } = require("./graph");
const { ROUTES, PER_TURN_RESET } = require("./state");
const { createRouterNode } = require("./nodes/router");
const { createGenerateNode } = require("./nodes/generate");
const { createStatsNode, createStatsAndDocsNode } = require("./nodes/stats");
const { createAboutMeNode } = require("./nodes/about-me");
const { refusal, listCapabilities, makeStubNode } = require("./nodes/simple");

// Routes whose real implementation lands in a later phase (5, 6b, 7).
const STUBBED_ROUTES = Object.freeze([
  "tech_web",
  "complex",
  "book_catchup",
  "send_mail",
]);

/** The production node set. Tests build their own and pass it straight to buildGraph. */
function createNodes() {
  const nodes = {
    router: createRouterNode(),
    generate: createGenerateNode(),
    refusal,
    list_capabilities: listCapabilities,
  };

  STUBBED_ROUTES.forEach((route) => {
    nodes[route] = makeStubNode(route);
  });

  // stats_and_docs composes the other two rather than reimplementing either.
  nodes.about_me = createAboutMeNode();
  nodes.stats = createStatsNode();
  nodes.stats_and_docs = createStatsAndDocsNode({
    statsNode: nodes.stats,
    aboutMeNode: nodes.about_me,
  });

  return nodes;
}

let compiled = null;

async function getCompiledGraph() {
  if (!compiled) {
    const { mongo } = getConfig();
    const checkpointer = new MongoDBSaver({
      client: await getClient(),
      dbName: mongo.dbName,
      checkpointCollectionName: mongo.checkpointCollection,
      checkpointWritesCollectionName: mongo.checkpointWritesCollection,
    });

    compiled = buildGraph({ nodes: createNodes(), checkpointer });
  }
  return compiled;
}

/**
 * Run one conversational turn.
 *
 * @param {{ sessionId: string, message: string }} turn
 * @param {{ graph?: object }} [deps] Injected compiled graph, for tests and evals.
 * @returns {Promise<{sessionId, runId, route, routeConfidence, answer, documents,
 *   statsPayload, error}>}
 */
async function runTurn({ sessionId, message }, deps = {}) {
  const { moonmind } = getConfig();
  const graph = deps.graph ?? (await getCompiledGraph());
  const runId = crypto.randomUUID();

  const result = await graph.invoke(
    {
      // Per-turn reset first, so a stale field from the checkpointed thread can never
      // survive into this turn; the real values for this turn follow.
      ...PER_TURN_RESET,
      sessionId,
      rawQuery: message,
      messages: [new HumanMessage(message)],
    },
    {
      configurable: { thread_id: sessionId, runId },
      recursionLimit: moonmind.recursionLimit,
      // Wall-clock cap for the whole run, enforced by every runnable underneath.
      signal: AbortSignal.timeout(moonmind.runTimeoutMs),
    },
  );

  return {
    sessionId,
    runId,
    route: result.route ?? null,
    routeConfidence: result.routeConfidence ?? 0,
    answer: result.finalAnswer ?? null,
    documents: result.documents ?? [],
    statsPayload: result.statsPayload ?? null,
    error: result.error ?? null,
  };
}

module.exports = { runTurn, createNodes, getCompiledGraph, STUBBED_ROUTES, ROUTES };
