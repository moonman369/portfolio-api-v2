"use strict";

// The spec, and the guard the old service lacked.
//
// Its Swagger definitions were hand-written in a separate file and drifted from the
// code until `GithubResponse` claimed to return an array of objects when the handler
// returned one object. The coverage test below walks the routes Express actually
// mounted and fails if any of them is missing from the document — so the spec cannot
// silently fall behind a new route.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "t";
process.env.REFRESH_PROFILE ??= "p";
process.env.REFRESH_SECRET ??= "s";
process.env.OPENAI_API_KEY ??= "sk-test";
process.env.MOONMIND_PASSWORD ??= "pw";
process.env.GEMINI_API_KEY ??= "gem-test";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp, listRoutes } = require("../../src/http/app");
const { buildOpenApiDocument } = require("../../src/http/openapi");
const { ALLOWED_SUBCATEGORIES, ALLOWED_CATEGORIES } = require("../../src/documents/taxonomy");

const spec = buildOpenApiDocument();

/** Express `:param` -> OpenAPI `{param}`. */
const toSpecPath = (path) => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

test("every mounted route appears in the spec", () => {
  const routes = listRoutes()
    // The docs endpoints document themselves by existing; no need to list them.
    .filter(({ path }) => !["/api/docs", "/api/openapi.json"].includes(path));

  assert.ok(routes.length >= 13, `expected the app to mount 13+ routes, found ${routes.length}`);

  const missing = routes.filter(({ method, path }) => {
    const entry = spec.paths[toSpecPath(path)];
    return !entry || !entry[method.toLowerCase()];
  });

  assert.deepEqual(
    missing.map((r) => `${r.method} ${r.path}`),
    [],
    "these routes exist but are undocumented — add them to src/http/openapi.js",
  );
});

test("every documented path corresponds to a real route", () => {
  const mounted = new Set(
    listRoutes().map(({ method, path }) => `${method} ${toSpecPath(path)}`),
  );

  const phantom = [];
  Object.entries(spec.paths).forEach(([path, methods]) => {
    Object.keys(methods).forEach((method) => {
      if (!mounted.has(`${method.toUpperCase()} ${path}`)) {
        phantom.push(`${method.toUpperCase()} ${path}`);
      }
    });
  });

  assert.deepEqual(phantom, [], "these are documented but not mounted");
});

// ---------------------------------------------------------------------------
// Generated, not retyped
// ---------------------------------------------------------------------------

test("the document payload schema is generated from the zod schema", () => {
  const payload = spec.components.schemas.DocumentPayload;

  // If this were hand-written it would not carry all 78 subcategory values.
  const subcategory =
    payload.properties.metadata.properties.subcategory.items.enum;
  assert.deepEqual(subcategory, [...ALLOWED_SUBCATEGORIES]);
  assert.deepEqual(payload.properties.category.enum, [...ALLOWED_CATEGORIES]);
});

test("the document schema keeps its nullability and required fields", () => {
  const payload = spec.components.schemas.DocumentPayload;

  assert.ok(payload.required.includes("content_full"), "key required even though nullable");
  assert.ok(payload.required.includes("id"));
  assert.ok(!payload.required.includes("summary_for_embedding"), "optional on the way in");

  const metadata = payload.properties.metadata;
  ["domain", "verified", "proficiency_level", "organization", "impact_score", "is_active"].forEach(
    (field) => assert.ok(metadata.required.includes(field), `${field} must be required`),
  );
});

test("the chat request schema is generated and honours the length cap", () => {
  const document = buildOpenApiDocument({ maxMessageChars: 1234 });
  const chat = document.components.schemas.ChatRequest;

  assert.equal(chat.properties.message.maxLength, 1234);
  assert.equal(chat.properties.prompt.maxLength, 1234, "the legacy alias is documented too");
});

// ---------------------------------------------------------------------------
// Accuracy of the hand-described response shapes
// ---------------------------------------------------------------------------

test("GithubStats is an object, not an array", () => {
  // The precise mistake the old Swagger made.
  const github = spec.components.schemas.GithubStats;

  assert.equal(github.type, "object");
  assert.equal(github.nullable, true, "null until /refresh has run");
  assert.equal(github.properties.stats.properties.repos.type, "integer");
});

test("/refresh is documented with the secret scheme, not the password header", () => {
  const refresh = spec.paths["/api/v1/refresh"].get;

  assert.deepEqual(refresh.security, [{ RefreshSecret: [] }]);
});

test("public routes carry no security, MoonMind routes carry the password", () => {
  assert.deepEqual(spec.paths["/health"].get.security, []);
  assert.deepEqual(spec.paths["/api/v1/github"].get.security, []);
  assert.deepEqual(spec.paths["/api/v1/moonmind/chat"].post.security, [{ MoonMindPassword: [] }]);
  assert.deepEqual(
    spec.paths["/api/v1/moonmind/createDoc"].post.security,
    [{ MoonMindPassword: [] }],
  );
});

test("every secured route documents a 401", () => {
  Object.entries(spec.paths).forEach(([path, methods]) => {
    Object.entries(methods).forEach(([method, operation]) => {
      if (operation.security?.some((scheme) => "MoonMindPassword" in scheme)) {
        assert.ok(
          operation.responses["401"],
          `${method.toUpperCase()} ${path} is secured but documents no 401`,
        );
      }
    });
  });
});

test("the spec is serializable and structurally valid", () => {
  const serialized = JSON.stringify(spec);

  assert.ok(serialized.length > 2000);
  assert.equal(spec.openapi, "3.0.3");
  assert.ok(spec.info.title);
  assert.deepEqual(JSON.parse(serialized).paths["/health"].get.tags, ["Health"]);
});

// ---------------------------------------------------------------------------
// Served
// ---------------------------------------------------------------------------

async function withServer(run) {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("the spec and the docs page are served without authentication", async () => {
  await withServer(async (base) => {
    const specResponse = await fetch(`${base}/api/openapi.json`);
    assert.equal(specResponse.status, 200);
    const served = await specResponse.json();
    assert.equal(served.openapi, "3.0.3");
    assert.ok(served.paths["/api/v1/moonmind/chat"]);

    const docs = await fetch(`${base}/api/docs`);
    assert.equal(docs.status, 200);
    assert.match(docs.headers.get("content-type"), /html/);
    assert.match(await docs.text(), /swagger-ui/);
  });
});

test("the root route points at the docs", async () => {
  await withServer(async (base) => {
    const body = await (await fetch(base)).json();
    assert.equal(body.docs, "/api/docs");
  });
});
