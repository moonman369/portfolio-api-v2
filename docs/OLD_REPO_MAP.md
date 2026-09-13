# OLD_REPO_MAP — behavior map of Portfolio-Stats-API

**This is a map of what the old service *does*, not a structure to replicate.**
The new repo's shape is `docs/ARCHITECTURE.md`. Read this document for contracts,
algorithms, and traps; read ARCHITECTURE.md for where the rewrite puts them.

- **Source:** https://github.com/moonman369/Portfolio-Stats-API, branch `master` (there is no `main`).
- **Snapshot read:** `a0bc0e4` — *Merge pull request #54 from moonman369/feature/moonmind-retrieval-revamp*.
- **Local read-only clone:** `../Portfolio-Stats-API-ref`. **Never modify it.**
- **Stack:** Node 22, CommonJS, Express 4, MongoDB Atlas (`$vectorSearch`), zod, axios, dotenv. No AI framework anywhere.

---

## 1. Process and entry point

`api/index.js` is the single entry (`node api/index.js`; also `npm start` / `npm run build`, and `nodemon api/index.js` for `dev`).
The `api/` folder name is a leftover of the abandoned Vercel target — it is not a serverless function.

What it does, in order:

1. `require("dotenv").config()`.
2. `app.set("trust proxy", 1)` — one proxy hop (Nginx + Certbot in front).
3. `express.json({ limit: "1mb" })`.
4. CORS with an explicit origin allowlist: `https://devfoliomoonman369.netlify.app`, `https://moonman.in`, `https://moonman.in/`, `https://new.moonman.in`, `https://new.moonman.in/`, `http://localhost:3000`, `http://localhost:5173`, `https://portfolio-2-sigma-bice.vercel.app/`. Methods `GET, POST, PUT, DELETE, OPTIONS`; allowed headers `Content-Type, Authorization, password`; `credentials: true`.
5. Mounts routers (see below).
6. `app.listen(port)` — `PORT` env, default `8000` — and **only then** `await connectToDatabase()` inside the listen callback (the server accepts traffic before Mongo is confirmed up).
7. Graceful shutdown on `SIGTERM`/`SIGINT`: `server.close()`, forced `process.exit(1)` after a 10s unref'd timer.

**Mount table (`api/index.js`)**

| Mount path | Router |
|---|---|
| `/api/v1/leetcode` | `src/routes/leetcode.js` |
| `/api/v1/github` | `src/routes/github.js` |
| `/api/v1/refresh` | `src/routes/refresh.js` |
| `/api/v1/chat` | `src/routes/chat.js` |
| `/api/v1/moonmind` | `src/routes/moonmind.js` (which itself calls `router.use(moonmindMemoryRoutes)`) |
| `/api/v1` | `routes/moonmindMemoryRoutes.js` — **the same router, mounted a second time** |

---

## 2. Every HTTP route

Auth vocabulary used below:

- **none** — public.
- **`password` header** — `src/middleware/moonmindPasswordAuth.js`. Compares the `password` request header (first value if the header repeats) by strict `===` against `MOONMIND_PASSWORD.trim()`, falling back to `REFRESH_SECRET.trim()` when the former is empty. `500 ConfigurationError` if neither is set; `401 UnauthorizedError` on mismatch. Not constant-time.
- **`secret` query param** — `/refresh` only; `req.query.secret !== process.env.REFRESH_SECRET` → `401`.

| # | Method | Path | Auth | Caching |
|---|---|---|---|---|
| 1 | GET | `/health` | none | none |
| 2 | GET | `/` | none | 302 → `/api/docs` |
| 3 | GET | `/api/docs` | none | Swagger UI (`swagger-jsdoc` + `swagger-ui-express`) |
| 4 | GET | `/api/v1/github` | none | read-through of a Mongo cache document; no TTL |
| 5 | GET | `/api/v1/leetcode/:username` | none | in-process `memory-cache`, 1 h TTL |
| 6 | GET | `/api/v1/refresh` | `secret` query param | writes the GitHub cache document |
| 7 | POST | `/api/v1/chat` | `password` header | none |
| 8 | POST | `/api/v1/moonmind/chat` | `password` header (checked twice — see note) | none |
| 9 | POST | `/api/v1/moonmind/createDoc` **and** `/api/v1/createDoc` | `password` header | none |
| 10 | POST | `/api/v1/moonmind/bulkCreateDoc` **and** `/api/v1/bulkCreateDoc` | `password` header | none |
| 11 | PUT | `/api/v1/moonmind/updateDoc` **and** `/api/v1/updateDoc` | `password` header | none |
| 12 | DELETE | `/api/v1/moonmind/deleteDoc` **and** `/api/v1/deleteDoc` | `password` header | none |
| 13 | POST | `/api/v1/moonmind/documents/embeddings/regenerate` **and** `/api/v1/documents/embeddings/regenerate` | `password` header + rate limit | none |
| 14 | POST | `/api/v1/moonmind/documents/:id/embedding` **and** `/api/v1/documents/:id/embedding` | `password` header + rate limit | none |

> **Double-mount note.** `routes/moonmindMemoryRoutes.js` is mounted twice: once inside `src/routes/moonmind.js` via `router.use(...)` (giving the `/api/v1/moonmind/*` paths) and once directly at `/api/v1` in `api/index.js`. Every ingestion route therefore answers on **two** URLs. Side effect: because the memory router calls `router.use(requireMoonMindPassword)` at its top and then falls through, `POST /api/v1/moonmind/chat` runs the password check **twice**.
>
> **Rate limiter:** `express-rate-limit`, `windowMs` 15 min, `limit` 10, `standardHeaders: "draft-7"`, `legacyHeaders: false`, custom `message` body `{status:"error", message:"Too many embedding requests, please retry later", error:{name:"RateLimitError"}}`. Applied only to routes 13 and 14. One module-level instance, so both mount paths share one budget.

### 2.1 `GET /health`

Response `200`:

```json
{ "status": "ok", "uptime": 1234.56, "timestamp": "2026-07-11T13:00:00.000Z" }
```

Dependency-free — also the Docker `HEALTHCHECK` target (`wget -qO- http://localhost:8000/health`).

### 2.2 `GET /api/v1/github`

- Handler: `getGithubStats()` → `mongo.js: getStats()` → `db.collection("gitStatsArchive").findOne({ _id: "github_stats" })`.
- The DB name comes from `MONGO_DB_NAME`; the collection name `gitStatsArchive` and the document `_id` `github_stats` are **hardcoded in `mongo.js`**.
- Response `200` is the raw Mongo document, or `null` if never refreshed:

```json
{ "_id": "github_stats", "stats": { "repos": 106, "commits": 1854, "pulls": 45, "stars": 238 } }
```

- Errors → `500 { "status": "error", "message": "Server Error" }`.
- **Caching:** pure read-through. Nothing refreshes it except route 6. No TTL, no staleness signal — the numbers are as old as the last `/refresh`.
- **Contract divergence:** the Swagger schema `GithubResponse` declares an **array** of objects with an ObjectId-shaped `_id`; the code returns a **single object** with the string `_id` `github_stats`. Trust the code.

