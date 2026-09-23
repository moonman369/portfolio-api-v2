"use strict";

// Storage for the live event feed: one `runs` document per turn with an append-only
// `steps` log underneath it. Plain Mongo and plain JS — no LangChain reaches this file.
// `agent/index.js` writes through it while consuming the graph's own event stream, and
// `http/chat.js` reads it back for the polling endpoints.
//
// **What a step may carry is decided here and nowhere else.** The summarize* functions
// below are a whitelist: they read a fixed set of state fields and emit counts, lengths
// and enum values. A step never carries a retrieved document, a tool's arguments, a
// system prompt or a model's raw output. The feed exists to show the *shape* of a run;
// anything richer would copy retrieved content and model input into a collection that
// the chat route's own contract never promised to hold.
//
// Both collections are debug traces rather than durable data, so both are TTL-indexed.

const { getConfig } = require("../config");
const { getCollection } = require("../db");

/** A step is one of exactly these. `tool` and `error` are emitted from Phase 5 onward. */
const STEP_TYPES = Object.freeze(["start", "end", "tool", "error"]);

const RUN_STATUSES = Object.freeze(["running", "done", "failed"]);

const SUMMARY_MAX_CHARS = 200;
// The question is echoed back so the viewer can label the run. It is the visitor's own
// words, already stored verbatim in the checkpointer's `messages`, so this adds no new
// exposure — but it is clipped, because the feed has no use for the long tail.
const QUESTION_MAX_CHARS = 300;

/** Collapse whitespace and cap length. Every string written by this module goes through it. */
function clip(text, limit) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// ---------------------------------------------------------------------------
// Summaries — the redaction whitelist
// ---------------------------------------------------------------------------

const count = (value) => (Array.isArray(value) ? value.length : 0);

/**
 * Field -> short description, applied in this order. A field absent from this list is
 * absent from the feed: adding one is a deliberate decision about what may be stored,
 * which is the whole point of keeping the list here rather than stringifying the update.
 */
const UPDATE_SUMMARIZERS = Object.freeze([
  ["route", (value) => `route=${value}`],
  ["routeConfidence", (value) => `confidence=${Number(value).toFixed(2)}`],
  // Key names only. Slot *values* are visitor content (a date, a subject line).
  ["slots", (value) => {
    const keys = Object.keys(value ?? {});
    return keys.length > 0 ? `slots=${keys.join(",")}` : null;
  }],
  ["searchResults", (value) => `candidates=${count(value)}`],
  ["documents", (value) => `documents=${count(value)}`],
  // Which sources answered, never what they said. The payload mixes the sources
  // themselves (objects, keyed by source name) with bookkeeping arrays — `requested`
  // and `unavailable` — so array-valued keys are not sources.
  ["statsPayload", (value) => {
    const answered = Object.keys(value ?? {}).filter(
      (key) => value[key] != null && !Array.isArray(value[key]),
    );
    const down = Array.isArray(value?.unavailable) ? value.unavailable.length : 0;

    return [
      `stats=${answered.length > 0 ? answered.join("+") : "none"}`,
      down > 0 ? `unavailable=${down}` : null,
    ]
      .filter(Boolean)
      .join(" ");
  }],
  ["finalAnswer", (value) => `answer=${String(value).length} chars`],
  // The escalation: why knowledge asked for it (an enum we wrote, never visitor text),
  // and the hop's own step spending the budget.
  ["escalationReason", (value) => `escalate=${value}`],
  ["escalations", (value) => `escalations=${value}`],
]);

/** Summarize the state update a node returned. Derived facts only. */
function summarizeUpdate(update) {
  if (!update || typeof update !== "object") {
    return "";
  }

  const parts = UPDATE_SUMMARIZERS.filter(
    ([field]) => update[field] !== undefined && update[field] !== null,
  )
    .map(([field, describe]) => describe(update[field]))
    .filter(Boolean);

  return clip(parts.join(" "), SUMMARY_MAX_CHARS);
}

/**
 * Summarize what the error boundary recorded. The message is ours or the runtime's, not
 * model output, and the stack stays in the server log where `withErrorBoundary` put it.
 */
function summarizeError(error) {
  return clip(error?.message ?? "unknown error", SUMMARY_MAX_CHARS);
}

/** Shape of a tool's result, never its content. */
function describeToolOutput(output) {
  if (output == null) return "no result";
  if (typeof output === "string") return `${output.length} chars`;
  if (Array.isArray(output)) return `${output.length} items`;

  if (typeof output === "object") {
    // A tool that ran inside an agent arrives as a ToolMessage. Its `artifact` is the
    // structured record the tool meant for the node (see `agent/tools.js`), so the
    // useful number is how many results came back — not how many fields a LangChain
    // message class happens to have.
    const results = output.artifact?.results;
    if (Array.isArray(results)) {
      return `${results.length} results`;
    }
    if (typeof output.content === "string") {
      return `${output.content.length} chars`;
    }
    return `${Object.keys(output).length} fields`;
  }

  return typeof output;
}

