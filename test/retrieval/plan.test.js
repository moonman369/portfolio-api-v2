"use strict";

// Planning, and the deterministic fallback every stage drops to. No model, no network.

const test = require("node:test");
const assert = require("node:assert/strict");

const { decomposeQuery, planQuery, deterministicPlan } = require("../../src/retrieval/plan");
const { ALLOWED_SUBCATEGORIES } = require("../../src/documents/taxonomy");

const CONFIG = Object.freeze({
  retrieval: {
    decomposeEnabled: true,
    decomposeMaxSubqueries: 3,
    keywordEnabled: true,
  },
});

const cfg = { config: CONFIG };

function fakeModel(result, { throws = false } = {}) {
  return {
    withStructuredOutput: () => ({
      invoke: async () => {
        if (throws) throw new Error("structured output failed");
        return result;
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Decompose
// ---------------------------------------------------------------------------

test("decompose splits a multi-part question", async () => {
  const model = fakeModel({ subqueries: ["backend skills", "AI projects"] });

  assert.deepEqual(await decomposeQuery("backend and AI?", { ...cfg, model }), [
    "backend skills",
    "AI projects",
  ]);
});

test("decompose falls back to [query] when the model fails", async () => {
  const model = fakeModel(null, { throws: true });

  assert.deepEqual(await decomposeQuery("anything", { ...cfg, model }), ["anything"]);
});

test("decompose falls back to [query] when disabled or model-less", async () => {
  const disabled = { config: { retrieval: { ...CONFIG.retrieval, decomposeEnabled: false } } };

  assert.deepEqual(await decomposeQuery("q", { ...disabled, model: fakeModel({ subqueries: ["a", "b"] }) }), ["q"]);
  assert.deepEqual(await decomposeQuery("q", cfg), ["q"]);
});

test("decompose trims, dedupes and caps at the configured maximum", async () => {
  const model = fakeModel({ subqueries: ["  a  ", "a", "b", "c", "d", 7, ""] });

  assert.deepEqual(await decomposeQuery("q", { ...cfg, model }), ["a", "b", "c"]);
});

test("an empty subquery list falls back to the original", async () => {
  assert.deepEqual(await decomposeQuery("q", { ...cfg, model: fakeModel({ subqueries: [] }) }), ["q"]);
});

// ---------------------------------------------------------------------------
// Deterministic plan — the fallback, and the no-model path
// ---------------------------------------------------------------------------

test("the regex table recognises the obvious domains", () => {
  assert.equal(deterministicPlan("what are his backend skills?").domain, "skills");
  assert.equal(deterministicPlan("tell me about his projects").domain, "projects");
  assert.equal(deterministicPlan("what certifications does he hold?").domain, "certifications");
  assert.equal(deterministicPlan("who is ayan?").domain, "profile");
  assert.equal(deterministicPlan("what is the weather").domain, null);
});

test("the regex table only emits subcategories in the vocabulary", () => {
  const plan = deterministicPlan("backend rag work with vector databases and azure cloud");

  assert.ok(plan.subcategories.length > 0);
  plan.subcategories.forEach((value) => {
    assert.ok(ALLOWED_SUBCATEGORIES.includes(value), `${value} must be in the vocabulary`);
  });
});

test("greetings and small talk need no retrieval", () => {
  assert.equal(deterministicPlan("hello").requires_retrieval, false);
  assert.equal(deterministicPlan("thanks!").requires_retrieval, false);
  assert.equal(deterministicPlan("what are his skills").requires_retrieval, true);
});

test("planQuery without a model uses the deterministic plan", async () => {
  const plan = await planQuery("what are his backend skills?", cfg);

  assert.equal(plan.domain, "skills");
  assert.equal(plan.retrieval_plan.semantic, true);
  assert.equal(plan.retrieval_plan.metadata, true, "a detected domain enables the metadata arm");
});

test("planQuery falls back to the deterministic plan when the model fails", async () => {
  const plan = await planQuery("tell me about his projects", {
    ...cfg,
    model: fakeModel(null, { throws: true }),
  });

  assert.equal(plan.domain, "projects");
  assert.equal(plan.retrieval_plan.semantic, true);
});

// ---------------------------------------------------------------------------
// Arm selection
// ---------------------------------------------------------------------------

const modelPlan = (overrides = {}) =>
  fakeModel({
    domain: "skills",
    subcategories: ["backend"],
    requires_retrieval: true,
    keyword_useful: false,
    entities: { skills: [], projects: [], certifications: [], organizations: [] },
    dates: { from: null, to: null },
    ...overrides,
  });

test("semantic is always on when retrieving", async () => {
  const plan = await planQuery("q", { ...cfg, model: modelPlan({ domain: null, subcategories: [] }) });

  assert.equal(plan.retrieval_plan.semantic, true);
});

test("the metadata arm turns on only when there is something to filter by", async () => {
  const withDomain = await planQuery("q", { ...cfg, model: modelPlan() });
  const without = await planQuery("q", {
    ...cfg,
    model: modelPlan({ domain: null, subcategories: [] }),
  });

  assert.equal(withDomain.retrieval_plan.metadata, true);
  assert.equal(without.retrieval_plan.metadata, false);
});

test("keyword needs both the model's opinion and the config flag", async () => {
  const wanted = modelPlan({ keyword_useful: true });

  const enabled = await planQuery("q", { ...cfg, model: wanted });
  assert.equal(enabled.retrieval_plan.keyword, true);

  const flagOff = await planQuery("q", {
    config: { retrieval: { ...CONFIG.retrieval, keywordEnabled: false } },
    model: wanted,
  });
  assert.equal(flagOff.retrieval_plan.keyword, false);

  const notUseful = await planQuery("q", { ...cfg, model: modelPlan({ keyword_useful: false }) });
  assert.equal(notUseful.retrieval_plan.keyword, false);
});

test("no retrieval means every arm is off", async () => {
  const plan = await planQuery("hello", { ...cfg, model: modelPlan({ requires_retrieval: false }) });

  assert.deepEqual(plan.retrieval_plan, { semantic: false, keyword: false, metadata: false });
});

test("an out-of-vocabulary domain or subcategory from the model is discarded", async () => {
  const plan = await planQuery("q", {
    ...cfg,
    model: modelPlan({ domain: "engineering", subcategories: ["wizardry", "backend"] }),
  });

  assert.equal(plan.domain, null);
  assert.deepEqual(plan.subcategories, ["backend"]);
});
