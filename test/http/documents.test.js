"use strict";

// Ingestion routes end to end over real HTTP, with the store's Mongo and Gemini calls
// faked at the collection/embedding boundary. Exercises auth, validation, status
// mapping and the bulk partial-success path.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "t";
process.env.REFRESH_PROFILE ??= "p";
process.env.REFRESH_SECRET ??= "s";
process.env.OPENAI_API_KEY ??= "sk-test";
process.env.MOONMIND_PASSWORD ??= "hunter2";
process.env.GEMINI_API_KEY ??= "gem-test";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../../src/http/app");
const store = require("../../src/documents/store");

const PASSWORD = "hunter2";
const VECTOR = new Array(768).fill(0.1);

const payload = (overrides = {}) => ({
  id: "3341e59a-2a2f-4e8a-8aff-eb957e1ceeba",
  title: "Node.js API Architecture",
  category: "skill",
  tags: ["nodejs"],
  summary_for_embedding:
    "Built backend APIs with Node.js. Used MongoDB aggregation pipelines. Delivered latency reductions.",
  content_full: "Designed production backend services.",
  metadata: {
    domain: "skills",
    subcategory: ["backend"],
    verified: true,
    proficiency_level: "expert",
    organization: "MoonMind",
    impact_score: 91,
    is_active: true,
  },
  ...overrides,
});

/** Replace the store's exported functions for the duration of one test. */
function stubStore(overrides) {
  const original = {};
  Object.entries(overrides).forEach(([key, value]) => {
    original[key] = store[key];
    store[key] = value;
  });
  return () => Object.entries(original).forEach(([key, value]) => {
    store[key] = value;
  });
}

async function withServer(run) {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    return await run(base);
  } finally {
    server.close();
  }
}

