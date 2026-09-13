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
const PAGE_SIZE = 100;

// Kept identical to the old service's query: same selection set means the same numbers.
const REPOSITORIES_QUERY = `
  query ($username: String!, $afterCursor: String) {
    user(login: $username) {
      repositories(
        first: ${PAGE_SIZE}
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

async function fetchRepositoryPage({ username, afterCursor, token, timeoutMs, fetchImpl }) {
  const response = await fetchImpl(GITHUB_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      query: REPOSITORIES_QUERY,
      variables: { username, afterCursor },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw failure(
      "GITHUB_REQUEST_FAILED",
      `GitHub GraphQL request failed with status ${response.status}`,
    );
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

  while (hasNextPage) {
    const page = await fetchRepositoryPage({
      username,
      afterCursor,
      token,
      timeoutMs,
      fetchImpl,
    });
    repositories.push(...(page.nodes ?? []));
    hasNextPage = Boolean(page.pageInfo?.hasNextPage);
    afterCursor = page.pageInfo?.endCursor ?? null;
  }

  const totals = totalsFrom(repositories);

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
