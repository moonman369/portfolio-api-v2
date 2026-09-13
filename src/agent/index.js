"use strict";

// The only API the HTTP layer uses. Everything that runs the graph — the chat route,
// the run feed, the eval scripts — comes through here: `runTurn` for a single
// request/response turn, `startRun`/`streamTurn` for the live event feed.

const crypto = require("node:crypto");
const { HumanMessage } = require("@langchain/core/messages");
const { START } = require("@langchain/langgraph");
const { MongoDBSaver } = require("@langchain/langgraph-checkpoint-mongodb");
const { getConfig } = require("../config");
const { getClient } = require("../db");
const { buildGraph } = require("./graph");
const { ROUTES, PER_TURN_RESET } = require("./state");
const runs = require("./runs");
const { createRouterNode } = require("./nodes/router");
const { createGenerateNode } = require("./nodes/generate");
const { createStatsNode, createStatsAndDocsNode } = require("./nodes/stats");
const { createAboutMeNode } = require("./nodes/about-me");
const { makeAgentNode } = require("./nodes/agents");
const { TOOLSETS } = require("./tools");
const { TECH_WEB_SYSTEM_PROMPT } = require("./prompts");
const { refusal, listCapabilities, makeStubNode } = require("./nodes/simple");

// Routes whose real implementation lands in a later phase (6b, 7).
const STUBBED_ROUTES = Object.freeze(["complex", "book_catchup", "send_mail"]);

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

  // The only agent so far. `TOOLSETS.tech_web` is the whole of what it can do — there is
  // no second place to look, and no prompt that widens it.
  nodes.tech_web = makeAgentNode({
    name: "tech_web",
    toolset: TOOLSETS.tech_web,
    prompt: TECH_WEB_SYSTEM_PROMPT,
    sourcesField: "searchResults",
    // Classify before searching. The router already sends off-topic questions to
    // `refusal`, but it decides which branch answers, not whether a question that
    // reached this one is worth a web search — "which coin should I buy" is a plausible
    // industry question as far as it is concerned.
    scopeGuard: true,
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
 * The input and config for one turn. Shared so `runTurn` and `streamTurn` cannot drift
 * on the thread key, the per-turn reset, the recursion limit or the wall-clock cap.
 */
function buildInvocation({ sessionId, message, runId }) {
  const { moonmind } = getConfig();

  return {
    input: {
      // Per-turn reset first, so a stale field from the checkpointed thread can never
      // survive into this turn; the real values for this turn follow.
      ...PER_TURN_RESET,
      sessionId,
      rawQuery: message,
      messages: [new HumanMessage(message)],
    },
    config: {
      configurable: { thread_id: sessionId, runId },
      recursionLimit: moonmind.recursionLimit,
      // Wall-clock cap for the whole run, enforced by every runnable underneath.
      signal: AbortSignal.timeout(moonmind.runTimeoutMs),
    },
  };
}

/** The final state of a run, as the HTTP layer wants it. */
function toTurn({ sessionId, runId, state }) {
  const result = state ?? {};

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

/**
 * Run one conversational turn.
 *
 * @param {{ sessionId: string, message: string }} turn
 * @param {{ graph?: object }} [deps] Injected compiled graph, for tests and evals.
 * @returns {Promise<{sessionId, runId, route, routeConfidence, answer, documents,
 *   statsPayload, error}>}
 */
async function runTurn({ sessionId, message }, deps = {}) {
  const graph = deps.graph ?? (await getCompiledGraph());
  const runId = crypto.randomUUID();
  const { input, config } = buildInvocation({ sessionId, message, runId });

  return toTurn({ sessionId, runId, state: await graph.invoke(input, config) });
}

// ---------------------------------------------------------------------------
// The live event feed
// ---------------------------------------------------------------------------

/**
 * The graph's own event stream is the event source — there is no instrumentation layer,
 * and no node knows the feed exists. `streamEvents` reports every runnable inside a node
 * as well as the node itself, so the label decides what reaches the feed:
 *
 *   - `event.name === langgraph_node` is the node boundary itself;
 *   - `<node>.<something>` is a sub-step whose author named it, on purpose, to be
 *     watchable — `about_me.retrieve` is the first of them. Naming a runnable is how a
 *     node opts into the feed;
 *   - anything else is an anonymous inner runnable (`RunnableSequence`, `RunnableLambda`)
 *     and is dropped, or the feed would be unreadable.
 *
 * The root graph events carry no `langgraph_node` at all, and the root `on_chain_end` is
 * where the complete final state arrives.
 */
function stepLabel(event, node) {
  if (!node || node === START) {
    return null;
  }
  if (event.name === node) {
    return node;
  }
  return String(event.name ?? "").startsWith(`${node}.`) ? event.name : null;
}

/**
 * Which graph node an event belongs to.
 *
 * An agent node runs its own compiled graph inside itself, and that inner graph
 * overwrites `langgraph_node` with its own node names — a `web_search` call from the
 * `tech_web` agent arrives labelled `tools`, which says nothing about which branch ran
 * it and will collide with every other agent once Phases 6b and 7 land.
 *
 * `langgraph_checkpoint_ns` carries the full path (`tech_web:<id>|tools:<id>`), so the
 * outermost segment is the branch. Only nested events have a `|`; for everything else
 * `langgraph_node` is already right.
 */
function owningNode(event) {
  const namespace = event.metadata?.langgraph_checkpoint_ns;

  if (typeof namespace === "string" && namespace.includes("|")) {
    const outermost = namespace.split("|")[0].split(":")[0];
    if (outermost) {
      return outermost;
    }
  }

  return event.metadata?.langgraph_node ?? null;
}

/**
 * Stream one turn as ordered steps.
 *
 * Yields `{ runId, seq, node, type, ts, summary }` and **returns** the turn summary, so
 * a consumer drains the iterator for the feed and reads the final answer off the return
 * value.
 *
 * A node that throws does not surface as a stream error: `withErrorBoundary` catches it
 * and returns an update carrying `error`, which is what this reads to emit an `error`
 * step. That is the point — the run continues to `generate` and still answers.
 *
 * A tool produces one step, on completion. There is no `start` counterpart: the step
 * vocabulary has a single `tool` type, and a tool that never returns is already visible
 * as the missing `end` on the node holding it.
 */
async function* streamTurn({ sessionId, message, runId }, deps = {}) {
  const graph = deps.graph ?? (await getCompiledGraph());
  const { input, config } = buildInvocation({ sessionId, message, runId });

  let seq = 0;
  let finalState = null;
  // A node's boundary must appear exactly once per superstep. Nothing stops a node from
  // naming an inner runnable after itself — about-me.js did — and `streamEvents` then
  // reports two indistinguishable pairs. Keeping the first of each means a slip like
  // that costs a less precise `end` summary rather than a duplicated feed. Named
  // sub-steps are not deduplicated: a fan-out genuinely runs them more than once.
  const boundaries = new Set();
  const step = (node, type, summary) => ({
    runId,
    seq: (seq += 1),
    node,
    type,
    ts: new Date(),
    summary,
  });

  for await (const event of graph.streamEvents(input, { ...config, version: "v2" })) {
    const node = owningNode(event);

    if (!node) {
      if (event.event === "on_chain_end") {
        finalState = event.data?.output ?? finalState;
      }
      continue;
    }

    if (event.event === "on_tool_end") {
      yield step(node, "tool", runs.summarizeTool(event.name, event.data?.output));
      continue;
    }
    if (event.event === "on_tool_error") {
      yield step(node, "error", runs.summarizeTool(event.name, null));
      continue;
    }

    const label = stepLabel(event, node);
    if (!label) {
      continue;
    }

    if (label === node) {
      const boundary = `${node}:${event.metadata?.langgraph_step ?? 0}:${event.event}`;
      if (boundaries.has(boundary)) {
        continue;
      }
      boundaries.add(boundary);
    }

    if (event.event === "on_chain_start") {
      yield step(label, "start", "");
    } else if (event.event === "on_chain_end") {
      // A sub-step's output is whatever that runnable returns — for `about_me.prepare`
      // that includes the resolved config, API keys and all. `summarizeUpdate` is a
      // whitelist rather than a serializer precisely so this stays safe: a shape it
      // does not recognise summarizes to nothing.
      const update = event.data?.output ?? {};
      yield update?.error
        ? step(label, "error", runs.summarizeError(update.error))
        : step(label, "end", runs.summarizeUpdate(update));
    }
  }

  return toTurn({ sessionId, runId, state: finalState });
}

/** Drain `streamTurn` into the store. Resolves with the turn, or null; never rejects. */
async function driveRun({ sessionId, message, runId }, deps) {
  const { store } = deps;
  const iterator = streamTurn({ sessionId, message, runId }, deps);

  try {
    let next = await iterator.next();
    while (!next.done) {
      await store.recordStep(next.value, deps);
      next = await iterator.next();
    }

    await store.finishRun({ runId, turn: next.value }, deps);
    return next.value;
  } catch (error) {
    // The graph failed outside any node — a wall-clock abort or the recursion limit,
    // neither of which the per-node boundary sees. The run is closed as failed rather
    // than left `running` for its whole retention window, and nothing is rethrown:
    // `POST /runs` answered long ago, so a rejection here could only be an unhandled one.
    console.error("agent.run.failed", { runId, sessionId, message: error?.message });
    await store.failRun({ runId, message: error?.message }, deps).catch((storeError) => {
      console.error("agent.run.store_failed", { runId, message: storeError?.message });
    });
    return null;
  }
}

/**
 * Open a run and start it in the background.
 *
 * The run document is written before this resolves, so the `runId` handed back is
 * pollable immediately — a client that polls on the next tick finds a `running` run,
 * never a 404. `completed` is for tests and evals that want to wait; the HTTP handler
 * ignores it, which is the entire point of the feed.
 */
async function startRun({ sessionId, message }, deps = {}) {
  const store = deps.store ?? runs;
  const runId = crypto.randomUUID();
  const withStore = { ...deps, store };

  await store.startRun({ runId, sessionId, question: message }, withStore);

  return { runId, sessionId, completed: driveRun({ sessionId, message, runId }, withStore) };
}

module.exports = {
  runTurn,
  streamTurn,
  startRun,
  createNodes,
  getCompiledGraph,
  STUBBED_ROUTES,
  ROUTES,
};
