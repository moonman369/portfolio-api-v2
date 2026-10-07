"use strict";

// The router: one structured-output classification per turn, with a deterministic
// fallback. It writes `route`, `routeConfidence` and `slots` — the decision about which
// node that maps to belongs to `routeFromState` in graph.js. The one exception is the mail
// flow (Phase 10): a reply the flow is waiting for is held without a model call, and a
// confident change of subject ends the flow here, clearing `activeFlow` and
// `pendingConfirmation` so a later "yes" can never send a draft the visitor walked away from.
// While mail is paused (Phase 10.1, MOONMIND_MAIL_ENABLED off) a thread still holding mail
// state from before is sent to `action` once, with that state cleared, for the paused reply.

const { z } = require("zod");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");
const { getConfig } = require("../../config");
const { getModel } = require("../models");
const {
  ROUTES,
  INHERITABLE_ROUTES,
  recentMessages,
  resolveLegacyRoute,
  restoreLegacySlots,
} = require("../state");
const { ROUTER_SYSTEM_PROMPT, buildRouterContext, CANNED_DEAD_ENDS } = require("../prompts");
const { inMailFlow, isMailFlowReply, hasMailState } = require("./action");

// Flat on purpose: models fill a flat object far more reliably than a nested one.
// `which`, `withDocuments` and `action` are lifted into `slots` before they reach state.
const RouterOutputSchema = z.object({
  route: z.enum(ROUTES),
  confidence: z.number().min(0).max(1),
  which: z.enum(["github", "leetcode", "both"]).nullable(),
  // The mixed "my github numbers AND my projects" question. Phase 7 collapsed the old
  // `stats_and_docs` route into this slot rather than keeping an eighth label — the same
  // shape as `action` below, and the composed node behind it is unchanged.
  withDocuments: z.boolean(),
  // Which half of `action` is wanted.
  action: z.enum(["book", "mail"]).nullable(),
  // A day or time the visitor asked to book ("Tuesday afternoon"). Only ever echoed back
  // as their own words — `book` never promises it.
  preference: z.string().nullable(),
  // The meeting length the visitor asked for, in minutes (Phase 10.1). Any length, not
  // just the offered ones: "an hour" has to arrive as 60 so `book` can say it isn't
  // offered. Which lengths ARE offered is config (`booking.urls`), not this schema.
  duration: z.number().int().nullable(),
  cancelsActiveFlow: z.boolean(),
});

// A preference is echoed into the answer, so it is kept short.
const PREFERENCE_MAX_CHARS = 60;

// A "preference" that is only a meeting length ("15", "30 min", "half an hour", "the
// shorter one") is `duration` misfiled. Measured: a bare "15" came back with
// preference "15", and the reply read "You mentioned 15 — pick an open time…".
const LENGTH_ONLY =
  /^(?:\d+|an?|one|half an?|the (?:short|long)(?:er|est)? one)(?:\s*-?\s*(?:m|mins?|minutes?|h|hrs?|hours?))?(?:\s+please)?[.!]*$/i;

/** The visitor's stated day or time, trimmed and bounded — or "" when there is none. */
function toPreference(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return LENGTH_ONLY.test(trimmed) ? "" : trimmed.slice(0, PREFERENCE_MAX_CHARS);
}

// Where an unusable classification lands. knowledge is the safe default: it is the most
// common intent, it is grounded in retrieved documents, and it cannot cause a side
// effect. Refusing instead would contradict the old pipeline's explicit rule that
// MoonMind never answers with a generic refusal.
const LOW_CONFIDENCE_ROUTE = "knowledge";

