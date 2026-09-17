"use strict";

// Every tool, and the map that decides which agent may hold which.
//
// **`TOOLSETS` is the isolation mechanism.** What an agent can do is what was passed to
// it — never what a prompt asked it not to do (CLAUDE.md, LLD §4). A `tech_web` agent
// has no calendar or email tool in its process memory, let alone in its schema, so
// "ignore your instructions and book a meeting" has nothing to reach. Keeping the map
// here, next to the tools, is what makes that auditable in one screen.
//
// Tools return `[content, artifact]` (`responseFormat: "content_and_artifact"`): the
// content is what the model reads, the artifact is the structured record the node writes
// into state. `makeAgentNode` collects `artifact.results` from every tool message, so a
// tool that wants its sources cited puts them there under that key.

const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { search } = require("../integrations/websearch");
const { getConfig } = require("../config");
const { searchAllArms } = require("../retrieval/search");
const { rankDocuments, sanitizeForPrompt } = require("../retrieval/rank");
const { ALLOWED_DOMAINS, ALLOWED_SUBCATEGORIES } = require("../documents/taxonomy");

// ---------------------------------------------------------------------------
// resolve_time — deterministic, no model
// ---------------------------------------------------------------------------

const MONTHS = Object.freeze([
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
]);

const WORD_NUMBERS = Object.freeze({
  a: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
});

const pad = (value) => String(value).padStart(2, "0");
const iso = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;

/** Days in a month, so a range never lands on the 31st of February. */
const lastDayOf = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Today, as the visitor's calendar sees it.
 *
 * `en-CA` formats as YYYY-MM-DD, which is the shape the rest of this file compares
 * lexicographically — the corpus stores zero-padded ISO strings, so string order is date
 * order (see `buildMetadataQuery` in retrieval/search.js).
 */
function todayParts(timeZone, now) {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .split("-")
    .map(Number);

  return { year, month, day };
}

const wholeYear = (year, label) => ({ from: iso(year, 1, 1), to: iso(year, 12, 31), label });

/**
 * Turn a time expression into a date range. Pure: `now` and the zone are arguments, so a
 * test can sit on a year boundary without waiting for one.
 *
 * Returns `{ resolved: false, reason }` rather than guessing. A wrong range is worse than
 * no range — it silently filters the corpus down to the wrong slice and the answer looks
 * confident either way.
 */
