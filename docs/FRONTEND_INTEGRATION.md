# Frontend integration brief — MoonMind on portfolio-api-v2

Hand this to the frontend repo. Every shape below was captured from a live run of the API
on 2026-09-15, not written from memory.

---

## 0. Context

The portfolio backend has been rewritten. **The GitHub and LeetCode stats endpoints are
unchanged and need no frontend work** — `/api/v1/github`, `/api/v1/leetcode/:username` and
`/api/v1/refresh` keep their old paths, auth and response shapes exactly.

Only MoonMind chat changes. The old pipeline was a single request that returned a finished
answer. The new one is an agent graph: a router classifies the question, one of nine
branches answers it, and the whole thing takes between 2 and 25 seconds depending on the
route. That latency is why there is now a live event feed — the user should watch it work
rather than stare at a spinner.

**Base URL:** `https://api.portfolio.moonman.in`
**Auth:** every MoonMind endpoint needs a `password: <MOONMIND_PASSWORD>` request header.
Same header name and same value the old API used — no change.
**CORS:** `localhost:3000`, `localhost:5173`, `moonman.in`, `new.moonman.in` and the
Netlify/Vercel preview origins are already allowed, and `password` is an allowed header.

---

## 1. What you are building

1. Migrate the chat response shape (`data.summary` → `data.answer`).
2. Track `runId` and `sessionId` per conversation.
3. Poll `GET /runs/:runId?since=` for live agent steps.
4. Render those steps as the answer is being produced.
5. Ship all of it without breaking any existing UI component or flow.

**Use `POST /runs` as the only chat path.** Do not call `/chat` and `/runs` for the same
question — each call runs the graph independently and costs a full set of model and search
calls. `/chat` remains available and supported, but the feed endpoint returns a superset of
what it returns, including the same `documents`.

---

## 2. The endpoints

### `POST /api/v1/moonmind/runs` — ask a question

Request:

```json
{ "message": "What are Ayan's main backend skills?", "sessionId": "optional-existing-id" }
```

- `message` — required, 1–4000 characters. `prompt` is accepted as an alias for the old
  field name, so you can migrate the key separately from everything else.
- `sessionId` — optional. **Omit it on the first message of a conversation and the server
  mints one.** Send the same value on subsequent messages to continue the thread.
- `metadata` — the old API accepted this and used it as a retrieval filter. The new API
  **silently ignores it.** Stop sending it.

Response — `202 Accepted`, returned while the graph is still running:

```json
{
  "status": "success",
  "data": {
    "runId": "a3d9678c-77fb-4e61-8274-38f47bbd1f3e",
    "sessionId": "7507806b-b70d-4978-92ec-1641a392e8aa"
  }
}
```

### `GET /api/v1/moonmind/runs/:runId?since=<seq>` — poll it

`since` is the highest `seq` you already hold; omit or send `0` to get everything from the
start. Each response returns only the steps after that cursor.

```json
{
  "status": "success",
  "data": {
    "runId": "a3d9678c-...",
    "sessionId": "7507806b-...",
    "status": "running",
    "question": "What are Ayan's main backend skills?",
    "route": null,
    "answer": null,
    "error": null,
    "documents": [],
    "documentIds": [],
    "documentCount": 0,
    "startedAt": "2026-09-15T16:59:27.889Z",
    "finishedAt": null,
    "steps": [
      { "seq": 1, "node": "router", "type": "start", "ts": "2026-09-15T16:59:28.091Z", "summary": "" },
      { "seq": 2, "node": "router", "type": "end", "ts": "2026-09-15T16:59:30.903Z",
        "summary": "route=about_me confidence=0.90 slots=cancelsActiveFlow" }
    ],
    "nextSince": 2
  }
}
```

- `status` — `running` | `done` | `failed`. **Poll until it is not `running`.**
- `route` / `answer` / `documents` — `null` or empty until the run finishes.
- `nextSince` — send this back as `since` on the next poll. It does not move when nothing
  new arrived, so it is always safe to echo.
- All timestamps are ISO 8601 strings.

### `POST /api/v1/moonmind/chat` — the one-shot path (unchanged behaviour, new shape)

Still supported. Same request body as `/runs`. Returns `200` with the finished answer:

```json
{
  "status": "success",
  "data": {
    "sessionId": "...", "runId": "...", "route": "about_me",
    "answer": "<markdown>", "documents": [ ... ]
  }
}
```

