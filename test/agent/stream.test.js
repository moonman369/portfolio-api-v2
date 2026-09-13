"use strict";

// The live event feed against a real compiled graph with fake nodes — no Mongo, no
// model. This is where the `streamEvents` filtering is pinned down: LangGraph reports
// every runnable inside a node as well as the node itself, and a feed that forwarded
// all of it would be unreadable.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "t";
process.env.REFRESH_PROFILE ??= "p";
process.env.REFRESH_SECRET ??= "s";
process.env.OPENAI_API_KEY ??= "sk-test";
process.env.MOONMIND_PASSWORD ??= "pw";
process.env.GEMINI_API_KEY ??= "gem-test";

const test = require("node:test");
const assert = require("node:assert/strict");

const { z } = require("zod");
const { tool } = require("@langchain/core/tools");
const { RunnableLambda } = require("@langchain/core/runnables");

const { streamTurn, startRun } = require("../../src/agent");
const { buildGraph } = require("../../src/agent/graph");
const { ROUTES } = require("../../src/agent/state");

/**
 * A real graph whose nodes are fakes. `overrides` replaces individual nodes; everything
 * else is a no-op so the wiring stays complete.
 */
function graphWith(overrides = {}) {
  const nodes = {
    router: async () => ({ route: "stats", routeConfidence: 0.9 }),
    generate: async (state) => ({ finalAnswer: state.finalAnswer ?? "the answer" }),
  };
  ROUTES.forEach((route) => {
    nodes[route] = async () => ({});
  });
  nodes.stats = async () => ({ statsPayload: { github: { repos: 106 }, leetcode: null } });

  return buildGraph({ nodes: { ...nodes, ...overrides }, topicChangeConfidence: 1 });
}

/** Drain the generator, keeping both the steps and the turn it returns. */
async function collect(iterator) {
  const steps = [];
  let next = await iterator.next();
  while (!next.done) {
    steps.push(next.value);
    next = await iterator.next();
  }
  return { steps, turn: next.value };
}

const shape = (steps) => steps.map((step) => `${step.node}:${step.type}`);

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

test("a run streams ordered start/end steps and returns the final answer", async () => {
  const { steps, turn } = await collect(
    streamTurn({ sessionId: "s1", message: "how many repos?", runId: "r1" }, { graph: graphWith() }),
  );

  assert.deepEqual(shape(steps), [
    "router:start",
    "router:end",
    "stats:start",
    "stats:end",
    "generate:start",
    "generate:end",
  ]);

  assert.deepEqual(steps.map((step) => step.seq), [1, 2, 3, 4, 5, 6]);
  steps.forEach((step) => {
    assert.equal(step.runId, "r1");
    assert.ok(step.ts instanceof Date);
  });

  assert.equal(turn.answer, "the answer");
  assert.equal(turn.route, "stats");
  assert.equal(turn.runId, "r1");
  assert.equal(turn.error, null);
});

test("the steps carry the summaries, and __start__ is not one of them", async () => {
  const { steps } = await collect(
    streamTurn({ sessionId: "s1", message: "hi", runId: "r1" }, { graph: graphWith() }),
  );

  assert.ok(!steps.some((step) => step.node.startsWith("__")), "graph internals are not steps");

  const byNode = Object.fromEntries(
    steps.filter((step) => step.type === "end").map((step) => [step.node, step.summary]),
  );
  assert.equal(byNode.router, "route=stats confidence=0.90");
  assert.equal(byNode.stats, "stats=github");
  assert.equal(byNode.generate, "answer=10 chars");
});

test("a node's anonymous inner runnables do not each become a step", async () => {
  // A node built as an LCEL chain — about_me really is one — reports its inner steps
  // under the same `langgraph_node`. An unnamed one stays out of the feed.
  const nested = RunnableLambda.from(async () => ({ statsPayload: { github: { repos: 1 } } }));
  const graph = graphWith({ stats: async (state, config) => nested.invoke(state, config) });

  const { steps } = await collect(streamTurn({ sessionId: "s1", message: "hi", runId: "r1" }, { graph }));

  assert.equal(steps.filter((step) => step.node === "stats").length, 2, "exactly one start and one end");
});

test("a sub-step named `<node>.<step>` opts into the feed under its own name", async () => {
  // The convention `about_me.retrieve` relies on. Naming a runnable is how a node says
  // "this part is worth watching"; the label is the runnable's name, not the node's.
  const retrieve = RunnableLambda.from(async () => ({ documents: [{ id: "a" }, { id: "b" }] }))
    .withConfig({ runName: "about_me.retrieve" });

  const graph = graphWith({
    router: async () => ({ route: "about_me", routeConfidence: 1 }),
    about_me: async (state, config) => retrieve.invoke(state, config),
  });

  const { steps } = await collect(streamTurn({ sessionId: "s1", message: "hi", runId: "r1" }, { graph }));

  assert.deepEqual(shape(steps), [
    "router:start",
    "router:end",
    "about_me:start",
    "about_me.retrieve:start",
    "about_me.retrieve:end",
    "about_me:end",
    "generate:start",
    "generate:end",
  ]);
});

