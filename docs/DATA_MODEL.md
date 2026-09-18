# DATA_MODEL — the MoonMind document contract

The data contract for `moonmind_documents_v3`, reconciled line by line against the old
repo's real code: `models/vectorDocument.js` (the Mongo `$jsonSchema` validator),
`config/vectorConfig.js` (the enums), `validators/memoryValidator.js` (the request-time
zod schema) and `utils/embeddingGenerator.js` (the embedding templates).

**Rule used throughout: where the LLD/brief and the code disagree, the code wins.**
Every difference is recorded in §7.

---

## 1. Storage names — all env-driven, none hardcoded

| Thing | Value | Env var | Default in code |
|---|---|---|---|
| Database | `portfolio-stats-api` | `MONGO_DB_NAME` | `portfolio-stats-api` |
| Document collection | `moonmind_documents_v3` | `MONGO_VECTOR_COLLECTION` | `moonmind_documents_v3` |
| Vector field | `embedding` | `MONGO_VECTOR_FIELD` | `embedding` |
| Atlas vector index | `vector_index` | `MONGO_VECTOR_INDEX` | `vector_index` |
| Metadata mirror collection | `moonmindMetadataIndex` | `MONGO_METADATA_COLLECTION` | `moonmindMetadataIndex` |

The Atlas index's `numDimensions` is **768** and must equal `GEMINI_EMBEDDING_DIMENSIONS`.
Changing either without re-embedding the whole collection makes every document unsearchable.

> `moonmindMetadataIndex` is a full second copy of every document, written transactionally
> on create/update/delete and **read by nothing**. It is on the Leave-behind list
> (`OLD_REPO_MAP.md` §10.7). The rewrite does not carry it unless Ayan names a reader.

Existing indexes on the document collection: unique `{ id: 1 }`, plus the Atlas vector
index on `embedding`. There is no text index — which is why the old keyword arm was an
unindexed regex scan.

---

## 2. Canonical document shape

A real document from the live collection (embedding elided):

```json
{
  "_id": "ObjectId('69c941027a5f0b056647161f')",
  "id": "3341e59a-2a2f-4e8a-8aff-eb957e1ceeba",
  "title": "Ayan Maiti - Professional Resume Overview",
  "category": "experience",
  "tags": ["java", "springboot", "dotnet", "azure", "microservices", "generative-ai",
           "mulesoft", "rag", "fullstack", "blockchain", "vector-databases",
           "algorithms", "cloud"],
  "summary_for_embedding": "java, springboot, dotnet, azure, microservices, generative-ai, mulesoft, rag, fullstack, blockchain, systems, engineer, consultancy, services, working, azure-based, integration, accounts, developed, resilient, microservice, interfaces",
  "content_full": "Ayan Maiti is a Systems Engineer at Tata Consultancy Services working on Azure-based integration systems for retail accounts. ...",
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
    "external_links": {
      "portfolio": "...", "resume": "...", "github": "...",
      "leetcode": "...", "linkedin": "..."
    }
  },
  "created_at": "2026-03-29T15:10:58.966Z",
  "updated_at": "2026-07-10T12:47:16.224Z",
  "embedding": [ /* exactly 768 floats */ ]
}
```

Note what the live document does **not** have: no `date_end`, no `external_link`
(singular). Both are optional. `metadata.subcategory` here mixes technical tags
(`cloud`, `backend`) with meta tags (`experimental`) — that is normal.

`summary_for_embedding` is **keyword-dense, not prose**. It exists to be embedded, not to
be read. `content_full` is the prose. The two are embedded together (see §5), not as
alternatives.

---

## 3. Field-by-field contract

Legend: **DB** = the Mongo `$jsonSchema` validator; **API** = the request-time zod schema.
`required` in the DB column means the key must be present in the stored document;
`required` in the API column means the key must be present in the request payload.

### Top level

