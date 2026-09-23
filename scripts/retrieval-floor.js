"use strict";

/**
 * Retrieval floor: the semantic score distribution, measured, before anyone picks a number.
 *
 * `MOONMIND_MIN_SEMANTIC_SCORE` gates candidates on absolute similarity, and Phase 9's
 * escalation fires on "weak retrieval" against that same floor. Phase 6's A/B recorded
 * which documents came back but no scores, so it cannot say where the floor goes. This
 * does: it runs the production pipeline in debug mode (`retrieve({ debug: true })`, real
 * intent model, real Atlas) over the Phase 3b set, the three Phase 8 portfolio questions
 * and a few narrow and nothing-should-match probes, and reports per query:
 *
 *   - the semantic arm's score at ranks 1, 2, 5, 10, 15 and last, and the top-to-10 drop;
 *   - how many candidates arrived from other arms only (no semantic score — an absolute
 *     gate drops every one of them);
 *   - the document count the gate would leave at each candidate absolute floor, and at
 *     each candidate relative floor (within X of that query's top score), capped at k.
 *
 * Nothing here changes configuration. The rerank model is deliberately not supplied:
 * reranking reorders, it never adds, so counts are identical and the run is cheaper.
 *
 * Writes docs/evals/retrieval-floor.md.
 *
 * Usage:
 *   node --env-file=.env scripts/retrieval-floor.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { getConfig } = require("../src/config");
const { close } = require("../src/db");
const { retrieve } = require("../src/retrieval");
const { getModel } = require("../src/agent/models");

const OUTPUT_PATH = path.join(__dirname, "..", "docs", "evals", "retrieval-floor.md");

// `kind` is what a person would expect retrieval to do with the question — the thing a
// floor has to separate. It is a label for reading the table, not an input to anything.
const QUESTIONS = Object.freeze([
  // Phase 3b set (scripts/knowledge-eval.js), Q1-Q10
  { id: "3b-1", kind: "broad", text: "What backend technologies does Ayan work with?" },
  { id: "3b-2", kind: "focused", text: "Tell me about Ayan's experience at Tata Consultancy Services." },
  { id: "3b-3", kind: "focused", text: "What certifications does he hold?" },
  { id: "3b-4", kind: "focused", text: "What projects has he built involving RAG or vector search?" },
  { id: "3b-5", kind: "focused", text: "What is his educational background?" },
  { id: "3b-6", kind: "focused", text: "What are his hobbies and interests outside work?" },
  { id: "3b-7", kind: "broad", text: "How has he used generative AI in his day-to-day engineering work?" },
  { id: "3b-8", kind: "broad", text: "What are his strongest skills, and which projects demonstrate them?" },
  { id: "3b-9", kind: "nothing", text: "Has Ayan ever worked on underwater basket weaving?" },
  { id: "3b-10", kind: "broad", text: "Show me my github stats and my projects" },
  // Phase 7 baseline
  { id: "p7", kind: "broad", text: "How have Ayan's AI skills evolved over time?" },
  // Phase 8 portfolio questions (scripts/agent-eval.js)
  { id: "p8-1", kind: "broad", text: "How have his backend skills changed from 2023 to now?" },
  { id: "p8-2", kind: "broad", text: "How has Ayan upskilled in AI?" },
  { id: "p8-3", kind: "broad", text: "What AI projects has he built and how relevant are they to the market today?" },
  // Narrow, and nothing-should-match probes
  { id: "n-1", kind: "narrow", text: "Ayan's resume" },
  { id: "n-2", kind: "narrow", text: "What is his LinkedIn profile?" },
  { id: "x-1", kind: "nothing", text: "Has Ayan published a cookbook?" },
  { id: "x-2", kind: "nothing", text: "What is Ayan's favourite football club?" },
]);

const ABSOLUTE_FLOORS = Object.freeze([0.8, 0.82, 0.83, 0.84, 0.85, 0.86, 0.87]);
const RELATIVE_FLOORS = Object.freeze([0.01, 0.02, 0.03, 0.04]);

const fmt = (value) => (Number.isFinite(value) ? value.toFixed(4) : "—");

/** The semantic score of every fused candidate; 0 for one no semantic hit carried. */
function candidateScores(debug) {
  const semantic = new Map();
  debug.arms
    .filter((arm) => arm.source === "semantic")
    .forEach((arm) =>
      arm.hits.forEach((hit) => {
        if (Number.isFinite(hit.score)) {
          semantic.set(hit.id, Math.max(semantic.get(hit.id) ?? 0, hit.score));
        }
      }),
    );

  return debug.fused.map((document) => ({ id: document.id, title: document.title, score: semantic.get(document.id) ?? 0 }));
}

