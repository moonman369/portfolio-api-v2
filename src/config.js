"use strict";

// The ONLY module in src/ that reads process.env.
//
// `loadConfig(env)` is pure and takes its environment as an argument, so it can be
// unit-tested without touching the real process. `getConfig()` is the memoized
// singleton the app uses; `server.js` calls it first so a bad environment fails the
// boot with a readable message instead of surfacing later as a confusing runtime error.

const { z } = require("zod");

// Matches the old service's allowlist so the existing portfolio frontends keep working
// unchanged through cutover. Override with a comma-separated CORS_ORIGINS.
const DEFAULT_CORS_ORIGINS = [
  "https://devfoliomoonman369.netlify.app",
  "https://moonman.in",
  "https://moonman.in/",
  "https://new.moonman.in",
  "https://new.moonman.in/",
  "http://localhost:3000",
  "http://localhost:5173",
  "https://portfolio-2-sigma-bice.vercel.app/",
];

const nonEmpty = z.string().trim().min(1);
const positiveInt = z.coerce.number().int().positive();
// Ranking weights are unbounded above — a weight of 5 is legitimate — so this only
// rejects negatives and non-numbers.
const nonNegativeFloat = z.coerce.number().min(0);

// Accepts the shapes an operator actually types into a .env file.
//
// Takes its fallback as an argument rather than using `.default()`: a zod default is fed
// back through the inner schema, so a boolean default would fail this string enum.
const booleanFlag = (fallback) =>
  z
    .enum(["true", "1", "yes", "on", "false", "0", "no", "off"])
    .optional()
    .transform((value) => (value === undefined ? fallback : ["true", "1", "yes", "on"].includes(value)));

const csv = (raw) =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const originList = z
  .string()
  .optional()
  .transform((raw) => (raw === undefined ? DEFAULT_CORS_ORIGINS : csv(raw)));

