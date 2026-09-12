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
      return true;
    },
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
