"use strict";

/**
 * Stats answers, old pipeline vs new, recorded side by side.
 *
 * Asks both services the same five questions, pulls the raw numbers from `/api/v1/github`
 * and `/api/v1/leetcode/:username` as ground truth, and writes `docs/evals/stats.md`.
 *
 * Every integer in each answer is checked against the ground-truth set. Numbers that do
 * not appear there are flagged for review rather than failed outright — prose legitimately
 * contains years, percentages and list positions, so a human reads the result.
 *
 * Usage:
 *   node --env-file=.env scripts/stats-eval.js --old https://old.example --new https://new.example
 *   node --env-file=.env scripts/stats-eval.js --new https://new.example        # new only
 *
 * Passwords come from the environment, never a flag: MOONMIND_PASSWORD for the new
 * service, OLD_MOONMIND_PASSWORD for the old one (defaults to the same value).
 */

const fs = require("node:fs");
const path = require("node:path");

const TIMEOUT_MS = 120_000;
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "evals", "stats.md");

const QUESTIONS = Object.freeze([
  { id: 1, text: "How many public repos does Ayan have on GitHub?", expectRoute: "stats" },
  { id: 2, text: "What is Ayan's LeetCode ranking?", expectRoute: "stats" },
  { id: 3, text: "How many LeetCode problems has he solved, and how many were hard?", expectRoute: "stats" },
  { id: 4, text: "Give me his GitHub stats - repos, commits, stars and pull requests.", expectRoute: "stats" },
  { id: 5, text: "Show me my github stats and my projects", expectRoute: "stats" },
]);

function parseArgs(argv) {
  const args = { leetcodeUser: "moonman369" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old") args.old = argv[++i];
    else if (argv[i] === "--new") args.new = argv[++i];
    else if (argv[i] === "--leetcode-user") args.leetcodeUser = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.new) throw new Error("--new <baseUrl> is required");
  return args;
}

const trimSlash = (url) => url.replace(/\/+$/, "");

async function getJson(baseUrl, routePath) {
  const response = await fetch(`${trimSlash(baseUrl)}${routePath}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET ${routePath} -> ${response.status}`);
  return response.json();
}

async function ask(baseUrl, password, message) {
  const response = await fetch(`${trimSlash(baseUrl)}/api/v1/moonmind/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", password },
    // `prompt` is what the old route reads; the new route accepts it as an alias, so one
    // body shape serves both.
    body: JSON.stringify({ prompt: message, message, sessionId: `stats-eval-${Date.now()}` }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    return { answer: `[HTTP ${response.status}] ${JSON.stringify(body)}`, route: null };
  }

  return {
    // Old shape: data.summary. New shape: data.answer.
    answer: body?.data?.answer ?? body?.data?.summary ?? "[no answer field in response]",
    route: body?.data?.route ?? null,
  };
}

/** Every integer appearing anywhere in the ground-truth payloads. */
function groundTruthNumbers(github, leetcode) {
  const numbers = new Set();
  const walk = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) numbers.add(value);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(github);
  walk(leetcode);
  return numbers;
}

function checkNumbers(answer, truth) {
  // Strip thousands separators so "1,854" matches 1854.
  const found = [...answer.replace(/(\d),(?=\d{3}\b)/g, "$1").matchAll(/\b\d+\b/g)].map((m) =>
    Number(m[0]),
  );

  const matched = [...new Set(found.filter((n) => truth.has(n)))];

  // Small ordinals and years are normal in prose and would drown the signal. A real
  // stat that happens to look like a year will still show up under `matched`; the
  // trade-off is deliberate, since this file is read by a human.
  const looksLikeYear = (n) => n >= 1990 && n <= 2100;
  const unknown = [...new Set(found.filter((n) => !truth.has(n) && n > 100 && !looksLikeYear(n)))];

  return { matched, unknown };
}

function renderMarkdown({ args, github, leetcode, truth, rows }) {
  const lines = [
    "# Stats eval — old pipeline vs new",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Old: ${args.old ? trimSlash(args.old) : "_not run_"}`,
    `New: ${trimSlash(args.new)}`,
    "",
    "## Ground truth",
    "",
    "Straight from the endpoints, for comparison against the prose below.",
    "",
    "```json",
    JSON.stringify({ github, leetcode }, null, 2),
    "```",
    "",
    `Numbers treated as correct: ${[...truth].sort((a, b) => a - b).join(", ")}`,
    "",
    "## Questions",
    "",
  ];

  rows.forEach((row) => {
    lines.push(
      `### ${row.id}. ${row.text}`,
      "",
      `- Route (new): \`${row.newRoute ?? "n/a"}\`${
        row.expectRoute ? ` — expected \`${row.expectRoute}\`${row.newRoute === row.expectRoute ? " ✅" : " ⚠️"}` : ""
      }`,
      `- Ground-truth numbers echoed: ${row.check.matched.length ? row.check.matched.join(", ") : "_none_"}`,
      `- Unverified numbers > 100: ${row.check.unknown.length ? `⚠️ ${row.check.unknown.join(", ")}` : "_none_"}`,
      "",
      "**Old pipeline**",
      "",
      "```",
      row.oldAnswer ?? "_not run_",
      "```",
      "",
      "**New pipeline**",
      "",
      "```",
      row.newAnswer,
      "```",
      "",
    );
  });

  const flagged = rows.filter((r) => r.check.unknown.length > 0 || r.newRoute !== r.expectRoute);
  lines.push(
    "## Summary",
    "",
    `- Questions: ${rows.length}`,
    `- Routed as expected: ${rows.filter((r) => r.newRoute === r.expectRoute).length}/${rows.length}`,
    `- Needing a human look: ${flagged.length ? flagged.map((r) => `Q${r.id}`).join(", ") : "none"}`,
    "",
  );

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const newPassword = process.env.MOONMIND_PASSWORD;
  const oldPassword = process.env.OLD_MOONMIND_PASSWORD ?? newPassword;

  if (!newPassword) throw new Error("MOONMIND_PASSWORD must be set in the environment");

  process.stdout.write("fetching ground truth...\n");
  const githubDocument = await getJson(args.new, "/api/v1/github");
  const leetcode = await getJson(args.new, `/api/v1/leetcode/${encodeURIComponent(args.leetcodeUser)}`);
  const github = githubDocument?.stats ?? githubDocument;
  const truth = groundTruthNumbers(github, leetcode);

  const rows = [];
  for (const question of QUESTIONS) {
    process.stdout.write(`Q${question.id}: ${question.text}\n`);

    const next = await ask(args.new, newPassword, question.text);
    const previous = args.old ? await ask(args.old, oldPassword, question.text) : { answer: null };
    const check = checkNumbers(next.answer, truth);

    rows.push({
      id: question.id,
      text: question.text,
      expectRoute: question.expectRoute,
      newRoute: next.route,
      newAnswer: next.answer,
      oldAnswer: previous.answer,
      check,
    });

    process.stdout.write(
      `   route=${next.route ?? "n/a"} matched=[${check.matched.join(",")}] unknown=[${check.unknown.join(",")}]\n`,
    );
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, renderMarkdown({ args, github, leetcode, truth, rows }), "utf8");

  const flagged = rows.filter((r) => r.check.unknown.length > 0 || r.newRoute !== r.expectRoute);
  process.stdout.write(`\nwrote ${path.relative(process.cwd(), OUTPUT_PATH)}\n`);
  process.stdout.write(
    flagged.length ? `${flagged.length} question(s) need a human look\n` : "all questions clean\n",
  );
  process.exit(flagged.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`stats-eval failed: ${error.message}`);
  process.exit(1);
});
