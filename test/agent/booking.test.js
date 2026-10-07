"use strict";

// Phase 10.1: `book` with Cal.com links, checked before they are shown, and mail paused
// behind MOONMIND_MAIL_ENABLED — through a real compiled graph and the real run feed
// (`streamTurn`), with the router model, the link check and every mail dependency faked.
// Mail is OFF here, as it is by default; the flag-on mail flow is action.test.js.

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
const { MemorySaver } = require("@langchain/langgraph");

const { getConfig } = require("../../src/config");
const { streamTurn } = require("../../src/agent");
const { buildGraph } = require("../../src/agent/graph");
const { ROUTES } = require("../../src/agent/state");
const { createRouterNode } = require("../../src/agent/nodes/router");
const { createGenerateNode } = require("../../src/agent/nodes/generate");
const { createActionNode } = require("../../src/agent/nodes/action");
const { refusal, listCapabilities } = require("../../src/agent/nodes/simple");
const { createLinkChecker } = require("../../src/integrations/scheduling");
const {
  BOOKING_NOT_FOUND_ANSWER,
  BOOKING_UNREACHABLE_ANSWER,
  ERROR_ANSWER,
  TIMEZONE_NOTE,
  buildCapabilitiesAnswer,
  buildRefusalAnswer,
  buildOutOfScopeAnswer,
} = require("../../src/agent/prompts");

const URL_15 = "https://cal.com/example/15min";
const URL_30 = "https://cal.com/example/30min";

/** A structured-output model that replays scripted answers and counts its calls. */
function scripted(answers) {
  const queue = [...answers];
  const model = {
    calls: 0,
    withStructuredOutput: () => ({
      invoke: async () => {
        model.calls += 1;
        if (queue.length === 0) throw new Error("unexpected model call");
        return queue.shift();
      },
    }),
  };
  return model;
}

const classified = (route, extra = {}) => ({
  route,
  confidence: 0.95,
  which: null,
  withDocuments: false,
  action: null,
  preference: null,
  duration: null,
  cancelsActiveFlow: false,
  ...extra,
});

const book = (extra = {}) => classified("action", { action: "book", ...extra });

/** Cal.com, faked: `statuses[url]` is a status code or a function that throws. */
function fakeCalcom(statuses = {}) {
  const clock = { now: 0 };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const status = statuses[url] ?? 200;
    return { status: typeof status === "function" ? status() : status };
  };
  const checkLink = createLinkChecker({ fetchImpl, now: () => clock.now, timeoutMs: 3000, cacheMs: 300_000 });
  return { checkLink, calls, clock };
}

/** The mail dependencies, every one of them counting — with mail off, all must stay at 0. */
function mailFakes() {
  const counts = { capture: 0, validate: 0, store: 0 };
  return {
    counts,
    model: {
      withStructuredOutput: () => ({
        invoke: async () => {
          counts.capture += 1;
          return { senderName: null, senderEmail: null, subject: "s", body: "b" };
        },
      }),
    },
    validate: async () => {
      counts.validate += 1;
      return { ok: true };
    },
    store: {
      capReached: async () => {
        counts.store += 1;
        return null;
      },
      recordMailEvent: async (event) => {
        counts.store += 1;
        return event;
      },
    },
  };
}

/**
 * One session through the real router, action and generate nodes. Every other route's
 * node records that it ran. `mailEnabled` switches the flag for both nodes that read it.
 */
