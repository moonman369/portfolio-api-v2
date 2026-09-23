"use strict";

// The MoonMind chat route: validate -> runTurn -> respond. The graph decides
// everything else.
//
// Alongside it, the live event feed. Same graph, same validation, different shape:
// `POST /runs` opens a run and answers with its id while the graph is still working,
// and `GET /runs/:runId?since=` returns the steps recorded since the caller's cursor.
// Polling rather than SSE, decided at the Phase 4 gate — it needs no Nginx buffering
// change, keeps the existing `password` header (EventSource cannot send one), and
// resuming after a refresh is just a larger `since`. Both endpoints read the same
// `steps` collection an SSE endpoint would, so adding one later changes no data.

const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");
const { getConfig } = require("../config");
// Imported as namespaces rather than destructured so the run feed's tests can
// replace a single function without rebuilding the router.
const agent = require("../agent");
const runs = require("../agent/runs");
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

/**
 * Shape the agent's sources for the response — web results and document references.
 *
 * Entry for entry in the `documents` shape, so a source panel that renders `documents`
 * renders these with the same code. A web result's link sits in
 * `metadata.external_links`, where a document's links already live. `kind` and `url` are
 * the two keys a document entry does not have. The agent can hit the same source twice
 * (two searches, overlapping results), so repeats are dropped, first one wins.
 */
function toResponseSources(sources) {
  if (!Array.isArray(sources)) {
    return [];
  }

  const seen = new Set();
  const shaped = [];

  sources.forEach((source) => {
    const web = source?.kind !== "document";
    const key = web ? source?.url : source?.id;
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);

    shaped.push({
      id: key,
      title: source?.title || key,
      category: web ? "web" : null,
      tags: [],
      content_full: web ? source?.content || null : null,
      metadata: web ? { external_links: { source: source.url } } : {},
      score: web ? (source?.score ?? null) : null,
      semantic_score: null,
      retrieval_sources: [],
      rrf_score: null,
      retrieval_score: null,
      boost_score: null,
      kind: web ? "web" : "document",
      url: web ? source.url : null,
    });
  });

  return shaped;
}

// `since` is the last seq the caller already holds; absent means "from the start".
const feedQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
});

const runIdSchema = z.string().uuid();

/** Shape one run for the feed. Steps are already summarized and clipped by `runs.js`. */
function toFeedResponse(run, steps, since) {
  return {
    runId: run._id,
    sessionId: run.sessionId,
    status: run.status,
    question: run.question,
    route: run.route,
    answer: run.answer,
    error: run.error,
    // The same shaping `/chat` applies, from the same function, so a caller can move
    // between the two endpoints without a second mapping. Empty until the run finishes.
    documents: toResponseDocuments(run.documents),
    documentIds: run.documentIds ?? [],
    documentCount: run.documentCount ?? 0,
    sources: toResponseSources(run.sources),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    steps: steps.map(({ seq, node, type, ts, summary }) => ({ seq, node, type, ts, summary })),
    // What to send as `since` next time, whether or not this poll saw anything new.
    nextSince: steps.length > 0 ? steps[steps.length - 1].seq : since,
  };
}

function createChatRouter() {
  const { moonmind, retrieval } = getConfig();
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

    const turn = await agent.runTurn({ sessionId, message });

    return res.status(200).json({
      status: "success",
      data: {
        sessionId: turn.sessionId,
        runId: turn.runId,
        route: turn.route,
        answer: turn.answer,
        documents: toResponseDocuments(turn.documents),
        // The agent's citations. Empty for every route that does not run the agent.
        sources: toResponseSources(turn.searchResults),
        // Extra field, gated on MOONMIND_RETRIEVAL_DEBUG, never part of the normal
        // response shape. Ids and titles only — see retrieval/index.js.
        ...(retrieval.debugEnabled ? { retrievalDebug: turn.retrievalDebug } : {}),
      },
    });
  });

  // 202, not 200: the graph is still running when this answers. Everything the caller
  // needs to follow it is the runId.
  router.post("/runs", requirePassword, async (req, res) => {
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        status: "error",
        message: parsed.error.issues[0].message,
        code: "INVALID_REQUEST",
      });
    }

    const sessionId = parsed.data.sessionId ?? crypto.randomUUID();
    const message = parsed.data.message ?? parsed.data.prompt;

    // `completed` is deliberately not awaited — the run outlives this request, and
    // `driveRun` already records its own failure rather than rejecting.
    const { runId } = await agent.startRun({ sessionId, message });

    return res.status(202).json({ status: "success", data: { runId, sessionId } });
  });

  router.get("/runs/:runId", requirePassword, async (req, res) => {
    const runId = runIdSchema.safeParse(req.params.runId);
    if (!runId.success) {
      return res.status(400).json({
        status: "error",
        message: "runId must be a UUID",
        code: "INVALID_REQUEST",
      });
    }

    const query = feedQuerySchema.safeParse(req.query ?? {});
    if (!query.success) {
      return res.status(400).json({
        status: "error",
        message: "since must be a non-negative integer",
        code: "INVALID_REQUEST",
      });
    }

    const run = await runs.getRun(runId.data);
    if (!run) {
      return res.status(404).json({
        status: "error",
        message: "No run with that id",
        code: "RUN_NOT_FOUND",
      });
    }

    const { since } = query.data;
    const steps = await runs.listSteps(runId.data, { since });

    return res.status(200).json({ status: "success", data: toFeedResponse(run, steps, since) });
  });

  return router;
}

module.exports = {
  createChatRouter,
  buildBodySchema,
  toResponseDocuments,
  toResponseSources,
  toFeedResponse,
};
