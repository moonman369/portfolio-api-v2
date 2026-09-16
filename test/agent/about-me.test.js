"use strict";

// The about_me node and the full synthesis path, with retrieval and the model faked.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "t";
process.env.REFRESH_PROFILE ??= "p";
process.env.REFRESH_SECRET ??= "s";
process.env.OPENAI_API_KEY ??= "sk-test";
process.env.MOONMIND_PASSWORD ??= "pw";
process.env.GEMINI_API_KEY ??= "gem-test";
process.env.TAVILY_API_KEY ??= "tvly-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { HumanMessage, AIMessage } = require("@langchain/core/messages");

const { createAboutMeNode, resolveQuery } = require("../../src/agent/nodes/about-me");
const { createGenerateNode, buildContextBlocks } = require("../../src/agent/nodes/generate");

const CONFIG = Object.freeze({
  moonmind: { historyMaxMessages: 20 },
  retrieval: { decomposeEnabled: false, rerankEnabled: false },
});

const doc = (id, extra = {}) => ({
  id,
  title: `Document ${id}`,
  category: "project",
  tags: ["rag"],
  content_full: `content for ${id}`,
  summary_for_embedding: "keyword soup",
  metadata: { domain: "projects", verified: true, impact_score: 99 },
  score: 0.05,
  ...extra,
});

/** Records what the node asks retrieval for, and replays a canned result. */
function fakeRetrieve(result = {}) {
  const calls = [];
  const fn = async (query, options) => {
    calls.push({ query, options });
    return { documents: [doc("a"), doc("b")], failedArms: [], ...result };
  };
  fn.calls = calls;
  return fn;
}

const nodeDeps = (retrieve, overrides = {}) => ({
  retrieve,
  config: CONFIG,
  models: { intent: "fake-intent" },
  ...overrides,
});