Use it only where a live feed makes no sense.

### Errors

Every error is `{ "status": "error", "message": "...", "code": "..." }` with no stack
trace — the old API leaked stacks in its 500 bodies; this one does not.

| Status | `code` | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Missing/oversized `message`, non-UUID `runId`, negative `since` |
| 401 | `UNAUTHORIZED` | Missing or wrong `password` header |
| 404 | `RUN_NOT_FOUND` | Unknown `runId`, **or a run older than 7 days** (see §6) |

---

## 3. Migrating the response shape

This is the only genuinely breaking change, and it is small.

| Old | New |
|---|---|
| `data.summary` | `data.answer` |
| `data.documents` | `data.documents` — **identical shape, no change** |
| — | `data.sessionId`, `data.runId`, `data.route` are new |

`documents` entries carry exactly the keys they did before:

```
id, title, category, tags, content_full, metadata,
score, semantic_score, retrieval_sources, rrf_score, retrieval_score, boost_score
```

`summary_for_embedding` is stripped, `content_full` is always present (`null` when the
document has none). **If your UI renders documents today, that code needs no changes.**

Routes that do not retrieve — `stats`, `tech_web`, `refusal`, `list_capabilities` — return
an empty `documents` array. Your source panel should already handle that; the old API
returned `[]` for a no-match query too.

---

## 4. Rendering the live steps

### Step vocabulary

Each step is `{ seq, node, type, ts, summary }`.

`type` is one of:

| `type` | Meaning |
|---|---|
| `start` | A node began. `summary` is always `""`. |
| `end` | A node finished. `summary` carries derived counts. |
| `tool` | One tool call completed, e.g. a web search. |
| `error` | A node failed. **The run still produces an answer** — see §5. |

`node` values you will see today:

| `node` | Suggested label |
|---|---|
| `router` | Understanding your question |
| `about_me` | Searching Ayan's portfolio |
| `about_me.prepare` | Preparing the search |
| `about_me.retrieve` | Retrieving documents |
| `about_me.to_state` | Collecting results |
| `stats` | Fetching GitHub & LeetCode stats |
| `stats_and_docs` | Fetching stats and portfolio |
| `tech_web` | Researching on the web |
| `tech_web.scope_check` | Checking the topic |
| `generate` | Writing the answer |
| `refusal` / `list_capabilities` | Preparing a response |

**Treat this list as open-ended.** More nodes land in later backend phases
(`book_catchup`, `send_mail`, `complex`, and their sub-steps). A node name you do not
recognise must render with a humanised fallback — e.g. title-case the segment after the
last `.` — never blank and never a crash.

A dotted name like `about_me.retrieve` is a sub-step of the node before the dot. Nest it,
or indent it, but do not treat it as a peer of `about_me`.

### `summary` strings

`summary` is deliberately terse and is **derived**, not prose. Observed forms:

```
route=about_me confidence=0.90 slots=cancelsActiveFlow
documents=10
stats=github+leetcode
stats=github unavailable=1
candidates=5 answer=1353 chars
web_search -> 5 results
```

It never contains document text, tool arguments or prompts. It is a debug affordance.
Show it in a muted/secondary style, or behind a "details" toggle — **the primary label
should come from the `node` map above, not from `summary`.**

### Real examples

`about_me`, 7.7 seconds end to end:

```
 1 start  router
 2 end    router               route=about_me confidence=0.90 slots=cancelsActiveFlow
 3 start  about_me
 4 start  about_me.prepare
 5 end    about_me.prepare
 6 start  about_me.retrieve
 7 end    about_me.retrieve    documents=10
 8 start  about_me.to_state
 9 end    about_me.to_state    documents=10
10 end    about_me             documents=10
11 start  generate
12 end    generate             answer=1124 chars
```

`tech_web`, 20.1 seconds end to end:

```
 1 start  router
 2 end    router                 route=tech_web confidence=0.90 slots=cancelsActiveFlow
 3 start  tech_web
 4 start  tech_web.scope_check
 5 end    tech_web.scope_check
 6 tool   tech_web               web_search -> 5 results
 7 end    tech_web               candidates=5 answer=1353 chars
 8 start  generate
 9 end    generate               answer=...
```

Note `tech_web.scope_check` ends with an empty `summary` — that is expected, not a bug.

---

## 5. Behaviour you must handle