test("a runnable named exactly after its node does not double the node's steps", async () => {
  // What about-me.js used to do. Such a runnable is indistinguishable from the graph
  // node in `streamEvents`, so it must not be treated as a second boundary.
  const chain = RunnableLambda.from(async () => ({ documents: [] })).withConfig({ runName: "about_me" });

  const graph = graphWith({
    router: async () => ({ route: "about_me", routeConfidence: 1 }),
    about_me: async (state, config) => chain.invoke(state, config),
  });

  const { steps } = await collect(streamTurn({ sessionId: "s1", message: "hi", runId: "r1" }, { graph }));
  const boundaries = steps.filter((step) => step.node === "about_me");

  assert.deepEqual(boundaries.map((step) => step.type), ["start", "end"]);
});

test("a throwing node becomes an error step, and the run still answers", async () => {
  const graph = graphWith({
    router: async () => ({ route: "about_me", routeConfidence: 1 }),
    about_me: async () => {
      throw new Error("retrieval exploded");
    },
  });

  const { steps, turn } = await collect(
    streamTurn({ sessionId: "s1", message: "tell me about Ayan", runId: "r1" }, { graph }),
  );

  assert.deepEqual(shape(steps), [
    "router:start",
    "router:end",
    "about_me:start",
    "about_me:error",
    "generate:start",
    "generate:end",
  ]);

  const failure = steps.find((step) => step.type === "error");
  assert.equal(failure.summary, "retrieval exploded");

  // The Phase 4 criterion: an error step, then a graceful answer — not a failed run.
  assert.deepEqual(turn.error, { node: "about_me", message: "retrieval exploded" });
  assert.match(turn.answer, /Something went wrong/);
});

test("a tool call inside a node becomes one tool step", async () => {
  const search = tool(async ({ q }) => `results for ${q}`, {
    name: "web_search",
    description: "search",
    schema: z.object({ q: z.string() }),
  });

  const graph = graphWith({
    router: async () => ({ route: "tech_web", routeConfidence: 1 }),
    tech_web: async (state, config) => {
      await search.invoke({ q: "langgraph" }, config);
      return { searchResults: [1, 2] };
    },
  });

  const { steps } = await collect(streamTurn({ sessionId: "s1", message: "what is langgraph?", runId: "r1" }, { graph }));

  assert.deepEqual(shape(steps), [
    "router:start",
    "router:end",
    "tech_web:start",
    "tech_web:tool",
    "tech_web:end",
    "generate:start",
    "generate:end",
  ]);

  const toolStep = steps.find((step) => step.type === "tool");
  assert.equal(toolStep.summary, "web_search -> 21 chars");
  assert.ok(!toolStep.summary.includes("langgraph"), "tool arguments must not reach the feed");
});

// ---------------------------------------------------------------------------
// startRun
// ---------------------------------------------------------------------------

/** Records what `driveRun` writes, in order. */
function fakeStore() {
  const calls = { startRun: [], recordStep: [], finishRun: [], failRun: [] };
  return {
    calls,
    startRun: async (run) => calls.startRun.push(run),
    recordStep: async (step) => calls.recordStep.push(step),
    finishRun: async (result) => calls.finishRun.push(result),
    failRun: async (result) => calls.failRun.push(result),
  };
}

test("startRun opens the run before it resolves, then records every step", async () => {
  const store = fakeStore();

  const { runId, sessionId, completed } = await startRun(
    { sessionId: "s1", message: "how many repos?" },
    { graph: graphWith(), store },
  );

  // Pollable already: the run document exists before the caller gets the id back.
  assert.match(runId, /^[0-9a-f-]{36}$/);
  assert.equal(sessionId, "s1");
  assert.deepEqual(store.calls.startRun, [{ runId, sessionId: "s1", question: "how many repos?" }]);
  assert.equal(store.calls.recordStep.length, 0, "nothing has run yet");

  const turn = await completed;

  assert.deepEqual(shape(store.calls.recordStep), [
    "router:start",
    "router:end",
    "stats:start",
    "stats:end",
    "generate:start",
    "generate:end",
  ]);
  assert.equal(store.calls.finishRun.length, 1);
  assert.equal(store.calls.finishRun[0].runId, runId);
  assert.equal(store.calls.finishRun[0].turn.answer, "the answer");
  assert.equal(turn.answer, "the answer");
});

test("a graph that fails outside a node closes the run instead of rejecting", async () => {
  const store = fakeStore();
  const graph = {
    streamEvents() {
      throw new Error("The operation was aborted");
    },
  };

  const { runId, completed } = await startRun({ sessionId: "s1", message: "hi" }, { graph, store });

  // Resolves rather than rejects: POST /runs has already answered, so a rejection here
  // could only ever be an unhandled one.
  assert.equal(await completed, null);
  assert.deepEqual(store.calls.failRun, [{ runId, message: "The operation was aborted" }]);
  assert.equal(store.calls.finishRun.length, 0);
});
