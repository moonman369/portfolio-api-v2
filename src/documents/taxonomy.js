"use strict";

// The controlled vocabularies for `moonmind_documents_v3`, and the single source for
// them across ingestion, validation, retrieval planning and any future tool.
//
// **This file is the source of truth, and the collection's `$jsonSchema` validator is
// generated from it** — run `scripts/sync-document-validator.js` after changing anything
// here. The two used to be maintained separately, which meant adding a value here made
// the app accept a document the database then rejected with an opaque
// `code: 121, Document failed validation` naming no field. See DATA_MODEL.md §8.
//
// The original values were transcribed from the live collection. Two look like typos and
// are not: `data structures` carries a space where everything else is kebab-case, and
// `fullstack` and `full-stack` are separate values. Existing documents use these
// strings, so "tidying" them would orphan data.

/** `category` — singular. */
const ALLOWED_CATEGORIES = Object.freeze([
  "skill",
  "certification",
  "credential",
  "education",
  "experience",
  "profile",
  "project",
  "hobby",
  "topic",
  // Added 2026-09-18. Life outside work: interests, fitness, entertainment, the
  // curiosity-driven rabbit holes. Broader than `hobby`, which it supersedes in
  // practice — see the note on CATEGORY_DOMAIN_MAP.
  "personal",
]);

/** `metadata.domain` — plural. A different word for the same concept, by design. */
const ALLOWED_DOMAINS = Object.freeze([
  "skills",
  "projects",
  "experience",
  "profile",
  "certifications",
  "education",
  "achievements",
  "research",
  "hobbies",
  // Added 2026-09-18, paired with the `personal` category.
  "personal",
]);

const ALLOWED_PROFICIENCY_LEVELS = Object.freeze([
  "beginner",
  "intermediate",
  "advanced",
  "expert",
]);

/** Technical skills, soft skills and meta tags. Grew from 78 to 85 on 2026-09-18. */
const ALLOWED_SUBCATEGORIES = Object.freeze([
  "programming-language", "backend", "frontend", "fullstack", "database", "devops",
  "cloud", "architecture", "api-design", "system-design", "distributed-systems",
  "security", "testing", "performance-optimization", "data-engineering",
  "machine-learning", "generative-ai", "rag", "vector-databases", "problem-solving",
  "communication", "teamwork", "leadership", "adaptability", "creativity",
  "critical-thinking", "decision-making", "time-management", "ownership", "ai",
  "automation", "api", "search", "chatbot", "analytics", "open-source", "experimental",
  "production-grade", "scalable", "high-performance", "integration",
  "enterprise-systems", "microservices", "computer-science", "software-engineering",
  "data-science", "artificial-intelligence", "mathematics", "hackathon", "competition",
  "ranking", "award", "recognition", "community", "nlp", "algorithms",
  "experimentation", "technical", "non-technical", "competitive-programming", "writing",
  "gaming", "learning", "ai-development", "agent-sdk", "prompt-engineering", "llm",
  "claude", "anthropic", "ai-agents", "mcp", "claude-api", "data structures", "practice",
  "ai-evaluation", "interview-preparation", "full-stack", "software-development",
  // Added 2026-09-18 for the EY GDS agentic-AI work.
  "azure-ai", "azure-foundry", "microsoft-agent-framework", "agentic-workflows",
  "agent-orchestration", "agentic-ai", "ai-engineering",
  // Added 2026-09-18. Named technologies rather than concepts: the older values sit a
  // level up (`programming-language`, `cloud`) and left specifics to free-form `tags`.
  // Adding these makes a language or platform filterable via `metadata_filter`, which
  // tags are not — so the ones that matter should be added deliberately, not as they
  // come up, or filtering is reliable for Python and silently useless for Java.
  "python", "azure",
  // Added 2026-09-18 for the `personal` category: interests outside work. `hobbies` is
  // also a domain name — the two vocabularies are independent, and a `personal` document
  // legitimately carries the subcategory `hobbies` under the domain `personal`.
  "hobbies", "programming", "music", "fitness", "sports", "movies", "web-series",
  "conspiracy-theories", "urban-legends", "creepypasta", "internet-mysteries",
]);

/**
 * The bridge between the two enums. Not a bijection — `certification` and `credential`
 * both map to `certifications` — so a category cannot be derived back from a domain.
 *
 * Note `topic -> research`, the one mapping nothing about the words suggests, and that
 * `achievements` is unreachable: no category maps to it, so no document written through
 * this path can carry it. See docs/DATA_MODEL.md §4.
 *
 * **`hobby` and `personal` overlap, deliberately for now.** `personal` was added
 * 2026-09-18 as the broader home for life outside work, and it is where that content
 * actually goes. `hobby`/`hobbies` predates it and has **zero documents in the live
 * collection**, so retiring the pair is a free removal whenever someone decides to —
 * unlike most enum removals, nothing stored would become invalid. Until then, prefer
 * `personal`; the deterministic domain rules in `retrieval/plan.js` point there.
 */
const CATEGORY_DOMAIN_MAP = Object.freeze({
  skill: "skills",
  certification: "certifications",
  credential: "certifications",
  education: "education",
  experience: "experience",
  profile: "profile",
  project: "projects",
  hobby: "hobbies",
  topic: "research",
  personal: "personal",
});

/** The domain a category requires, or undefined for an unknown category. */
function domainForCategory(category) {
  return CATEGORY_DOMAIN_MAP[category];
}

function isAllowedCategory(value) {
  return ALLOWED_CATEGORIES.includes(value);
}

function isAllowedDomain(value) {
  return ALLOWED_DOMAINS.includes(value);
}

function isAllowedSubcategory(value) {
  return ALLOWED_SUBCATEGORIES.includes(value);
}

module.exports = {
  ALLOWED_CATEGORIES,
  ALLOWED_DOMAINS,
  ALLOWED_PROFICIENCY_LEVELS,
  ALLOWED_SUBCATEGORIES,
  CATEGORY_DOMAIN_MAP,
  domainForCategory,
  isAllowedCategory,
  isAllowedDomain,
  isAllowedSubcategory,
};
