"use strict";

// Phase 10's mail routes over real HTTP, with mail switched ON (MOONMIND_MAIL_ENABLED) —
// paused by default since Phase 10.1, so these run in their own process with the flag set
// before config is first read. The tests themselves are Phase 10's, unchanged.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "t";
process.env.REFRESH_PROFILE ??= "p";
process.env.REFRESH_SECRET ??= "s";
process.env.OPENAI_API_KEY ??= "sk-test";
process.env.MOONMIND_PASSWORD ??= "hunter2";
process.env.GEMINI_API_KEY ??= "gem-test";
process.env.TAVILY_API_KEY ??= "tvly-test";
process.env.MOONMIND_BOOKING_URL_15MIN ??= "https://cal.com/example/15min";
process.env.MOONMIND_BOOKING_URL_30MIN ??= "https://cal.com/example/30min";
process.env.MOONMIND_MAIL_ENABLED = "true";
process.env.WEB3FORMS_ACCESS_KEY ??= "public-access-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../../src/http/app");
const { buildOpenApiDocument } = require("../../src/http/openapi");
const agent = require("../../src/agent");
const runs = require("../../src/agent/runs");

const PASSWORD = "hunter2";
const P = "/api/v1/moonmind";
const RUN_ID = "3341e59a-2a2f-4e8a-8aff-eb957e1ceeba";

/** Replace exported functions on a module for the duration of one test. */
function stub(target, overrides) {
  const original = {};
  Object.entries(overrides).forEach(([key, value]) => {
    original[key] = target[key];
    target[key] = value;
  });
  return () => Object.entries(original).forEach(([key, value]) => {
    target[key] = value;
  });
}

async function withServer(run) {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function call(base, path, { method = "GET", password = PASSWORD, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (password !== null) headers.password = password;
  const sendsBody = !["GET", "HEAD"].includes(method) && body !== undefined;
  return fetch(`${base}${path}`, { method, headers, body: sendsBody ? JSON.stringify(body) : undefined });
}

const finishedRun = (overrides = {}) => ({
  _id: RUN_ID,
  sessionId: "s1",
  question: "how many repos?",
  status: "done",
  route: "stats",
  answer: "106 repositories.",
  error: null,
  documents: [{ id: "a", title: "A doc", content_full: "body", summary_for_embedding: "keyword soup" }],
  documentIds: ["a"],
  documentCount: 1,
  startedAt: new Date("2026-09-13T10:00:00Z"),
  finishedAt: new Date("2026-09-13T10:00:04Z"),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Phase 10: mail in the feed, and the browser's report-back
// ---------------------------------------------------------------------------

const SUBMISSION_ID = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);

test("the feed returns the mail action a run produced, and null otherwise", async () => {
  const mail = { type: "confirm", display: "confirm_card", body: "hello" };
  const restore = stub(runs, {
    getRun: async () => finishedRun({ route: "action", documents: [], mail }),
    listSteps: async () => [],
  });

  try {
    await withServer(async (base) => {
      assert.deepEqual((await (await call(base, `${P}/runs/${RUN_ID}`)).json()).data.mail, mail);
    });
  } finally {
    restore();
  }

  const restorePlain = stub(runs, { getRun: async () => finishedRun(), listSteps: async () => [] });
  try {
    await withServer(async (base) => {
      assert.equal((await (await call(base, `${P}/runs/${RUN_ID}`)).json()).data.mail, null);
    });
  } finally {
    restorePlain();
  }
});

test("POST /mail/:id/result records the browser's outcome", async () => {
  const seen = [];
  const restore = stub(agent, {
    reportMailResult: async (report) => {
      seen.push(report);
      return { outcome: "recorded", row: { status: report.status, digestMatches: true } };
    },
  });

  try {
    await withServer(async (base) => {
      const response = await call(base, `${P}/mail/${SUBMISSION_ID}/result`, {
        method: "POST",
        body: { status: "sent", digest: DIGEST },
      });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, { submissionId: SUBMISSION_ID, status: "sent", digestMatches: true });
      assert.deepEqual(seen, [{ submissionId: SUBMISSION_ID, status: "sent", digest: DIGEST }]);
    });
  } finally {
    restore();
  }
});

test("the mail report answers 404 for an unknown id and 409 for a second report", async () => {
  let outcome = "not_found";
  const restore = stub(agent, { reportMailResult: async () => ({ outcome, row: { status: "sent" } }) });

  try {
    await withServer(async (base) => {
      const path = `${P}/mail/${SUBMISSION_ID}/result`;
      assert.equal((await call(base, path, { method: "POST", body: { status: "sent" } })).status, 404);
      outcome = "already_final";
      const conflict = await call(base, path, { method: "POST", body: { status: "failed" } });
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).code, "MAIL_ALREADY_REPORTED");
    });
  } finally {
    restore();
  }
});

test("the mail report validates its input and requires the password", async () => {
  const restore = stub(agent, {
    reportMailResult: async () => {
      throw new Error("must not be called");
    },
  });

  try {
    await withServer(async (base) => {
      const path = `${P}/mail/${SUBMISSION_ID}/result`;
      assert.equal((await call(base, path, { method: "POST", password: null, body: { status: "sent" } })).status, 401);
      assert.equal((await call(base, `${P}/mail/not-a-uuid/result`, { method: "POST", body: { status: "sent" } })).status, 400);
      assert.equal((await call(base, path, { method: "POST", body: { status: "delivered" } })).status, 400);
      assert.equal((await call(base, path, { method: "POST", body: { status: "sent", digest: "short" } })).status, 400);
    });
  } finally {
    restore();
  }
});

test("mail on: the spec documents the mail route and the mail field again", () => {
  const spec = buildOpenApiDocument({ mailEnabled: true });

  assert.ok(spec.paths["/api/v1/moonmind/mail/{submissionId}/result"].post);
  assert.ok(spec.components.schemas.MailAction);
  assert.ok(spec.components.schemas.ChatResponse.properties.data.properties.mail);
});
