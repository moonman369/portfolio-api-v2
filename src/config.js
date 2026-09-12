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

const originList = z
  .string()
  .optional()
  .transform((raw) =>
    raw === undefined
      ? DEFAULT_CORS_ORIGINS
      : raw
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
  );

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
  // LangGraph checkpointer storage — conversation state, keyed by thread_id.
  MONGO_CHECKPOINT_COLLECTION: nonEmpty.default("moonmind_checkpoints"),
  MONGO_CHECKPOINT_WRITES_COLLECTION: nonEmpty.default("moonmind_checkpoint_writes"),

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
  MOONMIND_RECURSION_LIMIT: positiveInt.default(25),
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
      checkpointCollection: raw.MONGO_CHECKPOINT_COLLECTION,
      checkpointWritesCollection: raw.MONGO_CHECKPOINT_WRITES_COLLECTION,
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
