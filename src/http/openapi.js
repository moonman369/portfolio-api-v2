"use strict";

// The OpenAPI document, generated from the schemas that actually validate requests.
//
// The old service hand-wrote its Swagger definitions in a separate file, and they
// drifted: its `GithubResponse` declared an array of objects while the code returned a
// single object (OLD_REPO_MAP.md §10.8). Anything with a zod schema is converted from
// that schema here, so the document payload — the one that is genuinely complex, with
// 78 subcategory values and a nested nullable metadata object — can never disagree with
// the validator. `test/http/openapi.test.js` additionally asserts every route the app
// mounts appears here, which is the guard the old setup lacked.

const { zodToJsonSchema } = require("zod-to-json-schema");
const { documentSchema } = require("../documents/schema");
const { STEP_TYPES, RUN_STATUSES } = require("../agent/runs");
const { buildBodySchema } = require("./chat");

const PASSWORD_SCHEME = "MoonMindPassword";
const SECRET_SCHEME = "RefreshSecret";

/** Convert a zod schema, inlining refs so each component stands alone. */
function fromZod(schema) {
  return zodToJsonSchema(schema, { $refStrategy: "none", target: "openApi3" });
}

const json = (schema) => ({ content: { "application/json": { schema } } });

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

const errorResponse = (description) => ({ description, ...json(ref("Error")) });

const object = (properties, required) => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
});

const str = (example) => ({ type: "string", ...(example === undefined ? {} : { example }) });
const int = (example) => ({ type: "integer", ...(example === undefined ? {} : { example }) });