| Field | Type | DB | API | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | optional | — | Mongo-assigned. Never accepted from a payload. |
| `id` | string | **required** | **required** | Must be a valid UUID (API-side check via `uuid.validate`). The DB validator only checks `bsonType: "string"`. Unique index. This — not `_id` — is the business key for update/delete/re-embed. |
| `title` | string | **required** | **required**, trimmed, 2–180 chars | Fed into the embedding prefix. |
| `category` | enum | **required** | **required** | `ALLOWED_CATEGORIES`, **singular**. See §4. |
| `tags` | string[] | **required** | **required**, each trimmed 1–64 chars, max 50 items | **Lowercased** by `normalizeDocument`. Free-form — *not* a controlled vocabulary (unlike `subcategory`). Feeds the `Tags: ` line of the embedding text. |
| `summary_for_embedding` | string | **required** | **optional**, trimmed, 20–4000 chars | ⚠️ Mismatch — see §7.1. When omitted, the write path synthesizes one (`generateDeterministicSummary`), so the stored document always has it. |
| `content_full` | string \| null | **required** (key present; value nullable) | **required key**, string ≤25000 or `null` | Genuinely nullable — certifications and hobbies frequently have none. Everything downstream must tolerate this. |
| `metadata` | object | **required** | **required**, `.strict()` | See below. |
| `created_at` | **string** | **required** | set by the server | ISO 8601 string, **not** a BSON Date. Set once on create, preserved across updates. |
| `updated_at` | **string** | **required** | set by the server | ISO 8601 string. Rewritten on every update and on every re-embed. |
| `embedding` | number[] | **required** | set by the server | Exactly **768** numbers. The DB validator does **not** check length — see §7.2. |

`additionalProperties: false` at the top level and inside `metadata`, both in the DB
validator and (via `.strict()`) in the zod schema: any unknown key is rejected.

### `metadata`

| Field | Type | DB | API | Notes |
|---|---|---|---|---|
| `domain` | enum | **required** | **required** | `ALLOWED_DOMAINS`, **plural**. Must equal `CATEGORY_DOMAIN_MAP[category]` — enforced API-side only. |
| `subcategory` | enum[] | **required** | **required** (defaults to `[]`) | Every element from `ALLOWED_SUBCATEGORIES`. The count grows — read `taxonomy.js`, and see §8 for keeping the DB validator in step. |
| `verified` | bool | **required** | **required** | Non-nullable. |
| `proficiency_level` | enum \| null | **required** (nullable) | **required** (nullable) | `beginner \| intermediate \| advanced \| expert \| null`. Key must be present; `null` is normal (the live sample has `null`). |
| `organization` | string \| null | **required** (nullable) | **required** (nullable), 1–160 chars | `null` is normal. |
| `impact_score` | number \| null | **required** (nullable) | **required** (nullable), 0–100 | Stored as `NumberInt` in the live sample; the validator accepts `int \| long \| double \| null`. Deliberately never shown to the LLM. |
| `is_active` | bool | **required** | **required** | Non-nullable. |
| `date_start` | **string** \| null | optional | optional, nullable, ISO datetime with offset | ⚠️ **String, not Date** — the metadata retrieval arm compares it lexicographically, which is only correct because the values are zero-padded ISO. |
| `date_end` | **string** \| null | optional | optional, nullable, ISO datetime with offset | Same. API-side rule: `date_start <= date_end`. |
| `completion_year` | number \| null | optional | optional, nullable, int 1900–3000 | `int \| long \| double \| null` in the DB validator. |
| `external_links` | object \| null | optional | optional, nullable | `Record<string, string>`. The DB validator requires every value to be a string; the API caps each at 512 chars but does **not** require a valid URL. Live keys: `portfolio, resume, github, leetcode, linkedin`. |
| `external_link` | string \| null | optional | optional, nullable | **Legacy singular.** Validated as a URL ≤512 chars. Handled everywhere as a fallback when `external_links` is absent. On the Leave-behind list — the rewrite should pick one shape. |

