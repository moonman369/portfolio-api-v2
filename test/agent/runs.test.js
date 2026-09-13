"use strict";

// The feed's storage and, more importantly, its redaction rules. The summarize*
// functions are the only thing standing between a step and a collection full of
// retrieved documents and model input, so they are tested as a contract, not as
// formatting.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "t";
process.env.REFRESH_PROFILE ??= "p";
process.env.REFRESH_SECRET ??= "s";
process.env.OPENAI_API_KEY ??= "sk-test";
process.env.MOONMIND_PASSWORD ??= "pw";
process.env.GEMINI_API_KEY ??= "gem-test";
process.env.TAVILY_API_KEY ??= "tvly-test";

const test = require("node:test");
const assert = require("node:assert/strict");

const runs = require("../../src/agent/runs");

/** Enough of a Mongo collection for this module: insert, findOne, updateOne, find. */
function fakeCollection() {
  const docs = [];
  return {
    docs,
    createIndex: async () => undefined,
    insertOne: async (doc) => {
      docs.push(doc);
      return { insertedId: doc._id };
    },
    findOne: async (filter) => docs.find((doc) => doc._id === filter._id) ?? null,
    updateOne: async (filter, update) => {
      const doc = docs.find((candidate) => candidate._id === filter._id);
      if (doc) Object.assign(doc, update.$set);
      return { matchedCount: doc ? 1 : 0 };
    },
    find: (filter) => {
      const matched = docs.filter(
        (doc) => doc.runId === filter.runId && doc.seq > filter.seq.$gt,
      );
      return {
        sort: () => ({ toArray: async () => [...matched].sort((a, b) => a.seq - b.seq) }),
      };
    },
  };
}

const store = () => {
  const deps = { runs: fakeCollection(), steps: fakeCollection() };
  return deps;
};

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("a node's update is summarized as counts and enums, never as content", () => {
  const summary = runs.summarizeUpdate({
    route: "about_me",
    routeConfidence: 0.912,
    documents: [
      { id: "a", content_full: "Ayan's private salary history" },
      { id: "b", content_full: "more secret prose" },
    ],
    searchResults: [1, 2, 3, 4],
    finalAnswer: "He has built several Node services.",
  });

  assert.equal(summary, "route=about_me confidence=0.91 candidates=4 documents=2 answer=35 chars");
  assert.ok(!summary.includes("salary"), "document content must never reach a step");
  assert.ok(!summary.includes("Node services"), "answer text must never reach a step");
});

test("slots contribute their key names, never the visitor's values", () => {
  const summary = runs.summarizeUpdate({ slots: { when: "next Tuesday 3pm", subject: "coffee" } });

  assert.equal(summary, "slots=when,subject");
  assert.ok(!summary.includes("Tuesday"));
  assert.ok(!summary.includes("coffee"));
});

test("statsPayload contributes which sources answered, not their numbers", () => {
  // The real payload from `nodes/stats.js`: sources keyed by name, plus the `requested`
  // and `unavailable` bookkeeping arrays, which are not sources.
  const summary = runs.summarizeUpdate({
    statsPayload: {
      requested: ["github", "leetcode"],
      unavailable: [],
      github: { repos: 106 },
      leetcode: { totalSolved: 468 },
    },
  });

  assert.equal(summary, "stats=github+leetcode");
  assert.ok(!summary.includes("106"));
  assert.ok(!summary.includes("requested"));
});

test("a source that failed is counted, so a half-answer is visible in the feed", () => {
  const summary = runs.summarizeUpdate({
    statsPayload: {
      requested: ["github", "leetcode"],
      unavailable: [{ source: "leetcode", message: "timed out" }],
      github: { repos: 106 },
    },
  });

  assert.equal(summary, "stats=github unavailable=1");
  assert.ok(!summary.includes("timed out"), "the failure message stays in the server log");
});

test("summarizeUpdate tolerates an empty, absent or malformed update", () => {
  assert.equal(runs.summarizeUpdate({}), "");
  assert.equal(runs.summarizeUpdate(null), "");
  assert.equal(runs.summarizeUpdate("nonsense"), "");
  assert.equal(runs.summarizeUpdate({ documents: "not an array" }), "documents=0");
});

