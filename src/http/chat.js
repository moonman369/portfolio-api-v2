"use strict";

// The MoonMind chat route: validate -> runTurn -> respond. The graph decides
// everything else.

const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");
const { getConfig } = require("../config");
const { runTurn } = require("../agent");
const { requirePassword } = require("./auth");

function buildBodySchema(maxMessageChars) {
  return z
    .object({
      sessionId: z.string().trim().min(1).max(200).optional(),
      message: z.string().trim().min(1).max(maxMessageChars).optional(),
      // The old route called this `prompt`. Accepted so the live frontend keeps
      // working before the Phase 8 cutover; `message` is the contract going forward.
      prompt: z.string().trim().min(1).max(maxMessageChars).optional(),
    })
    .refine((body) => Boolean(body.message ?? body.prompt), {
      message: "message is required",
      path: ["message"],
    });
}

/**
 * Shape retrieved documents for the response.
 *
 * Mirrors the old service's contract: `summary_for_embedding` is dropped (it is
 * keyword soup meant for the embedder, not for a reader) and `content_full` is always
 * present, null when the document has none.
 */
function toResponseDocuments(documents) {
  if (!Array.isArray(documents)) {
    return [];
  }

  return documents.map((document) => {
    const { summary_for_embedding, ...rest } = document ?? {};
    return { ...rest, content_full: rest.content_full ?? null };
  });
}

function createChatRouter() {
  const { moonmind } = getConfig();
  const bodySchema = buildBodySchema(moonmind.maxMessageChars);

  const router = express.Router();

  router.post("/chat", requirePassword, async (req, res) => {
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        status: "error",
        message: parsed.error.issues[0].message,
        code: "INVALID_REQUEST",
      });
    }

    // No visitor identity behind the shared password, so an absent sessionId just
    // starts a fresh thread rather than being an error.
    const sessionId = parsed.data.sessionId ?? crypto.randomUUID();
    const message = parsed.data.message ?? parsed.data.prompt;

    const turn = await runTurn({ sessionId, message });

    return res.status(200).json({
      status: "success",
      data: {
        sessionId: turn.sessionId,
        runId: turn.runId,
        route: turn.route,
        answer: turn.answer,
        documents: toResponseDocuments(turn.documents),
      },
    });
  });

  return router;
}

module.exports = { createChatRouter, buildBodySchema, toResponseDocuments };
