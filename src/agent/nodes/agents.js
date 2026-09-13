"use strict";

// `makeAgentNode` — the one place a tool-using agent is constructed. `tech_web` is its
// first caller; Phases 6b and 7 reuse it unchanged, which is the point: there is exactly
// one answer to "what can this agent do", and it is the `toolset` argument.
//
// Built on `createAgent` from `langchain` v1, not LangGraph's `createReactAgent` — the
// latter's own type declarations mark it deprecated and point here (Phase 1 decision).
//
// The node writes back **only** `finalAnswer` and its sources. The agent's internal
// scratchpad — tool calls, tool results, intermediate reasoning — stays inside the agent
// and never reaches the conversation the next turn replays. `generate` appends the
// answer as a single AIMessage, exactly as it does for every other branch.

const { createAgent, modelCallLimitMiddleware } = require("langchain");
const { getConfig } = require("../../config");
const { getModel } = require("../models");
const { recentMessages } = require("../state");
const { AGENT_NO_ANSWER, buildTruncatedAnswer } = require("../prompts");

/** Message content can be a string or an array of blocks; a node wants the text. */
function toText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : (block?.text ?? "")))
      .join("")
      .trim();
  }
  return "";
}

/** Every `{ results: [...] }` artifact the run produced, in the order the tools ran. */
function collectSources(messages) {
  return messages
    .filter((message) => message?.getType?.() === "tool" || message?._getType?.() === "tool")
    .flatMap((message) => {
      const results = message?.artifact?.results;
      return Array.isArray(results) ? results : [];
    });
}

/** How many times the model asked for tools. One per round; see `wasTruncated`. */
function countToolRounds(messages) {
  return messages.filter(
    (message) =>
      (message?.getType?.() === "ai" || message?._getType?.() === "ai") &&
      (message?.tool_calls?.length ?? 0) > 0,
  ).length;
}

/**
 * Did the agent run out of steps?
 *
 * `modelCallLimitMiddleware({ exitBehavior: "end" })` stops the loop by appending its own
 * notice as the final message — correct behaviour, but that notice is library text, not
 * something to show a visitor. Rather than match on its wording, count: with a run limit
 * of `maxSteps`, spending every one of those calls on a tool request means the call that
 * would have written the answer never happened. Fewer rounds means the agent chose to
 * stop, and the last message really is its answer.
 */
function wasTruncated(messages, maxSteps) {
  return countToolRounds(messages) >= maxSteps;
}

/**
 * Build a graph node backed by a tool-using agent.
 *
 * @param {object} params
 * @param {string} params.name           Route name; also the node name in the feed.
 * @param {Array}  params.toolset        Exactly the tools this agent may call.
 * @param {string} params.prompt         System prompt.
 * @param {number} [params.maxSteps]     Model calls per run. Defaults to config.
 * @param {string} [params.sourcesField] State field to write collected sources into.
 * @param {object} [deps]                `model`, `config`, `agent` — injected by tests.
 */
function makeAgentNode({ name, toolset, prompt, maxSteps, sourcesField }, deps = {}) {
  if (!name || !Array.isArray(toolset) || !prompt) {
    throw new Error("makeAgentNode requires name, toolset and prompt");
  }

  const config = deps.config ?? getConfig();
  const steps = maxSteps ?? config.moonmind.agentMaxSteps;

  // Constructed once, at wiring time. The toolset is bound here and cannot be widened
  // later by anything the model says.
  //
  // `deps.agent` replaces the whole thing for tests that need to drive an exact message
  // list — `FakeToolCallingModel` synthesizes its own content and cannot, for instance,
  // produce an empty answer. The toolset is still bound and still reported by
  // `toolNames`, so the isolation assertions stay honest either way.
  const agent =
    deps.agent ??
    createAgent({
      model: deps.model ?? getModel("agent"),
      tools: toolset,
      systemPrompt: prompt,
      middleware: [modelCallLimitMiddleware({ runLimit: steps, exitBehavior: "end" })],
    });

  async function agentNode(state, runConfig) {
    // Seeded from the capped tail of the conversation, the same cap `generate` uses, so
    // a long thread cannot grow the agent's context without bound.
    const seed = recentMessages(state.messages, config.moonmind.historyMaxMessages);

    // `runConfig` is passed straight through: it carries the run's abort signal and the
    // callback manager, which is how the agent's tool calls surface in the Phase 4 feed.
    const result = await agent.invoke({ messages: seed }, runConfig);
    const messages = result?.messages ?? [];

    const sources = collectSources(messages);
    const update = sourcesField ? { [sourcesField]: sources } : {};

    if (wasTruncated(messages, steps)) {
      console.warn("agent.node.truncated", { node: name, maxSteps: steps, sources: sources.length });
      return { ...update, finalAnswer: buildTruncatedAnswer(sources) };
    }

    const answer = toText(messages[messages.length - 1]?.content);
    return { ...update, finalAnswer: answer || AGENT_NO_ANSWER };
  }

  // The bound toolset, exposed for tests and for the Phase 8 audit. Reading it is how
  // `test/agent/agents.test.js` asserts `tech_web` holds exactly `["web_search"]`.
  agentNode.toolNames = Object.freeze(toolset.map((t) => t.name));

  return agentNode;
}

module.exports = { makeAgentNode, collectSources, countToolRounds, wasTruncated, toText };
