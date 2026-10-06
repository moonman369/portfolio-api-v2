"use strict";

/**
 * Phase 9's escalation, measured live.
 *
 * Two suites, one report (docs/evals/escalation.md):
 *
 *   1. Before/after on the questions the hop exists for. "Before" is the pre-Phase-9 path
 *      exactly — the knowledge node then generate, with the semantic floor at 0 as it was.
 *      "After" is `runTurn` through the real graph, floor and escalation included.
 *   2. No-regression: the Phase 3b set and the Phase 7 "AI skills evolved" baseline
 *      through `runTurn`. None may escalate; route, document count and latency are
 *      recorded so a regression is visible, not inferred.
 *
 * Real models, real Atlas, real Tavily. Nothing is written to the database except the
 * checkpoints `runTurn` always writes, each under a fresh session id.
 *
 * Usage:
 *   node --env-file=.env scripts/escalation-eval.js
 *
 * Exit 0 when the market question escalates with web sources and nothing in suite 2
 * escalates; 1 otherwise.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { HumanMessage } = require("@langchain/core/messages");
const { getConfig } = require("../src/config");
const { close } = require("../src/db");
const { runTurn } = require("../src/agent");
const { createKnowledgeNode } = require("../src/agent/nodes/knowledge");
const { createGenerateNode } = require("../src/agent/nodes/generate");

const OUTPUT_PATH = path.join(__dirname, "..", "docs", "evals", "escalation.md");

const HOP_QUESTIONS = Object.freeze([
  { text: "What AI projects has he built and how relevant are they to the market today?", expect: "needs_current" },
  { text: "Has Ayan published a cookbook?", expect: "weak_retrieval" },
]);

const NO_REGRESSION = Object.freeze([
  "What backend technologies does Ayan work with?",
  "Tell me about Ayan's experience at Tata Consultancy Services.",
  "What certifications does he hold?",
  "What projects has he built involving RAG or vector search?",
  "What is his educational background?",
  "What are his hobbies and interests outside work?",
  "How has he used generative AI in his day-to-day engineering work?",
  "What are his strongest skills, and which projects demonstrate them?",
  "Has Ayan ever worked on underwater basket weaving?",
  "Show me my github stats and my projects",
  "How have Ayan's AI skills evolved over time?",
]);

const URL_PATTERN = /https?:\/\/[^\s)\]]+/g;

/** The pre-Phase-9 path: knowledge then generate, with the floor as it was (0). */
async function before(question) {
  const config = getConfig();
  const ungated = { ...config, retrieval: { ...config.retrieval, minSemanticScore: 0 } };
  const state = { sessionId: "escalation-eval", rawQuery: question, messages: [new HumanMessage(question)] };

  const startedAt = Date.now();
  const retrieved = await createKnowledgeNode({ config: ungated })(state, {});
  const generated = await createGenerateNode()({ ...state, documents: retrieved.documents }, {});

  return { ms: Date.now() - startedAt, documents: retrieved.documents.length, answer: generated.finalAnswer };
}

async function after(question) {
  const startedAt = Date.now();
  const turn = await runTurn({ sessionId: `escalation-eval-${crypto.randomUUID()}`, message: question });
  const web = turn.searchResults.filter((source) => source?.kind !== "document");

  return {
    ms: Date.now() - startedAt,
    route: turn.route,
    escalations: turn.escalations,
    reason: turn.escalationReason,
    documents: turn.documents.length,
    webSources: web.length,
    documentSources: turn.searchResults.length - web.length,
    urls: [...new Set(turn.answer?.match(URL_PATTERN) ?? [])],
    // A URL is grounded if a web search returned it or a handed-over document carries it
    // in its own links — those are real portfolio links, not inventions.
    returnedUrls: new Set([
      ...web.map((source) => source.url),
      ...turn.documents.flatMap((document) => Object.values(document?.metadata?.external_links ?? {})),
    ]),
    answer: turn.answer,
    error: turn.error,
  };
}

const fence = (text) => ["```", String(text ?? "").trim(), "```"].join("\n");

async function main() {
  const { retrieval, moonmind } = getConfig();
  const lines = [
    "# Escalation — knowledge → agent, once per turn",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Floors: MOONMIND_MIN_SEMANTIC_SCORE=${retrieval.minSemanticScore} (cut-off) · ` +
      `MOONMIND_ESCALATION_MIN_TOP_SCORE=${moonmind.escalationMinTopScore} (trigger) · k=${retrieval.finalDocumentLimit}`,
    "",
    "Produced by `scripts/escalation-eval.js`. **Before** is the pre-Phase-9 path exactly:",
    "the knowledge node then generate, floor 0. **After** is `runTurn` through the real graph.",
    "",
    "## 1. Before / after",
    "",
  ];
  let failed = false;

  for (const { text, expect } of HOP_QUESTIONS) {
    process.stdout.write(`hop: ${text}\n`);
    const was = await before(text);
    const now = await after(text);
    const invented = now.urls.filter((url) => ![...now.returnedUrls].some((u) => url.startsWith(u) || u.startsWith(url)));

    const ok = now.escalations === 1 && now.reason === expect && !now.error &&
      (expect !== "needs_current" || now.webSources > 0);
    failed ||= !ok;

    lines.push(
      `### ${text}`,
      "",
      `**Before** — ${was.ms} ms, ${was.documents} documents, no tools.`,
      "",
      fence(was.answer),
      "",
      `**After** — ${now.ms} ms · route \`${now.route}\` · escalations=${now.escalations} ` +
        `(\`${now.reason}\`) · ${now.documents} documents handed over · ` +
        `${now.webSources} web sources, ${now.documentSources} document-tool sources · ` +
        `${now.urls.length} URLs cited, ${invented.length} from neither a tool nor a handed-over document. ${ok ? "PASS" : "**FAIL**"}`,
      "",
      fence(now.answer),
      "",
    );
  }

  lines.push(
    "## 2. No regression — the Phase 3b set and the Phase 7 baseline",
    "",
    "None may escalate.",
    "",
    "| question | route | escalated | documents | ms |",
    "|---|---|---|---|---|",
  );

  for (const text of NO_REGRESSION) {
    process.stdout.write(`plain: ${text}\n`);
    const now = await after(text);
    const ok = now.escalations === 0 && !now.error;
    failed ||= !ok;
    lines.push(
      `| ${text} | ${now.route} | ${now.escalations ? `**yes (${now.reason})**` : "no"} | ${now.documents} | ${now.ms} |`,
    );
  }

  fs.writeFileSync(OUTPUT_PATH, `${lines.join("\n")}\n`);
  process.stdout.write(`\nwrote ${path.relative(process.cwd(), OUTPUT_PATH)} — ${failed ? "FAIL" : "PASS"}\n`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(`escalation-eval failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => close());
