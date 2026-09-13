"use strict";

// Store CRUD against a fake collection. No Mongo, no Gemini.

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

const store = require("../../src/documents/store");

const VECTOR = new Array(768).fill(0.1);

const payload = (overrides = {}) => ({
  id: "3341e59a-2a2f-4e8a-8aff-eb957e1ceeba",
  title: "Node.js API Architecture",
  category: "skill",
  tags: ["nodejs", "express"],
  summary_for_embedding:
    "Built backend APIs with Node.js and Express. Used MongoDB aggregation pipelines. Delivered latency reductions in production.",
  content_full: "Designed and maintained production backend services.",
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

/** Minimal in-memory stand-in for a Mongo collection. */
function fakeCollection(seed = []) {
  const docs = new Map(seed.map((d) => [d.id, { ...d }]));
  const calls = { insert: 0, replace: 0, update: 0, delete: 0 };

  return {
    docs,
    calls,
    async findOne(filter, options = {}) {
      const found = docs.get(filter.id);
      if (!found || !options.projection) return found ?? null;

      const projected = {};
      Object.entries(options.projection).forEach(([key, include]) => {
        if (include === 1 && key in found) projected[key] = found[key];
      });
      return projected;
    },
    async insertOne(document) {
      calls.insert += 1;
      if (docs.has(document.id)) {
        const error = new Error("E11000 duplicate key error");
        error.code = 11000;
        throw error;
      }
      docs.set(document.id, { ...document });
      return { acknowledged: true };
    },
    async replaceOne(filter, document) {
      calls.replace += 1;
      docs.set(filter.id, { ...document });
      return { matchedCount: 1 };
    },
    async updateOne(filter, update) {
      calls.update += 1;
      docs.set(filter.id, { ...docs.get(filter.id), ...update.$set });
      return { matchedCount: 1 };
    },
    async deleteOne(filter) {
      calls.delete += 1;
      return { deletedCount: docs.delete(filter.id) ? 1 : 0 };
    },
    find(filter) {
      const all = [...docs.values()].filter((d) =>
        filter?.$or ? !Array.isArray(d.embedding) || d.embedding.length === 0 : true,
      );
      let index = 0;
      return {
        async next() {
          return index < all.length ? all[index++] : null;
        },
      };
    },
  };
}

const deps = (collection, embed = async () => VECTOR) => ({ collection, embed });

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test("create validates, embeds and stores with timestamps", async () => {
  const collection = fakeCollection();
  const created = await store.createDocument(payload(), deps(collection));

  assert.equal(created.embedding.length, 768);
  assert.equal(created.created_at, created.updated_at);
  assert.match(created.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(collection.calls.insert, 1);
});

test("create rejects an invalid payload before spending an embedding call", async () => {
  let embedCalls = 0;
  const collection = fakeCollection();

  await assert.rejects(
    () =>
      store.createDocument(
        payload({ metadata: { ...payload().metadata, domain: "experience" } }),
        deps(collection, async () => {
          embedCalls += 1;
          return VECTOR;
        }),
      ),
    { code: "INVALID_DOCUMENT" },
  );

  assert.equal(embedCalls, 0, "validation must come first - embedding costs money");
  assert.equal(collection.calls.insert, 0);
});

test("create rejects a wrong-length vector rather than storing it", async () => {
  await assert.rejects(
    () => store.createDocument(payload(), deps(fakeCollection(), async () => new Array(767).fill(0))),
    { code: "INVALID_DOCUMENT" },
  );
});

test("create reports a duplicate id as a conflict", async () => {
  const collection = fakeCollection([{ id: payload().id }]);

  await assert.rejects(() => store.createDocument(payload(), deps(collection)), {
    code: "DOCUMENT_CONFLICT",
  });
});

test("a payload without a summary gets a deterministic one", async () => {
  const { summary_for_embedding, ...without } = payload();
  const collection = fakeCollection();

  const created = await store.createDocument(without, deps(collection));

  assert.ok(created.summary_for_embedding.includes("Node.js API Architecture"));
  assert.ok(created.summary_for_embedding.includes("skills domain"));
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

test("update re-embeds only when the embedding input changed", async () => {
  const collection = fakeCollection();
  await store.createDocument(payload(), deps(collection));

  let embedCalls = 0;
  const countingEmbed = async () => {
    embedCalls += 1;
    return VECTOR;
  };

  // Same embedding inputs, different metadata: no re-embed.
  const untouched = await store.updateDocument(
    payload({ metadata: { ...payload().metadata, impact_score: 10 } }),
    deps(collection, countingEmbed),
  );
  assert.equal(embedCalls, 0);
  assert.equal(untouched.reembedded, false);

  // Title change: the embedding text differs, so re-embed.
  const changed = await store.updateDocument(
    payload({ title: "A Different Title Entirely" }),
    deps(collection, countingEmbed),
  );
  assert.equal(embedCalls, 1);
  assert.equal(changed.reembedded, true);
});

test("update re-embeds a stored document that has no vector", async () => {
  const collection = fakeCollection([{ ...payload(), created_at: "2020-01-01T00:00:00.000Z" }]);
  let embedCalls = 0;

  await store.updateDocument(
    payload(),
    deps(collection, async () => {
      embedCalls += 1;
      return VECTOR;
    }),
  );

  assert.equal(embedCalls, 1);
});

test("update preserves created_at and moves updated_at", async () => {
  const collection = fakeCollection();
  const created = await store.createDocument(payload(), deps(collection));

  // ISO timestamps have millisecond resolution, so without this the two writes can
  // land in the same tick and the assertion below becomes a coin flip.
  await new Promise((resolve) => setTimeout(resolve, 2));

  const updated = await store.updateDocument(payload({ title: "New Title Here" }), deps(collection));

  assert.equal(updated.created_at, created.created_at, "created_at must survive an update");
  assert.notEqual(updated.updated_at, created.updated_at);
  assert.ok(new Date(updated.updated_at) > new Date(created.created_at));
});

test("update on a missing document is a not-found", async () => {
  await assert.rejects(() => store.updateDocument(payload(), deps(fakeCollection())), {
    code: "DOCUMENT_NOT_FOUND",
  });
});

// ---------------------------------------------------------------------------
// Delete and re-embed
// ---------------------------------------------------------------------------

test("delete removes the document, and a second delete is a not-found", async () => {
  const collection = fakeCollection();
  await store.createDocument(payload(), deps(collection));

  assert.deepEqual(await store.deleteDocument(payload().id, deps(collection)), {
    id: payload().id,
    deleted: true,
  });
  await assert.rejects(() => store.deleteDocument(payload().id, deps(collection)), {
    code: "DOCUMENT_NOT_FOUND",
  });
});

test("regenerate rewrites only the vector and the timestamp", async () => {
  const collection = fakeCollection();
  await store.createDocument(payload(), deps(collection));

  const result = await store.regenerateEmbedding(payload().id, deps(collection));

  assert.equal(result.dimensions, 768);
  assert.equal(collection.docs.get(payload().id).title, payload().title);
});

test("bulk regeneration collects per-document failures instead of aborting", async () => {
  const collection = fakeCollection([
    { ...payload(), id: "11111111-1111-4111-8111-111111111111" },
    { ...payload(), id: "22222222-2222-4222-8222-222222222222" },
  ]);

  let call = 0;
  const flaky = async () => {
    call += 1;
    if (call === 1) throw Object.assign(new Error("rate limited"), { code: "RATE_LIMITED" });
    return VECTOR;
  };

  const result = await store.regenerateAllEmbeddings({}, deps(collection, flaky));

  assert.equal(result.processed, 2);
  assert.equal(result.updated, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].code, "RATE_LIMITED");
});

test("withoutEmbedding strips the vector and the Mongo _id", () => {
  const stripped = store.withoutEmbedding({ _id: "x", id: "a", title: "T", embedding: VECTOR });

  assert.deepEqual(stripped, { id: "a", title: "T" });
  assert.equal(store.withoutEmbedding(null), null);
});
