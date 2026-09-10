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

### `[ ]` Phase 0 — Lean skeleton, stats parity, deploy
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

## Decisions

*(One line per decision: what was decided, by whom, and why. Append as they are made.)*

- **2026-09-10 — Documentation-only Phase 00.** No `package.json`, no dependencies, no
  scaffolding. Dependency choices belong to the phase that first needs them, so each one
  can be justified against a real requirement.
- **2026-09-10 — Code wins over the LLD on every data-model conflict.** The LLD is the
  plan; the old code is the ground truth for behavior that must be preserved. Every
  difference is recorded rather than silently resolved (DATA_MODEL §7, OLD_REPO_MAP §11).

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
