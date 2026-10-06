"use strict";

// GitHub stats: a read path over a Mongo cache document, and a refresh path that
// recomputes that document from the GitHub GraphQL API.
//
// Framework-free plain JS. Every dependency (collection, token, fetch) can be injected,
// so the whole module is testable offline; when an option is omitted it falls back to
// config/db, which is what the HTTP layer and Phase 2's stats node rely on.

const { getConfig } = require("../config");
const { statsCollection } = require("../db");

const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const GITHUB_REST_ENDPOINT = "https://api.github.com";
// Repositories per page, and why it is not 100. GitHub runs each GraphQL query against a
// ~10s execution budget and answers an overrun with a bare **502** (an nginx HTML page, not
// a GraphQL error). The expensive field is `history.totalCount` on every repository's
// default branch, so the cost grows with repos AND commits. Measured 2026-10-01 against
// 113 repositories: first=100 → 502 at ~11s, twice; 50 → 200 in 9.1s (at the edge);
// 25 → 200 in 4.4s. The old service's 100 worked until the account outgrew it.
const PAGE_SIZE = 25;
// If a page still overruns, the SAME cursor is retried at half the size, down to this
// floor — at most three retries per page, so a real outage still fails fast-ish.
const MIN_PAGE_SIZE = 5;
// Gateway answers: the query (or GitHub) ran out of time, not a bad request.
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

// The old service's selection set, unchanged — same fields means the same numbers. Only
// the page size is now a variable instead of a hardcoded 100.
const REPOSITORIES_QUERY = `
  query ($username: String!, $afterCursor: String, $pageSize: Int!) {
    user(login: $username) {
      repositories(
        first: $pageSize
        after: $afterCursor
        ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
        isFork: false
        orderBy: {field: CREATED_AT, direction: DESC}
      ) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          name
          visibility
          stargazers {
            totalCount
          }
          pullRequests(states: [OPEN, CLOSED, MERGED]) {
            totalCount
          }
          defaultBranchRef {
            target {
              ... on Commit {
                history {
                  totalCount
                }
              }
            }
          }
        }
      }
    }
  }
`;

// The repo count, asked for separately: every public repository the user owns, forks
// INCLUDED — the number on the profile's Repositories tab, and GitHub's own `public_repos`
// for an unauthenticated visitor. Verified 2026-10-06: 124 here, 124 `public_repos`
// (106 originals + 18 forks). The paginated query still feeds stars, pulls and commits
// from its own scope; only `totalRepos` comes from here. One field, no pagination:
// `totalCount` is computed by GitHub, so this is cheap.
const OWNED_PUBLIC_REPOS_QUERY = `
  query ($username: String!) {
    user(login: $username) {
      repositories(ownerAffiliations: [OWNER], privacy: PUBLIC) {
        totalCount
      }
    }
  }
`;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function authHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function resolveTarget({ collection, docId }) {
  if (collection && docId) {
    return { collection, docId };
  }
  const { mongo } = getConfig();
  return {
    collection: collection ?? (await statsCollection()),
    docId: docId ?? mongo.statsDocId,
  };
}

/**
 * Read the cached GitHub stats document.
 * Returns the stored document, or `null` when a refresh has never run — the old
 * service's contract, preserved exactly.
 */
async function readGithubStats(options = {}) {
  const { collection, docId } = await resolveTarget(options);
  return collection.findOne({ _id: docId });
}

async function fetchRepositoryPage({ username, afterCursor, pageSize, token, timeoutMs, fetchImpl }) {
  const response = await fetchImpl(GITHUB_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      query: REPOSITORIES_QUERY,
      variables: { username, afterCursor, pageSize },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const error = failure(
      "GITHUB_REQUEST_FAILED",
      `GitHub GraphQL request failed with status ${response.status} (page size ${pageSize})`,
    );
    error.retryable = RETRYABLE_STATUSES.has(response.status);
    throw error;
  }

  const payload = await response.json();

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw failure(
      "GITHUB_REQUEST_FAILED",
      `GitHub GraphQL error: ${payload.errors[0]?.message ?? "unknown"}`,
    );
  }

  const repositories = payload?.data?.user?.repositories;
  if (!repositories) {
    throw failure("GITHUB_PROFILE_NOT_FOUND", `GitHub user '${username}' was not found`);
  }

  return repositories;
}

