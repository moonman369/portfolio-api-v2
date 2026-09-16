"use strict";

/**
 * Retrieval A/B: decompose on/off x rerank on/off, over the Phase 3b question set.
 *
 * Calls `retrieve()` and `generate` directly, in-process, with per-config overrides —
 * no server, no HTTP. Each config gets its own frozen-shaped config object (decompose
 * and rerank flipped; everything else exactly what `.env` says), so the four runs are
 * comparable and nothing here changes what production actually uses.
 *
 * Also measures recall headroom: for three broad questions, an LLM judges which
 * documents in the whole (small) corpus are genuinely relevant, and that is compared
 * against what the *current* configured `k` (MOONMIND_FINAL_DOCUMENT_LIMIT) returns.
 *
 * Writes docs/evals/retrieval-ab.md. Read-only against the collection; makes real
 * OpenAI and Gemini calls (embeddings + several chat completions per question).
 *
 * Usage:
 *   node --env-file=.env scripts/retrieval-ab.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { z } = require("zod");
const { HumanMessage } = require("@langchain/core/messages");
const { getConfig } = require("../src/config");
const { getCollection, close } = require("../src/db");
const { retrieve } = require("../src/retrieval");
const { createGenerateNode } = require("../src/agent/nodes/generate");
const { getModel } = require("../src/agent/models");

const OUTPUT_PATH = path.join(__dirname, "..", "docs", "evals", "retrieval-ab.md");

// Mirrors scripts/about-me-eval.js's Phase 3b question set, Q1-Q9. Q10 there is the
// mixed stats+docs query — stats has nothing to do with retrieval configuration, so it
// is left out here.
const QUESTIONS = Object.freeze([
  { id: 1, text: "What backend technologies does Ayan work with?" },
  { id: 2, text: "Tell me about Ayan's experience at Tata Consultancy Services." },
  { id: 3, text: "What certifications does he hold?" },
  { id: 4, text: "What projects has he built involving RAG or vector search?" },
  { id: 5, text: "What is his educational background?" },
  { id: 6, text: "What are his hobbies and interests outside work?" },
  { id: 7, text: "How has he used generative AI in his day-to-day engineering work?" },
  {
    id: 8,
    text: "What are his strongest skills, and which projects demonstrate them?",
    note: "multi-part - the case decomposition exists for",
  },
  {
    id: 9,
    text: "Has Ayan ever worked on underwater basket weaving?",
    note: "nothing should match - watch whether decompose/rerank invent false positives",
  },
]);

const RECALL_QUESTIONS = Object.freeze([
  "AI skills over time",
  "backend experience",
  "everything about Ayan's projects",
]);

const CONFIGS = Object.freeze([
  { id: "decompose=off rerank=off", decompose: false, rerank: false },
  { id: "decompose=off rerank=on", decompose: false, rerank: true },
  { id: "decompose=on rerank=off", decompose: true, rerank: false },
  { id: "decompose=on rerank=on", decompose: true, rerank: true },
]);

const RelevanceSchema = z.object({
  relevantIds: z.array(z.string()).describe("ids of documents genuinely relevant to the question"),
});

const CORPUS_PROJECTION = Object.freeze({
  _id: 0,
  id: 1,
  title: 1,
  category: 1,
  tags: 1,
  summary_for_embedding: 1,
});

// ---------------------------------------------------------------------------
// LLM call counting — wraps a model so every `.invoke()`, including through
// `.withStructuredOutput()`, increments a shared counter. Counts what the pipeline
// actually called, rather than guessing from which flags are on.
// ---------------------------------------------------------------------------

function countingModel(model, counter) {
  return {
    withStructuredOutput(...args) {
      const structured = model.withStructuredOutput(...args);
      return {
        invoke: async (...invokeArgs) => {
          counter.n += 1;
          return structured.invoke(...invokeArgs);
        },
      };
    },
    invoke: async (...args) => {
      counter.n += 1;
      return model.invoke(...args);
    },
  };
}

function buildConfigVariant(base, { decompose, rerank }) {
  return {
    ...base,
    retrieval: { ...base.retrieval, decomposeEnabled: decompose, rerankEnabled: rerank },
  };
}

/** Ids ranked before rerank vs after, in id/title form — what actually moved. */
function rerankMoves(ranked, reranked) {
  const before = new Map(ranked.map((doc, index) => [doc.id, index]));

  return reranked
    .map((doc, index) => ({ id: doc.id, title: doc.title, from: before.get(doc.id), to: index }))
    .filter((entry) => entry.from !== undefined && entry.from !== entry.to);
}

async function runOne(question, configVariant) {
  const counter = { n: 0 };
  const models = {
    intent: countingModel(getModel("intent"), counter),
    decompose: configVariant.retrieval.decomposeEnabled
      ? countingModel(getModel("decompose"), counter)
      : undefined,
    rerank: configVariant.retrieval.rerankEnabled ? countingModel(getModel("rerank"), counter) : undefined,
  };

  const startedAt = Date.now();
  const result = await retrieve(question, { config: configVariant, models, debug: true });

  const generate = createGenerateNode({
    config: configVariant,
    model: countingModel(getModel("response"), counter),
  });
  const generated = await generate({
    documents: result.documents,
    statsPayload: null,
    messages: [new HumanMessage(question)],
    finalAnswer: null,
  });
  const ms = Date.now() - startedAt;

  return {
    ids: result.documents.map((doc) => doc.id),
    arms: result.debug.arms.map(({ source, hits }) => `${source}=${hits.length}`).join(" "),
    moved: rerankMoves(result.debug.ranked, result.debug.reranked),
    answer: generated.finalAnswer ?? "",
    ms,
    llmCalls: counter.n,
  };
}

