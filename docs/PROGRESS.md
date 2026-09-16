# PROGRESS — MoonMind agentic rebuild

The running state of the rebuild. Update the checklist and add a handoff entry at the end
of every phase, before the commit.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done.

---

## Phase checklist

### `[x]` Phase 00 — Bootstrap (docs only)
**Scope:** behavior map of the old repo, data model, target architecture, standing rules,
progress log. No application code.
**Done when:** `docs/OLD_REPO_MAP.md`, `docs/DATA_MODEL.md`, `docs/ARCHITECTURE.md`,
`CLAUDE.md` and `docs/PROGRESS.md` all exist; OLD_REPO_MAP covers every route and every env
var name and has a "Leave behind" list; DATA_MODEL is reconciled against the real
validator. Commit `phase-00: bootstrap docs`.

### `[x]` Phase 0 — Lean skeleton, stats parity, deploy
*Ticked on Ayan's explicit call (2026-09-12) so Phase 1 could start. **Its CI/CD deploy
and live parity run were never executed** — the code is built and unit-tested, but the
"Done when" evidence below does not exist yet. Open items 1-5 in the Phase 0 handoff
entry are still outstanding.*
**Scope:** `src/server.js`, `src/config.js` (zod-validated, fail fast), `src/db.js`,
`src/http/app.js` + `auth.js` + `stats.js`, `/health`. `src/stats/github.js` +
`leetcode.js` rewritten fresh on native fetch with timeouts, keeping the GitHub Mongo cache
and the LeetCode in-memory TTL cache. `/github`, `/leetcode`, `/refresh` with the exact
paths, auth and response shapes from OLD_REPO_MAP. Dockerfile, docker-compose, deploy
workflow, `.env.example`, `npm start` / `npm run dev` via `node --env-file=.env`.
`scripts/parity-check.js`.
**⛔ GATE before the deploy workflow:** VM folder, container name, host port, subdomain —
must not collide with the old API's `~/api-deploy`.
**Done when:** CI/CD deploys; `parity-check.js` shows no diffs for `/leetcode`, `/github`,
`/refresh`; unit tests cover config validation and cache TTL.

