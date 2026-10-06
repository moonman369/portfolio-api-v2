# Frontend integration brief — MoonMind on portfolio-api-v2

Hand this to the frontend repo. Every shape below was captured from a live run of the API,
not written from memory — the endpoint shapes on 2026-09-15, and the step vocabulary in §4
re-captured on 2026-09-17 after the backend collapsed its route taxonomy from ten labels to
seven. **If you have an older copy of this file, §3, §4 and §5 changed.** Since
2026-09-23 responses also carry `sources` (§3); since 2026-09-25 they carry `mail`, and
**§11 is new work**: booking and messaging Ayan, including the browser-side send.

---

## 0. Context

The portfolio backend has been rewritten. **The GitHub and LeetCode stats endpoints are
unchanged and need no frontend work** — `/api/v1/github`, `/api/v1/leetcode/:username` and
`/api/v1/refresh` keep their old paths, auth and response shapes exactly.

Only MoonMind chat changes. The old pipeline was a single request that returned a finished
answer. The new one is an agent graph: a router classifies the question into one of seven
routes, that branch answers it, and the whole thing takes between 2 and 25 seconds
depending on the route. That latency is why there is now a live event feed — the user
should watch it work rather than stare at a spinner.

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
    "sources": [],
    "mail": null,
    "startedAt": "2026-09-15T16:59:27.889Z",
    "finishedAt": null,
    "steps": [
      { "seq": 1, "node": "router", "type": "start", "ts": "2026-09-15T16:59:28.091Z", "summary": "" },
      { "seq": 2, "node": "router", "type": "end", "ts": "2026-09-15T16:59:30.903Z",
        "summary": "route=knowledge confidence=0.90 slots=cancelsActiveFlow" }
    ],
    "nextSince": 2
  }
}
```

- `status` — `running` | `done` | `failed`. **Poll until it is not `running`.**
- `route` / `answer` / `documents` / `sources` / `mail` — `null` or empty until the run
  finishes.
- `mail` — `null` on every turn except two in the message-Ayan flow: a confirm card to
  show, or a Web3Forms request for the browser to send. **See §11 — this one needs code.**
- `nextSince` — send this back as `since` on the next poll. It does not move when nothing
  new arrived, so it is always safe to echo.
- All timestamps are ISO 8601 strings.

### `POST /api/v1/moonmind/chat` — the one-shot path (unchanged behaviour, new shape)

Still supported. Same request body as `/runs`. Returns `200` with the finished answer:

```json
{
  "status": "success",
  "data": {
    "sessionId": "...", "runId": "...", "route": "knowledge",
    "answer": "<markdown>", "documents": [ ... ], "sources": [ ... ], "mail": null
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

Routes that do not retrieve — `agent`, `refusal`, `capabilities`, `greeting`, `action` —
return an empty `documents` array. Your source panel should already handle that; the old
API returned `[]` for a no-match query too.

Two notes on which routes populate it:

- **`stats` sometimes does.** A pure numbers question ("how many repos?") returns no
  documents; a mixed one ("my github stats *and* my projects") returns both the numbers and
  a full `documents` array. Do not key your source panel on the route name — key it on
  `documents.length`.
- **`agent` never does — its citations are in `sources` instead.** The agent researches
  with tools rather than writing to `documents`. Since 2026-09-23 both `/chat` and the run
  feed carry a `sources` array: web results and the portfolio documents the agent looked
  up, **each entry with the same keys as a `documents` entry** so your existing renderer
  works on it, plus `kind` (`"web"` | `"document"`) and `url`. A web result's link is also
  at `metadata.external_links.source`, where document links already live. A document
  entry carries only `id` and `title` — the rest are empty. `sources` is `[]` for every
  route that does not run the agent. To show one panel for both: render
  `[...documents, ...sources]`.

---

## 4. Rendering the live steps

This section is the complete step vocabulary. Every value listed is exhaustive as of
2026-09-17 unless it says otherwise, and every trace at the end is a real captured run.

Each step is `{ seq, node, type, ts, summary }`.

### 4.1 `type` — exactly four values

There are four and there will only ever be four; the backend validates against this list.

| `type` | Meaning |
|---|---|
| `start` | A node or sub-step began. `summary` is **always** `""`. |
| `end` | It finished. `summary` carries derived counts — see §4.5. |
| `tool` | One tool call completed. Emitted on completion only; there is no matching `start`. |
| `error` | A node threw, or a tool failed. **The run still produces an answer** — see §5. |

### 4.2 `node` — the graph nodes

Every run begins with `router` and ends with `generate`. Exactly one branch runs between
them — with one exception, below. Each of these emits `start`, then `end` **or** `error`.

**The escalation (since 2026-09-23).** A `knowledge` question that retrieval cannot fully
answer — one that asks about the market, "latest", "today", or that the portfolio barely
matches — hops once to `agent`. The run then reads
`router → knowledge → escalation → agent → generate`, `route` stays `"knowledge"`, and the
answer comes with both `documents` (what `knowledge` found) and `sources` (what the agent
found). It happens at most once per question. Label `escalation` something like
"Looking further" and let the `agent` step that follows keep its usual label.

| `node` | When it runs | Suggested label |
|---|---|---|
| `router` | Always, first | Understanding your question |
| `knowledge` | Questions about Ayan — skills, projects, experience, timeline | Searching Ayan's portfolio |
| `stats` | GitHub/LeetCode numbers, optionally with portfolio documents | Fetching GitHub & LeetCode stats |
| `agent` | Tech/industry questions needing research | Researching |
| `action` | Booking a call (a Calendly link) or messaging Ayan (a confirmed flow — §11) | Preparing a response |
| `refusal` | Off-topic or unsafe requests | Preparing a response |
| `capabilities` | "What can you do?" | Preparing a response |
| `greeting` | A bare "hey" with no question | Saying hello |
| `escalation` | Between `knowledge` and `agent`, when a portfolio question needs more (see above) | Looking further |
| `generate` | Always, last | Writing the answer |

There is one more you are very unlikely to see: **`tech_web`**, a retired label kept alive
so conversations started before the taxonomy change still resolve. It runs the same code as
`agent`. Label it identically if it ever appears.

### 4.3 `node` — named sub-steps

A dotted name is a sub-step of the node before the dot. **Nest or indent it — do not treat
it as a peer.** These emit `start` and `end` only, never `tool` or `error`.

| `node` | Parent | Suggested label |
|---|---|---|
| `knowledge.prepare` | `knowledge` | Preparing the search |
| `knowledge.retrieve` | `knowledge` | Retrieving documents |
| `knowledge.to_state` | `knowledge` | Collecting results |
| `agent.scope_check` | `agent` | Checking the topic |

That is the complete list today. A node opts into the feed by naming an internal step, so
later backend phases may add more — always in `parent.child` form.

### 4.4 `tool` steps

A `tool` step carries the **owning branch** in `node`, not the tool. So a web search during
research arrives as `node: "agent"`, and the tool's identity is the first token of
`summary`. In practice only `agent` emits these.

Four tools exist, all read-only:

| Tool | What it does |
|---|---|
| `web_search` | Public web search |
| `semantic_search` | Ayan's portfolio documents, by meaning |
| `metadata_filter` | Ayan's portfolio documents, by date/domain/status |
| `resolve_time` | Turns "last year" into a date range. No I/O |

If you want per-tool labels ("Searching the web" vs "Reading the portfolio"), parse the
token before `->`. Fall back to a generic "Using a tool" for a name you do not recognise —
more tools may be added.

### 4.5 `summary` — the grammar

`summary` is **derived**, never prose, and clipped to 200 characters. It is a debug
affordance: show it muted, or behind a details toggle. **The primary label must come from
the `node` maps above, not from parsing this.**

| `type` | Shape | Real examples |
|---|---|---|
| `start` | always `""` | |
| `end` | space-joined `key=value` pairs | `route=knowledge confidence=0.90 slots=cancelsActiveFlow` |
| | | `documents=15` · `answer=1212 chars` |
| | | `documents=15 stats=requested+github` |
| | | `candidates=5 answer=1990 chars` |
| | | `documents=15 escalate=needs_current` (on `knowledge`) · `escalations=1` (on `escalation`) |
| `tool` | `<tool> -> <result shape>` | `web_search -> 5 results` · `resolve_time -> 0 results` |
| `error` | the error message | `retrieval exploded` · `web_search -> no result` |

The keys that can appear in an `end` summary, in this order: `route`, `confidence`,
`slots` (**key names only, never values**), `candidates`, `documents`, `stats`,
`answer=N chars`, `escalate` (`weak_retrieval` | `needs_current`), `escalations`.

**Three `end` steps legitimately have an empty `summary`** — these are not bugs, do not
render them as failures:

- `knowledge.prepare` and `agent.scope_check` — their output carries no reportable field.
- `generate` — whenever the branch already produced the answer, which is every templated
  route (`greeting`, `refusal`, `capabilities`, `action`) and `agent`. For `knowledge` and
  `stats`, `generate:end` reads `answer=N chars`.

### 4.6 What a step never contains

Guaranteed by a whitelist in the backend, not by convention: no document text, no tool
arguments (not even the model's search query), no prompts, no model output beyond a
character count, and **no slot values** — only slot key names, because values are the
visitor's own words. You cannot reconstruct the answer from the feed; read `data.answer`.

### 4.7 Real traces

Captured 2026-09-17. `knowledge`, 11.5s:

```
 1 start  router
 2 end    router               route=knowledge confidence=0.90 slots=cancelsActiveFlow
 3 start  knowledge
 4 start  knowledge.prepare
 5 end    knowledge.prepare
 6 start  knowledge.retrieve
 7 end    knowledge.retrieve   documents=15
 8 start  knowledge.to_state
 9 end    knowledge.to_state   documents=15
10 end    knowledge            documents=15
11 start  generate
12 end    generate             answer=1212 chars
```

`agent` with a web search, 8.0s — note the `tool` step is attributed to `agent`:

```
 1 start  router
 2 end    router               route=agent confidence=0.90 slots=cancelsActiveFlow
 3 start  agent
 4 start  agent.scope_check
 5 end    agent.scope_check
 6 tool   agent                web_search -> 5 results
 7 end    agent                candidates=5 answer=1990 chars
 8 start  generate
 9 end    generate
```

`stats` for a mixed "my github stats and my projects", 8.4s — one node, both halves, and
`documents` is populated:

```
 1 start  router
 2 end    router               route=stats confidence=0.90 slots=which,withDocuments,cancelsActiveFlow
 3 start  stats
 4 end    stats                documents=15 stats=requested+github
 5 start  generate
 6 end    generate             answer=1069 chars
```

`greeting`, 1.6s — the shortest possible run, and a good one to test your empty-summary
handling against:

```
 1 start  router
 2 end    router               route=greeting confidence=1.00 slots=cancelsActiveFlow
 3 start  greeting
 4 end    greeting             answer=85 chars
 5 start  generate
 6 end    generate
```

### 4.8 Rendering rules that follow from all this

- **Never crash on an unknown `node`.** Humanise the fallback: take the segment after the
  last `.`, replace `_` with spaces, title-case it. The route taxonomy has already changed
  once and will gain `action` properly in a later phase.
- **Never crash on an empty `summary`.** See §4.5.
- **Pair `start` with `end` or `error` by `node`,** not by adjacency — sub-steps interleave
  with their parent, and the parent's `end` arrives after all of its children's.
- **An `error` step is a warning, not a terminal state.** See §5.

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
with `route: "agent"` and zero documents. It is not an error state. In the feed it looks
like a run that ends right after `agent.scope_check` with no `tool` step — the guard stops
it before any search runs.

**Timing.** Measured 2026-09-17: `greeting` ≈ 1.6s, `stats` ≈ 8s, `agent` ≈ 8–10s,
`knowledge` ≈ 8–12s. `refusal` and `capabilities` are templated and return in about a
second. A research question that needs several tool calls can reach ~25s. The server-side
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
7. A `greeting` ("hey") renders cleanly despite two of its six steps having an empty
   `summary` — the shortest run, and the one most likely to expose a rendering assumption.
8. A mixed question ("my github stats and my projects") renders both the numbers and the
   source documents, on route `stats`.
9. GitHub and LeetCode widgets are untouched and still work.
10. No console errors, no leaked intervals.
11. The message-Ayan flow works end to end and a real email lands in Ayan's inbox — §11.9
    lists the cases.

---

## 10. Quick reference

```
BASE = https://api.portfolio.moonman.in/api/v1/moonmind
HEADERS = { "Content-Type": "application/json", "password": <MOONMIND_PASSWORD> }

POST {BASE}/runs                      -> 202 { data: { runId, sessionId } }
GET  {BASE}/runs/{runId}?since={seq}  -> 200 { data: { status, answer, documents, sources, mail, steps, nextSince, ... } }
POST {BASE}/chat                      -> 200 { data: { answer, documents, sources, mail, sessionId, runId, route } }
POST {BASE}/mail/{submissionId}/result  { status: "sent"|"failed", digest?, providerMessage? }
                                      -> 200 | 404 MAIL_NOT_FOUND | 409 MAIL_ALREADY_REPORTED
```

Interactive docs: **`/api/docs`**. Machine-readable spec: **`/api/openapi.json`** — point
your client generator at it rather than hand-writing types.

There is also a working reference implementation of the whole polling loop, in plain
dependency-free JS, at **`/run-viewer.html`** on the API host. It is a backend test page,
not a design reference, but the fetch/cursor/stop logic is exactly what you need.

---

## 11. Booking and messaging Ayan — implementation prompt (backend Phase 10, 2026-09-25)

**Paste everything from here to the end of the file into the frontend repo's session as the
task.** It is written to be complete on its own.

> You are extending the MoonMind chat UI in this repo. The backend (portfolio-api-v2) now
> answers two new kinds of request: booking a call with Ayan, and sending Ayan a message.
> Booking needs almost nothing from you. Messaging needs real code, because **the email is
> sent from the browser, not the backend**: Web3Forms, the mail provider, refuses
> server-side calls on its free plan, so the backend validates and composes the exact
> request, and your code POSTs it. Read all of this section before writing anything.
> Everything else in this file (§1-§10) still applies, and nothing here changes it.

### 11.1 Booking — render links properly, nothing else

A booking request ("can I book a call with Ayan on Tuesday?") comes back as an ordinary
answer on `route: "action"` with `mail: null`. The markdown contains the Calendly URL and
the bookable windows. Make sure links in answers are clickable and open in a new tab
(`target="_blank" rel="noopener noreferrer"`). That is all. The backend never knows
whether a booking happened, so do not show any "booked" state.

### 11.2 The message flow, as the visitor sees it

1. Visitor: "send a message to Ayan about a backend role" → answer asks for their email.
   `mail: null`.
2. Visitor types their address → answer echoes the exact message, and
   `mail = { type: "confirm", ... }`. **You show a confirm card** (§11.4).
3. Visitor clicks **Send** (or types "yes") → answer "Sending it to Ayan now…", and
   `mail = { type: "submit", ... }`. **You POST the payload to Web3Forms** (§11.5), then
   **report the outcome** to the backend (§11.6), then show the result.

Variants: if the first message already contains their address, step 2 comes straight
away. An unreachable address is declined in the answer text (they get one retry). "No" or
**Cancel** ends it. Every one of these arrives as a normal chat answer — only the two
`mail` values above need special handling.

### 11.3 The `mail` field — exact shapes

It appears on `GET /runs/:runId` (and `/chat`) under `data.mail`. It is `null` on every
other turn. Act on it **only once `status === "done"`**.

```json
{
  "type": "confirm",
  "display": "confirm_card",
  "to": "Ayan Maiti",
  "from": { "name": "Jane Doe", "email": "jane@example.com" },
  "subject": "A backend role",
  "body": "I'd like to talk to you about a backend role.",
  "replies": { "confirm": "yes", "cancel": "no" }
}
```

```json
{
  "type": "submit",
  "submissionId": "3f6c1b8e-9a1d-4b8e-8f0e-2c7d5e9a1b44",
  "endpoint": "https://api.web3forms.com/submit",
  "method": "POST",
  "headers": { "Content-Type": "application/json", "Accept": "application/json" },
  "body": "{\"access_key\":\"…\",\"subject\":\"A backend role\",\"from_name\":\"MoonMind — Jane Doe\",\"name\":\"Jane Doe\",\"email\":\"jane@example.com\",\"replyto\":\"jane@example.com\",\"message\":\"I'd like to talk to you about a backend role.\"}",
  "digest": "<sha-256 hex of body>"
}
```

`from.name` may be `null`. Treat an unknown `type` as `null` (ignore it) — more may come.

### 11.4 The confirm card (`type: "confirm"`)

- **Render the card instead of the answer's markdown** for that message. The answer text
  is the same content as plain markdown, and is only the fallback for clients without a
  card. Showing both duplicates the message.
- Show **To**, **From** (name and address, or just the address), **Subject** and **Body**,
  exactly as given. Render the body as **plain text with preserved whitespace**
  (`white-space: pre-wrap`), not as markdown. The visitor is approving these exact bytes,
  and a markdown renderer would change what they see.
- Two buttons: **Send** and **Cancel**. Clicking one **sends `replies.confirm` or
  `replies.cancel` as the next chat message**, through the normal `POST /runs` path, as
  though the visitor had typed it. It appears in the conversation like any message. Do not
  call any other endpoint here: the backend's flow is driven by that message.
- Typing "yes" or "no" instead must keep working, because it goes through the same path.
- **Only the latest card is live.** Disable both buttons once either is clicked, once any
  newer message is sent, and on any card rendered from history (a reload, a re-opened
  session). A stale **Send** must never be clickable.

### 11.5 Sending (`type: "submit"`) — exactly once, byte for byte

```js
async function submitMail(mail) {
  let status = "failed";
  let providerMessage;
  try {
    const response = await fetch(mail.endpoint, {
      method: mail.method,
      headers: mail.headers,
      body: mail.body, // the string as given — never JSON.parse + JSON.stringify it
    });
    const json = await response.json().catch(() => ({}));
    if (response.ok && json.success === true) {
      status = "sent";
    } else {
      providerMessage = json.body?.message ?? json.message ?? `HTTP ${response.status}`;
    }
  } catch (error) {
    providerMessage = `network: ${error.message}`;
  }
  const digest = await sha256Hex(mail.body); // of the exact string you sent
  return { status, digest, providerMessage };
}

async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

Rules, all of them important:

- **Send `mail.body` unchanged.** Do not parse it, re-serialise it, add fields, remove
  fields, or put an access key from your own env into it. It already carries everything,
  including the (public-by-design) Web3Forms key. It has **no recipient field**, and must
  never gain one: Web3Forms delivers to the inbox bound to that key, which is the whole
  guarantee.
- **Exactly once per `submissionId`.** The feed keeps returning the same finished run on
  every poll, React may run effects twice, and a reload or a re-opened `runId` returns the
  same `mail` again. Record each `submissionId` you have acted on (a `useRef` set plus
  `localStorage`) and skip any you have seen. Sending twice means Ayan gets two emails, and
  the backend cannot stop it.
- **Never retry automatically.** A failed POST may still have been delivered. Report the
  failure and let the visitor ask again, which starts a fresh, capped flow.
- Web3Forms answers `200 {"success":true,...}` on success, `400 {"success":false,"body":
  {"message":…}}` on a bad request, `429 {"success":false,"message":…}` when rate-limited,
  and `500` on its own failure. The code above handles all four. If spam protection
  (hCaptcha) is ever switched on in the Web3Forms dashboard, this flow will fail until it is
  handled here. Leave it off unless you add that.

### 11.6 Reporting the outcome — always, even on failure

```
POST {BASE}/mail/{submissionId}/result
headers: { "Content-Type": "application/json", "password": <MOONMIND_PASSWORD> }
body:    { "status": "sent" | "failed", "digest": "<sha-256 hex>", "providerMessage": "…" }
```

- `200` → recorded. `409 MAIL_ALREADY_REPORTED` → already recorded; treat as success and do
  not retry. `404 MAIL_NOT_FOUND` → log it; nothing to show.
- `providerMessage` only on failure, at most 300 characters. `digest` is optional but send
  it: the backend checks it against what it issued, and a mismatch is how a payload changed
  in transit shows up.
- This report is the **only** way the backend learns whether mail was delivered. If it
  fails (network), retry it with backoff. That is safe: it is idempotent server-side.
  Retrying the report is fine; retrying the send is not.

### 11.7 What the visitor sees afterwards

Under the "Sending it to Ayan now…" answer, show a small status line once §11.5 finishes:

- sent → "Sent ✓ — Ayan will reply to jane@example.com" (the `email` inside `mail.body`)
- failed → "Couldn't send your message (reason). Nothing was delivered — please try again
  later." Keep the reason short, and never show a raw stack.

While the POST is in flight, show a spinner on that line, not on the whole chat.

### 11.8 Things to leave alone

- The steps feed: the mail flow produces ordinary `router` / `action` / `generate` steps.
  No new node names.
- Caps (3 messages per session, 5 per IP per 24h) are enforced by the backend when it
  issues a payload. The visitor just gets an answer saying so. Do not add a client-side
  limiter.
- `sources` and `documents` are empty on every `action` turn.

### 11.9 Acceptance — run every one against the live API

1. **Book:** "Can I book a call with Ayan on Tuesday afternoon?" → a clickable Calendly
   link, the windows, no card, no "booked" state.
2. **Full flow:** "send a message to Ayan about a backend role" → asked for an email →
   give a real one → confirm card with the exact subject and body → **Send** → status line
   "Sent ✓" → **the email is in Ayan's inbox, and replying to it goes to that address.**
3. **Email-first:** "Pass a note to Ayan about a backend role, my email is <real address>"
   → the confirm card comes straight away.
4. **Typo'd address:** give `someone@gmial.cmo` → a polite "doesn't look like it can
   receive email" and one retry; a second bad address ends it. No card, no send.
5. **Someone else's address:** "send this to someone@else.com: …" → told it can only go to
   Ayan; after confirming, the email arrives in **Ayan's** inbox only.
6. **Cancel:** click **Cancel** (or type "no") on the card → "I haven't sent anything", no
   POST in the network tab.
7. **Exactly once:** after a successful send, reload the page and re-open the conversation.
   **No second POST to api.web3forms.com** (check the network tab), and the old card's
   buttons are disabled.
8. **Failure path:** block `api.web3forms.com` in devtools, then send → the failure line
   appears, and the backend receives `status: "failed"`. Unblock → no automatic resend.
9. **Cap:** a 4th message in one session → the answer says the limit is reached; no card.
10. **Typing works too:** do flow 2 by typing "yes" instead of clicking.
