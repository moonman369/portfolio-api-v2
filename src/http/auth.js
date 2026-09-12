"use strict";

// Auth and rate limiting for the HTTP layer. One implementation of each, applied where
// needed. Phase 1 adds the shared `password` header guard here for the chat route.

const crypto = require("node:crypto");
const rateLimit = require("express-rate-limit");
const { getConfig } = require("../config");

// Compare via fixed-length digests so neither the comparison time nor the buffer length
// leaks anything about the configured secret.
function secretsMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Guards `/refresh`, which authenticates with a `secret` query parameter rather than the
 * `password` header used by the MoonMind routes. The rejected value is never logged.
 */
function requireRefreshSecret(req, res, next) {
  const { refresh } = getConfig();

  if (!secretsMatch(req.query?.secret, refresh.secret)) {
    return res.status(401).json({
      message: "You are not authorized to perform this action",
    });
  }

  return next();
}

/**
 * `/refresh` paginates every repository on the profile, so it is expensive in both time
 * and GitHub quota. Limiting it also bounds guessing attempts against the secret.
 */
function createRefreshLimiter() {
  const { refresh } = getConfig();

  return rateLimit({
    windowMs: refresh.rateLimitWindowMs,
    limit: refresh.rateLimitMax,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      status: "error",
      message: "Too many refresh requests, please retry later",
      code: "RATE_LIMITED",
    },
  });
}

module.exports = { requireRefreshSecret, createRefreshLimiter };
