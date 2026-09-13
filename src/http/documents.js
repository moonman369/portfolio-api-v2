"use strict";

// Document ingestion. Validate -> call store -> respond.
//
// Paths are kept exactly as the old service exposed them (`createDoc`, `bulkCreateDoc`,
// `updateDoc`, `deleteDoc` and the two embedding routes) so existing ingestion tooling
// keeps working — but mounted ONCE, under /api/v1/moonmind. The old service mounted the
// same router twice, so every one of these answered on two URLs.

const express = require("express");
const { z } = require("zod");
const rateLimit = require("express-rate-limit");
const { getConfig } = require("../config");
const store = require("../documents/store");
const { requirePassword } = require("./auth");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idSchema = z.string().regex(UUID_PATTERN, "id must be a valid UUID");

// Domain error codes -> HTTP status. The store and schema never mention HTTP.
const CODE_TO_STATUS = Object.freeze({
  INVALID_DOCUMENT: 400,
  DOCUMENT_NOT_FOUND: 404,
  DOCUMENT_CONFLICT: 409,
  RATE_LIMITED: 429,
  EMBEDDING_FAILED: 502,
});

function statusFor(error) {
  return CODE_TO_STATUS[error?.code] ?? 500;
}

function errorBody(error) {
  const status = statusFor(error);
  return {
    status: "error",
    message: status >= 500 ? "Server Error" : error.message,
    code: error?.code ?? "INTERNAL_ERROR",
  };
}

function sendError(res, error) {
  const status = statusFor(error);
  if (status >= 500) {
    console.error("documents.route.failed", { code: error?.code, message: error?.message });
  }
  return res.status(status).json(errorBody(error));
}

/**
 * The embedding routes fan out to a paid, rate-limited API, and the bulk variant can
 * issue one request per document in the collection. Authenticated, but limited anyway.
 */
function createEmbeddingLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      status: "error",
      message: "Too many embedding requests, please retry later",
      code: "RATE_LIMITED",
    },
  });
}

function createDocumentsRouter() {
  const router = express.Router();
  const embeddingLimiter = createEmbeddingLimiter();

  router.use(requirePassword);

  router.post("/createDoc", async (req, res) => {
    try {
      const created = await store.createDocument(req.body);
      return res.status(201).json({ status: "ok", data: store.withoutEmbedding(created) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  /**
   * Sequential by design — one Gemini call per document, never batched. A failure on one
   * document does not abort the rest; failures come back keyed by array index.
   */
  router.post("/bulkCreateDoc", async (req, res) => {
    if (!Array.isArray(req.body) || req.body.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "Request body must be a non-empty array of document payloads",
        code: "INVALID_REQUEST",
      });
    }

    const created = [];
    const errors = [];

    for (const [index, payload] of req.body.entries()) {
      try {
        created.push(store.withoutEmbedding(await store.createDocument(payload)));
      } catch (error) {
        // `status` last: errorBody carries the string "error" under that key, and the
        // numeric HTTP status is what the shared-status calculation below needs.
        errors.push({ index, ...errorBody(error), status: statusFor(error) });
      }
    }

    if (errors.length === 0) {
      return res.status(201).json({ status: "ok", data: created });
    }
    if (created.length > 0) {
      return res.status(207).json({ status: "partial", data: created, errors });
    }

    // Nothing succeeded: report the shared status, or 500 when they disagree.
    const shared = errors.every((failure) => failure.status === errors[0].status)
      ? errors[0].status
      : 500;
    return res.status(shared).json({
      status: "error",
      message: "Bulk create failed for every document",
      code: "BULK_CREATE_FAILED",
      errors,
    });
  });

  router.put("/updateDoc", async (req, res) => {
    try {
      const updated = await store.updateDocument(req.body);
      return res.status(200).json({ status: "ok", data: store.withoutEmbedding(updated) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.delete("/deleteDoc", async (req, res) => {
    const parsed = idSchema.safeParse(req.body?.id);
    if (!parsed.success) {
      return res.status(400).json({
        status: "error",
        message: parsed.error.issues[0].message,
        code: "INVALID_REQUEST",
      });
    }

    try {
      return res.status(200).json({ status: "ok", data: await store.deleteDocument(parsed.data) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/documents/embeddings/regenerate", embeddingLimiter, async (req, res) => {
    const { onlyMissing } = req.body ?? {};
    if (onlyMissing !== undefined && typeof onlyMissing !== "boolean") {
      return res.status(400).json({
        status: "error",
        message: "onlyMissing must be a boolean",
        code: "INVALID_REQUEST",
      });
    }

    try {
      const result = await store.regenerateAllEmbeddings({ onlyMissing: Boolean(onlyMissing) });

      // Nothing succeeded and something failed: surface it as an outright error.
      if (result.updated === 0 && result.failed > 0) {
        return res.status(502).json({
          status: "error",
          message: "Embedding regeneration failed for every document",
          code: "EMBEDDING_FAILED",
          data: result,
        });
      }

      return res
        .status(result.failed > 0 ? 207 : 200)
        .json({ status: result.failed > 0 ? "partial" : "ok", data: result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/documents/:id/embedding", embeddingLimiter, async (req, res) => {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) {
      return res.status(400).json({
        status: "error",
        message: parsed.error.issues[0].message,
        code: "INVALID_REQUEST",
      });
    }

    try {
      return res
        .status(200)
        .json({ status: "ok", data: await store.regenerateEmbedding(parsed.data) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/documents", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || getConfig().retrieval.candidateLimit, 200);
    const skip = Math.max(Number(req.query.skip) || 0, 0);

    try {
      const data = await store.listDocuments({ limit, skip });
      return res.status(200).json({ status: "ok", data, count: data.length });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

module.exports = { createDocumentsRouter };