**Nullability summary for consumers:** `content_full`, `proficiency_level`,
`organization`, `impact_score`, `date_start`, `date_end`, `completion_year`,
`external_links`/`external_link` can all be null or absent. Retrieval, ranking, the
sanitizer and the response generator must all tolerate a sparse document without
special-casing. This tolerance is a feature of the old pipeline and is preserved.

---

## 4. The two enums, and why they are the top source of payload errors

`category` and `metadata.domain` are **separate enums with different words for the same
concept** — singular versus plural — bridged by `CATEGORY_DOMAIN_MAP`.

`ALLOWED_CATEGORIES` (9, singular):

```
skill  certification  credential  education  experience  profile  project  hobby  topic
```

`ALLOWED_DOMAINS` (9, plural):

```
skills  projects  experience  profile  certifications  education  achievements  research  hobbies
```

`CATEGORY_DOMAIN_MAP`:

| category | → domain |
|---|---|
| `skill` | `skills` |
| `certification` | `certifications` |
| `credential` | `certifications` |
| `education` | `education` |
| `experience` | `experience` |
| `profile` | `profile` |
| `project` | `projects` |
| `hobby` | `hobbies` |
| `topic` | **`research`** |

Traps, all real, all already responsible for rejected payloads:

1. **Three pairs are identical words** (`education`, `experience`, `profile`), which makes
   the other six look like they should be too. They are not.
2. **`topic → research`** is the one non-obvious mapping. Nothing about "topic" suggests
   "research".
3. **`credential` and `certification` both map to `certifications`** — the map is not a
   bijection, so you cannot derive the category back from the domain.
4. **`achievements` is unreachable.** No category maps to it, so no document written
   through the validated path can ever carry `metadata.domain === "achievements"`. The old
   intent extractor nevertheless classifies "awards"/"ranking" queries into that domain,
   and the metadata arm then matches nothing.

**Rewrite rule:** `src/documents/taxonomy.js` is the single source for all four enums and
the map. `validateDocument()` derives the expected domain from the category and rejects a
mismatch with a message naming both values. Callers never hand-write the pair.

`ALLOWED_SUBCATEGORIES` — **78** values (the LLD says "~90"; 78 is what the code has),
spanning technical skills, soft skills and meta tags:

```
programming-language  backend  frontend  fullstack  database  devops  cloud  architecture
api-design  system-design  distributed-systems  security  testing  performance-optimization
data-engineering  machine-learning  generative-ai  rag  vector-databases  problem-solving
communication  teamwork  leadership  adaptability  creativity  critical-thinking
decision-making  time-management  ownership  ai  automation  api  search  chatbot  analytics
open-source  experimental  production-grade  scalable  high-performance  integration
enterprise-systems  microservices  computer-science  software-engineering  data-science
artificial-intelligence  mathematics  hackathon  competition  ranking  award  recognition
community  nlp  algorithms  experimentation  technical  non-technical
competitive-programming  writing  gaming  learning  ai-development  agent-sdk
prompt-engineering  llm  claude  anthropic  ai-agents  mcp  claude-api  data structures
practice  ai-evaluation  interview-preparation  full-stack  software-development
```

Two internal inconsistencies to **preserve, not fix** (existing documents use these exact
strings; changing them orphans data):

- `data structures` has a **space**; every other value is kebab-case.
- `fullstack` and `full-stack` are two distinct values.

`ALLOWED_PROFICIENCY_LEVELS` (4): `beginner`, `intermediate`, `advanced`, `expert`.

---

## 5. Embeddings — the part that must stay byte-identical

Vectors already in Atlas were produced by the exact strings below. Any drift in prefixes,
separators or truncation changes the vector for the same input and silently degrades
retrieval against the existing collection, with no error anywhere.

- **Model:** `gemini-embedding-2` (`GEMINI_EMBEDDING_MODEL`).
- **Dimensions:** `768` (`GEMINI_EMBEDDING_DIMENSIONS`), sent as `output_dimensionality`.
- **Endpoint:** `POST {GEMINI_BASE_URL}/v1beta/models/{model}:embedContent`, header
  `x-goog-api-key`, body `{ content: { parts: [{ text }] }, output_dimensionality }`.
