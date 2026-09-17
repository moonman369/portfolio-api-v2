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
const {
  refusal,
  listCapabilities,
  greeting,
  makeStubNode,
} = require("../../src/agent/nodes/simple");
const { ROUTES, recentMessages } = require("../../src/agent/state");
const {
  NOT_IMPLEMENTED_ANSWER,
  REFUSAL_ANSWER,
  ERROR_ANSWER,
  HIDDEN_CAPABILITIES,
  GREETINGS,
} = require("../../src/agent/prompts");

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

test("router keeps `which` and `withDocuments` only for stats", async () => {
  const stats = createRouterNode({
    model: fakeRouterModel({
      route: "stats",
      confidence: 0.9,
      which: "both",
      withDocuments: true,
      action: null,
      cancelsActiveFlow: false,
    }),
  });
  const onStats = await stats(baseState());
  assert.equal(onStats.slots.which, "both");
  assert.equal(onStats.slots.withDocuments, true, "the mixed question keeps its slot");

  const node = createRouterNode({
    model: fakeRouterModel({
      route: "knowledge",
      confidence: 0.9,
      which: "github",
      withDocuments: true,
      action: "mail",
      cancelsActiveFlow: false,
    }),
  });
  const result = await node(baseState());
  assert.equal(result.slots.which, undefined, "non-stats routes must drop which");
  assert.equal(result.slots.withDocuments, undefined, "and withDocuments");
  assert.equal(result.slots.action, undefined, "and an action meant for another route");
});

test("a pure numbers question carries no withDocuments slot", async () => {
  const node = createRouterNode({
    model: fakeRouterModel({
      route: "stats",
      confidence: 0.95,
      which: "github",
      withDocuments: false,
      action: null,
      cancelsActiveFlow: false,
    }),
  });

  const result = await node(baseState());
  assert.equal(result.slots.withDocuments, undefined, "absent, so the stats node skips retrieval");
});

test("router lifts `action` into slots for the action route", async () => {
  for (const action of ["book", "mail"]) {
    const node = createRouterNode({
      model: fakeRouterModel({
        route: "action",
        confidence: 0.9,
        which: null,
        withDocuments: false,
        action,
        cancelsActiveFlow: false,
      }),
    });

    assert.equal((await node(baseState())).slots.action, action);
  }
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
      route: "agent",
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
  for (const route of ["action"]) {
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
      route: "action",
      confidence: 0.9,
      which: null,
      cancelsActiveFlow: false,
    }),
  });

  assert.equal((await node(baseState())).route, "action");
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

test("capabilities is templated from the route enum", async () => {
  const { finalAnswer } = await listCapabilities();

  assert.ok(finalAnswer.includes("GitHub"), "mentions stats");
  assert.ok(finalAnswer.includes("book time"), "mentions booking");
  // One bullet per advertised route: every route except the hidden ones.
  const bullets = finalAnswer.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(bullets.length, ROUTES.length - HIDDEN_CAPABILITIES.length);
  assert.ok(!finalAnswer.includes("Hey"), "greeting is not advertised as a capability");
});

test("a greeting gets a greeting, not the capability menu", async () => {
  // "Hey" used to return the seven-item menu — twice in the same session.
  const { finalAnswer } = await greeting({ messages: [new HumanMessage("Hey!")] });

  const bullets = finalAnswer.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(bullets.length, 0, "no capability list");
  assert.ok(finalAnswer.length < 200, "short");
  assert.ok(GREETINGS.includes(finalAnswer), "one of the fixed set");
});

test("a repeat greeting in one session is not word-for-word identical", async () => {
  const first = await greeting({ messages: [new HumanMessage("Hey")] });
  // Later in the same conversation: two turns have accumulated four messages.
  const later = await greeting({
    messages: [
      new HumanMessage("Hey"),
      new AIMessage(first.finalAnswer),
      new HumanMessage("Ayan's resume"),
      new AIMessage("...an answer..."),
      new HumanMessage("Hey"),
    ],
  });

  assert.notEqual(later.finalAnswer, first.finalAnswer);
  assert.ok(GREETINGS.includes(later.finalAnswer));
});

