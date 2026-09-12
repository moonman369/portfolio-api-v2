"use strict";

// The stats branch. A plain function, not an agent: the router already decided this is
// a stats question and which sources it wants, so there is nothing left to reason about.
//
// It calls src/stats/* directly — no HTTP self-calls, no duplicated fetch logic — and
// writes only `statsPayload`. `generate` turns that into prose.

const { getConfig } = require("../../config");
const { readGithubStats } = require("../../stats/github");
const { getLeetcodeStats } = require("../../stats/leetcode");

const SOURCES = Object.freeze(["github", "leetcode"]);

/** `which` comes from the router. Anything unrecognised means "answer with everything". */
function sourcesFor(which) {
  return SOURCES.includes(which) ? [which] : SOURCES;
}

async function loadGithub(read) {
  const document = await read();
  // The document only exists once /api/v1/refresh has run at least once.
  if (!document?.stats) {
    throw new Error("no GitHub stats have been recorded yet");
  }
  return document.stats;
}

async function loadLeetcode(fetchStats, username) {
  // `status` is a transport artifact of the public endpoint; the numbers are the point.
  const { status, ...stats } = await fetchStats(username);
  return stats;
}

/**
 * @param {object} [deps] Injected for tests: `readGithubStats`, `getLeetcodeStats`,
 *   `username`. Production uses the real modules and the configured username.
 */
function createStatsNode(deps = {}) {
  return async function stats(state) {
    const readGithub = deps.readGithubStats ?? readGithubStats;
    const fetchLeetcode = deps.getLeetcodeStats ?? getLeetcodeStats;
    const username = deps.username ?? getConfig().leetcode.defaultUsername;

    const requested = sourcesFor(state.slots?.which);

    // allSettled, not all: one dead source must not cost the user the other one.
    const results = await Promise.allSettled(
      requested.map((source) =>
        source === "github" ? loadGithub(readGithub) : loadLeetcode(fetchLeetcode, username),
      ),
    );

    const statsPayload = {
      requested: state.slots?.which && SOURCES.includes(state.slots.which)
        ? state.slots.which
        : "both",
      github: null,
      leetcode: null,
      unavailable: [],
    };

    results.forEach((result, index) => {
      const source = requested[index];
      if (result.status === "fulfilled") {
        statsPayload[source] = result.value;
        return;
      }

      console.warn("agent.stats.source_unavailable", {
        sessionId: state.sessionId,
        source,
        message: result.reason?.message,
      });
      statsPayload.unavailable.push({
        source,
        reason: result.reason?.message ?? "unknown error",
      });
    });

    return { statsPayload };
  };
}

/**
 * The `stats_and_docs` branch: the mixed "my github stats and my projects" query the
 * old regex router handled and the LLD's taxonomy has no slot for.
 *
 * It composes the two real nodes rather than reimplementing either. Note what it keeps:
 * `statsPayload` from one and `documents` from the other, and deliberately NOT
 * `finalAnswer` — a mixed question is answered once, by `generate`, from both halves.
 */
function createStatsAndDocsNode({ statsNode, aboutMeNode }) {
  return async function statsAndDocs(state, config) {
    const [statsResult, docsResult] = await Promise.allSettled([
      statsNode(state, config),
      aboutMeNode(state, config),
    ]);

    if (statsResult.status === "rejected") {
      console.warn("agent.stats_and_docs.stats_failed", {
        sessionId: state.sessionId,
        message: statsResult.reason?.message,
      });
    }
    if (docsResult.status === "rejected") {
      console.warn("agent.stats_and_docs.documents_failed", {
        sessionId: state.sessionId,
        message: docsResult.reason?.message,
      });
    }

    return {
      statsPayload: statsResult.status === "fulfilled" ? statsResult.value?.statsPayload ?? null : null,
      documents: docsResult.status === "fulfilled" ? docsResult.value?.documents ?? [] : [],
    };
  };
}

module.exports = { createStatsNode, createStatsAndDocsNode };
