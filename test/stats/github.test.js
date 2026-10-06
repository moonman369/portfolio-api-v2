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

/** Is this POST the owned-public repo count, rather than a repository page? */
const isCountQuery = (init) => JSON.parse(init.body).query.includes("privacy: PUBLIC");

/**
 * The count query's answer: `repoCount` when a test sets one, otherwise a 503 — which
 * exercises the fallback to the paginated count, so tests written before the separate
 * count existed keep asserting what they always did.
 */
function countResponse(repoCount) {
  return repoCount === undefined
    ? { ok: false, status: 503, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ data: { user: { repositories: { totalCount: repoCount } } } }) };
}

/** GitHub stand-in: one REST profile probe, N GraphQL repository pages, one count query. */
function fakeGithub({ pages = [], profileStatus = 200, repoCount } = {}) {
  const calls = [];
  let pageIndex = 0;

  const fetchImpl = async (url, init) => {
    if (init.method === "POST" && isCountQuery(init)) {
      calls.push({ url, method: init.method, count: true });
      return countResponse(repoCount);
    }
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

  const graphqlCalls = calls.filter((call) => call.method === "POST" && !call.count);
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

// ---------------------------------------------------------------------------
// GitHub's GraphQL time budget (2026-10-01): an overrun is a bare 502
// ---------------------------------------------------------------------------

/**
 * GitHub stand-in that answers each GraphQL call with the next scripted status, and
 * records the variables it was sent. A 200 serves one page of `size` repos.
 */
function scriptedGithub(statuses, { pages = 1 } = {}) {
  const sent = [];
  let served = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === "GET") {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (isCountQuery(init)) {
      return countResponse(undefined);
    }
    const { variables } = JSON.parse(init.body);
    sent.push(variables);
    const status = statuses.shift() ?? 200;
    if (status !== 200) {
      return { ok: false, status, json: async () => ({}) };
    }
    served += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          user: {
            repositories: {
              totalCount: 0,
              pageInfo: { hasNextPage: served < pages, endCursor: `cursor-${served}` },
              nodes: [repo({ stars: 1, commits: 2 })],
            },
          },
        },
      }),
    };
  };
  return { fetchImpl, sent };
}

const refresh = (fetchImpl) =>
  refreshGithubStats({
    collection: fakeCollection(),
    docId: "doc",
    username: "moonman369",
    token: "t",
    timeoutMs: 1000,
    fetchImpl,
  });

test("pages are requested 25 at a time — 100 overruns GitHub's budget", async () => {
  const github = scriptedGithub([], { pages: 2 });
  await refresh(github.fetchImpl);
  assert.deepEqual(github.sent.map((v) => v.pageSize), [25, 25]);
});

test("a 502 retries the same cursor at half the page size, and the run completes", async () => {
  const github = scriptedGithub([200, 502], { pages: 2 });
  const totals = await refresh(github.fetchImpl);

  assert.deepEqual(
    github.sent.map(({ afterCursor, pageSize }) => [afterCursor, pageSize]),
    [
      [null, 25],
      ["cursor-1", 25],
      ["cursor-1", 12],
    ],
    "same cursor, smaller page",
  );
  assert.equal(totals.totalRepos, 2);
  assert.equal(totals.totalCommits, 4);
});

test("a persistent 502 gives up at the floor, after a bounded number of tries", async () => {
  const github = scriptedGithub([502, 502, 502, 502, 502, 502]);
  await assert.rejects(refresh(github.fetchImpl), (error) => {
    assert.equal(error.code, "GITHUB_REQUEST_FAILED");
    assert.match(error.message, /status 502/);
    return true;
  });
  assert.deepEqual(github.sent.map((v) => v.pageSize), [25, 12, 6, 5]);
});

test("a non-gateway failure is not retried", async () => {
  const github = scriptedGithub([401]);
  await assert.rejects(refresh(github.fetchImpl), /status 401/);
  assert.equal(github.sent.length, 1);
});

// ---------------------------------------------------------------------------
// totalRepos: public, owned, forks included — the profile's count, its own query (2026-10-06)
// ---------------------------------------------------------------------------

test("totalRepos comes from the owned-public count; stars, pulls and commits from the pages", async () => {
  const collection = fakeCollection();
  const { fetchImpl, calls } = fakeGithub({
    pages: [[repo({ stars: 3, pulls: 2, commits: 10 }), repo({ stars: 1, pulls: 1, commits: 5 })], [repo({ commits: 1 })]],
    repoCount: 124,
  });

  const totals = await refreshGithubStats({ ...refreshOptions, collection, fetchImpl });

  assert.deepEqual(totals, { totalRepos: 124, totalStars: 4, totalPulls: 3, totalCommits: 16 });
  assert.deepEqual(collection.writes[0].update.$set.stats, { repos: 124, commits: 16, pulls: 3, stars: 4 });
  assert.equal(calls.filter((call) => call.count).length, 1, "one count query, no pagination");
});

test("the count query asks for every public repository the user owns, forks included", async () => {
  let countBody = null;
  const { fetchImpl } = fakeGithub({ pages: [[repo({})]], repoCount: 7 });
  await refreshGithubStats({
    ...refreshOptions,
    collection: fakeCollection(),
    fetchImpl: async (url, init) => {
      if (init.method === "POST" && isCountQuery(init)) countBody = JSON.parse(init.body);
      return fetchImpl(url, init);
    },
  });

  const compact = countBody.query.replace(/\s+/g, " ");
  assert.match(compact, /repositories\(ownerAffiliations: \[OWNER\], privacy: PUBLIC\) \{ totalCount \}/);
  assert.doesNotMatch(compact, /isFork/, "forks count: the profile's Repositories tab includes them");
  assert.doesNotMatch(compact, /first:|after:|nodes/, "no pagination");
  assert.deepEqual(countBody.variables, { username: "moonman369" });
});

test("if the count query fails, totalRepos falls back to the paginated count and the refresh succeeds", async () => {
  const collection = fakeCollection();
  const { fetchImpl } = fakeGithub({ pages: [[repo({}), repo({}), repo({})]] }); // count answers 503

  const totals = await refreshGithubStats({ ...refreshOptions, collection, fetchImpl });

  assert.equal(totals.totalRepos, 3);
  assert.equal(collection.writes[0].update.$set.stats.repos, 3);
});
