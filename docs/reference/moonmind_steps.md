# MoonMind Agentic Rebuild — Claude Code Prompt Playbook (v2)

Serial prompts for building the MoonMind agentic workflow (LangChain + LangGraph, one `StateGraph`) in a fresh repo, per `moonmind-agentic-lld.md`. Paste them into Claude Code **in order**, one phase per session.

**What changed from v1**
- **The new repo is a rewrite, not a copy.** Prompt 00 now writes `docs/ARCHITECTURE.md` with a lean, feature-oriented layout, one-way dependency rules, a carry-over policy, and a "do not bring over" list. Every later prompt builds into that layout. "Parity" now means the same HTTP contract and results, not the same files.
- **The graph has concrete design rules.** They are simple (one wiring file, plain-function nodes, one agent factory, one toolset map) and robust (structured output with deterministic fallbacks, an error boundary, per-turn state reset, bounded loops and timeouts, side effects enforced in code, a sticky active flow for multi-turn actions). Each phase tests these rules with fake models, so no network is needed.

## How continuity works

Every prompt follows the same contract, so prompt *n* resumes exactly where prompt *n−1* stopped:

1. **Start:** read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`; verify the previous phase is ticked, else stop.
2. **Work:** build only the current phase, inside the `ARCHITECTURE.md` layout. **⛔ GATE** = present options and wait for your answer.
3. **End:** run the End-of-phase checklist in `CLAUDE.md` (tests, structure check, env example, deps, handoff entry, commit `phase-N: …`), then stop.

Don't paste the next prompt until you've verified the current phase's "Done when".

## Before Prompt 00

1. Create an empty GitHub repo for the rebuild; clone it locally.
2. Copy `moonmind-agentic-lld.md` and `moonmind-langchain-feasibility.md` into `docs/reference/` in that repo (one copy of the LLD is enough).
3. Open Claude Code at the new repo root.

Existing repo (read-only reference throughout): **https://github.com/moonman369/Portfolio-Stats-API**, default branch **`master`** (no `main`).

## Prompt map

| # | Phase (LLD §6) | Scope |
|---|---|---|
| 00 | — | Bootstrap: behavior map, data model, architecture, rules, progress log |
| 01 | 0 | Lean skeleton + stats parity + Docker/CI/CD deploy |
| 02 | 1 | Graph skeleton: wiring, router, trivial nodes, error boundary, checkpointer |
| 03 | 2 | `stats` node |
| 04 | 3a | Documents + retrieval modules, ingestion |
| 05 | 3b | `about_me` node + eval |
| 06 | 4 | Live event feed |
| 07 | 5 | Agent factory + `tech_web` |
| 08 | 6a | Action decisions + integrations + tools |
| 09 | 6b | `book_catchup` + `send_mail` |
| 10 | 7 | `complex` |
| 11 | 8 | Cutover + final structure audit |
| R | — | Resume a broken session |

---

## Prompt 00 — Bootstrap (docs only, no app code)

````md
# Phase 00 — Bootstrap the MoonMind agentic rebuild (docs only)

## Context
This empty repo is a **clean rewrite** of Portfolio-Stats-API's service plus a LangChain + LangGraph agentic rebuild of its MoonMind chat pipeline. It must be leaner and better organized than the old repo — not a copy of its structure.
- Source of truth: `docs/reference/moonmind-agentic-lld.md`. Companion: `docs/reference/moonmind-langchain-feasibility.md`. Read both fully.
- Old codebase (read-only, never modify): https://github.com/moonman369/Portfolio-Stats-API, branch `master` (no `main`). Clone to `../Portfolio-Stats-API-ref`.

## Goal
Write five files, then stop. No application code.

### 1. `docs/OLD_REPO_MAP.md` — behavior map, not a structure to replicate
- Every HTTP route: method, path, auth header, request/response shape, caching behavior.
- What each `src/moonmind/*` file *does* (inputs → outputs, LLM calls, fallbacks, feature flags), plus `config/vectorConfig.js` enums, `models/vectorDocument.js`, `utils/embeddingGenerator.js`.
- Deploy setup (Dockerfile, compose, `.github/workflows/deploy.yml`); note `vercel.json` is stale.
- Every env var read — **names only, never values**.
- Document ingestion routes (create / bulk-create / embedding regeneration), if present.
- **Leave behind:** dead code, unused dependencies, duplicated logic, structural pain points.
- **Divergences from LLD.**

### 2. `docs/DATA_MODEL.md`
Record this shape and these constraints, then reconcile against `models/vectorDocument.js` and `config/vectorConfig.js` — **code wins on conflict**; note every difference.

Collection `moonmind_documents_v3` (env `MONGO_VECTOR_COLLECTION`), vector field `embedding` (`MONGO_VECTOR_FIELD`), Atlas index `vector_index` (`MONGO_VECTOR_INDEX`).

```json
{
  "_id": "ObjectId(...)",
  "id": "3341e59a-2a2f-4e8a-8aff-eb957e1ceeba",
  "title": "Ayan Maiti - Professional Resume Overview",
  "category": "experience",
  "tags": ["java", "springboot", "dotnet", "azure", "microservices", "generative-ai"],
  "summary_for_embedding": "keyword-dense, not prose",
  "content_full": "full prose (nullable)",
  "metadata": {
    "domain": "experience",
    "subcategory": ["cloud", "ai", "backend", "generative-ai", "experimental"],
    "verified": true,
    "proficiency_level": null,
    "organization": "self",
    "impact_score": 100,
    "is_active": true,
    "date_start": "2022-01-01T00:00:00.000Z",
    "completion_year": 2026,
    "external_links": { "portfolio": "...", "resume": "...", "github": "...", "leetcode": "...", "linkedin": "..." }
  },
  "created_at": "2026-03-29T15:10:58.966Z",
  "updated_at": "2026-07-10T12:47:16.224Z",
  "embedding": [/* exactly 768 floats */]
}
```

- `category` ∈ ALLOWED_CATEGORIES (singular: skill, certification, credential, education, experience, profile, project, hobby, topic); `metadata.domain` ∈ ALLOWED_DOMAINS (plural: skills, projects, experience, profile, certifications, education, achievements, research, hobbies). Separate enums, mapped via CATEGORY_DOMAIN_MAP — a recurring source of payload errors.
- `metadata.subcategory`: array from ALLOWED_SUBCATEGORIES (~90 values).
- `embedding`: exactly 768 numbers. The validator only checks bsonType; wrong length writes fine but is silently unsearchable.
- `content_full` and most metadata date/org/link fields are nullable.
- Embeddings: `gemini-embedding-2`, 768 dims, **one text per `embedContent` call** (batching returns one aggregated vector — silently wrong). Document template `title: <title> | text: <Tags: ...>\n<summary_for_embedding>\n<content_full>`, ~28,000-char budget, word-boundary truncation trimming `content_full`'s tail first. Query template `task: search result | query: <query>`. No `taskType`, no manual normalization. Record the old implementation's exact details — templates must stay byte-identical.

### 3. `docs/ARCHITECTURE.md` — the target shape of this repo

**Layout** (CommonJS; feature folders; max 3 levels under `src/`):
```
src/
  server.js              # starts the app; the only process entry point
  config.js              # the ONLY reader of process.env — zod-validated at boot, frozen, fails fast
  db.js                  # one MongoClient, named collection getters
  http/                  # thin: validate → call → respond. No business logic.
    app.js               # express app, middleware, mounting, error handler
    auth.js              # shared password header, rate limiters
    stats.js             # /github, /leetcode, /refresh
    documents.js         # ingestion routes
    chat.js              # /api/v1/moonmind/chat (+ run feed in Phase 4)
  stats/                 # github.js, leetcode.js — plain JS, framework-free
  documents/             # taxonomy.js, schema.js, embeddings.js, store.js — plain JS
  retrieval/             # embedder.js, plan.js, search.js, rank.js, index.js
  integrations/          # websearch.js, calendar.js, email.js — plain JS
  agent/
    index.js             # runTurn(), streamTurn() — the only API the HTTP layer uses
    graph.js             # StateGraph wiring only
    state.js
    models.js            # getModel(role)
    prompts.js           # every system prompt
    tools.js             # every tool + TOOLSETS map
    nodes/               # router.js, simple.js, stats.js, about-me.js, agents.js, generate.js
