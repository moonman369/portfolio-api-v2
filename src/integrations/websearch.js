"use strict";

// Web search via Tavily. Plain JS on native `fetch` — no provider SDK, no LangChain.
// `agent/tools.js` wraps this; `retrieval/` and `stats/` never touch it.
//
// Tavily rather than a general search API because it returns extracted page *content*
// alongside the links (ARCHITECTURE.md §2, Phase 5 gate). A snippets-only provider would
// have meant building fetch-and-extract here, which is the bulk of the work this module
// otherwise avoids.
//
// One call, one timeout, no retries: the agent above can decide to search again, and a
// retry loop underneath an agent loop multiplies latency in a way neither layer can see.

const { getConfig } = require("../config");

/** Domains that never help a tech question and burn the result budget. */
const EXCLUDED_DOMAINS = Object.freeze(["pinterest.com", "quora.com"]);

const MAX_QUERY_CHARS = 400;
// Each result's extract, trimmed before it reaches a prompt. Tavily's "advanced" depth
// can return a lot; the agent needs enough to answer, not the whole page.
const MAX_CONTENT_CHARS = 1200;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** One result, reduced to the fields a model or a citation needs. */
function toResult(raw) {
  const content = typeof raw?.content === "string" ? raw.content.trim() : "";

  return {
    title: typeof raw?.title === "string" ? raw.title.trim() : "",
    url: typeof raw?.url === "string" ? raw.url : "",
    content: content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS - 1)}…` : content,
    score: typeof raw?.score === "number" ? raw.score : null,
    publishedDate: raw?.published_date ?? null,
  };
}

/**
 * Search the web.
 *
 * @param {string} query
 * @param {{ maxResults?: number, searchDepth?: "basic"|"advanced", config?: object,
 *          signal?: AbortSignal }} [options]
 * @returns {Promise<{ query: string, answer: string|null, results: Array }>}
 */
async function search(query, options = {}) {
  const { tavily } = options.config ?? getConfig();

  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed) {
    throw failure("WEB_SEARCH_EMPTY_QUERY", "A search query is required");
  }

  const body = {
    query: trimmed.slice(0, MAX_QUERY_CHARS),
    max_results: options.maxResults ?? tavily.maxResults,
    search_depth: options.searchDepth ?? tavily.searchDepth,
    // Tavily's own one-line synthesis. Cheap, and a useful anchor when the extracts
    // disagree with each other.
    include_answer: true,
    include_raw_content: false,
    exclude_domains: EXCLUDED_DOMAINS,
  };

  let response;
  try {
    response = await fetch(`${tavily.baseUrl}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tavily.apiKey}`,
      },
      body: JSON.stringify(body),
      // Every outbound call is bounded (CLAUDE.md). `options.signal` lets the graph's
      // own wall-clock cap abort a search already in flight.
      signal: options.signal ?? AbortSignal.timeout(tavily.timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw failure("WEB_SEARCH_TIMEOUT", `Web search timed out after ${tavily.timeoutMs}ms`);
    }
    throw failure("WEB_SEARCH_REQUEST_FAILED", `Web search request failed: ${error?.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    // The key itself is never logged or echoed.
    throw failure("WEB_SEARCH_UNAUTHORIZED", "Web search rejected the API key");
  }
  if (response.status === 429) {
    throw failure("WEB_SEARCH_RATE_LIMITED", "Web search quota exhausted");
  }
  if (!response.ok) {
    throw failure("WEB_SEARCH_REQUEST_FAILED", `Web search returned HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw failure("WEB_SEARCH_UNEXPECTED_RESPONSE", "Web search returned a non-JSON body");
  }

  if (!Array.isArray(payload?.results)) {
    throw failure("WEB_SEARCH_UNEXPECTED_RESPONSE", "Web search response had no results array");
  }

  return {
    query: body.query,
    answer: typeof payload.answer === "string" && payload.answer.trim() ? payload.answer.trim() : null,
    results: payload.results.map(toResult).filter((result) => result.url),
  };
}

module.exports = { search, EXCLUDED_DOMAINS, MAX_CONTENT_CHARS };
