# ARCHITECTURE — the target shape of this repo

This is the shape every phase builds into. It is **binding**: the end-of-phase structure
check compares new files against this document, and any deviation needs a ⛔ GATE with
Ayan before it lands.

Companion documents:
- `docs/reference/moonmind_agentic_lld.md` — the plan (what and why).
- `docs/OLD_REPO_MAP.md` — what the old service does, and what to leave behind.
- `docs/DATA_MODEL.md` — the data contract.
- `docs/PROGRESS.md` — phase state, decisions, deviations.

---

## 1. Layout

CommonJS. Feature folders. **Maximum three levels under `src/`.**

```
src/
  server.js              # starts the app; the only process entry point
  config.js              # the ONLY reader of process.env — zod-validated at boot, frozen, fails fast
  db.js                  # one MongoClient, named collection getters
  http/                  # thin: validate -> call -> respond. No business logic.
    app.js               # express app, middleware, mounting, error handler
    auth.js              # shared password header, rate limiters
    stats.js             # /github, /leetcode, /refresh
    documents.js         # ingestion routes
    chat.js              # /api/v1/moonmind/chat + the run feed (POST /runs, GET /runs/:runId)
  stats/                 # github.js, leetcode.js — plain JS, framework-free
  documents/             # taxonomy.js, schema.js, embeddings.js, store.js — plain JS
  retrieval/             # embedder.js, plan.js, search.js, rank.js, index.js
  integrations/          # websearch.js, calendar.js, email.js — plain JS
  agent/
    index.js             # runTurn(), streamTurn(), startRun() — how HTTP runs the graph
    graph.js             # StateGraph wiring only
    runs.js              # runs/steps collections behind the live event feed
    state.js
    models.js            # getModel(role)
    prompts.js           # every system prompt
    tools.js             # every tool + TOOLSETS map
    nodes/               # router.js, simple.js, stats.js, about-me.js, agents.js, generate.js
public/                  # run-viewer.html — the only static asset (see below)
scripts/                 # parity-check, evals, oauth, one-off migrations
test/                    # node:test, mirrors src/
docs/
```

Phase 4 added `src/agent/runs.js` and, by gate, the top-level `public/`. Nothing else is
added without a gate.

**`public/` is a gated exception** to the no-new-top-level-folders rule (Ayan's call,
2026-09-13). It holds exactly one file, `run-viewer.html`: a dependency-free test page for
the live event feed, served by `express.static` mounted last in `app.js` with directory
indexes off, so it can never shadow a route. It is a development tool, not product
surface — the portfolio frontend calls the API and loads nothing from here. A second file
in `public/` is a new design question, not a free extension of this one.

Files not under `src/`: `Dockerfile`, `docker-compose.yml`, `.github/workflows/deploy.yml`,
`.env.example`, `package.json`, `CLAUDE.md`.

---

## 2. Dependency rules

**One direction only:**

```
http  →  agent  →  { retrieval, stats, documents, integrations }  →  { config, db }
```

- Nothing imports **upward**, and nothing imports **sideways into `http`**. If a module in
  `stats/` or `documents/` needs something from `http/`, the design is wrong.
- `retrieval/` may import `documents/` (it wraps `documents/embeddings.js`). The reverse is
  forbidden.
- `agent/nodes/*` import from `retrieval/`, `stats/`, `documents/`, `integrations/` and
  from sibling `agent/` modules. They never import `http/`.
- `config.js` and `db.js` import nothing from the layers above them.

**Framework boundary.** LangChain and LangGraph imports appear **only** in `agent/` and
`retrieval/`. `stats/`, `documents/` and `integrations/` stay framework-free plain JS, so
they are testable without a model and reusable from scripts, tools and tests alike.

**No grab-bag folders.** No `utils/`, `helpers/`, `common/`, `lib/`, or `adapters/`.
Shared code gets a named home that says what it is, or it stays local until there is a
real second use. (The old repo had four different `utils/`-shaped modules and an
`adapters/` layer; both are on the Leave-behind list.)

