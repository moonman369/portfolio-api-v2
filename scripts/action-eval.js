"use strict";

/**
 * The action node, live: real router, real Cal.com link checks, real draft capture and MX
 * lookups, through `runTurn` on checkpointed sessions. Writes docs/evals/action.md.
 *
 * Three suites:
 *   1. booking, on the default config (mail paused) — Phase 10.1's live checks: both links
 *      and the question; a bare length picks one; a stated length gets one; a mail request
 *      gets the paused reply.
 *   2. a broken link — the 15-minute URL pointed at a made-up slug for this run only (an
 *      in-process config override; `.env` is never touched, so nothing needs restoring).
 *   3. the Phase 10 mail flow with MOONMIND_MAIL_ENABLED switched ON for its graph only, so
 *      the flag-gated code is still exercised live. Nothing is sent: the browser POSTs the
 *      payload (Web3Forms refuses server-side calls on its free plan).
 *
 * Suites 2 and 3 run on their own graphs with in-memory checkpoints. Every `mail_events` row
 * this run creates is deleted at the end, so it never counts against a real visitor's cap.
 * If WEB3FORMS_ACCESS_KEY is unset, suite 3 uses a labelled placeholder; the report says so.
 *
 * Usage:
 *   node --env-file=.env scripts/action-eval.js
 *   node --env-file=.env scripts/action-eval.js --memory   # no Mongo: in-memory checkpoints
 *                                                         # and mail store everywhere
 *
 * Exit 0 when every scenario behaves as specified, 1 otherwise.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { getConfig } = require("../src/config");
const { MemorySaver } = require("@langchain/langgraph");
const { getCollection, close } = require("../src/db");
const { runTurn, createNodes } = require("../src/agent");
const { buildGraph } = require("../src/agent/graph");
const { createRouterNode } = require("../src/agent/nodes/router");
const { createActionNode } = require("../src/agent/nodes/action");
const { PAYLOAD_FIELDS } = require("../src/integrations/email");

const OUTPUT_PATH = path.join(__dirname, "..", "docs", "evals", "action.md");
const SESSION_PREFIX = "action-eval-";
const MEMORY = process.argv.includes("--memory");
const PLACEHOLDER_KEY = "action-eval-placeholder-key";
// Made up on purpose: Cal.com answers a real 404 for it (verified at the Phase 10.1 gate).
const BROKEN_SLUG = "action-eval-no-such-event";

const memoryStore = () => ({ capReached: async () => null, recordMailEvent: async (event) => event });

/** A graph over the production nodes with `router` / `action` swapped for this config. */
function graphFor(config, { store } = {}) {
  const nodes = createNodes();
  nodes.router = createRouterNode({ config });
  nodes.action = createActionNode({ config, ...(store ? { store } : {}) });
  return buildGraph({ nodes, checkpointer: new MemorySaver() });
}

