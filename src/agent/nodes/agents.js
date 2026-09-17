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

const {
  createAgent,
  modelCallLimitMiddleware,
  dynamicSystemPromptMiddleware,
} = require("langchain");
const { z } = require("zod");
const { SystemMessage, HumanMessage } = require("@langchain/core/messages");
const { RunnableLambda } = require("@langchain/core/runnables");
const { getConfig } = require("../../config");
const { getModel } = require("../models");
const { recentMessages } = require("../state");
const {
  AGENT_NO_ANSWER,
  buildTruncatedAnswer,
  buildDateContext,
  buildScopePrompt,
  resolveExcludedTopics,
  OUT_OF_SCOPE_ANSWER,
} = require("../prompts");

// Flat, and two fields only — this runs before every search, so it is the one model call
// in the system that should stay as cheap as it can be.
const ScopeOutputSchema = z.object({
  inScope: z.boolean(),
  topic: z.string().nullable(),
});

/**
 * Build the scope guard: one classification, before any tool is dispatched.
 *
 * It runs on the visitor's question rather than on the query the model would have
 * written, which is the right input for a topic decision and means a blocked question
 * costs exactly one cheap model call — no agent loop, no search, no credit spent.
 *
 * **Fails open.** If the classifier itself errors, the question is allowed through and
 * the failure is logged. A scope guard is an editorial filter, not a safety control:
 * the model's own training still applies, and the router's `refusal` route still exists,
 * so breaking every tech question because a classifier hiccuped is the worse outcome.
 * Note that this reasoning does NOT transfer to Phase 9's `action` node, which guards a
 * side effect — sending mail — and must fail closed.
 */
function createScopeGuard({ name, topics, model }) {
  const prompt = buildScopePrompt(topics);

  return async function scopeCheck(question, runConfig) {
    let verdict;
    try {
      verdict = await model
        .withStructuredOutput(ScopeOutputSchema, { name: "scope" })
        .invoke([new SystemMessage(prompt), new HumanMessage(question)], runConfig);
    } catch (error) {
      console.error("agent.scope_guard.failed", { node: name, message: error?.message });
      return { inScope: true, topic: null };
    }

    if (!verdict?.inScope) {
      // The topic is logged but never shown: naming it back to a visitor tells a prober
      // exactly what the filter keys on.
      console.log("agent.scope_guard.blocked", { node: name, topic: verdict?.topic ?? null });
    }

    return { inScope: Boolean(verdict?.inScope), topic: verdict?.topic ?? null };
  };
}

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
 * @param {boolean} [params.scopeGuard]  Classify the question before any tool runs.
 * @param {object} [deps]                `model`, `config`, `agent`, `scopeModel`,
 *                                       `scopeGuard` — injected by tests.
 */
function makeAgentNode({ name, toolset, prompt, maxSteps, sourcesField, scopeGuard }, deps = {}) {
  if (!name || !Array.isArray(toolset) || !prompt) {
    throw new Error("makeAgentNode requires name, toolset and prompt");
  }

  const config = deps.config ?? getConfig();
  const steps = maxSteps ?? config.moonmind.agentMaxSteps;

  // Opt-in per agent, and switchable without a deploy. Wrapped as a named runnable so it
  // appears in the Phase 4 feed as `<node>.scope_check` — a guardrail that runs invisibly
  // is a guardrail nobody can audit.
  const guardEnabled = scopeGuard && config.moonmind.scopeGuardEnabled;
  const guard = guardEnabled
    ? RunnableLambda.from(
        deps.scopeGuard ??
          createScopeGuard({
            name,
            topics: resolveExcludedTopics(config.moonmind.excludedTopics),
            model: deps.scopeModel ?? getModel("intent"),
          }),
      ).withConfig({ runName: `${name}.scope_check` })
    : null;

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
      // The system prompt is assembled per run rather than passed as `systemPrompt`,
      // so today's date is always today's. A model with no date anchors on its training
      // cutoff instead: gpt-4o-mini was observed appending "2023" to its own search
      // queries and answering from the results that came back. The container is
      // always-on, so a date resolved once at boot would go stale within a day.
      //
      // This is the same defect Deviation 32 recorded for the old response prompt, in a
      // new place. Every agent gets it, not just tech_web - Phase 9 cannot resolve
      // "next Tuesday" without knowing what today is.
      middleware: [
        dynamicSystemPromptMiddleware(() => `${prompt}\n\n${buildDateContext()}`),
        modelCallLimitMiddleware({ runLimit: steps, exitBehavior: "end" }),
      ],
    });

  async function agentNode(state, runConfig) {
    // Seeded from the capped tail of the conversation, the same cap `generate` uses, so
    // a long thread cannot grow the agent's context without bound.
    const seed = recentMessages(state.messages, config.moonmind.historyMaxMessages);
    const empty = sourcesField ? { [sourcesField]: [] } : {};

    if (guard) {
      const question = toText(state.rawQuery) || toText(seed[seed.length - 1]?.content);

      // Fail open, and guarantee it here rather than only inside the classifier: this
      // catch covers any guard, including an injected one, so no failure in the gate can
      // take the whole route down with it.
      let inScope = true;
      try {
        ({ inScope } = await guard.invoke(question, runConfig));
      } catch (error) {
        console.error("agent.scope_guard.errored", { node: name, message: error?.message });
      }

      // Out of scope ends the turn here: the agent is never invoked, so no tool is
      // dispatched and no search credit is spent. `generate` passes `finalAnswer`
      // through, so the visitor gets this copy verbatim rather than a model's take on it.
      if (!inScope) {
        return { ...empty, finalAnswer: OUT_OF_SCOPE_ANSWER };
      }
    }

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