function buildComponents(maxMessageChars) {
  return {
    securitySchemes: {
      [PASSWORD_SCHEME]: {
        type: "apiKey",
        in: "header",
        name: "password",
        description:
          "The MOONMIND_PASSWORD value. A single shared password, not per-visitor identity.",
      },
      [SECRET_SCHEME]: {
        type: "apiKey",
        in: "query",
        name: "secret",
        description: "The REFRESH_SECRET value. Only /refresh uses this instead of the header.",
      },
    },
    schemas: {
      Error: object(
        {
          status: str("error"),
          message: str("Document appears to contain an API key and was rejected"),
          code: {
            type: "string",
            example: "INVALID_DOCUMENT",
            description: "Stable machine-readable code. Never carries a stack trace.",
          },
        },
        ["status", "message", "code"],
      ),

      Health: object(
        { status: str("ok"), uptime: { type: "number", example: 1234.56 }, timestamp: str() },
        ["status", "uptime", "timestamp"],
      ),

      GithubStats: {
        nullable: true,
        description: "Null until /refresh has run at least once. A single object, not an array.",
        ...object({
          _id: str("github_stats"),
          stats: object({
            repos: int(106),
            commits: int(1854),
            pulls: int(45),
            stars: int(238),
          }),
        }),
      },

      LeetcodeStats: object(
        {
          status: str("success"),
          username: str("moonman369"),
          totalSolved: int(219),
          totalQuestions: int(3491),
          easySolved: int(121),
          totalEasy: int(867),
          mediumSolved: int(94),
          totalMedium: int(1813),
          hardSolved: int(4),
          totalHard: int(811),
          ranking: { type: "integer", nullable: true, example: 512680 },
        },
        ["status", "username", "totalSolved", "totalQuestions"],
      ),

      RefreshResult: object({
        status: str("success"),
        message: str("Refresh success"),
        elapsed: int(8123),
        totalRepos: int(106),
        totalCommits: int(1854),
        totalStars: int(238),
        totalPulls: int(45),
      }),

      // Generated from the zod schema the ingestion routes validate against.
      DocumentPayload: fromZod(documentSchema),
      ChatRequest: fromZod(buildBodySchema(maxMessageChars)),

      ChatResponse: object({
        status: str("success"),
        data: object({
          sessionId: str(),
          runId: str(),
          route: {
            type: "string",
            description: "Which branch of the graph answered.",
            example: "about_me",
          },
          answer: str("Ayan works primarily in Java, Spring Boot and .NET..."),
          documents: {
            type: "array",
            description:
              "Documents that grounded the answer. Empty for routes that do not retrieve. `summary_for_embedding` is stripped — it is keyword soup for the embedder, not prose.",
            items: { type: "object", additionalProperties: true },
          },
        }),
      }),

      RunAccepted: object({
        status: str("success"),
        data: object({ runId: str(), sessionId: str() }, ["runId", "sessionId"]),
      }),

      RunStep: object(
        {
          seq: int(3),
          node: str("about_me"),
          type: {
            type: "string",
            enum: [...STEP_TYPES],
            description: "`start`/`end` bracket a node; `tool` is one tool call; `error` is a node the boundary caught.",
          },
          ts: str(),
          summary: {
            type: "string",
            example: "documents=8",
            description:
              "A short derived summary — counts, lengths and enum values. Never a retrieved document, a tool's arguments or a prompt.",
          },
        },
        ["seq", "node", "type", "ts", "summary"],
      ),

      RunFeed: object({
        status: str("success"),
        data: object({
          runId: str(),
          sessionId: str(),
          status: { type: "string", enum: [...RUN_STATUSES] },
          question: str("what has Ayan built with Node?"),
          route: { type: "string", nullable: true, example: "about_me" },
          answer: { type: "string", nullable: true, description: "Null until the run finishes." },
          error: { type: "object", nullable: true, additionalProperties: true },
          documents: {
            type: "array",
            description:
              "The documents that grounded the answer, in exactly the shape /chat returns. Empty until the run finishes.",
            items: { type: "object", additionalProperties: true },
          },
          documentIds: { type: "array", items: str(), description: "Their ids, for convenience." },
          documentCount: int(8),
          startedAt: str(),
          finishedAt: { type: "string", nullable: true },
          steps: { type: "array", items: ref("RunStep") },
          nextSince: {
            type: "integer",
            example: 7,
            description: "Send this back as `since` on the next poll. Unchanged when nothing new arrived.",
          },
        }),
      }),

      EmbeddingRegenerateResult: object({
        onlyMissing: { type: "boolean", example: false },
        processed: int(42),
        updated: int(41),
        failed: int(1),
        failures: { type: "array", items: { type: "object", additionalProperties: true } },
      }),
    },
  };
}

const secured = [{ [PASSWORD_SCHEME]: [] }];