### 2.3 `GET /api/v1/leetcode/:username`

- `username` is a required path param. `statsService.js` has a default (`LEETCODE_USERNAME` env, else the literal `moonman369`) but this route always passes the path param, so the default only applies to the internal MoonMind stats call.
- Cache: `memory-cache`, key `leetcode:<username>`, TTL `1000 * 60 * 60` ms (1 h). In-process only — dies with the container, not shared across replicas.
- On miss, two parallel `axios.post` calls to `https://leetcode.com/graphql/`:
  - `userSessionProgress` → `allQuestionsCount { difficulty count }` + `matchedUser.submitStats.acSubmissionNum { difficulty count submissions }`
  - `userPublicProfile` → `matchedUser.profile.ranking`
- Response `200`:

```json
{
  "status": "success", "username": "moonman369",
  "totalSolved": 219, "totalQuestions": 3491,
  "easySolved": 121, "totalEasy": 867,
  "mediumSolved": 94, "totalMedium": 1813,
  "hardSolved": 4, "totalHard": 811,
  "ranking": 512680
}
```

- The mapping is **positional**: `acSubmissionNum[0..3]` and `allQuestionsCount[0..3]` are assumed to be All/Easy/Medium/Hard in that order. No `difficulty` field is checked. If LeetCode reorders the array, the numbers silently swap.
- Any failure (including an unknown username, which returns `matchedUser: null`) throws and becomes `500 { "status": "error", "message": "Server Error" }`.

### 2.4 `GET /api/v1/refresh`

- Query: `secret` (required, must equal `REFRESH_SECRET`), `useWorker` (optional, string `"true"`/`"false"`).
- `401 { "message": "You are not authorized to perform this action" }` when `secret` mismatches. **The rejected `req.query` is `console.debug`'d** — a submitted secret lands in the logs.
- On success: preflight `GET https://api.github.com/users/<REFRESH_PROFILE>` with `Authorization: Bearer <GITHUB_PAT>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
  - No `REFRESH_PROFILE` → `500 { "message": "Username not found" }`.
- Then either:
  - `useWorker=true` → `worker.postMessage([username, "test"])` and immediate `200 { "message": "Refresh worker has been triggered successfully..." }`. **This is a lie.** `refresh_worker.js`'s `parentPort.on("message", ...)` handler is commented out, so the worker receives the message and does nothing. Nothing is refreshed.
  - otherwise → inline `await refreshStats([username, "test"])`, status `200` on `{status:"success"}` else `500`, body:

```json
{ "status": "success", "message": "Refresh success", "elapsed": 8123,
  "totalRepos": 106, "totalCommits": 1854, "totalStars": 238, "totalPulls": 45 }
```

- `new Worker("./refresh_worker.js")` is constructed on **every** request, before the branch that would use it is chosen, and is never `terminate()`d — one leaked thread per call.
- The `"test"` element of the params array is never read.

**`refresh_worker.js: refreshStats(params)`** — the actual work:

- Paginates `POST https://api.github.com/graphql` (100 repos/page, `after` cursor) for `ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]`, `isFork: false`, ordered `CREATED_AT DESC`, selecting `name, visibility, stargazers.totalCount, pullRequests(states:[OPEN,CLOSED,MERGED]).totalCount, defaultBranchRef.target.history.totalCount`.
- Totals: `totalRepos = allRepos.length` (**not** `repositories.totalCount`), summed stars, summed PR counts, summed default-branch commit counts (repos with no `defaultBranchRef` contribute 0).
- Writes via `mongo.js: setStats` → `updateOne({_id:"github_stats"}, {$set:{stats:{repos,commits,pulls,stars}}}, {upsert:true})`.
- Argument-order trap: `setStats(repos, commits, pulls, stars)` is called as `setStats(totalRepos, totalCommits, totalPulls, totalStars)` — correct, but the local variable declaration order (`stars` before `pulls`) differs from the parameter order.
- On error it **returns** `{status:"error", message: <Error object>, elapsed}` rather than throwing; the route turns that into a `500` whose `message` serializes to `{}`.

### 2.5 `POST /api/v1/chat` and `POST /api/v1/moonmind/chat`

Both call the same `runMoonMind`. `/api/v1/chat` is the older path; `/api/v1/moonmind/chat` is the one the LLD targets. The two handlers are near-duplicates (the `/chat` one adds three extra `debugLog` calls).

Request body:

```json
{ "prompt": "What projects has Ayan built using RAG?",
  "sessionId": "8f2b0c1e-...",
  "metadata": { "verified": true } }
```

- `prompt` — required, non-empty string. Anything else → `MoonMindError("Prompt is required", {code:"INVALID_INPUT"})` → `400`.
- `sessionId` — accepted, logged, threaded into `extractIntent`, and **otherwise unused**. There is no conversation memory of any kind.
- `metadata` — optional flat object. Every non-empty entry becomes an equality clause `metadata.<key> === <value>` on the metadata retrieval arm. Unvalidated: any key reaches the Mongo filter.

Response `200`:

```json
{ "status": "success",
  "data": { "summary": "<markdown>", "documents": [ /* see below */ ] } }
```

`documents` come from `pipeline.js: buildResponseDocuments` — the ranked documents with `summary_for_embedding` **stripped** and `content_full` forced to exist (`null` when absent). All internal scores (`score`, `rrf_score`, `semantic_score`, `retrieval_score`, `boost_score`, `retrieval_sources`) **are** returned to the caller.

Errors:

- `MoonMindError` → `400 { status, message, details, error }`
- anything else → `500 { status:"error", message:"Server Error", details, error }`

`error` is `serializeError(err)` and **includes the full stack trace** in the HTTP response.

### 2.6 Ingestion routes (`routes/moonmindMemoryRoutes.js`)

All authenticated with the `password` header. All responses omit the `embedding` array from the returned document (`omitEmbedding`).

Shared error mapping (`serializeRouteError`): Mongo duplicate key (`11000` or an `E11000` message) → `409 ConflictError`; `ValidationError` → `400`; `NotFoundError` → `404`; `EmbeddingError` → `502`; `RateLimitError` → `429`; anything else → `500`.

| Route | Body | Success |
|---|---|---|
| `POST createDoc` | one `VectorDocumentPayload` | `201 { status:"ok", data }` |
| `POST bulkCreateDoc` | non-empty **array** of payloads | `201` all-ok; `207 {status:"partial", data, errors}` mixed; else the single shared error status (or `500` when the failures have mixed statuses) |
| `PUT updateDoc` | full `VectorDocumentPayload` (not a patch) | `200 { status:"ok", data }` |
| `DELETE deleteDoc` | `{ "id": "<uuid>" }` | `200 { status:"ok", data:{ id, deleted:true } }` |
| `POST documents/embeddings/regenerate` | `{ "onlyMissing": true }` (optional; must be boolean) | `200` ok / `207` partial / `502` when `updated === 0 && failed > 0`. Data: `{ onlyMissing, processed, updated, failed, failures[] }` |
| `POST documents/:id/embedding` | none; `:id` is a UUID | `200 { status:"ok", data:{ id, dimensions, updated_at } }` |

