"use strict";

// runTurn against an injected graph — no Mongo, no checkpointer, no model.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "test-token";
process.env.REFRESH_PROFILE ??= "test-profile";
process.env.REFRESH_SECRET ??= "test-secret";
process.env.OPENAI_API_KEY ??= "sk-test-not-used";
process.env.MOONMIND_PASSWORD ??= "test-password";
process.env.GEMINI_API_KEY ??= "gem-test-not-used";

const test = require("node:test");
const assert = require("node:assert/strict");

const { runTurn, createNodes, STUBBED_ROUTES } = require("../../src/agent");
const { ROUTES } = require("../../src/agent/state");

/** Records what runTurn passes to the graph and replays a canned result. */
function fakeGraph(result = {}) {
  const calls = [];
  return {
    calls,
    invoke: async (input, config) => {
      calls.push({ input, config });
      return { route: "refusal", routeConfidence: 1, finalAnswer: "declined", error: null, ...result };
    },
  };
}

test("runTurn returns the turn summary the HTTP layer needs", async () => {
  const graph = fakeGraph({ route: "stats", routeConfidence: 0.9, finalAnswer: "106 repos" });

  const turn = await runTurn({ sessionId: "abc", message: "how many repos?" }, { graph });

  assert.equal(turn.sessionId, "abc");
  assert.equal(turn.route, "stats");
  assert.equal(turn.routeConfidence, 0.9);
  assert.equal(turn.answer, "106 repos");
  assert.equal(turn.error, null);
  assert.match(turn.runId, /^[0-9a-f-]{36}$/, "a runId is minted per turn");
});

test("runTurn clears every per-turn field in its invoke input", async () => {
  const graph = fakeGraph();

  await runTurn({ sessionId: "abc", message: "hi" }, { graph });

  const { input } = graph.calls[0];
  assert.equal(input.route, null);
  assert.equal(input.routeConfidence, 0);
  assert.deepEqual(input.documents, []);
  assert.equal(input.statsPayload, null);
  assert.deepEqual(input.searchResults, []);
  assert.equal(input.finalAnswer, null);
  assert.equal(input.error, null);
});

test("runTurn does not reset the fields meant to persist across turns", async () => {
  const graph = fakeGraph();

  await runTurn({ sessionId: "abc", message: "hi" }, { graph });

  const { input } = graph.calls[0];
  ["slots", "pendingConfirmation", "activeFlow", "summary"].forEach((field) => {
    assert.ok(!(field in input), `${field} must be left to the checkpointer`);
  });
});

test("runTurn keys the thread on sessionId and bounds the run", async () => {
  const graph = fakeGraph();

  await runTurn({ sessionId: "session-42", message: "hi" }, { graph });

  const { config, input } = graph.calls[0];
  assert.equal(config.configurable.thread_id, "session-42");
  assert.match(config.configurable.runId, /^[0-9a-f-]{36}$/);
  assert.equal(typeof config.recursionLimit, "number");
  assert.ok(config.signal instanceof AbortSignal, "a wall-clock cap is attached");
  assert.equal(input.messages.length, 1);
  assert.equal(input.messages[0].content, "hi");
  assert.equal(input.rawQuery, "hi");
});

test("runTurn reports a node failure recorded by the error boundary", async () => {
  const graph = fakeGraph({
    error: { node: "about_me", message: "boom" },
    finalAnswer: "graceful message",
  });

  const turn = await runTurn({ sessionId: "abc", message: "hi" }, { graph });

  assert.deepEqual(turn.error, { node: "about_me", message: "boom" });
  assert.equal(turn.answer, "graceful message");
});

test("the production node set covers router, generate and every route", () => {
  const nodes = createNodes();

  assert.equal(typeof nodes.router, "function");
  assert.equal(typeof nodes.generate, "function");
  ROUTES.forEach((route) => {
    assert.equal(typeof nodes[route], "function", `missing node for ${route}`);
  });
});

test("only the phases still to come are stubbed", () => {
  const live = ROUTES.filter((route) => !STUBBED_ROUTES.includes(route));

  // Phase 1: refusal + list_capabilities. Phase 2: the two stats routes.
  // Phase 3b: about_me. Update as each later phase lands — this is the tripwire for a
  // forgotten stub.
  assert.deepEqual(live.sort(), [
    "about_me",
    "list_capabilities",
    "refusal",
    "stats",
    "stats_and_docs",
  ]);
  assert.deepEqual(
    [...STUBBED_ROUTES].sort(),
    ["book_catchup", "complex", "send_mail", "tech_web"],
  );
});