scripts/                 # parity-check, evals, oauth, one-off migrations
test/                    # node:test, mirrors src/
docs/
```

**Dependency rules**
- One direction only: `http → agent → {retrieval, stats, documents, integrations} → {config, db}`. Nothing imports upward or sideways into `http`.
- LangChain/LangGraph imports only in `agent/` and `retrieval/`. `stats/`, `documents/`, `integrations/` stay framework-free plain JS, so they're testable and reusable.
- No `utils/`, `helpers/`, `common/`, `lib/`, or `adapters/` folders. Shared code gets a named home or stays local until there's a real second use.
- Split a file by responsibility once it passes ~250 lines.
- Lean deps: native `fetch` + `AbortSignal.timeout` (no axios), `node --env-file=.env` locally (no dotenv), `node:test` (no jest). Justify every new dependency in PROGRESS.md.

**Carry-over policy**
- Rewrite, don't copy. Read old code to learn behavior, then write it fresh in this layout.
- Exception: byte-fidelity and pure-algorithm code (embedding templates + truncation, RRF, ranker scoring) may move over near-verbatim into its new home.
- Do not bring over: `vercel.json`, the regex `statsRouter.js`, the `adapters/` layer, dead code or unused deps from the map, commented-out code.

**Graph design — simple**
- `agent/graph.js` is wiring only and fits on one screen:
  ```js
  function buildGraph({ nodes, checkpointer }) {
    return new StateGraph(State)
      .addNode('router', nodes.router)
      /* one addNode per route + 'generate' */
      .addEdge(START, 'router')
      .addConditionalEdges('router', routeFromState, ROUTE_TO_NODE)
      /* each branch → 'generate' */
      .addEdge('generate', END)
      .compile({ checkpointer });
  }
  ```
- Every node is a plain `async (state, config) => partialState` function that returns only the keys it changes. No classes, no BaseNode.
- `routeFromState` is a pure function over a static `ROUTE_TO_NODE` map; unknown route → `refusal`.
- All four agentic nodes come from one `makeAgentNode({ name, toolset, prompt, maxSteps })` factory (Phase 5). The agent runs on its own message list seeded from recent history, and writes back only its final answer and sources — never its internal tool chatter.
- `TOOLSETS` in `tools.js` is the single auditable map of which agent gets which tools.
- `getModel(role)` is the single model factory (roles: router, intent, decompose, rerank, response, agent), reading the per-role env vars from `config.js`.
- `runTurn({ sessionId, message })` is the single entry point for HTTP, feed, and evals.

**Graph design — robust**
- Every LLM output that drives control flow (router, intent, decompose, rerank) uses `.withStructuredOutput(zodSchema)` and has a deterministic fallback on failure: router → low-confidence path; decompose → `[query]`; rerank → input order.
- **Per-turn reset:** `runTurn` resets per-turn fields (`route`, `documents`, `statsPayload`, `searchResults`, `finalAnswer`, `error`) in its invoke input. Otherwise the checkpointer leaks the last turn's data into this one. Persistent across turns: `messages`, `slots`, `pendingConfirmation`, `activeFlow`, `summary`.
- **Error boundary:** `graph.js` wraps every node with one small `withErrorBoundary`. It logs with runId/sessionId/node, sets `error` plus a graceful `finalAnswer`, and flow continues to `generate` (which passes through). The API never 500s because a node threw.
- **Retries live in one layer:** the outbound call (Gemini, OpenAI, GitHub, search). No stacked node-level retries on top.
- **Everything is bounded:** timeout on every outbound call, per-agent `maxSteps`, graph `recursionLimit`, per-run wall-clock cap, max input message length, history sent to models capped at N turns (`summary` populated only when history exceeds the cap).
- **Side effects only in tools, enforced in code:** idempotent writes; calendar writes require a confirmation recorded in state on a prior turn; the email recipient comes from config and is never a tool argument.
- **Sticky active flow:** while `activeFlow` is set (e.g. mid-booking), `routeFromState` returns to that flow unless the router classifies an explicit cancel or topic change. Slot-filling replies like "Tuesday 3pm" must not be re-routed elsewhere.
- **Testable offline:** `buildGraph` takes injected nodes/deps, so `test/agent/` runs the whole graph with fake models and fake services.

**Explicitly out of scope (keep it simple):** supervisor/multi-agent hierarchies, one agent that can see every tool, hand-rolled agent loops, plugin registries or DI containers, custom event buses, TypeScript/ESM migration, mandatory LangSmith.

### 4. `CLAUDE.md` — standing rules (keep it short; point to docs)
- **Project:** clean rewrite + MoonMind agentic rebuild. LLD (`docs/reference/moonmind-agentic-lld.md`) is the plan; `docs/ARCHITECTURE.md` is the shape; `docs/DATA_MODEL.md` is the data contract. If code or a prompt conflicts with them, stop and ask.
- **Stack:** Node 22, CommonJS, Express, official MongoDB driver, zod. LangChain + LangGraph together as one stack — never propose dropping or deferring LangGraph.
- **Config:** env-driven via `config.js` only; `MONGO_` / `GEMINI_` prefixes; per-role model env vars (`MOONMIND_INTENT_MODEL`, `MOONMIND_RESPONSE_MODEL`, `MOONMIND_RERANK_MODEL` → RESPONSE, `MOONMIND_DECOMPOSE_MODEL` → INTENT), default `gpt-4o-mini`; never commit secrets.
- **Guardrails:** tool isolation by `TOOLSETS` binding, never by prompting; email recipient fixed by config; calendar writes need code-enforced confirmation.
- **Deploy:** Docker on an Oracle Cloud Ubuntu VM behind Nginx, `restart: unless-stopped`, GitHub Actions. Always-on, not serverless. Never hardcode VM paths — confirm with Ayan (the old API uses `~/api-deploy`; this one gets its own folder).
- **Working style:** one phase per session; additive commits; stop at ⛔ GATEs and unclear design points; the old repo is read-only.
- **End-of-phase checklist:** (1) `node --test` passes; (2) structure check — new files match ARCHITECTURE.md layout and dependency rules, with no new top-level folders or grab-bag modules (any deviation needs a gate); (3) `.env.example` updated; (4) no unused deps; (5) handoff entry in PROGRESS.md (shipped, files, env vars, deviations, open items); (6) commit `phase-N: …`; (7) stop.

### 5. `docs/PROGRESS.md`
Phase checklist (00, 0, 1, 2, 3a, 3b, 4, 5, 6a, 6b, 7, 8) with "Done when" from the LLD, plus sections `## Handoff log`, `## Decisions`, `## Deviations from LLD`. First handoff entry = Phase 00.

