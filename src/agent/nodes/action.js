"use strict";

// The action node (Phase 10): reach Ayan, two ways, neither of them an agent.
//
//   book — a templated answer: the configured bookable windows and the Calendly link.
//          No model call, no tool, no calendar access. It cannot know his availability or
//          whether a booking happened, and never says otherwise.
//   mail — a small state machine over `activeFlow: "action"`, `slots.mailDraft` and
//          `pendingConfirmation`:
//
//            capture  → one structured-output call turns the request into a draft,
//                       stored verbatim; asks for the visitor's address if it is missing
//            validate → syntax + MX on the address (integrations/email.js); one re-entry
//            confirm  → echoes the stored draft exactly and asks for a yes, with a
//                       `mailAction` telling the frontend to show a confirm card
//            issue    → on a clear yes only: composes the Web3Forms request from the
//                       SAME stored draft, records it `pending`, and hands the bytes to
//                       the browser, which POSTs them (the free plan refuses server-side
//                       calls) and reports the outcome back
//
// The draft is never regenerated after capture. The text confirmed is the text sent.
// Anything but a clear yes at the confirmation step cancels.

const crypto = require("node:crypto");
const { z } = require("zod");
const { SystemMessage, HumanMessage } = require("@langchain/core/messages");
const { getConfig } = require("../../config");
const { getModel } = require("../models");
const { resolveLegacyRoute } = require("../state");
const email = require("../../integrations/email");
const {
  MAIL_CAPTURE_PROMPT,
  BOOKING_UNAVAILABLE_ANSWER,
  ACTION_CLARIFY_ANSWER,
  buildBookingAnswer,
  MAIL_UNAVAILABLE_ANSWER,
  buildMailCapReachedAnswer,
  buildMailTooLongAnswer,
  MAIL_ASK_EMAIL_ANSWER,
  buildMailAddressDeclinedAnswer,
  buildMailConfirmationAnswer,
  buildMailOnlyToAyanNote,
  MAIL_SENDING_ANSWER,
  MAIL_CANCELLED_ANSWER,
  MAIL_ISSUE_FAILED_ANSWER,
} = require("../prompts");

// What the frontend's confirm card sends back, and what a person types. Anchored and
// short on purpose: "yes" must be unmistakable, because it is the only word that sends.
const YES_PATTERN =
  /^\s*(?:yes|yep|yeah|yup|y|sure|ok|okay|confirm(?:ed)?|send(?: it)?|go ahead|do it|yes,? (?:please|send(?: it)?)|please send(?: it)?)\s*[.!]*\s*$/i;