function harness({ routes = [], calcom = fakeCalcom(), mailEnabled = false, checkpointer = new MemorySaver(), checkLink } = {}) {
  const base = getConfig();
  const config = mailEnabled ? { ...base, mail: { ...base.mail, enabled: true, accessKey: "public-access-key" } } : base;
  const routerModel = scripted(routes);
  const mail = mailFakes();
  const visited = [];

  const nodes = { router: createRouterNode({ model: routerModel, config }), generate: createGenerateNode() };
  ROUTES.forEach((route) => {
    nodes[route] = async () => {
      visited.push(route);
      return { finalAnswer: `answer from ${route}` };
    };
  });
  const action = createActionNode({
    config,
    checkLink: checkLink ?? calcom.checkLink,
    model: mail.model,
    validate: mail.validate,
    store: mail.store,
  });
  nodes.action = async (state, runConfig) => {
    visited.push("action");
    return action(state, runConfig);
  };

  const graph = buildGraph({ nodes, checkpointer, topicChangeConfidence: 0.8 });
  const sessionId = "booking-session";
  let n = 0;

  /** One turn through the run feed: the steps it streamed, its answer, and the state after. */
  async function say(message) {
    n += 1;
    const iterator = streamTurn({ sessionId, message, runId: `run-${n}` }, { graph });
    const steps = [];
    let next = await iterator.next();
    while (!next.done) {
      steps.push(next.value);
      next = await iterator.next();
    }
    const { values } = await graph.getState({ configurable: { thread_id: sessionId } });
    return { answer: next.value.answer, steps, state: values, turn: next.value };
  }

  return { say, visited, routerModel, mail, calcom };
}

/** The feed's `book_link_error` entries: the error step each failed link records. */
const linkErrors = (steps) => steps.filter((step) => step.node === "action.book_link_error" && step.type === "error");

const NO_AVAILABILITY = /\b(hours?|windows?|weekdays?|weekends?|IST|UTC|GMT|PST|EST|Asia\/|Europe\/|America\/|\d{1,2}\s?(am|pm))\b/i;
const NO_BOOKING_CLAIM = /\b(booked|scheduled|confirmed|reserved)\b|is (free|available) (at|on)/i;
const NO_LEAKS = /\b[1-5]\d\d\b|https?:\/\/[^\s]*no-such|Error|ECONN|TIMEOUT|\bat .*\.js/;

// ---------------------------------------------------------------------------
// book — the replies
// ---------------------------------------------------------------------------

test("book, no length: both links labelled, the choice question, one model call, no tool", async () => {
  const h = harness({ routes: [book()] });

  const { answer, steps, state } = await h.say("I'd like to book a call with Ayan");

  assert.ok(answer.includes(`**15 minutes:** ${URL_15}`));
  assert.ok(answer.includes(`**30 minutes:** ${URL_30}`));
  assert.match(answer, /Which works better\?/);
  assert.ok(answer.includes(TIMEZONE_NOTE), "the visitor's own timezone, and only that");
  assert.doesNotMatch(answer, NO_AVAILABILITY);
  assert.equal(h.routerModel.calls, 1, "routing is the only model call");
  assert.equal(h.mail.counts.capture, 0);
  assert.equal(steps.filter((step) => step.type === "tool").length, 0, "no tool call");
  assert.deepEqual(h.visited, ["action"]);
  assert.equal(state.activeFlow, null);
});

test("book with 15 or 30: only the matching link", async () => {
  const fifteen = await harness({ routes: [book({ duration: 15 })] }).say("a quick 15-minute chat?");
  assert.ok(fifteen.answer.includes(URL_15));
  assert.ok(!fifteen.answer.includes(URL_30));
  assert.ok(fifteen.answer.includes(TIMEZONE_NOTE));
  assert.doesNotMatch(fifteen.answer, /Which works better/);

  const thirty = await harness({ routes: [book({ duration: 30 })] }).say("can we do half an hour?");
  assert.ok(thirty.answer.includes(URL_30));
  assert.ok(!thirty.answer.includes(URL_15));
});

test("book for an hour: says only 15 and 30 are offered, and shows both", async () => {
  const { answer } = await harness({ routes: [book({ duration: 60 })] }).say("can I get an hour with him?");

  assert.match(answer, /only offer 15- or 30-minute calls/);
  assert.ok(answer.includes(URL_15) && answer.includes(URL_30));
});