/** The number of public repositories the user owns, forks included. Throws on any failure. */
async function fetchOwnedPublicRepoCount({ username, token, timeoutMs, fetchImpl }) {
  const response = await fetchImpl(GITHUB_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query: OWNED_PUBLIC_REPOS_QUERY, variables: { username } }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw failure("GITHUB_REQUEST_FAILED", `GitHub repo count request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw failure("GITHUB_REQUEST_FAILED", `GitHub GraphQL error: ${payload.errors[0]?.message ?? "unknown"}`);
  }

  const count = payload?.data?.user?.repositories?.totalCount;
  if (!Number.isInteger(count)) {
    throw failure("GITHUB_REQUEST_FAILED", "GitHub repo count response had no totalCount");
  }
  return count;
}

/** Confirm the profile exists before paginating potentially hundreds of repositories. */
async function assertProfileExists({ username, token, timeoutMs, fetchImpl }) {
  const response = await fetchImpl(`${GITHUB_REST_ENDPOINT}/users/${encodeURIComponent(username)}`, {
    method: "GET",
    headers: authHeaders(token),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 404) {
    throw failure("GITHUB_PROFILE_NOT_FOUND", `GitHub user '${username}' was not found`);
  }
  if (!response.ok) {
    throw failure(
      "GITHUB_REQUEST_FAILED",
      `GitHub profile lookup failed with status ${response.status}`,
    );
  }
}

function totalsFrom(repositories) {
  return repositories.reduce(
    (totals, repository) => ({
      totalRepos: totals.totalRepos + 1,
      totalStars: totals.totalStars + (repository?.stargazers?.totalCount ?? 0),
      totalPulls: totals.totalPulls + (repository?.pullRequests?.totalCount ?? 0),
      // Repositories with no default branch (empty repos) contribute no commits.
      totalCommits:
        totals.totalCommits + (repository?.defaultBranchRef?.target?.history?.totalCount ?? 0),
    }),
    { totalRepos: 0, totalStars: 0, totalPulls: 0, totalCommits: 0 },
  );
}

/**
 * Recompute the GitHub totals from the live API and persist them.
 * Returns `{ totalRepos, totalCommits, totalStars, totalPulls }`.
 */
async function refreshGithubStats(options = {}) {
  const { collection, docId } = await resolveTarget(options);
  const config = options.username && options.token && options.timeoutMs ? null : getConfig();

  const username = options.username ?? config.github.profile;
  const token = options.token ?? config.github.token;
  const timeoutMs = options.timeoutMs ?? config.github.timeoutMs;
  const fetchImpl = options.fetchImpl ?? fetch;

  await assertProfileExists({ username, token, timeoutMs, fetchImpl });

  const repositories = [];
  let afterCursor = null;
  let hasNextPage = true;
  let pageSize = options.pageSize ?? PAGE_SIZE;

  while (hasNextPage) {
    let page;
    try {
      page = await fetchRepositoryPage({
        username,
        afterCursor,
        pageSize,
        token,
        timeoutMs,
        fetchImpl,
      });
    } catch (error) {
      // A gateway error means the query overran GitHub's budget: ask for less, same
      // cursor. The smaller size is kept for the remaining pages, which cost the same.
      if (error.retryable && pageSize > MIN_PAGE_SIZE) {
        const smaller = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 2));
        console.warn("github.page_retry", { reason: error.message, from: pageSize, to: smaller });
        pageSize = smaller;
        continue;
      }
      throw error;
    }
    repositories.push(...(page.nodes ?? []));
    hasNextPage = Boolean(page.pageInfo?.hasNextPage);
    afterCursor = page.pageInfo?.endCursor ?? null;
  }

  const totals = totalsFrom(repositories);

  // Repos: public and owned, forks included — the profile's number. If that query fails, fall back to the paginated count
  // (every repository it covered) rather than failing a refresh whose other three numbers
  // are already in hand.
  try {
    totals.totalRepos = await fetchOwnedPublicRepoCount({ username, token, timeoutMs, fetchImpl });
  } catch (error) {
    console.warn("github.repo_count_fallback", {
      code: error?.code ?? null,
      message: error?.message,
      fallback: totals.totalRepos,
    });
  }

  await collection.updateOne(
    { _id: docId },
    {
      $set: {
        stats: {
          repos: totals.totalRepos,
          commits: totals.totalCommits,
          pulls: totals.totalPulls,
          stars: totals.totalStars,
        },
      },
    },
    { upsert: true },
  );

  return totals;
}

module.exports = { readGithubStats, refreshGithubStats };
