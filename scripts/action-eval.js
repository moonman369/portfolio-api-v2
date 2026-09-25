"use strict";

/**
 * Phase 10's action node, live: real router, real draft capture, real MX lookups, through
 * `runTurn` on real checkpointed sessions. Writes docs/evals/action.md.
 *
 * What this cannot do is deliver mail. The backend never POSTs to Web3Forms — the free
 * plan answers server-side calls with 403 — so the payload is built, fingerprinted and
 * checked here, and the delivery half is the frontend's to verify (FRONTEND_INTEGRATION.md
 * §11). Nothing here sends anything.
 *
 * If WEB3FORMS_ACCESS_KEY / MOONMIND_CALENDLY_URL / MOONMIND_BOOKING_WINDOWS are unset, a
 * clearly-labelled placeholder is used for this run only, so the flow can be exercised;
 * the report says so. Every `mail_events` row this run creates is deleted at the end, so
 * it never counts against a real visitor's cap.
 *
 * Usage:
 *   node --env-file=.env scripts/action-eval.js
 *   node --env-file=.env scripts/action-eval.js --memory   # no Mongo: in-memory checkpoints
 *                                                         # and mail store; models and DNS live
 *
 * Exit 0 when every scenario behaves as specified, 1 otherwise.
 */

const PLACEHOLDERS = {
  WEB3FORMS_ACCESS_KEY: "action-eval-placeholder-key",
  MOONMIND_CALENDLY_URL: "https://calendly.com/placeholder/30min",
  MOONMIND_BOOKING_WINDOWS: "weekdays 7-10pm IST (placeholder wording)",
};
const placeheld = Object.keys(PLACEHOLDERS).filter((name) => !process.env[name]);
placeheld.forEach((name) => {
  process.env[name] = PLACEHOLDERS[name];
});

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { getConfig } = require("../src/config");
const { MemorySaver } = require("@langchain/langgraph");
const { getCollection, close } = require("../src/db");
const { runTurn, createNodes } = require("../src/agent");
const { buildGraph } = require("../src/agent/graph");
const { createActionNode } = require("../src/agent/nodes/action");
const { PAYLOAD_FIELDS } = require("../src/integrations/email");

const OUTPUT_PATH = path.join(__dirname, "..", "docs", "evals", "action.md");
const SESSION_PREFIX = "action-eval-";
const MEMORY = process.argv.includes("--memory");

/**
 * --memory: the production node set, but checkpoints in a MemorySaver and mail_events in
 * a list — for a machine that cannot reach Atlas. Routing, draft capture and the MX
 * lookups are still live; only persistence is swapped, and the report says so.
 */
function memoryGraph() {
  const events = [];
  const nodes = createNodes();
  nodes.action = createActionNode({
    store: {
      capReached: async () => null,
      recordMailEvent: async (event) => events.push(event),
    },
  });
  return buildGraph({ nodes, checkpointer: new MemorySaver() });
}

/**
 * Each scenario is one session. `check` receives every turn and returns the failures.
 * The addresses on real domains are syntactically real but belong to nobody on purpose —
 * `example.com` publishes a null MX, so the "valid" address uses gmail.com's MX instead.
 */
