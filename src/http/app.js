"use strict";

// Express wiring: middleware, mounting, and the single error handler.
//
// Express 5 forwards rejected promises from async handlers to the error handler on its
// own, so route handlers stay genuinely thin — no try/catch boilerplate and no shared
// async-wrapper helper.

const express = require("express");
const cors = require("cors");
const { getConfig } = require("../config");
const { createStatsRouter } = require("./stats");

// Domain modules throw plain Errors carrying a `code`; HTTP semantics are decided here,
// so `stats/` and `documents/` never need to know about status codes.
const CODE_TO_STATUS = Object.freeze({
  INVALID_USERNAME: 400,
  LEETCODE_USER_NOT_FOUND: 404,
  GITHUB_PROFILE_NOT_FOUND: 404,
  LEETCODE_REQUEST_FAILED: 502,
  LEETCODE_UNEXPECTED_RESPONSE: 502,
  GITHUB_REQUEST_FAILED: 502,
});

function notFoundHandler(req, res) {
  res.status(404).json({
    status: "error",
    message: `Cannot ${req.method} ${req.path}`,
    code: "NOT_FOUND",
  });
}

// Error bodies carry a message and a code, never a stack trace — stacks stay in the
// server logs.
function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  const status = CODE_TO_STATUS[error?.code] ?? 500;

  if (status >= 500) {
    console.error("request.failed", {
      method: req.method,
      path: req.path,
      code: error?.code ?? null,
      message: error?.message,
      stack: error?.stack,
    });
  }

  return res.status(status).json({
    status: "error",
    message: status >= 500 ? "Server Error" : error.message,
    code: error?.code ?? "INTERNAL_ERROR",
  });
}

function createApp() {
  const config = getConfig();
  const app = express();

  // Nginx terminates TLS in front of the container: trust exactly one proxy hop so
  // req.ip reflects the real client (rate limiting depends on this).
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(express.json({ limit: config.http.bodyLimit }));
  app.use(
    cors({
      origin: config.http.corsOrigins,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "password"],
      credentials: true,
    }),
  );

  // Dependency-free liveness probe: also the Docker HEALTHCHECK target.
  app.get("/health", (req, res) => {
    res.status(200).json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/", (req, res) => {
    res.status(200).json({ status: "ok", service: "portfolio-api-v2", health: "/health" });
  });

  app.use("/api/v1", createStatsRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
