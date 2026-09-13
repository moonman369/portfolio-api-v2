"use strict";

// The document contract, enforced in application code.
//
// This is the real gate, not the collection's $jsonSchema: the old service installed
// that validator through a `collMod` it swallows an Unauthorized from, and a comment in
// its own source says the live collection has none. See docs/DATA_MODEL.md §6.
//
// It also adds the check nothing in the old stack performed: `embedding` must be exactly
// 768 numbers. The Mongo validator only checks `bsonType`, so a 767-length vector writes
// cleanly and is then invisible to $vectorSearch forever.

const { z } = require("zod");
const { getConfig } = require("../config");
const {
  ALLOWED_CATEGORIES,
  ALLOWED_DOMAINS,
  ALLOWED_PROFICIENCY_LEVELS,
  ALLOWED_SUBCATEGORIES,
  domainForCategory,
} = require("./taxonomy");

// Not env-driven in the old service either; it bounds the embedded summary.
const MAX_SUMMARY_CHARACTERS = 4_000;
const MAX_CONTENT_CHARACTERS = 25_000;

// Kept from the old validator, minus three patterns. `system prompt`,
// `chain of thought` and the rest were topic words, not secrets, and they reject
// legitimate documents — `prompt-engineering`, `llm`, `claude` and `mcp` are all valid
// subcategories. `ignore previous instructions` stays: retrieved documents are fed to a
// model, so that one is a genuine injection payload and never portfolio prose.
const PROHIBITED_PATTERNS = Object.freeze([
  { pattern: /sk-[a-zA-Z0-9]{20,}/, label: "an API key" },
  { pattern: /api[_-]?key\s*[:=]/i, label: "an API key assignment" },
  { pattern: /authorization\s*[:=]/i, label: "an authorization header" },
  { pattern: /bearer\s+[a-z0-9\-_.]+/i, label: "a bearer token" },
  { pattern: /-----begin\s+private\s+key-----/i, label: "a private key" },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: "a social security number" },
  { pattern: /ignore\s+previous\s+instructions/i, label: "a prompt-injection payload" },
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validationError(message) {
  const error = new Error(message);
  error.code = "INVALID_DOCUMENT";
  return error;
}

const isoDate = z.string().datetime({ offset: true });

const metadataSchema = z
  .object({
    domain: z.enum(ALLOWED_DOMAINS),
    subcategory: z.array(z.enum(ALLOWED_SUBCATEGORIES)).default([]),
    verified: z.boolean(),
    proficiency_level: z.enum(ALLOWED_PROFICIENCY_LEVELS).nullable(),
    organization: z.string().trim().min(1).max(160).nullable(),
    impact_score: z.number().min(0).max(100).nullable(),
    is_active: z.boolean(),
    // Stored as ISO strings, not BSON dates — the metadata retrieval arm compares them
    // lexicographically, which only works because they are zero-padded ISO.
    date_start: isoDate.nullable().optional(),
    date_end: isoDate.nullable().optional(),
    completion_year: z.number().int().min(1900).max(3000).nullable().optional(),
    external_links: z.record(z.string().trim().min(1).max(512)).nullable().optional(),
  })
  .strict();

const documentSchema = z
  .object({
    id: z.string().regex(UUID_PATTERN, "id must be a valid UUID"),
    title: z.string().trim().min(2).max(180),
    category: z.enum(ALLOWED_CATEGORIES),
    tags: z.array(z.string().trim().min(1).max(64)).max(50),
    // Optional on the way in: the store fills it from a deterministic summary when a
    // payload omits it, so the stored document always has one.
    summary_for_embedding: z.string().trim().min(20).max(MAX_SUMMARY_CHARACTERS).optional(),
    // Required key, nullable value. Certifications and hobbies frequently have none.
    content_full: z.string().trim().max(MAX_CONTENT_CHARACTERS).nullable(),
    metadata: metadataSchema,
  })
  .strict();

function countSentences(text) {
  return (text.match(/[^.!?]+[.!?]+/g) ?? []).length;
}

function assertNoProhibitedContent(document) {
  const haystack = [
    document.title,
    ...(document.tags ?? []),
    document.summary_for_embedding ?? "",
    document.content_full ?? "",
    ...(document.metadata?.subcategory ?? []),
    document.metadata?.organization ?? "",
  ].join("\n");

  const hit = PROHIBITED_PATTERNS.find(({ pattern }) => pattern.test(haystack));
  if (hit) {
    throw validationError(`Document appears to contain ${hit.label} and was rejected`);
  }
}

/** Only meaningful when there is no content_full — the summary is then all that is embedded. */
function assertSummaryConstraints(document, documentsConfig) {
  if (!documentsConfig.enforceSummarySentenceRange || !document.summary_for_embedding) {
    return;
  }
  if (typeof document.content_full === "string" && document.content_full.trim().length > 0) {
    return;
  }

  const count = countSentences(document.summary_for_embedding);
  const { summaryMinSentences: min, summaryMaxSentences: max } = documentsConfig;
  if (count < min || count > max) {
    throw validationError(
      `summary_for_embedding must contain ${min}-${max} sentences when content_full is empty (found ${count})`,
    );
  }
}

/** The single most common payload error: the two enums use different words. */
function assertCategoryDomainAlignment(document) {
  const expected = domainForCategory(document.category);
  if (document.metadata.domain !== expected) {
    throw validationError(
      `metadata.domain must be '${expected}' when category is '${document.category}' (got '${document.metadata.domain}')`,
    );
  }
}

function assertDateConsistency(metadata) {
  const { date_start: start, date_end: end } = metadata;
  if (start && end && new Date(start).getTime() > new Date(end).getTime()) {
    throw validationError("metadata.date_start cannot be after metadata.date_end");
  }
}

function assertEmbedding(embedding, dimensions) {
  if (!Array.isArray(embedding)) {
    throw validationError("embedding must be an array of numbers");
  }
  if (embedding.length !== dimensions) {
    throw validationError(
      `embedding must contain exactly ${dimensions} numbers (got ${embedding.length}) - a mismatched vector is silently unsearchable`,
    );
  }
  if (!embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw validationError("embedding must contain only finite numbers");
  }
}

function normalize(parsed) {
  return {
    ...parsed,
    title: parsed.title.trim(),
    // Lowercased because existing documents are, and tags feed the embedding text.
    tags: parsed.tags.map((tag) => tag.trim().toLowerCase()),
    summary_for_embedding: parsed.summary_for_embedding?.trim(),
    metadata: { ...parsed.metadata, subcategory: parsed.metadata.subcategory ?? [] },
  };
}

/**
 * Validate and normalize a document.
 *
 * @param {object} input
 * @param {{ requireEmbedding?: boolean, config?: object }} [options]
 * @returns {object} the normalized document (embedding passed through untouched)
 * @throws an Error with `code: "INVALID_DOCUMENT"` naming what is wrong
 */
function validateDocument(input, options = {}) {
  const config = options.config ?? getConfig();
  const { embedding, ...payload } = input ?? {};

  const parsed = documentSchema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw validationError(detail);
  }

  const document = normalize(parsed.data);

  assertCategoryDomainAlignment(document);
  assertDateConsistency(document.metadata);
  assertNoProhibitedContent(document);
  assertSummaryConstraints(document, config.documents);

  if (embedding !== undefined) {
    assertEmbedding(embedding, config.gemini.dimensions);
    return { ...document, embedding };
  }
  if (options.requireEmbedding) {
    throw validationError("embedding is required");
  }

  return document;
}

module.exports = {
  documentSchema,
  metadataSchema,
  validateDocument,
  MAX_SUMMARY_CHARACTERS,
  MAX_CONTENT_CHARACTERS,
};
