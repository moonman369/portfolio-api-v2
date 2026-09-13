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
const { createChatRouter } = require("./chat");
const { createDocumentsRouter } = require("./documents");
const { buildOpenApiDocument } = require("./openapi");

// Swagger UI is loaded from a CDN rather than vendored: the spec at
// /api/openapi.json is the durable artifact (point Postman, Insomnia or a codegen at
// it), and the rendered page is a convenience that does not need to cost a dependency
// or a few megabytes in the image.
const SWAGGER_UI_VERSION = "5.17.14";

function docsPage() {
  const base = `https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>portfolio-api-v2 — API docs</title>
    <link rel="stylesheet" href="${base}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger"></div>
    <script src="${base}/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/api/openapi.json",
        dom_id: "#swagger",
        docExpansion: "list",
        defaultModelsExpandDepth: 0,
        persistAuthorization: true,
      });
    </script>
  </body>
</html>`;
}

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

// The mount table, declared once so `createApp` and `listRoutes` cannot disagree.
const ROUTER_MOUNTS = Object.freeze([
  { prefix: "/api/v1", create: createStatsRouter },
  { prefix: "/api/v1/moonmind", create: createChatRouter },
  { prefix: "/api/v1/moonmind", create: createDocumentsRouter },
]);

// Routes defined directly on the app rather than in a router.
const APP_ROUTES = Object.freeze([
  { method: "GET", path: "/health" },
  { method: "GET", path: "/api/openapi.json" },
  { method: "GET", path: "/api/docs" },
  { method: "GET", path: "/" },
]);

/**
 * Every route the app serves, as `{ method, path }`.
 *
 * Built from the same mount table `createApp` uses, so it is an inventory rather than a
 * second list to keep in step. `test/http/openapi.test.js` diffs it against the OpenAPI
 * document, which is what stops the spec drifting behind a new route the way the old
 * service's hand-written Swagger did.
 */
function listRoutes() {
  const routes = APP_ROUTES.map((route) => ({ ...route }));

  ROUTER_MOUNTS.forEach(({ prefix, create }) => {
    create().stack.forEach((layer) => {
      if (!layer.route) {
        return;
      }
      Object.entries(layer.route.methods)
        .filter(([, enabled]) => enabled)
        .forEach(([method]) =>
          routes.push({ method: method.toUpperCase(), path: `${prefix}${layer.route.path}` }),
        );
    });
  });

  return routes;
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

  // Built once at boot: the spec is derived from schemas, not from the request.
  const openApiDocument = buildOpenApiDocument({
    maxMessageChars: config.moonmind.maxMessageChars,
  });
  const renderedDocs = docsPage();

  app.get("/api/openapi.json", (req, res) => res.status(200).json(openApiDocument));
  app.get("/api/docs", (req, res) => res.status(200).type("html").send(renderedDocs));

  app.get("/", (req, res) => {
    res.status(200).json({
      status: "ok",
      service: "portfolio-api-v2",
      health: "/health",
      docs: "/api/docs",
    });
  });

  ROUTER_MOUNTS.forEach(({ prefix, create }) => app.use(prefix, create()));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, listRoutes };
