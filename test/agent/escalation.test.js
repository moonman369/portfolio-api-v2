"use strict";

// Phase 9's knowledge -> agent escalation. The whole hop runs through a real compiled
// graph with fake nodes: the trigger, the one-hop budget, the stats limitation, the
// per-turn reset, the handover of documents and history, and the step in the feed.

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
const { MemorySaver } = require("@langchain/langgraph");
const { HumanMessage, AIMessage } = require("@langchain/core/messages");
const { FakeToolCallingModel } = require("langchain");

const { buildGraph, routeAfterKnowledge, MAX_ESCALATIONS } = require("../../src/agent/graph");
const { ROUTES, PER_TURN_RESET } = require("../../src/agent/state");
const { createKnowledgeNode, escalationReason } = require("../../src/agent/nodes/knowledge");
const { createStatsAndDocsNode } = require("../../src/agent/nodes/stats");
const { makeAgentNode } = require("../../src/agent/nodes/agents");
const { streamTurn } = require("../../src/agent");
const { summarizeUpdate } = require("../../src/agent/runs");
const { getConfig } = require("../../src/config");

// Far below the production default of 25. The escalated path is five supersteps —
// router, knowledge, escalation, agent, generate — so a limit of 6 proves the hop is
// bounded: one more step of looping and LangGraph would throw GraphRecursionError.
const TIGHT_RECURSION_LIMIT = 6;

const MOONMIND = Object.freeze({ escalationMinTopScore: 0.84, escalationTerms: [] });

/** A graph where every node records its visit. `overrides` replaces individual nodes. */
function compile(overrides = {}) {
  const visited = [];
  const record = (name, update = {}) => async () => {
    visited.push(name);
    return update;
  };

  const nodes = {
    router: async () => ({ route: "knowledge", routeConfidence: 1 }),
    generate: async (state) => {
      visited.push("generate");
      return { finalAnswer: state.finalAnswer ?? "generated", messages: [new AIMessage("a")] };
    },
  };
  ROUTES.forEach((route) => {
    nodes[route] = record(route, { finalAnswer: `answer from ${route}` });
  });
  nodes.agent = record("agent", { finalAnswer: "agent answer", searchResults: [{ url: "https://w" }] });

  const wrapped = Object.fromEntries(
    Object.entries({ ...nodes, ...overrides }).map(([name, node]) => [
      name,
      overrides[name] && name !== "router"
        ? async (state, config) => {
            visited.push(name);
            return node(state, config);
          }
        : node,
    ]),
  );

  return {
    graph: buildGraph({ nodes: wrapped, checkpointer: new MemorySaver(), topicChangeConfidence: 1 }),
    visited,
  };
}

const turn = (message, extra = {}) => ({
  ...PER_TURN_RESET,
  sessionId: "s1",
  rawQuery: message,
  messages: [new HumanMessage(message)],
  ...extra,
});

const config = (thread = "s1") => ({
  configurable: { thread_id: thread, runId: "r1" },
  recursionLimit: TIGHT_RECURSION_LIMIT,
});

/** A knowledge node that asks for the hop on every call — the looping worst case. */
const alwaysWeak = async () => ({
  documents: [{ id: "d1", title: "Doc 1" }],
  escalate: true,
  escalationReason: "weak_retrieval",
});

// ---------------------------------------------------------------------------
// The budget: once, and only once
// ---------------------------------------------------------------------------

test("a node that always reports weak results still terminates, with escalations === 1", async () => {
  const { graph, visited } = compile({ knowledge: alwaysWeak });

  const result = await graph.invoke(turn("anything"), config());

  assert.deepEqual(visited, ["knowledge", "agent", "generate"]);
  assert.equal(result.escalations, 1);
  assert.equal(result.finalAnswer, "agent answer");
  assert.equal(result.error, null, "the recursion limit was never reached");
});

