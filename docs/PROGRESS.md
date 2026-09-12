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

### `[~]` Phase 0 — Lean skeleton, stats parity, deploy
*Built and tested locally; awaiting the first CI/CD deploy and a live parity run — see
the Phase 0 handoff entry for the exact remaining steps.*
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

### `[ ]` Phase 1 — Graph skeleton
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

### `[ ]` Phase 2 — `stats` node
**Scope:** `src/agent/nodes/stats.js` — a plain function (no agent; the router already
decided) calling `src/stats/*` directly based on `slots.which`, writing `statsPayload`.
`generate` synthesizes. No duplicated fetch logic, no HTTP self-calls. If one source fails,
return the other plus a note — don't fail the run.
**Done when:** an offline test with fake stats services covers github / leetcode / both /
one-source-down; 5 live questions are recorded side by side with the old pipeline in
`docs/evals/stats.md` and are consistent with `/github` and `/leetcode`.

### `[ ]` Phase 3a — Documents + retrieval modules
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

### `[ ]` Phase 3b — `about_me` node
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