function buildPaths() {
  const unauthorized = { 401: errorResponse("Missing or incorrect password") };
  const documentBody = { required: true, ...json(ref("DocumentPayload")) };

  return {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Liveness probe",
        description: "Dependency-free. Also the Docker HEALTHCHECK target.",
        security: [],
        responses: { 200: { description: "Service is up", ...json(ref("Health")) } },
      },
    },

    "/": {
      get: {
        tags: ["Health"],
        summary: "Service identity",
        security: [],
        responses: { 200: { description: "Service name and health path" } },
      },
    },

    "/api/v1/github": {
      get: {
        tags: ["Stats"],
        summary: "Cached GitHub stats",
        description:
          "Reads a cached document. It never calls GitHub — /refresh is what recomputes it.",
        security: [],
        responses: {
          200: { description: "Stats, or null if never refreshed", ...json(ref("GithubStats")) },
          500: errorResponse("Server error"),
        },
      },
    },

    "/api/v1/leetcode/{username}": {
      get: {
        tags: ["Stats"],
        summary: "Live LeetCode stats",
        description: "Served from an in-process cache with a 1 hour TTL.",
        security: [],
        parameters: [
          {
            in: "path",
            name: "username",
            required: true,
            schema: { type: "string", pattern: "^[A-Za-z0-9_-]+$", maxLength: 39 },
            example: "moonman369",
          },
        ],
        responses: {
          200: { description: "Stats", ...json(ref("LeetcodeStats")) },
          400: errorResponse("Invalid username"),
          404: errorResponse("No such LeetCode user"),
          502: errorResponse("LeetCode unreachable or malformed"),
        },
      },
    },

    "/api/v1/refresh": {
      get: {
        tags: ["Stats"],
        summary: "Recompute GitHub stats from the live API",
        description:
          "Paginates every repository on the profile and overwrites the cached document. Authenticates with a `secret` query parameter, not the password header. Rate limited to 5 per 15 minutes.",
        security: [{ [SECRET_SCHEME]: [] }],
        responses: {
          200: { description: "Refresh completed", ...json(ref("RefreshResult")) },
          401: { description: "Wrong or missing secret" },
          429: errorResponse("Rate limited"),
          500: errorResponse("Refresh failed"),
        },
      },
    },

    "/api/v1/moonmind/chat": {
      post: {
        tags: ["MoonMind"],
        summary: "Ask MoonMind",
        description:
          "The router classifies the message and one branch answers it. `sessionId` continues a conversation; omit it and one is minted. Never returns 500 because a node failed — the error boundary turns that into a graceful answer.",
        security: secured,
        requestBody: { required: true, ...json(ref("ChatRequest")) },
        responses: {
          200: { description: "Answer", ...json(ref("ChatResponse")) },
          400: errorResponse("Validation error"),
          ...unauthorized,
        },
      },
    },

    "/api/v1/moonmind/runs": {
      post: {
        tags: ["MoonMind"],
        summary: "Start a run and watch it",
        description:
          "Same question as /chat, answered as a live feed instead of a single response. Returns immediately with a runId while the graph is still working; poll GET /runs/{runId} for the steps.",
        security: secured,
        requestBody: { required: true, ...json(ref("ChatRequest")) },
        responses: {
          202: { description: "Run accepted and started", ...json(ref("RunAccepted")) },
          400: errorResponse("Validation error"),
          ...unauthorized,
        },
      },
    },

    "/api/v1/moonmind/runs/{runId}": {
      get: {
        tags: ["MoonMind"],
        summary: "Poll a run's steps",
        description:
          "Steps recorded after `since`, in order, plus the run's current status and — once finished — its answer. Poll until `status` is no longer `running`.",
        security: secured,
        parameters: [
          { name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          {
            name: "since",
            in: "query",
            required: false,
            description: "The last seq already seen. Echo back `nextSince` from the previous poll.",
            schema: { type: "integer", minimum: 0, default: 0 },
          },
        ],
        responses: {
          200: { description: "The run and its new steps", ...json(ref("RunFeed")) },
          400: errorResponse("runId is not a UUID, or since is not a non-negative integer"),
          ...unauthorized,
          404: errorResponse("No run with that id (it may have passed its retention window)"),
        },
      },
    },

    "/api/v1/moonmind/createDoc": {
      post: {
        tags: ["Documents"],
        summary: "Create a document",
        description: "Validates, embeds with Gemini, then stores. Validation runs first.",
        security: secured,
        requestBody: documentBody,
        responses: {
          201: { description: "Created (the 768-float vector is not returned)" },
          400: errorResponse("Validation error, e.g. category/domain mismatch"),
          ...unauthorized,
          409: errorResponse("A document with that id already exists"),
          502: errorResponse("Embedding provider failed"),
        },
      },
    },

    "/api/v1/moonmind/bulkCreateDoc": {
      post: {
        tags: ["Documents"],
        summary: "Create many documents",
        description:
          "Sequential, one embedding call per document. A failure does not abort the rest; failures come back keyed by array index.",
        security: secured,
        requestBody: {
          required: true,
          ...json({ type: "array", minItems: 1, items: ref("DocumentPayload") }),
        },
        responses: {
          201: { description: "All created" },
          207: { description: "Partial success" },
          400: errorResponse("Body is not a non-empty array, or every document failed"),
          ...unauthorized,
        },
      },
    },

    "/api/v1/moonmind/updateDoc": {
      put: {
        tags: ["Documents"],
        summary: "Replace a document",
        description:
          "A full replace, not a patch. Re-embeds only when the embedding input actually changed, or when the stored document has no vector.",
        security: secured,
        requestBody: documentBody,
        responses: {
          200: { description: "Updated" },
          400: errorResponse("Validation error"),
          ...unauthorized,
          404: errorResponse("No document with that id"),
        },
      },
    },

    "/api/v1/moonmind/deleteDoc": {
      delete: {
        tags: ["Documents"],
        summary: "Delete a document",
        security: secured,
        requestBody: {
          required: true,
          ...json(object({ id: { type: "string", format: "uuid" } }, ["id"])),
        },
        responses: {
          200: { description: "Deleted" },
          400: errorResponse("Invalid id"),
          ...unauthorized,
          404: errorResponse("No document with that id"),
        },
      },
    },

    "/api/v1/moonmind/documents": {
      get: {
        tags: ["Documents"],
        summary: "List documents",
        description: "Vectors are excluded from the projection.",
        security: secured,
        parameters: [
          { in: "query", name: "limit", schema: { type: "integer", maximum: 200 } },
          { in: "query", name: "skip", schema: { type: "integer", minimum: 0 } },
        ],
        responses: { 200: { description: "Documents" }, ...unauthorized },
      },
    },

    "/api/v1/moonmind/documents/embeddings/regenerate": {
      post: {
        tags: ["Documents"],
        summary: "Re-embed every document",
        description:
          "Sequential by design — batching Gemini returns one blended vector for the whole batch. Rate limited to 10 per 15 minutes. For a large backfill prefer a script, which no HTTP read timeout applies to.",
        security: secured,
        requestBody: json(object({ onlyMissing: { type: "boolean" } })),
        responses: {
          200: { description: "All re-embedded", ...json(ref("EmbeddingRegenerateResult")) },
          207: { description: "Some documents failed" },
          400: errorResponse("onlyMissing is not a boolean"),
          ...unauthorized,
          429: errorResponse("Rate limited"),
          502: errorResponse("Every document failed"),
        },
      },
    },

    "/api/v1/moonmind/documents/{id}/embedding": {
      post: {
        tags: ["Documents"],
        summary: "Re-embed one document",
        description: "Rewrites only `embedding` and `updated_at`.",
        security: secured,
        parameters: [
          { in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          200: { description: "Re-embedded" },
          400: errorResponse("Invalid id"),
          ...unauthorized,
          404: errorResponse("No document with that id"),
          429: errorResponse("Rate limited"),
          502: errorResponse("Embedding provider failed"),
        },
      },
    },
  };
}

/** The full OpenAPI document. */
function buildOpenApiDocument({ maxMessageChars = 4000, version = "0.1.0" } = {}) {
  return {
    openapi: "3.0.3",
    info: {
      title: "portfolio-api-v2",
      version,
      description: [
        "Portfolio stats plus the MoonMind agentic chat pipeline.",
        "",
        "**Authentication.** Most MoonMind routes take the shared password in a `password`",
        "header. `GET /api/v1/refresh` is the exception — it uses a `secret` query parameter.",
        "",
        "**Errors** carry `{ status, message, code }`. Stacks stay in the server logs.",
      ].join("\n"),
    },
    servers: [
      { url: "/", description: "This origin" },
      { url: "http://localhost:8000", description: "Local development" },
    ],
    tags: [
      { name: "Health", description: "Liveness" },
      { name: "Stats", description: "GitHub and LeetCode" },
      { name: "MoonMind", description: "Agentic chat" },
      { name: "Documents", description: "Vector document ingestion" },
    ],
    components: buildComponents(maxMessageChars),
    paths: buildPaths(),
  };
}

module.exports = { buildOpenApiDocument };