test("the agent asking to escalate too goes nowhere: agent never escalates", async () => {
  const { graph, visited } = compile({
    knowledge: alwaysWeak,
    agent: async () => ({ finalAnswer: "agent answer", escalate: true, escalationReason: "weak_retrieval" }),
  });

  const result = await graph.invoke(turn("anything"), config());

  assert.deepEqual(visited, ["knowledge", "agent", "generate"]);
  assert.equal(result.escalations, 1);
});

test("the edge refuses a second hop once the budget is spent", () => {
  assert.equal(MAX_ESCALATIONS, 1);
  assert.equal(routeAfterKnowledge({ escalate: true, escalations: 0 }), "escalation");
  assert.equal(routeAfterKnowledge({ escalate: true, escalations: 1 }), "generate");
  assert.equal(routeAfterKnowledge({ escalate: false, escalations: 0 }), "generate");
  assert.equal(routeAfterKnowledge({}), "generate");
});

test("a knowledge node that threw does not escalate — the boundary's answer stands", async () => {
  const { graph, visited } = compile({
    knowledge: async () => {
      throw new Error("atlas down");
    },
  });

  const result = await graph.invoke(turn("anything"), config());

  assert.deepEqual(visited, ["knowledge", "generate"]);
  assert.equal(result.escalations, 0);
  assert.equal(result.error.node, "knowledge");
});

test("ordinary retrieval does not escalate: knowledge goes straight to generate", async () => {
  const { graph, visited } = compile({
    knowledge: async () => ({ documents: [{ id: "d1" }], escalate: false, escalationReason: null }),
  });

  const result = await graph.invoke(turn("what certifications does he hold?"), config());

  assert.deepEqual(visited, ["knowledge", "generate"]);
  assert.equal(result.escalations, 0);
});

test("the budget is per turn: the next turn on the same session may hop again", async () => {
  const { graph, visited } = compile({ knowledge: alwaysWeak });

  await graph.invoke(turn("first"), config("same"));
  const second = await graph.invoke(turn("second"), config("same"));

  assert.deepEqual(visited, ["knowledge", "agent", "generate", "knowledge", "agent", "generate"]);
  assert.equal(second.escalations, 1, "reset to 0 by runTurn's input, then spent once");
});

test("a direct agent route never passes through the hop", async () => {
  const { graph, visited } = compile({ router: async () => ({ route: "agent", routeConfidence: 1 }) });

  const result = await graph.invoke(turn("what's new in LangGraph?"), config());

  assert.deepEqual(visited, ["agent", "generate"]);
  assert.equal(result.escalations, 0);
});

// ---------------------------------------------------------------------------
// The accepted limitation: stats + withDocuments cannot escalate
// ---------------------------------------------------------------------------

test("stats + withDocuments does NOT escalate, even when its retrieval would have (accepted limitation)", async () => {
  // Decided 2026-09-23 (PROGRESS.md Decisions): the only escalation edge runs from
  // `knowledge`. A mixed question routes to `stats`, which composes the knowledge node
  // but keeps only its documents — so a three-part question (numbers AND documents AND
  // market framing) is answered without the hop. This test pins that down as intended
  // behaviour, not a bug to fix here.
  const stats = createStatsAndDocsNode({
    statsNode: async () => ({ statsPayload: { github: { repos: 106 } } }),
    knowledgeNode: alwaysWeak,
  });
  const { graph, visited } = compile({
    router: async () => ({ route: "stats", routeConfidence: 1, slots: { withDocuments: true } }),
    stats,
  });

  const result = await graph.invoke(
    turn("his github numbers and how his projects compare to the market today"),
    config(),
  );

  assert.deepEqual(visited, ["stats", "generate"]);
  assert.equal(result.escalations, 0);
  assert.equal(result.escalate, false, "the knowledge node's request never reaches state");
  assert.equal(result.documents.length, 1, "its documents still do");
});

// ---------------------------------------------------------------------------
// The trigger: deterministic, config-driven, no model call
// ---------------------------------------------------------------------------