`bulkCreateDoc` is strictly sequential (`for` + `await`) — no batching, one Gemini call per document — and is **not** rate-limited, even though it fans out to the same paid API the rate-limited routes protect.

---

## 3. `src/moonmind/*` — what each file does

### `index.js`
Two-line shim: `runMoonMind({prompt, sessionId, metadata})` → `runMoonMindPipeline({query: prompt, sessionId, metadata})`. Exists only to rename `prompt` → `query`.

### `pipeline.js` — the orchestrator
**In:** `{query, sessionId, metadata}`. **Out:** `{status:"success", data:{summary, documents}}`. Mints a `requestId` (`crypto.randomUUID()`) used only for logging.

Flow:

1. Reject empty `query` (`MoonMindError`).
2. `detectStatsQuery(query)` (regex, below).
3. If GitHub or LeetCode detected → fetch that one source.
   - Fetch failure **and** pure stats → early return `{summary:"Unable to fetch stats at the moment", documents:[]}` with **no LLM call**.
   - Fetch failure **and** mixed → drop `statsPayload` to `null` and continue to retrieval.
   - Success **and** pure stats → skip retrieval entirely, call `generateResponse` with `documents: []`, `intent: "stats_query"`, and return.
   - Success **and** mixed → fall through with `statsPayload` set.
4. `retrieveAndRank`: optional decompose → per-sub-query (`extractIntent` → `retrieveDocuments`) under `Promise.all` → `unionDocuments` (only when >1 sub-query) → `rankDocuments` → optional `rerankDocuments` → slice to `FINAL_DOCUMENT_LIMIT`.
5. `generateResponse` with `intent = statsPayload ? "stats_query" : primaryIntent`.

Only one stats source is ever fetched per turn: `isGithub` wins over `isLeetcode` in the ternary, so *"compare my GitHub and LeetCode"* returns GitHub only.

`unionDocuments(groups)` — dedupe by `id`; **sums** `rrf_score` across sub-queries (a doc relevant to several sub-questions is boosted), takes `max` of `semantic_score`, and prefers whichever copy actually carries `content_full`.

`buildResponseDocuments(documents)` — strips `summary_for_embedding`, guarantees a `content_full` key.

Candidate-pool sizing: when `RERANK_ENABLED`, `rankDocuments` gets `max(RERANK_CANDIDATES, FINAL_DOCUMENT_LIMIT)` so the reranker has something to reorder; otherwise just `FINAL_DOCUMENT_LIMIT`.

### `statsRouter.js` — regex router (**do not port**)
`detectStatsQuery(prompt)` → `{isGithub, isLeetcode, isPureStats}`.

- `hasStatsIntent` = the lowercased prompt contains any of `"stats"`, `"profile"`, `"moonman"`, `"ayan"`.
- `isGithub` = contains `"github"` **and** `hasStatsIntent`; `isLeetcode` likewise for `"leetcode"`.
- `isPureStats` = `(isGithub || isLeetcode)` and the prompt does **not** match `PORTFOLIO_INTENT_PATTERN` (`skills?|tech stack|projects?|experiences?|work|role|certifications?|certificates?|education|degree|university|college|achievements?|awards?|research|papers?|publications?|hobbies?|interests?|about (me|him|ayan)|who is|tell me about`).

Consequences: *"how many GitHub repos do I have?"* is **not** a stats query (no intent word); *"ayan's profile"* alone matches neither source; the substring `"profile"` in `hasStatsIntent` makes any mention of a profile a stats trigger when paired with `github`/`leetcode`. This whole file is replaced by the LLM router.

### `statsService.js`
- `getGithubStats()` — a one-line pass-through to `mongo.js: getStats()`. **No live GitHub call on the read path.**
- `getLeetcodeStats(username = LEETCODE_USERNAME || "moonman369")` — as §2.3. The default username is captured **at module load**, so changing the env at runtime has no effect.
- No error handling: transport failures and `matchedUser: null` both throw a `TypeError` out of the destructuring.

### `planning/queryDecomposer.js` — LLM call, optional
- Flag `DECOMPOSE_ENABLED` (default **false**). Model `MOONMIND_DECOMPOSE_MODEL` → `MOONMIND_INTENT_MODEL` → `gpt-4o-mini`.
- `response_format: {type:"json_object"}`, `temperature: 0`. Asks for `{"subqueries": ["..."]}`, at most `DECOMPOSE_MAX_SUBQUERIES` (default 3), each standalone and keyword-rich with pronouns resolved; single-topic questions must come back unchanged.
- `normalizeSubqueries`: keeps strings only, trims, dedupes, slices to max. Empty → `[originalQuery]`.
- **Fallback:** any throw or parse failure → `[query]`. Never breaks the pipeline.

### `intentExtractor.js` — LLM call #1 (+ conditional #2)
- Model `MOONMIND_INTENT_MODEL` → `gpt-4o-mini`, `json_object`, `temperature: 0`.
- `INTENT_SYSTEM_PROMPT` frames the model as an *"intent compiler… Your job is NOT to interpret freely"* and hard-codes: `semantic` always true, `keyword` always false, `metadata` true when a domain is detected, `filters.domain` must contain the detected domain, never a null domain for portfolio queries.
- Output normalized by `normalizeIntentPayload` into `DEFAULT_INTENT_PAYLOAD`'s shape: `{intent, retrieval_plan{semantic,keyword,metadata}, entities{skills,projects,certifications,organizations,dates{from,to}}, domain, subcategories, requires_retrieval, filters{domain, time_range}}`. `intent` is clamped to `question|greeting|chat`.
- **Then the LLM's own taxonomy is thrown away.** `inferDeterministicIntentTaxonomy(query)` runs a local regex table (`DOMAIN_RULES`, 9 patterns → domain; `SUBCATEGORY_RULES`, 21 patterns → subcategory) plus three "no retrieval needed" patterns (`GREETING_ONLY_PATTERN`, `CASUAL_ONLY_PATTERN`, `META_ONLY_PATTERN`). Its result **overwrites** `normalized.domain`, `.subcategories`, `.requires_retrieval`.
- LLM call #2 (`extractTaxonomyIntentWithLLM`) fires **only** when the regex table produced neither a domain nor any subcategory. It asks for `{domain, subcategories, requires_retrieval}` against the real enums and returns `null` (keeping the deterministic result) on any parse failure.
- Post-conditions re-applied: if retrieval is required but no arm is on, force `semantic: true`; if retrieval is not required, force all three arms off; if a domain survived, ensure it is in `filters.domain`.
- **Fallback:** none for call #1 — an empty completion or unparseable JSON **throws** and fails the whole request. This is the only LLM call in the pipeline without a fallback.

### `retrievalEngine.js` — the three arms + fusion
`retrieveDocuments({query, intentPayload, metadata, limit})` runs whichever arms `retrieval_plan` enables, each capped at `max(limit, 10)`, under `Promise.all`, then `fuseByRRF`.