function call(base, path, { method = "POST", password = PASSWORD, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (password !== null) headers.password = password;

  // fetch rejects a body on GET/HEAD outright.
  const sendsBody = !["GET", "HEAD"].includes(method) && body !== undefined;

  return fetch(`${base}${path}`, {
    method,
    headers,
    body: sendsBody ? JSON.stringify(body) : undefined,
  });
}

const P = "/api/v1/moonmind";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test("every ingestion route rejects a missing or wrong password", async () => {
  await withServer(async (base) => {
    const routes = [
      ["POST", `${P}/createDoc`],
      ["POST", `${P}/bulkCreateDoc`],
      ["PUT", `${P}/updateDoc`],
      ["DELETE", `${P}/deleteDoc`],
      ["POST", `${P}/documents/embeddings/regenerate`],
      ["POST", `${P}/documents/3341e59a-2a2f-4e8a-8aff-eb957e1ceeba/embedding`],
      ["GET", `${P}/documents`],
    ];

    for (const [method, path] of routes) {
      const missing = await call(base, path, { method, password: null, body: {} });
      assert.equal(missing.status, 401, `${method} ${path} without a password`);

      const wrong = await call(base, path, { method, password: "nope", body: {} });
      assert.equal(wrong.status, 401, `${method} ${path} with a wrong password`);
    }
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test("createDoc stores a valid document and never returns the vector", async () => {
  const restore = stubStore({
    createDocument: async (input) => ({ ...input, embedding: VECTOR, created_at: "t", updated_at: "t" }),
  });

  try {
    await withServer(async (base) => {
      const response = await call(base, `${P}/createDoc`, { body: payload() });
      const json = await response.json();

      assert.equal(response.status, 201);
      assert.equal(json.status, "ok");
      assert.equal(json.data.id, payload().id);
      assert.equal(json.data.embedding, undefined, "768 floats must not go over the wire");
    });
  } finally {
    restore();
  }
});

test("a category/domain mismatch comes back as 400 with a useful message", async () => {
  await withServer(async (base) => {
    const response = await call(base, `${P}/createDoc`, {
      body: payload({ category: "project" }),
    });
    const json = await response.json();

    assert.equal(response.status, 400);
    assert.equal(json.code, "INVALID_DOCUMENT");
    assert.match(json.message, /must be 'projects'/);
  });
});

test("a duplicate id comes back as 409", async () => {
  const restore = stubStore({
    createDocument: async () => {
      throw Object.assign(new Error("already exists"), { code: "DOCUMENT_CONFLICT" });
    },
  });

  try {
    await withServer(async (base) => {
      const response = await call(base, `${P}/createDoc`, { body: payload() });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "DOCUMENT_CONFLICT");
    });
  } finally {
    restore();
  }
});

test("an embedding provider failure comes back as 502, not 500", async () => {
  const restore = stubStore({
    createDocument: async () => {
      throw Object.assign(new Error("gemini down"), { code: "EMBEDDING_FAILED" });
    },
  });

  try {
    await withServer(async (base) => {
      const response = await call(base, `${P}/createDoc`, { body: payload() });
      assert.equal(response.status, 502);
    });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------

test("bulkCreateDoc requires a non-empty array", async () => {
  await withServer(async (base) => {
    assert.equal((await call(base, `${P}/bulkCreateDoc`, { body: {} })).status, 400);
    assert.equal((await call(base, `${P}/bulkCreateDoc`, { body: [] })).status, 400);
  });
});

test("bulkCreateDoc reports partial success as 207 with per-index errors", async () => {
  const restore = stubStore({
    createDocument: async (input) => {
      if (input.title === "bad") {
        throw Object.assign(new Error("nope"), { code: "INVALID_DOCUMENT" });
      }
      return { ...input, embedding: VECTOR };
    },
  });

  try {
    await withServer(async (base) => {
      const response = await call(base, `${P}/bulkCreateDoc`, {
        body: [payload(), payload({ title: "bad" }), payload()],
      });
      const json = await response.json();

      assert.equal(response.status, 207);
      assert.equal(json.status, "partial");
      assert.equal(json.data.length, 2, "the good documents still landed");
      assert.equal(json.errors.length, 1);
      assert.equal(json.errors[0].index, 1, "failures are keyed by position");
    });
  } finally {
    restore();
  }
});

test("bulkCreateDoc with every document failing reports the shared status", async () => {
  const restore = stubStore({
    createDocument: async () => {
      throw Object.assign(new Error("nope"), { code: "INVALID_DOCUMENT" });
    },
  });

  try {
    await withServer(async (base) => {
      const response = await call(base, `${P}/bulkCreateDoc`, { body: [payload(), payload()] });

      assert.equal(response.status, 400);
      assert.equal((await response.json()).errors.length, 2);
    });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Update, delete, embeddings
// ---------------------------------------------------------------------------

test("updateDoc on a missing document is a 404", async () => {
  const restore = stubStore({
    updateDocument: async () => {
      throw Object.assign(new Error("missing"), { code: "DOCUMENT_NOT_FOUND" });
    },
  });

  try {
    await withServer(async (base) => {
      const response = await call(base, `${P}/updateDoc`, { method: "PUT", body: payload() });
      assert.equal(response.status, 404);
    });
  } finally {
    restore();
  }
});

test("deleteDoc validates the id before touching the store", async () => {
  let called = false;
  const restore = stubStore({
    deleteDocument: async () => {
      called = true;
      return { id: "x", deleted: true };
    },
  });

  try {
    await withServer(async (base) => {
      const bad = await call(base, `${P}/deleteDoc`, { method: "DELETE", body: { id: "nope" } });
      assert.equal(bad.status, 400);
      assert.equal(called, false);

      const good = await call(base, `${P}/deleteDoc`, {
        method: "DELETE",
        body: { id: payload().id },
      });
      assert.equal(good.status, 200);
      assert.equal(called, true);
    });
  } finally {
    restore();
  }
});

test("regenerate rejects a non-boolean onlyMissing", async () => {
  await withServer(async (base) => {
    const response = await call(base, `${P}/documents/embeddings/regenerate`, {
      body: { onlyMissing: "yes" },
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_REQUEST");
  });
});

test("regenerate reports partial failure as 207 and total failure as 502", async () => {
  let result = { onlyMissing: false, processed: 2, updated: 1, failed: 1, failures: [{ id: "a" }] };
  const restore = stubStore({ regenerateAllEmbeddings: async () => result });

  try {
    await withServer(async (base) => {
      const partial = await call(base, `${P}/documents/embeddings/regenerate`, { body: {} });
      assert.equal(partial.status, 207);
      assert.equal((await partial.json()).status, "partial");

      result = { onlyMissing: false, processed: 2, updated: 0, failed: 2, failures: [] };
      const total = await call(base, `${P}/documents/embeddings/regenerate`, { body: {} });
      assert.equal(total.status, 502);
    });
  } finally {
    restore();
  }
});

test("single-document re-embed validates the id in the path", async () => {
  await withServer(async (base) => {
    const response = await call(base, `${P}/documents/not-a-uuid/embedding`, { body: {} });
    assert.equal(response.status, 400);
  });
});

test("the old double-mounted URLs are gone", async () => {
  await withServer(async (base) => {
    // The old service answered on /api/v1/createDoc as well as /api/v1/moonmind/createDoc.
    const response = await call(base, "/api/v1/createDoc", { body: payload() });
    assert.equal(response.status, 404);
  });
});
