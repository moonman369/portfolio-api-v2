"use strict";

// CRUD over `moonmind_documents_v3`, used by the ingestion routes.
//
// Two things the old service did that this deliberately does not:
//   - It mirrored every write into `moonmindMetadataIndex`, a second full copy kept in
//     sync transactionally and read by nothing (OLD_REPO_MAP.md §10.7).
//   - It installed the $jsonSchema validator via a collMod it swallows an Unauthorized
//     from, which also meant a legacy out-of-enum document could block its own
//     re-embedding. schema.js is the gate instead (DATA_MODEL.md §6).

const { getConfig } = require("../config");
const { getCollection } = require("../db");
const { validateDocument } = require("./schema");
const { buildDocumentEmbeddingText, embedDocument } = require("./embeddings");

let indexEnsured = false;

function notFound(id) {
  const error = new Error(`No document found with id '${id}'`);
  error.code = "DOCUMENT_NOT_FOUND";
  return error;
}

function conflict(id) {
  const error = new Error(`A document with id '${id}' already exists`);
  error.code = "DOCUMENT_CONFLICT";
  return error;
}

function isDuplicateKey(error) {
  return error?.code === 11000 || /E11000 duplicate key/i.test(error?.message ?? "");
}

async function documentsCollection(deps = {}) {
  if (deps.collection) {
    return deps.collection;
  }

  const collection = await getCollection(getConfig().mongo.vectorCollection);
  if (!indexEnsured) {
    // Idempotent: the index already exists on the live collection.
    await collection.createIndex({ id: 1 }, { unique: true });
    indexEnsured = true;
  }
  return collection;
}

/**
 * Stand-in summary when a payload omits `summary_for_embedding`. Carried over from the
 * old service so documents ingested either way embed comparably.
 */
function deterministicSummary(document) {
  const technologies = document.tags.length
    ? document.tags.join(", ")
    : "portfolio technologies";
  const timeContext =
    [document.metadata.date_start, document.metadata.date_end].filter(Boolean).join(" to ") ||
    (document.metadata.completion_year
      ? `completed in ${document.metadata.completion_year}`
      : "ongoing timeframe");
  const impact =
    document.metadata.impact_score !== null
      ? `impact score ${document.metadata.impact_score}`
      : "impact score not specified";
  const organization = document.metadata.organization || "independent portfolio context";

  return [
    `${document.title} is categorized as ${document.category} in the ${document.metadata.domain} domain.`,
    `Core technologies and keywords include ${technologies}.`,
    `The documented time context is ${timeContext}.`,
    `The work is associated with ${organization} and has ${impact}.`,
    `Verification status is ${document.metadata.verified ? "verified" : "unverified"} with activity state ${document.metadata.is_active ? "active" : "inactive"}.`,
  ].join(" ");
}

function withSummary(document) {
  return document.summary_for_embedding
    ? document
    : { ...document, summary_for_embedding: deterministicSummary(document) };
}

/** Strip the vector before a document goes back over HTTP — 768 floats help nobody. */
function withoutEmbedding(document) {
  if (!document) {
    return document;
  }
  const { embedding, _id, ...rest } = document;
  return rest;
}

async function getDocument(id, deps = {}) {
  const collection = await documentsCollection(deps);
  return collection.findOne({ id });
}

async function listDocuments({ limit = 50, skip = 0 } = {}, deps = {}) {
  const collection = await documentsCollection(deps);
  return collection
    .find({}, { projection: { embedding: 0, _id: 0 } })
    .skip(skip)
    .limit(limit)
    .toArray();
}

/** Validate -> embed -> insert. Rejects a duplicate id rather than overwriting. */
async function createDocument(payload, deps = {}) {
  const document = withSummary(validateDocument(payload));
  const embedding = await (deps.embed ?? embedDocument)(document);
  const now = new Date().toISOString();

  // Re-validate with the vector attached so the 768-length rule covers the write path.
  const stored = validateDocument(
    { ...document, embedding },
    { requireEmbedding: true },
  );
  const record = { ...stored, created_at: now, updated_at: now };

  const collection = await documentsCollection(deps);
  try {
    await collection.insertOne({ ...record });
  } catch (error) {
    throw isDuplicateKey(error) ? conflict(document.id) : error;
  }

  return record;
}