function renderQuestion(question, rows) {
  const lines = [`### Q${question.id}. ${question.text}`, ""];
  if (question.note) {
    lines.push(`> ${question.note}`, "");
  }

  rows.forEach((row) => {
    lines.push(`**${row.config}** — ${row.ms}ms, ${row.llmCalls} LLM calls, arms: ${row.arms || "none"}`);
    lines.push("");
    lines.push(`- Retrieved: ${row.ids.join(", ") || "(none)"}`);
    lines.push(
      row.moved.length
        ? `- Reranker moved: ${row.moved.map((m) => `${m.id} (${m.from}->${m.to})`).join(", ")}`
        : "- Reranker moved: (nothing, or disabled)",
    );
    lines.push("", "```", row.answer || "(empty answer)", "```", "");
  });

  return lines.join("\n");
}

async function runRecallQuestion(question, corpus, baseConfig) {
  const judgeModel = getModel("intent");
  const candidates = corpus
    .map((doc) => `${doc.id} :: ${doc.title} [${doc.category}] tags=${(doc.tags ?? []).join(",")} — ${doc.summary_for_embedding ?? ""}`)
    .join("\n");

  const judged = await judgeModel.withStructuredOutput(RelevanceSchema, { name: "relevance_judge" }).invoke([
    {
      role: "system",
      content: [
        "You judge document relevance for a retrieval-recall audit.",
        "Given a broad question about Ayan Maiti's portfolio and every document in the",
        "corpus (id :: title [category] tags=... — summary), return the ids of every",
        "document that is GENUINELY relevant and should ground an answer to the question.",
        "Be generous but honest: a document only tangentially related does not count.",
      ].join(" "),
    },
    { role: "user", content: `Question: ${question}\n\nCorpus:\n${candidates}` },
  ]);

  const relevantIds = new Set((judged?.relevantIds ?? []).map(String));
  const result = await retrieve(question, { config: baseConfig, models: {} });
  const retrievedIds = new Set(result.documents.map((doc) => String(doc.id)));
  const missed = [...relevantIds].filter((id) => !retrievedIds.has(id));

  return {
    question,
    relevantCount: relevantIds.size,
    retrievedCount: retrievedIds.size,
    overlap: [...relevantIds].filter((id) => retrievedIds.has(id)).length,
    missed,
  };
}

function render({ corpusSize, rowsByQuestion, recallRows, currentK }) {
  const lines = [
    "# Retrieval A/B — decompose x rerank",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Corpus size (moonmind_documents_v3): ${corpusSize} documents`,
    "",
    "Four configs run over the same 9 questions (Phase 3b's about_me set, minus the",
    "mixed stats+docs query). Everything but `decomposeEnabled`/`rerankEnabled` is",
    "whatever `.env` has right now — this does not change production defaults.",
    "",
    "## Per-question results",
    "",
  ];

  rowsByQuestion.forEach(({ question, rows }) => {
    lines.push(renderQuestion(question, rows), "");
  });

  lines.push(
    "## Recall headroom",
    "",
    `Current \`MOONMIND_FINAL_DOCUMENT_LIMIT\` (k): ${currentK}. For each broad question, an`,
    "LLM judged which documents in the whole corpus are genuinely relevant; \"retrieved\"",
    "is what the current configured pipeline (current .env decompose/rerank settings, k",
    "above) actually returned.",
    "",
    "| question | relevant in corpus | retrieved (k) | overlap | missed |",
    "|---|---|---|---|---|",
  );

  recallRows.forEach((row) => {
    lines.push(
      `| ${row.question} | ${row.relevantCount} | ${row.retrievedCount} | ${row.overlap} | ${row.missed.length ? row.missed.join(", ") : "none"} |`,
    );
  });

  lines.push("");
  return lines.join("\n");
}

async function main() {
  const baseConfig = getConfig();
  const collection = await getCollection(baseConfig.mongo.vectorCollection);
  const corpusSize = await collection.countDocuments();

  process.stdout.write(`corpus size: ${corpusSize} documents\n\n`);

  const rowsByQuestion = [];
  for (const question of QUESTIONS) {
    process.stdout.write(`Q${question.id}: ${question.text}\n`);
    const rows = [];
    for (const configSpec of CONFIGS) {
      const variant = buildConfigVariant(baseConfig, configSpec);
      const row = await runOne(question.text, variant);
      rows.push({ config: configSpec.id, ...row });
      process.stdout.write(
        `   ${configSpec.id}: ${row.ms}ms, ${row.llmCalls} calls, ${row.ids.length} docs, ${row.moved.length} moved\n`,
      );
    }
    rowsByQuestion.push({ question, rows });
  }

  process.stdout.write("\nrecall headroom:\n");
  const corpus = await collection.find({}, { projection: CORPUS_PROJECTION }).toArray();
  const recallRows = [];
  for (const question of RECALL_QUESTIONS) {
    const row = await runRecallQuestion(question, corpus, baseConfig);
    recallRows.push(row);
    process.stdout.write(
      `   "${question}": relevant=${row.relevantCount} retrieved=${row.retrievedCount} overlap=${row.overlap}\n`,
    );
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUTPUT_PATH,
    render({
      corpusSize,
      rowsByQuestion,
      recallRows,
      currentK: baseConfig.retrieval.finalDocumentLimit,
    }),
    "utf8",
  );

  await close();
  process.stdout.write(`\nwrote ${path.relative(process.cwd(), OUTPUT_PATH)}\n`);
  process.exit(0);
}

main().catch(async (error) => {
  console.error(`retrieval-ab failed: ${error.message}`);
  await close().catch(() => {});
  process.exit(1);
});