## Done when
All five files exist; OLD_REPO_MAP covers every route and env var name and has a "Leave behind" list; DATA_MODEL is reconciled against the real validator. Commit `phase-00: bootstrap docs`, report divergences + leave-behind list, stop.
````

---

## Prompt 01 — Phase 0: lean skeleton + stats parity

````md
# Phase 0 — Lean skeleton, stats parity, deploy

## Resume
Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`, `docs/OLD_REPO_MAP.md`. Confirm Phase 00 is complete; if not, stop. Old repo: `../Portfolio-Stats-API-ref` (https://github.com/moonman369/Portfolio-Stats-API, `master`) — read-only.

## Goal
Build the skeleton in the ARCHITECTURE.md layout and reach behavior parity for non-MoonMind endpoints:
- `src/server.js`, `src/config.js` (zod-validated, fail fast), `src/db.js`, `src/http/app.js` + `auth.js` + `stats.js`, `/health`.
- `src/stats/github.js`, `src/stats/leetcode.js` — rewritten fresh with native fetch + timeouts. Keep the GitHub Mongo cache and LeetCode in-memory TTL cache behavior.
- `/leetcode`, `/github`, `/refresh` with the exact paths, auth, and response shapes from OLD_REPO_MAP.
- Dockerfile, docker-compose.yml, deploy workflow, `.env.example`, `npm start` / `npm run dev` (`node --env-file=.env`).
- `scripts/parity-check.js`: hits OLD and NEW base URLs, diffs JSON ignoring volatile fields.

## Constraints
- Parity = same contract and results, not same files. Don't copy old files; don't port anything on the Leave-behind list.
- `stats/` stays framework-free and callable directly (Phase 2's node imports it; no HTTP self-calls).
- ⛔ GATE before the deploy workflow: ask me for the VM folder, container name, host port, and subdomain. They must not collide with the old API (`~/api-deploy`).
- If the container can't reach Atlas: check the cluster is active (free tier spins down) and VM iptables outbound DNS (port 53) before touching code.

## Done when
CI/CD deploys; `parity-check.js` shows no diffs for `/leetcode`, `/github`, `/refresh`; unit tests cover config validation and cache TTL. Run the End-of-phase checklist, commit `phase-0: lean skeleton + stats parity`, stop.
````

---

## Prompt 02 — Phase 1: graph skeleton

````md
# Phase 1 — Graph skeleton

## Resume
Read `CLAUDE.md`, `docs/ARCHITECTURE.md` (Graph design sections are binding), `docs/PROGRESS.md`, LLD §1–§3. Confirm Phase 0 is ticked; if not, stop.

## Step 1 — Verify the toolchain, report, then continue
Install `langchain`, `@langchain/core`, `@langchain/langgraph`, `@langchain/openai`, and a MongoDB checkpointer for LangGraph JS. Verify and report:
- Installed versions; `require()` works for each under CommonJS on Node 22.
- Our `zod` version works with `.withStructuredOutput()` in the installed `@langchain/core`.
- Which prebuilt agent helper is current: LangGraph's `createReactAgent` (named in the LLD) or LangChain v1's `createAgent`, which superseded it. Check the installed package types/docs. Record the choice in Decisions — `makeAgentNode` (Phase 5) uses it.
If any check fails, stop with options.

## Step 2 — Build (in `src/agent/`, exactly per ARCHITECTURE.md)
- `state.js`: LLD §3 fields (`sessionId`, `rawQuery`, `messages` with the messages reducer, `route`, `routeConfidence`, `slots`, `documents`, `statsPayload`, `searchResults`, `pendingConfirmation`, `summary`) plus `finalAnswer`, `error`, `activeFlow`. Log the three additions under Deviations.
- `models.js` (`getModel(role)`; add `MOONMIND_ROUTER_MODEL` → falls back to INTENT → `gpt-4o-mini`), `prompts.js`.
- `nodes/router.js`: structured output (zod enum of the 8 routes + confidence + slots, e.g. `which: github|leetcode|both`), temperature 0, deterministic fallback on parse failure, a low-confidence path (record the behavior in Decisions).
- `nodes/simple.js`: `refusal` (no extra LLM call), `list_capabilities` (templated from the route enum). Stubs for the remaining routes set `finalAnswer: "not implemented yet"`.
- `nodes/generate.js`: pass through when `finalAnswer` is set; otherwise synthesize (full synthesis lands in 3b).
- `graph.js`: wiring only, `routeFromState` + `ROUTE_TO_NODE`, `withErrorBoundary` on every node, `activeFlow` stickiness in `routeFromState`, Mongo checkpointer, `thread_id = sessionId`.
- `index.js`: `runTurn({ sessionId, message })` with per-turn reset, recursion limit, and wall-clock cap.
- `src/http/chat.js`: `POST /api/v1/moonmind/chat`, same password header as the old route, zod-validated body `{ sessionId, message }` with a length cap.

## ⛔ GATE
The old `statsRouter.js` has a mixed (stats + docs) path that the 8-route taxonomy lacks. Propose 2–3 options and wait for my pick before finalizing the router schema.

## Done when
- Offline graph tests (fake models): every route reaches its node and then `generate`; a throwing node yields a graceful answer instead of a 500; per-turn fields don't leak across two turns on one `sessionId`; router parse failure hits the fallback.
- `scripts/router-eval.js`: ≥3 labeled prompts per route (24+) all classify correctly against the real model.
- `refusal` and `list_capabilities` return real answers; two turns persist `messages` in the checkpointer.

Run the End-of-phase checklist, commit `phase-1: graph skeleton`, stop.
````

---

## Prompt 03 — Phase 2: `stats` node

````md
# Phase 2 — stats node

## Resume
Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md` (incl. the mixed-query Decision). Confirm Phase 1 is ticked; if not, stop.