const state = (overrides = {}) => ({
  sessionId: "s1",
  rawQuery: "what projects has he built?",
  messages: [new HumanMessage("what projects has he built?")],
  documents: [],
  statsPayload: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// about_me node
// ---------------------------------------------------------------------------

test("writes documents and nothing else", async () => {
  const retrieve = fakeRetrieve();
  const result = await createAboutMeNode(nodeDeps(retrieve))(state());

  assert.deepEqual(Object.keys(result), ["documents", "retrievalDebug"]);
  assert.deepEqual(result.documents.map((d) => d.id), ["a", "b"]);
  assert.equal(result.retrievalDebug, null, "off unless MOONMIND_RETRIEVAL_DEBUG is on");
  assert.equal(result.finalAnswer, undefined, "generate owns the answer");
});

test("retrieves against the turn's query", async () => {
  const retrieve = fakeRetrieve();
  await createAboutMeNode(nodeDeps(retrieve))(state());

  assert.equal(retrieve.calls[0].query, "what projects has he built?");
});

test("falls back to the last message when rawQuery is missing", async () => {
  const retrieve = fakeRetrieve();
  await createAboutMeNode(nodeDeps(retrieve))(
    state({ rawQuery: "", messages: [new HumanMessage("tell me about his certifications")] }),
  );

  assert.equal(retrieve.calls[0].query, "tell me about his certifications");
});

test("an empty query skips retrieval instead of searching for nothing", async () => {
  const retrieve = fakeRetrieve();
  const result = await createAboutMeNode(nodeDeps(retrieve))(
    state({ rawQuery: "", messages: [] }),
  );

  assert.equal(retrieve.calls.length, 0);
  assert.deepEqual(result.documents, []);
});

test("passes the injected models through to retrieval", async () => {
  const retrieve = fakeRetrieve();
  await createAboutMeNode(nodeDeps(retrieve))(state());

  assert.deepEqual(retrieve.calls[0].options.models, { intent: "fake-intent" });
});

test("an empty result set is a valid answer, not an error", async () => {
  const retrieve = fakeRetrieve({ documents: [] });
  const result = await createAboutMeNode(nodeDeps(retrieve))(state());

  assert.deepEqual(result.documents, []);
});

test("a degraded arm still returns the documents that were found", async () => {
  const retrieve = fakeRetrieve({
    documents: [doc("a")],
    failedArms: [{ source: "semantic", message: "atlas down" }],
  });

  const result = await createAboutMeNode(nodeDeps(retrieve))(state());
  assert.deepEqual(result.documents.map((d) => d.id), ["a"]);
});

test("a retrieval failure propagates, so the error boundary can catch it", async () => {
  const retrieve = async () => {
    throw new Error("retrieval exploded");
  };

  await assert.rejects(
    () => createAboutMeNode(nodeDeps(retrieve))(state()),
    /retrieval exploded/,
  );
});

test("resolveQuery trims and tolerates junk", () => {
  assert.equal(resolveQuery({ rawQuery: "  spaced  " }), "spaced");
  assert.equal(resolveQuery({ rawQuery: "", messages: [] }), "");
  assert.equal(resolveQuery({ messages: [{ content: 42 }] }), "");
});

// ---------------------------------------------------------------------------
// generate — full synthesis
// ---------------------------------------------------------------------------

/** Captures the prompt the model is handed. */
function fakeModel(answer = "synthesized answer") {
  const seen = [];
  return { seen, invoke: async (messages) => {
    seen.push(messages);
    return new AIMessage(answer);
  } };
}

const contextOf = (model) =>
  model.seen[0]
    .map((message) => String(message.content))
    .filter((content) => content.startsWith("CONTEXT"))
    .join("\n");

test("documents reach the prompt sanitized", async () => {
  const model = fakeModel();
  await createGenerateNode({ model, config: CONFIG })(state({ documents: [doc("a")] }));

  const context = contextOf(model);
  assert.match(context, /supporting document/);
  assert.match(context, /content for a/);
  assert.doesNotMatch(context, /impact_score/, "editorial scores never reach the model");
  assert.doesNotMatch(context, /keyword soup/, "summary_for_embedding is not prose");
});

test("a stats payload and documents can both be in context at once", async () => {
  const model = fakeModel();
  await createGenerateNode({ model, config: CONFIG })(
    state({
      documents: [doc("a")],
      statsPayload: { requested: "github", github: { repos: 106 }, unavailable: [] },
    }),
  );

  const context = contextOf(model);
  assert.match(context, /supporting document/);
  assert.match(context, /"repos":106/);
});

test("an empty retrieval is told so explicitly", async () => {
  const model = fakeModel();
  await createGenerateNode({ model, config: CONFIG })(state({ documents: [] }));

  assert.match(contextOf(model), /no supporting documents matched/);
});

test("a stats-only turn is not told its documents are missing", async () => {
  const model = fakeModel();
  await createGenerateNode({ model, config: CONFIG })(
    state({ documents: [], statsPayload: { github: { repos: 106 }, unavailable: [] } }),
  );

  assert.doesNotMatch(contextOf(model), /no supporting documents matched/);
});

test("today's date is supplied as an ISO date, not epoch milliseconds", async () => {
  const model = fakeModel();
  await createGenerateNode({ model, config: CONFIG, now: new Date("2026-09-13T10:00:00Z") })(
    state(),
  );

  assert.match(contextOf(model), /today's date is 2026-09-13/);
  assert.doesNotMatch(contextOf(model), /\b17\d{11}\b/, "no raw epoch timestamp");
});

test("context blocks come after the conversation history", async () => {
  const model = fakeModel();
  await createGenerateNode({ model, config: CONFIG })(state({ documents: [doc("a")] }));

  const contents = model.seen[0].map((m) => String(m.content));
  const lastHuman = contents.findIndex((c) => c.includes("what projects has he built?"));
  const firstContext = contents.findIndex((c) => c.startsWith("CONTEXT"));

  assert.ok(lastHuman < firstContext, "context sits closest to the question");
});

test("history is capped before it reaches the model", async () => {
  const model = fakeModel();
  const messages = Array.from({ length: 60 }, (_, i) => new HumanMessage(`m${i}`));

  await createGenerateNode({ model, config: CONFIG })(state({ messages }));

  // system prompt + <= 20 history + context blocks
  const history = model.seen[0].filter((m) => m instanceof HumanMessage);
  assert.equal(history.length, 20);
  assert.equal(history.at(-1).content, "m59");
});

test("an existing finalAnswer still passes through untouched", async () => {
  const model = {
    invoke: async () => {
      throw new Error("model must not be called");
    },
  };

  const result = await createGenerateNode({ model, config: CONFIG })(
    state({ finalAnswer: "already answered", documents: [doc("a")] }),
  );

  assert.equal(result.messages[0].content, "already answered");
});

test("buildContextBlocks always leads with the date", () => {
  const blocks = buildContextBlocks({ documents: [], statsPayload: null });

  assert.match(blocks[0], /today's date/);
});

test("generate records this turn's route for the next turn's router", async () => {
  // `route` is cleared by PER_TURN_RESET before the router runs, so the only way it can
  // know what the last exchange was about is if generate carries it across.
  const model = { invoke: async () => ({ content: "An answer." }) };

  const synthesized = await createGenerateNode({ model, config: CONFIG })(
    state({ route: "about_me", documents: [doc("a")] }),
  );
  assert.equal(synthesized.previousRoute, "about_me");

  // The pass-through path too: templated and agentic branches answer without a model,
  // and they are exactly the routes a follow-up is most likely to arrive after.
  const passedThrough = await createGenerateNode({ model, config: CONFIG })(
    state({ route: "tech_web", finalAnswer: "already answered" }),
  );
  assert.equal(passedThrough.previousRoute, "tech_web");
});