**An `error` step does not mean the run failed.** Every node is wrapped in an error
boundary: a failing node emits an `error` step, and the graph continues to `generate` and
still returns a usable answer. Render the step as a warning if you like, but **do not**
abort polling or show a failure state — wait for `status`.

**`status: "failed"` still carries an answer.** `data.answer` will hold graceful copy and
`data.error` will be `{ node, message }`. Show the answer. `data.error` is for your
console, not for the user.

**Out-of-scope questions return normally.** Ask about medical, legal or financial advice,
politics, religion or trading and the backend blocks the web search and answers with
"That one's beyond what MoonMind covers…". This arrives as an ordinary `status: "done"`
with `route: "tech_web"` and zero documents. It is not an error state.

**Timing.** Measured: `about_me` ≈ 8s, `tech_web` ≈ 20s. `stats` is faster. The server-side
hard cap is 120s, after which the run is closed as `failed`.

---

## 6. Polling rules

- Poll every **800ms–1s**. Do not poll faster: `/runs` is not rate-limited yet, and a tight
  loop is a self-inflicted denial of service.
- Always send `since=<last nextSince>` so each poll returns only new steps. Append, do not
  replace — you will otherwise re-render the whole list every tick.
- **Stop when `status !== "running"`.**
- Give up after ~150 polls (≈2 minutes, matching the server cap) and show a timeout state.
- Stop polling when the component unmounts or the user navigates away. Use an
  `AbortController`.
- On a transient network error, retry with backoff rather than abandoning the run — the run
  continues server-side regardless of whether you are listening.
- **Runs are retained for 7 days**, then deleted. A `runId` persisted in `localStorage` and
  polled later will 404. Treat `RUN_NOT_FOUND` as "this conversation's trace has expired",
  not as an error worth surfacing.

---

## 7. Session continuity — a genuine new capability

The old API accepted `sessionId` and **ignored it**; there was no conversation memory of
any kind. The new backend checkpoints conversation state per `sessionId`, so follow-up
questions work ("what about his frontend work?" after an answer about backend).

- Keep `sessionId` in component state for the life of the conversation.
- Persist it in `sessionStorage` if you want it to survive a reload; clear it on "new chat".
- `runId` is **per message**, not per conversation. Keep the current one for polling and
  optionally retain it per message so a user can re-open that message's step trace.

---

## 8. Non-breakage requirements

This is point 5 of the brief and the one most likely to go wrong.

- The stats widgets must not be touched. They consume unchanged endpoints.
- Existing chat components — message list, markdown renderer, document/source panel,
  loading states — should be **extended, not replaced**. The steps panel is additive.
- The step feed should degrade to the existing loading state if polling fails: the answer
  still arrives, and a broken feed must never block it.
- Keep the answer rendering path identical. Only its source field changes
  (`summary` → `answer`).
- If the app is server-rendered, the polling loop is client-only.

---

## 9. Acceptance criteria

1. Asking a question about Ayan returns an answer with its source documents rendered
   exactly as before the migration.
2. Steps appear progressively while the answer is being produced, in `seq` order, with no
   duplicates and no gaps.
3. A tech question shows a `tool` step for the web search.
4. A follow-up question on the same `sessionId` demonstrably uses conversation context.
5. Polling stops on completion, on unmount, and at the timeout cap.
6. An unknown future `node` name renders with a readable fallback label.
7. GitHub and LeetCode widgets are untouched and still work.
8. No console errors, no leaked intervals.

---

## 10. Quick reference

```
BASE = https://api.portfolio.moonman.in/api/v1/moonmind
HEADERS = { "Content-Type": "application/json", "password": <MOONMIND_PASSWORD> }

POST {BASE}/runs                      -> 202 { data: { runId, sessionId } }
GET  {BASE}/runs/{runId}?since={seq}  -> 200 { data: { status, answer, documents, steps, nextSince, ... } }
POST {BASE}/chat                      -> 200 { data: { answer, documents, sessionId, runId, route } }
```

Interactive docs: **`/api/docs`**. Machine-readable spec: **`/api/openapi.json`** — point
your client generator at it rather than hand-writing types.

There is also a working reference implementation of the whole polling loop, in plain
dependency-free JS, at **`/run-viewer.html`** on the API host. It is a backend test page,
not a design reference, but the fetch/cursor/stop logic is exactly what you need.