## Goal
`src/agent/nodes/stats.js`: a plain function (no agent — the router already decided) that calls `src/stats/*` directly based on `slots.which` and writes `statsPayload`. `generate` synthesizes. Implement the mixed-query decision if it touches this node.

## Constraints
- No duplicated fetch logic, no HTTP self-calls.
- If one source fails, return the other plus a note in the payload — don't fail the run.

## Done when
Offline test with fake stats services covers github / leetcode / both / one-source-down. 5 live questions are recorded side by side with the old pipeline in `docs/evals/stats.md` and are consistent with `/github` and `/leetcode`. Run the End-of-phase checklist, commit `phase-2: stats node`, stop.
````

---

## Prompt 04 — Phase 3a: documents + retrieval modules

````md
# Phase 3a — Documents and retrieval modules (not yet a node)

## Resume
Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`, `docs/DATA_MODEL.md`, `docs/OLD_REPO_MAP.md`, feasibility Q1. Confirm Phase 2 is ticked; if not, stop.

## Data contract (full spec in docs/DATA_MODEL.md; reconciled version wins)
Collection `moonmind_documents_v3` / field `embedding` / index `vector_index` (env-driven). Doc: `id, title, category (singular), tags[], summary_for_embedding, content_full (nullable), metadata { domain (plural), subcategory[], verified, proficiency_level, organization, impact_score, is_active, date_start, completion_year, external_links }, created_at, updated_at, embedding[768]`.

## Goal — plain JS in `src/documents/`
- `taxonomy.js`: the enums + CATEGORY_DOMAIN_MAP (single source).
- `schema.js`: one zod schema for the document plus a `validateDocument()` that enforces category↔domain, the subcategory vocabulary, and embedding length === 768.
- `embeddings.js`: Gemini `embedContent` call (one text per call, timeout, retry/backoff honoring `Retry-After`) plus the two templates and truncation, carried over near-verbatim.
- `store.js`: CRUD used by ingestion.
- `src/http/documents.js`: rewrite the ingestion routes listed in OLD_REPO_MAP on top of `store.js` + `schema.js`.

## Goal — LangChain-shaped in `src/retrieval/`
- `embedder.js`: a small subclass of LangChain's `Embeddings` wrapping `documents/embeddings.js`. `embedQuery` uses the query template; `embedDocuments` uses the document template, sequentially. No stock `@langchain/google-genai` class.
- `plan.js`: decompose + intent extraction (+ taxonomy fallback) via `getModel(role).withStructuredOutput(zod)`, temperature 0; decompose failure → `[query]`.
- `search.js`: semantic (`$vectorSearch`, hand-rolled for parity; note `@langchain/mongodb` as optional later), keyword, metadata arms + RRF.
- `rank.js`: deterministic ranker (semantic gate + impact/verified boost), document sanitizer, LLM reranker (failure → input order).
- `index.js`: `retrieve(query, opts)` composing the above — the one function the node and tools will call.

## Done when
- Template fidelity: fixtures generated by running the old `embeddingGenerator.js` (5 docs, including a truncation case, and 5 queries) match the new output byte-for-byte.
- For 5 queries, the new semantic arm returns the same top-k ids as the old code against the live collection.
- `validateDocument` rejects a category/domain mismatch and a 767-length embedding.
- Ingestion routes pass a smoke test.
- Offline tests for fallbacks.

Run the End-of-phase checklist, commit `phase-3a: documents + retrieval`, stop.
````

---

## Prompt 05 — Phase 3b: `about_me` node

````md
# Phase 3b — about_me node

## Resume
Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`. Confirm Phase 3a is ticked; if not, stop.

