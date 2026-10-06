"use strict";

// Mail to Ayan, via Web3Forms — plain JS, no framework. Three jobs, all deterministic:
//
//   1. Validate the visitor's address: syntax, then an MX lookup on the domain.
//   2. Compose the exact Web3Forms payload the BROWSER will POST. The backend never
//      sends it: Web3Forms answers server-side calls with 403 unless the account is paid
//      and the server IP safelisted (verified 2026-09-24, Phase 10 gate). So this module
//      builds the bytes, fingerprints them, and hands them over.
//   3. Keep `mail_events`: what was issued, cancelled, and what the browser reported.
//
// **There is no recipient in any payload built here.** Web3Forms delivers to the inbox
// registered to the access key, and no field in its request can change that — `ccemail`,
// the one field that adds a recipient, is a paid feature this module never writes. The
// visitor's address goes in `email` / `replyto` only, so Ayan can reply; it is never a
// destination. `PAYLOAD_FIELDS` below is the whole vocabulary, and a test holds it there.

const crypto = require("node:crypto");
const { Resolver } = require("node:dns").promises;
const { getConfig } = require("../config");
const { getCollection } = require("../db");

// ---------------------------------------------------------------------------
// 1. Address validation
// ---------------------------------------------------------------------------

// Deliberately plain: one @, a non-empty local part without spaces, a dotted domain with
// an alphabetic TLD. RFC 5322 in full admits addresses no visitor types; the MX lookup
// is what actually decides whether the domain can take mail.
const ADDRESS_PATTERN = /^[^\s@<>()[\],;:"]+@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/i;

/** Every address-looking token in a piece of text, in order. */
const ADDRESS_IN_TEXT = /[^\s@<>()[\],;:"']+@(?:[a-z0-9-]+\.)+[a-z]{2,63}/gi;

function findAddresses(text) {
  return [...String(text ?? "").matchAll(ADDRESS_IN_TEXT)].map((match) => match[0].replace(/[.]+$/, ""));
}

/**
 * A resolver with a timeout, pointed at the same DNS servers the Mongo client is told to
 * use when `MONGO_DNS_SERVERS` is set. That override exists for machines whose system
 * resolver refuses queries outright (`ECONNREFUSED`); a scoped `Resolver` does not pick up
 * `dns.setServers()`, so without this the MX lookup would fail open on every address there.
 */
function mxResolver() {
  const { mail, mongo } = getConfig();
  const resolver = new Resolver({ timeout: mail.dnsTimeoutMs, tries: 1 });
  if (mongo.dnsServers.length > 0) {
    resolver.setServers(mongo.dnsServers);
  }
  return resolver;
}

// DNS answers that mean "this domain cannot receive mail" — as opposed to a resolver that
// is slow or down, which says nothing about the address.
const DEFINITIVE_DNS_FAILURES = new Set(["ENOTFOUND", "ENODATA", "ENONAME", "EBADNAME", "NXDOMAIN"]);

/**
 * Can this address plausibly receive a reply?
 *
 * Syntax, then MX on the domain — nothing else. There is no SMTP probe: port 25 is
 * normally blocked outbound on Oracle Cloud VMs, and a mailbox probe is unreliable anyway.
 * So a pass means "the domain takes mail", never "this mailbox exists", and the copy that
 * reports a failure must not claim more than that either.
 *
 * A resolver that times out or errors transiently **fails open** (`verified: false`): the
 * address is only ever a reply-to, so the worst case is Ayan's reply bouncing — not a
 * reason to refuse a visitor because DNS hiccuped.
 *
 * @returns {Promise<{ ok: boolean, reason: "syntax"|"no_mx"|null, verified: boolean }>}
 */
async function validateAddress(address, deps = {}) {
  const match = ADDRESS_PATTERN.exec(String(address ?? "").trim());
  if (!match) {
    return { ok: false, reason: "syntax", verified: true };
  }

  const domain = match[1].toLowerCase();
  const resolver = deps.resolver ?? mxResolver();

  try {
    const records = await resolver.resolveMx(domain);
    // RFC 7505 "null MX": a single record with an empty exchange declares no mail.
    const usable = (records ?? []).filter((record) => record?.exchange && record.exchange !== ".");
    return usable.length > 0
      ? { ok: true, reason: null, verified: true }
      : { ok: false, reason: "no_mx", verified: true };
  } catch (error) {
    if (DEFINITIVE_DNS_FAILURES.has(error?.code)) {
      return { ok: false, reason: "no_mx", verified: true };
    }
    console.warn("mail.mx_unverified", { domain, code: error?.code ?? null });
    return { ok: true, reason: null, verified: false };
  }
}

// ---------------------------------------------------------------------------
// 2. The payload
// ---------------------------------------------------------------------------

/**
 * Every field a payload built here may carry. No `to`, no `ccemail`, no `redirect`, no
 * `webhook`: nothing that could route the message anywhere but the key's own inbox.
 */
const PAYLOAD_FIELDS = Object.freeze(["access_key", "subject", "from_name", "name", "email", "replyto", "message"]);

/**
 * The exact JSON the browser will POST, and its fingerprint.
 *
 * `message` is the draft body **unchanged** — the byte-identical text the visitor saw at
 * the confirmation step. Their address travels in `email` and `replyto`, which Web3Forms
 * prints in the notification alongside the message, so Ayan has it without anything being
 * appended to what the visitor confirmed.
 *
 * Returned as a string, not an object: the browser must send these bytes, and the digest
 * is over these bytes. Key order is fixed by `PAYLOAD_FIELDS`.
 */
function buildSubmission(draft, { accessKey, endpoint }) {
  const values = {
    access_key: accessKey,
    subject: draft.subject,
    from_name: `MoonMind — ${draft.senderName || draft.senderEmail}`,
    name: draft.senderName || "",
    email: draft.senderEmail,
    replyto: draft.senderEmail,
    message: draft.body,
  };

  const payload = Object.fromEntries(PAYLOAD_FIELDS.map((field) => [field, values[field]]));
  const body = JSON.stringify(payload);

  return { endpoint, body, digest: digestOf(body) };
}

function digestOf(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** Pseudonymous: enough to count repeat attempts from one address, not to store the IP. */
function hashIp(ip) {
  return ip ? digestOf(`moonmind-mail:${ip}`).slice(0, 32) : null;
}

// ---------------------------------------------------------------------------
// 3. mail_events
// ---------------------------------------------------------------------------

const STATUSES = Object.freeze(["pending", "sent", "failed", "cancelled"]);
// What counts against a cap: everything the backend handed out that was not cancelled.
const COUNTED = Object.freeze(["pending", "sent", "failed"]);

let indexesEnsured = false;

async function events(deps = {}) {
  if (deps.collection) {
    return deps.collection;
  }
  const collection = await getCollection(getConfig().mongo.mailEventsCollection);
  if (!indexesEnsured) {
    await Promise.all([
      collection.createIndex({ submissionId: 1 }, { unique: true }),
      collection.createIndex({ sessionId: 1, createdAt: -1 }),
      collection.createIndex({ ipHash: 1, createdAt: -1 }),
    ]);
    indexesEnsured = true;
  }
  return collection;
}

/**
 * Has this session or address reached its cap? Checked before a draft is captured, so a
 * capped visitor is told up front, and again at issuance, which is the check that counts.
 */
async function capReached({ sessionId, ipHash, now = new Date() }, deps = {}) {
  const { mail } = deps.config ?? getConfig();
  const collection = await events(deps);
  const since = new Date(now.getTime() - mail.windowHours * 60 * 60 * 1000);
  const recent = { status: { $in: COUNTED }, createdAt: { $gte: since } };

  const bySession = await collection.countDocuments({ ...recent, sessionId });
  if (bySession >= mail.maxPerSession) {
    return "session";
  }
  if (ipHash) {
    const byIp = await collection.countDocuments({ ...recent, ipHash });
    if (byIp >= mail.maxPerIp) {
      return "ip";
    }
  }
  return null;
}

/** Record an issued (`pending`) or `cancelled` mail. Never stores the body itself. */
async function recordMailEvent(event, deps = {}) {
  if (!STATUSES.includes(event.status)) {
    throw new Error(`unknown mail status '${event.status}'`);
  }
  const collection = await events(deps);
  const row = {
    submissionId: event.submissionId ?? crypto.randomUUID(),
    sessionId: event.sessionId ?? null,
    ipHash: event.ipHash ?? null,
    senderEmail: event.senderEmail ?? null,
    subject: event.subject ?? null,
    bodyChars: event.bodyChars ?? null,
    digest: event.digest ?? null,
    status: event.status,
    createdAt: event.now ?? new Date(),
    sentAt: null,
    reportedDigest: null,
    digestMatches: null,
    error: null,
  };
  await collection.insertOne(row);
  return row;
}

/**
 * What the browser reported after POSTing to Web3Forms. Only a `pending` row moves, and
 * only once: a second report for the same submission is a conflict, not an update.
 *
 * `digestMatches` compares the fingerprint of the bytes the browser says it sent with the
 * one issued. It is advisory — the browser could lie — but an honest client that altered
 * the payload shows up here instead of silently.
 *
 * @returns {Promise<{ outcome: "recorded"|"not_found"|"already_final", row?: object }>}
 */
async function finalizeMailEvent({ submissionId, status, digest, providerMessage, now = new Date() }, deps = {}) {
  if (!["sent", "failed"].includes(status)) {
    throw new Error(`a report must be sent or failed, not '${status}'`);
  }
  const collection = await events(deps);
  const existing = await collection.findOne({ submissionId });
  if (!existing) {
    return { outcome: "not_found" };
  }
  if (existing.status !== "pending") {
    return { outcome: "already_final", row: existing };
  }

  const update = {
    status,
    sentAt: status === "sent" ? now : null,
    reportedDigest: digest ?? null,
    digestMatches: digest ? digest === existing.digest : null,
    error: status === "failed" ? String(providerMessage ?? "unknown error").slice(0, 300) : null,
  };
  const result = await collection.updateOne({ submissionId, status: "pending" }, { $set: update });
  if (result.modifiedCount === 0) {
    // Lost a race with a concurrent report.
    return { outcome: "already_final", row: await collection.findOne({ submissionId }) };
  }
  return { outcome: "recorded", row: { ...existing, ...update } };
}

module.exports = {
  validateAddress,
  findAddresses,
  buildSubmission,
  digestOf,
  hashIp,
  capReached,
  recordMailEvent,
  finalizeMailEvent,
  PAYLOAD_FIELDS,
  STATUSES,
};