### `[~]` Phase 1 — Graph skeleton
*Built; all offline criteria met. `scripts/router-eval.js` has not been run against the
real model — there is no `.env` with an OpenAI key in this working copy.*
**Scope:** install `langchain`, `@langchain/core`, `@langchain/langgraph`,
`@langchain/openai`, a LangGraph Mongo checkpointer. Verify versions, CommonJS `require()`
on Node 22, zod + `.withStructuredOutput()`, and which prebuilt agent helper is current
(`createReactAgent` vs LangChain v1's `createAgent`) — record the choice in Decisions.
Then build `state.js`, `models.js`, `prompts.js`, `nodes/router.js`, `nodes/simple.js`
(`refusal`, `list_capabilities`, stubs for the rest), `nodes/generate.js` (pass-through),
`graph.js` (wiring + `routeFromState` + `ROUTE_TO_NODE` + `withErrorBoundary` + stickiness
+ checkpointer), `index.js` (`runTurn` with per-turn reset, recursion limit, wall-clock
cap), and `src/http/chat.js`.
**⛔ GATE:** the old regex router has a mixed stats + docs path the 8-route taxonomy lacks.
Propose 2–3 options and wait.
**Done when:** offline graph tests (fake models) show every route reaching its node and
then `generate`; a throwing node yields a graceful answer, not a 500; per-turn fields don't
leak across two turns on one `sessionId`; router parse failure hits the fallback.
`scripts/router-eval.js` classifies ≥3 labeled prompts per route (24+) correctly against
the real model. `refusal` and `list_capabilities` return real answers; two turns persist
`messages` in the checkpointer.

### `[~]` Phase 2 — `stats` node
*Built; the offline half of "Done when" is met. `docs/evals/stats.md` is a placeholder —
`scripts/stats-eval.js` needs both services live and has never been run.*
**Scope:** `src/agent/nodes/stats.js` — a plain function (no agent; the router already
decided) calling `src/stats/*` directly based on `slots.which`, writing `statsPayload`.
`generate` synthesizes. No duplicated fetch logic, no HTTP self-calls. If one source fails,
return the other plus a note — don't fail the run.
**Done when:** an offline test with fake stats services covers github / leetcode / both /
one-source-down; 5 live questions are recorded side by side with the old pipeline in
`docs/evals/stats.md` and are consistent with `/github` and `/leetcode`.

### `[~]` Phase 3a — Documents + retrieval modules
*Built. Byte-fidelity is **proven** against the old implementation. The live top-k
comparison needs Mongo + Gemini and has not been run.*
**Scope:** plain JS in `src/documents/` — `taxonomy.js` (the enums + CATEGORY_DOMAIN_MAP,
single source), `schema.js` (one zod document schema + `validateDocument()` enforcing
category↔domain, the subcategory vocabulary, and `embedding.length === 768`),
`embeddings.js` (Gemini `embedContent`, one text per call, timeout, retry honoring
`Retry-After`, plus the two templates and truncation carried over near-verbatim),
`store.js`. `src/http/documents.js` rewrites the ingestion routes on top of them.
LangChain-shaped in `src/retrieval/` — `embedder.js` (a small `Embeddings` subclass
wrapping `documents/embeddings.js`; no stock `@langchain/google-genai` class), `plan.js`,
`search.js` (semantic + keyword + metadata + RRF), `rank.js`, `index.js` (`retrieve()`).
**Done when:** template fidelity — fixtures from the old `embeddingGenerator.js` (5 docs
including a truncation case, 5 queries) match byte for byte. For 5 queries the new semantic
arm returns the same top-k ids as the old code against the live collection.
`validateDocument` rejects a category/domain mismatch and a 767-length embedding. Ingestion
routes pass a smoke test. Offline tests cover the fallbacks.

### `[x]` Phase 3b — `about_me` node
*Ticked on Ayan's explicit call (2026-09-13) so Phase 4 could start, the same way Phase 0
was. **Its eval was never run.** `docs/evals/about_me.md` is still a placeholder and the
"Done when" below — Ayan reading it and agreeing the quality is equivalent — has not
happened. Open item 1 in the Phase 3b handoff entry stands.*
**Scope:** `src/agent/nodes/about-me.js` as an LCEL composition over `retrieval/`:
decompose → fan-out per sub-query (intent → retrieve) → union → rank → rerank → write
`documents`. Keep `DECOMPOSE_ENABLED` / `RERANK_ENABLED` from `config.js`; keep the node
small. `src/agent/nodes/generate.js` gains full synthesis (sanitized docs + optional stats
payload, `response` model, prompt in `prompts.js`), tolerant of sparse documents, history
capped per ARCHITECTURE.md.
**Done when:** `scripts/about-me-eval.js` runs 10 fixed questions (including one mixed
stats+docs question) against the old `/api/v1/moonmind/chat` and the new endpoint, writing
`docs/evals/about_me.md` (answers side by side + retrieved-id overlap), and Ayan agrees the
quality is equivalent. An offline test covers the node with fake retrieval.

### `[x]` Phase 4 — Live event feed
*Ticked on Ayan's explicit call (2026-09-13) so Phase 5 could start, as Phases 0 and 3b
were. Built, covered offline, and watched live end to end for a stats question and an
about_me question. **Two live re-checks remain outstanding** — handoff open items 1 and 2
— both blocked on Atlas refusing TLS handshakes, not on code.*
**⛔ GATE — settled 2026-09-13:** **(a) polling.** No Nginx buffering change to get
wrong in prod, the `password` header survives (EventSource cannot send one), and
resuming after a refresh is just a larger `since`. SSE stays available later over the
same `steps` collection, so nothing here forecloses it.
**Scope:** `agent/index.js` → `streamTurn()` on the compiled graph's `.stream()` /
`.streamEvents()`, no separate instrumentation layer. `agent/runs.js` — `runs` / `steps`
Mongo collections; a step is `runId, seq, node, type (start|end|tool|error), ts, summary`.
Short summaries only: no secrets, no full documents, no raw prompts. Feed endpoints in
`http/chat.js`; `/api/v1/moonmind/chat` unchanged. `public/run-viewer.html` test page;
Nginx location block if SSE. Add `runs.js` to the ARCHITECTURE.md layout.
**Done when:** the test page shows ordered steps ending in the final answer for an
about_me query and a stats query; an erroring node appears as an `error` step followed by a
graceful answer.

### `[x]` Phase 5 — Agent factory + `tech_web`
*Ticked on Ayan's explicit call (2026-09-16) so Phase 6 could start, the same way Phases 0,
3b and 4 were. Built and covered offline. **The live half of the "Done when" — 5 tech/AI
questions returning web-grounded answers — was never run**: no Tavily key in this working
copy and Atlas was down. Open item 1 in the Phase 5 handoff entry stands.*
**⛔ GATE — settled 2026-09-13:** **Tavily** (Ayan's call, matching the LLD). It returns
extracted page content rather than snippets, so `websearch.js` needs no scrape-and-extract
layer and the agent can ground an answer from one call.
**Scope:** `src/integrations/websearch.js` (plain JS, timeout); `src/agent/tools.js` with a
zod-schema'd `web_search` tool and `TOOLSETS = { tech_web: [web_search] }`;
`src/agent/nodes/agents.js` with `makeAgentNode({ name, toolset, prompt, maxSteps })` on
the helper chosen in Phase 1 — seeds from capped recent history, enforces `maxSteps`,
writes back only `finalAnswer` + sources. Tool calls must appear in the Phase 4 feed. The
factory is reused unchanged in 6b and 7.
**Done when:** 5 tech/AI questions return web-grounded answers with sources. Tests: the
`tech_web` agent's bound tools are exactly `["web_search"]`; hitting `maxSteps` ends
gracefully; "book a meeting / send an email" injected into a tech question has no
calendar/email path.

### `[x]` Phase 6 — Re-plan the remaining phases, then measure retrieval
**Scope:** the 8-route taxonomy is superseded — no `complex` node, no `book_catchup`
agent, no calendar/email booking stack. `docs/ARCHITECTURE.md`, this file, and
`CLAUDE.md` rewritten to the 6-label graph (`knowledge` / `stats` / `agent` / `action` /
`refusal` / `capabilities`, diagrammed in ARCHITECTURE.md §4). A debug mode added to
`retrieve()` (per-arm hits, RRF-fused order, post-ranker order, post-rerank order — ids
and titles only) behind the existing password header, plus `MOONMIND_RETRIEVAL_DEBUG` for
the endpoint. `scripts/retrieval-ab.js` runs the Phase 3b question set across four configs
(decompose on/off × rerank on/off), writing `docs/evals/retrieval-ab.md` with corpus size,
per-question/config retrieved ids + rank changes + answers + latency + LLM call count, and
recall-headroom numbers for 3 broad questions.
**⛔ GATE:** present the A/B results; Ayan decides `DECOMPOSE_ENABLED`, `RERANK_ENABLED`
and `k`, recorded in Decisions.
**Done when:** docs match the new plan; debug mode returns per-stage ordering;
`retrieval-ab.md` covers all four configs plus recall headroom; the gate is answered.

### `[ ]` Phase 7 — Router (6 labels) + `knowledge` node
**Scope:** router relabeled to 6 outputs: `knowledge`, `stats`, `agent`, `action`,
`refusal`, `capabilities`. `about_me` and `complex`'s retrieval-only path merge into one
`knowledge` node, reusing the existing decompose → fan-out → rank → rerank pipeline.
`knowledge` may hand off to `agent` once per turn, the budget tracked in
`agentEscalationUsed` (reset per turn) so it can't loop. No other node escalates; `agent`
never escalates back.
**⛔ GATE:** how a mixed stats+knowledge question routes now that `stats_and_docs` has no
slot in the 6-label taxonomy — carried over unresolved from the Phase 1 gate.
**Done when:** router-eval passes on the relabeled fixtures; `knowledge` node tests cover
the merged about_me/complex paths and the escalation budget; a live knowledge question that
needs live/tool grounding escalates to `agent` exactly once.

### `[ ]` Phase 8 — `agent` node (one bounded agent, four tools)
**Scope:** `TOOLSETS.agent = [resolve_time, metadata_filter, semantic_search, web_search]`
— `tech_web`'s `web_search` plus a deterministic `resolve_time` tool (no LLM; turns
"2023", "now", "last year", "since I joined" into date ranges relative to the current
date) and `metadata_filter` / `semantic_search` thin wrappers over `retrieval/` (same code
paths, not copies; filters cover `date_start`, `completion_year`, `domain`, `subcategory`,
`is_active`) — all bound to one `makeAgentNode` call, reused unchanged from Phase 5.
Replaces the separate `tech_web` and `complex` routes.
**Done when:** exactly 4 bound tools; `resolve_time` unit cases; live questions spanning
both web-grounded and portfolio-metadata queries ("backend skills 2023 vs now", "how has
Ayan upskilled in AI", "AI projects + market relevance today") get coherent, sourced
answers, recorded in `docs/evals/agent.md`.

### `[ ]` Phase 9 — `action` node (`book` | `mail`)
**⛔ GATE first — questions for Ayan, recorded in Decisions and CLAUDE.md:** (1)
scheduling-link provider (hosted, e.g. Calendly-style — no `check_free_busy`/`create_event`
tool, no calendar integration); (2) email provider (HTTP API — Resend/SendGrid — over
SMTP, recipient fixed via `MOONMIND_OWNER_EMAIL`, never a tool argument); (3) how a visitor
is shown the link/confirmation; (4) whether either branch needs multi-turn `slots` state at
all, given both are now deterministic and single-turn (ARCHITECTURE.md §5).
**Scope:** `src/integrations/email.js` (plain JS, timeout); one `action` node, no agent,
branching internally on `slots.action` (`'book'` | `'mail'`). `book` returns a templated
scheduling link deterministically — no tool, no confirmation step. `mail` sends via
`send_email` (**no recipient field** in its schema) deterministically. Replaces
`book_catchup`/`send_mail` and the calendar/email tool-and-confirmation stack from the
superseded Phase 6a/6b plan. Tight per-IP + sessionId rate limits for the action route.
**Done when:** both branches covered by offline tests; `send_email`'s schema has no
recipient; "send this to someone@else.com" still reaches only Ayan; the rate limit trips.

### `[ ]` Phase 10 — Structure audit + monitoring
**Scope:** structure audit against ARCHITECTURE.md — layout, dependency direction,
framework boundary, file sizes, grab-bag modules, unused deps; fix small drift, report
anything larger and wait. Monitoring: per-run route, per-node latency, errors, tool-call
counts, reusing `runs`/`steps`, plus a summary script or endpoint.
**Done when:** the audit is clean or its exceptions are explicitly recorded; monitoring
surfaces per-route/per-node stats from real run data.

### `[ ]` Phase 11 — Cutover
**Scope:** `docs/CUTOVER.md`: the exact frontend change (separate repo — instructions
only), rollback plan, monitoring checklist, agreed zero-traffic period. Regression: run
every eval script against production.
**⛔ GATE:** decommissioning the old MoonMind pipeline happens in the old repo only after
Ayan confirms zero traffic for the agreed period. Don't touch that repo from here — write
the steps into CUTOVER.md for a separate session.
**Done when:** evals pass in production, CUTOVER.md is complete, and Ayan has switched the
frontend.

---

## Handoff log

### Phase 00 — Bootstrap docs — 2026-09-10

**Shipped.** The five bootstrap documents. No application code, no dependencies, no
`package.json` yet.

**Files.**
- `docs/OLD_REPO_MAP.md` — behavior map of the old service: all 14 route shapes (9 of them
  reachable on two URLs each), every `src/moonmind/*` module's inputs → outputs → LLM calls
  → fallbacks → feature flags, the `config/vectorConfig.js` enums, `models/vectorDocument.js`,
  `utils/embeddingGenerator.js`, the write path, scripts, deploy setup, all 45 env var names,
  a 40-item Leave-behind list, and 12 divergences from the LLD.
- `docs/DATA_MODEL.md` — the `moonmind_documents_v3` contract, reconciled field by field
  against the DB `$jsonSchema` validator and the request-time zod schema, with 10 recorded
  differences from the brief.
- `docs/ARCHITECTURE.md` — target layout, dependency rules, carry-over policy, graph design
  (simple + robust), HTTP/config/testing/deploy rules, out-of-scope list.
- `CLAUDE.md` — standing rules and the end-of-phase checklist.
- `docs/PROGRESS.md` — this file.

**Env vars.** None added. All 45 read by the old code are catalogued by name in
OLD_REPO_MAP §9; `MOONMIND_ROUTER_MODEL` and `MOONMIND_OWNER_EMAIL` are planned additions
(Phases 1 and 6a) and do not exist yet.

**Setup.** The old repo is cloned read-only at `../Portfolio-Stats-API-ref` at commit
`a0bc0e4` on branch `master`.

**Deviations.** See the Deviations section below — five recorded, all documentation-level.

**Open items.**
1. ⛔ Phase 0 gate: VM folder, container name, host port, subdomain for the new service.
2. ⛔ Phase 1 gate: how mixed stats + portfolio queries route (the 8-route taxonomy has no
   slot for them).
3. Nothing schedules `/refresh` any more — the cron lived in the discarded `vercel.json`.
   Needs a deliberate replacement (host cron / scheduled Actions workflow / in-process
   timer). Raise at the Phase 0 gate.
4. Does any live document carry `metadata.domain === "achievements"`? No category maps to
   it. Check before touching the enum (Phase 3a).
5. Confirm nothing reads `moonmindMetadataIndex` before dropping it (Phase 3a).
6. The keyword retrieval arm is inert in the old code. Revive it with a real text index, or
   drop it — decide in Phase 3a.
7. `.env.example` and `config/vectorConfig.js` give contradictory guidance on the useful
   ranking-boost band. Re-measure before enabling either weight.

**Reference filename note.** The brief refers to `docs/reference/moonmind-agentic-lld.md`
and `moonmind-langchain-feasibility.md` (hyphens); the files in this repo use underscores:
`moonmind_agentic_lld.md`, `moonmind_langchain_feasibility.md`, plus
`moonmind_steps.md` (the prompt playbook). All docs here cite the real names.

---

### Phase 0 — Lean skeleton + stats parity — 2026-09-12

**Shipped.** The HTTP skeleton and both stats endpoints in the ARCHITECTURE.md layout,
with the deploy pipeline. 29 tests pass offline (`node --test`, no network, no keys).

**Files.**
- `src/config.js` — the only reader of `process.env`; `loadConfig(env)` is pure and
  testable, `getConfig()` is the memoized singleton. Deep-frozen, fails fast naming
  every offending variable at once.
- `src/db.js` — one non-strict `MongoClient` (strict rejects `$vectorSearch`, which is
  why the old service kept two), lazy connect with concurrent callers sharing one
  attempt, named collection getters.
- `src/server.js` — validates config → connects to Mongo → **then** listens, plus
  graceful SIGTERM/SIGINT shutdown that also closes the client.
- `src/http/app.js` — middleware, mounting, 404 and the single error handler
  (message + code, never a stack).
- `src/http/auth.js` — `requireRefreshSecret` (constant-time via SHA-256 digests) and
  the `/refresh` rate limiter.
- `src/http/stats.js` — `/github`, `/leetcode/:username`, `/refresh`.
- `src/stats/github.js`, `src/stats/leetcode.js` — framework-free, native `fetch` +
  `AbortSignal.timeout`, every dependency injectable.
- `scripts/parity-check.js` — deep-diffs old vs new JSON, ignoring volatile fields.
- `test/config.test.js`, `test/stats/github.test.js`, `test/stats/leetcode.test.js`.
- `Dockerfile`, `docker-compose.yml`, `.github/workflows/deploy.yml`, `.dockerignore`,
  `.env.example`, `package.json`, `README.md`; `node_modules/` added to `.gitignore`.

**Env vars.** All new, all in `.env.example`. Required: `MONGO_URI`, `GITHUB_PAT`,
`REFRESH_PROFILE`, `REFRESH_SECRET`. Defaulted: `NODE_ENV`, `PORT`, `CORS_ORIGINS`,
`REQUEST_BODY_LIMIT`, `MONGO_DB_NAME`, `MONGO_STATS_COLLECTION`, `MONGO_STATS_DOC_ID`,
`MONGO_TIMEOUT_MS`, `GITHUB_TIMEOUT_MS`, `REFRESH_RATE_LIMIT_WINDOW_MS`,
`REFRESH_RATE_LIMIT_MAX`, `LEETCODE_USERNAME`, `LEETCODE_TIMEOUT_MS`,
`LEETCODE_CACHE_TTL_MS`. `MONGO_STATS_COLLECTION` / `MONGO_STATS_DOC_ID` are new names
for values the old service hardcoded in `mongo.js`.

**Gate answered (deploy identifiers).** VM folder `portfolio-api-v2` (relative to the
deploy user's home), container `portfolio-api-v2`, host port `127.0.0.1:8001` →
container `8000`, subdomain `api.portfolio.moonman.in`. None collide with the old API
(`~/api-deploy`, `portfolio-stats-api`, port `8000`). The path is **not** hardcoded —
the workflow reads `secrets.VM_APP_DIR` and fails loudly when it is unset.

**Deviations.** Six, all recorded below (11–16).

**Open items.**
1. **Not yet verified: the Docker build and CI/CD deploy.** The local Docker daemon was
   not running, so the image was never built here. The workflow runs `npm test` before
   building, so a broken build fails CI rather than shipping.
2. **Not yet verified: `parity-check.js` against live hosts.** It needs both services
   reachable; the new one is not deployed yet. Run it immediately after the first
   deploy — this is the remaining half of Phase 0's "Done when".
3. **VM prerequisites before the first deploy:** create `~/portfolio-api-v2`, copy
   `docker-compose.yml` into it, create its `.env`, and set the repository secrets
   `VM_HOST`, `VM_USER`, `VM_SSH_KEY`, `VM_APP_DIR=portfolio-api-v2`.
4. **Nginx + Certbot for `api.portfolio.moonman.in`** proxying to `127.0.0.1:8001`,
   forwarding `X-Forwarded-For`/`X-Forwarded-Proto` (the app sets `trust proxy 1`).
5. **The workflow deploys on push to `main`;** work so far is on `dev`. Nothing ships
   until that merge.
6. **Still nothing schedules `/refresh`** (carried over from Phase 00 — the cron died
   with `vercel.json`). `/github` serves whatever the last refresh wrote. Options: a VM
   cron calling the endpoint, a scheduled GitHub Actions workflow, or an in-process
   timer. Worth deciding before cutover.
7. **No retries on outbound GitHub/LeetCode calls** — timeouts only. Retries land with
   the Gemini client in Phase 3a, where they are load-bearing; revisit then whether the
   stats clients want the same treatment.

### Phase 1 — Graph skeleton — 2026-09-12

**Shipped.** One `StateGraph` with a structured-output router, nine routes, an error
boundary on every node, a Mongo checkpointer, and the chat endpoint. 79 offline tests
pass (`node --test`, no network, no keys) — 50 of them new.

**Toolchain verified (Step 1).** All CommonJS `require()` calls succeed on Node 24
locally; `@langchain/openai` declares `engines.node >= 22`, matching the `node:22-alpine`
image. Installed: `@langchain/core` 1.2.11, `@langchain/langgraph` 1.4.15,
`@langchain/openai` 1.5.13, `@langchain/langgraph-checkpoint-mongodb` 1.4.1.
zod stays at 3.25.76 — `@langchain/core` declares `zod: ^3.25.76 || ^4`, so our pin is
exactly the supported minimum. `.withStructuredOutput(zodV3Schema)` binds and converts
to correct JSON Schema (enums included), verified directly.

**Files.**
- `src/agent/state.js` — the state schema, `ROUTES`, `ACTION_ROUTES`, `PER_TURN_RESET`
  and `recentMessages`.
- `src/agent/graph.js` — wiring only: `buildGraph`, `routeFromState`, `ROUTE_TO_NODE`,
  `withErrorBoundary`. Nodes and the topic-change threshold are injected.
- `src/agent/models.js` — `getModel(role)` over the six roles, memoized.
- `src/agent/prompts.js` — every system prompt plus the templated capability copy.
- `src/agent/nodes/{router,simple,generate}.js`.
- `src/agent/index.js` — `runTurn` with per-turn reset, recursion limit and wall-clock cap.
- `src/http/chat.js` — `POST /api/v1/moonmind/chat`; `requirePassword` added to `auth.js`;
  `getClient()` added to `db.js` for the checkpointer.
- `scripts/router-eval.js` — 29 labelled prompts, 3-4 per route across all nine.
- `test/agent/{graph,nodes,index}.test.js`.

**Env vars.** 20 new, all in `.env.example`, all defaulted except two.
Required: `OPENAI_API_KEY`, `MOONMIND_PASSWORD`. Defaulted: `OPENAI_BASE_URL`,
`MOONMIND_RESPONSE_MODEL`, `MOONMIND_INTENT_MODEL`, `MOONMIND_ROUTER_MODEL`,
`MOONMIND_DECOMPOSE_MODEL`, `MOONMIND_RERANK_MODEL`, `MOONMIND_AGENT_MODEL`,
`MOONMIND_MODEL_TIMEOUT_MS`, `MOONMIND_ROUTER_MIN_CONFIDENCE`,
`MOONMIND_TOPIC_CHANGE_CONFIDENCE`, `MOONMIND_MAX_MESSAGE_CHARS`,
`MOONMIND_HISTORY_MAX_MESSAGES`, `MOONMIND_RUN_TIMEOUT_MS`, `MOONMIND_RECURSION_LIMIT`,
`MONGO_CHECKPOINT_COLLECTION`, `MONGO_CHECKPOINT_WRITES_COLLECTION`. A check confirms
`.env.example` and `config.js` list exactly the same 36 variables.

**Gate answered (mixed queries).** A ninth route, `stats_and_docs`. Its node composes
the `stats` and `about_me` nodes in Phase 3b; `graph.js` stays a flat star and
`routeFromState` stays a pure map lookup.

**Bug caught by the tests.** When the router itself threw, the error boundary wrote a
graceful answer, but `routeFromState` then fell back to `refusal`, whose node overwrote
it. Fixed by short-circuiting to `generate` whenever `state.error` is set — which is
what ARCHITECTURE §5 specifies ("flow continues to `generate`"). Regression test added.

**Deviations.** Five, recorded below (17-21).

**Open items.**
1. **`scripts/router-eval.js` has not been run against the real model.** It needs a live
   `OPENAI_API_KEY`; there is no `.env` in this working copy. This is the one Phase 1
   "Done when" criterion still outstanding. Run
   `node --env-file=.env scripts/router-eval.js --verbose` and expect 29/29; misses most
   likely sit on the `stats` / `stats_and_docs` and `about_me` / `complex` boundaries.
   Tune `ROUTER_SYSTEM_PROMPT`, not the threshold, if it misclassifies.
2. **Two turns persisting `messages` is proven against `MemorySaver`, not `MongoDBSaver`.**
   The Mongo checkpointer is wired but never exercised — no Mongo in this environment.
   First live chat call will confirm it, and will create the two checkpoint collections.
3. **Phase 5 must reinstall `langchain`** (`npm i langchain`) for `createAgent`. It was
   installed for the Step 1 verification and removed again to keep the dependency list
   free of unused entries.
4. **The chat response shape is not the old one.** New: `{status, data:{sessionId, runId,
   route, answer}}`; old: `{status, data:{summary, documents}}`. `documents` arrives in
   Phase 3b. The frontend mapping belongs in Phase 8's `CUTOVER.md` — a base-URL swap
   alone will not be enough, contrary to ARCHITECTURE §6's assumption.
5. **Everything carried over from Phase 0** — its deploy and parity run (open items 1-5
   there) are still outstanding despite the phase now being ticked.

### Phase 2 — stats node — 2026-09-12

**Shipped.** The `stats` branch and the `stats_and_docs` composite, plus the synthesis
path that turns a stats payload into prose. 96 offline tests pass (17 new).

**Files.**
- `src/agent/nodes/stats.js` — `createStatsNode` (plain function, no agent) and
  `createStatsAndDocsNode` (composes the other two nodes).
- `src/agent/prompts.js` — `buildStatsContext()` plus grounding rules in
  `GENERATE_SYSTEM_PROMPT`.
- `src/agent/nodes/generate.js` — appends the stats context after the history.
- `src/agent/index.js` — `stats` and `stats_and_docs` off the stub list and wired.
- `scripts/stats-eval.js`, `docs/evals/stats.md` (placeholder).
- `test/agent/stats-node.test.js`, `test/agent/prompts.test.js`.

**Env vars.** None added.

**`statsPayload` shape** — the contract `generate` and Phase 4's feed read:

```js
{ requested: "github" | "leetcode" | "both",
  github:   { repos, commits, pulls, stars } | null,
  leetcode: { username, totalSolved, ... }   | null,
  unavailable: [{ source, reason }] }
```

**Deviations.** Three, recorded below (22-24).

**Open items.**
1. **`docs/evals/stats.md` is a placeholder — the live eval has never been run.** This is
   the outstanding half of Phase 2's "Done when". It needs both services reachable and a
   live key. Running it overwrites the file:
   `node --env-file=.env scripts/stats-eval.js --old <old-host> --new <new-host>`.
2. **Run `/api/v1/refresh` on the new service before the eval.** Otherwise
   `/api/v1/github` returns `null`, the node correctly reports GitHub as unavailable, and
   the comparison is meaningless.
3. **Question 5 (the mixed query) will under-answer until Phase 3b.** `stats_and_docs`
   composes `about_me`, which is still a stub, so the portfolio half contributes nothing.
   The stats half is correct and the answer degrades gracefully; expect the old pipeline
   to say more here.
4. **Carried over:** Phase 1's `router-eval` is still unrun, and Phase 0's deploy and
   parity run are still outstanding.

### Phase 3a — Documents and retrieval modules — 2026-09-13

**Shipped.** `src/documents/` (plain JS) and `src/retrieval/` (LangChain-shaped), plus
the rewritten ingestion routes. 230 offline tests pass — 134 new.

**Files.**
- `src/documents/taxonomy.js` — all four vocabularies + `CATEGORY_DOMAIN_MAP`, verified
  equal to the old `vectorConfig.js` enums element-for-element and in order.
- `src/documents/schema.js` — one zod schema plus `validateDocument()`.
- `src/documents/embeddings.js` — the two templates, truncation, and the Gemini client.
- `src/documents/store.js` — CRUD and the re-embed paths.
- `src/http/documents.js` — the six ingestion routes, mounted once.
- `src/retrieval/{embedder,plan,search,rank,index}.js`.
- `scripts/generate-embedding-fixtures.js`, `scripts/retrieval-parity.js`.
- `test/fixtures/embedding-templates.json` — committed, so the suite needs neither the
  reference clone nor the network.
- Tests: `test/documents/{embedding-templates,schema,store}.test.js`,
  `test/retrieval/{plan,search,rank,index}.test.js`, `test/http/documents.test.js`.

**Env vars.** 30 new, all in `.env.example`; a check confirms it and `config.js` list
exactly the same 66 variables. Required: `GEMINI_API_KEY`. The rest default, including
`MONGO_VECTOR_COLLECTION`, `MONGO_VECTOR_INDEX`, `MONGO_VECTOR_FIELD`, the nine
`GEMINI_*` settings, the retrieval tuning block, and the three ingestion settings.

**Byte-fidelity: proven.** `scripts/generate-embedding-fixtures.js` runs the OLD
`utils/embeddingGenerator.js` from the reference clone and writes its output to
`test/fixtures/embedding-templates.json`; the new implementation matches all 10 fixtures
exactly (5 documents including a truncation case at 27,993 chars, and 5 queries). The
fixtures deliberately come from the old code — a fixture the new code generated would
prove nothing.

**Two bugs the tests caught.**
1. `booleanFlag` used zod's `.default(false)`, but zod feeds a default back through the
   inner schema, so a boolean default failed the string enum and **every** config load
   with an unset flag threw. Now the fallback is an argument, not a `.default()`.
2. In `bulkCreateDoc`, spreading `errorBody(error)` overwrote the numeric HTTP status
   with the string `"error"`, so the all-documents-failed path computed a nonsense status
   and returned 500 instead of the shared 400. Key order fixed; test added.

**Deviations.** Seven, recorded below (25-31).

**Open items.**
1. **`scripts/retrieval-parity.js` has never been run** — the "same top-k ids against the
   live collection" criterion. It needs Mongo + Gemini, **and** `npm ci` inside
   `../Portfolio-Stats-API-ref` (the old `vectorSearch` requires the mongodb driver,
   which the clone does not have installed). Read-only; it never writes.
2. **Three files exceed the ~250-line guideline**: `retrieval/search.js` (328),
   `config.js` (297), `retrieval/rank.js` (251). See Deviation 31 — I did not split them,
   and each has a reason. Worth a look at the Phase 8 structure audit.
3. **The keyword arm is reachable but off** (`MOONMIND_KEYWORD_ENABLED=false`). Decide in
   3b whether to enable it; note it is a regex collection scan, as there is no text index.
4. **`achievements` is still unreachable** and `moonmindMetadataIndex` is still assumed
   dead — both need the live-collection check from Phase 00 open items 4 and 5 before
   anything is removed.
5. **Carried over:** Phase 0's deploy and parity run, Phase 1's `router-eval`, Phase 2's
   `stats-eval` — all still unrun.

### Phase 3b — about_me node — 2026-09-13

**Shipped.** The `about_me` branch and full answer synthesis. 248 offline tests pass
(18 new). The mixed `stats_and_docs` route is now complete — it returns stats **and**
documents in one answer, closing Phase 2 open item 3.

**Files.**
- `src/agent/nodes/about-me.js` (~88 lines) — an LCEL `RunnableSequence` of three named
  steps that delegates the pipeline to `retrieval/`.
- `src/agent/nodes/generate.js` — full synthesis from sanitized documents plus an
  optional stats payload.
- `src/agent/prompts.js` — `GENERATE_SYSTEM_PROMPT` rewritten to the old
  responseGenerator's rules, plus `buildDocumentContext`, `buildDateContext` and
  `NO_DOCUMENTS_CONTEXT`.
- `src/agent/index.js` — `about_me` off the stub list and wired.
- `src/http/chat.js` — the response now carries `data.documents`.
- `scripts/about-me-eval.js`, `docs/evals/about_me.md` (placeholder).
- `test/agent/about-me.test.js`.

**Env vars.** None added; `.env.example` and `config.js` still list the same 66.

**Verified end to end with fakes.** A full graph run confirms `about_me` writes
`documents`, the sanitized view reaches the prompt, and neither `impact_score` nor
`summary_for_embedding` leaks into the model's context. The `stats_and_docs` run carries
three context blocks — date, documents, stats.

**Deviations.** Three, recorded below (32-34).

**Open items.**
1. **`docs/evals/about_me.md` is a placeholder — the eval has never been run.** This is
   the outstanding "Done when", and it ends with **your** judgement, not a script's:
   `node --env-file=.env scripts/about-me-eval.js --old <old-host> --new <new-host>`.
   Read Q9 (nothing should match — the answer must stay helpful, not refuse) and Q10
   (both halves present) especially.
2. **`MOONMIND_DECOMPOSE_ENABLED` and `MOONMIND_RERANK_ENABLED` are still off**, matching
   the old service's defaults so the eval compares like with like. Question 8 is the
   multi-part case to re-run with decomposition on once the baseline is agreed.
3. **The chat response shape still differs from the old one.** It now carries
   `data.documents` in the old shape, but the answer is `data.answer` where the old was
   `data.summary`. The frontend mapping belongs in Phase 8's `CUTOVER.md`.
4. **Carried over:** Phase 0's deploy and parity run, Phase 1's `router-eval`, Phase 2's
   `stats-eval`, Phase 3a's `retrieval-parity` — four scripted checks, none run.

### Phase 4 — Live event feed — 2026-09-13

**Shipped.** A live step feed over the graph's own event stream, behind
`POST /api/v1/moonmind/runs` + `GET /api/v1/moonmind/runs/:runId?since=`, with a
dependency-free viewer at `/run-viewer.html`. 289 offline tests pass (28 new).
`/api/v1/moonmind/chat` is untouched in shape and behaviour.

**Files.**
- `src/agent/runs.js` (~245 lines, new) — the `runs`/`steps` collections, and **the one
  place that decides what a step may carry**. `summarizeUpdate` is a field whitelist, not
  a serializer: counts, lengths and enum values only.
- `src/agent/index.js` — `streamTurn()` (an async generator over
  `compiledGraph.streamEvents({ version: "v2" })` that yields steps and returns the turn)
  and `startRun()` (opens the run, then drives it in the background). `runTurn` and
  `streamTurn` now share `buildInvocation()` and `toTurn()`, so the thread key, per-turn
  reset, recursion limit and wall-clock cap cannot drift apart.
- `src/http/chat.js` — the two feed endpoints. The agent and run-store modules are now
  imported as namespaces so tests can replace one function.
- `src/http/app.js` — `express.static` on `public/`, mounted last, indexes off.
- `src/http/openapi.js` — `RunAccepted`, `RunStep`, `RunFeed` and both paths.
- `src/config.js` — three new vars.
- `src/agent/nodes/about-me.js` — one-line fix, see Deviations.
- `public/run-viewer.html` (new, gated — see Deviations).
- `Dockerfile` — copies `public/`.
- `test/agent/runs.test.js`, `test/agent/stream.test.js`, `test/http/runs.test.js`.

**Env vars.** Three added, all optional with defaults, bringing the total to 69:
`MONGO_RUNS_COLLECTION` (`moonmind_runs`), `MONGO_RUN_STEPS_COLLECTION`
(`moonmind_run_steps`), `MOONMIND_RUN_RETENTION_DAYS` (`7`). Both collections are
TTL-indexed on that retention: these are debug traces, not durable data, so watching runs
cannot grow the database without bound.

**No new dependencies.** The feed is `streamEvents` plus the Mongo driver already present.

**What a step carries.** `{ runId, seq, node, type, ts, summary }`, where `type` is
`start | end | tool | error`. The summary is derived — `route=about_me confidence=0.80`,
`documents=10`, `stats=github+leetcode`, `answer=483 chars`. Never a retrieved document,
never a tool's arguments, never a prompt. Slots contribute their **key names** only, since
slot values are visitor content. The run document holds the final answer and the
`documentIds` that grounded it, not the documents themselves — `/chat` is where those
live. `test/agent/runs.test.js` asserts the negatives, not just the formatting.

**Verified live** against the real graph, real models and real Atlas:
- A stats question routed to `stats_and_docs`, six ordered steps, ending in a correct
  answer (100 repos / 468 LeetCode problems) consistent with `/github` and `/leetcode`.
- An about_me question routed to `about_me`, ending in a grounded answer citing MoonMind
  AI and BlinkMart.

**Verified offline** (`test/agent/stream.test.js`, against a real compiled graph with fake
nodes): ordered `start`/`end` per node; a throwing node yields an `error` step **followed
by `generate` and a graceful answer**, not a failed run; a tool call yields exactly one
`tool` step; anonymous inner runnables are dropped; a graph-level failure closes the run
as `failed` rather than rejecting into an unhandled promise.

**Deviations.** Three, recorded below (35-37).

**Open items.**
1. **Re-watch an about_me run live.** The first live run exposed a duplicate-step bug
   (below, deviation 36); it is fixed and proven against the real `createAboutMeNode` and
   in tests, but Atlas began refusing TLS handshakes
   (`tlsv1 alert internal error`, SSL alert 80) before the fixed feed could be watched
   live. Nothing suggests a code cause — the same build connected fine minutes earlier.
   Re-run: `node --env-file=.env src/server.js`, open `http://127.0.0.1:8000/run-viewer.html`,
   ask an about_me question, and confirm one `about_me` start/end pair wrapping
   `about_me.prepare` / `about_me.retrieve` / `about_me.to_state`.
2. **Watch an erroring node live.** Covered offline and it is the sharper half of the
   "Done when". The cheap way to force it is a deliberately wrong `GEMINI_API_KEY` on a
   throwaway run — `about_me` fails in the embedder, and the feed should show
   `about_me:error` then `generate:end` with the graceful answer.
3. **The feed is unauthenticated beyond the shared password**, exactly like `/chat`, and
   `POST /runs` is not rate-limited. A visitor who knows the password can start runs
   faster than they can read them, and each one costs model calls. Phase 6a is already
   bringing "tight rate limiting" for the action routes — the limiter belongs on `/runs`
   at the same time, not before.
4. **Carried over, now five unrun checks:** Phase 0's deploy and parity run, Phase 1's
   `router-eval`, Phase 2's `stats-eval`, Phase 3a's `retrieval-parity`, and Phase 3b's
   `about-me-eval` — the last of which is the gate on Phase 3b actually being done. The
   `.env` in this working copy is now fully populated, so every one of them is runnable;
   the reason recorded against them in earlier phases ("no credentials here") has expired.
5. **`npm test` is broken and has been since Phase 0** — `package.json` says
   `nodemon --test`, not `node --test`, and `nodemon` is not a dependency. Every phase has
   been verified with `node --test` directly. One-word fix, left alone here because it is
   outside Phase 4's scope; say the word.
6. **Structure check: two files now exceed the ~250-line guideline** —
   `src/agent/index.js` (295, was 110) and `src/agent/runs.js` (273). Deliberately not
   split: the phase brief and ARCHITECTURE.md §1 both place `runTurn`/`streamTurn`/
   `startRun` in `index.js`, and `runs.js` is one responsibility (the feed's storage and
   its redaction rules) where splitting would separate the whitelist from the writer that
   depends on it. That makes **six** files over the guideline. As the Phase 3a/OpenAPI
   note already said, six is a pattern rather than an exception — the Phase 8 structure
   audit should either move the number or split in earnest, not keep granting one-offs.

---

### Phase 5 — Agent factory + tech_web — 2026-09-13

**Shipped.** `makeAgentNode`, the `web_search` tool, the `TOOLSETS` map, and `tech_web`
as the first live agent route. 322 offline tests pass (30 new). `tech_web` is off the
stub list; `complex`, `book_catchup` and `send_mail` remain stubbed.

**Files.**
- `src/integrations/websearch.js` (~120 lines, new) — Tavily on native `fetch`, one
  timeout, no retries, plain JS with no LangChain import.
- `src/agent/tools.js` (~85 lines, new) — the `web_search` tool and
  `TOOLSETS = { tech_web: [web_search] }`.
- `src/agent/nodes/agents.js` (~135 lines, new) — `makeAgentNode`.
- `src/agent/prompts.js` — `TECH_WEB_SYSTEM_PROMPT`, `buildTruncatedAnswer`,
  `AGENT_NO_ANSWER`.
- `src/agent/index.js` — `tech_web` registered; `owningNode()` added to the feed.
- `src/agent/runs.js` — `describeToolOutput` understands a ToolMessage.
- `src/config.js` — five new vars.
- `test/agent/agents.test.js`, `test/integrations/websearch.test.js`, plus one new case
  in `test/agent/stream.test.js`.
- Ten existing test files gained `TAVILY_API_KEY` in their env preamble; `config.test.js`
  gained it in `MINIMAL_ENV` and in the required-vars assertion.

**One new dependency: `langchain` (1.5.11).** Pre-justified by the Phase 1 decision and
its open item 3 — `createAgent` lives there, and LangGraph's `createReactAgent` carries a
`@deprecated` pointing at it. Nothing else was added: Tavily is called with `fetch`, not
with `@langchain/tavily`, because `integrations/` is framework-free by ARCHITECTURE §2 and
the client is ~120 lines either way.

**Env vars.** Five added, bringing the total to 74. **`TAVILY_API_KEY` is required** —
the same treatment `OPENAI_API_KEY` and `GEMINI_API_KEY` get, because `tech_web` is a live
route from now on and a missing key should stop the boot rather than reach a visitor as a
broken answer. `TAVILY_BASE_URL`, `TAVILY_TIMEOUT_MS` (15s), `TAVILY_MAX_RESULTS` (5),
`TAVILY_SEARCH_DEPTH` (basic) and `MOONMIND_AGENT_MAX_STEPS` (4) all have defaults.

**Tool isolation, as built.** `TOOLSETS` is the only place a route's tools are named, and
`makeAgentNode` binds exactly what it is handed. `tech_web` therefore has no calendar or
email tool in memory, never mind in a schema. The prompt *also* says it cannot book or
email, but that is courtesy to the visitor, not the control: the test that matters drives
a model which explicitly calls `send_email` and `create_calendar_event`, and asserts
nothing executes and the run still answers.

**maxSteps.** `modelCallLimitMiddleware({ runLimit, exitBehavior: "end" })`. Its own exit
appends a library notice ("Model call limits exceeded…") as the final message, which is
not visitor-facing copy, so the node detects truncation by **counting tool rounds** rather
than matching that wording — with a limit of N, spending all N calls on tool requests means
the call that would have written the answer never happened. On truncation the node returns
`buildTruncatedAnswer(sources)`, which still hands over the links it did find.

**Verified offline** (no network, no API key; `FakeToolCallingModel` plus an injected
search): bound tools are exactly `["web_search"]`; an injected "book a meeting and send an
email" executes nothing; `maxSteps` ends gracefully with sources and without the library's
notice; sources accumulate across several searches in order; the node writes back only
`finalAnswer` and `searchResults` and never the agent's scratchpad; every Tavily failure
mode (timeout, 401/403, 429, 5xx, malformed body) maps to a distinct code, and the API key
never appears in an error message.

**Deviations.** Three, recorded below (38-40).

**Open items.**
1. **The "Done when" live check has not run: 5 tech/AI questions returning web-grounded
   answers with sources.** It is blocked on two things, neither of them code:
   **(a) there is no `TAVILY_API_KEY`** — the `.env` in this working copy has none, and
   getting one is yours to do (tavily.com, free tier); **(b) Atlas is still refusing TLS
   handshakes**, so the graph cannot compile its checkpointer. Once both are sorted:
   `node --env-file=.env src/server.js`, then `/run-viewer.html` and ask five tech
   questions — the feed should show `tech_web:tool` steps and the answer should carry
   markdown source links.
2. **`TAVILY_API_KEY` is now required, so the next deploy fails without it.** Set it in
   the VM's `~/portfolio-api-v2/.env` **before** pulling the next image, or the container
   will not boot. This is the one change in this phase that can break a running service.
3. **Tavily's free tier is ~1,000 credits/month and nothing meters it.** `tech_web` is
   reachable by anyone with the shared password, at up to `MOONMIND_AGENT_MAX_STEPS`
   searches per question. Phase 6a's "tight rate limiting" should cover `/chat` and
   `/runs`, not only the action routes — this is the second phase to raise it (Phase 4
   open item 3).
4. **Carried over, still five unrun checks:** Phase 0's deploy and parity run, Phase 1's
   `router-eval`, Phase 2's `stats-eval`, Phase 3a's `retrieval-parity`, Phase 3b's
   `about-me-eval`, plus Phase 4's two live re-checks. All of them need Atlas back.
5. **`npm test` is still broken** (`nodemon --test`, and `nodemon` is not a dependency).
   Unchanged from Phase 4; `node --test` is what was run.

---

### Phase 6 — Re-plan + retrieval measurement — 2026-09-16

**Shipped.** The docs rewritten to the 6-label graph, a per-stage retrieval debug trace,
and a live A/B eval over the real 42-document corpus. 339 offline tests pass (1 changed).
Phase 5 ticked on Ayan's explicit call at the start of this session — its live eval was
still unrun, same pattern as Phases 0/3b/4.

**Files.**
- `docs/ARCHITECTURE.md` — §4's route taxonomy and state-field list replaced by the
  6-label graph (`knowledge`/`stats`/`agent`/`action`/`refusal`/`capabilities`); §5's
  stickiness and side-effects sections updated to match (no calendar tool, no
  confirmation step).
- `docs/PROGRESS.md` — this file: the remaining phase checklist renumbered 7-11 to the
  new scopes; Phase 6 deviations recorded; three Decisions appended.
- `CLAUDE.md` — the Guardrails "calendar writes" line replaced with the `action` node's
  actual shape (no calendar tool).
- `src/config.js` — `MOONMIND_RETRIEVAL_DEBUG`, `retrieval.debugEnabled`.
- `src/retrieval/search.js` — `searchAllArms` also returns `armHits` (id/title/score per
  arm), always computed (cheap — the hits are already in memory), surfaced only when asked.
- `src/retrieval/index.js` — `retrieve({ debug: true })` returns `.debug`: `arms`, `fused`
  (RRF order, sorted by `rrf_score` for readability), `ranked`, `reranked`. Exported
  `buildDebugTrace` for reuse (`scripts/retrieval-ab.js`).
- `src/agent/state.js` — `retrievalDebug` state field, per-turn reset.
- `src/agent/nodes/about-me.js`, `src/agent/nodes/stats.js` — pass `debug` through to
  `retrieve()` and carry `retrievalDebug` onto state (including through
  `stats_and_docs`).
- `src/agent/index.js` — `toTurn()` carries `retrievalDebug`.
- `src/http/chat.js` — `POST /chat` adds `retrievalDebug` as an extra field, only when
  `MOONMIND_RETRIEVAL_DEBUG` is on; absent entirely otherwise. Not wired into
  `POST /runs`/`GET /runs/:runId` — see Deviation 42.
- `scripts/retrieval-ab.js` (new) — calls `retrieve()` and `generate` directly, in
  process, with per-config overrides; counts real LLM calls via a wrapping proxy rather
  than guessing from flags.
- `docs/evals/retrieval-ab.md` (new) — the live results (see below).
- `.env.example` — `MOONMIND_RETRIEVAL_DEBUG` documented.
- `test/agent/about-me.test.js` — updated for the new `retrievalDebug` key.

**Env vars.** One added, bringing the total to 79: `MOONMIND_RETRIEVAL_DEBUG` (default
`false`).

**The eval, run live** against the real 42-document corpus, real OpenAI and Gemini:
9 questions (Phase 3b's about_me set, minus the mixed stats+docs one) × 4 configs, plus 3
broad recall-headroom questions. Full per-question/config detail — retrieved ids, what the
reranker moved, the answer, latency, LLM call count — plus the recall table is in
`docs/evals/retrieval-ab.md`. Findings and the resulting Decisions are above; not repeated
here.

**Deviations.** Two, recorded above (41-42): the taxonomy supersession, and the debug
trace's scope (not wired into the run feed).

**Open items.**
1. **`k` is only recorded as a Decision here, not applied.** The gate said "change no
   defaults," so `config.js` still defaults `MOONMIND_FINAL_DOCUMENT_LIMIT` to 10. Ayan
   applies `MOONMIND_FINAL_DOCUMENT_LIMIT=15` (and `MOONMIND_RERANK_ENABLED=true`) to the
   deployed `.env`; whether the *default* in `config.js` should also move is for whichever
   phase next touches retrieval config to decide, not assumed here.
2. **The router-relabeling gate carried into Phase 7** (mixed stats+knowledge routing,
   since `stats_and_docs` has no slot in the 6-label taxonomy) is unresolved by this
   session — it is a re-statement of the still-open Phase 1 gate, not a new one.
3. **Carried over, unchanged:** the five unrun live checks from Phase 5's handoff (Phase
   0's deploy and parity run, Phase 1's `router-eval` — actually run out-of-band on
   2026-09-16, see the entry above, so this is now four — Phase 2's `stats-eval`, Phase
   3a's `retrieval-parity`, Phase 3b's `about-me-eval`), Phase 4's two live re-checks, and
   `npm test` being broken (`nodemon --test`).

---

---

## Decisions

*(One line per decision: what was decided, by whom, and why. Append as they are made.)*

- **2026-09-10 — Documentation-only Phase 00.** No `package.json`, no dependencies, no
  scaffolding. Dependency choices belong to the phase that first needs them, so each one
  can be justified against a real requirement.
- **2026-09-10 — Code wins over the LLD on every data-model conflict.** The LLD is the
  plan; the old code is the ground truth for behavior that must be preserved. Every
  difference is recorded rather than silently resolved (DATA_MODEL §7, OLD_REPO_MAP §11).
- **2026-09-12 — Express 5, not 4.** Express 5 forwards rejected promises from async
  handlers to the error handler by itself. On Express 4 every async route needs its own
  try/catch, or a shared `asyncHandler` wrapper — which is exactly the kind of
  grab-bag helper ARCHITECTURE.md §2 forbids. Verified end to end: a rejected handler
  returns `500 {status, message, code}` with no stack in the body.
- **2026-09-12 — zod stays on v3 (`^3.25.76`).** Matches the old repo, and Phase 1 has
  to verify zod against `.withStructuredOutput()` in the installed `@langchain/core`;
  changing major versions now would confound that check. Revisit in Phase 1.
- **2026-09-12 — Phase 0 dependencies: `express`, `cors`, `express-rate-limit`,
  `mongodb`, `zod`. Five, all used.** Dropped from the old set: `axios` (native
  `fetch` + `AbortSignal.timeout`), `dotenv` (`node --env-file`), `memory-cache` (a
  9-line TTL `Map`), `nodemon` (`node --watch`), `uuid`, `swagger-jsdoc`,
  `swagger-ui-express`, `@types/node`. No dev dependencies at all.
- **2026-09-12 — `config.js` is lazy, not eager.** `loadConfig(env)` is pure; the
  singleton is built on first `getConfig()`. An eager parse at import time would make
  `require`ing any module fail without a full environment, which breaks ARCHITECTURE
  §8's "tests run with no network and no API keys". `server.js` calls `getConfig()`
  first, so boot still fails fast.
- **2026-09-12 — Domain modules throw `code`-carrying plain Errors; `http/app.js` owns
  the code→status map.** Keeps `stats/` (and later `documents/`) framework-free and
  free of HTTP semantics, per the dependency direction.
- **2026-09-12 — `scripts/` may read `process.env`.** The "`src/config.js` is the only
  reader" rule governs the application. `parity-check.js` takes `REFRESH_SECRET` from
  the environment rather than a CLI flag, so the secret never lands in shell history or
  a process listing.
- **2026-09-12 — The VM path is never written into the repo.** The workflow reads
  `secrets.VM_APP_DIR` with no fallback and exits 1 when it is unset, rather than
  guessing as the old workflow did. Note that a `~` inside a secret would not be
  expanded, so the agreed value is the home-relative `portfolio-api-v2`.
- **2026-09-12 — CI runs `npm test` before building the image.** The old workflow built
  and deployed without ever running the tests.
- **2026-09-16 — `MOONMIND_RERANK_ENABLED=true`** (Ayan, at the Phase 6 gate, from
  `docs/evals/retrieval-ab.md`). The reranker consistently reordered 3-10 of the top 10
  candidates and, on the questions that matter — "strongest skills, and which projects
  demonstrate them" and the RAG-projects question — it tied skills to the projects that
  demonstrate them and surfaced relevant documents RRF alone left outside top-10, for one
  extra LLM call and +0.5-1s.
- **2026-09-16 — `MOONMIND_DECOMPOSE_ENABLED` stays `false`** (Ayan, same gate). It cost
  2-3 extra LLM calls and ~1.5s on every question, including the 7 of 9 that were
  single-part, for a top-10 and answer nearly identical to decompose-off. Its one clear win
  (the multi-part skills question) was already fixed by the reranker alone.
- **2026-09-16 — `MOONMIND_FINAL_DOCUMENT_LIMIT` (k) raised 10 -> 15** (Ayan, same gate).
  Recall-headroom measurement found 2 of 3 broad questions have more genuinely relevant
  documents (11-12) than k=10 returns, and the corpus is small enough (42 documents) that
  the extra context is cheap. This phase changed no defaults itself — Ayan applies the new
  value to the deployed `.env`; Phase 7 is where `config.js`'s default would move if that
  is what this decision is later understood to mean for a clean checkout.

---

## Deviations from LLD

*(Anything this rebuild does differently from `docs/reference/moonmind_agentic_lld.md`,
with the reason. Append as they arise.)*

1. **Lean feature-folder layout replaces the old module spread.** The LLD describes
   behavior per old file (`pipeline.js`, `intentExtractor.js`, `adapters/…`); this repo
   organizes by feature (`documents/`, `retrieval/`, `agent/`, `stats/`, `integrations/`)
   with no `utils/`, `adapters/` or `lib/`. *Why:* the old repo's two parallel hierarchies
   are a named pain point; the brief requires max 3 levels under `src/` and named homes for
   shared code.
2. **Three state fields added** beyond LLD §3: `finalAnswer` (so templated and agentic
   branches skip re-synthesis in `generate`), `error` (the error boundary's output), and
   `activeFlow` (sticky multi-turn actions). *Why:* the LLD's state has no way to express
   "this branch already produced the answer", "this node failed but the run continues", or
   "we are mid-booking".
3. **Per-turn reset in `runTurn`.** Not in the LLD. *Why:* without it the checkpointer
   carries the previous turn's `documents`, `statsPayload` and `finalAnswer` into the next
   turn on the same `sessionId`.
4. **One `makeAgentNode` factory + one `TOOLSETS` map** instead of four independently
   authored `createReactAgent` nodes. *Why:* the LLD's guardrail — "enforced by what's
   passed to `createReactAgent`, not by prompting" — is only auditable if there is one
   place to read it.
5. **`MOONMIND_ROUTER_MODEL` added**, falling back to the intent model. *Why:* the LLD
   names four per-call-site model vars for the old pipeline's four call sites; the router
   is a new fifth call site and gets the same independence.
6. **Phase 3 is split into 3a (documents + retrieval + ingestion) and 3b (`about_me`
   node),** and Phase 6 into 6a (decisions + integrations + tools) and 6b (the two action
   agents). *Why:* ingestion is rewritten in 3a so cutover doesn't strand it in the old
   repo, and the 6a gate questions must be answered before any agent is built.
7. **Two gaps in the LLD are gated rather than assumed:** how mixed stats + portfolio
   queries route (Phase 1), and how a visitor receives a booking confirmation without the
   email tool ever addressing a visitor-supplied address (Phase 6a).
8. **The agent-helper choice is verified, not assumed.** The LLD names LangGraph's
   `createReactAgent`; LangChain JS v1's `createAgent` superseded it. Phase 1 checks the
   installed packages and records the choice.
9. **`ALLOWED_SUBCATEGORIES` is 78 values, not "~90".** Counted from the code.
10. **DB-side schema validation is treated as unavailable.** The LLD calls the validator
    "enforced at the DB level"; the old code catches a `collMod` `Unauthorized` and
    continues, and a comment states the live collection has no validator. Application-side
    `validateDocument()` is the real gate, and it adds the `embedding.length === 768` check
    that no existing layer performs.
11. **`/refresh` no longer has a `useWorker` mode.** *Why:* the old worker path is dead —
    `refresh_worker.js`'s `parentPort.on("message")` handler is commented out, so
    `useWorker=true` returned "Refresh worker has been triggered successfully..." while
    refreshing nothing, and a `Worker` was constructed on every request and never
    terminated. The refresh now always runs inline, which is what the old default already
    did. The parameter is simply ignored. (Leave-behind §10.6.)
12. **LeetCode difficulty buckets are looked up by `difficulty`, not by array position.**
    *Why:* the old code assumed `[0..3]` = All/Easy/Medium/Hard and never checked the
    field, so a reordered response would silently swap the numbers. Identical output for
    the normal response, with a test covering the reversed case. (Leave-behind §10.37.)
13. **`/leetcode/:username` returns 404 for an unknown user and 502 for an upstream
    failure**, where the old service returned 500 for both. *Why:* the old handler let a
    `TypeError` from destructuring `matchedUser: null` become a generic 500. Parity is
    unaffected on the happy path, which is what `parity-check.js` compares.
14. **Error responses carry a `code` and never a stack trace.** *Why:* the old service
    embedded `serializeError()` — including `stack` — in its 400/500 bodies.
    (Leave-behind §10.17.)
15. **`GET /` returns a small JSON identity document instead of redirecting to
    `/api/docs`.** *Why:* Swagger is on the Leave-behind list (§10.8), so there is no
    `/api/docs` to redirect to; a bare 404 on the subdomain root reads as an outage.
16. **`/refresh` is rate limited (5 per 15 min, before the secret check) and the rejected
    secret is never logged.** *Why:* the endpoint paginates every repository on the
    profile, and the old handler `console.debug`'d `req.query` on a failed auth, writing
    the attempted secret to the logs. (Leave-behind §10.18.)

### Phase 1 decisions — 2026-09-12

- **Agent helper: `createAgent` from `langchain`, not LangGraph's `createReactAgent`.**
  Settled by the shipped types, not by guesswork —
  `@langchain/langgraph/dist/prebuilt/react_agent_executor.d.ts` carries
  ``@deprecated `createReactAgent` has been moved to the langchain package. Update your
  import to `import { createAgent } from "langchain";```. `makeAgentNode` (Phase 5) uses
  `createAgent`. This confirms Phase 00's Deviation 8.
- **zod stays on v3 (3.25.76).** `@langchain/core` 1.2.11 declares
  `zod: "^3.25.76 || ^4"`, so the Phase 0 pin is exactly the supported minimum.
  `.withStructuredOutput()` was verified against it. No reason to move to v4 now.
- **Mixed stats+docs queries get a ninth route, `stats_and_docs`** (Ayan, at the Phase 1
  gate). The alternative — a `needsDocuments` flag plus a second conditional edge — would
  have put a branch point outside `routeFromState` and made `graph.js` harder to read.
  The node composes the existing `stats` and `about_me` nodes, so no logic is duplicated.
- **Low-confidence router behaviour: redirect to `about_me`, keep the real confidence.**
  Below `MOONMIND_ROUTER_MIN_CONFIDENCE` (0.5) the turn is routed to `about_me` rather
  than refused, because the old pipeline's response prompt explicitly forbids answering
  with a generic refusal, and `about_me` is grounded in retrieved documents and has no
  side effects. `routeConfidence` still reports what the model actually said, so the
  eval script and the Phase 4 feed see the truth. The same rule doubles as the guard that
  keeps a guess from ever reaching `book_catchup` or `send_mail`.
- **A router parse/call failure uses the same destination**, with `routeConfidence: 0`
  and empty slots — one deterministic fallback rather than two behaviours to reason about.
- **Flow stickiness is broken by two signals only:** the router setting
  `cancelsActiveFlow` (an explicit "cancel"/"never mind"), or a classification into a
  different route at or above `MOONMIND_TOPIC_CHANGE_CONFIDENCE` (0.8). Otherwise a
  slot-filling reply stays in the flow regardless of how it classifies.
- **`cancelsActiveFlow` lives in `slots`, not as a new state field.** `slots` already
  exists for router-extracted parameters, and the LLD's state list is long enough.
- **The router schema is flat** (`route`, `confidence`, `which`, `cancelsActiveFlow`)
  rather than nesting `which` under `slots`. Models fill flat objects far more reliably;
  `which` is lifted into `slots` by the node, and dropped entirely for non-stats routes.
- **`buildGraph` uses loops over `ROUTES`** rather than nine literal `.addNode` calls.
  ARCHITECTURE §4 requires the file to fit on one screen and it does (~95 lines); a loop
  also makes it structurally impossible for a route to exist without a node, which
  `test/agent/graph.test.js` asserts.
- **`POST /api/v1/moonmind/chat` accepts `prompt` as an alias for `message`.** The phase
  prompt specifies `{sessionId, message}`; ARCHITECTURE §6 wants the frontend cutover to
  be a base-URL change. The alias satisfies both for the request. The response shape
  still differs — see Phase 1 open item 4.
- **A missing `sessionId` starts a new thread rather than erroring.** There is no visitor
  identity behind the shared password, so the server minting one is the only sensible
  behaviour; it is returned in the response so the client can continue the thread.
- **`langchain` was installed for the Step 1 verification, then removed.** It is unused
  until Phase 5, and CLAUDE.md's end-of-phase checklist forbids unused dependencies.
  This trims the phase prompt's install list by one package, deliberately.

## Phase 1 deviations from LLD

17. **A ninth route, `stats_and_docs`,** beyond LLD §2's eight. *Why:* the old regex
    router has a mixed stats+portfolio state the taxonomy cannot express, and dropping it
    would be a visible regression at cutover. Decided at the Phase 1 gate.
18. **`cancelsActiveFlow` is carried in `slots`.** *Why:* `routeFromState` needs a signal
    to break out of a sticky flow, and ARCHITECTURE §5 requires that behaviour; `slots`
    is already the channel for router-extracted values.
19. **A router failure routes straight to `generate`, bypassing the branch.** *Why:*
    otherwise the fallback branch node overwrites the error boundary's graceful answer.
    ARCHITECTURE §5 already says flow "continues to `generate`"; this makes it literal.
20. **`MOONMIND_AGENT_MODEL` added** (falls back to `MOONMIND_RESPONSE_MODEL`). *Why:*
    ARCHITECTURE §4 lists `agent` among `getModel`'s roles, but the LLD names only the
    four env vars belonging to the old pipeline's four call sites. This gives the agent
    role the same independence as the rest.
21. **`OPENAI_BASE_URL` now includes the version segment** (`https://api.openai.com/v1`).
    *Why:* `ChatOpenAI` takes a full base URL, whereas the old hand-rolled adapter
    appended `/v1` itself. Carrying the old value across verbatim would produce
    `/v1/v1/chat/completions`. Flagged in `.env.example`.

### Phase 2 decisions — 2026-09-12

- **The stats node writes only `statsPayload`; `generate` writes the answer.** The phase
  brief says "`generate` synthesizes", and keeping the branch free of prose is what lets
  `stats_and_docs` reuse it — a mixed question must be answered once, from both halves,
  not twice.
- **`Promise.allSettled`, not `Promise.all`, for the two sources.** A dead LeetCode must
  not cost the user their GitHub numbers. Failures land in `statsPayload.unavailable` as
  `{source, reason}` and the run continues.
- **An unrecognised or missing `slots.which` answers with both sources.** The router
  normally fills it, but answering with more than asked is a better failure than
  answering with nothing.
- **A never-refreshed GitHub document reads as unavailable, not as zeroes.**
  `readGithubStats()` returns `null` until `/refresh` has run once; reporting "0 repos"
  would be a confident lie.
- **The internal `reason` never reaches the prompt.** `buildStatsContext` says a source
  is `UNAVAILABLE` and nothing more — "mongo unreachable" is for the logs, not the user.
- **`stats_and_docs` drops `finalAnswer` from both halves and uses `allSettled`.** It
  keeps `statsPayload` from one and `documents` from the other. Dropping `finalAnswer`
  is what stops the `about_me` stub's "not implemented yet" from becoming the whole
  answer; `allSettled` means a retrieval outage still returns the stats.
- **`buildStatsContext` lives in `prompts.js`, not in the node.** CLAUDE.md puts every
  prompt there, and this is prompt text. It also made `test/agent/prompts.test.js` the
  natural home for its tests, which brought `stats-node.test.js` back under the 250-line
  rule.
- **The eval flags unverified numbers over 100, excluding 1990-2100.** Years in prose
  would otherwise drown the signal. A real stat that looks like a year still shows up
  under `matched`; the trade-off is deliberate for a human-reviewed file.

## Phase 2 deviations from LLD

22. **`statsPayload` carries both sources plus an `unavailable` list**, where the old
    pipeline used `{type: "github_stats" | "leetcode_stats", data}` — one source per turn.
    *Why:* the old shape cannot express "both", so *"compare my GitHub and LeetCode
    activity"* silently dropped half the question (`OLD_REPO_MAP.md` §10.35). The new
    shape also carries partial failure, which the old one had no way to express.
23. **`GENERATE_SYSTEM_PROMPT` gained grounding rules for a CONTEXT block.** *Why:* the
    LLD puts full synthesis in Phase 3b, but Phase 2's brief requires `generate` to
    synthesize stats now. The rules added are the numeric ones — never invent a number,
    never describe an unavailable source as though it had data. Document grounding joins
    them in 3b.
24. **The old pipeline's `Date.now()` "today's date" bug is not reproduced.** *Why:* the
    old response prompt interpolated raw epoch milliseconds as the current date
    (`OLD_REPO_MAP.md` §10.34). Phase 2's prompt simply omits a date; if the answer path
    needs one later it gets an ISO string.

### Phase 3a decisions — 2026-09-13

- **Fixtures are generated by the OLD code, not the new.** `scripts/generate-embedding-
  fixtures.js` requires the reference clone's `utils/embeddingGenerator.js` directly. A
  fixture produced by the implementation it is meant to pin proves nothing; this way the
  test genuinely compares against what wrote the vectors in Atlas.
- **Retrieval never imports `getModel`.** `agent/` sits above `retrieval/` in the
  dependency chain, so `plan.js` and `rank.js` take an injected model and fall back to
  their deterministic paths without one. Phase 3b's node supplies the models. This also
  means `retrieve()` works with no models at all, which is what the offline tests use.
- **`embedDocuments` keeps LangChain's `string[]` signature.** Applying the document
  template there would have broken substitutability for any `Embeddings` consumer. The
  template-aware variant is a separate `embedStoredDocuments(documents)`.
- **Ingestion keeps the old URL names** (`createDoc`, `bulkCreateDoc`, `updateDoc`,
  `deleteDoc`), mounted once instead of twice. RESTifying them would break whatever
  tooling already posts to them for no functional gain; parity is the stated principle
  for routes, and the two embedding routes were already REST-shaped.
- **The store does not install the collection's `$jsonSchema` validator.** The old
  `ensureStorage()` applied it via a `collMod` whose Unauthorized it swallowed, and that
  same mechanism could block a legacy document from being re-embedded.
  `schema.js` is the gate (DATA_MODEL.md §6); the store only ensures the unique `id`
  index, which is idempotent.
- **Validation runs before embedding.** Embedding costs money and quota; a document that
  cannot be stored should never be embedded. Asserted by a test.
- **Documents are validated twice on write** — once as a payload, once with the vector
  attached. The second pass is what enforces `embedding.length === 768` on the write path.
- **The keyword arm needs both the plan's opinion and a config flag.** It was unreachable
  in the old service, so enabling it by default would change retrieval behaviour right
  before the 3b parity eval. Off by default, and the flag is the deliberate switch.
- **`MOONMIND_MIN_SEMANTIC_SCORE` stays at 0.** The old comments warn that any previously
  tuned value is invalid after the Gemini migration, and the gate also drops
  metadata-only hits. Calibrate against a real eval before raising it.

## Phase 3a deviations from LLD

25. **The embedding templates are treated as a wire format, not as code.** *Why:* they
    determine what every vector in Atlas means. They are carried over near-verbatim under
    ARCHITECTURE.md §3 and pinned by fixtures from the original implementation, so drift
    fails a test rather than silently degrading retrieval.
26. **`moonmindMetadataIndex` is not written.** *Why:* the old service maintained a full
    second copy of every document transactionally, read by nothing
    (OLD_REPO_MAP.md §10.7). Confirm nothing external reads it before deleting the
    collection itself.
27. **The prohibited-content scan lost three patterns and kept one.** *Why:* `system
    prompt`, `chain of thought` and the rest were topic words, not secrets, and they
    reject legitimate documents — `prompt-engineering`, `llm`, `claude` and `mcp` are all
    valid subcategories. `ignore previous instructions` is kept: retrieved documents are
    fed to a model, so that one is a genuine injection payload. A test covers both sides.
28. **`normalizeDocument` keeps `tags`.** *Why:* the old service projected them from Mongo
    and then discarded them, so the reranker's tag view and the sanitizer's tag field were
    always empty (OLD_REPO_MAP.md §10.23).
29. **The intent LLM's output is used, with the regex table as the fallback.** *Why:* the
    old pipeline ran the call and then unconditionally overwrote its taxonomy with the
    regex result, making half its system prompt dead code (OLD_REPO_MAP.md §10.22).
30. **Retrieval arms run under `allSettled`.** *Why:* the old `Promise.all` meant one
    failing arm lost the whole turn. A failed arm is now reported in `failedArms` and the
    healthy arms still answer.
31. **Three files exceed the ~250-line guideline in ARCHITECTURE.md §2.**
    `retrieval/search.js` (328) — the Phase 3a brief explicitly specifies "semantic,
    keyword, metadata arms + RRF" as its contents, and ARCHITECTURE.md §1 fixes the
    retrieval file list, so splitting would contradict both. `config.js` (297) — it has
    exactly one responsibility and splitting it would undercut "the ONLY reader of
    process.env". `rank.js` (251) — one line over. Flagged for the Phase 8 audit rather
    than resolved unilaterally.

### Phase 3b decisions — 2026-09-13

- **The node delegates to `retrieve()` rather than re-composing the pipeline.** The
  brief describes the LCEL shape (decompose → fan-out → union → rank → rerank) and also
  says "keep the node small — the logic already lives in `retrieval/`". Re-expressing the
  stages in the node would have put that logic in two places and bypassed the single
  entry point Phase 7's tools are meant to share. The node supplies models, calls
  `retrieve()`, and maps the result onto state.
- **It is still an LCEL `RunnableSequence`, of three named steps.** Not ceremony: Phase 4
  feeds the run viewer from `.streamEvents()`, and named runnables (`about_me.prepare`,
  `about_me.retrieve`, `about_me.to_state`) surface there as steps instead of one opaque
  `about_me` blob. The node itself stays a plain async function per ARCHITECTURE.md §4.
- **Models are built per enabled stage.** `decompose` and `rerank` models are only
  constructed when their flags are on, so a disabled stage costs nothing and falls to its
  deterministic path in `retrieval/`.
- **Documents are sanitized inside `generate`, not by the node.** `state.documents` keeps
  the full ranked records for the API response and the Phase 4 feed, while the prompt only
  ever sees `sanitizeForPrompt`'s output. One place decides what the model may read.
- **The "no documents" context block is only added when there was genuinely nothing.**
  A stats-only turn has no documents by design and must not be told its documents are
  missing — that would push the model into an apology it has no reason to make.
- **`data.documents` returns in the old shape** (`summary_for_embedding` stripped,
  `content_full` always present). The eval needs ids to compute overlap, and it keeps the
  frontend's document rendering working at cutover.

## Phase 3b deviations from LLD

32. **Today's date reaches the prompt as an ISO date.** *Why:* the old response prompt
    interpolated `Date.now()` — raw epoch milliseconds — as "today's date", so every
    duration question was reasoned against a meaningless number
    (`OLD_REPO_MAP.md` §10.34). A test asserts no epoch timestamp appears.
33. **`about_me` writes only `documents`; it never writes `finalAnswer`.** *Why:* the old
    pipeline generated the answer inside the retrieval flow. Keeping synthesis in
    `generate` is what lets `stats_and_docs` reuse this node unchanged and answer a mixed
    question once, from both halves.
34. **The answer prompt is assembled from discrete CONTEXT blocks** (date, documents,
    stats) rather than one `JSON.stringify` of the whole payload as the old service did.
    *Why:* each block is independently testable, the absence of one is meaningful, and the
    model is told in words when a source is unavailable instead of having to infer it from
    a null.

### Out-of-band fix — 2026-09-13

- **`MONGO_DNS_SERVERS` added, partially reversing Leave-behind item §10.14.** The old
  service called `dns.setServers(["8.8.8.8","1.1.1.1"])` at import time in `mongo.js`,
  and its docker-compose set `dns:` as well. I dropped the code as an import-time side
  effect mutating process-global DNS — correct about the *implementation*, wrong to
  assume the *capability* was unnecessary. It exists because `mongodb+srv://` does an SRV
  lookup before it can reach Atlas, and a resolver that does not answer SRV queries fails
  it with `querySrv ECONNREFUSED` — which reads like a connection or credential problem
  but happens before any connection is attempted. Hit for real on first local run.
  The capability is back, but opt-in (empty by default), applied in `db.js` at connect
  time rather than on import, logged when it engages, and documented in `.env.example`
  with the symptom that calls for it. It remains process-global because the driver
  resolves through the global `dns` module, so a scoped `dns.Resolver` would not affect
  it; that constraint is noted in the code.

### Out-of-band: OpenAPI docs — 2026-09-13

- **Swagger is back, generated rather than hand-written — reversing Leave-behind §10.8 in
  substance but not in reasoning.** That item did not say "no API docs"; it said the old
  `src/swagger.js` hand-duplicated schemas that then drifted from the code, and concluded
  "if API docs are wanted, generate them from the same zod schemas that validate". That is
  what `src/http/openapi.js` does: `DocumentPayload` and `ChatRequest` are converted from
  the zod schemas the routes actually validate against, so the complex one — 78
  subcategory values, nested nullable metadata — cannot disagree with the validator. A
  test asserts all 78 values are present, which a retyped schema would not have.
- **The drift guard the old setup lacked.** `src/http/app.js` now declares its mount table
  once and exports `listRoutes()`; `test/http/openapi.test.js` diffs that inventory
  against the spec in both directions, so a new route with no documentation fails the
  suite, and so does a documented path that is not mounted. The old service's
  `GithubResponse` claimed an array where the handler returned an object; there is now a
  test asserting exactly that shape.
- **One new dependency: `zod-to-json-schema` (3.25.2).** Zero runtime dependencies,
  peer-depends on the zod already present. `zod/v4`'s built-in `toJSONSchema` is available
  on the installed 3.25.76 but cannot consume v3-API schemas, which is what ours are.
- **Swagger UI is loaded from a CDN, not vendored.** `swagger-ui-express` would have been
  a second dependency plus several megabytes in the image for what is a convenience
  wrapper. The durable artifact is the spec at `/api/openapi.json`; the rendered page at
  `/api/docs` is a nicety. Trade-off: the docs page needs outbound internet, the spec
  does not.
- **`/api/docs` keeps the old service's path**, so any existing bookmark still lands on
  API documentation.
- **`src/http/openapi.js` is 406 lines**, over the ~250 guideline and the fourth file to
  exceed it (see Deviation 31). It is declarative spec data with a single responsibility,
  and splitting a document across files makes it harder to read rather than easier — but
  four exceptions is a pattern, not an exception. Worth a deliberate decision at the
  Phase 8 structure audit rather than another case-by-case note.

### Phase 4 decisions — 2026-09-13

- **⛔ GATE: polling, not SSE, for the feed transport.** Ayan's call. Both work on an
  always-on container, so the deciding factors were risk and auth, not capability. SSE
  needs `proxy_buffering off` and to survive Nginx's 60s `proxy_read_timeout` — both
  mitigable in-app (`X-Accel-Buffering: no`, ~15s heartbeat comments), possibly with no VM
  config change at all, but there is no Nginx in front of the dev machine, so a wrong
  mitigation surfaces only in production. The auth cost was the clincher: `EventSource`
  cannot set a custom header, so SSE means either moving `MOONMIND_PASSWORD` into the
  query string — and thus into Nginx access logs and browser history — or hand-parsing
  SSE from `fetch` + `ReadableStream`, which spends the "SSE is cheaper on the frontend"
  argument. Polling keeps the header, needs no proxy change, and makes resume-after-reload
  a larger `since`. **Not foreclosed:** both transports read the same `steps` collection,
  so adding SSE later is one endpoint and no data-model change.
- **⛔ GATE: `public/` as a new top-level folder.** Ayan's call, against
  ARCHITECTURE.md §1's "nothing else without a gate" and the end-of-phase structure
  check. Recorded in ARCHITECTURE.md §1 with the scope of the exception: one file, one
  purpose, a development tool rather than product surface.
- **The graph's own `streamEvents` is the event source; no instrumentation layer.** Per
  LLD §10 ("custom event buses" are out of scope) and the phase brief. No node knows the
  feed exists, which is why `stats` and `about_me` needed no changes to be watchable.
- **`streamTurn` is an async generator that *returns* the turn summary.** Steps are the
  yielded values and the final answer is the return value, so one function serves both
  the feed and the answer without a second graph run or an out-parameter. `driveRun`
  drains it with an explicit iterator loop, which is the price of that shape.
- **Both feed collections are TTL-indexed** on `MOONMIND_RUN_RETENTION_DAYS` (7).
  Step traces are debug data; without expiry, every question asked would be kept forever.
- **The run document stores `documentIds`, not documents.** The feed shows *what*
  grounded an answer; `/chat` returns the documents themselves. Keeping the corpus out of
  the runs collection is the same instinct as the step whitelist.
- **`POST /runs` answers 202 after the run document is written, never before.** Awaiting
  the insert costs one round trip and removes the race where a client polls a runId that
  does not exist yet.

## Phase 4 deviations from LLD

35. **A named sub-step convention: a runnable called `<node>.<something>` opts into the
    feed under its own name.** *Why:* Phase 3b had already composed `about_me` as an LCEL
    sequence of `about_me.prepare` / `about_me.retrieve` / `about_me.to_state`
    specifically "so Phase 4's `.streamEvents()` feed shows named steps instead of a
    single blob". Forwarding *every* inner runnable would be unreadable; forwarding none
    would waste that design. Naming one is now how a node says "this part is worth
    watching". Anonymous runnables (`RunnableSequence`, `RunnableLambda`) stay out.
    **The safety of this rests on the whitelist:** `about_me.prepare` returns the resolved
    config, API keys included, and summarizes to the empty string because
    `summarizeUpdate` recognises none of its fields. A serializer would have leaked it.
36. **Fixed in `about-me.js`: the outer chain was `.withConfig({ runName: "about_me" })`,
    the same name as its graph node.** *Why:* `streamEvents` then reports two
    indistinguishable `on_chain_start`/`on_chain_end` pairs for that node, and the first
    live run showed every `about_me` step twice. The outer chain is now unnamed — the
    three inner steps carry the names. `streamTurn` *also* deduplicates node boundaries
    per superstep, so a future node making the same mistake costs a less precise `end`
    summary rather than a doubled feed. Belt and braces, because the naming rule is a
    convention and conventions get forgotten.
37. **A tool produces one step, on completion, not a `start`/`end` pair.** *Why:* the step
    vocabulary fixed in the brief has a single `tool` type. A tool that never returns is
    already visible as the missing `end` on the node holding it. Revisit in Phase 5 if
    watching a long web search start matters.

### Phase 5 decisions — 2026-09-13

- **⛔ GATE: Tavily as the search provider.** Ayan's call, matching the LLD's
  recommendation. The deciding factor was depth of grounding per call: Tavily returns
  extracted page *content* plus source URLs, where Brave and most general search APIs
  return snippets and links. With snippets we would have had to build fetch-and-extract
  inside `integrations/`, which is the bulk of the work the module otherwise avoids, and
  answers would cite pages the agent never actually read. Brave's larger free tier (2,000
  queries/month vs ~1,000 credits) was not worth that.
- **No provider SDK.** `@langchain/tavily` exists, but `integrations/` is framework-free
  plain JS by ARCHITECTURE §2 and the client is ~120 lines of `fetch` either way. One
  fewer dependency, and the timeout and error taxonomy are ours.
- **`TAVILY_API_KEY` is required, not optional.** Consistent with `OPENAI_API_KEY` and
  `GEMINI_API_KEY`, and it follows from CLAUDE.md's "fails fast": `tech_web` is live from
  this phase, so a missing key is misconfiguration, and finding out at boot beats finding
  out when a visitor asks a question. The cost is that the next deploy needs the key set
  on the VM first — recorded as a handoff open item rather than softened away.
- **`maxSteps` is enforced by `modelCallLimitMiddleware`, not by a hand-rolled loop.**
  LLD §10 puts hand-rolled agent loops out of scope; the prebuilt helper ships this.
  `exitBehavior: "end"` rather than `"error"`, so the run finishes and the node can still
  return sources.
- **Truncation is detected by counting tool rounds, not by matching the library's
  notice.** The middleware ends the run by appending its own message; matching its wording
  would break on a LangChain patch release. Counting is exact: with a run limit of N, N
  tool rounds means the answering call never happened.
- **One search tool, not one per search mode.** The model picks the query; depth and
  result count are configuration, not something to expose in a schema the model can talk
  its way around.
- **Agent nodes write back only `finalAnswer` plus their sources.** The scratchpad —
  tool calls, tool results, intermediate reasoning — stays inside the agent, so the
  conversation the next turn replays holds one AIMessage per turn, exactly as for every
  other branch. `generate` appends it, unchanged.

## Phase 5 deviations from LLD

38. **The tool contract is `responseFormat: "content_and_artifact"`, not a JSON string.**
    *Why:* the node needs structured sources for `searchResults` and the model needs
    readable prose; returning `[content, artifact]` gives both without the node parsing
    the text it just asked a model to read. `makeAgentNode` collects `artifact.results`
    from every tool message, which is the convention Phases 6b and 7 inherit.
39. **The feed now derives a tool step's branch from `langgraph_checkpoint_ns`, not from
    `langgraph_node`.** *Why:* an agent node runs its own compiled graph, and that inner
    graph overwrites `langgraph_node` — a `web_search` from `tech_web` arrives labelled
    `tools`. That says nothing about which branch ran it and would collide across every
    agent once 6b and 7 land. The namespace carries the full path
    (`tech_web:<id>|tools:<id>`), so the outermost segment is the branch. Only nested
    events have a `|`; everything else is untouched. This is Phase 4 code changed by
    Phase 5, and it is the second time the feed has needed a fix that only a real nested
    case could reveal.
40. **`makeAgentNode` accepts an injected `agent` for tests.** *Why:* `FakeToolCallingModel`
    synthesizes its content from the system prompt and ignores a supplied response, so it
    cannot produce an empty or absent answer — the two cases the `AGENT_NO_ANSWER` fallback
    exists for. The seam matches the `deps` pattern `about-me.js` and `stats.js` already
    use, and the toolset is still bound and still reported by `toolNames`, so the isolation
    assertions are unaffected by it.

### Out-of-band fix: tech_web answered from memory — 2026-09-13

**Reported.** "Tell me something about the latest GPT frontier model" came back describing
**GPT-4o, May 2024** — the model's training knowledge, not the web — with `route:
"tech_web"`. The suspicion was that the Tavily call was not going through, and there was
no logging to tell.

**Tavily was fine.** A direct call returned 5 results and the correct current answer, and
instrumenting the real node showed `web_search` invoked on every request with 5 sources
written to `searchResults`. The search ran; the answer did not use it.

**Root cause: `TECH_WEB_SYSTEM_PROMPT` never told the agent what day it is.** With no date,
gpt-4o-mini anchors on its training cutoff and *writes the year into its own search query*.
Reproducible, and confirmed by A/B on the same question:

| prompt | query the model wrote | answer |
|---|---|---|
| as shipped | `latest GPT frontier model 2023` | GPT-5.2, framed as "the landscape in 2023" |
| + date context | `latest GPT frontier model 2026` | GPT-5.6, July 2026 — correct |

So the failure was upstream of the search: a stale query returned stale-ish results, and
the model filled the gaps from memory. Note it still cited a URL, which is what made this
look like a working search — the answer's `help.openai.com` link is genuinely Tavily's top
result for this query.

**This is Deviation 32 in a new place.** That one recorded the old service interpolating
`Date.now()` epoch milliseconds as "today's date" into the response prompt. `generate` was
fixed in Phase 3b via `buildDateContext()`; Phase 5 then built an agent prompt without it.

**Fixed.**
1. `makeAgentNode` composes its system prompt through `dynamicSystemPromptMiddleware`
   rather than passing `systemPrompt`, appending `buildDateContext()` **per run**. Per run
   matters: `createNodes()` executes once at boot and the container is always-on, so a
   date captured at construction is wrong by the next day. The middleware appends a second
   system message rather than replacing the first, which is why `systemPrompt` is now
   dropped instead of kept alongside it.
   Applied in the factory, so every agent inherits it — Phase 6b cannot resolve "next
   Tuesday" without it either.
2. `web_search` logs `agent.web_search { query, results, ms }` on success and
   `agent.web_search.failed { query, code, message, ms }` on failure. **Server log only.**
   The persisted feed still carries no tool arguments; this is a per-tool decision, and the
   reasoning does not transfer to `send_email`, whose arguments are the visitor's words
   rather than the model's.
3. Two regression tests: the agent's system prompt contains today's date, and it is
   resolved per run rather than frozen at build.

**Why the feed did not catch this.** It showed `web_search -> 5 results`, which looked
healthy. The bad query was invisible because `summarizeTool` deliberately excludes tool
arguments. That redaction rule is still right for the persisted feed; the server log is
the correct place for the query.

**Worth knowing:** an agent *swallows* a tool failure — the error comes back to the model
as a tool result and it answers from memory, which from outside is indistinguishable from
a healthy answer. `agent.web_search.failed` is now the only signal that this happened.

**Open.** `MOONMIND_AGENT_MODEL` is unset, so agents run on `gpt-4o-mini` via the RESPONSE
fallback. It is a weak model for deciding when and what to search, and it was weak enough
here to date its own query. Worth setting it to something stronger for the agent role and
re-running the Phase 5 live check both ways before Phase 6b hands an agent real actions.

### Out-of-band: scope guard before tool dispatch — 2026-09-13

**Asked for.** A small classifier before the Tavily call: if the question is about an
excluded topic, the search does not go through and the visitor gets a "beyond MoonMind's
scope" message. Ayan's calls at the gate: **make the topic list extendable** rather than
fixed, and **redirect** in the message rather than dead-ending or naming the topic.

**Shipped.** 332 offline tests pass (10 new). One extra cheap model call per agent
question; a blocked question costs that and nothing else — no agent loop, no search credit.

**Where it sits.** In `makeAgentNode`, opt-in per agent via `scopeGuard: true`, so Phases
6b and 7 inherit it without inheriting the decision. It runs on the **visitor's question**,
not on the query the model would have written — the right input for a topic judgement, and
it means the gate closes before any tool is dispatched. Wrapped as a named runnable so it
shows in the Phase 4 feed as `tech_web.scope_check`: a guardrail that runs invisibly is one
nobody can audit.

**Not the same thing as the router's `refusal` route,** and deliberately so. The router
decides which branch answers; this decides whether a question that already reached an agent
is worth a search. They disagree exactly where you would expect — "which crypto should I
buy right now" is a perfectly good industry question as far as the router is concerned.

**Extendable, as asked.** `EXCLUDED_TOPICS` in `agent/prompts.js` is a list of
`{ id, description }`, and the classifier prompt is generated from it — the same idiom as
`buildCapabilitiesAnswer` templating from the route enum. Adding a topic is one entry and
nothing else. `MOONMIND_EXCLUDED_TOPICS` appends to it at runtime, so the VM can gain a
topic with a container restart instead of a rebuild. Seeded with eight defaults
(medical/legal/financial advice, trading speculation, politics, religion, adult content,
violence/illicit) — **my choice, not a stated requirement**; delete lines freely.

**Verified live**, real classifier and real search:

| question | result |
|---|---|
| latest GPT frontier model | allowed, 5 sources |
| which crypto should I buy right now | blocked — `trading_speculation` |
| sharp headache for three days | blocked — `medical_advice` |
| who should I vote for | blocked — `politics` |
| **best Python library for medical imaging** | **allowed, 5 sources** |
| should I sue my landlord | blocked — `legal_advice` |

That fifth row is the one that matters: a software question that merely mentions an
excluded field stays in scope. It is why this is an LLM classifier and not a keyword list —
a keyword list fails that case, and a scope guard with false positives is worse than none.

**Fails open, on purpose.** If the classifier errors the question is allowed through and
the failure is logged. This is an editorial filter, not a safety control: the model's own
training still applies and `refusal` still exists, so taking every tech question down
because a classifier hiccuped is the worse outcome. The catch sits at the **call site**,
not only inside the classifier, so no guard — including an injected one — can take the
route down. **This reasoning does not transfer to Phase 6b's calendar confirmation**,
which guards a side effect and must fail closed.

**Logging.** `agent.scope_guard.blocked { node, topic }` on a block,
`agent.scope_guard.failed` / `.errored` on failure. The topic is logged but never shown:
naming it back would tell a prober exactly what the filter keys on.

**Structure.** `prompts.js` is now 350 lines and `agents.js` 241. The topic list and the
classifier prompt belong in `prompts.js` by its own stated rule ("every system prompt"),
and a new `agent/scope.js` would have needed a gate for one small module — so prompts.js
is now the **seventh** file over the ~250 guideline and by some way the largest offender.
Splitting it by audience (router / generate / agents / user-facing copy) is the obvious
move and is the clearest candidate yet for the Phase 8 structure audit.

**Env vars.** Two added, total 76: `MOONMIND_SCOPE_GUARD_ENABLED` (default true) and
`MOONMIND_EXCLUDED_TOPICS` (empty).

### Out-of-band: the run feed returns documents — 2026-09-15

**Reverses a Phase 4 decision, on Ayan's call**, ahead of the frontend cutover work.

Phase 4 stored `documentIds` rather than documents, so the feed would not become a second
copy of the corpus. That held while `/chat` was the frontend's chat path. It stops holding
now that the frontend drives chat entirely from `POST /runs` + `GET /runs/:runId`: with ids
only, either source rendering is lost or the frontend calls both endpoints and **the graph
runs twice for every question**, doubling model and Tavily cost.

**Changed.** `finishRun` stores `turn.documents`; `toFeedResponse` puts them through
`toResponseDocuments` — the same function `/chat` uses, so the two payloads cannot drift.
Verified live: an `about_me` run returns 10 documents with identical keys to `/chat`
(`id, title, category, tags, content_full, metadata, score, semantic_score,
retrieval_sources, rrf_score, retrieval_score, boost_score`) and `summary_for_embedding`
stripped. `documentIds` and `documentCount` stay, for callers that only want the ids.

**Cost accepted.** The runs collection now holds document bodies. It is bounded by
`MOONMIND_RUN_RETENTION_DAYS` (7) and by the fact that only retrieving routes populate it.
Worth watching on the Atlas free tier if traffic grows — the row size is roughly the
`/chat` payload per run.

**Measured run times** (useful for the frontend's polling): `about_me` 7.7s, `tech_web`
20.1s. The hard cap is `MOONMIND_RUN_TIMEOUT_MS` (120s).

**Also written:** `docs/FRONTEND_INTEGRATION.md` — the API contract and migration brief to
hand to the frontend repo. It is the backend half of what Phase 8's `CUTOVER.md` will
cover; Phase 8 should reference it rather than restate it.

### Out-of-band: debug tracing for agent runs — 2026-09-15

**Asked for.** A way to watch the agentic steps while debugging behaviour.

**What already existed.** Good failure logging — `agent.node.failed` with a stack,
`agent.router.fallback`, `agent.stats.source_unavailable`, `agent.about_me.degraded`,
`agent.web_search`, `agent.scope_guard.blocked`, `agent.node.truncated`. What was missing
was the **happy path**: which nodes ran, in what order, how long each took, and what each
one decided. The run feed captures that, but only into Mongo and only in redacted form.

**Where it went.** `withErrorBoundary` in `graph.js` wraps every node, so instrumenting
there covers `/chat` (which uses `.invoke()` and produces no feed), the run feed, the eval
scripts and the tests — from one place, with no node aware of it.

**Two levels, both off by default.**
- `MOONMIND_DEBUG` — `agent.run.start` / `agent.node.start` / `agent.node.end` /
  `agent.route` / `agent.run.end`, each with `runId`, `sessionId` and `ms`.
- `MOONMIND_DEBUG_MODELS` — LangChain's own `verbose`, set in `models.js`: every prompt and
  completion in full. Kept separate because the volume is on a different scale; one
  `about_me` turn prints ten documents of context. The intended workflow is
  `MOONMIND_DEBUG` to find the node, then this to see what it was asked.

**`describeUpdate` vs `summarizeUpdate`.** Deliberately two functions. The feed's
`summarizeUpdate` (`runs.js`) is a redaction whitelist for a Mongo collection; this one is
for the server log the operator already sees stack traces in, so it keeps **slot values**,
**document ids** and a 140-character answer preview — the things that actually separate a
bad route from a bad retrieval. It is still a whitelist rather than a serializer: an LCEL
sub-step's output carries the resolved config, API keys included, and a test asserts that
shape summarizes to `{}`.

**`agent.route` is the high-value line.** It prints the branch taken alongside the
classification and the sticky `activeFlow` that may have overridden it — the answer to
"why did this question go there".

**One defect found and fixed while building it.** The first version called `getConfig()`
unconditionally, which broke `test/agent/graph.test.js` — that file drives `buildGraph`
with an explicit `topicChangeConfidence` specifically so it needs no environment.
`debugEnabled()` now tolerates config being absent. A tracer must never be the reason a
run fails.

**Verified live.** A real `about_me` turn with `MOONMIND_DEBUG=true` traces router (3.2s,
`route=about_me confidence=0.9`) → `agent.route` → about_me (10 document ids) → generate
(4.3s, 1058 chars) → `agent.run.end` 16.5s. With the flag off, zero `agent.*` lines — a
test asserts that too. 337 tests pass (5 new).

**Env vars.** Two added, total 78.

### Out-of-band fix: the router refused from its own history — 2026-09-16

**Reported.** `"Ayan's resume"` came back `route: refusal, confidence: 1` in a real run,
*after* `resume` had been added to the `about_me` bullet in `ROUTER_SYSTEM_PROMPT`. The
question was why the prompt edit had not taken.

**It had taken. The prompt was never the lever.** With the edited prompt and no history,
8 identical calls returned `about_me@0.9` — the edit moved it up from 0.8. The refusal
came from **session history**:

1. The router classifies from `recentMessages(state.messages, …)`, not from the latest
   message alone.
2. `generate` appends every answer to `messages`, including `REFUSAL_ANSWER`.
3. So the router reads its own past refusals as precedent and refuses again.

Two refused resume-style asks in one session was enough to flip it, reproducing the
reported trace exactly — `refusal@1.0`. A confidence of 1.0 also clears
`MOONMIND_ROUTER_MIN_CONFIDENCE`, so the low-confidence floor never catches it, and the
floor lands on `about_me` anyway rather than `refusal`.

**Measured, because the obvious fix does not work:**

| variant | result over 4 calls |
|---|---|
| as-is, poisoned history | 4x `refusal@1.0` |
| + explicit "earlier refusals are not precedent" rule in the prompt | 4x `refusal@1.0` |
| canned dead-ends filtered out of the router's history | 4x `about_me@0.9` |
| both | 4x `about_me@0.9` |

The prompt rule failed 4/4. The contamination is in the input, so the input is what
changed — this is worth remembering the next time a routing bug looks promptable.

**Fixed.**
1. `CANNED_DEAD_ENDS` in `prompts.js` — the five answers that say "I can't help with this"
   (`REFUSAL_ANSWER`, `ERROR_ANSWER`, `NOT_IMPLEMENTED_ANSWER`, `OUT_OF_SCOPE_ANSWER`,
   `AGENT_NO_ANSWER`). Exact strings, since they are our own constants, so a genuine
   answer that happens to sound apologetic is never dropped. `buildTruncatedAnswer` is
   deliberately excluded: it reports partial progress, not a refusal.
2. `routerHistory()` in `nodes/router.js` filters them out of what the router sees. Real
   answers stay — they are what lets the router resolve "what about that?".
3. Two regression tests: the dead-ends are filtered, and a real answer still reaches the
   router.

**Router eval, finally run — and it is now the regression net it was meant to be.**
Baseline before this session's changes: **27/29**, with two misses unrelated to the
resume bug:
- `about_me` 3/4 — "What backend technologies does Ayan work with?" → `tech_web` (0.80)
- `tech_web` 2/3 — "How does RAG compare to fine-tuning in 2026?" → `complex` (0.70)

Both were genuinely promptable, and two new Rules fixed them: a question naming Ayan (or
he/his/him) is never `tech_web` however much technology it mentions, and `complex` is only
for questions about Ayan. **Re-run: 29/29, every route passing, no regressions.**

This closes Phase 1's open item 2. The eval had never been run; it took ten minutes and
caught two real defects, which is the argument for running the other four.

**Still open.** `scripts/router-eval.js` contains `require("dotenv").config()`, which
violates CLAUDE.md's standing "no dotenv" rule and does nothing — it reports
`injected env (0)` because `--env-file` has already loaded everything. `dotenv` is not in
`package.json` either, so it resolves only via a transitive install and would break on a
clean `npm ci`. One line to delete; left alone because it is outside what was asked.

## Phase 6 deviations from LLD

41. **The 8-route taxonomy (LLD §2, ARCHITECTURE.md's old §4) is superseded by a 6-label
    graph** — `knowledge`, `stats`, `agent`, `action`, `refusal`, `capabilities` — dropping
    `about_me`/`complex`/`tech_web`/`book_catchup`/`send_mail`/`list_capabilities` as
    separate routes. *Why:* three problems the old taxonomy accumulated once real
    questions and real routing were run against it, not a re-plan done in the abstract.
    (a) **`about_me`/`complex` never had a real boundary.** The out-of-band router fix on
    2026-09-16 needed an explicit rule — "`complex` is only for questions about Ayan" —
    just to keep them apart, and both already run the identical retrieval pipeline
    underneath (`retrieve()`). There was never a second implementation to justify a second
    route.
    (b) **Four near-identical agents were planned** (`tech_web`, `complex`, `book_catchup`,
    `send_mail`) against a factory (`makeAgentNode`, Phase 5) built to need only one.
    `tech_web` and `complex`'s tool use collapse into a single bounded `agent` with four
    tools (`resolve_time`, `metadata_filter`, `semantic_search`, `web_search`);
    `book_catchup` and `send_mail` were never agents at all once booking stopped needing a
    live free/busy negotiation — see (c).
    (c) **Scheduling is delegated to a hosted provider.** A templated scheduling link
    (Calendly-shaped) replaces `check_free_busy`/`create_event` and the Google Calendar
    OAuth integration the old Phase 6a gate would have required. There is no calendar tool
    to isolate or confirm a write against, so the LLD's confirmation-in-state guardrail
    design for calendar writes does not need building at all — `mail` is the only side
    effect left, and it was already deterministic.
    Old Phase 6a/6b/7 (this file's previous revision) are replaced by Phase 7 (router +
    `knowledge`), Phase 8 (`agent`), Phase 9 (`action`). `pendingConfirmation` is dropped
    from state (ARCHITECTURE.md §4); a new `agentEscalationUsed` field is added for the
    `knowledge`→`agent` handoff budget.
42. **`retrieve()` gained an opt-in `debug` trace** (`options.debug`, surfaced over HTTP
    behind `MOONMIND_RETRIEVAL_DEBUG`) — not in the LLD, which predates the need to measure
    the pipeline against a live, if small, corpus. Ids and titles only, per stage: per-arm
    hits, the RRF-fused order (sorted by `rrf_score` for readability — the raw fusion order
    is Map insertion order, not a ranking), the post-ranker order, and the post-rerank
    order. Wired through `about-me.js` -> `state.retrievalDebug` (per-turn reset) ->
    `toTurn()` -> `POST /chat`'s response as an extra field, never the normal shape;
    `stats_and_docs` carries it through from the `about_me` half. Deliberately **not**
    wired into `POST /runs`/`GET /runs/:runId` — `runs.js`'s whole design is a redaction
    whitelist bounded by `MOONMIND_RUN_RETENTION_DAYS`, and a multi-stage per-arm trace is
    exactly the kind of thing that whitelist exists to keep out of durable-ish storage.
    `scripts/retrieval-ab.js` calls `retrieve()` directly with `debug: true` rather than
    going through HTTP, so it needs no server and no flag flip.