## Goal
- `src/agent/nodes/about-me.js`: an LCEL composition over `retrieval/`: decompose → fan-out per sub-query (`RunnableParallel`/`RunnableLambda`: intent → retrieve) → union → rank → rerank → write `documents`. Keep `DECOMPOSE_ENABLED` / `RERANK_ENABLED` from `config.js`. Keep the node small — the logic already lives in `retrieval/`.
- `src/agent/nodes/generate.js`: full synthesis (old responseGenerator behavior: sanitized docs + optional stats payload) on the `response` model, prompt in `prompts.js`. Tolerate sparse docs. History capped per ARCHITECTURE.md.

## Done when
`scripts/about-me-eval.js` runs 10 fixed questions (including one mixed stats+docs question) against the old `/api/v1/moonmind/chat` and the new endpoint, writing `docs/evals/about_me.md` (answers side by side + retrieved-id overlap), and I agree quality is equivalent. Offline test covers the node with fake retrieval. Run the End-of-phase checklist, commit `phase-3b: about_me node`, stop.
````

---

## Prompt 06 — Phase 4: live event feed

````md
# Phase 4 — Live event feed

## Resume
Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`, LLD §6 Phase 4. Confirm Phase 3b is ticked; if not, stop.

## ⛔ GATE first
Always-on container, so both work: (a) `POST /runs` + polling `GET /runs/:id?since=`, (b) SSE. Present trade-offs (Nginx buffering/timeouts for SSE, frontend cost) and wait for my pick.

## Goal (after the gate)
- `agent/index.js` → `streamTurn()`, built on the compiled graph's `.stream()` / `.streamEvents()`. No separate instrumentation layer.
- `agent/runs.js`: `runs` / `steps` Mongo collections; step = `runId, seq, node, type (start|end|tool|error), ts, summary`. Short summaries only — no secrets, full docs, or raw prompts. Add `runs.js` to the ARCHITECTURE.md layout.
- `http/chat.js`: feed endpoint(s); `/api/v1/moonmind/chat` unchanged.
- `public/run-viewer.html` test page; Nginx location block if SSE.

## Done when
The test page shows ordered steps ending in the final answer for an about_me and a stats query; an erroring node appears as an `error` step followed by a graceful answer. Run the End-of-phase checklist, commit `phase-4: live event feed`, stop.
````

---

## Prompt 07 — Phase 5: agent factory + `tech_web`

````md
# Phase 5 — makeAgentNode + tech_web

## Resume
Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md` (agent-helper Decision from Phase 1). Confirm Phase 4 is ticked; if not, stop.

