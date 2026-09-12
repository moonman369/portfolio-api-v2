"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { getLeetcodeStats, clearLeetcodeCache } = require("../../src/stats/leetcode");

const TOTALS = [
  { difficulty: "All", count: 3491 },
  { difficulty: "Easy", count: 867 },
  { difficulty: "Medium", count: 1813 },
  { difficulty: "Hard", count: 811 },
];

const SOLVED = [
  { difficulty: "All", count: 219, submissions: 400 },
  { difficulty: "Easy", count: 121, submissions: 180 },
  { difficulty: "Medium", count: 94, submissions: 190 },
  { difficulty: "Hard", count: 4, submissions: 30 },
];

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

/**
 * Stands in for the two parallel GraphQL calls. Counts invocations so cache behaviour
 * is observable, and lets each test reshape the payload.
 */
function fakeLeetcode({ totals = TOTALS, solved = SOLVED, ranking = 512680, matched = true } = {}) {
  const calls = [];

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, operationName: body.operationName, username: body.variables.username });

    if (body.operationName === "userSessionProgress") {
      return jsonResponse({
        allQuestionsCount: totals,
        matchedUser: matched ? { submitStats: { acSubmissionNum: solved } } : null,
      });
    }
    return jsonResponse({
      matchedUser: matched ? { profile: { ranking } } : null,
    });
  };

  return { fetchImpl, calls };
}

const baseOptions = { timeoutMs: 1000, ttlMs: 60_000 };

test.beforeEach(() => {
  clearLeetcodeCache();
});

test("maps the LeetCode response onto the old service's shape", async () => {
  const { fetchImpl } = fakeLeetcode();

  const stats = await getLeetcodeStats("moonman369", { ...baseOptions, fetchImpl });

  assert.deepEqual(stats, {
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
  });
});

test("looks buckets up by difficulty, not by array position", async () => {
  // Same data, reversed order. The old service indexed positionally and would have
  // reported the Hard counts as the All counts.
  const { fetchImpl } = fakeLeetcode({
    totals: [...TOTALS].reverse(),
    solved: [...SOLVED].reverse(),
  });

  const stats = await getLeetcodeStats("moonman369", { ...baseOptions, fetchImpl });

  assert.equal(stats.totalSolved, 219);
  assert.equal(stats.totalQuestions, 3491);
  assert.equal(stats.hardSolved, 4);
  assert.equal(stats.totalHard, 811);
});

test("serves a second call from cache while the entry is fresh", async () => {
  const { fetchImpl, calls } = fakeLeetcode();
  let clock = 1_000;
  const now = () => clock;

  await getLeetcodeStats("moonman369", { ...baseOptions, fetchImpl, now });
  assert.equal(calls.length, 2, "first call queries both GraphQL operations");

  clock += 59_000; // still inside the 60s TTL
  await getLeetcodeStats("moonman369", { ...baseOptions, fetchImpl, now });
  assert.equal(calls.length, 2, "cache hit must not issue more requests");
});

test("refetches once the TTL has elapsed", async () => {
  const { fetchImpl, calls } = fakeLeetcode();
  let clock = 1_000;
  const now = () => clock;

  await getLeetcodeStats("moonman369", { ...baseOptions, fetchImpl, now });
  clock += 60_001; // past the TTL
  await getLeetcodeStats("moonman369", { ...baseOptions, fetchImpl, now });

  assert.equal(calls.length, 4, "expired entry must be refetched");
});

test("caches per username", async () => {
  const { fetchImpl, calls } = fakeLeetcode();

  await getLeetcodeStats("moonman369", { ...baseOptions, fetchImpl });
  await getLeetcodeStats("someone-else", { ...baseOptions, fetchImpl });

  assert.equal(calls.length, 4);
  assert.deepEqual(
    [...new Set(calls.map((call) => call.username))],
    ["moonman369", "someone-else"],
  );
});

test("does not cache failures", async () => {
  let attempt = 0;
  const fetchImpl = async (url, init) => {
    attempt += 1;
    if (attempt <= 2) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return fakeLeetcode().fetchImpl(url, init);
  };

  await assert.rejects(() => getLeetcodeStats("moonman369", { ...baseOptions, fetchImpl }), {
    code: "LEETCODE_REQUEST_FAILED",
  });

  const stats = await getLeetcodeStats("moonman369", { ...baseOptions, fetchImpl });
  assert.equal(stats.totalSolved, 219);
});

test("reports an unknown user as LEETCODE_USER_NOT_FOUND", async () => {
  const { fetchImpl } = fakeLeetcode({ matched: false });

  await assert.rejects(() => getLeetcodeStats("ghost", { ...baseOptions, fetchImpl }), {
    code: "LEETCODE_USER_NOT_FOUND",
  });
});

test("reports a malformed payload instead of returning undefined counts", async () => {
  const { fetchImpl } = fakeLeetcode({ totals: [{ difficulty: "Easy", count: 1 }] });

  await assert.rejects(() => getLeetcodeStats("moonman369", { ...baseOptions, fetchImpl }), {
    code: "LEETCODE_UNEXPECTED_RESPONSE",
  });
});

test("passes an abort signal so a hung request cannot stall the process", async () => {
  const seen = [];
  const inner = fakeLeetcode().fetchImpl;
  const fetchImpl = async (url, init) => {
    seen.push(init.signal);
    return inner(url, init);
  };

  await getLeetcodeStats("moonman369", { ...baseOptions, fetchImpl });

  assert.equal(seen.length, 2);
  seen.forEach((signal) => assert.ok(signal instanceof AbortSignal));
});