/** Summarize one tool call: which tool, and the shape of what came back. */
function summarizeTool(name, output) {
  return clip(`${name ?? "tool"} -> ${describeToolOutput(output)}`, SUMMARY_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

let indexesEnsured = false;

async function ensureIndexes(runs, steps) {
  if (indexesEnsured) {
    return;
  }
  const { runRetentionDays } = getConfig().mongo;
  const expireAfterSeconds = runRetentionDays * 24 * 60 * 60;

  await Promise.all([
    runs.createIndex({ startedAt: 1 }, { expireAfterSeconds }),
    runs.createIndex({ sessionId: 1, startedAt: -1 }),
    // Ordering and the `since` cursor both depend on seq, and the run writer is the
    // only producer — a unique index turns a double-write bug into a loud failure.
    steps.createIndex({ runId: 1, seq: 1 }, { unique: true }),
    steps.createIndex({ ts: 1 }, { expireAfterSeconds }),
  ]);
  indexesEnsured = true;
}

/**
 * Both collections at once, with their indexes ensured.
 * `deps.runs` / `deps.steps` bypass Mongo entirely, which is how the tests run.
 */
async function collections(deps = {}) {
  if (deps.runs && deps.steps) {
    return { runs: deps.runs, steps: deps.steps };
  }

  const { mongo } = getConfig();
  const [runs, steps] = await Promise.all([
    getCollection(mongo.runsCollection),
    getCollection(mongo.runStepsCollection),
  ]);
  await ensureIndexes(runs, steps);
  return { runs, steps };
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------

/**
 * Open a run. Called — and awaited — before `POST /runs` answers, so a client that
 * polls immediately finds the run rather than a 404.
 */
async function startRun({ runId, sessionId, question }, deps = {}) {
  const { runs } = await collections(deps);

  await runs.insertOne({
    _id: runId,
    sessionId,
    question: clip(question, QUESTION_MAX_CHARS),
    status: "running",
    route: null,
    answer: null,
    // The documents that grounded the answer, stored so a caller driving the feed gets
    // the same payload `/chat` returns and never has to run the graph twice to get it.
    //
    // This reverses Phase 4's "ids, not documents" decision, on Ayan's call (2026-09-15)
    // once the frontend moved to the feed as its only chat path. The original reasoning —
    // do not make this a second copy of the corpus — still stands as a cost, but it is
    // bounded: these rows expire with `MOONMIND_RUN_RETENTION_DAYS`, and the alternative
    // was either losing source rendering in the UI or paying for every answer twice.
    documents: [],
    documentIds: [],
    documentCount: 0,
    // The agent's sources, stored raw for the same reason and shaped on the way out.
    sources: [],
    error: null,
    startedAt: new Date(),
    finishedAt: null,
  });

  return runId;
}

/** Append one step. Everything written here has already been through a summarize*. */
async function recordStep(step, deps = {}) {
  const { steps } = await collections(deps);

  await steps.insertOne({
    runId: step.runId,
    seq: step.seq,
    node: step.node,
    type: step.type,
    ts: step.ts ?? new Date(),
    summary: clip(step.summary, SUMMARY_MAX_CHARS),
  });
}

/**
 * Close a run with the turn summary `streamTurn` produced. A turn that carries an
 * `error` is `failed` even though it still answered — the error boundary's graceful
 * answer is recorded too, because that is what the visitor actually saw.
 */
async function finishRun({ runId, turn }, deps = {}) {
  const { runs } = await collections(deps);
  const documents = Array.isArray(turn?.documents) ? turn.documents : [];

  await runs.updateOne(
    { _id: runId },
    {
      $set: {
        status: turn?.error ? "failed" : "done",
        route: turn?.route ?? null,
        answer: turn?.answer ?? null,
        // Stored as the graph produced them. The HTTP layer applies exactly the same
        // shaping `/chat` does on the way out, so the two payloads cannot drift.
        documents,
        documentIds: documents.map((document) => document?.id ?? null).filter(Boolean),
        documentCount: documents.length,
        sources: Array.isArray(turn?.searchResults) ? turn.searchResults : [],
        error: turn?.error ? { node: turn.error.node ?? null, message: summarizeError(turn.error) } : null,
        finishedAt: new Date(),
      },
    },
  );
}

/**
 * Close a run that failed outside any node — a wall-clock abort or the recursion limit,
 * which the per-node error boundary never sees.
 */
async function failRun({ runId, message }, deps = {}) {
  const { runs } = await collections(deps);

  await runs.updateOne(
    { _id: runId },
    {
      $set: {
        status: "failed",
        error: { node: null, message: clip(message ?? "run failed", SUMMARY_MAX_CHARS) },
        finishedAt: new Date(),
      },
    },
  );
}

async function getRun(runId, deps = {}) {
  const { runs } = await collections(deps);
  return runs.findOne({ _id: runId });
}

/** Steps after `since`, in order. `since` is the last seq the caller already has. */
async function listSteps(runId, { since = 0 } = {}, deps = {}) {
  const { steps } = await collections(deps);

  return steps
    .find({ runId, seq: { $gt: since } })
    .sort({ seq: 1 })
    .toArray();
}

module.exports = {
  STEP_TYPES,
  RUN_STATUSES,
  startRun,
  recordStep,
  finishRun,
  failRun,
  getRun,
  listSteps,
  summarizeUpdate,
  summarizeError,
  summarizeTool,
};