function suites() {
  const config = getConfig();
  const { urls } = config.booking;
  const broken15 = urls[15].replace(/[^/]+$/, BROKEN_SLUG);
  const mailOn = { ...config, mail: { ...config.mail, enabled: true, accessKey: config.mail.accessKey ?? PLACEHOLDER_KEY } };
  const claimsBooking = (text) => /\b(booked|scheduled|confirmed|reserved)\b/i.test(text);
  const statesAvailability = (text) => /\b(hours?|windows?|weekdays?|weekends?|IST|UTC|GMT|\d{1,2}\s?(am|pm))\b/i.test(text);

  return [
    {
      name: "1. Booking (default config: mail paused)",
      graph: MEMORY ? graphFor(config, { store: memoryStore() }) : undefined,
      scenarios: [
        {
          name: "'book a call' → both links + question; then '15' → only the 15-minute link",
          turns: ["book a call", "15"],
          check: ([t1, t2]) => [
            t1.route !== "action" && `turn 1 routed ${t1.route}`,
            !(t1.answer.includes(urls[15]) && t1.answer.includes(urls[30])) && "turn 1 did not show both links",
            !/Which works better\?/.test(t1.answer) && "turn 1 did not ask which",
            !/your own timezone/.test(t1.answer) && "no timezone line",
            t2.route !== "action" && `turn 2 routed ${t2.route}`,
            !(t2.answer.includes(urls[15]) && !t2.answer.includes(urls[30])) && "turn 2 was not only the 15-minute link",
            [t1, t2].some((t) => claimsBooking(t.answer)) && "claims a booking",
            [t1, t2].some((t) => statesAvailability(t.answer)) && "states availability",
          ],
        },
        {
          name: "'quick 30 min chat' → only the 30-minute link",
          turns: ["can we have a quick 30 min chat?"],
          check: ([t]) => [
            t.route !== "action" && `routed ${t.route}`,
            !(t.answer.includes(urls[30]) && !t.answer.includes(urls[15])) && "not only the 30-minute link",
          ],
        },
        {
          name: "'an hour' → only 15 and 30 offered, both shown",
          turns: ["Can I book an hour with Ayan?"],
          check: ([t]) => [
            !/only offer 15- or 30-minute calls/.test(t.answer) && "did not say only 15 and 30 are offered",
            !(t.answer.includes(urls[15]) && t.answer.includes(urls[30])) && "did not show both links",
          ],
        },
        {
          name: "a mail request gets the paused reply and the links",
          turns: ["Can you pass a message to Ayan for me?"],
          check: ([t]) => [
            !/^Sending messages isn't available right now/.test(t.answer) && "not the paused reply",
            !t.answer.includes(urls[30]) && "no booking link",
            t.mail !== null && "produced a mail action",
          ],
        },
      ],
    },
    {
      name: `2. A broken link (15-minute URL → \`${broken15}\`, this run only)`,
      graph: graphFor({ ...config, booking: { ...config.booking, urls: { ...urls, 15: broken15 } } }),
      scenarios: [
        {
          name: "'book a call' with the 15-minute page missing → names it, offers the 30",
          turns: ["book a call"],
          check: ([t]) => [
            !/The 15-minute option isn't available right now — its booking page couldn't be found/.test(t.answer) &&
              "did not name the 15-minute length as unavailable",
            !t.answer.includes(urls[30]) && "did not offer the 30-minute link",
            t.answer.includes(broken15) && "showed the broken link",
            /\b404\b/.test(t.answer) && "leaked a status code",
          ],
        },
        {
          name: "'15 minutes please' with that page missing → says so, offers the other",
          turns: ["can I book 15 minutes with him?"],
          check: ([t]) => [
            !/The 15-minute meeting you asked for isn't available right now/.test(t.answer) && "did not say the asked-for length is down",
            !t.answer.includes(urls[30]) && "did not offer the 30-minute link",
          ],
        },
      ],
    },
    {
      name: "3. Mail flow, flag switched ON for this graph (Phase 10 code, still guarded)",
      graph: graphFor(mailOn, MEMORY ? { store: memoryStore() } : {}),
      placeholder: !config.mail.accessKey,
      scenarios: [
        {
          name: "full mail flow: ask for an address, confirm, yes",
          turns: ["send a message to Ayan about a backend role", "moonmind.action.eval@gmail.com", "yes"],
          check: ([t1, t2, t3]) => [
            t1.route !== "action" && `turn 1 routed ${t1.route}`,
            !/email address/i.test(t1.answer) && "turn 1 did not ask for an address",
            t2.mail?.type !== "confirm" && "turn 2 did not confirm",
            t3.mail?.type !== "submit" && "turn 3 did not produce a submission",
            t3.mail && JSON.parse(t3.mail.body).message !== t2.mail?.body && "sent body differs from the confirmed body",
            t3.mail && Object.keys(JSON.parse(t3.mail.body)).some((k) => !PAYLOAD_FIELDS.includes(k)) && "payload has an unexpected field",
          ],
        },
        {
          name: "unreachable address: declined twice, never sent",
          turns: ["send Ayan a message about a backend role", "someone@gmial.cmo", "someone@gmial.con"],
          check: ([, t2, t3]) => [
            /does(n't| not) exist/i.test(t2.answer) && "claims the mailbox does not exist",
            !/nothing was sent/i.test(t3.answer) && "second failure did not stop",
            [t2, t3].some((t) => t.mail?.type === "submit") && "issued a submission",
          ],
        },
        {
          name: "a bare 'no' at confirmation cancels",
          turns: ["Please pass a note to Ayan that I enjoyed his portfolio. My email is moonmind.action.eval@gmail.com", "no"],
          check: ([t1, t2]) => [
            t1.mail?.type !== "confirm" && "turn 1 did not confirm",
            !/haven't sent anything/.test(t2.answer) && "did not cancel",
          ],
        },
      ],
    },
  ];
}

const clip = (text, n = 600) => (text.length > n ? `${text.slice(0, n)}…` : text);

async function main() {
  const all = suites();
  const lines = [
    "# Action node — live",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "Real router, real Cal.com link checks, real draft capture and MX lookups, through",
    "`runTurn`. Produced by `scripts/action-eval.js`. **Nothing is sent:** with mail on, the",
    "browser POSTs the payload (Web3Forms refuses server-side calls on its free plan).",
    MEMORY ? "\n**Run with `--memory`:** checkpoints and `mail_events` were in-memory throughout." : "",
    all[2].placeholder ? "\n**Placeholder used for suite 3:** WEB3FORMS_ACCESS_KEY was unset in `.env`." : "",
    "",
  ];
  let failed = false;

  for (const suite of all) {
    process.stdout.write(`${suite.name}\n`);
    lines.push(`## ${suite.name}`, "");

    for (const scenario of suite.scenarios) {
      process.stdout.write(`  ${scenario.name}\n`);
      const sessionId = `${SESSION_PREFIX}${crypto.randomUUID()}`;
      const turns = [];
      for (const message of scenario.turns) {
        turns.push({ message, ...(await runTurn({ sessionId, message }, { graph: suite.graph })) });
      }

      const problems = scenario.check(turns).filter(Boolean);
      failed ||= problems.length > 0;

      lines.push(`### ${scenario.name} — ${problems.length === 0 ? "PASS" : "**FAIL**"}`, "");
      problems.forEach((problem) => lines.push(`- **${problem}**`));
      turns.forEach((t, index) => {
        lines.push(
          `**Turn ${index + 1}** — "${t.message}" → route \`${t.route}\`, mail \`${t.mail?.type ?? "none"}\``,
          "",
          "```",
          clip(t.answer ?? ""),
          "```",
        );
        if (t.mail?.type === "submit") {
          const payload = JSON.parse(t.mail.body);
          payload.access_key = "(redacted)";
          lines.push("", "Payload the browser would POST:", "", "```json", JSON.stringify(payload, null, 2), "```");
        }
        lines.push("");
      });
    }
  }

  if (!MEMORY) {
    const collection = await getCollection(getConfig().mongo.mailEventsCollection);
    const { deletedCount } = await collection.deleteMany({ sessionId: { $regex: `^${SESSION_PREFIX}` } });
    lines.push(`_Cleaned up ${deletedCount} \`mail_events\` row(s) this run created._`);
  }

  fs.writeFileSync(OUTPUT_PATH, `${lines.join("\n")}\n`);
  process.stdout.write(`\nwrote ${path.relative(process.cwd(), OUTPUT_PATH)} — ${failed ? "FAIL" : "PASS"}\n`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(`action-eval failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => close());
