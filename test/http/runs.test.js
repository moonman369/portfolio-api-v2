"use strict";

// The feed endpoints over real HTTP, with the agent and the run store faked at their
// module boundary. Covers auth, validation, the 202 handoff and the `since` cursor.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "t";
process.env.REFRESH_PROFILE ??= "p";
process.env.REFRESH_SECRET ??= "s";
process.env.OPENAI_API_KEY ??= "sk-test";
process.env.MOONMIND_PASSWORD ??= "hunter2";
process.env.GEMINI_API_KEY ??= "gem-test";
process.env.TAVILY_API_KEY ??= "tvly-test";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../../src/http/app");
const agent = require("../../src/agent");
const runs = require("../../src/agent/runs");

const PASSWORD = "hunter2";
const P = "/api/v1/moonmind";
const RUN_ID = "3341e59a-2a2f-4e8a-8aff-eb957e1ceeba";

/** Replace exported functions on a module for the duration of one test. */
function stub(target, overrides) {
  const original = {};
  Object.entries(overrides).forEach(([key, value]) => {
    original[key] = target[key];
    target[key] = value;
  });
  return () => Object.entries(original).forEach(([key, value]) => {
    target[key] = value;
  });
}

async function withServer(run) {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function call(base, path, { method = "GET", password = PASSWORD, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (password !== null) headers.password = password;
  const sendsBody = !["GET", "HEAD"].includes(method) && body !== undefined;
  return fetch(`${base}${path}`, { method, headers, body: sendsBody ? JSON.stringify(body) : undefined });
}

const step = (seq, node, type, summary = "") => ({
  runId: RUN_ID,
  seq,
  node,
  type,
  ts: new Date("2026-09-13T10:00:00Z"),
  summary,
});

const finishedRun = (overrides = {}) => ({
  _id: RUN_ID,
  sessionId: "s1",
  question: "how many repos?",
  status: "done",
  route: "stats",
  answer: "106 repositories.",
  error: null,
  documents: [{ id: "a", title: "A doc", content_full: "body", summary_for_embedding: "keyword soup" }],
  documentIds: ["a"],
  documentCount: 1,
  startedAt: new Date("2026-09-13T10:00:00Z"),
  finishedAt: new Date("2026-09-13T10:00:04Z"),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Auth and validation
// ---------------------------------------------------------------------------

test("both feed routes reject a missing or wrong password", async () => {
  await withServer(async (base) => {
    const routes = [
      ["POST", `${P}/runs`],
      ["GET", `${P}/runs/${RUN_ID}`],
    ];

    for (const [method, path] of routes) {
      assert.equal((await call(base, path, { method, password: null, body: {} })).status, 401);
      assert.equal((await call(base, path, { method, password: "nope", body: {} })).status, 401);
    }
  });
});

test("POST /runs rejects a body with no message", async () => {
  await withServer(async (base) => {
    const response = await call(base, `${P}/runs`, { method: "POST", body: { sessionId: "s1" } });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_REQUEST");
  });
});

test("GET /runs rejects a runId that is not a UUID and a negative since", async () => {
  await withServer(async (base) => {
    const badId = await call(base, `${P}/runs/not-a-uuid`);
    assert.equal(badId.status, 400);
    assert.equal((await badId.json()).message, "runId must be a UUID");

    const restore = stub(runs, { getRun: async () => finishedRun(), listSteps: async () => [] });
    try {
      const badSince = await call(base, `${P}/runs/${RUN_ID}?since=-3`);
      assert.equal(badSince.status, 400);
    } finally {
      restore();
    }
  });
});

test("GET /runs 404s for a run that does not exist or has aged out", async () => {
  const restore = stub(runs, { getRun: async () => null });
  try {
    await withServer(async (base) => {
      const response = await call(base, `${P}/runs/${RUN_ID}`);

      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, "RUN_NOT_FOUND");
    });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The handoff
// ---------------------------------------------------------------------------

test("POST /runs answers 202 with the runId while the graph is still working", async () => {
  let settled = false;
  const restore = stub(agent, {
    startRun: async ({ sessionId }) => ({
      runId: RUN_ID,
      sessionId,
      // A run that outlives the request. If the handler awaited this, the response
      // below could not arrive first.
      completed: new Promise((resolve) => setTimeout(() => { settled = true; resolve(null); }, 50)),
    }),
  });

  try {
    await withServer(async (base) => {
      const response = await call(base, `${P}/runs`, {
        method: "POST",
        body: { message: "how many repos?", sessionId: "s1" },
      });

      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), {
        status: "success",
        data: { runId: RUN_ID, sessionId: "s1" },
      });
      assert.equal(settled, false, "the response did not wait for the run");
    });
  } finally {
    restore();
  }
});

test("POST /runs mints a sessionId when the caller omits one", async () => {
  const seen = [];
  const restore = stub(agent, {
    startRun: async ({ sessionId }) => {
      seen.push(sessionId);
      return { runId: RUN_ID, sessionId, completed: Promise.resolve(null) };
    },
  });

  try {
    await withServer(async (base) => {
      const response = await call(base, `${P}/runs`, { method: "POST", body: { message: "hi" } });
      const { data } = await response.json();

      assert.match(data.sessionId, /^[0-9a-f-]{36}$/);
      assert.equal(seen[0], data.sessionId);
    });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

test("GET /runs returns the steps after `since` and the cursor for the next poll", async () => {
  const all = [
    step(1, "router", "start"),
    step(2, "router", "end", "route=stats confidence=0.90"),
    step(3, "stats", "start"),
    step(4, "stats", "end", "stats=github"),
  ];

  const restore = stub(runs, {
    getRun: async () => finishedRun({ status: "running", answer: null, finishedAt: null }),
    listSteps: async (runId, { since }) => all.filter((candidate) => candidate.seq > since),
  });

  try {
    await withServer(async (base) => {
      const first = await call(base, `${P}/runs/${RUN_ID}`);
      const firstBody = (await first.json()).data;

      assert.equal(first.status, 200);
      assert.equal(firstBody.status, "running");
      assert.equal(firstBody.answer, null);
      assert.deepEqual(firstBody.steps.map((s) => s.seq), [1, 2, 3, 4]);
      assert.equal(firstBody.nextSince, 4);

      const second = await call(base, `${P}/runs/${RUN_ID}?since=${firstBody.nextSince}`);
      const secondBody = (await second.json()).data;

      assert.deepEqual(secondBody.steps, [], "nothing new");
      assert.equal(secondBody.nextSince, 4, "a quiet poll does not move the cursor back");
    });
  } finally {
    restore();
  }
});

test("a finished run reports its answer and document ids, not its documents", async () => {
  const restore = stub(runs, {
    getRun: async () => finishedRun(),
    listSteps: async () => [step(5, "generate", "end", "answer=17 chars")],
  });

  try {
    await withServer(async (base) => {
      const { data } = await (await call(base, `${P}/runs/${RUN_ID}?since=4`)).json();

      assert.equal(data.status, "done");
      assert.equal(data.route, "stats");
      assert.equal(data.answer, "106 repositories.");
      assert.deepEqual(data.documentIds, ["a"]);
      assert.equal(data.documentCount, 1);
      assert.equal(data.nextSince, 5);
      assert.deepEqual(data.documents, [
        { id: "a", title: "A doc", content_full: "body" },
      ], "the feed returns documents in the same shape /chat does");
    });
  } finally {
    restore();
  }
});

test("a failed run still reports the graceful answer alongside the error", async () => {
  const restore = stub(runs, {
    getRun: async () =>
      finishedRun({
        status: "failed",
        answer: "Something went wrong on my side.",
        error: { node: "about_me", message: "retrieval exploded" },
      }),
    listSteps: async () => [step(4, "about_me", "error", "retrieval exploded")],
  });

  try {
    await withServer(async (base) => {
      const { data } = await (await call(base, `${P}/runs/${RUN_ID}`)).json();

      assert.equal(data.status, "failed");
      assert.equal(data.steps[0].type, "error");
      assert.equal(data.answer, "Something went wrong on my side.");
      assert.equal(data.error.node, "about_me");
    });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The test page
// ---------------------------------------------------------------------------

test("the run viewer is served and / is still the JSON banner", async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/run-viewer.html`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /run-viewer|MoonMind run viewer/);

    const root = await fetch(`${base}/`);
    assert.match(root.headers.get("content-type"), /application\/json/);
    assert.equal((await root.json()).service, "portfolio-api-v2");
  });
});

// ---------------------------------------------------------------------------
// The agent's sources (Phase 8's exit condition, surfaced 2026-09-23)
// ---------------------------------------------------------------------------

const { toResponseSources } = require("../../src/http/chat");

// Exactly what the agent's tools put in `searchResults`: web results from web_search,
// `{ id, title, kind: "document" }` from the two document tools.
const AGENT_SOURCES = [
  { title: "LangGraph v1", url: "https://example.com/langgraph", content: "Released...", score: 0.9, publishedDate: null },
  { id: "doc-1", title: "MoonMind AI", kind: "document" },
  { title: "LangGraph v1 again", url: "https://example.com/langgraph", content: "dup", score: 0.5 },
  { id: "doc-1", title: "MoonMind AI", kind: "document" },
];

// The keys every `documents` entry carries (FRONTEND_INTEGRATION.md §3).
const DOCUMENT_KEYS = [
  "id", "title", "category", "tags", "content_full", "metadata",
  "score", "semantic_score", "retrieval_sources", "rrf_score", "retrieval_score", "boost_score",
];

test("agent sources are shaped with every key a document entry has, plus kind and url", () => {
  const [web, document] = toResponseSources(AGENT_SOURCES);

  DOCUMENT_KEYS.forEach((key) => {
    assert.ok(key in web, `web source carries ${key}`);
    assert.ok(key in document, `document source carries ${key}`);
  });

  assert.equal(web.kind, "web");
  assert.equal(web.url, "https://example.com/langgraph");
  assert.equal(web.id, web.url, "a web result's identity is its url");
  assert.deepEqual(web.metadata.external_links, { source: "https://example.com/langgraph" });
  assert.equal(web.content_full, "Released...");

  assert.equal(document.kind, "document");
  assert.equal(document.id, "doc-1");
  assert.equal(document.url, null);
});

test("repeated agent sources are dropped, first one wins", () => {
  const shaped = toResponseSources(AGENT_SOURCES);

  assert.deepEqual(shaped.map((s) => s.id), ["https://example.com/langgraph", "doc-1"]);
  assert.equal(shaped[0].title, "LangGraph v1");
  assert.deepEqual(toResponseSources(undefined), []);
  assert.deepEqual(toResponseSources([{ title: "no url" }]), [], "a source with no identity is dropped");
});

test("POST /chat returns the agent's sources alongside the answer", async () => {
  const restore = stub(agent, {
    runTurn: async ({ sessionId }) => ({
      sessionId,
      runId: RUN_ID,
      route: "agent",
      answer: "LangGraph shipped v1.",
      documents: [],
      searchResults: AGENT_SOURCES,
    }),
  });

  try {
    await withServer(async (base) => {
      const response = await call(base, `${P}/chat`, { method: "POST", body: { message: "what's new in LangGraph?" } });
      const { data } = await response.json();

      assert.equal(response.status, 200);
      assert.equal(data.answer, "LangGraph shipped v1.");
      assert.deepEqual(data.documents, []);
      assert.deepEqual(data.sources, toResponseSources(AGENT_SOURCES));
    });
  } finally {
    restore();
  }
});

test("POST /chat returns empty sources for a route that does not run the agent", async () => {
  const restore = stub(agent, {
    runTurn: async ({ sessionId }) => ({
      sessionId, runId: RUN_ID, route: "knowledge", answer: "a", documents: [], searchResults: [],
    }),
  });

  try {
    await withServer(async (base) => {
      const { data } = await (await call(base, `${P}/chat`, { method: "POST", body: { message: "q" } })).json();
      assert.deepEqual(data.sources, []);
    });
  } finally {
    restore();
  }
});

test("the feed returns the agent's sources in the same shape /chat does", async () => {
  const restore = stub(runs, {
    getRun: async () => finishedRun({ route: "agent", documents: [], sources: AGENT_SOURCES }),
    listSteps: async () => [],
  });

  try {
    await withServer(async (base) => {
      const { data } = await (await call(base, `${P}/runs/${RUN_ID}`)).json();
      assert.deepEqual(data.sources, toResponseSources(AGENT_SOURCES));
    });
  } finally {
    restore();
  }
});

test("a run stored before sources existed reports an empty list, not an error", async () => {
  const restore = stub(runs, {
    getRun: async () => finishedRun(), // no `sources` key, as rows written before 2026-09-23
    listSteps: async () => [],
  });

  try {
    await withServer(async (base) => {
      const { data } = await (await call(base, `${P}/runs/${RUN_ID}`)).json();
      assert.deepEqual(data.sources, []);
    });
  } finally {
    restore();
  }
});