## ⛔ GATE
Confirm the search provider (LLD recommends Tavily) before building.

## Goal
- `src/integrations/websearch.js`: plain JS client with a timeout.
- `src/agent/tools.js`: a zod-schema'd `web_search` tool, and `TOOLSETS = { tech_web: [web_search] }`.
- `src/agent/nodes/agents.js`: `makeAgentNode({ name, toolset, prompt, maxSteps })` built on the chosen prebuilt helper. It seeds from capped recent history, enforces `maxSteps`, and writes back only `finalAnswer` + sources (`searchResults` for tech_web). Tool calls must show up in the Phase 4 feed. This factory is reused unchanged in Phases 6b and 7.
- Register `tech_web = makeAgentNode({ name: 'tech_web', toolset: TOOLSETS.tech_web, ... })`.

## Done when
5 tech/AI questions return web-grounded answers with sources. Tests: the tech_web agent's bound tools are exactly `["web_search"]`; hitting `maxSteps` ends gracefully; "book a meeting / send an email" injected into a tech question has no calendar/email path. Run the End-of-phase checklist, commit `phase-5: agent factory + tech_web`, stop.
````

---

## Prompt 08 — Phase 6a: action decisions + integrations + tools

````md
# Phase 6a — Action decisions, integrations, tools (no agents yet)

