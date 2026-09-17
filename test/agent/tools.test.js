"use strict";

// The three tools Phase 8 added. `resolve_time` is pure, so it is tested directly with an
// injected clock; the two document tools are tested through injected collections, so no
// Mongo and no embedder are needed.

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

const {
  resolveTimeExpression,
  createResolveTimeTool,
  createSemanticSearchTool,
  createMetadataFilterTool,
  renderDocuments,
} = require("../../src/agent/tools");
const { getConfig } = require("../../src/config");

const IST = "Asia/Kolkata";
const at = (iso) => new Date(iso);

// ---------------------------------------------------------------------------
// resolve_time — deterministic, no model
// ---------------------------------------------------------------------------

test("a bare year becomes that whole calendar year", () => {
  const result = resolveTimeExpression("2023", { timeZone: IST, now: at("2026-09-17T00:00:00Z") });

  assert.deepEqual(
    { from: result.from, to: result.to },
    { from: "2023-01-01", to: "2023-12-31" },
  );
});

test("a year mentioned inside a phrase is still found", () => {
  const result = resolveTimeExpression("what was he doing in 2021", {
    timeZone: IST,
    now: at("2026-09-17T00:00:00Z"),
  });

  assert.equal(result.from, "2021-01-01");
  assert.equal(result.to, "2021-12-31");
});

test("'last year' on a year boundary resolves to the previous calendar year", () => {
  // The boundary case: one second into the new year in the configured zone. A naive
  // implementation reading the server's UTC clock gets this wrong for five and a half
  // hours every new year.
  const result = resolveTimeExpression("last year", {
    timeZone: IST,
    now: at("2025-12-31T18:31:00Z"), // 2026-01-01 00:01 IST
  });

  assert.equal(result.resolved, true);
  assert.equal(result.from, "2025-01-01");
  assert.equal(result.to, "2025-12-31");
});

test("the configured timezone decides which day it is", () => {
  const instant = at("2025-12-31T18:31:00Z"); // still 2025 in UTC, already 2026 in IST

  assert.equal(resolveTimeExpression("this year", { timeZone: "UTC", now: instant }).from, "2025-01-01");
  assert.equal(resolveTimeExpression("this year", { timeZone: IST, now: instant }).from, "2026-01-01");
});

test("'now' is a single day, not an open range", () => {
  const result = resolveTimeExpression("now", { timeZone: IST, now: at("2026-09-17T06:00:00Z") });

  assert.equal(result.from, "2026-09-17");
  assert.equal(result.to, "2026-09-17");
});

test("a relative phrase rolls back from today, not to a calendar boundary", () => {
  const result = resolveTimeExpression("the past two years", {
    timeZone: IST,
    now: at("2026-09-17T06:00:00Z"),
  });

  assert.equal(result.from, "2024-09-17", "rolling, so the day is preserved");
  assert.equal(result.to, "2026-09-17");
});

test("a relative phrase in words resolves the same as in digits", () => {
  const now = at("2026-09-17T06:00:00Z");

  assert.equal(
    resolveTimeExpression("last three years", { timeZone: IST, now }).from,
    resolveTimeExpression("last 3 years", { timeZone: IST, now }).from,
  );
});

test("a rolling month range does not land on a day the month lacks", () => {
  // 31 March minus one month is 28 February, not 31 February.
  const result = resolveTimeExpression("last 1 month", {
    timeZone: "UTC",
    now: at("2026-03-31T12:00:00Z"),
  });

  assert.equal(result.from, "2026-02-28");
});

test("'since 2023' is open-ended up to today", () => {
  const result = resolveTimeExpression("since 2023", {
    timeZone: IST,
    now: at("2026-09-17T06:00:00Z"),
  });

  assert.equal(result.from, "2023-01-01");
  assert.equal(result.to, "2026-09-17");
});

test("a year span resolves both ends, in either order", () => {
  const now = at("2026-09-17T06:00:00Z");
  const forward = resolveTimeExpression("2023 to 2025", { timeZone: IST, now });
  const backward = resolveTimeExpression("between 2025 and 2023", { timeZone: IST, now });

  assert.deepEqual(
    { from: forward.from, to: forward.to },
    { from: "2023-01-01", to: "2025-12-31" },
  );
  assert.deepEqual({ from: backward.from, to: backward.to }, { from: forward.from, to: forward.to });
});

test("a month and year resolves to that month, ending on its real last day", () => {
  const result = resolveTimeExpression("February 2024", {
    timeZone: IST,
    now: at("2026-09-17T06:00:00Z"),
  });

  assert.equal(result.from, "2024-02-01");
  assert.equal(result.to, "2024-02-29", "2024 was a leap year");
});

test("an unresolvable phrase says so instead of guessing", () => {
  // "since I joined" has no anchor in a date utility — the real date is in the corpus,
  // and a guessed range would silently filter to the wrong slice while looking confident.
  const result = resolveTimeExpression("since I joined", {
    timeZone: IST,
    now: at("2026-09-17T06:00:00Z"),
  });

  assert.equal(result.resolved, false);
  assert.match(result.reason, /metadata_filter|semantic_search/);
  assert.equal(result.from, undefined);
});

