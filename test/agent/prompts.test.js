"use strict";

// Prompt construction. Pure string building - no model, no config, no network.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildStatsContext } = require("../../src/agent/prompts");

const GITHUB_STATS = { repos: 106, commits: 1854, pulls: 45, stars: 238 };

test("stats context carries the real numbers", () => {
  const context = buildStatsContext({
    requested: "both",
    github: GITHUB_STATS,
    leetcode: { totalSolved: 219 },
    unavailable: [],
  });

  assert.match(context, /GitHub: .*"repos":106/);
  assert.match(context, /LeetCode: .*"totalSolved":219/);
  assert.doesNotMatch(context, /UNAVAILABLE/);
});

test("stats context names an unavailable source in words", () => {
  const context = buildStatsContext({
    requested: "both",
    github: null,
    leetcode: { totalSolved: 219 },
    unavailable: [{ source: "github", reason: "mongo unreachable" }],
  });

  assert.match(context, /GitHub: UNAVAILABLE/);
  assert.match(context, /LeetCode: .*219/);
  assert.doesNotMatch(context, /mongo unreachable/, "internal reasons stay out of the prompt");
});

test("stats context is null when there is nothing to say", () => {
  assert.equal(buildStatsContext(null), null);
  assert.equal(
    buildStatsContext({ requested: "both", github: null, leetcode: null, unavailable: [] }),
    null,
  );
});