test("a stated preference is echoed, never promised", async () => {
  const { answer } = await harness({ routes: [book({ preference: "Tuesday afternoon" })] }).say("Tuesday afternoon?");

  assert.ok(answer.includes("Tuesday afternoon"));
  assert.match(answer, /can't promise/);
});

// ---------------------------------------------------------------------------
// The follow-up: inheritance, not a flow
// ---------------------------------------------------------------------------

test("a bare '30' after the both-links reply inherits book and gets only the 30-minute link", async () => {
  // The bare "30" classified cold is unsure and off-target — exactly the case inheritance is for.
  const h = harness({ routes: [book(), classified("knowledge", { confidence: 0.3, duration: 30 })] });

  const first = await h.say("can I book a call?");
  assert.equal(first.state.activeFlow, null);

  const second = await h.say("30");
  assert.equal(second.turn.route, "action");
  assert.equal(second.state.slots.action, "book");
  assert.equal(second.state.slots.duration, 30);
  assert.ok(second.answer.includes(URL_30));
  assert.ok(!second.answer.includes(URL_15));
  assert.equal(second.state.activeFlow, null, "activeFlow is never set");
  assert.deepEqual(h.visited, ["action", "action"]);
});

test("a confident follow-up that names no half ('the short one') stays a booking, keeping the preference", async () => {
  const h = harness({
    routes: [book({ preference: "Friday" }), classified("action", { confidence: 0.9, duration: 15 })],
  });

  await h.say("book a call on Friday");
  const second = await h.say("the short one");

  assert.ok(second.answer.includes(URL_15) && !second.answer.includes(URL_30));
  assert.ok(second.answer.includes("Friday"));
  assert.equal(second.state.activeFlow, null);
});

test("a length the model misfiles as the preference is not echoed as one", async () => {
  // Measured live: a bare "15" came back with preference "15" as well as duration 15.
  const h = harness({ routes: [book(), book({ duration: 15, preference: "15" })] });

  await h.say("book a call");
  const second = await h.say("15");

  assert.ok(second.answer.includes(URL_15) && !second.answer.includes(URL_30));
  assert.doesNotMatch(second.answer, /You mentioned/);
  assert.equal(second.state.slots.preference, undefined);
});

test("an unsure turn after something other than a booking does not inherit action", async () => {
  const h = harness({ routes: [classified("knowledge"), classified("knowledge", { confidence: 0.3, duration: 30 })] });

  await h.say("what does he work on?");
  const second = await h.say("30");

  assert.equal(second.turn.route, "knowledge");
  assert.deepEqual(h.visited, ["knowledge", "knowledge"]);
});

// ---------------------------------------------------------------------------
// The link check: cache, and the failure replies
// ---------------------------------------------------------------------------

test("two book requests inside the cache time check each URL once; after it, again", async () => {
  const calcom = fakeCalcom();
  const h = harness({ routes: [book(), book(), book()], calcom });

  await h.say("book a call");
  await h.say("book a call");
  assert.deepEqual(calcom.calls.sort(), [URL_15, URL_30]);

  calcom.clock.now += 300_001;
  await h.say("book a call");
  assert.equal(calcom.calls.length, 4, "one new call per URL once the cache time has passed");
});

test("15 down, 30 fine: names the problem plainly, offers only the 30-minute link, logs it", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const h = harness({ routes: [book()], calcom: fakeCalcom({ [URL_15]: 404 }) });

  const { answer, steps } = await h.say("book a call");

  assert.match(answer, /The 15-minute option isn't available right now — its booking page couldn't be found/);
  assert.ok(answer.includes(URL_30));
  assert.ok(!answer.includes(URL_15), "the broken link is not shown");
  assert.doesNotMatch(answer, NO_LEAKS);

  const logged = linkErrors(steps);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].type, "error");
  assert.match(logged[0].summary, /15min not_found status=404/);
  assert.ok(logged[0].summary.includes(URL_15), "Ayan sees which link broke");

  const call = warn.mock.calls.find((c) => c.arguments[0] === "agent.action.book_link_error");
  assert.equal(call.arguments[1].runId, "run-1");
  assert.equal(call.arguments[1].sessionId, "booking-session");
  assert.equal(call.arguments[1].httpStatus, 404);
});