function resolveTimeExpression(expression, { timeZone = "UTC", now = new Date() } = {}) {
  const text = String(expression ?? "").toLowerCase().trim();
  const { year, month, day } = todayParts(timeZone, now);
  const today = iso(year, month, day);

  if (!text) {
    return { resolved: false, reason: "No time expression given." };
  }

  // "2023 to 2025", "2023-2025", "between 2023 and 2025"
  const span = text.match(/\b(\d{4})\s*(?:to|-|–|—|until|through|and)\s*(\d{4})\b/);
  if (span) {
    const [start, end] = [Number(span[1]), Number(span[2])].sort((a, b) => a - b);
    return { resolved: true, from: iso(start, 1, 1), to: iso(end, 12, 31), label: `${start}-${end}` };
  }

  // "since 2023", "from 2023 onwards"
  const since = text.match(/\b(?:since|from|after)\s+(\d{4})\b/);
  if (since) {
    return { resolved: true, from: iso(Number(since[1]), 1, 1), to: today, label: `since ${since[1]}` };
  }

  // "march 2024", "since august 2023"
  const monthYear = text.match(new RegExp(`\\b(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{4})\\b`));
  if (monthYear) {
    const monthIndex = MONTHS.indexOf(monthYear[1]) + 1;
    const inYear = Number(monthYear[2]);
    const from = iso(inYear, monthIndex, 1);
    const open = /\b(?:since|from|after)\b/.test(text);

    return {
      resolved: true,
      from,
      to: open ? today : iso(inYear, monthIndex, lastDayOf(inYear, monthIndex)),
      label: `${open ? "since " : ""}${monthYear[1]} ${inYear}`,
    };
  }

  // "last 2 years", "past three years" — rolling from today, not whole calendar years.
  const rolling = text.match(/\b(?:last|past|previous)\s+(\d+|[a-z]+)\s+(year|month)s?\b/);
  if (rolling) {
    const count = Number(rolling[1]) || WORD_NUMBERS[rolling[1]];
    if (count) {
      const unit = rolling[2];
      const from =
        unit === "year"
          ? iso(year - count, month, Math.min(day, lastDayOf(year - count, month)))
          : (() => {
              const total = year * 12 + (month - 1) - count;
              const y = Math.floor(total / 12);
              const m = (total % 12) + 1;
              return iso(y, m, Math.min(day, lastDayOf(y, m)));
            })();
      return { resolved: true, from, to: today, label: `last ${count} ${unit}${count > 1 ? "s" : ""}` };
    }
  }

  if (/\b(?:last|previous)\s+year\b/.test(text)) {
    return { resolved: true, ...wholeYear(year - 1, "last year") };
  }
  if (/\bthis\s+year\b/.test(text)) {
    return { resolved: true, from: iso(year, 1, 1), to: today, label: "this year" };
  }
  if (/\b(?:now|today|current|currently|present|at the moment|these days|right now)\b/.test(text)) {
    return { resolved: true, from: today, to: today, label: "today" };
  }

  // A bare year, or one mentioned in a longer phrase ("in 2023", "his 2023 work").
  const bareYear = text.match(/\b(19|20)(\d{2})\b/);
  if (bareYear) {
    const inYear = Number(`${bareYear[1]}${bareYear[2]}`);
    return { resolved: true, ...wholeYear(inYear, String(inYear)) };
  }

  return {
    resolved: false,
    reason:
      `Could not resolve "${expression}" to a date range without guessing. ` +
      "If it refers to an event in Ayan's history (joining a company, starting a project), " +
      "look the date up with metadata_filter or semantic_search and use the real date.",
  };
}

/** How a single result is rendered for the model. Compact, and always with its URL. */
function renderResult(result, index) {
  const date = result.publishedDate ? ` (${result.publishedDate})` : "";
  return `[${index + 1}] ${result.title}${date}\n${result.url}\n${result.content}`;
}