test("a tool step records the tool and the shape of its result, not the result", () => {
  assert.equal(runs.summarizeTool("web_search", "a long page of scraped text"), "web_search -> 27 chars");
  assert.equal(runs.summarizeTool("freebusy", [1, 2, 3]), "freebusy -> 3 items");
  assert.equal(runs.summarizeTool("send_email", { ok: true, id: "x" }), "send_email -> 2 fields");
  assert.equal(runs.summarizeTool("web_search", null), "web_search -> no result");
});

test("summaries are clipped and whitespace-collapsed", () => {
  const summary = runs.summarizeError({ message: `${"x".repeat(400)}\n\n   spaced` });

  assert.ok(summary.length <= 200, `expected <= 200 chars, got ${summary.length}`);
  assert.ok(summary.endsWith("…"));
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test("startRun opens a pollable run before anything else happens", async () => {
  const deps = store();

  await runs.startRun({ runId: "r1", sessionId: "s1", question: "  what  did   he build? " }, deps);
  const run = await runs.getRun("r1", deps);

  assert.equal(run.status, "running");
  assert.equal(run.sessionId, "s1");
  assert.equal(run.question, "what did he build?", "whitespace is collapsed");
  assert.equal(run.answer, null);
  assert.ok(run.startedAt instanceof Date);
  assert.equal(run.finishedAt, null);
});

test("steps come back in order and only after the caller's cursor", async () => {
  const deps = store();
  await runs.startRun({ runId: "r1", sessionId: "s1", question: "q" }, deps);

  for (const seq of [1, 2, 3, 4]) {
    await runs.recordStep({ runId: "r1", seq, node: "about_me", type: "start", summary: "" }, deps);
  }
  await runs.recordStep({ runId: "other", seq: 1, node: "stats", type: "start", summary: "" }, deps);

  assert.deepEqual((await runs.listSteps("r1", {}, deps)).map((s) => s.seq), [1, 2, 3, 4]);
  assert.deepEqual((await runs.listSteps("r1", { since: 2 }, deps)).map((s) => s.seq), [3, 4]);
  assert.deepEqual(await runs.listSteps("r1", { since: 4 }, deps), []);
});

test("finishRun records the answer and the document ids, never the documents", async () => {
  const deps = store();
  await runs.startRun({ runId: "r1", sessionId: "s1", question: "q" }, deps);

  await runs.finishRun(
    {
      runId: "r1",
      turn: {
        route: "about_me",
        answer: "He has built several Node services.",
        documents: [{ id: "a", content_full: "secret" }, { id: "b" }],
        error: null,
      },
    },
    deps,
  );

  const run = await runs.getRun("r1", deps);
  assert.equal(run.status, "done");
  assert.equal(run.route, "about_me");
  assert.equal(run.answer, "He has built several Node services.");
  assert.deepEqual(run.documentIds, ["a", "b"]);
  assert.equal(run.documentCount, 2);
  assert.ok(!JSON.stringify(run).includes("secret"), "document bodies must not be stored");
  assert.ok(run.finishedAt instanceof Date);
});

test("a turn carrying an error finishes as failed but keeps its graceful answer", async () => {
  const deps = store();
  await runs.startRun({ runId: "r1", sessionId: "s1", question: "q" }, deps);

  await runs.finishRun(
    {
      runId: "r1",
      turn: {
        route: "about_me",
        answer: "Something went wrong on my side.",
        documents: [],
        error: { node: "about_me", message: "boom" },
      },
    },
    deps,
  );

  const run = await runs.getRun("r1", deps);
  assert.equal(run.status, "failed");
  assert.deepEqual(run.error, { node: "about_me", message: "boom" });
  assert.equal(run.answer, "Something went wrong on my side.");
});

test("failRun closes a run that died outside any node", async () => {
  const deps = store();
  await runs.startRun({ runId: "r1", sessionId: "s1", question: "q" }, deps);

  await runs.failRun({ runId: "r1", message: "The operation was aborted" }, deps);

  const run = await runs.getRun("r1", deps);
  assert.equal(run.status, "failed");
  assert.equal(run.error.node, null);
  assert.equal(run.error.message, "The operation was aborted");
  assert.ok(run.finishedAt instanceof Date);
});
