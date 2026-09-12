"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadConfig } = require("../src/config");

// The minimum environment a boot requires: everything else has a default.
const MINIMAL_ENV = Object.freeze({
  MONGO_URI: "mongodb://localhost:27017/test",
  GITHUB_PAT: "test-token",
  REFRESH_PROFILE: "test-profile",
  REFRESH_SECRET: "test-secret",
  OPENAI_API_KEY: "sk-test-not-used",
  MOONMIND_PASSWORD: "test-password",
});

function envWith(overrides) {
  return { ...MINIMAL_ENV, ...overrides };
}

test("accepts a minimal environment and applies defaults", () => {
  const config = loadConfig(MINIMAL_ENV);

  assert.equal(config.env, "development");
  assert.equal(config.port, 8000);
  assert.equal(config.mongo.dbName, "portfolio-stats-api");
  assert.equal(config.mongo.statsCollection, "gitStatsArchive");
  assert.equal(config.mongo.statsDocId, "github_stats");
  assert.equal(config.leetcode.defaultUsername, "moonman369");
  assert.equal(config.leetcode.cacheTtlMs, 60 * 60 * 1000);
  assert.equal(config.http.bodyLimit, "1mb");
});

test("returns a deeply frozen object", () => {
  const config = loadConfig(MINIMAL_ENV);

  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.mongo));
  assert.throws(() => {
    config.mongo.dbName = "hijacked";
  }, TypeError);
});

test("fails when a required variable is missing, naming every offender", () => {
  assert.throws(
    () => loadConfig({ MONGO_URI: "mongodb://localhost:27017/test" }),
    (error) => {
      assert.match(error.message, /Invalid environment configuration/);
      assert.match(error.message, /GITHUB_PAT/);
      assert.match(error.message, /REFRESH_PROFILE/);
      assert.match(error.message, /REFRESH_SECRET/);
      assert.match(error.message, /OPENAI_API_KEY/);
      assert.match(error.message, /MOONMIND_PASSWORD/);
      return true;
    },
  );
});

test("every model role defaults to gpt-4o-mini", () => {
  const { models } = loadConfig(MINIMAL_ENV).moonmind;

  assert.deepEqual(models, {
    response: "gpt-4o-mini",
    intent: "gpt-4o-mini",
    router: "gpt-4o-mini",
    decompose: "gpt-4o-mini",
    rerank: "gpt-4o-mini",
    agent: "gpt-4o-mini",
  });
});

test("router and decompose fall back to the intent model", () => {
  const { models } = loadConfig(envWith({ MOONMIND_INTENT_MODEL: "gpt-5-nano" })).moonmind;

  assert.equal(models.router, "gpt-5-nano");
  assert.equal(models.decompose, "gpt-5-nano");
  assert.equal(models.response, "gpt-4o-mini", "response is unaffected");
});

test("rerank and agent fall back to the response model", () => {
  const { models } = loadConfig(envWith({ MOONMIND_RESPONSE_MODEL: "gpt-5" })).moonmind;

  assert.equal(models.rerank, "gpt-5");
  assert.equal(models.agent, "gpt-5");
  assert.equal(models.intent, "gpt-4o-mini", "intent is unaffected");
});

test("an explicit per-role model overrides its fallback", () => {
  const { models } = loadConfig(
    envWith({ MOONMIND_INTENT_MODEL: "gpt-5-nano", MOONMIND_ROUTER_MODEL: "gpt-5-mini" }),
  ).moonmind;

  assert.equal(models.router, "gpt-5-mini");
  assert.equal(models.decompose, "gpt-5-nano", "decompose still follows intent");
});

test("router confidence thresholds are bounded to 0..1", () => {
  assert.equal(loadConfig(MINIMAL_ENV).moonmind.routerMinConfidence, 0.5);
  assert.equal(loadConfig(MINIMAL_ENV).moonmind.topicChangeConfidence, 0.8);
  assert.throws(
    () => loadConfig(envWith({ MOONMIND_ROUTER_MIN_CONFIDENCE: "1.5" })),
    /MOONMIND_ROUTER_MIN_CONFIDENCE/,
  );
});

test("rejects a blank required variable rather than treating it as set", () => {
  assert.throws(() => loadConfig(envWith({ MONGO_URI: "   " })), /MONGO_URI/);
});

test("rejects an out-of-range port", () => {
  assert.throws(() => loadConfig(envWith({ PORT: "70000" })), /PORT/);
  assert.throws(() => loadConfig(envWith({ PORT: "not-a-number" })), /PORT/);
});

test("rejects a non-positive timeout", () => {
  assert.throws(() => loadConfig(envWith({ GITHUB_TIMEOUT_MS: "0" })), /GITHUB_TIMEOUT_MS/);
  assert.throws(() => loadConfig(envWith({ LEETCODE_CACHE_TTL_MS: "-1" })), /LEETCODE_CACHE_TTL_MS/);
});

test("coerces numeric strings", () => {
  const config = loadConfig(envWith({ PORT: "9100", LEETCODE_CACHE_TTL_MS: "1000" }));

  assert.equal(config.port, 9100);
  assert.equal(config.leetcode.cacheTtlMs, 1000);
});

test("parses CORS_ORIGINS as a trimmed comma-separated list", () => {
  const config = loadConfig(
    envWith({ CORS_ORIGINS: "https://a.example, https://b.example ,," }),
  );

  assert.deepEqual(config.http.corsOrigins, ["https://a.example", "https://b.example"]);
});

test("falls back to the old service's CORS allowlist when unset", () => {
  const config = loadConfig(MINIMAL_ENV);

  assert.ok(config.http.corsOrigins.includes("https://moonman.in"));
  assert.ok(config.http.corsOrigins.includes("http://localhost:5173"));
});

test("marks production explicitly", () => {
  assert.equal(loadConfig(envWith({ NODE_ENV: "production" })).isProduction, true);
  assert.equal(loadConfig(MINIMAL_ENV).isProduction, false);
});

test("rejects an unknown NODE_ENV", () => {
  assert.throws(() => loadConfig(envWith({ NODE_ENV: "staging" })), /NODE_ENV/);
});