/** A comma-separated list that defaults to empty. */
const optionalList = z
  .string()
  .optional()
  .transform((raw) => (raw === undefined ? [] : csv(raw)));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  CORS_ORIGINS: originList,
  REQUEST_BODY_LIMIT: nonEmpty.default("1mb"),

  // ---- MongoDB ----------------------------------------------------------
  MONGO_URI: nonEmpty,
  MONGO_DB_NAME: nonEmpty.default("portfolio-stats-api"),
  // The old service hardcoded both of these in mongo.js. They name a live collection
  // and a live document, so they are configuration, not constants.
  MONGO_STATS_COLLECTION: nonEmpty.default("gitStatsArchive"),
  MONGO_STATS_DOC_ID: nonEmpty.default("github_stats"),
  MONGO_TIMEOUT_MS: positiveInt.default(10_000),
  // Optional DNS override for the SRV lookup `mongodb+srv://` performs before it can
  // reach Atlas at all. Set it when the machine's resolver does not answer SRV queries
  // — the symptom is `querySrv ECONNREFUSED`, which looks like a connection failure but
  // happens before any connection is attempted. Empty means "use the system resolver".
  MONGO_DNS_SERVERS: optionalList,
  // LangGraph checkpointer storage — conversation state, keyed by thread_id.
  MONGO_CHECKPOINT_COLLECTION: nonEmpty.default("moonmind_checkpoints"),
  MONGO_CHECKPOINT_WRITES_COLLECTION: nonEmpty.default("moonmind_checkpoint_writes"),
  // The vector collection and its Atlas index. All three names must match what the
  // existing vectors were written under, or retrieval silently returns nothing.
  MONGO_VECTOR_COLLECTION: nonEmpty.default("moonmind_documents_v3"),
  MONGO_VECTOR_INDEX: nonEmpty.default("vector_index"),
  MONGO_VECTOR_FIELD: nonEmpty.default("embedding"),
  // The live event feed (Phase 4). Debug traces, not durable data: a TTL index drops
  // both collections' documents once the retention window passes, so watching runs
  // never grows the database without bound.
  MONGO_RUNS_COLLECTION: nonEmpty.default("moonmind_runs"),
  MONGO_RUN_STEPS_COLLECTION: nonEmpty.default("moonmind_run_steps"),
  MOONMIND_RUN_RETENTION_DAYS: positiveInt.default(7),

  // ---- GitHub stats refresh ---------------------------------------------
  GITHUB_PAT: nonEmpty,
  REFRESH_PROFILE: nonEmpty,
  REFRESH_SECRET: nonEmpty,
  GITHUB_TIMEOUT_MS: positiveInt.default(20_000),
  REFRESH_RATE_LIMIT_WINDOW_MS: positiveInt.default(15 * 60 * 1000),
  REFRESH_RATE_LIMIT_MAX: positiveInt.default(5),

  // ---- LeetCode ----------------------------------------------------------
  LEETCODE_USERNAME: nonEmpty.default("moonman369"),
  LEETCODE_TIMEOUT_MS: positiveInt.default(15_000),
  LEETCODE_CACHE_TTL_MS: positiveInt.default(60 * 60 * 1000),

  // ---- OpenAI (chat completions) -----------------------------------------
  OPENAI_API_KEY: nonEmpty,
  // ChatOpenAI takes a full base URL including the version segment, unlike the old
  // service's adapter which appended "/v1" itself.
  OPENAI_BASE_URL: nonEmpty.default("https://api.openai.com/v1"),

  // ---- Tavily (web search) ------------------------------------------------
  // Required, like the other two providers: `tech_web` is a live route from Phase 5 on,
  // and a missing key should stop the boot rather than surface as a broken answer to a
  // visitor. Set it on the VM before the next deploy.
  TAVILY_API_KEY: nonEmpty,
  TAVILY_BASE_URL: nonEmpty.default("https://api.tavily.com"),
  TAVILY_TIMEOUT_MS: positiveInt.default(15_000),
  TAVILY_MAX_RESULTS: positiveInt.max(20).default(5),
  // "advanced" costs 2 credits per search instead of 1 and returns longer extracts.
  TAVILY_SEARCH_DEPTH: z.enum(["basic", "advanced"]).default("basic"),

  // ---- MoonMind chat ------------------------------------------------------
  MOONMIND_PASSWORD: nonEmpty,
  // Per-role models stay independent so the cheap roles can move without touching
  // the others. Unset roles fall back along the chains resolved below.
  MOONMIND_RESPONSE_MODEL: nonEmpty.default("gpt-4o-mini"),
  MOONMIND_INTENT_MODEL: nonEmpty.default("gpt-4o-mini"),
  MOONMIND_ROUTER_MODEL: nonEmpty.optional(),
  MOONMIND_DECOMPOSE_MODEL: nonEmpty.optional(),
  MOONMIND_RERANK_MODEL: nonEmpty.optional(),
  MOONMIND_AGENT_MODEL: nonEmpty.optional(),
  MOONMIND_MODEL_TIMEOUT_MS: positiveInt.default(60_000),

  // Below this router confidence the turn takes the low-confidence path.
  MOONMIND_ROUTER_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
  // A confident classification away from an active flow is treated as a topic change.
  MOONMIND_TOPIC_CHANGE_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  MOONMIND_MAX_MESSAGE_CHARS: positiveInt.default(4_000),
  // How many recent messages are replayed to a model. `summary` covers the rest
  // once history outgrows this (populated from Phase 3b).
  MOONMIND_HISTORY_MAX_MESSAGES: positiveInt.default(20),
  MOONMIND_RUN_TIMEOUT_MS: positiveInt.default(120_000),
  MOONMIND_AGENT_MAX_STEPS: positiveInt.max(20).default(4),
  // The scope guard: one cheap classification before an agent dispatches any tool.
  // The topic list lives in `agent/prompts.js` (EXCLUDED_TOPICS); this appends to it, so
  // the VM can gain a topic by editing .env instead of waiting for a build.
  // Debug tracing. `MOONMIND_DEBUG` logs a per-node trace of every run — order, timing
  // and what each node decided. `MOONMIND_DEBUG_MODELS` additionally turns on LangChain's
  // own verbosity, which prints every prompt and completion in full; that is enormously
  // noisy and is kept separate on purpose.
  MOONMIND_DEBUG: booleanFlag(false),
  MOONMIND_DEBUG_MODELS: booleanFlag(false),
  MOONMIND_SCOPE_GUARD_ENABLED: booleanFlag(true),
  MOONMIND_EXCLUDED_TOPICS: optionalList,
  MOONMIND_RECURSION_LIMIT: positiveInt.default(25),

  // ---- Gemini embeddings --------------------------------------------------
  GEMINI_API_KEY: nonEmpty,
  // Base only — the code appends "/v1beta/models/<model>:embedContent".
  GEMINI_BASE_URL: nonEmpty.default("https://generativelanguage.googleapis.com"),
  GEMINI_EMBEDDING_MODEL: nonEmpty.default("gemini-embedding-2"),
  // MUST equal numDimensions on the Atlas index, or every write is unsearchable.
  GEMINI_EMBEDDING_DIMENSIONS: positiveInt.default(768),
  GEMINI_TIMEOUT_MS: positiveInt.default(30_000),
  GEMINI_MAX_RETRIES: positiveInt.default(5),
  GEMINI_RETRY_BASE_MS: positiveInt.default(500),
  GEMINI_MAX_BACKOFF_MS: positiveInt.default(20_000),
  // Character budget for the whole embedded text, prefix included.
  GEMINI_MAX_INPUT_CHARS: positiveInt.default(28_000),

  // ---- Retrieval ----------------------------------------------------------
  MOONMIND_VECTOR_NUM_CANDIDATES: positiveInt.default(150),
  MOONMIND_RRF_K: positiveInt.default(60),
  MOONMIND_FINAL_DOCUMENT_LIMIT: positiveInt.default(10),
  MOONMIND_RETRIEVAL_CANDIDATE_LIMIT: positiveInt.default(30),
  MOONMIND_RRF_WEIGHT_SEMANTIC: nonNegativeFloat.default(1),
  MOONMIND_RRF_WEIGHT_KEYWORD: nonNegativeFloat.default(1),
  MOONMIND_RRF_WEIGHT_METADATA: nonNegativeFloat.default(0.5),
  MOONMIND_RANK_IMPACT_WEIGHT: nonNegativeFloat.default(0),
  MOONMIND_RANK_VERIFIED_WEIGHT: nonNegativeFloat.default(0),
  MOONMIND_MIN_SEMANTIC_SCORE: z.coerce.number().min(0).max(1).default(0),
  MOONMIND_RERANK_ENABLED: booleanFlag(false),
  MOONMIND_RERANK_CANDIDATES: positiveInt.default(20),
  MOONMIND_DECOMPOSE_ENABLED: booleanFlag(false),
  MOONMIND_DECOMPOSE_MAX_SUBQUERIES: positiveInt.default(3),
  // The old service's keyword arm was unreachable (its prompt hard-coded it off), so
  // this stays off by default to keep retrieval behaviour comparable. Note the
  // collection has no text index: enabling it means a regex collection scan.
  MOONMIND_KEYWORD_ENABLED: booleanFlag(false),

  // ---- Document ingestion -------------------------------------------------
  MOONMIND_SUMMARY_MIN_SENTENCES: positiveInt.default(3),
  MOONMIND_SUMMARY_MAX_SENTENCES: positiveInt.default(6),
  MOONMIND_ENFORCE_SUMMARY_SENTENCE_RANGE: booleanFlag(true),
});

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function describeFailure(error) {
  const lines = error.issues.map((issue) => {
    const name = issue.path.join(".") || "(root)";
    return `  - ${name}: ${issue.message}`;
  });
  return `Invalid environment configuration:\n${lines.join("\n")}`;
}