const NO_PATTERN =
  /^\s*(?:no|nope|nah|n|cancel|stop|abort|don'?t(?: send)?(?: it)?|do not send(?: it)?|never ?mind|forget (?:it|about it))\b/i;

// A draft subject is echoed and sent, so it is bounded like the body.
const SUBJECT_MAX_CHARS = 120;
// The address-entry budget: one re-entry after a failed address, then the flow stops.
const MAX_ADDRESS_ATTEMPTS = 2;

const CaptureSchema = z.object({
  senderName: z.string().nullable(),
  senderEmail: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
});

/** Is this session inside the mail flow? */
function inMailFlow(state) {
  return (
    resolveLegacyRoute(state?.activeFlow) === "action" &&
    state?.slots?.action === "mail" &&
    Boolean(state?.slots?.mailDraft)
  );
}

/**
 * A reply the flow is waiting for, recognised without a model: a cancel at any point, a
 * clear yes at the confirmation step, or an address while one is being asked for. The
 * router holds these in the flow directly — see `nodes/router.js`.
 */
function isMailFlowReply(text, state) {
  const value = String(text ?? "");
  if (NO_PATTERN.test(value)) {
    return true;
  }
  if (state?.pendingConfirmation?.kind === "mail") {
    return YES_PATTERN.test(value);
  }
  return email.findAddresses(value).length > 0;
}

/**
 * Is this address somewhere the visitor wants the message SENT, rather than their own?
 * "send this to someone@else.com" names a destination; "reply to me at…" and "reply to
 * x@y.com" do not. A destination is never taken as the sender — it stays in the body,
 * and nothing in the payload can route mail to it anyway.
 */
function isDestination(text, address) {
  const at = String(text).toLowerCase().indexOf(address.toLowerCase());
  if (at === -1) {
    return false;
  }
  const before = String(text).slice(Math.max(0, at - 40), at);
  return /(?<!reply\s)\b(?:to|cc|bcc|forward(?:ed)?(?: it)?(?: on)? to)\s*:?\s*<?$/i.test(before);
}

/** The visitor's own address in this message, if there is one. */
function ownAddress(text, candidate) {
  const found = email.findAddresses(text).filter((address) => !isDestination(text, address));
  if (candidate) {
    const match = found.find((address) => address.toLowerCase() === String(candidate).trim().toLowerCase());
    return match ?? null;
  }
  return found[0] ?? null;
}

/** Fingerprint of the draft as confirmed, so issuance can prove nothing moved. */
function draftDigest(draft) {
  return email.digestOf(JSON.stringify([draft.senderName, draft.senderEmail, draft.subject, draft.body]));
}

/** Everything that ends the flow, whatever the reason. */
function endFlow(extra) {
  return { activeFlow: null, pendingConfirmation: null, slots: { action: "mail" }, ...extra };
}

/** The flow continues, holding this draft. */
function holdFlow(draft, extra) {
  return { activeFlow: "action", pendingConfirmation: null, slots: { action: "mail", mailDraft: draft }, ...extra };
}

/**
 * @param {object} [deps] Injected for tests: `model` (capture), `config`, `validate`
 *   (address validator), `store` ({ capReached, recordMailEvent }), `newId`.
 */
function createActionNode(deps = {}) {
  const validate = deps.validate ?? email.validateAddress;
  const store = deps.store ?? email;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function capture(text, ctx) {
    const { config, sessionId, ipHash, runConfig } = ctx;

    if (await store.capReached({ sessionId, ipHash }, { config })) {
      return endFlow({ finalAnswer: buildMailCapReachedAnswer() });
    }

    // The one model call in the flow. If it fails, the visitor's own words are the body —
    // deterministic, and they will see it before anything is sent.
    let extracted = { senderName: null, senderEmail: null, subject: null, body: null };
    try {
      const model = deps.model ?? getModel("intent");
      extracted = await model
        .withStructuredOutput(CaptureSchema, { name: "mail_draft" })
        .invoke([new SystemMessage(MAIL_CAPTURE_PROMPT), new HumanMessage(text)], runConfig);
    } catch (error) {
      console.warn("agent.action.capture_fallback", { sessionId, reason: error?.message });
    }

    const senderName = extracted?.senderName?.trim() || null;
    const draft = {
      senderName,
      senderEmail: null,
      subject: (extracted?.subject?.trim() || `Message from ${senderName ?? "a portfolio visitor"}`).slice(
        0,
        SUBJECT_MAX_CHARS,
      ),
      body: extracted?.body?.trim() || text,
      addressAttempts: 0,
    };

    if (draft.body.length > config.mail.maxBodyChars) {
      return endFlow({ finalAnswer: buildMailTooLongAnswer(config.mail.maxBodyChars) });
    }

    // Only an address the visitor actually typed, as their own, becomes the sender. The
    // model's pick is checked against the text; a destination is never accepted.
    const address = ownAddress(text, extracted?.senderEmail) ?? (extracted?.senderEmail ? null : ownAddress(text));
    const next = address
      ? await validateThenConfirm(draft, address)
      : holdFlow(draft, { finalAnswer: MAIL_ASK_EMAIL_ANSWER });

    // A request that named somewhere else to send it is told, once, that it cannot go
    // there. Nothing depends on this — the payload has no recipient field — but the
    // visitor should not walk away thinking it went where they asked.
    const destination = email.findAddresses(text).find((candidate) => isDestination(text, candidate));
    return destination ? { ...next, finalAnswer: `${buildMailOnlyToAyanNote(destination)}\n\n${next.finalAnswer}` } : next;
  }

  async function validateThenConfirm(draft, address) {
    const result = await validate(address);

    if (!result.ok) {
      const attempts = (draft.addressAttempts ?? 0) + 1;
      const final = attempts >= MAX_ADDRESS_ATTEMPTS;
      const finalAnswer = buildMailAddressDeclinedAnswer({ address, reason: result.reason, final });
      return final
        ? endFlow({ finalAnswer })
        : holdFlow({ ...draft, senderEmail: null, addressAttempts: attempts }, { finalAnswer });
    }

    const confirmed = { ...draft, senderEmail: address };
    return {
      ...holdFlow(confirmed, { finalAnswer: buildMailConfirmationAnswer(confirmed) }),
      pendingConfirmation: { kind: "mail", digest: draftDigest(confirmed) },
      // Everything the card shows, read from the stored draft — the same values the
      // payload will be built from if the visitor says yes.
      mailAction: {
        type: "confirm",
        display: "confirm_card",
        to: "Ayan Maiti",
        from: { name: confirmed.senderName, email: confirmed.senderEmail },
        subject: confirmed.subject,
        body: confirmed.body,
        replies: { confirm: "yes", cancel: "no" },
      },
    };
  }

  async function issue(draft, ctx) {
    const { config, sessionId, ipHash, pending } = ctx;

    if (pending.digest !== draftDigest(draft)) {
      // The stored draft is not the one that was confirmed. Nothing should ever get here;
      // if something does, the only safe outcome is not sending.
      console.error("agent.action.draft_changed", { sessionId });
      return endFlow({ finalAnswer: MAIL_ISSUE_FAILED_ANSWER });
    }

    if (await store.capReached({ sessionId, ipHash }, { config })) {
      return endFlow({ finalAnswer: buildMailCapReachedAnswer() });
    }

    const submission = email.buildSubmission(draft, config.mail);
    const submissionId = newId();

    // Recorded BEFORE the payload leaves: an issue that cannot be recorded is not issued.
    try {
      await store.recordMailEvent({
        submissionId,
        status: "pending",
        sessionId,
        ipHash,
        senderEmail: draft.senderEmail,
        subject: draft.subject,
        bodyChars: draft.body.length,
        digest: submission.digest,
      });
    } catch (error) {
      console.error("agent.action.record_failed", { sessionId, message: error?.message });
      return endFlow({ finalAnswer: MAIL_ISSUE_FAILED_ANSWER });
    }

    return endFlow({
      finalAnswer: MAIL_SENDING_ANSWER,
      mailAction: {
        type: "submit",
        submissionId,
        endpoint: submission.endpoint,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: submission.body,
        digest: submission.digest,
      },
    });
  }

  async function cancel(draft, ctx) {
    await store
      .recordMailEvent({
        status: "cancelled",
        sessionId: ctx.sessionId,
        ipHash: ctx.ipHash,
        senderEmail: draft.senderEmail ?? null,
        subject: draft.subject,
        bodyChars: draft.body?.length ?? null,
      })
      .catch((error) => console.warn("agent.action.cancel_unrecorded", { message: error?.message }));
    return endFlow({ finalAnswer: MAIL_CANCELLED_ANSWER });
  }

  async function mail(state, runConfig, config) {
    if (!config.mail.accessKey) {
      return endFlow({ finalAnswer: MAIL_UNAVAILABLE_ANSWER });
    }

    const text = String(state.rawQuery ?? "").trim();
    const ctx = {
      config,
      runConfig,
      sessionId: state.sessionId ?? null,
      // Hashed by `buildInvocation` before it entered the run config; the raw IP never
      // reaches the graph.
      ipHash: runConfig?.configurable?.ipHash ?? null,
      pending: state.pendingConfirmation,
    };

    if (!inMailFlow(state)) {
      return capture(text, ctx);
    }

    const draft = state.slots.mailDraft;
    if (NO_PATTERN.test(text) || state.slots.cancelsActiveFlow === true) {
      return cancel(draft, ctx);
    }

    if (state.pendingConfirmation?.kind === "mail") {
      return YES_PATTERN.test(text) ? issue(draft, ctx) : cancel(draft, ctx);
    }

    // Waiting for an address.
    const address = ownAddress(text);
    return address ? validateThenConfirm(draft, address) : { finalAnswer: MAIL_ASK_EMAIL_ANSWER };
  }

  return async function action(state, runConfig) {
    const config = deps.config ?? getConfig();
    const slots = state.slots ?? {};

    if (slots.action === "mail" || inMailFlow(state)) {
      return mail(state, runConfig, config);
    }
    if (slots.action === "book") {
      const { calendlyUrl, bookingWindows } = config.action;
      return {
        finalAnswer:
          calendlyUrl && bookingWindows
            ? buildBookingAnswer({ calendlyUrl, bookingWindows, preference: slots.preference ?? null })
            : BOOKING_UNAVAILABLE_ANSWER,
      };
    }
    return { finalAnswer: ACTION_CLARIFY_ANSWER };
  };
}

module.exports = {
  createActionNode,
  inMailFlow,
  isMailFlowReply,
  isDestination,
  ownAddress,
  YES_PATTERN,
  NO_PATTERN,
};
