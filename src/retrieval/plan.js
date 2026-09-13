"use strict";

// Query planning: split a question into sub-queries, then compile each into a retrieval
// plan (which arms to run, which filters to apply).
//
// Models are INJECTED for the same reason as in rank.js — agent/ sits above retrieval/,
// so importing getModel here would be an upward import. Every stage has a deterministic
// fallback, so planning still works with no model at all.
//
// One correction to the old service: it ran an LLM intent call and then unconditionally
// overwrote the result with a local regex table, making half its system prompt dead code
// (OLD_REPO_MAP.md §10.22). Here the regex table is the FALLBACK, not the override.

const { z } = require("zod");
const { getConfig } = require("../config");
const { ALLOWED_DOMAINS, ALLOWED_SUBCATEGORIES } = require("../documents/taxonomy");

const SUBCATEGORY_SET = new Set(ALLOWED_SUBCATEGORIES);

const DecomposeSchema = z.object({
  subqueries: z.array(z.string().min(1)).describe("independent, self-contained sub-questions"),
});

const PlanSchema = z.object({
  domain: z.enum(ALLOWED_DOMAINS).nullable(),
  subcategories: z.array(z.enum(ALLOWED_SUBCATEGORIES)).max(8),
  requires_retrieval: z.boolean(),
  keyword_useful: z.boolean().describe("true only for exact-term lookups: names, acronyms"),
  entities: z.object({
    skills: z.array(z.string()).max(10),
    projects: z.array(z.string()).max(10),
    certifications: z.array(z.string()).max(10),
    organizations: z.array(z.string()).max(10),
  }),
  dates: z.object({
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
});

const DECOMPOSE_PROMPT = [
  "Split the user's question into independent, self-contained sub-questions for a",
  "retrieval system, so each distinct information need can be searched separately.",
  "Return at most {max}. If the question asks about only ONE thing, return it unchanged",
  "as the single sub-question - do NOT invent extra parts. Each sub-question must be",
  "standalone and keyword-rich, with pronouns resolved.",
].join(" ");

const PLAN_PROMPT = [
  "You compile a question about Ayan Maiti's portfolio into a retrieval plan.",
  "You are not interpreting freely: map the question onto the fixed vocabulary.",
  "",
  "`domain` must be one of the allowed domains, or null if the question is not about a",
  "specific area of his portfolio.",
  "`subcategories` must come from the allowed list; leave it empty when nothing fits.",
  "`requires_retrieval` is false only for greetings and small talk.",
  "`keyword_useful` is true only when an exact term must match literally - a product",
  "name, an acronym, a specific technology - not for general questions.",
  "Extract entities only when explicitly named. Never invent vague labels like",
  '"technical skills".',
  "`dates.from` / `dates.to` are ISO-8601 strings, or null when no period is mentioned.",
].join("\n");

// ---------------------------------------------------------------------------
// Deterministic fallback — also the source of truth when no model is available
// ---------------------------------------------------------------------------

const DOMAIN_RULES = Object.freeze([
  [/\bskills?\b|\btech\s*stack\b|\bstrengths?\b/i, "skills"],
  [/\bprojects?\b|\bbuilt?\b|\bimplemented\b/i, "projects"],
  [/\bexperiences?\b|\bwork\b|\brole\b|\bjob\b/i, "experience"],
  [/\bprofile\b|\boverall\s+summary\b|\babout\s+(?:me|him|ayan)\b|\bwho\s+is\b/i, "profile"],
  [/\bcertifications?\b|\bcertified\b|\bcertificates?\b/i, "certifications"],
  [/\beducation\b|\bdegree\b|\buniversity\b|\bcollege\b/i, "education"],
  [/\bachievements?\b|\bawards?\b/i, "achievements"],
  [/\bresearch\b|\bpapers?\b|\bpublications?\b/i, "research"],
  [/\bhobbies\b|\binterests?\b|\bgaming\b/i, "hobbies"],
]);

const SUBCATEGORY_RULES = Object.freeze([
  ["backend", /\bbackend\b|\bnode\b|\bexpress\b/i],
  ["frontend", /\bfrontend\b|\breact\b/i],
  ["database", /\bmongodb\b|\bpostgres\b|\bdatabase\b/i],
  ["devops", /\bdevops\b|\bci\/cd\b|\bdocker\b/i],
  ["cloud", /\bcloud\b|\baws\b|\bazure\b|\bgcp\b/i],
  ["system-design", /\bsystem\s*design\b/i],
  ["microservices", /\bmicroservices\b|\bdistributed\b/i],
  ["machine-learning", /\bmachine\s*learning\b/i],
  ["generative-ai", /\bgenerative\s*ai\b|\bllm\b/i],
  ["rag", /\brag\b|\bretrieval[-\s]*augmented\b/i],
  ["vector-databases", /\bvector\s*(?:db|database)\b/i],
  ["ai", /\bai\b|\bartificial\s*intelligence\b/i],
  ["search", /\bsearch\b|\bretriev\w*\b/i],
  ["algorithms", /\balgorithm\w*\b/i],
  ["competitive-programming", /\bcompetitive\s*programming\b|\bleetcode\b/i],
]);

const NO_RETRIEVAL_PATTERNS = Object.freeze([
  /^\s*(?:hi|hello|hey|yo|good\s+(?:morning|afternoon|evening))[\s!,.?]*$/i,
  /^\s*(?:how are you|what'?s up|thanks|thank you)[\s!,.?]*$/i,
]);

function deterministicPlan(query) {
  const text = String(query ?? "").trim();

  const domain = DOMAIN_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
  const subcategories = SUBCATEGORY_RULES.filter(([, pattern]) => pattern.test(text))
    .map(([subcategory]) => subcategory)
    .filter((subcategory) => SUBCATEGORY_SET.has(subcategory));

  return {
    domain,
    subcategories: [...new Set(subcategories)],
    requires_retrieval: !NO_RETRIEVAL_PATTERNS.some((pattern) => pattern.test(text)),
    keyword_useful: false,
    entities: { skills: [], projects: [], certifications: [], organizations: [] },
    dates: { from: null, to: null },
  };
}

/** Shape a plan into what search.js reads, applying the arm-selection rules. */
function toRetrievalPlan(plan, { keywordEnabled }) {
  const requiresRetrieval = plan.requires_retrieval !== false;
  const hasDomain = Boolean(plan.domain) || plan.subcategories.length > 0;

  return {
    domain: plan.domain,
    subcategories: plan.subcategories,
    entities: { ...plan.entities, dates: plan.dates },
    filters: { domain: plan.domain ? [plan.domain] : [] },
    requires_retrieval: requiresRetrieval,
    retrieval_plan: {
      // Semantic is always on when retrieving: it is the only arm that works on a
      // question the vocabulary does not cover.
      semantic: requiresRetrieval,
      keyword: requiresRetrieval && keywordEnabled && plan.keyword_useful === true,
      metadata: requiresRetrieval && hasDomain,
    },
  };
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Split a query into sub-queries. Disabled, unavailable or failing → `[query]`.
 * @param {{ model?: object, config?: object }} [deps]
 */
async function decomposeQuery(query, deps = {}) {
  const { retrieval } = deps.config ?? getConfig();

  if (!retrieval.decomposeEnabled || !deps.model) {
    return [query];
  }

  try {
    const result = await deps.model
      .withStructuredOutput(DecomposeSchema, { name: "decompose" })
      .invoke([
        {
          role: "system",
          content: DECOMPOSE_PROMPT.replace("{max}", String(retrieval.decomposeMaxSubqueries)),
        },
        { role: "user", content: query },
      ]);

    const cleaned = [
      ...new Set(
        (result?.subqueries ?? [])
          .filter((item) => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ].slice(0, retrieval.decomposeMaxSubqueries);

    return cleaned.length > 0 ? cleaned : [query];
  } catch (error) {
    console.warn("retrieval.decompose_fallback", { message: error?.message });
    return [query];
  }
}

/**
 * Compile one query into a retrieval plan.
 * No model, or any failure → the deterministic regex plan.
 * @param {{ model?: object, config?: object }} [deps]
 */
async function planQuery(query, deps = {}) {
  const config = deps.config ?? getConfig();
  const fallback = () => toRetrievalPlan(deterministicPlan(query), config.retrieval);

  if (!deps.model) {
    return fallback();
  }

  try {
    const result = await deps.model
      .withStructuredOutput(PlanSchema, { name: "plan" })
      .invoke([
        { role: "system", content: PLAN_PROMPT },
        { role: "user", content: query },
      ]);

    return toRetrievalPlan(
      {
        domain: ALLOWED_DOMAINS.includes(result.domain) ? result.domain : null,
        subcategories: (result.subcategories ?? []).filter((value) => SUBCATEGORY_SET.has(value)),
        requires_retrieval: result.requires_retrieval,
        keyword_useful: result.keyword_useful,
        entities: result.entities ?? {
          skills: [],
          projects: [],
          certifications: [],
          organizations: [],
        },
        dates: result.dates ?? { from: null, to: null },
      },
      config.retrieval,
    );
  } catch (error) {
    console.warn("retrieval.plan_fallback", { message: error?.message });
    return fallback();
  }
}

module.exports = {
  decomposeQuery,
  planQuery,
  deterministicPlan,
  toRetrievalPlan,
  DecomposeSchema,
  PlanSchema,
};