/**
 * Parse and validate an environment. Pure — pass any object, get a frozen config back.
 * Throws with every offending variable named, not just the first.
 */
function loadConfig(env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(describeFailure(parsed.error));
  }

  const raw = parsed.data;

  return deepFreeze({
    env: raw.NODE_ENV,
    isProduction: raw.NODE_ENV === "production",
    port: raw.PORT,
    http: {
      corsOrigins: raw.CORS_ORIGINS,
      bodyLimit: raw.REQUEST_BODY_LIMIT,
    },
    mongo: {
      uri: raw.MONGO_URI,
      dbName: raw.MONGO_DB_NAME,
      statsCollection: raw.MONGO_STATS_COLLECTION,
      statsDocId: raw.MONGO_STATS_DOC_ID,
      timeoutMs: raw.MONGO_TIMEOUT_MS,
      dnsServers: raw.MONGO_DNS_SERVERS,
      checkpointCollection: raw.MONGO_CHECKPOINT_COLLECTION,
      checkpointWritesCollection: raw.MONGO_CHECKPOINT_WRITES_COLLECTION,
      runsCollection: raw.MONGO_RUNS_COLLECTION,
      runStepsCollection: raw.MONGO_RUN_STEPS_COLLECTION,
      runRetentionDays: raw.MOONMIND_RUN_RETENTION_DAYS,
      vectorCollection: raw.MONGO_VECTOR_COLLECTION,
      vectorIndex: raw.MONGO_VECTOR_INDEX,
      vectorField: raw.MONGO_VECTOR_FIELD,
    },
    github: {
      token: raw.GITHUB_PAT,
      profile: raw.REFRESH_PROFILE,
      timeoutMs: raw.GITHUB_TIMEOUT_MS,
    },
    refresh: {
      secret: raw.REFRESH_SECRET,
      rateLimitWindowMs: raw.REFRESH_RATE_LIMIT_WINDOW_MS,
      rateLimitMax: raw.REFRESH_RATE_LIMIT_MAX,
    },
    leetcode: {
      defaultUsername: raw.LEETCODE_USERNAME,
      timeoutMs: raw.LEETCODE_TIMEOUT_MS,
      cacheTtlMs: raw.LEETCODE_CACHE_TTL_MS,
    },
    openai: {
      apiKey: raw.OPENAI_API_KEY,
      baseUrl: raw.OPENAI_BASE_URL,
      timeoutMs: raw.MOONMIND_MODEL_TIMEOUT_MS,
    },
    moonmind: {
      password: raw.MOONMIND_PASSWORD,
      // Fallback chains, resolved once here so getModel(role) is a plain lookup:
      //   router -> intent, decompose -> intent, rerank -> response, agent -> response
      models: {
        response: raw.MOONMIND_RESPONSE_MODEL,
        intent: raw.MOONMIND_INTENT_MODEL,
        router: raw.MOONMIND_ROUTER_MODEL ?? raw.MOONMIND_INTENT_MODEL,
        decompose: raw.MOONMIND_DECOMPOSE_MODEL ?? raw.MOONMIND_INTENT_MODEL,
        rerank: raw.MOONMIND_RERANK_MODEL ?? raw.MOONMIND_RESPONSE_MODEL,
        agent: raw.MOONMIND_AGENT_MODEL ?? raw.MOONMIND_RESPONSE_MODEL,
      },
      routerMinConfidence: raw.MOONMIND_ROUTER_MIN_CONFIDENCE,
      topicChangeConfidence: raw.MOONMIND_TOPIC_CHANGE_CONFIDENCE,
      maxMessageChars: raw.MOONMIND_MAX_MESSAGE_CHARS,
      historyMaxMessages: raw.MOONMIND_HISTORY_MAX_MESSAGES,
      runTimeoutMs: raw.MOONMIND_RUN_TIMEOUT_MS,
      recursionLimit: raw.MOONMIND_RECURSION_LIMIT,
      // How many model calls one agent node gets per run. Each tool-calling round is
      // one, so this bounds both cost and latency for `tech_web` and every agent after.
      agentMaxSteps: raw.MOONMIND_AGENT_MAX_STEPS,
      debug: raw.MOONMIND_DEBUG,
      debugModels: raw.MOONMIND_DEBUG_MODELS,
      scopeGuardEnabled: raw.MOONMIND_SCOPE_GUARD_ENABLED,
      excludedTopics: raw.MOONMIND_EXCLUDED_TOPICS,
    },
    tavily: {
      apiKey: raw.TAVILY_API_KEY,
      baseUrl: raw.TAVILY_BASE_URL,
      timeoutMs: raw.TAVILY_TIMEOUT_MS,
      maxResults: raw.TAVILY_MAX_RESULTS,
      searchDepth: raw.TAVILY_SEARCH_DEPTH,
    },
    gemini: {
      apiKey: raw.GEMINI_API_KEY,
      baseUrl: raw.GEMINI_BASE_URL,
      model: raw.GEMINI_EMBEDDING_MODEL,
      dimensions: raw.GEMINI_EMBEDDING_DIMENSIONS,
      timeoutMs: raw.GEMINI_TIMEOUT_MS,
      maxRetries: raw.GEMINI_MAX_RETRIES,
      retryBaseMs: raw.GEMINI_RETRY_BASE_MS,
      maxBackoffMs: raw.GEMINI_MAX_BACKOFF_MS,
      maxInputChars: raw.GEMINI_MAX_INPUT_CHARS,
    },
    retrieval: {
      numCandidates: raw.MOONMIND_VECTOR_NUM_CANDIDATES,
      rrfK: raw.MOONMIND_RRF_K,
      finalDocumentLimit: raw.MOONMIND_FINAL_DOCUMENT_LIMIT,
      candidateLimit: raw.MOONMIND_RETRIEVAL_CANDIDATE_LIMIT,
      rrfWeights: {
        semantic: raw.MOONMIND_RRF_WEIGHT_SEMANTIC,
        keyword: raw.MOONMIND_RRF_WEIGHT_KEYWORD,
        metadata: raw.MOONMIND_RRF_WEIGHT_METADATA,
      },
      impactWeight: raw.MOONMIND_RANK_IMPACT_WEIGHT,
      verifiedWeight: raw.MOONMIND_RANK_VERIFIED_WEIGHT,
      minSemanticScore: raw.MOONMIND_MIN_SEMANTIC_SCORE,
      rerankEnabled: raw.MOONMIND_RERANK_ENABLED,
      rerankCandidates: raw.MOONMIND_RERANK_CANDIDATES,
      decomposeEnabled: raw.MOONMIND_DECOMPOSE_ENABLED,
      decomposeMaxSubqueries: raw.MOONMIND_DECOMPOSE_MAX_SUBQUERIES,
      keywordEnabled: raw.MOONMIND_KEYWORD_ENABLED,
    },
    documents: {
      summaryMinSentences: raw.MOONMIND_SUMMARY_MIN_SENTENCES,
      // Never below the minimum, mirroring the old service's clamp.
      summaryMaxSentences: Math.max(
        raw.MOONMIND_SUMMARY_MIN_SENTENCES,
        raw.MOONMIND_SUMMARY_MAX_SENTENCES,
      ),
      enforceSummarySentenceRange: raw.MOONMIND_ENFORCE_SUMMARY_SENTENCE_RANGE,
    },
  });
}

let cached = null;

/** The application's frozen config. Memoized; first call validates. */
function getConfig() {
  if (cached === null) {
    cached = loadConfig(process.env);
  }
  return cached;
}

module.exports = { getConfig, loadConfig };