- **semantic** → `retrieval/vectorSearch.js` (below). Keeps the raw Atlas score as `score`.
- **keyword** → Mongo `find`. `buildKeywordQuery` splits `query + entity terms + filters.domain` on whitespace, drops tokens ≤ 3 chars, dedupes, and ORs a case-insensitive `$regex` per token across `title`, `tags`, `content_full`, `summary_for_embedding`. Unanchored regex over full documents, no text index — a collection scan. In practice this arm **never runs**, because the intent prompt hard-codes `keyword: false`.
- **metadata** → Mongo `find`. `buildMetadataQuery` `$and`s: `filters.domain` matched against either `metadata.domain` **or** `category` (the singular/plural mismatch means the `category` half almost never hits), the singular `intentPayload.domain`, `metadata.subcategory $in subcategories`, per-entity regex ORs across `title/category/tags/metadata.domain/metadata.subcategory`, a date-range clause over the **string** `metadata.date_start`/`date_end` (lexicographic ISO comparison — works only because the dates are zero-padded ISO), and one equality clause per caller-supplied `metadata` key.
- An arm whose query object is empty is skipped and returns `[]`.
- `normalizeDocument` projects each hit down to `{id, title, category, summary_for_embedding, content_full, metadata{...}}`, nulls out any `metadata.domain` not in `ALLOWED_DOMAINS` (with a `console.warn`), and coerces `subcategory` to a string array. **`tags` is requested in the Mongo projection but dropped by `normalizeDocument`** — so `tags` never reaches the reranker or the sanitizer.
- `Promise.all` (not `allSettled`): one failing arm fails the whole retrieval.

### `retrieval/vectorSearch.js`
`vectorSearch(query, limit)`:

1. `generateQueryEmbedding(query)` (query template — see §5).
2. `connectToDatabase({apiStrict:false})` — Atlas Search stages are rejected under a strict-API client, hence the second connection.
3. Aggregation:

```js
{ $vectorSearch: { index: VECTOR_INDEX_NAME, queryVector, path: VECTOR_FIELD,
                   numCandidates: Math.max(limit * 5, VECTOR_NUM_CANDIDATES), limit } }
{ $project: { _id:0, id:1, title:1, category:1, summary_for_embedding:1,
              content_full:1, metadata:1, score: { $meta: "vectorSearchScore" } } }
```

`score` is the Atlas cosine score, `(1 + cos)/2` in `[0,1]`. No `filter` clause is used, so metadata pre-filtering is not applied at the ANN stage. **`tags` is not projected here at all.** Errors are logged and rethrown.

### `ranking/rrf.js` — Reciprocal Rank Fusion (pure, portable)
`fuseByRRF(resultSets, {k, weights})`:

```
rrf_score(doc) = Σ_arm  weight_arm * 1 / (k + rank_arm(doc))     // rank is 1-based
```

- `k` = `RRF_K` (default 60). Weights per arm: semantic 1, keyword 1, metadata 0.5 (all env-tunable). An unknown source defaults to weight 1.
- Records `retrieval_sources[source] = rank`, carries the max raw semantic score through as `semantic_score`, prefers the copy with `content_full`, and rounds `rrf_score` to 8 decimals.
- Deterministic, no LLM. **Eligible for near-verbatim carry-over.**

### `ranker.js` — deterministic editorial ranking (pure, portable)
`rankDocuments(documents, limit, options)`:

1. Optional gate: drop anything with `semantic_score < MIN_SEMANTIC_SCORE` (default 0 = off). Documents found only by the metadata arm have `semantic_score` 0 and are therefore dropped outright once this gate is enabled.
2. `boost = impactWeight * clamp01(impact_score/100) + verifiedWeight * (verified ? 1 : 0)`; both weights default to 0.
3. `score = rrf_score + boost`, rounded to 8 decimals; `retrieval_score` and `boost_score` kept separately for logs.
4. Sort by `score` desc, tie-break `String(id).localeCompare`, slice to `limit`.

The config comments and `.env.example` disagree on the useful boost band (see §9). **Eligible for near-verbatim carry-over.**

### `ranking/llmReranker.js` — LLM call, optional
- Flag `RERANK_ENABLED` (default **false**). Model `MOONMIND_RERANK_MODEL` → `MOONMIND_RESPONSE_MODEL` → `gpt-4o-mini`. `json_object`, `temperature: 0`.
- Candidate pool = the first `RERANK_CANDIDATES` (default 20) documents. Each is shown as `{index, title, content: truncate(content_full || summary_for_embedding, 900), tags: tags.slice(0,12)}` — but `tags` was already stripped by `normalizeDocument`, so it is always `[]`.
- Asks for `{"order": [<index>, ...]}`, every index exactly once, best first.
- `parseOrder` keeps only valid, in-range, unseen integers and **appends any dropped indices** in original order, so nothing is lost.
- **Fallback:** ≤1 document, unparseable order, or any throw → the input order sliced to `limit`.

### `documentSanitizer.js`
`sanitizeDocumentsForLLM(documents)` → `[{title, content, tags, metadata?}]`.

- `content = content_full || summary_for_embedding || ""`.
- `metadata` filtered to `SAFE_METADATA_FIELDS` = `domain, subcategory, organization, proficiency_level, verified, date_start, date_end, completion_year, is_active` — deliberately **excluding `impact_score`** so the model can't quote it. Empty-string/null/undefined values are dropped; an all-empty metadata object is omitted entirely.
- `external_links` kept when it has at least one non-empty string entry; otherwise falls back to the legacy singular `external_link`.
- `tags` is passed through but is always `[]` for retrieved documents (stripped upstream).

### `responseGenerator.js` — LLM call, final answer
- Model `MOONMIND_RESPONSE_MODEL` → `gpt-4o-mini`, `temperature: 0`, **no `response_format`** (free-form markdown).
- System prompt: represent Ayan (aliases *Moonman, Moonman369, MightyAyan, Mr. Maiti, Ayan Maiti*); answer only from the provided documents; never mention `impact_score`, ranking, embeddings, retrieval, metadata field names, or internal JSON; never hallucinate; **never emit a generic refusal** — when nothing was retrieved, still answer helpfully and note that MoonMind has no matching supporting documents; greeting-only messages get a friendly greeting; `stats_payload.data` is the sole source of truth when present. Format rules: clean markdown, bullets/numbered lists, concise, bold item titles. Ends with `Current user intent: <intent>.`
- User message is `JSON.stringify({query, documents, stats_payload, no_documents_found}, null, 2)`.
- **Bug to fix in the rewrite:** the "today's date" line interpolates `Date.now()` — a raw epoch-millisecond integer, not a date. Any duration reasoning is done against a meaningless number.
- **Fallback:** none. Empty content throws.

### `adapters/openaiClient.js`
`createChatCompletion({model, messages, responseFormat, temperature})` → raw `fetch` `POST {OPENAI_BASE_URL}/v1/chat/completions` with `Authorization: Bearer ${OPENAI_API_KEY}`. `OPENAI_BASE_URL` defaults to `https://api.openai.com` and must **not** include `/v1`. Non-2xx → throw with status + body. **No timeout, no retry, no abort signal.** This whole file is what `ChatOpenAI` replaces.