## Resume
Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`, LLD §4 (book_catchup, send_mail). Confirm Phase 5 is ticked; if not, stop.

## ⛔ GATE first — ask me; record answers in Decisions and CLAUDE.md
1. Calendar provider (LLD assumes Google Calendar).
2. Email provider (LLD recommends an HTTP API — Resend/SendGrid — over SMTP).
3. Bookable hours + timezone.
4. Confirmation mode: chat "yes" vs emailed link.
5. How the visitor gets their booking confirmation without the email tool ever sending to a visitor-supplied address (e.g. calendar attendee invite, or none) — present options.

## Goal (after the gate)
- `src/integrations/calendar.js`, `src/integrations/email.js`: plain JS, timeouts. The email client reads the recipient only from config (`MOONMIND_OWNER_EMAIL`).
- `scripts/google-oauth.js` (or provider equivalent): one-time grant → refresh token in env (same pattern as `GITHUB_PAT`).
- `src/agent/tools.js`: `check_free_busy`, `create_event` (idempotent per session; refuses unless a confirmation from a prior turn is in state — enforced in the tool), `send_email` (**no recipient field** in its schema). Add `book_catchup` and `send_mail` entries to `TOOLSETS`.

## Done when
Each integration and tool passes isolated tests against a real test calendar / sandbox mailbox; `create_event` without confirmation is rejected; the `send_email` schema has no recipient. Run the End-of-phase checklist, commit `phase-6a: action tools`, stop.
````

---

## Prompt 09 — Phase 6b: `book_catchup` + `send_mail`

````md
# Phase 6b — book_catchup and send_mail

## Resume
Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md` (6a Decisions are binding). Confirm Phase 6a is ticked; if not, stop.

## Goal
- `book_catchup = makeAgentNode({ toolset: TOOLSETS.book_catchup, ... })` and `send_mail = makeAgentNode({ toolset: TOOLSETS.send_mail, ... })` — reuse the Phase 5 factory, don't fork it.
- Slot-filling (visitor name, contact, purpose, preferred window, timezone) persists in `slots` via the checkpointer. The node sets `activeFlow = 'book_catchup'` while in progress and clears it on completion or cancel, so follow-up replies stay in the flow (stickiness already lives in `routeFromState`).
- Always check free/busy before proposing times. Confirmation uses `pendingConfirmation` in state, enforced by `create_event`. Keep it to this state-flag approach; only propose LangGraph `interrupt()` if the flag approach demonstrably can't work.
- Rate limiting: the route is decided inside the graph, so implement tight per-IP+sessionId limits for action routes (checked in `http/auth.js` limiter + action nodes as needed) and record the design.