test("an empty expression is unresolved, not today", () => {
  assert.equal(resolveTimeExpression("", { timeZone: IST }).resolved, false);
  assert.equal(resolveTimeExpression(null, { timeZone: IST }).resolved, false);
});

test("the tool hands the model a range it can pass straight to metadata_filter", async () => {
  const tool = createResolveTimeTool({ timezone: IST, now: at("2026-09-17T06:00:00Z") });
  const [content, artifact] = await tool.invoke(
    { name: "resolve_time", args: { expression: "2023" }, id: "1", type: "tool_call" },
  ).then((message) => [message.content, message.artifact]);

  assert.match(content, /2023-01-01 to 2023-12-31/);
  assert.match(content, /date_from and date_to/);
  assert.deepEqual(artifact.range, { from: "2023-01-01", to: "2023-12-31", label: "2023" });
  assert.deepEqual(artifact.results, [], "a date range is not a source to cite");
});

// ---------------------------------------------------------------------------
// The document tools — thin wrappers, verified by what they ask Mongo for
// ---------------------------------------------------------------------------

const DOC = {
  id: "doc-1",
  title: "Systems Engineer - TCS",
  category: "experience",
  tags: ["azure"],
  content_full: "Built integration systems.",
  summary_for_embedding: "keyword soup that must never reach a model",
  metadata: {
    domain: "experience",
    subcategory: ["backend"],
    date_start: "2023-08-01T00:00:00.000Z",
    is_active: true,
    impact_score: 99,
    external_links: { linkedin: "https://linkedin.com/in/x" },
  },
};

/** A collection that records the filter it was handed and replays canned documents. */
function fakeCollection(documents = [DOC]) {
  const queries = [];
  return {
    queries,
    find(query) {
      queries.push(query);
      return {
        limit: () => ({ toArray: async () => documents }),
      };
    },
    aggregate(pipeline) {
      queries.push(pipeline);
      return { toArray: async () => documents.map((d) => ({ ...d, score: 0.88 })) };
    },
  };
}

const call = (tool, args) =>
  tool
    .invoke({ name: tool.name, args, id: "1", type: "tool_call" })
    .then((message) => [message.content, message.artifact]);

test("metadata_filter turns its arguments into one Mongo query on the real arm", async () => {
  const collection = fakeCollection();
  const tool = createMetadataFilterTool({ collection });

  const [content, artifact] = await call(tool, {
    domain: "experience",
    date_from: "2023-01-01",
    date_to: "2023-12-31",
    is_active: true,
  });

  const query = JSON.stringify(collection.queries[0]);
  assert.match(query, /metadata\.domain/);
  assert.match(query, /metadata\.date_start/);
  assert.match(query, /metadata\.is_active/);
  assert.match(content, /Systems Engineer - TCS/);
  assert.deepEqual(artifact.results, [{ id: "doc-1", title: "Systems Engineer - TCS", kind: "document" }]);
});

test("metadata_filter with no criteria asks for criteria instead of scanning", async () => {
  const collection = fakeCollection();
  const [content] = await call(createMetadataFilterTool({ collection }), {});

  assert.match(content, /at least one filter/);
  assert.equal(collection.queries.length, 0, "no query is run");
});

test("semantic_search goes through the vector arm, not a Mongo filter", async () => {
  const collection = fakeCollection();
  const tool = createSemanticSearchTool({
    collection,
    embedder: { embedQuery: async () => new Array(768).fill(0.01) },
  });

  const [content, artifact] = await call(tool, { query: "what has he built" });

  assert.match(JSON.stringify(collection.queries[0]), /\$vectorSearch/);
  assert.match(content, /Systems Engineer - TCS/);
  assert.equal(artifact.results[0].id, "doc-1");
});

test("neither document tool leaks the embedding soup or the impact score", async () => {
  // The same whitelist `generate` uses. A tool that rendered raw documents would hand the
  // model both, and the answer prompt's "never reveal internal scores" rule is not a
  // substitute for not sending them.
  const collection = fakeCollection();
  const [content] = await call(createMetadataFilterTool({ collection }), { domain: "experience" });

  assert.ok(!content.includes("keyword soup"), "summary_for_embedding is dropped");
  assert.ok(!content.includes("99"), "impact_score is dropped");
  assert.match(content, /linkedin/, "external_links survive, as they do for generate");
});

test("renderDocuments says so plainly when nothing matched", () => {
  assert.match(renderDocuments([], { label: "domain=research" }), /No documents matched/);
});

test("the timezone is configurable and defaults to Ayan's", () => {
  assert.equal(typeof getConfig().moonmind.timezone, "string");
  assert.equal(getConfig().moonmind.timezone, "Asia/Kolkata");
});