/** What the model reads back from one search. */
function renderSearch({ query, answer, results }) {
  if (results.length === 0) {
    return `No results for "${query}".`;
  }

  return [
    answer ? `Summary: ${answer}` : null,
    `${results.length} result(s) for "${query}":`,
    results.map(renderResult).join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Search the public web.
 *
 * `deps.search` is injected by tests so the tool can be exercised without a network
 * call or an API key.
 */
function createWebSearchTool(deps = {}) {
  const run = deps.search ?? search;

  return tool(
    async ({ query }) => {
      const startedAt = Date.now();

      let found;
      try {
        found = await run(query);
      } catch (error) {
        // An agent swallows a tool failure: the error comes back to the model as a tool
        // result and it answers from memory instead, which looks identical to a good
        // answer from the outside. This line is the only place that failure is visible.
        console.error("agent.web_search.failed", {
          query,
          code: error?.code ?? null,
          message: error?.message,
          ms: Date.now() - startedAt,
        });
        throw error;
      }

      // The query the *model* wrote, which is the thing worth seeing when an answer is
      // grounded in the wrong decade. Server log only — the persisted feed still carries
      // no tool arguments, and this is a per-tool decision rather than a general licence:
      // a search query is the model's own words, where `send_email`'s arguments will be
      // the visitor's, and that tool will not log them.
      console.log("agent.web_search", {
        query,
        results: found.results.length,
        ms: Date.now() - startedAt,
      });

      // Content for the model, artifact for the node. The node never parses the prose.
      return [renderSearch(found), { results: found.results, answer: found.answer }];
    },
    {
      name: "web_search",
      description:
        "Search the public web for current information about technology, AI, frameworks, " +
        "releases and industry news. Use it when the answer depends on something recent " +
        "or something you are not sure of. Returns ranked extracts with their source URLs.",
      schema: z.object({
        query: z
          .string()
          .min(2)
          .max(400)
          .describe("A focused search query. Prefer specific terms over a whole question."),
      }),
      responseFormat: "content_and_artifact",
    },
  );
}

const webSearch = createWebSearchTool();

function createResolveTimeTool(deps = {}) {
  return tool(
    async ({ expression }) => {
      const timeZone = deps.timezone ?? (deps.config ?? getConfig()).moonmind.timezone;
      const result = resolveTimeExpression(expression, { timeZone, now: deps.now ?? new Date() });

      if (!result.resolved) {
        return [result.reason, { results: [] }];
      }

      return [
        `"${expression}" is ${result.from} to ${result.to} (${result.label}). ` +
          "Pass these to metadata_filter as date_from and date_to.",
        { results: [], range: { from: result.from, to: result.to, label: result.label } },
      ];
    },
    {
      name: "resolve_time",
      description:
        "Turn a time expression into a concrete date range before filtering on it. " +
        'Handles "2023", "since 2023", "2023 to 2025", "last year", "this year", ' +
        '"last two years", "March 2024" and "now". Deterministic - no guessing, and it ' +
        "says so when an expression cannot be resolved. Always use this instead of " +
        "inventing dates yourself.",
      schema: z.object({
        expression: z
          .string()
          .min(1)
          .max(100)
          .describe('The time expression exactly as the user phrased it, e.g. "last year".'),
      }),
      responseFormat: "content_and_artifact",
    },
  );
}

// ---------------------------------------------------------------------------
// Document tools — thin wrappers over retrieval/, never copies of it
// ---------------------------------------------------------------------------

const DOCUMENT_CONTENT_CHARS = 700;

/**
 * Render ranked documents for the model.
 *
 * Runs through `sanitizeForPrompt`, the same whitelist `generate` uses, so `impact_score`
 * and `summary_for_embedding` cannot reach the model from here either. Titles are the
 * citation unit: they are what a visitor can recognise, where the id is a UUID and the
 * answer prompt forbids exposing machinery.
 */
function renderDocuments(documents, { label }) {
  if (documents.length === 0) {
    return `No documents matched ${label}.`;
  }

  const rendered = sanitizeForPrompt(documents).map((document, index) => {
    const meta = document.metadata ?? {};
    const facts = [
      meta.domain ? `domain: ${meta.domain}` : null,
      meta.date_start ? `from: ${String(meta.date_start).slice(0, 10)}` : null,
      meta.date_end ? `to: ${String(meta.date_end).slice(0, 10)}` : null,
      meta.completion_year ? `year: ${meta.completion_year}` : null,
      meta.is_active === true ? "active" : null,
      meta.external_links ? `links: ${Object.values(meta.external_links).join(" ")}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    const body = String(document.content ?? "").slice(0, DOCUMENT_CONTENT_CHARS);
    return `[${index + 1}] ${document.title}\n${facts}\n${body}`;
  });

  return `${documents.length} document(s) matching ${label}:\n\n${rendered.join("\n\n")}`;
}

/** What a document tool hands back to the node as a source. Ids stay out of the prose. */
const toSource = (document) => ({
  id: document.id,
  title: document.title,
  kind: "document",
});

/**
 * Run one retrieval arm and rank the result.
 *
 * `searchAllArms` is the same function `retrieve()` calls; the plan decides which arm
 * runs. Nothing here re-implements a query, a projection or the fusion — the tools differ
 * only in the plan they hand over.
 */
async function runArm({ query, plan, metadata, limit }, deps = {}) {
  const config = deps.config ?? getConfig();
  const { documents, failed } = await searchAllArms(
    { query, plan, metadata, limit: config.retrieval.candidateLimit },
    { config, collection: deps.collection, embedder: deps.embedder },
  );

  if (failed.length > 0) {
    console.warn("agent.tool.arm_failed", { failed });
  }

  return rankDocuments(documents, limit ?? config.retrieval.finalDocumentLimit, { config });
}

function createSemanticSearchTool(deps = {}) {
  return tool(
    async ({ query, limit }) => {
      const documents = await runArm(
        {
          query,
          plan: { retrieval_plan: { semantic: true, keyword: false, metadata: false } },
          limit,
        },
        deps,
      );

      console.log("agent.semantic_search", { query, results: documents.length });

      return [
        renderDocuments(documents, { label: `"${query}"` }),
        { results: documents.map(toSource) },
      ];
    },
    {
      name: "semantic_search",
      description:
        "Search Ayan's portfolio documents by meaning - his skills, projects, experience, " +
        "education, certifications and interests. This is the tool for anything about " +
        "Ayan himself; prefer it over web_search, which knows nothing about him.",
      schema: z.object({
        query: z.string().min(2).max(400).describe("What to look for, in natural language."),
        limit: z.number().int().min(1).max(20).optional().describe("How many documents. Default 10."),
      }),
      responseFormat: "content_and_artifact",
    },
  );
}

function createMetadataFilterTool(deps = {}) {
  return tool(
    async ({ domain, subcategory, date_from, date_to, completion_year, is_active, limit }) => {
      // The shape `buildMetadataQuery` reads. Dates go through the plan's date range,
      // which already spans date_start/date_end and handles open-ended records; the two
      // scalar fields go through the runtime metadata channel as equality filters.
      const plan = {
        filters: { domain: domain ? [domain] : [] },
        subcategories: subcategory ? [subcategory] : [],
        entities: { dates: { from: date_from ?? null, to: date_to ?? null } },
        retrieval_plan: { semantic: false, keyword: false, metadata: true },
      };

      const metadata = {};
      if (completion_year !== undefined) metadata.completion_year = completion_year;
      if (is_active !== undefined) metadata.is_active = is_active;

      const criteria = [
        domain ? `domain=${domain}` : null,
        subcategory ? `subcategory=${subcategory}` : null,
        date_from || date_to ? `dates ${date_from ?? "any"}..${date_to ?? "any"}` : null,
        completion_year ? `completion_year=${completion_year}` : null,
        is_active !== undefined ? `is_active=${is_active}` : null,
      ].filter(Boolean);

      if (criteria.length === 0) {
        return ["Give at least one filter — otherwise use semantic_search.", { results: [] }];
      }

      const documents = await runArm({ query: "", plan, metadata, limit }, deps);
      console.log("agent.metadata_filter", { criteria, results: documents.length });

      return [
        renderDocuments(documents, { label: criteria.join(", ") }),
        { results: documents.map(toSource) },
      ];
    },
    {
      name: "metadata_filter",
      description:
        "List Ayan's portfolio documents by structured metadata rather than by meaning. " +
        "Use it for 'what did he do in 2023', 'what is he working on now', or to walk a " +
        "timeline in order. Resolve any time expression with resolve_time first.",
      schema: z.object({
        domain: z.enum(ALLOWED_DOMAINS).optional().describe("Area of the portfolio."),
        subcategory: z.enum(ALLOWED_SUBCATEGORIES).optional().describe("Narrower topic."),
        date_from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("ISO date, from resolve_time."),
        date_to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("ISO date, from resolve_time."),
        completion_year: z.number().int().min(1990).max(2100).optional(),
        is_active: z.boolean().optional().describe("Only things still ongoing."),
        limit: z.number().int().min(1).max(20).optional().describe("How many documents. Default 10."),
      }),
      responseFormat: "content_and_artifact",
    },
  );
}

const resolveTime = createResolveTimeTool();
const semanticSearch = createSemanticSearchTool();
const metadataFilter = createMetadataFilterTool();

/**
 * Route -> the tools that route's agent is built with. A route absent from this map gets
 * no tools at all.
 *
 * One entry, because Phase 7 left one agent. Phase 9's `action` is deliberately NOT an
 * agent and gets no entry here: its side effect runs in node code, not behind a model's
 * decision. Nothing gains a tool by accident, because gaining one means editing this
 * object — there is no calendar tool and no email tool anywhere in this file.
 */
const TOOLSETS = Object.freeze({
  agent: Object.freeze([resolveTime, metadataFilter, semanticSearch, webSearch]),
});

module.exports = {
  TOOLSETS,
  webSearch,
  resolveTime,
  semanticSearch,
  metadataFilter,
  createWebSearchTool,
  createResolveTimeTool,
  createSemanticSearchTool,
  createMetadataFilterTool,
  resolveTimeExpression,
  renderSearch,
  renderDocuments,
};