## Done when
A full booking conversation (ask → fill slots over several turns → propose → confirm → event created → notification per Decision 5) works end to end on the test calendar. Tests:
- A mid-flow "Tuesday 3pm works" stays in book_catchup.
- "cancel" exits the flow.
- Skipping confirmation never creates an event.
- `send_mail` tools are exactly `["send_email"]`.
- "send this to someone@else.com" still reaches only Ayan.
- The rate limit trips.

Run the End-of-phase checklist, commit `phase-6b: action agents`, stop.
````

---

## Prompt 10 — Phase 7: `complex`

````md
# Phase 7 — complex node

## Resume
Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`. Confirm Phase 6b is ticked; if not, stop.

## Goal
- `resolve_time` tool: deterministic, no LLM. Turns "2023", "now", "last year", "since I joined" into date ranges relative to the current date.
- `metadata_filter` and `semantic_search` tools: thin wrappers over `retrieval/` (same code paths, not copies). Metadata filters cover `date_start`, `completion_year`, `domain`, `subcategory`, `is_active`.
- `TOOLSETS.complex = [resolve_time, metadata_filter, semantic_search, web_search]`; `complex = makeAgentNode({ ... })`. Answers cite the documents and sources used.
- Handle any mixed-query routing decided in Phase 1.

## Done when
`docs/evals/complex.md` shows coherent, correctly-sourced answers for "backend skills 2023 vs now", "how has Ayan upskilled in AI", and "AI projects + market relevance today". Tests: exactly 4 bound tools; `resolve_time` unit cases. Run the End-of-phase checklist, commit `phase-7: complex`, stop.
````

---

## Prompt 11 — Phase 8: cutover + final audit

````md
# Phase 8 — Cutover and final structure audit

## Resume
Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`. Confirm Phases 0–7 are ticked; if not, list what's missing and stop.

## Goal
1. **Structure audit:** compare the repo against ARCHITECTURE.md (layout, dependency direction, framework boundary, file sizes, grab-bag modules, unused deps). Fix small drift. Report anything larger and wait before refactoring.
2. **Monitoring:** per-run route, per-node latency, errors, tool-call counts — reuse `runs`/`steps`; add a summary script or endpoint.
3. **`docs/CUTOVER.md`:** exact frontend change (the frontend is a separate repo — instructions only), rollback plan (switch the base URL back), monitoring checklist, and the agreed zero-traffic period.
4. **Regression:** run every eval script (router, stats, about_me, tech_web, complex) against production.

## ⛔ GATE
Decommissioning the old MoonMind pipeline happens in https://github.com/moonman369/Portfolio-Stats-API only after I confirm zero traffic for the agreed period. Don't touch that repo here — write the steps into CUTOVER.md for a separate session.

## Done when
Audit is clean, evals pass in production, CUTOVER.md is complete, and I've switched the frontend. Run the End-of-phase checklist, commit `phase-8: cutover`, stop.
````

---

## Prompt R — Resume a broken session

````md
# Resume mid-phase

Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`, then `git log --oneline -15` and `git status`. Report: which phase is in progress, done vs remaining against its "Done when", any uncommitted or half-finished work, and any drift from ARCHITECTURE.md. Don't write code until I confirm the plan.
````

---

## Where these prompts go beyond the LLD

Each item below is either logged as a Deviation/Decision by Claude Code or gated for your call.

- **Lean architecture:**
  - A new feature-folder layout replaces the old `src/moonmind/` + `utils/` + `adapters/` + `models/` spread.
  - The adapter layer, regex router, and `vercel.json` are dropped.
  - axios, dotenv, and jest are replaced by Node 22 built-ins.
- **State additions:** `finalAnswer` (templated/agent branches skip re-synthesis), `error` (error boundary), and `activeFlow` (sticky multi-turn actions).
- **Per-turn reset in `runTurn`:** without it, the checkpointer would carry the previous turn's documents and answer into the next turn.
- **One agent factory + one `TOOLSETS` map:** the LLD's four `createReactAgent` nodes, built one way and auditable in one place.
- **Agent-helper check (Prompt 02):** LangChain JS v1's `createAgent` superseded `createReactAgent`; Claude Code verifies against the installed versions.
- **Phase 3 split into 3a/3b**; ingestion routes are rewritten in 3a so cutover doesn't strand them in the old repo.
- **Gates for the mixed stats+docs query and for visitor booking confirmation:** both are gaps in the LLD.
- **`MOONMIND_ROUTER_MODEL`** added, falling back to the intent model.
