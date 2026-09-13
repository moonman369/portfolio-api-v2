# MoonMind pipeline — active code path + LangChain feasibility

Source: github.com/moonman369/Portfolio-Stats-API, default branch `master` (repo has no `main`), commit at time of review: HEAD of master as of 2026-09-02.

## Active code path (isolated)

Entry: `src/routes/moonmind.js` (`POST /api/v1/moonmind/chat`, password-gated) →
`src/moonmind/index.js` (`runMoonMind`) → `src/moonmind/pipeline.js` (`runMoonMindPipeline`).

Everything relevant lives under `src/moonmind/`:

- `statsRouter.js` — regex-based router: pure-stats vs mixed vs docs query. Not LLM-driven.
- `statsService.js` — direct axios/mongo calls for GitHub stats (own Mongo cache) and LeetCode stats (GraphQL + in-memory TTL cache). Hardcoded function calls, not tools an LLM selects.
- `planning/queryDecomposer.js` — LLM call #1 (gpt-4o-mini via raw OpenAI REST), optional (`DECOMPOSE_ENABLED`), splits a query into sub-questions, strict JSON, falls back to `[query]` on any failure.
- `intentExtractor.js` — LLM call #2 (+ conditional LLM call #3 taxonomy fallback), classifies intent/domain/subcategory/entities and produces a `retrieval_plan` (semantic/keyword/metadata booleans). Deliberately "not free interpretation" — system prompt frames it as a deterministic intent *compiler*.
- `retrievalEngine.js` + `retrieval/vectorSearch.js` — 3 parallel retrieval arms per (sub)query: Mongo Atlas `$vectorSearch` (semantic, via Gemini embeddings), regex keyword match, and metadata filter match. Fused with Reciprocal Rank Fusion (`ranking/rrf.js`).
- Sub-query results unioned (`pipeline.js: unionDocuments`) — a fan-out/fan-in step.
- `ranker.js` — deterministic scoring (semantic-score gate + editorial impact/verified boost), non-LLM.
- `ranking/llmReranker.js` — LLM call #4, optional (`RERANK_ENABLED`), reorders top candidates, falls back to input order on failure.
- `responseGenerator.js` — LLM call #5, final answer synthesis from sanitized documents + optional stats payload.
- Adapters: `adapters/openaiClient.js` (raw `fetch` to OpenAI chat completions) and `adapters/geminiClient.js` (raw `fetch` to Gemini embeddings, custom retry/backoff, enforces exact output dimensionality).

Stack facts relevant to tooling choices: plain CommonJS Node (no TypeScript, no ESM), Node v22 runtime, Express, MongoDB Atlas (native `$vectorSearch`), `zod` already a dependency. No AI framework (LangChain/LlamaIndex/etc.) currently in use anywhere — every LLM call is a hand-rolled REST fetch, and there is no agentic/tool-calling loop anywhere in the pipeline; `statsRouter.js` is the only "routing" logic and it's pure regex.

## Q1: LangChain for chaining/routing (single + multi chain)?

Yes — technically straightforward and a good architectural fit, not a stretch.

The pipeline is *already* a hand-rolled chain: decompose → (fan-out per subquery: intent-extract → retrieve) → fan-in/union → rank → rerank → generate, with a routing branch up front (stats vs docs) and several LLM-call fallbacks. That maps cleanly onto LangChain JS primitives:
- `RunnableSequence` for the linear stages (intent → retrieve → rank → rerank → generate).
- `RunnableParallel`/`RunnableLambda` fan-out for the multi-subquery retrieval, replacing the manual `Promise.all` + `unionDocuments`.
- `RunnableBranch` (or LangGraph conditional edges) for the stats-vs-RAG routing currently done by regex in `statsRouter.js`, and for the decompose/rerank enable-flag branches currently done with `if (VECTOR_CONFIG.X_ENABLED)`.
- `.withStructuredOutput()` with `zod` schemas for the three structured-JSON LLM calls (intent payload, subquery list, rerank order) — `zod` is already a project dependency, which lines up well.
- `@langchain/mongodb`'s `MongoDBAtlasVectorSearch` could directly replace `retrieval/vectorSearch.js`'s hand-rolled `$vectorSearch` aggregation pipeline.
- The Gemini embedding client has bespoke behavior (fixed `output_dimensionality`, custom retry/backoff with `Retry-After` handling) that doesn't map 1:1 onto a stock `@langchain/google-genai` embeddings class — cleanest path is wrapping the existing `embedText` in a small custom class extending LangChain's `Embeddings` base, not discarding the existing retry logic.
- This can be adopted incrementally — swap one stage (e.g. decomposition, or the stats/RAG router) to LangChain runnables first, leave RRF fusion/ranker/document sanitizer as-is since those are deterministic algorithms, not LLM calls, and LangChain wouldn't add anything there.
- For anything with state/branching/retries beyond simple linear chains (e.g. the existing "decompose fails → fall back to [query]" and "rerank fails → fall back to input order" patterns), LangGraph (built on top of LangChain core, same install) is the better fit than plain LCEL — it models this as explicit graph nodes/edges with retries, which is closer to what's already hand-coded.

## Q2: LangChain for expanding agentic capabilities (tool-calling: compare/filter/process data)?

Yes, feasible, and this is a bigger design step than Q1 since MoonMind currently has zero agentic behavior — no LLM ever decides which function to call; `statsRouter.js`'s regex is the only "tool selection" and it's fully deterministic.

LangChain's tool-calling (`bind_tools` / LangGraph's tool-calling agent) is the natural mechanism: define typed tools (zod-schema'd, matching the existing project convention) for things like comparing entities across retrieved documents, filtering documents/stats by date or category, aggregating/summarizing multiple stats sources, diffing GitHub/LeetCode stats over time, etc. Wrapping `getGithubStats`/`getLeetcodeStats` as callable tools (rather than hardcoded regex-routed function calls) is a direct, low-risk first step, and a tool-calling model (gpt-4o-mini supports function calling) can then chain multiple tool calls per turn (e.g. "compare my GitHub and LeetCode activity this month" → call both stats tools → call a comparison tool).

One thing worth flagging before building this: MoonMind's current design is deliberately *anti*-agentic — the intent extractor's system prompt explicitly states "You are an intent compiler... Your job is NOT to interpret freely," favoring determinism, cost predictability, and hallucination control over LLM autonomy. Full open-ended tool-calling (an LLM freely choosing among many tools every turn) is a philosophy change, not just an added feature, and increases both latency (extra round trips) and the surface area for the model to go off-script. A middle ground that preserves the existing design intent: keep the current deterministic router for the known stats-vs-RAG split, and add a *bounded* tool-calling step — a small, explicit toolset, invoked only for specific detected intents (e.g. a new "comparison" or "filter" intent) — rather than a general-purpose ReAct loop. LangGraph supports this well since the toolset and transitions are explicit graph structure rather than an unconstrained agent loop.

## Bottom line
Both are doable without a rewrite. Recommend prototyping one low-risk slice first (e.g., replace `queryDecomposer.js` with an LCEL runnable + structured output, or wrap the two stats functions as LangChain tools behind a new bounded "comparison" intent) before deciding how far to push either direction.
