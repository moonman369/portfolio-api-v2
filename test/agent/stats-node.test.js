"use strict";

// The stats branch with fake stats services. No network, no Mongo, no model.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "test-token";
process.env.REFRESH_PROFILE ??= "test-profile";
process.env.REFRESH_SECRET ??= "test-secret";
process.env.OPENAI_API_KEY ??= "sk-test-not-used";
process.env.MOONMIND_PASSWORD ??= "test-password";
process.env.GEMINI_API_KEY ??= "gem-test-not-used";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createStatsNode, createStatsAndDocsNode } = require("../../src/agent/nodes/stats");

const GITHUB_STATS = { repos: 106, commits: 1854, pulls: 45, stars: 238 };
const LEETCODE_STATS = {
  status: "success",
  username: "moonman369",
  totalSolved: 219,
  totalQuestions: 3491,
  easySolved: 121,
  totalEasy: 867,
  mediumSolved: 94,
  totalMedium: 1813,
  hardSolved: 4,
  totalHard: 811,
  ranking: 512680,
};

/** Fake stats services that record their calls; either can be made to fail. */
function fakeServices({ githubFails = false, leetcodeFails = false, githubEmpty = false } = {}) {
  const calls = { github: 0, leetcode: [] };

  return {
    calls,
    readGithubStats: async () => {
      calls.github += 1;
      if (githubFails) throw new Error("mongo unreachable");
      return githubEmpty ? null : { _id: "github_stats", stats: GITHUB_STATS };
    },
    getLeetcodeStats: async (username) => {
      calls.leetcode.push(username);
      if (leetcodeFails) throw new Error("leetcode timed out");
      return LEETCODE_STATS;
    },
    username: "moonman369",
  };
}

const stateWith = (which) => ({ sessionId: "s1", slots: which ? { which } : {} });

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

test("which=github fetches only GitHub", async () => {
  const services = fakeServices();
  const node = createStatsNode(services);

  const { statsPayload } = await node(stateWith("github"));

  assert.equal(services.calls.github, 1);
  assert.equal(services.calls.leetcode.length, 0, "must not call LeetCode");
  assert.deepEqual(statsPayload.github, GITHUB_STATS);
  assert.equal(statsPayload.leetcode, null);
  assert.equal(statsPayload.requested, "github");
  assert.deepEqual(statsPayload.unavailable, []);
});

test("which=leetcode fetches only LeetCode", async () => {
  const services = fakeServices();
  const node = createStatsNode(services);

  const { statsPayload } = await node(stateWith("leetcode"));

  assert.equal(services.calls.github, 0, "must not read the GitHub document");
  assert.deepEqual(services.calls.leetcode, ["moonman369"]);
  assert.equal(statsPayload.github, null);
  assert.equal(statsPayload.leetcode.totalSolved, 219);
  assert.equal(statsPayload.requested, "leetcode");
});

test("which=both fetches both sources", async () => {
  const services = fakeServices();
  const node = createStatsNode(services);

  const { statsPayload } = await node(stateWith("both"));

  assert.equal(services.calls.github, 1);
  assert.equal(services.calls.leetcode.length, 1);
  assert.deepEqual(statsPayload.github, GITHUB_STATS);
  assert.equal(statsPayload.leetcode.ranking, 512680);
  assert.deepEqual(statsPayload.unavailable, []);
});

test("a missing or unrecognised `which` answers with everything", async () => {
  for (const which of [undefined, "nonsense"]) {
    const services = fakeServices();
    const { statsPayload } = await createStatsNode(services)(stateWith(which));

    assert.equal(services.calls.github, 1, `which=${which}`);
    assert.equal(services.calls.leetcode.length, 1, `which=${which}`);
    assert.equal(statsPayload.requested, "both");
  }
});

test("the LeetCode transport `status` field is dropped from the payload", async () => {
  const { statsPayload } = await createStatsNode(fakeServices())(stateWith("leetcode"));

  assert.equal(statsPayload.leetcode.status, undefined);
  assert.equal(statsPayload.leetcode.username, "moonman369");
});

// ---------------------------------------------------------------------------
// One source down
// ---------------------------------------------------------------------------