test("the length asked for is down: says so, and offers the other", async (t) => {
  t.mock.method(console, "warn", () => {});
  const h = harness({ routes: [book({ duration: 15 })], calcom: fakeCalcom({ [URL_15]: 503 }) });

  const { answer } = await h.say("15 minutes please");

  assert.match(answer, /The 15-minute meeting you asked for isn't available right now — Cal.com isn't responding for it/);
  assert.match(answer, /book a 30-minute call with Ayan instead/);
  assert.ok(answer.includes(URL_30) && !answer.includes(URL_15));
  assert.doesNotMatch(answer, NO_LEAKS);
});

test("both not_found: the 'couldn't be found' reply, no link", async (t) => {
  t.mock.method(console, "warn", () => {});
  const h = harness({ routes: [book()], calcom: fakeCalcom({ [URL_15]: 404, [URL_30]: 404 }) });

  const { answer, steps } = await h.say("book a call");

  assert.equal(answer, BOOKING_NOT_FOUND_ANSWER);
  assert.equal(linkErrors(steps).length, 2);
});

test("both unreachable (a 5xx and a timeout): the 'not responding' reply, no link", async (t) => {
  t.mock.method(console, "warn", () => {});
  const timeout = () => {
    throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
  };
  const h = harness({ routes: [book()], calcom: fakeCalcom({ [URL_15]: 502, [URL_30]: timeout }) });

  const { answer, steps } = await h.say("book a call");

  assert.equal(answer, BOOKING_UNREACHABLE_ANSWER);
  const summaries = linkErrors(steps).map((step) => step.summary);
  assert.equal(summaries.length, 2);
  assert.ok(summaries.some((summary) => /status=502/.test(summary)));
  assert.ok(summaries.some((summary) => /code=TIMEOUT/.test(summary)));
  assert.doesNotMatch(answer, NO_LEAKS);
});

test("a check that throws is just unreachable — it never reaches the error boundary", async (t) => {
  t.mock.method(console, "warn", () => {});
  const h = harness({
    routes: [book()],
    checkLink: async () => {
      throw new Error("boom at checkBookingLink (scheduling.js:12)");
    },
  });

  const { answer, turn } = await h.say("book a call");

  assert.equal(answer, BOOKING_UNREACHABLE_ANSWER);
  assert.notEqual(answer, ERROR_ANSWER);
  assert.equal(turn.error, null);
});

test("no book reply, in any case, says a meeting was booked or scheduled", async (t) => {
  t.mock.method(console, "warn", () => {});
  const cases = [
    [book(), {}],
    [book({ duration: 15 }), {}],
    [book({ duration: 60 }), {}],
    [book({ preference: "Monday" }), {}],
    [book(), { [URL_15]: 404 }],
    [book({ duration: 30 }), { [URL_30]: 500 }],
    [book(), { [URL_15]: 404, [URL_30]: 404 }],
    [book(), { [URL_15]: 503, [URL_30]: 503 }],
    [book(), { [URL_15]: 404, [URL_30]: 503 }],
  ];

  for (const [route, statuses] of cases) {
    const { answer } = await harness({ routes: [route], calcom: fakeCalcom(statuses) }).say("book");
    assert.doesNotMatch(answer, NO_BOOKING_CLAIM, answer);
    assert.doesNotMatch(answer, NO_AVAILABILITY, answer);
  }
});

// ---------------------------------------------------------------------------
// Mail paused (the default)
// ---------------------------------------------------------------------------

