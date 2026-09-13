"use strict";

// A LangChain `Embeddings` implementation over documents/embeddings.js.
//
// Deliberately not `@langchain/google-genai`: the stock class knows nothing about the
// two prompt templates, the 768-dimension guard, or the one-text-per-call rule, and
// swapping it in would quietly produce vectors incomparable with everything already in
// Atlas. Wrapping keeps the feasibility review's recommendation intact.

const { Embeddings } = require("@langchain/core/embeddings");
const {
  embedText,
  embedQuery: embedQueryText,
  buildDocumentEmbeddingText,
} = require("../documents/embeddings");

class MoonMindEmbeddings extends Embeddings {
  /**
   * @param {{ embedText?: Function, embedQuery?: Function }} [deps] Injected for tests.
   */
  constructor(deps = {}) {
    super(deps.params ?? {});
    this.embedTextImpl = deps.embedText ?? embedText;
    this.embedQueryImpl = deps.embedQuery ?? embedQueryText;
  }

  /** Applies the QUERY template — the asymmetric partner of the document one. */
  async embedQuery(text) {
    return this.embedQueryImpl(text);
  }

  /**
   * LangChain's contract: an array of already-composed strings.
   *
   * Sequential, never batched: passing several inputs to Gemini's `embedContent` returns
   * one aggregated vector rather than one per input, so a batch would write the same
   * blended vector to every document.
   */
  async embedDocuments(texts) {
    const vectors = [];
    for (const text of texts) {
      vectors.push(await this.embedTextImpl(text));
    }
    return vectors;
  }

  /**
   * Embed stored documents by applying the DOCUMENT template first.
   *
   * Separate from `embedDocuments` on purpose: that one must keep LangChain's
   * `string[]` signature so this class stays substitutable for any `Embeddings`, while
   * the template needs the document's structure, not its text.
   */
  async embedStoredDocuments(documents) {
    return this.embedDocuments(documents.map((document) => buildDocumentEmbeddingText(document)));
  }
}

let shared = null;

/** The process-wide embedder. Tests construct their own with injected functions. */
function getEmbedder() {
  if (!shared) {
    shared = new MoonMindEmbeddings();
  }
  return shared;
}

module.exports = { MoonMindEmbeddings, getEmbedder };