/**
 * Full replace, not a patch. Re-embeds only when the embedding input actually changed,
 * or when the stored document has no vector yet.
 */
async function updateDocument(payload, deps = {}) {
  const document = withSummary(validateDocument(payload));
  const collection = await documentsCollection(deps);

  const existing = await collection.findOne({ id: document.id });
  if (!existing) {
    throw notFound(document.id);
  }

  const inputChanged =
    buildDocumentEmbeddingText(existing) !== buildDocumentEmbeddingText(document);
  const hasVector = Array.isArray(existing.embedding) && existing.embedding.length > 0;

  const embedding =
    inputChanged || !hasVector
      ? await (deps.embed ?? embedDocument)(document)
      : existing.embedding;

  const stored = validateDocument({ ...document, embedding }, { requireEmbedding: true });
  const record = {
    ...stored,
    created_at: existing.created_at,
    updated_at: new Date().toISOString(),
  };

  await collection.replaceOne({ id: document.id }, { ...record });
  return { ...record, reembedded: inputChanged || !hasVector };
}

async function deleteDocument(id, deps = {}) {
  const collection = await documentsCollection(deps);
  const result = await collection.deleteOne({ id });

  if (result.deletedCount !== 1) {
    throw notFound(id);
  }
  return { id, deleted: true };
}

// Exactly the fields buildDocumentEmbeddingText reads.
const EMBEDDING_SOURCE_PROJECTION = Object.freeze({
  _id: 0,
  id: 1,
  title: 1,
  tags: 1,
  summary_for_embedding: 1,
  content_full: 1,
});

const MISSING_EMBEDDING_FILTER = Object.freeze({
  $or: [{ embedding: { $exists: false } }, { embedding: null }, { embedding: { $size: 0 } }],
});

async function embedAndStore(collection, document, embed) {
  const embedding = await embed(document);
  const updated_at = new Date().toISOString();

  await collection.updateOne({ id: document.id }, { $set: { embedding, updated_at } });
  return { id: document.id, dimensions: embedding.length, updated_at };
}

async function regenerateEmbedding(id, deps = {}) {
  const collection = await documentsCollection(deps);
  const document = await collection.findOne({ id }, { projection: EMBEDDING_SOURCE_PROJECTION });

  if (!document) {
    throw notFound(id);
  }
  return embedAndStore(collection, document, deps.embed ?? embedDocument);
}

/**
 * Re-embed every document, or only those missing a vector.
 *
 * Sequential by design: gemini-embedding-2 blends batched inputs into one vector, and
 * firing N concurrent requests is the fastest way to hit the rate limit. Per-document
 * failures are collected so one bad document cannot abort the backfill.
 */
async function regenerateAllEmbeddings({ onlyMissing = false } = {}, deps = {}) {
  const collection = await documentsCollection(deps);
  const embed = deps.embed ?? embedDocument;
  const cursor = collection.find(onlyMissing ? MISSING_EMBEDDING_FILTER : {}, {
    projection: EMBEDDING_SOURCE_PROJECTION,
  });

  const failures = [];
  let processed = 0;
  let updated = 0;

  for (let document = await cursor.next(); document; document = await cursor.next()) {
    processed += 1;
    try {
      await embedAndStore(collection, document, embed);
      updated += 1;
    } catch (error) {
      failures.push({
        id: document.id,
        code: error?.code ?? "EMBEDDING_FAILED",
        message: error?.message ?? "Embedding generation failed",
      });
    }
  }

  return { onlyMissing, processed, updated, failed: failures.length, failures };
}

module.exports = {
  createDocument,
  updateDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  regenerateEmbedding,
  regenerateAllEmbeddings,
  deterministicSummary,
  withoutEmbedding,
};
