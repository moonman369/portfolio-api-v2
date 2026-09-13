"use strict";

/**
 * Semantic-arm parity: does the new retrieval return the same documents as the old?
 *
 * Runs the same queries through the OLD `src/moonmind/retrieval/vectorSearch.js` and the
 * new `retrieval/search.js` against the SAME live collection, and compares the top-k ids
 * in order. Both sides embed with Gemini, so a mismatch means either the templates
 * drifted (which test/documents/embedding-templates.test.js would have caught) or the
 * aggregation pipeline differs.
 *
 * Prerequisites:
 *   1. The read-only reference clone at ../Portfolio-Stats-API-ref
 *   2. Its dependencies installed - the old vectorSearch requires the mongodb driver:
 *        cd ../Portfolio-Stats-API-ref && npm ci
 *   3. A .env here with MONGO_URI and GEMINI_API_KEY pointed at the live collection
 *
 * Usage:
 *   node --env-file=.env scripts/retrieval-parity.js
 *   node --env-file=.env scripts/retrieval-parity.js --limit 10
 *
 * Read-only: it never writes to the collection. Exit 0 when every query matches.
 */

const path = require("node:path");
const fs = require("node:fs");

const { getConfig } = require("../src/config");
const { semanticSearch } = require("../src/retrieval/search");
const { close } = require("../src/db");

const REF_REPO = path.join(__dirname, "..", "..", "Portfolio-Stats-API-ref");

const QUERIES = Object.freeze([
  "What backend technologies does Ayan work with?",
  "Tell me about his RAG and vector database projects",
  "What certifications does he hold?",
  "How has he used generative AI in production work?",
  "competitive programming and algorithms",
]);

function parseArgs(argv) {
  const args = { limit: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function loadOldVectorSearch() {
  if (!fs.existsSync(REF_REPO)) {
    throw new Error(`Reference clone not found at ${REF_REPO}`);
  }
  if (!fs.existsSync(path.join(REF_REPO, "node_modules"))) {
    throw new Error(
      `The reference clone has no node_modules. Run: cd ${REF_REPO} && npm ci`,
    );
  }

  // The old config reads these at require time and uses its own names for two of them.
  process.env.MONGO_VECTOR_COLLECTION ??= getConfig().mongo.vectorCollection;
  process.env.MONGO_VECTOR_INDEX ??= getConfig().mongo.vectorIndex;

  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(path.join(REF_REPO, "src", "moonmind", "retrieval", "vectorSearch.js"))
    .vectorSearch;
}

function compare(oldIds, newIds) {
  const sameOrder = oldIds.length === newIds.length && oldIds.every((id, i) => id === newIds[i]);
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);

  return {
    sameOrder,
    sameSet:
      oldSet.size === newSet.size && [...oldSet].every((id) => newSet.has(id)),
    onlyOld: oldIds.filter((id) => !newSet.has(id)),
    onlyNew: newIds.filter((id) => !oldSet.has(id)),
  };
}

async function main() {
  const { limit } = parseArgs(process.argv.slice(2));
  const { mongo, gemini } = getConfig();

  process.stdout.write(
    `collection=${mongo.vectorCollection} index=${mongo.vectorIndex} model=${gemini.model} dims=${gemini.dimensions} limit=${limit}\n\n`,
  );

  const oldVectorSearch = loadOldVectorSearch();
  let mismatches = 0;

  for (const query of QUERIES) {
    const [oldResults, newResults] = await Promise.all([
      oldVectorSearch(query, limit),
      semanticSearch(query, limit),
    ]);

    const oldIds = oldResults.map((doc) => String(doc.id));
    const newIds = newResults.map((doc) => String(doc.id));
    const result = compare(oldIds, newIds);

    const verdict = result.sameOrder ? "PASS" : result.sameSet ? "REORDERED" : "FAIL";
    if (!result.sameOrder) mismatches += 1;

    process.stdout.write(`${verdict}  "${query}"\n`);
    process.stdout.write(`   old: ${oldIds.join(", ") || "(none)"}\n`);
    process.stdout.write(`   new: ${newIds.join(", ") || "(none)"}\n`);
    if (result.onlyOld.length) process.stdout.write(`   only old: ${result.onlyOld.join(", ")}\n`);
    if (result.onlyNew.length) process.stdout.write(`   only new: ${result.onlyNew.join(", ")}\n`);
    process.stdout.write("\n");
  }

  await close();

  process.stdout.write(
    `${QUERIES.length - mismatches}/${QUERIES.length} queries returned identical top-${limit} ids\n`,
  );
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(`retrieval-parity failed: ${error.message}`);
  await close().catch(() => {});
  process.exit(1);
});
