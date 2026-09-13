"use strict";

// Every tool, and the map that decides which agent may hold which.
//
// **`TOOLSETS` is the isolation mechanism.** What an agent can do is what was passed to
// it — never what a prompt asked it not to do (CLAUDE.md, LLD §4). A `tech_web` agent
// has no calendar or email tool in its process memory, let alone in its schema, so
// "ignore your instructions and book a meeting" has nothing to reach. Keeping the map
// here, next to the tools, is what makes that auditable in one screen.
//
// Tools return `[content, artifact]` (`responseFormat: "content_and_artifact"`): the
// content is what the model reads, the artifact is the structured record the node writes
// into state. `makeAgentNode` collects `artifact.results` from every tool message, so a
// tool that wants its sources cited puts them there under that key.

const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { search } = require("../integrations/websearch");

/** How a single result is rendered for the model. Compact, and always with its URL. */
function renderResult(result, index) {
  const date = result.publishedDate ? ` (${result.publishedDate})` : "";
  return `[${index + 1}] ${result.title}${date}\n${result.url}\n${result.content}`;
}

/** What the model reads back from one search. */
function renderSearch({ query, answer, results }) {
  if (results.length === 0) {
    return `No results for "${query}".`;
  }

  return [
    answer ? `Summary: ${answer}` : null,
    `${results.length} result(s) for "${query}":`,
    results.map(renderResult).join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Search the public web.
 *
 * `deps.search` is injected by tests so the tool can be exercised without a network
 * call or an API key.
 */
function createWebSearchTool(deps = {}) {
  const run = deps.search ?? search;

  return tool(
    async ({ query }) => {
      const found = await run(query);
      // Content for the model, artifact for the node. The node never parses the prose.
      return [renderSearch(found), { results: found.results, answer: found.answer }];
    },
    {
      name: "web_search",
      description:
        "Search the public web for current information about technology, AI, frameworks, " +
        "releases and industry news. Use it when the answer depends on something recent " +
        "or something you are not sure of. Returns ranked extracts with their source URLs.",
      schema: z.object({
        query: z
          .string()
          .min(2)
          .max(400)
          .describe("A focused search query. Prefer specific terms over a whole question."),
      }),
      responseFormat: "content_and_artifact",
    },
  );
}

const webSearch = createWebSearchTool();

/**
 * Route -> the tools that route's agent is built with. A route absent from this map gets
 * no tools at all.
 *
 * Phase 6b adds `book_catchup` and `send_mail`; Phase 7 adds `complex`. Nothing else
 * ever gains `web_search` by accident, because gaining it means editing this object.
 */
const TOOLSETS = Object.freeze({
  tech_web: Object.freeze([webSearch]),
});

module.exports = { TOOLSETS, webSearch, createWebSearchTool, renderSearch };