### `adapters/geminiClient.js` — embeddings (behavior must survive the rewrite)
`embedText(text)` → `POST {GEMINI_BASE_URL}/v1beta/models/{EMBEDDING_MODEL}:embedContent`, header `x-goog-api-key`, body `{content:{parts:[{text}]}, output_dimensionality: EMBEDDING_DIMENSIONS}`, `signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)`.

- **One text per call, deliberately.** Batching several inputs into one `embedContent` returns a *single aggregated* vector, not one per input — silently wrong rather than an error.
- Guards: non-empty string input; `GEMINI_API_KEY` present; response contains `embedding.values`; **`values.length === EMBEDDING_DIMENSIONS` or throw** (so a wrong-length vector is never written by this path).
- Retry: attempts `0..GEMINI_MAX_RETRIES` inclusive. Retryable statuses `408, 429, 500, 502, 503, 504`, plus `TimeoutError`/`AbortError`. Backoff = `Retry-After` seconds when parseable, else `GEMINI_RETRY_BASE_MS * 2**attempt + random()*GEMINI_RETRY_BASE_MS`, capped at `GEMINI_MAX_BACKOFF_MS`.
- Error naming: HTTP 429 → `RateLimitError` (route maps to 429); everything else → `EmbeddingError` (route maps to 502).
- No client-side L2 normalization — `gemini-embedding-2` auto-normalizes truncated Matryoshka output. No `taskType` parameter; task intent lives in the prompt templates.

### `utils/debug.js`
`debugLog(step, payload)` — prints `[moonmind][debug] <step>` unless `MOONMIND_DEBUG === "false"` (i.e. **on by default**, including in production). `serializeError(error)` returns `{name, message, stack, code, details}` — the object that gets embedded in HTTP error responses.

### `utils/errors.js`
`class MoonMindError extends Error` with `details`. The only thing that produces a `400` from the chat routes.

---

## 4. `config/vectorConfig.js`

A frozen object built from `process.env` at require time, with parsers `parseSentenceBound`, `parseBooleanFlag` (`true/1/yes/on` vs `false/0/no/off`), `parsePositiveInt`, `parseUnitFloat` (`[0,1]`), `parseNonNegativeFloat`. Invalid values silently fall back to the default. Deliberately does **not** honour the legacy `MOONMIND_VECTOR_*` / `MOONMIND_DB_NAME` names.

Non-enum keys and defaults: `DB_NAME` `portfolio-stats-api`, `DOCUMENT_COLLECTION` `moonmind_documents_v3`, `METADATA_INDEX_COLLECTION` `moonmindMetadataIndex`, `VECTOR_INDEX_NAME` `vector_index`, `VECTOR_FIELD` `embedding`, `GEMINI_BASE_URL`, `GEMINI_API_KEY`, `EMBEDDING_MODEL` `gemini-embedding-2`, `EMBEDDING_DIMENSIONS` `768`, `GEMINI_TIMEOUT_MS` `30000`, `GEMINI_MAX_RETRIES` `5`, `GEMINI_RETRY_BASE_MS` `500`, `GEMINI_MAX_BACKOFF_MS` `20000`, `MAX_EMBEDDING_INPUT_CHARS` `28000`, `MAX_SUMMARY_CHARACTERS` `4000` (hardcoded, not env-driven), `SUMMARY_MIN_SENTENCES` `3`, `SUMMARY_MAX_SENTENCES` `max(min, 6)`, `ENFORCE_SUMMARY_SENTENCE_RANGE` `true`, `VECTOR_NUM_CANDIDATES` `150`, `RRF_K` `60`, `FINAL_DOCUMENT_LIMIT` `10`, `RETRIEVAL_CANDIDATE_LIMIT` `30`, `RRF_WEIGHT_SEMANTIC` `1`, `RRF_WEIGHT_KEYWORD` `1`, `RRF_WEIGHT_METADATA` `0.5`, `RANK_IMPACT_WEIGHT` `0`, `RANK_VERIFIED_WEIGHT` `0`, `MIN_SEMANTIC_SCORE` `0`, `RERANK_ENABLED` `false`, `RERANK_CANDIDATES` `20`, `DECOMPOSE_ENABLED` `false`, `DECOMPOSE_MAX_SUBQUERIES` `3`.

**Enums** (verbatim, verified by executing the module):

- `ALLOWED_CATEGORIES` — **9, singular**: `skill, certification, credential, education, experience, profile, project, hobby, topic`
- `ALLOWED_DOMAINS` — **9, plural**: `skills, projects, experience, profile, certifications, education, achievements, research, hobbies`
- `ALLOWED_PROFICIENCY_LEVELS` — **4**: `beginner, intermediate, advanced, expert`
- `ALLOWED_SUBCATEGORIES` — **78** values, no duplicates: `programming-language, backend, frontend, fullstack, database, devops, cloud, architecture, api-design, system-design, distributed-systems, security, testing, performance-optimization, data-engineering, machine-learning, generative-ai, rag, vector-databases, problem-solving, communication, teamwork, leadership, adaptability, creativity, critical-thinking, decision-making, time-management, ownership, ai, automation, api, search, chatbot, analytics, open-source, experimental, production-grade, scalable, high-performance, integration, enterprise-systems, microservices, computer-science, software-engineering, data-science, artificial-intelligence, mathematics, hackathon, competition, ranking, award, recognition, community, nlp, algorithms, experimentation, technical, non-technical, competitive-programming, writing, gaming, learning, ai-development, agent-sdk, prompt-engineering, llm, claude, anthropic, ai-agents, mcp, claude-api, data structures, practice, ai-evaluation, interview-preparation, full-stack, software-development`
- `CATEGORY_DOMAIN_MAP` (frozen) — `skill→skills, certification→certifications, credential→certifications, education→education, experience→experience, profile→profile, project→projects, hobby→hobbies, topic→research`

Three enum traps to carry into the rewrite as explicit rules:

1. **`achievements` is unreachable.** No category maps to it, so no document created through the validated path can ever have `metadata.domain === "achievements"` — yet `intentExtractor`'s `DOMAIN_RULES` happily classifies *"awards"*/*"ranking"* queries into it, and the metadata arm then matches nothing.
2. **`data structures`** contains a space while every other value is kebab-case — trivially mistyped as `data-structures`.
3. `fullstack` and `full-stack` both exist as separate values.

---

## 5. `utils/embeddingGenerator.js` — templates (**byte-fidelity required**)

Four exports; `generateDeterministicSummary` is a fallback summary builder used by `vectorMemoryService` when a payload omits `summary_for_embedding`.

**Document template** — `buildEmbeddingText(document)`:

```
title: <title> | text: <body>
```

- `<title>` = trimmed `document.title`, or the literal string `none` when missing/blank.
- `<body>` = `["Tags: " + tags.join(", ")` (omitted when `tags` is empty)`, summary_for_embedding.trim(), content_full.trim()]`, empties filtered out, joined with `"\n"`.
- Content goes **last** so overflow truncation eats `content_full`'s tail rather than the tags or summary.
- Budget = `MAX_EMBEDDING_INPUT_CHARS - prefix.length`, where `prefix = "title: " + title + " | text: "`. The budget therefore depends on the title's length.

