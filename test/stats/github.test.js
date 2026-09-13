"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { readGithubStats, refreshGithubStats } = require("../../src/stats/github");

function repo({ stars = 0, pulls = 0, commits = null }) {
  return {
    name: "repo",
    visibility: "PUBLIC",
    stargazers: { totalCount: stars },
    pullRequests: { totalCount: pulls },
    defaultBranchRef: commits === null ? null : { target: { history: { totalCount: commits } } },
  };
}

/** Minimal stand-in for a Mongo collection: records writes, replays one document. */
function fakeCollection(document = null) {
  const writes = [];
  return {
    writes,
    async findOne(filter) {
      return document && document._id === filter._id ? document : null;
    },
    async updateOne(filter, update, options) {
      writes.push({ filter, update, options });
      return { acknowledged: true, upsertedCount: 1 };
    },
  };
}

/** GitHub stand-in: one REST profile probe, then N GraphQL repository pages. */
function fakeGithub({ pages = [], profileStatus = 200 } = {}) {
  const calls = [];
  let pageIndex = 0;

  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });

    if (init.method === "GET") {
      return { ok: profileStatus === 200, status: profileStatus, json: async () => ({}) };
    }

    const page = pages[pageIndex];
    pageIndex += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          user: {
            repositories: {
              totalCount: 0,
              pageInfo: {
                hasNextPage: pageIndex < pages.length,
                endCursor: `cursor-${pageIndex}`,
              },
              nodes: page,
            },
          },
        },
      }),
    };
  };

  return { fetchImpl, calls };
}

const refreshOptions = {
  username: "moonman369",
  token: "test-token",
  timeoutMs: 1000,
  docId: "github_stats",
};

test("reads the cached stats document unchanged", async () => {
  const stored = { _id: "github_stats", stats: { repos: 106, commits: 1854, pulls: 45, stars: 238 } };
  const collection = fakeCollection(stored);

  const result = await readGithubStats({ collection, docId: "github_stats" });

  assert.deepEqual(result, stored);
});

test("returns null when a refresh has never run", async () => {
  const result = await readGithubStats({ collection: fakeCollection(), docId: "github_stats" });

  assert.equal(result, null);
});

test("sums totals across every page", async () => {
  const collection = fakeCollection();
  const { fetchImpl } = fakeGithub({
    pages: [
      [repo({ stars: 10, pulls: 2, commits: 100 }), repo({ stars: 5, pulls: 1, commits: 50 })],
      [repo({ stars: 1, pulls: 0, commits: 7 })],
    ],
  });

  const totals = await refreshGithubStats({ ...refreshOptions, collection, fetchImpl });

  assert.deepEqual(totals, {
    totalRepos: 3,
    totalStars: 16,
    totalPulls: 3,
    totalCommits: 157,
  });
});

test("counts repositories with no default branch as zero commits", async () => {
  const collection = fakeCollection();
  const { fetchImpl } = fakeGithub({
    pages: [[repo({ stars: 2, pulls: 1, commits: null }), repo({ stars: 0, pulls: 0, commits: 9 })]],
  });

  const totals = await refreshGithubStats({ ...refreshOptions, collection, fetchImpl });

  assert.equal(totals.totalRepos, 2);
  assert.equal(totals.totalCommits, 9);
});

test("follows the cursor until hasNextPage is false", async () => {
  const collection = fakeCollection();
  const { fetchImpl, calls } = fakeGithub({
    pages: [[repo({})], [repo({})], [repo({})]],
  });

  await refreshGithubStats({ ...refreshOptions, collection, fetchImpl });

  const graphqlCalls = calls.filter((call) => call.method === "POST");
  assert.equal(graphqlCalls.length, 3);
});

test("upserts the stats document in the old service's shape", async () => {
  const collection = fakeCollection();
  const { fetchImpl } = fakeGithub({ pages: [[repo({ stars: 3, pulls: 2, commits: 11 })]] });

  await refreshGithubStats({ ...refreshOptions, collection, fetchImpl });

  assert.equal(collection.writes.length, 1);
  const [write] = collection.writes;
  assert.deepEqual(write.filter, { _id: "github_stats" });
  assert.deepEqual(write.update, {
    $set: { stats: { repos: 1, commits: 11, pulls: 2, stars: 3 } },
  });
  assert.deepEqual(write.options, { upsert: true });
});

test("rejects an unknown profile before paginating", async () => {
  const collection = fakeCollection();
  const { fetchImpl, calls } = fakeGithub({ profileStatus: 404 });

  await assert.rejects(
    () => refreshGithubStats({ ...refreshOptions, collection, fetchImpl }),
    { code: "GITHUB_PROFILE_NOT_FOUND" },
  );

  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  assert.equal(collection.writes.length, 0, "a failed refresh must not write");
});

test("surfaces a GraphQL error rather than writing zeroes", async () => {
  const collection = fakeCollection();
  const fetchImpl = async (url, init) => {
    if (init.method === "GET") {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: "Bad credentials" }] }),
    };
  };

  await assert.rejects(
    () => refreshGithubStats({ ...refreshOptions, collection, fetchImpl }),
    { code: "GITHUB_REQUEST_FAILED" },
  );

  assert.equal(collection.writes.length, 0);
});

test("sends the PAT and an abort signal on every call", async () => {
  const collection = fakeCollection();
  const seen = [];
  const inner = fakeGithub({ pages: [[repo({})]] }).fetchImpl;
  const fetchImpl = async (url, init) => {
    seen.push(init);
    return inner(url, init);
  };

  await refreshGithubStats({ ...refreshOptions, collection, fetchImpl });

  assert.ok(seen.length >= 2);
  seen.forEach((init) => {
    assert.equal(init.headers.Authorization, "Bearer test-token");
    assert.ok(init.signal instanceof AbortSignal);
  });
});
