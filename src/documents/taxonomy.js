"use strict";

// The controlled vocabularies for `moonmind_documents_v3`, and the single source for
// them across ingestion, validation, retrieval planning and any future tool.
//
// Values are reproduced exactly from the live collection. Two look like typos and are
// not: `data structures` carries a space where everything else is kebab-case, and
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
]);

const ALLOWED_PROFICIENCY_LEVELS = Object.freeze([
  "beginner",
  "intermediate",
  "advanced",
  "expert",
]);

/** 78 values spanning technical skills, soft skills and meta tags. */
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
]);

/**
 * The bridge between the two enums. Not a bijection — `certification` and `credential`
 * both map to `certifications` — so a category cannot be derived back from a domain.
 *
 * Note `topic -> research`, the one mapping nothing about the words suggests, and that
 * `achievements` is unreachable: no category maps to it, so no document written through
 * this path can carry it. See docs/DATA_MODEL.md §4.
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
