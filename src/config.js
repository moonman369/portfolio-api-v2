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