test("mail off: a mail request gets the paused reply and the links; nothing mail-related runs", async () => {
  const h = harness({ routes: [classified("action", { action: "mail" })] });

  const { answer, state, turn } = await h.say("can you pass a message to Ayan for me?");

  assert.match(answer, /^Sending messages isn't available right now, but you can book a 15- or 30-minute call with Ayan instead\./);
  assert.ok(answer.includes(URL_15) && answer.includes(URL_30));
  assert.deepEqual(h.mail.counts, { capture: 0, validate: 0, store: 0 }, "no extraction, no MX, no mail_events");
  assert.equal(turn.mail, null, "no Web3Forms payload, no confirm card");
  assert.equal(state.activeFlow, null);
  assert.equal(state.pendingConfirmation, null);
});

test("mail off: the paused reply never offers booking when no link works", async (t) => {
  t.mock.method(console, "warn", () => {});
  const h = harness({
    routes: [classified("action", { action: "mail" })],
    calcom: fakeCalcom({ [URL_15]: 503, [URL_30]: 503 }),
  });

  const { answer } = await h.say("send Ayan an email");

  assert.equal(answer, `Sending messages isn't available right now.\n\n${BOOKING_UNREACHABLE_ANSWER}`);
});

test("mail off: a thread checkpointed mid-mail gets the paused reply once, cleared, then routes normally", async () => {
  const checkpointer = new MemorySaver();
  const draft = { senderName: null, senderEmail: "jane@example.com", subject: "s", body: "b" };

  // Before the pause: mail on, the visitor reaches the confirmation step.
  const before = harness({ routes: [classified("action", { action: "mail" })], mailEnabled: true, checkpointer });
  before.mail.model.withStructuredOutput = () => ({ invoke: async () => draft });
  const held = await before.say("send Ayan a message, jane@example.com");
  assert.equal(held.state.activeFlow, "action");
  assert.equal(held.state.pendingConfirmation.kind, "mail");
  assert.ok(held.state.slots.mailDraft);

  // After the pause: same thread, mail off. The waiting "yes" must not send anything.
  const after = harness({ routes: [classified("knowledge")], checkpointer });
  const paused = await after.say("yes");
  assert.match(paused.answer, /^Sending messages isn't available right now/);
  assert.equal(after.routerModel.calls, 0, "held deterministically, not classified");
  assert.deepEqual(after.mail.counts, { capture: 0, validate: 0, store: 0 });
  assert.equal(paused.turn.mail, null);
  assert.equal(paused.state.activeFlow, null);
  assert.equal(paused.state.pendingConfirmation, null);
  assert.equal(paused.state.slots.mailDraft, undefined);

  const next = await after.say("what does he work on?");
  assert.equal(next.turn.route, "knowledge");
  assert.equal(after.routerModel.calls, 1);
  assert.deepEqual(after.visited, ["action", "knowledge"]);
});

test("mail off: an unclear 'reach Ayan' request gets the booking links, not a mail offer", async () => {
  const { answer } = await harness({ routes: [classified("action")] }).say("how do I reach Ayan?");

  assert.ok(answer.includes(URL_15) && answer.includes(URL_30));
  assert.doesNotMatch(answer, /message|mail/i);
});

test("mail off: capabilities and refusal offer scheduling, not messages", async () => {
  const capabilities = (await listCapabilities()).finalAnswer;
  assert.doesNotMatch(capabilities, /message|mail/i);
  assert.match(capabilities, /book time/);

  const declined = (await refusal()).finalAnswer;
  assert.doesNotMatch(declined, /message|mail/i);
  assert.match(declined, /book a call/);
});

test("mail on: the same copy offers messages again", () => {
  assert.match(buildCapabilitiesAnswer({ mailEnabled: true }), /pass a message along/);
  assert.match(buildRefusalAnswer({ mailEnabled: true }), /pass a message along/);
  assert.match(buildOutOfScopeAnswer({ mailEnabled: true }), /pass a message along/);
  assert.doesNotMatch(buildOutOfScopeAnswer(), /message|mail/i);
});
