"use strict";

// Node-level behaviour with injected fake models. The router and generate nodes read
// config, so a minimal environment is set before they are required.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "test-token";
process.env.REFRESH_PROFILE ??= "test-profile";
process.env.REFRESH_SECRET ??= "test-secret";
process.env.OPENAI_API_KEY ??= "sk-test-not-used";
process.env.MOONMIND_PASSWORD ??= "test-password";
process.env.GEMINI_API_KEY ??= "gem-test-not-used";
process.env.TAVILY_API_KEY ??= "tvly-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { HumanMessage, AIMessage } = require("@langchain/core/messages");

const { createRouterNode, LOW_CONFIDENCE_ROUTE } = require("../../src/agent/nodes/router");
const { createGenerateNode } = require("../../src/agent/nodes/generate");
const { refusal, listCapabilities, makeStubNode } = require("../../src/agent/nodes/simple");
const { ROUTES, recentMessages } = require("../../src/agent/state");
const { NOT_IMPLEMENTED_ANSWER, REFUSAL_ANSWER } = require("../../src/agent/prompts");

/** A model whose withStructuredOutput().invoke() resolves to `output`, or throws. */
function fakeRouterModel(output, { throws = false } = {}) {
  const seen = [];
  return {
    seen,
    withStructuredOutput() {
      return {
        invoke: async (messages) => {
          seen.push(messages);
          if (throws) {
            throw new Error("structured output failed");
          }
          return output;
        },
      };
    },
  };
}

const baseState = (overrides = {}) => ({
  sessionId: "s1",
  messages: [new HumanMessage("hello")],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

test("router writes route, confidence and slots from a confident classification", async () => {
  const node = createRouterNode({
    model: fakeRouterModel({
      route: "stats",
      confidence: 0.95,
      which: "github",
      cancelsActiveFlow: false,
    }),
  });

  const result = await node(baseState());

  assert.equal(result.route, "stats");
  assert.equal(result.routeConfidence, 0.95);
  assert.equal(result.slots.which, "github");
  assert.equal(result.slots.cancelsActiveFlow, false);
});

test("router keeps `which` only for the stats routes", async () => {
  for (const route of ["stats", "stats_and_docs"]) {
    const node = createRouterNode({
      model: fakeRouterModel({ route, confidence: 0.9, which: "both", cancelsActiveFlow: false }),
    });
    const result = await node(baseState());
    assert.equal(result.slots.which, "both", `${route} should keep which`);
  }

  const node = createRouterNode({
    model: fakeRouterModel({
      route: "about_me",
      confidence: 0.9,
      which: "github",
      cancelsActiveFlow: false,
    }),
  });
  const result = await node(baseState());
  assert.equal(result.slots.which, undefined, "non-stats routes must drop which");
});

test("a structured-output failure hits the deterministic fallback", async () => {
  const node = createRouterNode({ model: fakeRouterModel(null, { throws: true }) });

  const result = await node(baseState());

  assert.equal(result.route, LOW_CONFIDENCE_ROUTE);
  assert.equal(result.routeConfidence, 0);
  assert.deepEqual(result.slots, {});
});

test("low confidence redirects to the low-confidence route", async () => {
  const node = createRouterNode({
    model: fakeRouterModel({
      route: "tech_web",
      confidence: 0.2,
      which: null,
      cancelsActiveFlow: false,
    }),
  });

  const result = await node(baseState());

  assert.equal(result.route, LOW_CONFIDENCE_ROUTE);
  assert.equal(result.routeConfidence, 0.2, "the real confidence is still reported");
});

test("low confidence never lands on an action route", async () => {
  for (const route of ["book_catchup", "send_mail"]) {
    const node = createRouterNode({
      model: fakeRouterModel({ route, confidence: 0.35, which: null, cancelsActiveFlow: false }),
    });
    const result = await node(baseState());
    assert.equal(result.route, LOW_CONFIDENCE_ROUTE, `${route} must not run on a guess`);
  }
});

test("a confident action route is preserved", async () => {
  const node = createRouterNode({
    model: fakeRouterModel({
      route: "book_catchup",
      confidence: 0.9,
      which: null,
      cancelsActiveFlow: false,
    }),
  });

  assert.equal((await node(baseState())).route, "book_catchup");
});

test("router passes a capped slice of history to the model", async () => {
  const model = fakeRouterModel({
    route: "refusal",
    confidence: 1,
    which: null,
    cancelsActiveFlow: false,
  });
  const node = createRouterNode({ model });

  const messages = Array.from({ length: 50 }, (_, i) => new HumanMessage(`m${i}`));
  await node(baseState({ messages }));

  const sent = model.seen[0];
  // system prompt + at most historyMaxMessages (default 20)
  assert.ok(sent.length <= 21, `expected <= 21 messages, got ${sent.length}`);
  assert.equal(sent.at(-1).content, "m49", "the most recent message must survive");
});

test("router surfaces an explicit cancel", async () => {
  const node = createRouterNode({
    model: fakeRouterModel({
      route: "refusal",
      confidence: 0.9,
      which: null,
      cancelsActiveFlow: true,
    }),
  });

  assert.equal((await node(baseState())).slots.cancelsActiveFlow, true);
});

// ---------------------------------------------------------------------------
// Simple nodes
// ---------------------------------------------------------------------------

test("refusal returns a real answer without calling a model", async () => {
  const result = await refusal();

  assert.equal(result.finalAnswer, REFUSAL_ANSWER);
  assert.ok(result.finalAnswer.length > 40);
});

test("list_capabilities is templated from the route enum", async () => {
  const { finalAnswer } = await listCapabilities();

  assert.ok(finalAnswer.includes("GitHub"), "mentions stats");
  assert.ok(finalAnswer.includes("book time"), "mentions booking");
  // One bullet per advertised route: all routes except refusal and list_capabilities.
  const bullets = finalAnswer.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(bullets.length, ROUTES.length - 2);
});

test("stub nodes answer without clobbering router slots", async () => {
  const result = await makeStubNode("about_me")();

  assert.equal(result.finalAnswer, NOT_IMPLEMENTED_ANSWER);
  assert.equal(result.slots, undefined, "must not overwrite slots");
});

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

test("generate passes an existing finalAnswer straight through", async () => {
  const model = {
    invoke: async () => {
      throw new Error("model must not be called");
    },
  };
  const node = createGenerateNode({ model });

  const result = await node(baseState({ finalAnswer: "already answered" }));

  assert.equal(result.finalAnswer, undefined, "pass-through does not rewrite it");
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].content, "already answered");
});

test("generate synthesizes when no branch produced an answer", async () => {
  const node = createGenerateNode({
    model: { invoke: async () => new AIMessage("  synthesized answer  ") },
  });

  const result = await node(baseState({ finalAnswer: null }));

  assert.equal(result.finalAnswer, "synthesized answer");
  assert.equal(result.messages[0].content, "synthesized answer");
});

test("generate rejects empty model output rather than answering with nothing", async () => {
  const node = createGenerateNode({ model: { invoke: async () => new AIMessage("   ") } });

  await assert.rejects(() => node(baseState({ finalAnswer: null })), /empty content/);
});

// ---------------------------------------------------------------------------
// History cap
// ---------------------------------------------------------------------------

test("recentMessages keeps the tail and leaves short histories alone", () => {
  const messages = Array.from({ length: 10 }, (_, i) => i);

  assert.deepEqual(recentMessages(messages, 3), [7, 8, 9]);
  assert.deepEqual(recentMessages(messages, 50), messages);
  assert.deepEqual(recentMessages(messages, 0), messages);
  assert.deepEqual(recentMessages(null, 5), []);
});