**Query template** — `buildQueryEmbeddingText(query)`:

```
task: search result | query: <trimmed query>
```

Same truncation, prefix `"task: search result | query: "` (29 characters).

**Truncation** — `truncateToChars(text, maxChars)`:

- `maxChars <= 0` → `""`; `text.length <= maxChars` → unchanged.
- Otherwise slice to `maxChars`, take `lastIndexOf(" ")` within the slice; if that index is `> maxChars * 0.8`, cut there, else keep the hard slice. Then `.trimEnd()`.

These rules — the prefix strings, the `Tags: ` line, the `\n` joins, the 0.8 word-boundary threshold — determine every vector already sitting in Atlas. **Any drift silently degrades retrieval against the existing collection, with no error.**

---

## 6. Write path: `services/vectorMemoryService.js` + `validators/memoryValidator.js`

### `ensureStorage()` (once per process)
- Creates `moonmind_documents_v3` with `{validator: {$jsonSchema: vectorDocumentJsonSchema}, validationLevel: "strict", validationAction: "error"}` if absent, else `collMod`s the same validator onto it.
- Swallows a `collMod` `Unauthorized` (code 13) with a `console.error` and continues — **so on a restricted Atlas user the schema validator may not actually be installed.** A code comment elsewhere in the same file states `moonmind_documents_v3` currently has no validator.
- Indexes: unique `{id:1}` on both the document collection and `moonmindMetadataIndex`, plus a compound `{category, metadata.domain, metadata.verified, metadata.proficiency_level, metadata.date_end:-1, metadata.impact_score:-1}` on the metadata index.

### `createDocument(payload)`
`validateCreatePayload` → fill `summary_for_embedding` from `generateDeterministicSummary` if absent → `generateDocumentEmbedding` → transactional `insertOne` into both `moonmind_documents_v3` and `moonmindMetadataIndex`, with `created_at = updated_at = new Date().toISOString()`.

### `updateDocument(payload)`
Full replace, not a patch. Loads the existing doc (404 if absent), re-embeds **only** when `buildEmbeddingText(existing) !== buildEmbeddingText(next)` or the existing doc has no vector; preserves `created_at`; `replaceOne` in both collections inside a transaction, and skips the write entirely when `hasRetrievalRelevantChanges` finds no difference across `title, category, tags, content_full, summary_for_embedding, metadata`.

### `deleteDocument({id})`
Transactional delete from both collections; a missing entry in **either** raises `NotFoundError` and rolls back.

