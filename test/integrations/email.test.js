"use strict";

// integrations/email.js: address validation, the Web3Forms payload, and mail_events.
// No network: the DNS resolver and the collection are fakes.

process.env.MONGO_URI ??= "mongodb://localhost:27017/test";
process.env.GITHUB_PAT ??= "t";
process.env.REFRESH_PROFILE ??= "p";
process.env.REFRESH_SECRET ??= "s";
process.env.OPENAI_API_KEY ??= "sk-test";
process.env.MOONMIND_PASSWORD ??= "pw";
process.env.GEMINI_API_KEY ??= "gem-test";
process.env.TAVILY_API_KEY ??= "tvly-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const email = require("../../src/integrations/email");

/** A resolver whose answer for every domain is fixed; records what it was asked. */
function resolver(answer) {
  const asked = [];
  return {
    asked,
    resolveMx: async (domain) => {
      asked.push(domain);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const dnsError = (code) => Object.assign(new Error(code), { code });

/** Just enough of a Mongo collection for mail_events. */
function fakeCollection() {
  const rows = [];
  const matches = (row, query) =>
    Object.entries(query).every(([key, condition]) => {
      if (condition && typeof condition === "object" && !(condition instanceof Date)) {
        if ("$in" in condition && !condition.$in.includes(row[key])) return false;
        if ("$gte" in condition && !(row[key] >= condition.$gte)) return false;
        return true;
      }
      return row[key] === condition;
    });

  return {
    rows,
    insertOne: async (row) => rows.push({ ...row }),
    countDocuments: async (query) => rows.filter((row) => matches(row, query)).length,
    findOne: async (query) => rows.find((row) => matches(row, query)) ?? null,
    updateOne: async (query, { $set }) => {
      const row = rows.find((candidate) => matches(candidate, query));
      if (!row) return { modifiedCount: 0 };
      Object.assign(row, $set);
      return { modifiedCount: 1 };
    },
  };
}

const CONFIG = { mail: { maxPerSession: 2, maxPerIp: 3, windowHours: 24 } };

const DRAFT = Object.freeze({
  senderName: "Jane Doe",
  senderEmail: "jane@example.com",
  subject: "Backend role",
  body: "Hi Ayan,\n\nWe're hiring for a backend role — café résumé, trailing space \nThanks",
});

// ---------------------------------------------------------------------------
// Validation: syntax, then MX. Never a mailbox claim.
// ---------------------------------------------------------------------------

test("a malformed address fails on syntax without touching DNS", async () => {
  const dns = resolver([{ exchange: "mx.example.com", priority: 10 }]);
  for (const address of ["jane@", "jane example@x.com", "@example.com", "jane@example", "jane@@example.com"]) {
    const result = await email.validateAddress(address, { resolver: dns });
    assert.deepEqual(result, { ok: false, reason: "syntax", verified: true }, address);
  }
  assert.deepEqual(dns.asked, []);
});

test("a domain with an MX record passes, and the lookup is on the lowercased domain", async () => {
  const dns = resolver([{ exchange: "aspmx.l.google.com", priority: 1 }]);
  assert.deepEqual(await email.validateAddress("Jane@Gmail.COM", { resolver: dns }), {
    ok: true,
    reason: null,
    verified: true,
  });
  assert.deepEqual(dns.asked, ["gmail.com"]);
});

test("a typo'd domain that does not resolve fails as no_mx", async () => {
  const result = await email.validateAddress("someone@gmial.cmo", { resolver: resolver(dnsError("ENOTFOUND")) });
  assert.deepEqual(result, { ok: false, reason: "no_mx", verified: true });
});

test("no MX records, and a null MX, both mean the domain takes no mail", async () => {
  assert.equal((await email.validateAddress("a@nomx.example", { resolver: resolver([]) })).reason, "no_mx");
  assert.equal(
    (await email.validateAddress("a@nullmx.example", { resolver: resolver([{ exchange: ".", priority: 0 }]) })).reason,
    "no_mx",
  );
  assert.equal((await email.validateAddress("a@nodata.example", { resolver: resolver(dnsError("ENODATA")) })).reason, "no_mx");
});

test("a DNS timeout fails open, marked unverified — the address is only ever a reply-to", async () => {
  const result = await email.validateAddress("jane@example.com", { resolver: resolver(dnsError("ETIMEOUT")) });
  assert.deepEqual(result, { ok: true, reason: null, verified: false });
});

test("findAddresses pulls every address out of free text, without trailing punctuation", () => {
  assert.deepEqual(email.findAddresses("send this to someone@else.com, my email is jane.d@example.co.uk."), [
    "someone@else.com",
    "jane.d@example.co.uk",
  ]);
  assert.deepEqual(email.findAddresses("no address here"), []);
});

// ---------------------------------------------------------------------------
// The payload: no recipient, the body untouched
// ---------------------------------------------------------------------------

test("the payload carries exactly the allowed fields — no recipient of any kind", () => {
  const { body } = email.buildSubmission(DRAFT, { accessKey: "key-123", endpoint: "https://api.web3forms.com/submit" });
  const payload = JSON.parse(body);

  assert.deepEqual(Object.keys(payload), [...email.PAYLOAD_FIELDS]);
  for (const forbidden of ["to", "recipient", "ccemail", "cc", "bcc", "email_to", "redirect", "webhook"]) {
    assert.equal(forbidden in payload, false, `${forbidden} must never be sent`);
  }
});

test("the message is byte-identical to the draft body, and the visitor is only the reply-to", () => {
  const { body } = email.buildSubmission(DRAFT, { accessKey: "k", endpoint: "e" });
  const payload = JSON.parse(body);

  assert.equal(payload.message, DRAFT.body);
  assert.equal(Buffer.compare(Buffer.from(payload.message), Buffer.from(DRAFT.body)), 0);
  assert.equal(payload.email, "jane@example.com");
  assert.equal(payload.replyto, "jane@example.com");
  assert.equal(payload.subject, "Backend role");
  assert.equal(payload.access_key, "k");
});

test("the digest is SHA-256 over the exact bytes handed to the browser", () => {
  const { body, digest, endpoint } = email.buildSubmission(DRAFT, { accessKey: "k", endpoint: "https://x" });
  assert.equal(digest, crypto.createHash("sha256").update(body, "utf8").digest("hex"));
  assert.equal(endpoint, "https://x");
  assert.equal(email.buildSubmission(DRAFT, { accessKey: "k", endpoint: "https://x" }).body, body, "stable");
});

test("an IP is stored only as a pseudonymous hash", () => {
  const hash = email.hashIp("203.0.113.9");
  assert.match(hash, /^[a-f0-9]{32}$/);
  assert.ok(!hash.includes("203"));
  assert.equal(email.hashIp("203.0.113.9"), hash);
  assert.equal(email.hashIp(null), null);
});

// ---------------------------------------------------------------------------
// mail_events
// ---------------------------------------------------------------------------

test("caps count issued mail per session and per IP, and ignore cancelled ones", async () => {
  const collection = fakeCollection();
  const deps = { collection, config: CONFIG };
  const record = (extra) => email.recordMailEvent({ sessionId: "s1", ipHash: "ip1", subject: "x", ...extra }, deps);

  assert.equal(await email.capReached({ sessionId: "s1", ipHash: "ip1" }, deps), null);

  await record({ status: "cancelled" });
  await record({ status: "cancelled" });
  assert.equal(await email.capReached({ sessionId: "s1", ipHash: "ip1" }, deps), null, "cancels are free");

  await record({ status: "pending" });
  await record({ status: "sent" });
  assert.equal(await email.capReached({ sessionId: "s1", ipHash: "ip1" }, deps), "session");

  await email.recordMailEvent({ sessionId: "s2", ipHash: "ip1", status: "failed" }, deps);
  assert.equal(await email.capReached({ sessionId: "s3", ipHash: "ip1" }, deps), "ip", "a new session from the same IP");
  assert.equal(await email.capReached({ sessionId: "s3", ipHash: "ip2" }, deps), null);
});

test("caps only look back over the window", async () => {
  const collection = fakeCollection();
  const deps = { collection, config: CONFIG };
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await email.recordMailEvent({ sessionId: "s1", status: "sent", now: old }, deps);
  await email.recordMailEvent({ sessionId: "s1", status: "sent", now: old }, deps);
  assert.equal(await email.capReached({ sessionId: "s1", ipHash: null }, deps), null);
});

test("an event never stores the body, and an unknown status is refused", async () => {
  const collection = fakeCollection();
  const row = await email.recordMailEvent(
    { status: "pending", senderEmail: "jane@example.com", subject: "s", bodyChars: 42, digest: "d" },
    { collection },
  );
  assert.equal("body" in row, false);
  assert.equal(row.bodyChars, 42);
  await assert.rejects(email.recordMailEvent({ status: "delivered" }, { collection }), /unknown mail status/);
});

test("the browser's report moves a pending mail once, and checks the digest", async () => {
  const collection = fakeCollection();
  await email.recordMailEvent({ submissionId: "m1", status: "pending", digest: "abc" }, { collection });
  await email.recordMailEvent({ submissionId: "m2", status: "pending", digest: "abc" }, { collection });

  const sent = await email.finalizeMailEvent({ submissionId: "m1", status: "sent", digest: "abc" }, { collection });
  assert.equal(sent.outcome, "recorded");
  assert.equal(sent.row.status, "sent");
  assert.equal(sent.row.digestMatches, true);
  assert.ok(sent.row.sentAt instanceof Date);

  const again = await email.finalizeMailEvent({ submissionId: "m1", status: "failed" }, { collection });
  assert.equal(again.outcome, "already_final", "a second report is a conflict, not an update");

  const altered = await email.finalizeMailEvent(
    { submissionId: "m2", status: "failed", digest: "zzz", providerMessage: "Too may requests" },
    { collection },
  );
  assert.equal(altered.row.digestMatches, false);
  assert.equal(altered.row.error, "Too may requests");
  assert.equal(altered.row.sentAt, null);

  assert.equal((await email.finalizeMailEvent({ submissionId: "nope", status: "sent" }, { collection })).outcome, "not_found");
});