async function measure(question, { config, intent }) {
  const result = await retrieve(question.text, { models: { intent }, config, debug: true });
  const k = config.retrieval.finalDocumentLimit;

  const candidates = candidateScores(result.debug);
  const semanticScores = candidates.map((c) => c.score).filter((s) => s > 0).sort((a, b) => b - a);
  const top = semanticScores[0] ?? 0;
  const at = (rank) => semanticScores[rank - 1];

  const absolute = Object.fromEntries(
    ABSOLUTE_FLOORS.map((floor) => [floor, Math.min(k, candidates.filter((c) => c.score >= floor).length)]),
  );
  const relative = Object.fromEntries(
    RELATIVE_FLOORS.map((delta) => [delta, Math.min(k, candidates.filter((c) => c.score > 0 && c.score >= top - delta).length)]),
  );

  const arms = result.debug.arms.map((arm) => `${arm.source}=${arm.hits.length}`).join(" ");

  return {
    ...question,
    arms,
    candidates: candidates.length,
    semanticOnlyZero: candidates.filter((c) => c.score === 0).length,
    ranks: { 1: top, 2: at(2), 5: at(5), 10: at(10), 15: at(15), last: semanticScores[semanticScores.length - 1] },
    drop10: Number.isFinite(at(10)) ? top - at(10) : null,
    returned: result.documents.length,
    absolute,
    relative,
    top5: candidates
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((c) => `${fmt(c.score)} ${c.title}`),
  };
}

function render(rows, config) {
  const k = config.retrieval.finalDocumentLimit;
  const lines = [
    "# Retrieval floor — semantic score distribution",
    "",
    `Generated: ${new Date().toISOString()}`,
    `k (MOONMIND_FINAL_DOCUMENT_LIMIT): ${k} · current MOONMIND_MIN_SEMANTIC_SCORE: ${config.retrieval.minSemanticScore}`,
    `candidate limit per arm: ${config.retrieval.candidateLimit} · decompose: ${config.retrieval.decomposeEnabled}`,
    "",
    "Scores are Atlas `vectorSearchScore`, i.e. (1 + cos) / 2. `kind` is what a person would",
    "expect, for reading the table — not an input. Produced by `scripts/retrieval-floor.js`.",
    "",
    "## 1. Semantic arm, per query",
    "",
    "| id | kind | #1 | #2 | #5 | #10 | #15 | last | #1−#10 | arms | no-semantic candidates | returned today |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.kind} | ${fmt(r.ranks[1])} | ${fmt(r.ranks[2])} | ${fmt(r.ranks[5])} | ${fmt(r.ranks[10])} | ${fmt(r.ranks[15])} | ${fmt(r.ranks.last)} | ${fmt(r.drop10)} | ${r.arms} | ${r.semanticOnlyZero} | ${r.returned} |`,
    ),
    "",
    "## 2. Documents the gate would leave — absolute floor (capped at k)",
    "",
    `| id | kind | ${ABSOLUTE_FLOORS.join(" | ")} |`,
    `|---|---|${ABSOLUTE_FLOORS.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.id} | ${r.kind} | ${ABSOLUTE_FLOORS.map((f) => r.absolute[f]).join(" | ")} |`),
    "",
    "## 3. Documents the gate would leave — relative floor (within X of the query's #1, capped at k)",
    "",
    `| id | kind | ${RELATIVE_FLOORS.map((d) => `−${d}`).join(" | ")} |`,
    `|---|---|${RELATIVE_FLOORS.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.id} | ${r.kind} | ${RELATIVE_FLOORS.map((d) => r.relative[d]).join(" | ")} |`),
    "",
    "## 4. Top five semantic hits, per query",
    "",
    ...rows.flatMap((r) => [`**${r.id}** — ${r.text}`, "", ...r.top5.map((line) => `- ${line}`), ""]),
  ];
  return lines.join("\n");
}

async function main() {
  const config = getConfig();
  const intent = getModel("intent");
  const rows = [];

  for (const question of QUESTIONS) {
    process.stdout.write(`${question.id.padEnd(6)} ${question.text}\n`);
    rows.push(await measure(question, { config, intent }));
  }

  fs.writeFileSync(OUTPUT_PATH, `${render(rows, config)}\n`);
  process.stdout.write(`\nwrote ${path.relative(process.cwd(), OUTPUT_PATH)}\n`);
}

main()
  .catch((error) => {
    console.error(`retrieval-floor failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => close());