// Top semantic scores measured live on 2026-09-23 (docs/evals/retrieval-floor.md).
const PHASE_3B_AND_BASELINE = [
  ["What backend technologies does Ayan work with?", 0.8896],
  ["Tell me about Ayan's experience at Tata Consultancy Services.", 0.8698],
  ["What certifications does he hold?", 0.8615],
  ["What projects has he built involving RAG or vector search?", 0.8962],
  ["What is his educational background?", 0.8518],
  ["What are his hobbies and interests outside work?", 0.8755],
  ["How has he used generative AI in his day-to-day engineering work?", 0.8666],
  ["What are his strongest skills, and which projects demonstrate them?", 0.8552],
  ["Has Ayan ever worked on underwater basket weaving?", 0.8539],
  ["Show me my github stats and my projects", 0.8674],
  ["How have Ayan's AI skills evolved over time?", 0.8625],
];

test("the Phase 3b set and the Phase 7 baseline never escalate, at their measured scores", () => {
  PHASE_3B_AND_BASELINE.forEach(([query, topSemanticScore]) => {
    assert.equal(escalationReason({ query, topSemanticScore, moonmind: MOONMIND }), null, query);
  });
});

test("the market-relevance question escalates on its wording, not on its retrieval", () => {
  const query = "What AI projects has he built and how relevant are they to the market today?";
  assert.equal(escalationReason({ query, topSemanticScore: 0.8635, moonmind: MOONMIND }), "needs_current");
});

test("nothing-should-match probes escalate on weak retrieval", () => {
  assert.equal(
    escalationReason({ query: "Has Ayan published a cookbook?", topSemanticScore: 0.8198, moonmind: MOONMIND }),
    "weak_retrieval",
  );
  assert.equal(
    escalationReason({ query: "What is Ayan's favourite football club?", topSemanticScore: 0.8276, moonmind: MOONMIND }),
    "weak_retrieval",
  );
  assert.equal(
    escalationReason({ query: "anything", topSemanticScore: undefined, moonmind: MOONMIND }),
    "weak_retrieval",
    "no score at all is the weakest retrieval there is",
  );
});

test("phrases match whole words, case-insensitively, and config appends to them", () => {
  const at = (query, moonmind = MOONMIND) => escalationReason({ query, topSemanticScore: 0.9, moonmind });

  assert.equal(at("What's the LATEST in agents?"), "needs_current");
  assert.equal(at("is that   state of the art"), "needs_current");
  assert.equal(at("his marketplace project"), null, "'market' inside a word does not count");
  assert.equal(at("his industry experience"), null, "'industry' alone is a portfolio question");
  assert.equal(at("how does that sit in the industry"), "needs_current");
  assert.equal(at("the hiring outlook for him"), null);
  assert.equal(at("the hiring outlook for him", { ...MOONMIND, escalationTerms: ["hiring outlook"] }), "needs_current");
});

test("a floor of 0 switches the weak-retrieval trigger off", () => {
  assert.equal(
    escalationReason({ query: "cookbook", topSemanticScore: 0.5, moonmind: { escalationMinTopScore: 0 } }),
    null,
  );
});

test("the knowledge node asks for the hop from retrieve()'s top score", async () => {
  const retrieve = async () => ({ documents: [{ id: "a" }], failedArms: [], topSemanticScore: 0.8198 });
  const node = createKnowledgeNode({
    retrieve,
    models: {},
    config: { moonmind: MOONMIND, retrieval: { debugEnabled: false } },
  });

  const update = await node({ rawQuery: "Has Ayan published a cookbook?", messages: [] });

  assert.equal(update.escalate, true);
  assert.equal(update.escalationReason, "weak_retrieval");
  assert.equal(update.documents.length, 1, "the documents still go into state for the agent");
});

test("production config carries the gated floors", () => {
  const { moonmind, retrieval } = getConfig();
  assert.equal(moonmind.escalationMinTopScore, 0.84);
  assert.ok(retrieval.minSemanticScore > 0, "the gate is on: every query no longer returns k");
  assert.ok(
    retrieval.minSemanticScore < moonmind.escalationMinTopScore,
    "two numbers: the cut-off keeps broad recall below the escalation trigger",
  );
});

// ---------------------------------------------------------------------------
// The handover: documents and history go with the question
// ---------------------------------------------------------------------------