**File size.** Split a file by responsibility once it passes **~250 lines**. Split along
what it does, not into `partA`/`partB`.

**Lean dependencies.**

- Native `fetch` + `AbortSignal.timeout` — **no axios**.
- `node --env-file=.env` locally — **no dotenv**.
- `node:test` — **no jest**.
- Every new dependency is justified in `docs/PROGRESS.md` under Decisions, with what it
  replaces and why a built-in won't do.

---

## 3. Carry-over policy

**Rewrite, don't copy.** Read the old code to learn the behavior, then write it fresh in
this layout. Parity means the same contract and the same results — not the same files.

**The one exception** — byte-fidelity and pure-algorithm code may move over near-verbatim
into its new home:

| What | From | To |
|---|---|---|
| Embedding templates + `truncateToChars` | `utils/embeddingGenerator.js` | `src/documents/embeddings.js` |
| Reciprocal Rank Fusion | `src/moonmind/ranking/rrf.js` | `src/retrieval/search.js` |
| Deterministic ranker scoring | `src/moonmind/ranker.js` | `src/retrieval/rank.js` |

These are deterministic, already tested, and (for the templates) load-bearing against
vectors already in Atlas. Everything else gets rewritten.

**Do not bring over:** `vercel.json`, the regex `statsRouter.js`, the `adapters/` layer,
commented-out code, and anything on the Leave-behind list in `OLD_REPO_MAP.md` §10.

---

## 4. Graph design — simple

`src/agent/graph.js` is **wiring only** and fits on one screen:

```js
function buildGraph({ nodes, checkpointer }) {
  return new StateGraph(State)
    .addNode('router', nodes.router)
    /* one addNode per route + 'generate' */
    .addEdge(START, 'router')
    .addConditionalEdges('router', routeFromState, ROUTE_TO_NODE)
    /* each branch -> 'generate' */
    .addEdge('generate', END)
    .compile({ checkpointer });
}
```

Rules that keep it that way:

- **Every node is a plain `async (state, config) => partialState` function** that returns
  only the keys it changes. No classes, no `BaseNode`, no lifecycle hooks.
- **`routeFromState` is a pure function** over a static `ROUTE_TO_NODE` map. An unknown or
  missing route falls to `refusal`. No conditionals scattered across nodes.
- **The single `agent` node comes from the factory built in Phase 5**,
  `makeAgentNode({ name, toolset, prompt, maxSteps })`, reused unchanged. It runs on its
  own message list seeded from recent history and writes back **only its final answer and
  sources** — never its internal tool chatter into `messages`.
- **`TOOLSETS` in `tools.js` is the single auditable map** of which agent gets which tools.
  One place to read to answer "can this agent send email?".
- **`getModel(role)` is the single model factory.** Roles: `router`, `intent`, `decompose`,
  `rerank`, `response`, `agent`. It reads the per-role env vars from `config.js`; no module
  constructs a model any other way.
- **`runTurn({ sessionId, message })` is the single entry point** for HTTP, the run feed,
  and the eval scripts. If something needs to run the graph, it calls `runTurn`.

**Route taxonomy (supersedes LLD §2 — see PROGRESS.md Deviations for why):**

```
guard (non-LLM: length cap, rate limit, auth)  [existing http-layer checks, unchanged]
  → router  (6 labels)
      ├── knowledge    → retrieval (RRF pipeline) → generate
      ├── stats        → direct dispatch → generate
      ├── agent        → ONE bounded agent (4 tools) → generate
      ├── action       → sub-branch inside the node: 'book' | 'mail'
      ├── refusal      → templated, no LLM call
      ├── capabilities → templated, no LLM call
      └── greeting     → templated, no LLM call
```

- `about_me` and `complex` merge into **`knowledge`** — the boundary between them was
  never real.
- `tech_web` and `complex`'s tool use merge into **`agent`**: one `makeAgentNode` call,
  four tools (`resolve_time`, `metadata_filter`, `semantic_search`, `web_search`).
