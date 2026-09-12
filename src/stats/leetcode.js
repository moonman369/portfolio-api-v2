"use strict";

// LeetCode stats over the public GraphQL API, with an in-process TTL cache.
//
// Framework-free plain JS. The clock, the fetch implementation and both cache/timeout
// budgets are injectable, so TTL behaviour is unit-testable without sleeping or
// touching the network.

const { getConfig } = require("../config");

const LEETCODE_ENDPOINT = "https://leetcode.com/graphql/";

const PROGRESS_QUERY = `query userSessionProgress($username: String!) {
  allQuestionsCount { difficulty count }
  matchedUser(username: $username) {
    submitStats {
      acSubmissionNum { difficulty count submissions }
    }
  }
}`;

const RANKING_QUERY = `query userPublicProfile($username: String!) {
  matchedUser(username: $username) {
      profile {
        ranking
      }
    }
  }`;

const cache = new Map();

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function resolveOptions(options) {
  const needsConfig = options.timeoutMs === undefined || options.ttlMs === undefined;
  const leetcode = needsConfig ? getConfig().leetcode : null;

  return {
    timeoutMs: options.timeoutMs ?? leetcode.timeoutMs,
    ttlMs: options.ttlMs ?? leetcode.cacheTtlMs,
    now: options.now ?? Date.now,
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

async function postGraphql({ query, operationName, username, timeoutMs, fetchImpl }) {
  const response = await fetchImpl(LEETCODE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, operationName, variables: { username } }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw failure(
      "LEETCODE_REQUEST_FAILED",
      `LeetCode request failed with status ${response.status}`,
    );
  }

  const payload = await response.json();

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw failure(
      "LEETCODE_REQUEST_FAILED",
      `LeetCode GraphQL error: ${payload.errors[0]?.message ?? "unknown"}`,
    );
  }

  return payload?.data ?? null;
}

// The old service indexed these arrays positionally (`[0]`=All, `[1]`=Easy, ...) and
// never checked the `difficulty` field, so a reordered response would silently swap the
// numbers. Look the bucket up by name instead — same result, no silent failure mode.
function countFor(buckets, difficulty) {
  if (!Array.isArray(buckets)) {
    throw failure("LEETCODE_UNEXPECTED_RESPONSE", "LeetCode returned no difficulty buckets");
  }

  const bucket = buckets.find((entry) => entry?.difficulty === difficulty);
  if (!bucket || typeof bucket.count !== "number") {
    throw failure(
      "LEETCODE_UNEXPECTED_RESPONSE",
      `LeetCode response is missing the '${difficulty}' bucket`,
    );
  }

  return bucket.count;
}

async function fetchLeetcodeStats({ username, timeoutMs, fetchImpl }) {
  const [progress, ranking] = await Promise.all([
    postGraphql({
      query: PROGRESS_QUERY,
      operationName: "userSessionProgress",
      username,
      timeoutMs,
      fetchImpl,
    }),
    postGraphql({
      query: RANKING_QUERY,
      operationName: "userPublicProfile",
      username,
      timeoutMs,
      fetchImpl,
    }),
  ]);

  if (!progress?.matchedUser) {
    throw failure("LEETCODE_USER_NOT_FOUND", `LeetCode user '${username}' was not found`);
  }

  const solved = progress.matchedUser?.submitStats?.acSubmissionNum;
  const totals = progress.allQuestionsCount;

  return {
    status: "success",
    username,
    totalSolved: countFor(solved, "All"),
    totalQuestions: countFor(totals, "All"),
    easySolved: countFor(solved, "Easy"),
    totalEasy: countFor(totals, "Easy"),
    mediumSolved: countFor(solved, "Medium"),
    totalMedium: countFor(totals, "Medium"),
    hardSolved: countFor(solved, "Hard"),
    totalHard: countFor(totals, "Hard"),
    ranking: ranking?.matchedUser?.profile?.ranking ?? null,
  };
}

/**
 * Stats for one LeetCode user, served from the in-process cache when fresh.
 * Cache misses and expiries go to the network; failures are not cached.
 */
async function getLeetcodeStats(username, options = {}) {
  const { timeoutMs, ttlMs, now, fetchImpl } = resolveOptions(options);
  const key = `leetcode:${username}`;

  const entry = cache.get(key);
  if (entry && entry.expiresAt > now()) {
    return entry.value;
  }

  const value = await fetchLeetcodeStats({ username, timeoutMs, fetchImpl });
  cache.set(key, { value, expiresAt: now() + ttlMs });
  return value;
}

/** Drop cached entries. Used by tests and any future admin path. */
function clearLeetcodeCache() {
  cache.clear();
}

module.exports = { getLeetcodeStats, clearLeetcodeCache };
