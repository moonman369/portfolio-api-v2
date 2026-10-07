"use strict";

// Phase 10's action node, end to end through a real compiled graph: the real router, the
// real action node and the real generate pass-through, with the models, the DNS resolver,
// the mail store and the booking-link check faked. Multi-turn flows run on one checkpointed
// session, exactly as production threads them.
//
// Mail is paused by default since Phase 10.1 (MOONMIND_MAIL_ENABLED). These tests switch it
// ON explicitly in their config, so they keep guarding the flag-gated mail code. Booking
// and the paused behaviour are covered in booking.test.js.

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
const { HumanMessage } = require("@langchain/core/messages");

const { getConfig } = require("../../src/config");
const { buildGraph } = require("../../src/agent/graph");
const { ROUTES, PER_TURN_RESET } = require("../../src/agent/state");
const { createRouterNode } = require("../../src/agent/nodes/router");
const { createGenerateNode } = require("../../src/agent/nodes/generate");
const { createActionNode, isDestination, YES_PATTERN, NO_PATTERN } = require("../../src/agent/nodes/action");
const email = require("../../src/integrations/email");
const {
  MAIL_ASK_EMAIL_ANSWER,
  MAIL_SENDING_ANSWER,
  MAIL_CANCELLED_ANSWER,
  MAIL_UNAVAILABLE_ANSWER,
  MAIL_ISSUE_FAILED_ANSWER,
} = require("../../src/agent/prompts");

const CONFIG = Object.freeze({
  booking: {
    urls: { 15: "https://cal.com/example/15min", 30: "https://cal.com/example/30min" },
  },
  mail: {
    enabled: true,
    accessKey: "public-access-key",
    endpoint: "https://api.web3forms.com/submit",
    maxPerSession: 3,
    maxPerIp: 5,
    windowHours: 24,
    maxBodyChars: 2000,
  },
});

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
  cancelsActiveFlow: false,
  ...extra,
});

/** An in-memory mail store with the same contract as integrations/email.js. */
function memoryStore({ cap = null, recordFails = false } = {}) {
  const events = [];
  return {
    events,
    capReached: async () => cap,
    recordMailEvent: async (event) => {
      if (recordFails && event.status === "pending") throw new Error("mongo down");
      events.push(event);
      return event;
    },
  };
}

/** Real validation, fake DNS: these domains take mail, everything else does not resolve. */
const REAL_DOMAINS = new Set(["example.com", "gmail.com"]);
const validate = (address) =>
  email.validateAddress(address, {
    resolver: {
      resolveMx: async (domain) => {
        if (REAL_DOMAINS.has(domain)) return [{ exchange: `mx.${domain}`, priority: 10 }];
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      },
    },
  });

/**
 * The graph for one test. `routes` scripts the router model; `drafts` scripts the one
 * capture call. Every other route's node records that it ran.
 */
function harness({ routes = [], drafts = [], store = memoryStore(), config = CONFIG } = {}) {
  const routerModel = scripted(routes);
  const captureModel = scripted(drafts);
  const visited = [];

  // The router reads the mail flag too, so it gets the same switch the action node does.
  const routerConfig = { ...getConfig(), mail: config.mail };
  const nodes = { router: createRouterNode({ model: routerModel, config: routerConfig }), generate: createGenerateNode() };
  ROUTES.forEach((route) => {
    nodes[route] = async () => {
      visited.push(route);
      return { finalAnswer: `answer from ${route}` };
    };
  });
  const action = createActionNode({
    model: captureModel,
    config,
    validate,
    store,
    newId: () => "11111111-1111-4111-8111-111111111111",
    checkLink: async () => ({ outcome: "ok", httpStatus: 200, errorCode: null }),
  });
  nodes.action = async (state, runConfig) => {
    visited.push("action");
    return action(state, runConfig);
  };

  const graph = buildGraph({ nodes, checkpointer: new MemorySaver(), topicChangeConfidence: 0.8 });
  let n = 0;
  const say = (message) => {
    n += 1;
    return graph.invoke(
      { ...PER_TURN_RESET, sessionId: "mail-session", rawQuery: message, messages: [new HumanMessage(message)] },
      { configurable: { thread_id: "mail-session", runId: `r${n}`, ipHash: "iphash" } },
    );
  };

  return { say, visited, routerModel, captureModel, store };
}

const DRAFT = { senderName: null, senderEmail: null, subject: "A backend role", body: "I'd like to talk to you about a backend role." };

