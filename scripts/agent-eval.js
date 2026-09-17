"use strict";

/**
 * The unified agent: does it use the right tool, and does it cite what it used?
 *
 * Two suites, because the router does not send both kinds of question to the same place:
 *
 *   1. **Tech questions**, through the whole graph. These route to `agent`, so this is a
 *      true end-to-end check and the regression guard on Phase 5's web answers.
 *   2. **Questions about Ayan**, invoked on the agent node DIRECTLY. Phase 7's taxonomy
 *      sends these to `knowledge` — "never agent, however much technology it mentions" —
 *      and Phase 9's escalation is what will hand them over. Until then the only way to
 *      measure the node Phase 8 built is to call it, which is what this does. The routes
 *      are printed so the gap stays visible rather than looking like a pass.
 *
 * Writes docs/evals/agent.md. Makes real OpenAI, Tavily, Gemini and Atlas calls.
 *
 * Usage:
 *   node --env-file=.env scripts/agent-eval.js
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { HumanMessage } = require("@langchain/core/messages");

const { runTurn, createNodes } = require("../src/agent");
const { createRouterNode } = require("../src/agent/nodes/router");
const { getConfig } = require("../src/config");
const { close } = require("../src/db");

const OUTPUT_PATH = path.join(__dirname, "..", "docs", "evals", "agent.md");

// The Phase 5 set, verbatim where it was recorded, plus two more of the same shape. These
// route to `agent`, so they run through the graph.
const TECH_QUESTIONS = Object.freeze([
  "What is new in LangGraph this year?",
  "How does RAG compare to fine-tuning in 2026?",
  "What are the current best practices for vector database indexing?",
  "Which vector database should I use for a small production RAG app?",
  "What changed in Node.js 22 that matters for backend services?",
]);

// The three the phase brief names. All about Ayan, so all route to `knowledge`.
const PORTFOLIO_QUESTIONS = Object.freeze([
  "How have his backend skills changed from 2023 to now?",
  "How has Ayan upskilled in AI?",
  "What AI projects has he built and how relevant are they to the market today?",
]);

const URL_PATTERN = /https?:\/\/[^\s)]+/g;

async function classify(router, question) {
  const result = await router({ sessionId: "agent-eval", messages: [new HumanMessage(question)] });
  return { route: result.route, confidence: result.routeConfidence };
}

async function runThroughGraph(question) {
  const startedAt = Date.now();
  const turn = await runTurn({ sessionId: `agent-eval-${crypto.randomUUID()}`, message: question });

  return {
    question,
    route: turn.route,
    ms: Date.now() - startedAt,
    answer: turn.answer ?? "",
    sources: turn.searchResults ?? [],
  };
}

async function runOnNode(agentNode, question) {
  const startedAt = Date.now();
  const update = await agentNode(
    { messages: [new HumanMessage(question)], rawQuery: question, sessionId: "agent-eval" },
    {},
  );

  return {
    question,
    ms: Date.now() - startedAt,
    answer: update.finalAnswer ?? "",
    sources: update.searchResults ?? [],
  };
}

function describeSources(sources) {
  const documents = sources.filter((source) => source?.kind === "document");
  const web = sources.filter((source) => source?.url);

  return {
    documents,
    web,
    line: [
      documents.length ? `${documents.length} document(s)` : null,
      web.length ? `${web.length} web source(s)` : null,
    ]
      .filter(Boolean)
      .join(", ") || "none",
  };
}

function renderRow(row, { showRoute = true } = {}) {
  const sources = describeSources(row.sources);
  const urls = [...new Set(row.answer.match(URL_PATTERN) ?? [])];

  const lines = [
    `### ${row.question}`,
    "",
    [
      showRoute ? `- Route: \`${row.route}\`` : null,
      `- ${row.ms}ms`,
      `- Tool sources: ${sources.line}`,
      `- URLs in the answer: ${urls.length}`,
    ]
      .filter(Boolean)
      .join("\n"),
    "",
  ];

  if (sources.documents.length) {
    lines.push(
      "Documents used:",
      "",
      ...sources.documents.map((doc) => `- ${doc.title}`),
      "",
    );
  }
  if (sources.web.length) {
    lines.push("Web sources returned:", "", ...sources.web.map((s) => `- [${s.title}](${s.url})`), "");
  }

  lines.push("```", row.answer || "(empty answer)", "```", "");
  return lines.join("\n");
}

function render({ techRows, portfolioRows, portfolioRoutes, maxSteps }) {
  return [
    "# agent — the unified four-tool node",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Tools bound: \`resolve_time\`, \`metadata_filter\`, \`semantic_search\`, \`web_search\`` +
      `  |  maxSteps: ${maxSteps}`,
    "",
    "## Read this first: what the router actually sends here",
    "",
    "Phase 7's taxonomy routes every question **about Ayan** to `knowledge` — \"never agent,",
    "however much technology it mentions\". Measured against the live router:",
    "",
    "| question | route |",
    "|---|---|",
    ...portfolioRoutes.map((r) => `| ${r.question} | \`${r.route}\` (${r.confidence.toFixed(2)}) |`),
    "",
    "So the three questions this phase was asked to record **do not reach the agent through",
    "the router today**. Phase 9's `knowledge` → `agent` escalation is what will hand them",
    "over. They are recorded below by invoking the agent node directly, which measures the",
    "node Phase 8 built; the routing gap is Phase 9's to close, and these answers are the",
    "baseline it should beat.",
    "",
    "## 1. Tech questions — through the whole graph",
    "",
    "These route to `agent`, so this is end to end, and the regression guard on Phase 5.",
    "",
    ...techRows.map((row) => renderRow(row)),
    "## 2. Questions about Ayan — agent node invoked directly",
    "",
    "Watch the document tools being chosen over `web_search`, and the answers citing",
    "document titles rather than URLs.",
    "",
    ...portfolioRows.map((row) => renderRow(row, { showRoute: false })),
  ].join("\n");
}

async function main() {
  const { moonmind } = getConfig();
  const router = createRouterNode();
  const agentNode = createNodes().agent;

  process.stdout.write(`agent model: ${moonmind.models.agent}  |  maxSteps: ${moonmind.agentMaxSteps}\n\n`);

  process.stdout.write("Tech questions (through the graph):\n");
  const techRows = [];
  for (const question of TECH_QUESTIONS) {
    const row = await runThroughGraph(question);
    techRows.push(row);
    const sources = describeSources(row.sources);
    process.stdout.write(
      `  ${row.route.padEnd(10)} ${String(row.ms).padStart(6)}ms  ${sources.line.padEnd(20)}  ${question.slice(0, 50)}\n`,
    );
  }

  process.stdout.write("\nPortfolio questions (routes, then the node directly):\n");
  const portfolioRoutes = [];
  for (const question of PORTFOLIO_QUESTIONS) {
    portfolioRoutes.push({ question, ...(await classify(router, question)) });
  }

  const portfolioRows = [];
  for (const question of PORTFOLIO_QUESTIONS) {
    const row = await runOnNode(agentNode, question);
    portfolioRows.push(row);
    const sources = describeSources(row.sources);
    process.stdout.write(
      `  ${String(row.ms).padStart(6)}ms  ${sources.line.padEnd(24)}  ${question.slice(0, 50)}\n`,
    );
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUTPUT_PATH,
    render({ techRows, portfolioRows, portfolioRoutes, maxSteps: moonmind.agentMaxSteps }),
    "utf8",
  );

  await close();
  process.stdout.write(`\nwrote ${path.relative(process.cwd(), OUTPUT_PATH)}\n`);
  process.exit(0);
}

main().catch(async (error) => {
  console.error(`agent-eval failed: ${error.message}`);
  await close().catch(() => {});
  process.exit(1);
});