test("a failing GitHub source still returns LeetCode, with a note", async () => {
  const node = createStatsNode(fakeServices({ githubFails: true }));

  const { statsPayload } = await node(stateWith("both"));

  assert.equal(statsPayload.github, null);
  assert.equal(statsPayload.leetcode.totalSolved, 219, "the healthy source survives");
  assert.deepEqual(statsPayload.unavailable, [
    { source: "github", reason: "mongo unreachable" },
  ]);
});

test("a failing LeetCode source still returns GitHub, with a note", async () => {
  const node = createStatsNode(fakeServices({ leetcodeFails: true }));

  const { statsPayload } = await node(stateWith("both"));

  assert.deepEqual(statsPayload.github, GITHUB_STATS);
  assert.equal(statsPayload.leetcode, null);
  assert.deepEqual(statsPayload.unavailable, [
    { source: "leetcode", reason: "leetcode timed out" },
  ]);
});

test("both sources down still resolves rather than failing the run", async () => {
  const node = createStatsNode(fakeServices({ githubFails: true, leetcodeFails: true }));

  const { statsPayload } = await node(stateWith("both"));

  assert.equal(statsPayload.github, null);
  assert.equal(statsPayload.leetcode, null);
  assert.equal(statsPayload.unavailable.length, 2);
});

test("a never-refreshed GitHub document reads as unavailable, not as zeroes", async () => {
  const node = createStatsNode(fakeServices({ githubEmpty: true }));

  const { statsPayload } = await node(stateWith("github"));

  assert.equal(statsPayload.github, null);
  assert.match(statsPayload.unavailable[0].reason, /no GitHub stats have been recorded/);
});

test("the stats node writes statsPayload and nothing else", async () => {
  const result = await createStatsNode(fakeServices())(stateWith("both"));

  assert.deepEqual(Object.keys(result), ["statsPayload"]);
  assert.equal(result.finalAnswer, undefined, "generate owns the answer");
});

// ---------------------------------------------------------------------------
// stats_and_docs composition
// ---------------------------------------------------------------------------

test("stats_and_docs keeps statsPayload and documents, and drops finalAnswer", async () => {
  const node = createStatsAndDocsNode({
    statsNode: async () => ({ statsPayload: { github: GITHUB_STATS }, finalAnswer: "stats only" }),
    aboutMeNode: async () => ({ documents: [{ id: "doc-1" }], finalAnswer: "docs only" }),
  });

  const result = await node({ sessionId: "s1" });

  assert.deepEqual(result.statsPayload, { github: GITHUB_STATS });
  assert.deepEqual(result.documents, [{ id: "doc-1" }]);
  assert.equal(result.finalAnswer, undefined, "a mixed question is answered once, by generate");
});

test("stats_and_docs survives the documents half failing", async () => {
  const node = createStatsAndDocsNode({
    statsNode: async () => ({ statsPayload: { github: GITHUB_STATS } }),
    aboutMeNode: async () => {
      throw new Error("retrieval down");
    },
  });

  const result = await node({ sessionId: "s1" });

  assert.deepEqual(result.statsPayload, { github: GITHUB_STATS });
  assert.deepEqual(result.documents, []);
});

test("stats_and_docs survives the stats half failing", async () => {
  const node = createStatsAndDocsNode({
    statsNode: async () => {
      throw new Error("stats down");
    },
    aboutMeNode: async () => ({ documents: [{ id: "doc-1" }] }),
  });

  const result = await node({ sessionId: "s1" });

  assert.equal(result.statsPayload, null);
  assert.deepEqual(result.documents, [{ id: "doc-1" }]);
});

test("stats_and_docs runs both halves concurrently", async () => {
  const order = [];
  const node = createStatsAndDocsNode({
    statsNode: async () => {
      order.push("stats-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("stats-end");
      return { statsPayload: {} };
    },
    aboutMeNode: async () => {
      order.push("docs-start");
      return { documents: [] };
    },
  });

  await node({ sessionId: "s1" });

  assert.deepEqual(order, ["stats-start", "docs-start", "stats-end"]);
});
