"use strict";

// The Tavily client, with `fetch` replaced. Covers the request it sends, the shape it
// returns, and every failure mode the agent above has to survive.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "t";
process.env.REFRESH_PROFILE ??= "p";
process.env.REFRESH_SECRET ??= "s";
process.env.OPENAI_API_KEY ??= "sk-test";
process.env.MOONMIND_PASSWORD ??= "pw";
process.env.GEMINI_API_KEY ??= "gem-test";
process.env.TAVILY_API_KEY ??= "tvly-secret-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const { search, MAX_CONTENT_CHARS } = require("../../src/integrations/websearch");

const ok = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

/** Replace global fetch for one test, recording what it was called with. */
function stubFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const payload = (overrides = {}) => ({
  answer: "Node 22 is the LTS line.",
  results: [
    { title: "Node 22", url: "https://nodejs.org/22", content: "LTS in October.", score: 0.91, published_date: "2026-01-02" },
    { title: "Blog", url: "https://blog/22", content: "Details.", score: 0.62 },
  ],
  ...overrides,
});

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

test("sends the query, the key and an abort signal", async () => {
  const stub = stubFetch(() => ok(payload()));
  try {
    await search("what is new in node 22");

    const { url, options } = stub.calls[0];
    assert.equal(url, "https://api.tavily.com/search");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer tvly-secret-key");
    assert.ok(options.signal instanceof AbortSignal, "every outbound call is bounded");

    const body = JSON.parse(options.body);
    assert.equal(body.query, "what is new in node 22");
    assert.equal(body.include_answer, true);
    assert.equal(body.include_raw_content, false, "raw page bodies are never requested");
    assert.equal(body.max_results, 5);
    assert.equal(body.search_depth, "basic");
    assert.ok(body.exclude_domains.includes("pinterest.com"));
  } finally {
    stub.restore();
  }
});

test("per-call options override the configured defaults", async () => {
  const stub = stubFetch(() => ok(payload()));
  try {
    await search("q", { maxResults: 2, searchDepth: "advanced" });

    const body = JSON.parse(stub.calls[0].options.body);
    assert.equal(body.max_results, 2);
    assert.equal(body.search_depth, "advanced");
  } finally {
    stub.restore();
  }
});

test("a caller's signal is used instead of a fresh timeout", async () => {
  const controller = new AbortController();
  const stub = stubFetch(() => ok(payload()));
  try {
    await search("q", { signal: controller.signal });
    assert.equal(stub.calls[0].options.signal, controller.signal);
  } finally {
    stub.restore();
  }
});

test("an empty query never reaches the network", async () => {
  const stub = stubFetch(() => ok(payload()));
  try {
    await assert.rejects(() => search("   "), (error) => error.code === "WEB_SEARCH_EMPTY_QUERY");
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------

test("maps results onto the fields a model and a citation need", async () => {
  const stub = stubFetch(() => ok(payload()));
  try {
    const found = await search("node 22");

    assert.equal(found.answer, "Node 22 is the LTS line.");
    assert.deepEqual(found.results[0], {
      title: "Node 22",
      url: "https://nodejs.org/22",
      content: "LTS in October.",
      score: 0.91,
      publishedDate: "2026-01-02",
    });
    assert.equal(found.results[1].publishedDate, null, "a missing date is null, not undefined");
  } finally {
    stub.restore();
  }
});

test("long extracts are trimmed before they can reach a prompt", async () => {
  const stub = stubFetch(() =>
    ok(payload({ results: [{ title: "T", url: "https://x", content: "x".repeat(5000) }] })),
  );
  try {
    const found = await search("q");
    assert.equal(found.results[0].content.length, MAX_CONTENT_CHARS);
    assert.ok(found.results[0].content.endsWith("…"));
  } finally {
    stub.restore();
  }
});

test("results with no URL are dropped — a source that cannot be cited is not a source", async () => {
  const stub = stubFetch(() =>
    ok(payload({ results: [{ title: "No link", content: "c" }, { title: "Good", url: "https://x", content: "c" }] })),
  );
  try {
    const found = await search("q");
    assert.deepEqual(found.results.map((r) => r.url), ["https://x"]);
  } finally {
    stub.restore();
  }
});

test("an absent or blank answer comes back as null", async () => {
  const stub = stubFetch(() => ok(payload({ answer: "   " })));
  try {
    assert.equal((await search("q")).answer, null);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

test("a timeout is reported as one, not as a generic failure", async () => {
  const stub = stubFetch(() => {
    const error = new Error("aborted");
    error.name = "TimeoutError";
    throw error;
  });
  try {
    await assert.rejects(() => search("q"), (error) => error.code === "WEB_SEARCH_TIMEOUT");
  } finally {
    stub.restore();
  }
});

test("a rejected key is distinguishable from a quota failure", async () => {
  for (const [status, code] of [
    [401, "WEB_SEARCH_UNAUTHORIZED"],
    [403, "WEB_SEARCH_UNAUTHORIZED"],
    [429, "WEB_SEARCH_RATE_LIMITED"],
    [500, "WEB_SEARCH_REQUEST_FAILED"],
  ]) {
    const stub = stubFetch(() => ({ ok: false, status, json: async () => ({}) }));
    try {
      await assert.rejects(
        () => search("q"),
        (error) => error.code === code,
        `HTTP ${status} should be ${code}`,
      );
    } finally {
      stub.restore();
    }
  }
});

test("the API key never appears in an error message", async () => {
  const stub = stubFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
  try {
    await search("q");
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(!error.message.includes("tvly-secret-key"));
  } finally {
    stub.restore();
  }
});

test("a malformed body is a clear error, not undefined results", async () => {
  const noResults = stubFetch(() => ok({ answer: "hi" }));
  try {
    await assert.rejects(() => search("q"), (error) => error.code === "WEB_SEARCH_UNEXPECTED_RESPONSE");
  } finally {
    noResults.restore();
  }

  const notJson = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error("invalid json"); },
  }));
  try {
    await assert.rejects(() => search("q"), (error) => error.code === "WEB_SEARCH_UNEXPECTED_RESPONSE");
  } finally {
    notJson.restore();
  }
});