- **One text per `embedContent` call. Never batch.** Passing multiple inputs returns a
  single *aggregated* vector rather than one per input — silently wrong rather than an
  error. This constraint carries into any LangChain `Embeddings` wrapper: `embedDocuments`
  must loop sequentially, one call per document.
- **No `taskType` parameter.** `gemini-embedding-2` carries retrieval-task intent through
  the prompt text instead. (Its predecessor `gemini-embedding-001` used `taskType` and
  needed manual L2 normalization of truncated Matryoshka output.)
- **No manual normalization.** `gemini-embedding-2` auto-normalizes.
- **Dimension guard:** the client throws when the response vector's length is not exactly
  768, so a mismatched vector is never written by that path.
- **Retry:** attempts `0..GEMINI_MAX_RETRIES` inclusive; retryable on `408, 429, 500, 502,
  503, 504` and on timeout/abort; delay = `Retry-After` seconds when parseable, else
  `GEMINI_RETRY_BASE_MS * 2**attempt + random()*GEMINI_RETRY_BASE_MS`, capped at
  `GEMINI_MAX_BACKOFF_MS`. Timeout via `AbortSignal.timeout(GEMINI_TIMEOUT_MS)`.

### Document template

```
title: <title> | text: <body>
```

- `<title>` = `document.title.trim()`, or the **literal string `none`** when missing or blank.
- `<body>` = these three parts, each dropped when empty, joined with a single `"\n"`:
  1. `` `Tags: ${tags.join(", ")}` `` — the whole line omitted when `tags` is empty
  2. `summary_for_embedding.trim()`
  3. `content_full.trim()`
- Content is **last** on purpose: overflow truncation trims `content_full`'s tail rather
  than dropping the tags or the summary.
- `prefix = "title: " + title + " | text: "`; `budget = MAX_EMBEDDING_INPUT_CHARS -
  prefix.length`. **The budget depends on the title's length** — it is not a constant.
- `MAX_EMBEDDING_INPUT_CHARS` = `28000` (`GEMINI_MAX_INPUT_CHARS`), a conservative
  ~3.5 chars/token budget against the model's 8192-token limit. `title` + `summary` (≤4000)
  + `content_full` (≤25000) can otherwise overflow outright.

### Query template

```
task: search result | query: <trimmed query>
```

`prefix = "task: search result | query: "` — 29 characters. Same truncation and budget.

The document and query templates are an asymmetric-retrieval pair. **They must never drift
apart**, and neither may drift from what is already in Atlas.

### Truncation (`truncateToChars(text, maxChars)`)

1. `maxChars <= 0` → `""`.
2. `text.length <= maxChars` → returned unchanged (no trimming, no `.trimEnd()`).
3. Otherwise: `slice = text.slice(0, maxChars)`; `lastSpace = slice.lastIndexOf(" ")`;
   cut at `lastSpace` **only if `lastSpace > maxChars * 0.8`**, else keep the hard slice;
   then `.trimEnd()` the result.

The `0.8` threshold is part of the contract. So is the fact that the un-truncated path
does **not** call `.trimEnd()`.

### Re-embedding

- Update re-embeds only when `buildEmbeddingText(existing) !== buildEmbeddingText(next)`,
  or when the existing document has no vector.
- Bulk re-embed reads exactly the fields the template uses:
  `{ _id: 0, id: 1, title: 1, tags: 1, summary_for_embedding: 1, content_full: 1 }`,
  and writes only `embedding` + `updated_at`.
- "Missing vector" means `$or: [{embedding: {$exists: false}}, {embedding: null},
  {embedding: {$size: 0}}]`.
- Sequential, never concurrent — concurrency is the fastest way to hit the rate limit.

**Phase 3a acceptance:** fixtures produced by running the old `utils/embeddingGenerator.js`
(5 documents including a truncation case, and 5 queries) must match the new implementation
**byte for byte**.