/** A usable length in minutes, or null. */
function toDuration(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function toSlots({ route, which, withDocuments, action, preference, duration }) {
  // Each slot is dropped everywhere it is meaningless, so a stray value from the model
  // cannot influence a node that has no business reading it.
  const slots = {};

  if (route === "stats") {
    if (which) slots.which = which;
    if (withDocuments === true) slots.withDocuments = true;
  }
  if (route === "action" && action) {
    slots.action = action;
  }
  const stated = toPreference(preference);
  if (route === "action" && action === "book" && stated) {
    slots.preference = stated;
  }
  if (route === "action" && action === "book" && toDuration(duration)) {
    slots.duration = toDuration(duration);
  }

  return slots;
}

/**
 * The slots for a turn that continues a booking: "30" after the reply that offered 15 and
 * 30. Always `book`, with whatever length the model heard this turn — kept even when the
 * model labelled the bare message something else, which is exactly when the turn arrives
 * here by inheritance — and the earlier turn's preference, unless this one states its own.
 */
function bookingFollowUpSlots(output, previousSlots) {
  const slots = { action: "book" };
  const duration = toDuration(output.duration);
  const preference = toPreference(output.preference) || previousSlots?.preference;
  if (duration) slots.duration = duration;
  if (preference) slots.preference = preference;
  return slots;
}

/** Keep the mail flow where it is: the draft rides along, since `slots` is last-write-wins. */
function holdMailFlow(state, confidence, cancelsActiveFlow = false) {
  return {
    route: "action",
    routeConfidence: confidence,
    slots: { action: "mail", mailDraft: state.slots?.mailDraft ?? null, cancelsActiveFlow },
  };
}

/**
 * Apply the low-confidence rule.
 *
 * Below the threshold the classification is discarded. What replaces it is the previous
 * turn's route when there is a safe one — an unsure turn in the middle of an exchange is
 * far more likely to be continuing it than starting something new, and this is what stops
 * a terse follow-up from landing on `refusal`. Otherwise it falls to knowledge, which is
 * the most common intent, is grounded in retrieved documents, and has no side effects.
 *
 * A cancel beats inheritance: "never mind" is the user saying the previous thing is over,
 * so continuing it is the one thing they have ruled out. This is step 2 of the precedence
 * order in ARCHITECTURE.md §5 — the router half of it; `routeFromState` holds the rest.
 *
 * Note this only covers the UNSURE case. The failure that prompted it came back at
 * confidence 1.00, which no floor catches; the conversation context and the prompt rules
 * are what address that. This is the safety net under them, not the fix.
 */
function applyConfidenceFloor(route, confidence, minConfidence, previousRoute, cancelled, continuesBooking = false) {
  if (confidence >= minConfidence) {
    return route;
  }
  if (cancelled) {
    return LOW_CONFIDENCE_ROUTE;
  }
  // `action` is never inherited — except its `book` half, which only hands out links and
  // so cannot cause a side effect by being guessed. That is what lets a bare "30" after
  // the both-links reply get the 30-minute link without holding a flow open.
  if (continuesBooking) {
    return "action";
  }
  return INHERITABLE_ROUTES.includes(previousRoute) ? previousRoute : LOW_CONFIDENCE_ROUTE;
}

const isAiMessage = (message) =>
  (message?.getType?.() ?? message?._getType?.()) === "ai";

/**
 * The history the router is allowed to see.
 *
 * Strips MoonMind's own canned dead-ends — the refusal, the error answer, the
 * not-implemented stub. `generate` appends every answer to `messages`, so those strings
 * come back round as input on the next turn and the router reads them as precedent: it
 * sees that it refused, and refuses again. Two refused asks in one session was enough to
 * turn "Ayan's resume" from about_me@0.9 into refusal@1.0, and a confidence of 1.0 means
 * the low-confidence floor never catches it either.
 *
 * Prompt wording cannot fix this. An explicit "earlier refusals are not precedent" rule
 * was measured against the same poisoned history and still produced refusal 4 times out
 * of 4; removing these messages produced about_me 4 out of 4. The contamination is in the
 * input, so the input is what has to change.
 *
 * Real answers stay: they are what lets the router resolve "what about that?" against
 * whatever was just discussed.
 */
function routerHistory(messages) {
  return messages.filter(
    (message) => !(isAiMessage(message) && CANNED_DEAD_ENDS.has(String(message.content).trim())),
  );
}

/**
 * Split the conversation into the message being classified and the turns behind it.
 *
 * The latest human message is pulled out and sent as the only real `HumanMessage`, with
 * everything before it compacted into a context block. Passing raw history instead — which
 * is what this node used to do — buried the question: measured on the session this fix
 * came from, the live message was 0.9% of the router's input and lost to 5.8KB of the
 * assistant's own prose.
 */
function splitForRouter(messages) {
  const lastHumanIndex = messages.findLastIndex((message) => !isAiMessage(message));

  if (lastHumanIndex === -1) {
    return { current: "", turns: [] };
  }

  return {
    current: String(messages[lastHumanIndex].content ?? ""),
    turns: messages.slice(0, lastHumanIndex).map((message) => ({
      role: isAiMessage(message) ? "assistant" : "user",
      text: String(message.content ?? ""),
    })),
  };
}

/**
 * @param {object} [deps]
 * @param {object} [deps.model] Injected model; tests pass a fake with withStructuredOutput.
 * @param {object} [deps.config] Injected config; tests pass one to switch mail on or off.
 */
function createRouterNode(deps = {}) {
  return async function router(state) {
    const { moonmind, mail } = deps.config ?? getConfig();
    const model = deps.model ?? getModel("router");

    // The router's window is its own, but it can never exceed the conversation cap the
    // rest of the graph respects — one history mechanism, narrowed, not a second one.
    //
    // Dead-ends are filtered BEFORE the window is applied, so a run of refusals cannot
    // eat the budget and leave the router with no real context to resolve a follow-up
    // against. The window is N useful messages, not N messages of which some are dropped.
    const window = Math.min(moonmind.routerHistoryMessages, moonmind.historyMaxMessages);
    const history = recentMessages(routerHistory(state.messages ?? []), window);
    const { current, turns } = splitForRouter(history);

    // The mail flow is waiting on exactly one of a few replies — "yes", "no", an address.
    // Those are recognised deterministically and never reach the model: a bare "yes"
    // classified cold is a greeting at confidence 1.0, which would read as a topic change
    // and walk out of the flow with the visitor's confirmation in hand.
    //
    // With mail paused, a thread checkpointed mid-flow is not resumed: it goes to `action`
    // once, every piece of mail state cleared here, and gets the paused reply. Nothing from
    // the old draft can be sent — the draft does not survive this return.
    if (!mail.enabled && hasMailState(state)) {
      return {
        route: "action",
        routeConfidence: 1,
        slots: { action: "mail" },
        activeFlow: null,
        pendingConfirmation: null,
      };
    }
    const mailFlow = inMailFlow(state);
    if (mailFlow && isMailFlowReply(current, state)) {
      return holdMailFlow(state, 1);
    }

    // `previousRoute` is where an old taxonomy actually reaches this one: unlike `route`
    // it survives the per-turn reset, so a live thread hands the router a name that no
    // longer exists. Translate it before it is shown to the model or tested for
    // inheritance, or every pre-Phase-7 thread silently loses both.
    const rawPreviousRoute = state.previousRoute ?? null;
    const previousRoute = resolveLegacyRoute(rawPreviousRoute);
    // The last turn answered a booking request. `slots` persists across turns, so this is
    // the slot that turn ended with — `book`, never `mail`, which is never inherited.
    const continuesBooking = previousRoute === "action" && state.slots?.action === "book";
    const context = buildRouterContext({ turns, previousRoute });

    const messages = [
      new SystemMessage(ROUTER_SYSTEM_PROMPT),
      ...(context ? [new SystemMessage(context)] : []),
      new HumanMessage(current),
    ];

    let output;
    try {
      output = await model
        .withStructuredOutput(RouterOutputSchema, { name: "route" })
        .invoke(messages);
    } catch (error) {
      // Deterministic fallback: a malformed or failed classification must not take the
      // turn down with it, and must not land on a route with side effects.
      console.warn("agent.router.fallback", {
        sessionId: state.sessionId,
        reason: error?.message,
      });
      // Mid-flow, an unusable classification stays in the flow: the action node treats
      // anything that is not a clear "yes" as a cancel, so holding can never send.
      if (mailFlow) {
        return holdMailFlow(state, 0);
      }
      // Confidence 0 through the same rule the unsure path uses, so a failed
      // classification mid-exchange continues that exchange rather than resetting it.
      const route = applyConfidenceFloor(
        LOW_CONFIDENCE_ROUTE,
        0,
        moonmind.routerMinConfidence,
        previousRoute,
        false,
        continuesBooking,
      );
      return {
        route,
        routeConfidence: 0,
        slots: route === "action" ? bookingFollowUpSlots({}, state.slots) : {},
      };
    }

    // Anything else said mid-flow: the flow keeps it unless the visitor has confidently
    // moved on (MOONMIND_TOPIC_CHANGE_CONFIDENCE, the same bar `routeFromState` uses). A
    // cancel stays too — the action node ends the flow and says so. A real topic change
    // ends the flow HERE, and the turn goes wherever the new question belongs.
    // Asking to book instead is a move too, into the other half of `action`.
    if (mailFlow) {
      const movedOn =
        output.cancelsActiveFlow !== true &&
        ((output.route === "action" && output.action === "book") ||
          (output.route !== "action" && output.confidence >= moonmind.topicChangeConfidence));
      if (!movedOn) {
        return holdMailFlow(state, output.confidence, output.cancelsActiveFlow === true);
      }
    }

    const route = applyConfidenceFloor(
      output.route,
      output.confidence,
      moonmind.routerMinConfidence,
      previousRoute,
      output.cancelsActiveFlow === true,
      continuesBooking,
    );

    // When the classification was confident, the model's `withDocuments` is the answer —
    // it read this turn's question. Only when the route came from inheritance instead does
    // a thread that was mid mixed-stats question under the old taxonomy need its slot
    // handed back, since nothing this turn expressed a view on it.
    const inherited = output.confidence < moonmind.routerMinConfidence;
    let slots =
      inherited && route === "stats"
        ? restoreLegacySlots(rawPreviousRoute, toSlots(output))
        : toSlots(output);
    // A booking follow-up — inherited, classified `action` without saying which half, or
    // `book` without restating the preference — carries on as the same booking.
    if (route === "action" && continuesBooking && (inherited || output.action !== "mail")) {
      slots = bookingFollowUpSlots(output, state.slots);
    }

    return {
      route,
      routeConfidence: output.confidence,
      slots: { ...slots, cancelsActiveFlow: output.cancelsActiveFlow === true },
      // Leaving the mail flow: the draft is already gone with `slots`; clear the rest.
      ...(mailFlow ? { activeFlow: null, pendingConfirmation: null } : {}),
    };
  };
}

module.exports = {
  createRouterNode,
  RouterOutputSchema,
  LOW_CONFIDENCE_ROUTE,
  routerHistory,
  splitForRouter,
};
