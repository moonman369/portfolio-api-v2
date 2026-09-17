"use strict";

/**
 * knowledge answers, old pipeline vs new, recorded side by side.
 *
 * Asks both services the same ten questions and writes `docs/evals/knowledge-eval.md`: each
 * answer in full, plus the overlap between the document ids each pipeline retrieved.
 *
 * Retrieved-id overlap is the objective signal — two answers can read differently and
 * still be grounded in the same documents, which is what "equivalent quality" means
 * here. The prose itself needs a human read; the file is laid out for that.
 *
 * Usage:
 *   node --env-file=.env scripts/knowledge-eval.js --old https://old --new https://new
 *   node --env-file=.env scripts/knowledge-eval.js --new https://new        # new only
 *
 * Passwords come from the environment, never a flag: MOONMIND_PASSWORD for the new
 * service, OLD_MOONMIND_PASSWORD for the old one (defaults to the same value).
 *
 * Exit 0 when every question routed as expected and retrieved a non-empty overlap.
 */

const fs = require("node:fs");
const path = require("node:path");

const TIMEOUT_MS = 180_000;
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "evals", "knowledge-eval.md");

const QUESTIONS = Object.freeze([
  { id: 1, text: "What backend technologies does Ayan work with?", route: "knowledge" },
  { id: 2, text: "Tell me about Ayan's experience at Tata Consultancy Services.", route: "knowledge" },
  { id: 3, text: "What certifications does he hold?", route: "knowledge" },
  { id: 4, text: "What projects has he built involving RAG or vector search?", route: "knowledge" },
  { id: 5, text: "What is his educational background?", route: "knowledge" },
  { id: 6, text: "What are his hobbies and interests outside work?", route: "knowledge" },
  { id: 7, text: "How has he used generative AI in his day-to-day engineering work?", route: "knowledge" },
  {
    id: 8,
    text: "What are his strongest skills, and which projects demonstrate them?",
    route: "knowledge",
    note: "multi-part - exercises decomposition when MOONMIND_DECOMPOSE_ENABLED is on",
  },
  {
    id: 9,
    text: "Has Ayan ever worked on underwater basket weaving?",
    route: "knowledge",
    expectEmpty: true,
    note: "nothing should match - the answer must stay helpful and say so, never a bare refusal",
  },
  {
    id: 10,
    text: "Show me my github stats and my projects",
    route: "stats",
    note: "the mixed query the old regex router handled",
  },
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old") args.old = argv[++i];
    else if (argv[i] === "--new") args.new = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.new) throw new Error("--new <baseUrl> is required");
  return args;
}

const trimSlash = (url) => url.replace(/\/+$/, "");

async function ask(baseUrl, password, message) {
  const response = await fetch(`${trimSlash(baseUrl)}/api/v1/moonmind/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", password },
    // `prompt` is what the old route reads; the new one accepts it as an alias, so one
    // body shape serves both.
    body: JSON.stringify({ prompt: message, message, sessionId: `knowledge-eval-${Date.now()}` }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    return { answer: `[HTTP ${response.status}] ${JSON.stringify(body)}`, ids: [], route: null };
  }

  return {
    // Old shape: data.summary. New shape: data.answer.
    answer: body?.data?.answer ?? body?.data?.summary ?? "[no answer field]",
    ids: (body?.data?.documents ?? []).map((document) => String(document.id)).filter(Boolean),
    route: body?.data?.route ?? null,
  };
}

function overlap(oldIds, newIds) {
  const a = new Set(oldIds);
  const b = new Set(newIds);
  const shared = [...a].filter((id) => b.has(id));
  const union = new Set([...a, ...b]);

  return {
    shared,
    onlyOld: [...a].filter((id) => !b.has(id)),
    onlyNew: [...b].filter((id) => !a.has(id)),
    jaccard: union.size === 0 ? null : shared.length / union.size,
  };
}

function renderRow(row) {
  const { check } = row;
  const routeOk = row.newRoute === row.route;
  const pct = check.jaccard === null ? "n/a" : `${Math.round(check.jaccard * 100)}%`;

  const lines = [
    `### ${row.id}. ${row.text}`,
    "",
    row.note ? `> ${row.note}` : null,
    row.note ? "" : null,
    `- Route (new): \`${row.newRoute ?? "n/a"}\` — expected \`${row.route}\` ${routeOk ? "✅" : "⚠️"}`,
    `- Documents — old: ${row.oldIds.length}, new: ${row.newIds.length}, shared: ${check.shared.length} (Jaccard ${pct})`,
  ];

  if (check.onlyOld.length) lines.push(`- Only the old pipeline retrieved: ${check.onlyOld.join(", ")}`);
  if (check.onlyNew.length) lines.push(`- Only the new pipeline retrieved: ${check.onlyNew.join(", ")}`);

  lines.push(
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

  return lines.filter((line) => line !== null).join("\n");
}

function render({ args, rows }) {
  const routed = rows.filter((row) => row.newRoute === row.route).length;
  const withOverlap = rows.filter((row) => row.check.shared.length > 0).length;
  const comparable = rows.filter((row) => row.oldIds.length > 0).length;

  return [
    "# knowledge eval — old pipeline vs new",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Old: ${args.old ? trimSlash(args.old) : "_not run_"}`,
    `New: ${trimSlash(args.new)}`,
    "",
    "## Summary",
    "",
    `- Questions: ${rows.length}`,
    `- Routed as expected: ${routed}/${rows.length}`,
    `- Shared at least one retrieved document: ${withOverlap}/${comparable || rows.length}`,
    "",
    "Retrieved-id overlap is the objective signal. The prose needs your read — two",
    "answers can differ in wording and still be equally grounded.",
    "",
    "## Questions",
    "",
    ...rows.map(renderRow),
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const newPassword = process.env.MOONMIND_PASSWORD;
  const oldPassword = process.env.OLD_MOONMIND_PASSWORD ?? newPassword;

  if (!newPassword) throw new Error("MOONMIND_PASSWORD must be set in the environment");

  const rows = [];
  for (const question of QUESTIONS) {
    process.stdout.write(`Q${question.id}: ${question.text}\n`);

    const next = await ask(args.new, newPassword, question.text);
    const previous = args.old
      ? await ask(args.old, oldPassword, question.text)
      : { answer: null, ids: [] };
    const check = overlap(previous.ids, next.ids);

    rows.push({
      ...question,
      newRoute: next.route,
      newAnswer: next.answer,
      newIds: next.ids,
      oldAnswer: previous.answer,
      oldIds: previous.ids,
      check,
    });

    process.stdout.write(
      `   route=${next.route ?? "n/a"} docs old=${previous.ids.length} new=${next.ids.length} shared=${check.shared.length}\n`,
    );
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, render({ args, rows }), "utf8");

  const flagged = rows.filter(
    (row) =>
      row.newRoute !== row.route ||
      (!row.expectEmpty && row.oldIds.length > 0 && row.check.shared.length === 0),
  );

  process.stdout.write(`\nwrote ${path.relative(process.cwd(), OUTPUT_PATH)}\n`);
  process.stdout.write(
    flagged.length
      ? `${flagged.length} question(s) need a look: ${flagged.map((r) => `Q${r.id}`).join(", ")}\n`
      : "all questions routed as expected with overlapping retrieval\n",
  );
  process.exit(flagged.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`knowledge-eval failed: ${error.message}`);
  process.exit(1);
});