const agentNode = (deps) =>
  makeAgentNode(
    { name: "agent", toolset: [], prompt: "BASE PROMPT", maxSteps: 3, sourcesField: "searchResults" },
    deps,
  );

test("an escalated agent is handed the documents knowledge already retrieved", async () => {
  // FakeToolCallingModel echoes the system prompt it received.
  const node = agentNode({ model: new FakeToolCallingModel({ toolCalls: [[]] }) });

  const update = await node(
    {
      rawQuery: "how relevant are his AI projects to the market today?",
      messages: [new HumanMessage("how relevant are his AI projects to the market today?")],
      documents: [
        { id: "d1", title: "Moonmind AI", content_full: "RAG assistant", summary_for_embedding: "soup", metadata: { impact_score: 99 } },
      ],
      escalationReason: "needs_current",
    },
    {},
  );

  assert.ok(update.finalAnswer.includes("HANDOVER"), "the handover block is in the prompt");
  assert.ok(update.finalAnswer.includes("Moonmind AI"), "with the retrieved document");
  assert.ok(!update.finalAnswer.includes("soup"), "sanitized: no embedding text");
  assert.ok(!update.finalAnswer.includes("impact_score"), "sanitized: no editorial score");
});

test("a direct agent turn has no handover", async () => {
  const node = agentNode({ model: new FakeToolCallingModel({ toolCalls: [[]] }) });

  const update = await node({ rawQuery: "q", messages: [new HumanMessage("q")], documents: [] }, {});

  assert.ok(update.finalAnswer.includes("BASE PROMPT"));
  assert.ok(!update.finalAnswer.includes("HANDOVER"));
});

test("the conversation goes with the escalation, not just the documents", async () => {
  let seen;
  const node = agentNode({
    agent: {
      invoke: async (input, runConfig) => {
        seen = { input, runConfig };
        return { messages: [new AIMessage("compared")] };
      },
    },
  });

  await node(
    {
      rawQuery: "and how does that compare to the market today?",
      messages: [
        new HumanMessage("what AI projects has he built?"),
        new AIMessage("MoonMind AI and CodeSage."),
        new HumanMessage("and how does that compare to the market today?"),
      ],
      documents: [{ id: "d1", title: "Moonmind AI", content_full: "RAG assistant" }],
      escalationReason: "needs_current",
    },
    { configurable: { runId: "r1" } },
  );

  assert.deepEqual(
    seen.input.messages.map((message) => message.content),
    ["what AI projects has he built?", "MoonMind AI and CodeSage.", "and how does that compare to the market today?"],
    "the turn before the follow-up is what makes it answerable",
  );
  assert.ok(seen.runConfig.context.handover.includes("Moonmind AI"));
  assert.equal(seen.runConfig.configurable.runId, "r1", "the run config still passes through");
});

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

test("an escalation shows in the Phase 4 feed as its own step", async () => {
  const { graph } = compile({ knowledge: alwaysWeak });

  const steps = [];
  const iterator = streamTurn({ sessionId: "feed", message: "cookbook?", runId: "r1" }, { graph });
  let next = await iterator.next();
  while (!next.done) {
    steps.push(next.value);
    next = await iterator.next();
  }

  const shape = steps.map((step) => `${step.node}:${step.type}`);
  assert.deepEqual(shape, [
    "router:start", "router:end",
    "knowledge:start", "knowledge:end",
    "escalation:start", "escalation:end",
    "agent:start", "agent:end",
    "generate:start", "generate:end",
  ]);

  const summary = (node) => steps.find((step) => step.node === node && step.type === "end").summary;
  assert.match(summary("knowledge"), /escalate=weak_retrieval/);
  assert.match(summary("escalation"), /escalations=1/);
  assert.equal(next.value.answer, "agent answer");
});

test("the feed summary names the reason, never visitor text", () => {
  assert.equal(summarizeUpdate({ escalationReason: "needs_current" }), "escalate=needs_current");
  assert.equal(summarizeUpdate({ escalate: false, escalationReason: null }), "");
});