---

## 6. Validation layers, and which one actually protects the data

There are two, and they do not agree.

**Layer 1 — request-time zod (`validators/memoryValidator.js`).** Runs on every
create/update. This is the layer that actually rejects bad payloads today.

**Layer 2 — Mongo `$jsonSchema` (`models/vectorDocument.js`).** Installed by
`ensureStorage()` on the create/update path… *if* the Atlas user is allowed to run
`collMod`. The code catches an `Unauthorized` (code 13) and continues with only a
`console.error`, and a comment in `vectorMemoryService.js` states plainly that
`moonmind_documents_v3` currently **has no validator**. The re-embed paths skip
`ensureStorage()` deliberately, so a legacy out-of-enum document can still be re-embedded.

> **Corrected 2026-09-18 — that last claim is false, and was false when written.** The
> live collection **does** carry a `$jsonSchema` validator, at `validationLevel: strict`
> and `validationAction: error`. The old comment was describing a failed `collMod` under
> some other credential; the validator installed at collection-creation time was there all
> along. This surfaced when an ingestion attempt returned
> `code: 121, Document failed validation` — an error that names no field — for a document
> the application had already accepted. See §8.

**Do not rely on DB-side enforcement *alone*.** `src/documents/schema.js`
is the gate for readable errors. It must enforce, in application code:

1. Every field constraint in §3.
2. `metadata.domain === CATEGORY_DOMAIN_MAP[category]`.
3. Every `metadata.subcategory` element in `ALLOWED_SUBCATEGORIES`.
4. **`embedding.length === 768`** — the check no existing layer performs.
5. `date_start <= date_end` when both are present.

Additional request-time behavior worth deciding on rather than inheriting blindly:

- **Tag normalization:** tags are trimmed and **lowercased**. Keep this — existing
  documents are lowercase and `tags` feeds the embedding text.
- **Summary sentence range:** 3–6 sentences, enforced **only when `content_full` is empty**
  and only when `MOONMIND_ENFORCE_SUMMARY_SENTENCE_RANGE` is on.
- **Prohibited-content scan:** ten regexes over title + tags + summary + content +
  subcategory + organization. One of them, `system\s*prompt`, **rejects legitimate
  prompt-engineering portfolio documents** — and `prompt-engineering`, `llm`, `claude`,
  `anthropic`, `mcp`, `claude-api` are all valid subcategories, so this is a live
  contradiction, not a hypothetical. Fix or narrow the pattern in the rewrite; the secret
  patterns (`sk-…`, `bearer …`, private-key headers, SSN) are worth keeping.

---

## 7. Reconciliation — every difference between the brief and the code

**Code wins in all of these.**

### 7.1 `summary_for_embedding` is required in the DB but optional in the API
`models/vectorDocument.js` lists it in `required`; the zod schema marks it `.optional()`.
Not a contradiction in practice: `createDocument`/`updateDocument` fill it from
`generateDeterministicSummary(document)` when it is absent, so the stored document always
has one. **Rewrite:** keep the payload field optional, keep the server-side fallback, and
require it on the stored shape.

### 7.2 The 768-length rule is enforced nowhere near the database
The brief and the LLD both say "exactly 768 floats". The DB validator declares
`embedding: { bsonType: "array", items: { bsonType: ["double","int","long","decimal"] } }`
— **no `minItems`, no `maxItems`**. A 767-length vector writes cleanly and is then
invisible to `$vectorSearch` forever, with no error. The only length check anywhere is in
the Gemini client, on the response. **Rewrite:** `validateDocument()` checks the length
explicitly (Phase 3a acceptance includes rejecting a 767-length embedding).

### 7.3 `~90` subcategories → **78**
Counted by executing `config/vectorConfig.js`. No duplicates.

