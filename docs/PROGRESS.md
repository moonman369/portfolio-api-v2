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

### `[~]` Phase 3b — `about_me` node
*Built and covered offline. `docs/evals/about_me.md` is a placeholder — the eval has
never been run, and this phase is explicitly not done until Ayan reads it and agrees the
quality is equivalent.*
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

### `[ ]` Phase 4 — Live event feed
**⛔ GATE first:** always-on container, so both work — (a) `POST /runs` + polling
`GET /runs/:id?since=`, or (b) SSE. Present the trade-offs (Nginx buffering/timeouts for
SSE, frontend cost) and wait.
**Scope:** `agent/index.js` → `streamTurn()` on the compiled graph's `.stream()` /
`.streamEvents()`, no separate instrumentation layer. `agent/runs.js` — `runs` / `steps`
Mongo collections; a step is `runId, seq, node, type (start|end|tool|error), ts, summary`.
Short summaries only: no secrets, no full documents, no raw prompts. Feed endpoints in
`http/chat.js`; `/api/v1/moonmind/chat` unchanged. `public/run-viewer.html` test page;
Nginx location block if SSE. Add `runs.js` to the ARCHITECTURE.md layout.
**Done when:** the test page shows ordered steps ending in the final answer for an
about_me query and a stats query; an erroring node appears as an `error` step followed by a
graceful answer.

### `[ ]` Phase 5 — Agent factory + `tech_web`
**⛔ GATE:** confirm the search provider (the LLD recommends Tavily).
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

### `[ ]` Phase 6a — Action decisions, integrations, tools
**⛔ GATE first — five questions for Ayan, recorded in Decisions and CLAUDE.md:**
(1) calendar provider (LLD assumes Google Calendar); (2) email provider (LLD recommends an
HTTP API — Resend/SendGrid — over SMTP); (3) bookable hours + timezone; (4) confirmation
mode: chat "yes" vs emailed link; (5) how the visitor gets their booking confirmation
without the email tool ever sending to a visitor-supplied address.
**Scope:** `src/integrations/calendar.js` and `email.js` (plain JS, timeouts; the email
client reads the recipient only from config, `MOONMIND_OWNER_EMAIL`);
`scripts/google-oauth.js` (one-time grant → refresh token in env, same pattern as
`GITHUB_PAT`); tools `check_free_busy`, `create_event` (idempotent per session, refuses
without a prior-turn confirmation in state — enforced in the tool), `send_email` (**no
recipient field**); `TOOLSETS` entries for `book_catchup` and `send_mail`.
**Done when:** each integration and tool passes isolated tests against a real test calendar
and sandbox mailbox; `create_event` without confirmation is rejected; the `send_email`
schema has no recipient.

### `[ ]` Phase 6b — `book_catchup` + `send_mail`
**Scope:** both nodes from the Phase 5 factory (reuse, don't fork). Slot-filling (visitor
name, contact, purpose, preferred window, timezone) persists in `slots` via the
checkpointer; the node sets `activeFlow = 'book_catchup'` while in progress and clears it
on completion or cancel. Always free/busy check before proposing times. Confirmation via
`pendingConfirmation` in state, enforced by `create_event` — keep the state-flag approach
unless it demonstrably can't work. Tight per-IP + sessionId rate limits for action routes.
**Done when:** a full booking conversation (ask → fill slots over several turns → propose →
confirm → event created → notification per Decision 5) works end to end on the test
calendar. Tests: a mid-flow "Tuesday 3pm works" stays in `book_catchup`; "cancel" exits the
flow; skipping confirmation never creates an event; `send_mail`'s tools are exactly
`["send_email"]`; "send this to someone@else.com" still reaches only Ayan; the rate limit
trips.

### `[ ]` Phase 7 — `complex` node
**Scope:** a deterministic `resolve_time` tool (no LLM) turning "2023", "now", "last year",
"since I joined" into date ranges relative to the current date; `metadata_filter` and
`semantic_search` tools as thin wrappers over `retrieval/` (same code paths, not copies),
with metadata filters covering `date_start`, `completion_year`, `domain`, `subcategory`,
`is_active`; `TOOLSETS.complex = [resolve_time, metadata_filter, semantic_search,
web_search]`; `complex = makeAgentNode({ ... })`. Answers cite the documents and sources
used. Handle any mixed-query routing decided in Phase 1.
**Done when:** `docs/evals/complex.md` shows coherent, correctly-sourced answers for
"backend skills 2023 vs now", "how has Ayan upskilled in AI", and "AI projects + market
relevance today". Tests: exactly 4 bound tools; `resolve_time` unit cases.

### `[ ]` Phase 8 — Cutover + final structure audit
**Scope:** (1) structure audit against ARCHITECTURE.md — layout, dependency direction,
framework boundary, file sizes, grab-bag modules, unused deps; fix small drift, report
anything larger and wait. (2) Monitoring: per-run route, per-node latency, errors,
tool-call counts, reusing `runs`/`steps`, plus a summary script or endpoint.
(3) `docs/CUTOVER.md`: the exact frontend change (separate repo — instructions only),
rollback plan, monitoring checklist, agreed zero-traffic period. (4) Regression: run every
eval script against production.
**⛔ GATE:** decommissioning the old MoonMind pipeline happens in the old repo only after
Ayan confirms zero traffic for the agreed period. Don't touch that repo from here — write
the steps into CUTOVER.md for a separate session.
**Done when:** the audit is clean, evals pass in production, CUTOVER.md is complete, and
Ayan has switched the frontend.

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