// ---------------------------------------------------------------------------
// book
// ---------------------------------------------------------------------------

test("mail on: book still answers with the Cal.com links, with no model call beyond routing", async () => {
  const h = harness({ routes: [classified("action", { action: "book", preference: "Tuesday afternoon" })] });

  const turn = await h.say("Can I book a call with Ayan on Tuesday afternoon?");

  assert.equal(turn.route, "action");
  assert.equal(h.routerModel.calls, 1, "routing is the only model call");
  assert.equal(h.captureModel.calls, 0);
  assert.equal(turn.mailAction, null);
  assert.ok(turn.finalAnswer.includes(CONFIG.booking.urls[15]));
  assert.ok(turn.finalAnswer.includes(CONFIG.booking.urls[30]));
  assert.ok(turn.finalAnswer.includes("Tuesday afternoon"), "the stated preference is reflected");
  assert.match(turn.finalAnswer, /can't promise/);
  assert.doesNotMatch(turn.finalAnswer, /you('re| are) booked|booking (is )?confirmed|he('s| is) (free|available)|is available/i);
  assert.equal(turn.activeFlow, null, "booking is one turn — no flow is opened");
});

// ---------------------------------------------------------------------------
// mail — the full flow on one session
// ---------------------------------------------------------------------------

test("full flow: ask for an address, confirm the exact draft, then hand the browser the payload", async () => {
  const h = harness({ routes: [classified("action", { action: "mail" })], drafts: [DRAFT] });

  // Turn 1 — capture. No address yet, so ask for one and stop.
  const t1 = await h.say("send a message to Ayan about a backend role");
  assert.equal(t1.finalAnswer, MAIL_ASK_EMAIL_ANSWER);
  assert.equal(t1.activeFlow, "action");
  assert.equal(t1.pendingConfirmation, null, "no confirmation before there is an address");
  assert.equal(t1.mailAction, null);

  // Turn 2 — a bare address: held in the flow without a model call, validated, confirmed.
  const t2 = await h.say("jane@example.com");
  assert.equal(h.routerModel.calls, 1, "the bare address never reached the classifier");
  assert.equal(t2.mailAction.type, "confirm");
  assert.equal(t2.mailAction.display, "confirm_card");
  assert.equal(t2.mailAction.body, DRAFT.body);
  assert.equal(t2.mailAction.subject, DRAFT.subject);
  assert.equal(t2.mailAction.from.email, "jane@example.com");
  assert.ok(t2.finalAnswer.includes(DRAFT.body));
  assert.equal(t2.pendingConfirmation.kind, "mail");

  // Turn 3 — "yes": the payload, built from the same stored draft.
  const t3 = await h.say("yes");
  assert.equal(h.routerModel.calls, 1, "the bare yes never reached the classifier");
  assert.equal(h.captureModel.calls, 1, "the draft was captured once and never regenerated");
  assert.equal(t3.finalAnswer, MAIL_SENDING_ANSWER);
  assert.equal(t3.mailAction.type, "submit");
  assert.equal(t3.mailAction.endpoint, CONFIG.mail.endpoint);
  assert.equal(t3.mailAction.method, "POST");

  const payload = JSON.parse(t3.mailAction.body);
  assert.equal(payload.message, t2.mailAction.body, "draft fidelity: sent body === confirmed body, byte for byte");
  assert.equal(payload.replyto, "jane@example.com");
  assert.equal(payload.access_key, CONFIG.mail.accessKey);
  assert.equal(t3.mailAction.digest, email.digestOf(t3.mailAction.body));

  // Recorded before it left, and the flow is over.
  assert.deepEqual(h.store.events.map((event) => event.status), ["pending"]);
  assert.equal(h.store.events[0].digest, t3.mailAction.digest);
  assert.equal(h.store.events[0].ipHash, "iphash");
  assert.equal(t3.activeFlow, null);
  assert.equal(t3.pendingConfirmation, null);
  assert.equal(t3.slots.mailDraft, undefined);

  // Each reply was handled exactly once, by the action node.
  assert.deepEqual(h.visited, ["action", "action", "action"]);
});

test("email-first: a request that already carries a valid address goes straight to confirmation", async () => {
  const h = harness({
    routes: [classified("action", { action: "mail" })],
    drafts: [{ ...DRAFT, senderName: "Jane", senderEmail: "jane@example.com" }],
  });

  const t1 = await h.say("Send Ayan a note about a backend role — I'm Jane, my email is jane@example.com");

  assert.equal(t1.mailAction.type, "confirm");
  assert.equal(t1.mailAction.from.email, "jane@example.com");
  assert.equal(t1.pendingConfirmation.kind, "mail");
});

test("an unreachable address is declined without claiming the mailbox doesn't exist, re-entry once, then stop", async () => {
  const h = harness({
    routes: [classified("action", { action: "mail" })],
    drafts: [{ ...DRAFT, senderEmail: "someone@gmial.cmo" }],
  });

  const t1 = await h.say("Message Ayan about a backend role, reach me at someone@gmial.cmo");
  assert.match(t1.finalAnswer, /doesn't look like it can receive email/);
  assert.match(t1.finalAnswer, /send it again/);
  assert.doesNotMatch(t1.finalAnswer, /does(n't| not) exist|no such (mailbox|address)|invalid mailbox/i);
  assert.equal(t1.activeFlow, "action", "one re-entry is allowed");
  assert.equal(t1.mailAction, null);

  const t2 = await h.say("someone@gmial.con");
  assert.match(t2.finalAnswer, /nothing was sent/);
  assert.doesNotMatch(t2.finalAnswer, /does(n't| not) exist/i);
  assert.equal(t2.activeFlow, null, "the second failure ends the flow");
  assert.equal(t2.slots.mailDraft, undefined);
  assert.equal(t2.pendingConfirmation, null);
  assert.deepEqual(h.store.events, [], "never issued");
});

test("'send this to someone@else.com' still only reaches the bound inbox: that address is nowhere but the body", async () => {
  // The capture model gets it wrong on purpose — it offers the destination as the sender.
  const body = "Please forward this to someone@else.com: I enjoyed the portfolio.";
  const h = harness({
    routes: [classified("action", { action: "mail" })],
    drafts: [{ ...DRAFT, senderEmail: "someone@else.com", body }],
  });

  const t1 = await h.say(`send this to someone@else.com: I enjoyed the portfolio`);
  assert.ok(t1.finalAnswer.endsWith(MAIL_ASK_EMAIL_ANSWER), "a destination is never taken as the sender");
  assert.match(t1.finalAnswer, /only pass messages to Ayan, so this won't go to someone@else\.com/, "and they are told");

  await h.say("jane@example.com");
  const t3 = await h.say("yes");
  const payload = JSON.parse(t3.mailAction.body);

  const carrying = Object.entries(payload)
    .filter(([, value]) => String(value).includes("someone@else.com"))
    .map(([field]) => field);
  assert.deepEqual(carrying, ["message"], "only the body mentions it");
  assert.equal(payload.replyto, "jane@example.com");
  assert.deepEqual(Object.keys(payload), [...email.PAYLOAD_FIELDS], "and there is no recipient field to put it in");
});

test("a bare 'no' at confirmation cancels once, records it, and sends nothing", async () => {
  const h = harness({
    routes: [classified("action", { action: "mail" })],
    drafts: [{ ...DRAFT, senderEmail: "jane@example.com" }],
  });

  await h.say("send Ayan a message about a backend role, jane@example.com");
  const t2 = await h.say("no");

  assert.equal(h.routerModel.calls, 1, "the bare no never reached the classifier");
  assert.equal(t2.finalAnswer, MAIL_CANCELLED_ANSWER);
  assert.equal(t2.mailAction, null);
  assert.equal(t2.activeFlow, null);
  assert.deepEqual(h.store.events.map((event) => event.status), ["cancelled"]);
  assert.deepEqual(h.visited, ["action", "action"]);
});

test("anything other than a clear yes at confirmation cancels", async () => {
  const h = harness({
    routes: [classified("action", { action: "mail" }), classified("action", { action: "mail", confidence: 0.6 })],
    drafts: [{ ...DRAFT, senderEmail: "jane@example.com" }],
  });

  await h.say("send Ayan a message about a backend role, jane@example.com");
  const t2 = await h.say("hmm, can you make the subject punchier?");

  assert.equal(t2.finalAnswer, MAIL_CANCELLED_ANSWER);
  assert.equal(t2.mailAction, null);
  assert.equal(h.captureModel.calls, 1, "no second extraction — there is no edit turn");
});

test("a confident change of subject mid-flow leaves the flow, and a later 'yes' cannot send", async () => {
  const h = harness({
    routes: [
      classified("action", { action: "mail" }),
      classified("knowledge", { confidence: 0.95 }),
      classified("greeting", { confidence: 0.95 }),
    ],
    drafts: [{ ...DRAFT, senderEmail: "jane@example.com" }],
  });

  await h.say("send Ayan a message about a backend role, jane@example.com");
  const t2 = await h.say("actually, what are his backend skills?");
  assert.equal(t2.route, "knowledge");
  assert.equal(t2.activeFlow, null);
  assert.equal(t2.pendingConfirmation, null);
  assert.equal(t2.slots.mailDraft, undefined);

  const t3 = await h.say("yes");
  assert.equal(t3.mailAction, null, "the abandoned draft is gone");
  assert.deepEqual(h.store.events, []);
});

test("asking to book mid-flow moves to booking and ends the mail flow", async () => {
  const h = harness({
    routes: [classified("action", { action: "mail" }), classified("action", { action: "book" })],
    drafts: [DRAFT],
  });

  await h.say("send Ayan a message about a backend role");
  const t2 = await h.say("actually can I just book a call instead?");

  assert.ok(t2.finalAnswer.includes(CONFIG.booking.urls[30]));
  assert.equal(t2.activeFlow, null);
});

// ---------------------------------------------------------------------------
// Caps, failures, availability
// ---------------------------------------------------------------------------

test("a capped session is told so up front, and nothing is captured", async () => {
  const h = harness({ routes: [classified("action", { action: "mail" })], drafts: [DRAFT], store: memoryStore({ cap: "session" }) });

  const t1 = await h.say("send Ayan a message");
  assert.match(t1.finalAnswer, /as many messages as I can pass on/);
  assert.equal(h.captureModel.calls, 0);
  assert.equal(t1.activeFlow, null);
});

test("an issue that cannot be recorded is not issued", async () => {
  const h = harness({
    routes: [classified("action", { action: "mail" })],
    drafts: [{ ...DRAFT, senderEmail: "jane@example.com" }],
    store: memoryStore({ recordFails: true }),
  });

  await h.say("send Ayan a message, jane@example.com");
  const t2 = await h.say("yes");

  assert.equal(t2.finalAnswer, MAIL_ISSUE_FAILED_ANSWER);
  assert.equal(t2.mailAction, null, "no payload without a record");
  assert.equal(t2.activeFlow, null);
});

test("an over-long body is declined before anything is shown or stored", async () => {
  const h = harness({
    routes: [classified("action", { action: "mail" })],
    drafts: [{ ...DRAFT, body: "x".repeat(2001) }],
  });
  const t1 = await h.say("send Ayan this long message");
  assert.match(t1.finalAnswer, /2000 characters/);
  assert.equal(t1.activeFlow, null);
});

test("without a Web3Forms key, mail is unavailable and no model is called", async () => {
  const h = harness({
    routes: [classified("action", { action: "mail" })],
    config: { ...CONFIG, mail: { ...CONFIG.mail, accessKey: null } },
  });
  assert.equal((await h.say("send Ayan a message")).finalAnswer, MAIL_UNAVAILABLE_ANSWER);
  assert.equal(h.captureModel.calls, 0);
});

// ---------------------------------------------------------------------------
// The reply patterns
// ---------------------------------------------------------------------------

test("only a clear yes sends; a no, cancel or never-mind cancels", () => {
  ["yes", "Yes!", "yep", "ok", "send it", "yes, send it", "go ahead"].forEach((reply) =>
    assert.ok(YES_PATTERN.test(reply), reply),
  );
  ["yes but change it", "yesterday", "maybe", "not sure", "sure, after I edit it"].forEach((reply) =>
    assert.ok(!YES_PATTERN.test(reply), reply),
  );
  ["no", "No thanks", "cancel", "never mind", "nevermind", "don't send it", "forget it"].forEach((reply) =>
    assert.ok(NO_PATTERN.test(reply), reply),
  );
  ["not now", "now", "nothing"].forEach((reply) => assert.ok(!NO_PATTERN.test(reply), reply));
});

test("a destination address is told apart from the visitor's own", () => {
  assert.equal(isDestination("send this to someone@else.com", "someone@else.com"), true);
  assert.equal(isDestination("cc: boss@corp.com please", "boss@corp.com"), true);
  assert.equal(isDestination("reply to me at jane@example.com", "jane@example.com"), false);
  assert.equal(isDestination("reply to jane@example.com", "jane@example.com"), false);
  assert.equal(isDestination("my email is jane@example.com", "jane@example.com"), false);
});