### `regenerateDocumentEmbedding(id)` / `regenerateAllEmbeddings({onlyMissing})`
- Both **skip `ensureStorage()` on purpose**: installing a strict validator mid-backfill would make each `updateOne` revalidate the whole document, so one legacy out-of-enum value would block its own re-embedding.
- Projection is exactly the fields `buildEmbeddingText` reads: `{_id:0, id:1, title:1, tags:1, summary_for_embedding:1, content_full:1}`.
- `onlyMissing` filter: `$or: [{embedding:{$exists:false}}, {embedding:null}, {embedding:{$size:0}}]`.
- Writes only `embedding` + `updated_at`. Strictly sequential (concurrency would hit Gemini's rate limit). Per-document failures are collected into `failures[]`, never thrown.
- `regenerateDocumentEmbedding` validates its `id` by calling **`validateDeletePayload({id})`** — a delete validator repurposed as a UUID check.

### `validators/memoryValidator.js` (zod, request-time)
`metadataSchema` (`.strict()`): `domain` enum; `subcategory` array of enum (default `[]`); `date_start`/`date_end` ISO datetime with offset, nullable + optional; `completion_year` int 1900–3000, nullable + optional; `verified` bool **required**; `proficiency_level` enum-or-null **required**; `organization` 1–160 chars or null **required**; `impact_score` 0–100 or null **required**; `is_active` bool **required**; `external_link` URL ≤512 or null, optional; `external_links` `Record<string, string(1..512)>`, nullable + optional.

`baseDocumentSchema` (`.strict()`, used for both create and update): `id` valid UUID; `title` 2–180; `category` enum; `tags` array of 1–64-char strings, max 50; `summary_for_embedding` 20–4000 chars **optional**; `content_full` string ≤25000 **or null, key required**; `metadata`.

Then, in order: `assertDomainEnum`, `assertSubcategoryEnum`, `assertDomainCategoryAlignment` (`metadata.domain === CATEGORY_DOMAIN_MAP[category]`), `assertDateConsistency` (`date_start <= date_end`), `assertNoProhibitedContent`, `assertSummaryConstraints`.

- `PROHIBITED_PATTERNS` (scanned across title + tags + summary + content + subcategory + organization, joined by `\n`): `sk-[a-zA-Z0-9]{20,}`, `api[_-]?key\s*[:=]`, `authorization\s*[:=]`, `bearer\s+[a-z0-9\-_.]+`, `system\s*prompt`, `ignore\s+previous\s+instructions`, `chain[-\s]?of[-\s]?thought`, `social\s+security`, `\b\d{3}-\d{2}-\d{4}\b`, `-----begin\s+private\s+key-----`. **A portfolio document about prompt engineering trips `system\s*prompt` and is rejected.**
- `assertSummaryConstraints` enforces 3–6 sentences **only when `content_full` is empty**, and only when `ENFORCE_SUMMARY_SENTENCE_RANGE`.
- `normalizeDocument` trims the title, **lowercases every tag**, trims the summary, and rebuilds metadata key by key.

---

## 7. Scripts and tests

- `scripts/reembed.js` — CLI backfill sharing `regenerateAllEmbeddings`. `--dry-run` prints the first 120 chars of each embedding input; `--only-missing` restricts to vectorless docs using a **narrower** filter than the service (`{embedding:{$exists:false}}` only). Exits 1 when anything failed.
- `scripts/eval/retrievalEval.js` — gold-set harness over `extractIntent → retrieveDocuments → rankDocuments`, reporting Recall@5, Recall@10, MRR and no-hit precision. Optional custom gold-set path as `argv[2]`.
- `scripts/eval/goldset.json` — **a template**: every `expected_ids` entry is the literal `"REPLACE_WITH_REAL_..._DOC_ID"`, and its comment still names the dead `moonmindVectorMemory` collection. The harness has never been run against real labels.
- `test/ranker.test.js`, `test/rrf.test.js` — `node:test`, the only two test files in the repo. `npm test` is `node --test`.

---

## 8. Deploy setup

**`Dockerfile`** — two stages on `node:22-alpine`. `deps`: `COPY package.json package-lock.json` then `npm ci --omit=dev`. `runtime`: copies `node_modules` from `deps` and the source with `--chown=node:node`, `USER node`, `EXPOSE 8000`, `HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://localhost:8000/health`, `CMD ["node", "api/index.js"]`. `NODE_ENV=production` in both stages.

**`docker-compose.yml`** — one service `api`, image `ghcr.io/moonman369/portfolio-stats-api:latest` (pulled, never built on the VM), `container_name: portfolio-stats-api`, `env_file: ./.env`, `dns: [8.8.8.8, 1.1.1.1]`, port bound to **loopback only** `127.0.0.1:8000:8000` (Nginx reverse-proxies to it, so no VM firewall rule is needed), `restart: unless-stopped`, the same healthcheck, `json-file` logging capped at `10m × 3`.

**`.dockerignore`** — excludes `node_modules`, `.env` / `.env.*` (re-including `.env.example`), `.git`, `.vercel`, `.claude`, `.vscode`, `.idea`, `docs/`, and the Docker files themselves.

**`.github/workflows/deploy.yml`** — triggers on `push` to `master` and `workflow_dispatch`. Job `build-and-push`: checkout → Buildx → GHCR login with `GITHUB_TOKEN` → `docker/metadata-action` tagging `latest` + `sha` (long) → `docker/build-push-action` with GHA cache (`mode=max`). Job `deploy` (needs the first): `appleboy/ssh-action` into the VM using secrets `VM_HOST`, `VM_USER`, `VM_SSH_KEY`; runs `cd ${{ secrets.VM_APP_DIR || '/opt/portfolio-stats-api' }}`, `docker login ghcr.io`, `docker compose pull`, `docker compose up -d`, `docker image prune -f`.

> The workflow's default `/opt/portfolio-stats-api` is **not** what is actually deployed — the live VM folder is `~/api-deploy`. The new service must get its own folder, container name, host port and subdomain; confirm all four with Ayan before writing the workflow (Phase 0 gate).

**`vercel.json` — stale, do not port.** It declares an `@vercel/node` build of `api/index.js`, a catch-all route, and a daily cron `0 0 * * *` hitting `/api/v1/refresh?secret=${REFRESH_SECRET}`. Nothing runs on Vercel. **Consequence worth deciding deliberately:** with the cron gone, nothing schedules `/refresh` any more — the GitHub stats document is only as fresh as the last manual call. Pick a replacement (host cron, a scheduled GitHub Actions workflow, or an in-process timer) rather than inheriting the gap.

**Runtime shape:** an always-on `node` process in Docker on an Oracle Cloud Ubuntu VM behind Nginx, `restart: unless-stopped`. Not serverless — no function timeout, no `waitUntil`, no `maxDuration` budget.

---

## 9. Every env var the old code reads — names only

45 names, read via `process.env` somewhere in the repo. **Values are never recorded in this repo.**

**Server** — `PORT`

**MongoDB** — `MONGO_URI`, `MONGO_DB_NAME`, `MONGO_VECTOR_COLLECTION`, `MONGO_METADATA_COLLECTION`, `MONGO_VECTOR_INDEX`, `MONGO_VECTOR_FIELD`

**GitHub / refresh** — `GITHUB_PAT`, `REFRESH_PROFILE`, `REFRESH_SECRET`

**LeetCode** — `LEETCODE_USERNAME`

**Gemini embeddings** — `GEMINI_BASE_URL`, `GEMINI_API_KEY`, `GEMINI_EMBEDDING_MODEL`, `GEMINI_EMBEDDING_DIMENSIONS`, `GEMINI_TIMEOUT_MS`, `GEMINI_MAX_RETRIES`, `GEMINI_RETRY_BASE_MS`, `GEMINI_MAX_BACKOFF_MS`, `GEMINI_MAX_INPUT_CHARS`

**OpenAI chat** — `OPENAI_BASE_URL`, `OPENAI_API_KEY`

**MoonMind auth / models** — `MOONMIND_PASSWORD`, `MOONMIND_INTENT_MODEL`, `MOONMIND_RESPONSE_MODEL`, `MOONMIND_RERANK_MODEL`, `MOONMIND_DECOMPOSE_MODEL`

**MoonMind summary rules** — `MOONMIND_SUMMARY_MIN_SENTENCES`, `MOONMIND_SUMMARY_MAX_SENTENCES`, `MOONMIND_ENFORCE_SUMMARY_SENTENCE_RANGE`

**Retrieval tuning** — `MOONMIND_VECTOR_NUM_CANDIDATES`, `MOONMIND_RRF_K`, `MOONMIND_FINAL_DOCUMENT_LIMIT`, `MOONMIND_RETRIEVAL_CANDIDATE_LIMIT`

**Ranking weights** — `MOONMIND_RRF_WEIGHT_SEMANTIC`, `MOONMIND_RRF_WEIGHT_KEYWORD`, `MOONMIND_RRF_WEIGHT_METADATA`, `MOONMIND_RANK_IMPACT_WEIGHT`, `MOONMIND_RANK_VERIFIED_WEIGHT`, `MOONMIND_MIN_SEMANTIC_SCORE`

**Feature flags / logging** — `MOONMIND_RERANK_ENABLED`, `MOONMIND_RERANK_CANDIDATES`, `MOONMIND_DECOMPOSE_ENABLED`, `MOONMIND_DECOMPOSE_MAX_SUBQUERIES`, `MOONMIND_DEBUG`

**Not `process.env` — GitHub Actions secrets** (deploy only): `VM_HOST`, `VM_USER`, `VM_SSH_KEY`, `VM_APP_DIR`, `GITHUB_TOKEN`.

**Documented as inert** in `.env.example`: any leftover `MOONMIND_VECTOR_*` / `MOONMIND_DB_NAME`. The config deliberately refuses to read them, because a stale `MOONMIND_VECTOR_COLLECTION=moonmindVectorMemory` would silently point the app at a dead collection and return zero results with no error.

Doc/config inconsistency worth noting: `.env.example`'s ranking-weight comment says the usable band is around `0.005` at `CANDIDATE_LIMIT=30`, while `config/vectorConfig.js`'s comment on the same constants says the crossover sits between `0.001` and `0.002` and to start at `0.0005`. Both cannot be right; re-measure before enabling either weight.

---

## 10. Leave behind — do **not** port any of this

**Files / whole subsystems**

1. `vercel.json` — stale serverless config for a target that isn't used.
2. `src/moonmind/statsRouter.js` — the regex router. The LLM router replaces it.
3. `src/moonmind/adapters/` — the adapter layer. `ChatOpenAI` replaces `openaiClient.js`; `geminiClient.js`'s *behavior* moves into `documents/embeddings.js`, but not as an "adapters" folder.
4. `src/routes/chat.js` — a near-duplicate of `src/routes/moonmind.js`. One chat route, not two.
5. The **double mount** of the ingestion router. One mount, one URL per route.
6. The `worker_threads` refresh path in `src/routes/refresh.js` + `refresh_worker.js` — the message handler is commented out, the `useWorker=true` success response is false, a Worker is constructed on every request and never terminated, and the params array carries a dead `"test"` element.
7. `moonmindMetadataIndex` — written and indexed on every create/update/delete, **never read by anything**. A second copy of every document kept in sync for no consumer. Drop it unless Ayan names a reader.
8. `swagger-jsdoc` + `swagger-ui-express` with schemas hand-duplicated in `src/swagger.js` and drifting from the code (`GithubResponse` is the clearest case). If API docs are wanted, generate them from the same zod schemas that validate.
9. `scripts/eval/goldset.json` as shipped — an unfilled template referencing a dead collection. Rebuild it with real ids or don't ship it.

**Structural pain points to not reproduce**

10. Two parallel hierarchies: top-level `config/`, `models/`, `routes/`, `services/`, `utils/`, `validators/` **and** `src/routes/`, `src/moonmind/`, `src/middleware/`, with `src/moonmind/utils/` nested inside. One tree, feature folders.
11. `api/index.js` as the entry point — a Vercel-shaped path for a long-running server. The new entry is `src/server.js`.
12. `process.env` read from a dozen modules at require time. One `config.js`, zod-validated, frozen.
13. **Two cached MongoClients** in `mongo.js` (strict and non-strict `serverApi`) because `$vectorSearch` is rejected under `strict: true`. One client, not strict.
14. `dns.setServers(["8.8.8.8","1.1.1.1"])` executed as an import side effect in `mongo.js`, mutating process-global DNS for everything.
15. `mongo.js` hardcoding `gitStatsArchive` and `github_stats` while every other name is env-driven.
16. `MOONMIND_DEBUG` defaulting to **on** (`!== "false"`), printing full prompts, raw LLM responses and sample documents to stdout in production.
17. Stack traces returned in HTTP error bodies (`serializeError` inside the 400/500 responses).
18. `console.debug(req.query)` on a failed `/refresh` auth — logs the attempted secret.
19. No timeout, retry or abort signal on any OpenAI, GitHub or LeetCode call (only Gemini has them). Everything outbound gets `AbortSignal.timeout` in the rewrite.
20. `Promise.all` across retrieval arms — one arm's failure kills the turn.

**Dead / inert code**

21. The **keyword retrieval arm**. The intent prompt hard-codes `keyword: false` and `normalizeIntentPayload` defaults it false, so `buildKeywordQuery` never runs — while `MOONMIND_RRF_WEIGHT_KEYWORD` still exists as a tuning knob for it.
22. The intent LLM's `domain` / `subcategories` / `requires_retrieval` output — computed, then unconditionally overwritten by the regex taxonomy. Roughly half of `INTENT_SYSTEM_PROMPT` (the whole domain-mapping and subcategory section) is inert. Its own subcategory list (`web`, `systems`, `internship`, `full-time`, `programming`) doesn't even intersect `ALLOWED_SUBCATEGORIES`, and its domain list omits `profile`.
23. `tags` in the retrieval projections — fetched from Mongo, then dropped by `normalizeDocument`, so the reranker's `tags` view and the sanitizer's `tags` field are always `[]`.
24. `metadata.external_link` (singular) alongside `external_links` (plural) — dual handling in the validator, normalizer and sanitizer. Pick one shape.
25. `refresh_worker.js`'s commented-out `parentPort.on("message")` block.
26. `LEETCODE_DEFAULT_USERNAME` captured at module load.

**Unused / replaceable dependencies**

27. `axios` → native `fetch` + `AbortSignal.timeout`.
28. `dotenv` → `node --env-file=.env`.
29. `memory-cache` → a ~15-line TTL Map; it is used for exactly one cache key.
30. `nodemon` → `node --watch`.
31. `swagger-jsdoc` / `swagger-ui-express` → see item 8.
32. `@types/node` as a devDependency in a repo with no TypeScript.
33. `uuid` → `crypto.randomUUID()` for generation, and a regex or zod's `.uuid()` for validation.

**Bugs to fix rather than reproduce**

34. `responseGenerator.js` interpolating `Date.now()` as "today's date".
35. `pipeline.js` fetching only one stats source per turn (`isGithub` wins), so *"compare GitHub and LeetCode"* silently drops half the question.
36. `intentExtractor.js`'s first LLM call having **no fallback** — the only unprotected LLM call, and it fails the whole request.
37. `statsService.js` mapping LeetCode difficulty buckets by array position, not by the `difficulty` field.
38. `mongo.js` connecting **after** `app.listen`, so the server answers before the DB is confirmed reachable.
39. `assertNoProhibitedContent`'s `system\s*prompt` pattern rejecting legitimate prompt-engineering portfolio documents.
40. The `achievements` domain being unreachable through `CATEGORY_DOMAIN_MAP` while the intent router can still classify into it.

---

## 11. Divergences from the LLD

Things the LLD (or the Phase 00 brief) states that the code contradicts or under-specifies. **Code wins; these are recorded so nobody re-derives them later.**

| # | LLD / brief says | Code actually says | Consequence |
|---|---|---|---|
| 1 | `ALLOWED_SUBCATEGORIES` is "~90 values" | **78** values | Use 78; the rewrite's `documents/taxonomy.js` is the single source. |
| 2 | The document validator is "enforced at the DB level, not just convention" | `ensureStorage()` catches a `collMod` `Unauthorized` and continues; a comment in the same file says `moonmind_documents_v3` **currently has no validator** | Treat DB-side enforcement as **not guaranteed**. Application-side `validateDocument()` is the real gate. |
| 3 | Chat entry is `POST /api/v1/moonmind/chat` | That path exists **and** so does `POST /api/v1/chat`, plus every ingestion route on two URLs | The rewrite ships one URL per route. |
| 4 | State includes `sessionId` and `messages` | `sessionId` is accepted and logged but never used; there is **no** conversation memory | Multi-turn is genuinely net-new, not a port. |
| 5 | Route `stats` = "reuse `statsService.js` as-is" | `getGithubStats()` reads a Mongo cache document and never calls GitHub; only `/refresh` talks to GitHub | The stats node returns cached numbers. Refresh scheduling is a separate, currently-unowned concern (see §8). |
| 6 | LLD §5 sample shows `date_start` / `created_at` / `updated_at` as dates | All three are **strings** in the JSON-schema validator and in the live document | Keep them as ISO strings, or migrate deliberately. |
| 7 | A clean 8-route taxonomy | `statsRouter.js` has a **third** state — mixed stats + portfolio — that the 8 routes cannot express | Phase 1 gate: decide how mixed queries route. |
| 8 | "keyword" is one of three retrieval arms | The arm is hard-coded off by the intent prompt and never executes | Decide in Phase 3a whether to revive it (with a real text index) or drop it. |
| 9 | Four independently overridable model env vars | Correct — and `MOONMIND_ROUTER_MODEL` does not exist yet; this rebuild adds it | New var, logged as a deviation. |
| 10 | `metadata.subcategory` drawn from one controlled vocabulary | True, but `fullstack`/`full-stack` and the space-containing `data structures` make it internally inconsistent | Preserve values exactly (existing documents use them); do not "tidy" the enum. |
| 11 | `embedding` must be exactly 768 numbers | The JSON-schema validator checks `bsonType` only — a wrong-length array writes fine and is silently unsearchable. The **Gemini client** is what actually enforces the length | The rewrite's `validateDocument()` must check `length === 768` explicitly. |
| 12 | Deployment folder unspecified | The workflow defaults to `/opt/portfolio-stats-api`; the live VM actually uses `~/api-deploy` | Never hardcode a VM path — gate on Ayan for the new service's folder, container name, port and subdomain. |