- `book_catchup` and `send_mail` merge into **`action`**, branching internally on
  `slots.action`. Booking is a templated scheduling link from a hosted provider; mail is
  deterministic. Neither is an agent — no calendar tool, no confirmation step.
- Escalation: `knowledge` may hand off to `agent` **once per turn**, budget enforced in
  state. No other node escalates; `agent` never escalates back.
- **`greeting`** is templated alongside `refusal` and `capabilities` (added Phase 6.5).
  "Hey" is a greeting, not a request for the feature list — answering it with the
  capability menu was a live bug. `capabilities` stays for the explicit ask.

**Conversation context.** The router classifies the latest message against a compacted
block of the recent conversation plus `previousRoute`, not against raw history. Raw
history was measurably worse than none: at the turn that motivated Phase 6.5 the live
message was 0.9% of the router's input and classified `refusal` at confidence 1.00, where
the same message alone classified `about_me`. Earlier messages are clipped; the message
being classified is passed separately, last.

State fields (supersedes LLD §3): `sessionId`, `rawQuery`, `messages`, `route`,
`routeConfidence`, `slots`, `documents`, `statsPayload`, `searchResults`, `summary`,
**`finalAnswer`**, **`error`**, **`activeFlow`**, **`previousRoute`** (the route the last
turn took — written by `generate`, outside the per-turn reset, so a refinement can inherit
it), **`agentEscalationUsed`** (the `knowledge`→`agent` handoff budget, reset per turn).
`pendingConfirmation` is dropped — `action`'s `book` branch returns a templated link with
no confirmation step, and `mail` is deterministic.

---

## 5. Graph design — robust

**Structured output with a deterministic fallback, everywhere it drives control flow.**
Router, intent, decompose and rerank all use `.withStructuredOutput(zodSchema)` at
temperature 0, and each has a defined failure path:

| Call | On failure |
|---|---|
| router | low-confidence path (behavior recorded in Decisions, Phase 1) |
| decompose | `[query]` |
| rerank | input order |
| intent | deterministic taxonomy fallback (the old repo's unprotected call is a bug — see `OLD_REPO_MAP.md` §10.36) |

**Per-turn reset.** `runTurn` resets the per-turn fields in its invoke input —
`route`, `documents`, `statsPayload`, `searchResults`, `finalAnswer`, `error`. Without
this the checkpointer leaks the previous turn's documents and answer into this one.
Persistent across turns: `messages`, `slots`, `pendingConfirmation`, `activeFlow`,
`summary`.

**Error boundary.** `graph.js` wraps **every** node with one small `withErrorBoundary`.
It logs with `runId`/`sessionId`/`node`, sets `error` plus a graceful `finalAnswer`, and
lets flow continue to `generate` (which passes the answer through). **The API never 500s
because a node threw.**

**Retries live in exactly one layer:** the outbound call (Gemini, OpenAI, GitHub, LeetCode,
search, calendar, email). No node-level retries stacked on top of client-level retries.

**Everything is bounded.** A timeout on every outbound call; per-agent `maxSteps`; a graph
`recursionLimit`; a per-run wall-clock cap; a max input message length; and history sent to
models capped at N turns, with `summary` populated only once history exceeds that cap.

**Side effects only in tools, enforced in code — not by prompting.**

- `action`'s `mail` branch sends deterministically and idempotently per session/intent —
  no agent decides whether to send.
- The email recipient comes from `config.js` and is **never a tool argument** — the
  `send_email` tool schema has no recipient field, so no prompt injection can redirect it.
- `action`'s `book` branch has no calendar integration or tool at all — it returns a
  templated, hosted scheduling link. There is no confirmation step to guard.
- Tool isolation is by what `TOOLSETS` binds, never by asking a model not to use something.

**Sticky active flow.** `activeFlow` remains in state for any node that spans turns. The
old `book_catchup`/`send_mail` design used it for multi-turn slot-filling; `action`'s
`book` and `mail` branches are now single-turn and deterministic, so whether either still
needs stickiness is a Phase 9 decision, not assumed here.

**Testable offline.** `buildGraph` takes injected nodes and dependencies, so `test/agent/`
exercises the whole graph with fake models and fake services — no network, no keys.

---

## 6. HTTP layer

Thin by rule: **validate → call → respond.** A handler parses and validates its body with
zod, calls exactly one function from `agent/`, `stats/` or `documents/`, and shapes the
response. Any `if` that encodes a product decision belongs one layer down.

- `app.js` owns middleware order, mounting, and a single error handler. Error responses
  carry a message and a code — **never a stack trace** (the old repo returned stacks to
  callers; see `OLD_REPO_MAP.md` §10.17).
- `auth.js` owns the shared `password` header check and the rate limiters. One
  implementation, applied where needed.
- One URL per route. No aliases, no double mounts.
- `/health` stays dependency-free — it is the Docker `HEALTHCHECK` target.
- The chat endpoint keeps the old path `POST /api/v1/moonmind/chat` and the same password
  header, so the frontend's cutover is a base-URL change and nothing else.

---

## 7. Configuration

`src/config.js` is the **only** module that reads `process.env`. It parses and validates
with zod at boot, **fails fast** with a readable message naming the offending variable,
freezes the result, and exports it. Everything else imports `config`.

- Prefixes: `MONGO_` for storage, `GEMINI_` for embeddings, `MOONMIND_` for everything
  MoonMind-specific.
- Per-role model variables stay independent (they exist so the reranker or decomposer can
  run on a cheaper model without touching the others): `MOONMIND_ROUTER_MODEL`,
  `MOONMIND_INTENT_MODEL`, `MOONMIND_RESPONSE_MODEL`, `MOONMIND_RERANK_MODEL` (falls back
  to RESPONSE), `MOONMIND_DECOMPOSE_MODEL` (falls back to INTENT). Default `gpt-4o-mini`.
- `.env.example` is updated in the same commit as any new variable. It carries **names and
  shapes only — never a real value**.
- No secret is ever written into a doc, a log line, a test fixture, or a commit.

`src/db.js` owns **one** `MongoClient` (not strict-API, so `$vectorSearch` works) and
exports named collection getters. No module constructs its own client, and no collection
name is hardcoded outside `config.js`.

---

## 8. Testing

`test/` mirrors `src/` and runs under `node --test` with no network and no API keys.

- Pure logic (RRF, ranker, truncation, taxonomy, `resolve_time`) gets direct unit tests.
- Graph behavior is tested through `buildGraph` with injected fake nodes/models: routing,
  the error boundary, per-turn reset, flow stickiness, and tool binding per agent.
- Live checks (parity, retrieval overlap, eval questions) live in `scripts/` and write
  their output to `docs/evals/`. They are run deliberately, not on every `node --test`.

---

## 9. Deploy

Unchanged in shape from the old service, different in every identifier: an always-on Docker
container on an Oracle Cloud Ubuntu VM behind Nginx, `restart: unless-stopped`, built and
pushed to GHCR by GitHub Actions, pulled by the VM. Not serverless — a long agentic run can
just run.

**Never hardcode a VM path.** The old API uses `~/api-deploy`; this service gets its own
folder, container name, host port and subdomain, all confirmed with Ayan at the Phase 0
gate.

Also decide deliberately, rather than inheriting the gap: the old `/refresh` cron lived in
`vercel.json` and died with it, so nothing currently schedules a GitHub stats refresh.

---

## 10. Explicitly out of scope

Keep it simple. None of these get built:

- Supervisor or multi-agent hierarchies.
- One agent that can see every tool.
- Hand-rolled agent loops (use the prebuilt helper chosen in Phase 1).
- Plugin registries or DI containers.
- Custom event buses (the graph's own `.stream()` is the event source).
- TypeScript or ESM migration.
- Mandatory LangSmith.

And, standing: **LangChain and LangGraph are one stack, adopted together from the first
line of code.** Dropping or deferring LangGraph is not an option to propose.
