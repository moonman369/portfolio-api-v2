"use strict";

// The booking-link check (Phase 10.1), with `fetch` and the clock faked: no network, ever.
// The response shapes are the ones probed against cal.com at the Phase 10.1 gate — a live
// event page is a 200, a missing event or user is a real 404.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "t";
process.env.REFRESH_PROFILE ??= "p";
process.env.REFRESH_SECRET ??= "s";
process.env.OPENAI_API_KEY ??= "sk-test";
process.env.MOONMIND_PASSWORD ??= "pw";
process.env.GEMINI_API_KEY ??= "gem-test";
process.env.TAVILY_API_KEY ??= "tvly-test";
process.env.MOONMIND_BOOKING_URL_15MIN ??= "https://cal.com/example/15min";
process.env.MOONMIND_BOOKING_URL_30MIN ??= "https://cal.com/example/30min";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLinkChecker, classifyStatus, LINK_OUTCOMES } = require("../../src/integrations/scheduling");

const URL_15 = "https://cal.com/example/15min";

/** A fake fetch: `respond(url, init)` returns a status, or throws. Records every call. */
function fakeFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const status = await respond(url, init);
    let cancelled = false;
    return { status, body: { cancel: async () => { cancelled = true; } }, get cancelled() { return cancelled; } };
  };
  impl.calls = calls;
  return impl;
}

function checker(respond, { cacheMs = 300_000 } = {}) {
  const clock = { now: 1_000_000 };
  const fetchImpl = fakeFetch(respond);
  const check = createLinkChecker({ fetchImpl, now: () => clock.now, timeoutMs: 3000, cacheMs });
  return { check, fetchImpl, clock };
}

test("a live event page (200) is ok", async () => {
  const { check, fetchImpl } = checker(() => 200);

  assert.deepEqual(await check(URL_15), { outcome: "ok", httpStatus: 200, errorCode: null });
  assert.equal(fetchImpl.calls[0].init.method, "GET");
  assert.equal(fetchImpl.calls[0].init.redirect, "follow");
  assert.ok(fetchImpl.calls[0].init.signal instanceof AbortSignal, "every check carries a timeout");
});

test("a missing or disabled event (404, or 410) is not_found", async () => {
  assert.equal((await checker(() => 404).check(URL_15)).outcome, "not_found");
  assert.equal((await checker(() => 410).check(URL_15)).outcome, "not_found");
});

test("a 5xx, a timeout and a thrown error are all unreachable", async () => {
  assert.deepEqual(await checker(() => 503).check(URL_15), { outcome: "unreachable", httpStatus: 503, errorCode: null });

  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  assert.deepEqual(
    await checker(() => {
      throw timeout;
    }).check(URL_15),
    { outcome: "unreachable", httpStatus: null, errorCode: "TIMEOUT" },
  );

  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  assert.deepEqual(
    await checker(() => {
      throw refused;
    }).check(URL_15),
    { outcome: "unreachable", httpStatus: null, errorCode: "ECONNREFUSED" },
  );
});

test("the check never rejects, even when fetch itself is broken", async () => {
  const check = createLinkChecker({
    fetchImpl: () => {
      throw new Error("not a function of anything");
    },
    timeoutMs: 3000,
    cacheMs: 1000,
  });
  assert.equal((await check(URL_15)).outcome, "unreachable");
});

test("results are cached per URL — failures too — and refreshed once the time passes", async () => {
  let status = 404;
  const { check, fetchImpl, clock } = checker(() => status, { cacheMs: 300_000 });

  assert.equal((await check(URL_15)).outcome, "not_found");
  status = 200;
  clock.now += 299_999;
  assert.equal((await check(URL_15)).outcome, "not_found", "a failure is cached like a success");
  assert.equal(fetchImpl.calls.length, 1);

  clock.now += 2;
  assert.equal((await check(URL_15)).outcome, "ok");
  assert.equal(fetchImpl.calls.length, 2, "one new call after the cache time");

  await check("https://cal.com/example/30min");
  assert.equal(fetchImpl.calls.length, 3, "each URL has its own entry");
});

test("status classification", () => {
  assert.equal(classifyStatus(200), "ok");
  assert.equal(classifyStatus(204), "ok");
  assert.equal(classifyStatus(404), "not_found");
  assert.equal(classifyStatus(410), "not_found");
  assert.equal(classifyStatus(500), "unreachable");
  assert.equal(classifyStatus(429), "unreachable");
  assert.deepEqual([...LINK_OUTCOMES], ["ok", "not_found", "unreachable"]);
});