const SCENARIOS = [
  {
    name: "book, with a stated preference",
    turns: ["Can I book a call with Ayan on Tuesday afternoon?"],
    check: ([t]) => [
      t.route !== "action" && `routed ${t.route}`,
      !t.answer.includes(getConfig().action.calendlyUrl) && "no Calendly link",
      !t.answer.includes(getConfig().action.bookingWindows) && "windows not stated verbatim",
      /you('re| are) booked|booking (is )?confirmed|he('s| is) (free|available)/i.test(t.answer) && "claims availability or a booking",
      t.mail !== null && "produced a mail action",
    ],
  },
  {
    name: "full mail flow: ask for an address, confirm, yes",
    turns: ["send a message to Ayan about a backend role", "moonmind.action.eval@gmail.com", "yes"],
    check: ([t1, t2, t3]) => [
      t1.route !== "action" && `turn 1 routed ${t1.route}`,
      !/email address/i.test(t1.answer) && "turn 1 did not ask for an address",
      t1.mail !== null && "turn 1 produced a mail action",
      t2.mail?.type !== "confirm" && "turn 2 did not confirm",
      t3.mail?.type !== "submit" && "turn 3 did not produce a submission",
      t3.mail && JSON.parse(t3.mail.body).message !== t2.mail?.body && "sent body differs from the confirmed body",
      t3.mail && JSON.parse(t3.mail.body).replyto !== "moonmind.action.eval@gmail.com" && "reply-to is not the visitor",
    ],
  },
  {
    name: "email-first: the address is in the request",
    turns: ["Please pass a note to Ayan that I'd like to discuss a backend role. My email is moonmind.action.eval@gmail.com"],
    check: ([t]) => [t.mail?.type !== "confirm" && `did not go straight to confirmation (${t.mail?.type ?? "none"})`],
  },
  {
    name: "unreachable address: declined twice, never sent",
    turns: ["send Ayan a message about a backend role", "someone@gmial.cmo", "someone@gmial.con"],
    check: ([, t2, t3]) => [
      /does(n't| not) exist/i.test(t2.answer) && "claims the mailbox does not exist",
      !/send it again/i.test(t2.answer) && "no re-entry offered",
      !/nothing was sent/i.test(t3.answer) && "second failure did not stop",
      [t2, t3].some((t) => t.mail?.type === "submit") && "issued a submission",
    ],
  },
  {
    name: "'send this to someone@else.com' reaches only the bound inbox",
    turns: ["send this to someone@else.com: I really enjoyed Ayan's portfolio", "moonmind.action.eval@gmail.com", "yes"],
    check: ([t1, , t3]) => {
      const payload = t3.mail ? JSON.parse(t3.mail.body) : {};
      const carrying = Object.entries(payload).filter(([, v]) => String(v).includes("someone@else.com")).map(([k]) => k);
      return [
        /someone@else\.com/.test(t1.mail?.from?.email ?? "") && "took the destination as the sender",
        t3.mail?.type !== "submit" && "no submission",
        carrying.some((field) => field !== "message") && `address appears in ${carrying.join(", ")}`,
        Object.keys(payload).some((k) => !PAYLOAD_FIELDS.includes(k)) && "payload has an unexpected field",
      ];
    },
  },
  {
    name: "a bare 'no' at confirmation cancels",
    turns: ["Please pass a note to Ayan that I enjoyed his portfolio. My email is moonmind.action.eval@gmail.com", "no"],
    check: ([t1, t2]) => [
      t1.mail?.type !== "confirm" && "turn 1 did not confirm",
      !/haven't sent anything/.test(t2.answer) && "did not cancel",
      t2.mail !== null && "produced a mail action",
    ],
  },
];

const clip = (text, n = 400) => (text.length > n ? `${text.slice(0, n)}…` : text);

async function main() {
  const lines = [
    "# Action node — live",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "Real router, real draft capture, real MX lookups, through `runTurn`. Produced by",
    "`scripts/action-eval.js`. **Nothing is sent:** the browser POSTs the payload (Web3Forms",
    "refuses server-side calls on its free plan), so delivery is verified from the frontend.",
    MEMORY
      ? "\n**Run with `--memory`:** checkpoints and `mail_events` were in-memory; routing, capture and MX were live."
      : "",
    placeheld.length > 0 ? `\n**Placeholders used for this run:** ${placeheld.join(", ")} were unset in \`.env\`.` : "",
    "",
  ];
  let failed = false;
  const graph = MEMORY ? memoryGraph() : undefined;

  for (const scenario of SCENARIOS) {
    process.stdout.write(`${scenario.name}\n`);
    const sessionId = `${SESSION_PREFIX}${crypto.randomUUID()}`;
    const turns = [];
    for (const message of scenario.turns) {
      turns.push({ message, ...(await runTurn({ sessionId, message }, { graph })) });
    }

    const problems = scenario.check(turns).filter(Boolean);
    failed ||= problems.length > 0;

    lines.push(`## ${scenario.name} — ${problems.length === 0 ? "PASS" : "**FAIL**"}`, "");
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