test("stub nodes answer without clobbering router slots", async () => {
  const result = await makeStubNode("knowledge")();

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

// ---------------------------------------------------------------------------
// Router history hygiene
// ---------------------------------------------------------------------------

test("the router never sees MoonMind's own canned dead-ends", async () => {
  // Without this filter the router reads its own refusals as precedent and keeps
  // refusing: two refused asks in one session turned "Ayan's resume" from about_me@0.9
  // into refusal@1.0 against the real model, and 1.0 clears the confidence floor, so
  // nothing downstream catches it. Prompt wording was measured and did not fix it.
  const model = fakeRouterModel({
    route: "knowledge",
    confidence: 0.9,
    which: null,
    cancelsActiveFlow: false,
  });

  await createRouterNode({ model })(
    baseState({
      messages: [
        new HumanMessage("give me Ayan's resume"),
        new AIMessage(REFUSAL_ANSWER),
        new HumanMessage("his cv please"),
        new AIMessage(NOT_IMPLEMENTED_ANSWER),
        new HumanMessage("and this one errored"),
        new AIMessage(ERROR_ANSWER),
        new HumanMessage("Ayan's resume"),
      ],
    }),
  );

  const sent = model.seen[0];
  const everything = sent.map((message) => String(message.content)).join("\n");

  assert.ok(!everything.includes(REFUSAL_ANSWER), "the refusal answer is filtered out");
  assert.ok(!everything.includes(NOT_IMPLEMENTED_ANSWER), "the stub answer is filtered out");
  assert.ok(!everything.includes(ERROR_ANSWER), "the error answer is filtered out");

  // Every human turn survives — the earlier ones as `user:` lines in the context block,
  // the latest as the message actually being classified.
  ["give me Ayan's resume", "his cv please", "and this one errored"].forEach((turn) => {
    assert.ok(everything.includes(`user: ${turn}`), `earlier turn kept as context: ${turn}`);
  });

  const humanTurns = sent.filter((message) => message.getType() === "human");
  assert.deepEqual(
    humanTurns.map((message) => String(message.content)),
    ["Ayan's resume"],
    "exactly one HumanMessage: the message being classified",
  );
});

test("the router still sees real answers, so follow-ups stay resolvable", async () => {
  const model = fakeRouterModel({
    route: "knowledge",
    confidence: 0.9,
    which: null,
    cancelsActiveFlow: false,
  });
  const realAnswer = "Ayan works mostly in Node.js, Java and Spring Boot.";

  await createRouterNode({ model })(
    baseState({
      messages: [
        new HumanMessage("what are his backend skills?"),
        new AIMessage(realAnswer),
        new HumanMessage("what about the frontend?"),
      ],
    }),
  );

  const everything = model.seen[0].map((message) => String(message.content)).join("\n");
  assert.ok(
    everything.includes(`assistant: ${realAnswer}`),
    "a genuine answer is context, not contamination",
  );
});

test("the router is given the message to classify, not a transcript to wade through", async () => {
  // The bug this fixes: raw history meant the live message was 0.9% of the router's
  // input (55 chars of 5857) and lost to the assistant's own prose. It classified
  // `refusal` at 1.00 three times out of three; the same message alone gave about_me.
  const model = fakeRouterModel({
    route: "knowledge",
    confidence: 0.9,
    which: null,
    cancelsActiveFlow: false,
  });
  const longAnswer = `Here is a resume overview. ${"Ayan builds microservices. ".repeat(80)}`;

  await createRouterNode({ model })(
    baseState({
      messages: [
        new HumanMessage("Ayan's resume"),
        new AIMessage(longAnswer),
        new HumanMessage("Not the Resume overview.... I want just the resume link"),
      ],
      previousRoute: "knowledge",
    }),
  );

  const sent = model.seen[0];
  const everything = sent.map((message) => String(message.content)).join("\n");

  assert.ok(!everything.includes(longAnswer), "the long answer is clipped, not replayed");
  assert.ok(everything.includes("previous turn was routed to `knowledge`"), "previous route is stated");
  assert.equal(
    String(sent[sent.length - 1].content),
    "Not the Resume overview.... I want just the resume link",
    "the message being classified is the last thing the model sees",
  );
});

test("an unsure follow-up continues the previous route instead of refusing", async () => {
  // "no, just the link" after an about_me turn. The live failure came back at confidence
  // 1.00, which no floor catches — the context block and the prompt rules cover that. This
  // is the net underneath: when the model is genuinely unsure, continue the exchange.
  const model = fakeRouterModel({
    route: "refusal",
    confidence: 0.3,
    which: null,
    cancelsActiveFlow: false,
  });

  const result = await createRouterNode({ model })(
    baseState({
      messages: [
        new HumanMessage("Ayan's resume"),
        new AIMessage("Here is an overview of his resume..."),
        new HumanMessage("no, just the link"),
      ],
      previousRoute: "knowledge",
    }),
  );

  assert.equal(result.route, "knowledge");
});

test("an unsure turn never inherits a route that refuses or acts", async () => {
  const unsure = { confidence: 0.2, which: null, cancelsActiveFlow: false };

  for (const previousRoute of ["refusal", "greeting", "capabilities", "action", null]) {
    const model = fakeRouterModel({ route: "refusal", ...unsure });
    const result = await createRouterNode({ model })(
      baseState({ messages: [new HumanMessage("hmm")], previousRoute }),
    );

    assert.equal(
      result.route,
      LOW_CONFIDENCE_ROUTE,
      `previousRoute=${previousRoute} must not be inherited`,
    );
  }
});

test("a first turn sends no conversation context at all", async () => {
  const model = fakeRouterModel({
    route: "knowledge",
    confidence: 0.9,
    which: null,
    cancelsActiveFlow: false,
  });

  await createRouterNode({ model })(baseState({ messages: [new HumanMessage("Ayan's resume")] }));

  const sent = model.seen[0];
  assert.equal(sent.length, 2, "system prompt plus the message — no empty context heading");
  assert.ok(!String(sent[0].content).includes("CONTEXT - the conversation so far"));
});