### 7.4 Dates and timestamps are strings, not BSON Dates
The brief's JSON sample renders `date_start`, `created_at` and `updated_at` as
ISO-looking values; the validator declares all three `bsonType: "string"` and the live
document stores strings. The metadata retrieval arm relies on this (it does lexicographic
`$gte`/`$lte` on the string). **Rewrite:** keep them as ISO strings. Migrating to BSON
Dates is a separate, deliberate decision, not a side effect.

### 7.5 `metadata.date_end` exists and is omitted from the brief
The brief's sample shows `date_start` but not `date_end`. Both exist, both optional and
nullable, with an API-side ordering rule between them. The live sample document happens to
have no `date_end`.

### 7.6 `metadata.external_link` (singular) exists alongside `external_links`
The brief only shows the plural. The singular is a legacy field still validated, still
normalized, and still used as a fallback by the sanitizer. It is on the Leave-behind list —
pick one shape in the rewrite and note the migration if any live document uses the singular.

### 7.7 `impact_score` is `NumberInt` in the live document
The validator accepts `int | long | double | null`, and the API caps it at 0–100. Whatever
BSON numeric type is used, ranking normalizes it to `[0,1]` by dividing by 100.

### 7.8 `content_full` size limits differ per layer
The API caps it at 25000 characters; the DB validator has no length constraint; the
embedding budget is 28000 characters *for the whole text including the prefix, tags and
summary*. So a legal 25000-character `content_full` on a document with a long title and
many tags **will** be truncated at embed time. That is intended — the truncation exists
precisely for this case — but it means the stored text and the embedded text differ.

### 7.9 `tags` is not a controlled vocabulary; `subcategory` is
Easy to conflate because the live sample's tags (`rag`, `cloud`, `algorithms`,
`vector-databases`) look like subcategory values. `tags` is free-form (max 50, each 1–64
chars, lowercased); `metadata.subcategory` is a closed 78-value enum.

### 7.10 `achievements` is a valid domain that nothing can produce
See §4.4. The rewrite should either add a category that maps to it or drop it from
`ALLOWED_DOMAINS` — **but not before checking whether any live document already carries
it**, since documents predating the current map may exist. Until that check runs, keep the
value in the enum.

---

## 8. Keeping the two vocabularies in sync

The controlled vocabularies exist in two places that MongoDB has no way to reconcile for
you:

| Where | What enforces it | Failure mode |
|---|---|---|
| `src/documents/taxonomy.js` | `validateDocument()`, before the write | 400 naming the offending field and value |
| The collection's `$jsonSchema` | MongoDB, at write time | `code: 121, Document failed validation` — **names nothing** |

**`taxonomy.js` is the source of truth. The validator is generated from it.** Run
`scripts/sync-document-validator.js` after changing any vocabulary:

```
node --env-file=.env scripts/sync-document-validator.js          # show the diff
node --env-file=.env scripts/sync-document-validator.js --apply  # write it
node --env-file=.env scripts/sync-document-validator.js --check  # exit 1 on drift
```

It patches only the four enum arrays and writes every other rule back untouched, prints
the previous validator as a rollback artifact, and re-reads the schema afterwards to
confirm — `collMod` reports success on a no-op too.

**Why the direction of drift matters.** If the app's list is a *superset* of the DB's, a
value passes application validation and dies at the database with an error that identifies
no field. If the DB's is a superset, you get a readable 400 instead. The app being ahead is
the bad direction, and it is the one that happens naturally, because adding a value to a JS
file is easy and running a migration is a separate thought.

**Adding is safe; removing is not.** Widening an enum cannot invalidate a stored document.
Narrowing one can, and nothing re-validates existing rows — a `validationLevel: strict`
collection only checks on write, so a now-illegal document sits there until something
updates it and then fails. The script flags removals loudly; check the collection before
accepting one.

**History.** The vocabularies drifted to 85 (app) against 78 (DB) on 2026-09-18 when seven
agentic-AI subcategories were added for an EY GDS experience document. The symptom was an
opaque 121 on ingestion. Fixed by this script; §6's claim that the collection has no
validator was corrected at the same time.
