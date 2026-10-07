"use strict";

// The Cal.com booking links' health check (Phase 10.1). Plain JS on native `fetch` — no
// provider SDK, no LangChain, no Cal.com API. MoonMind only hands out links; the booking
// itself happens on Cal.com's page, where Cal.com shows its own errors. What MoonMind CAN
// see is whether the link it is about to show still leads somewhere, so it looks first.
//
// Detection, verified against the live site at the Phase 10.1 gate (2026-10-06): a working
// event page answers 200; a missing event or user answers a real 404 with Cal.com's
// "This page could not be found" page. The page text is no use as a marker — words like
// "disabled" and "unavailable" are in every page's bundle, working ones included — so the
// status is the whole signal. A hidden or disabled event was not available to probe; it is
// covered by the same rule and recorded as unverified in PROGRESS.md.
//
// One call per URL per cache period, one timeout, no retries: a result — good or bad — is
// cached for MOONMIND_BOOKING_CHECK_CACHE_MS, so a run of booking requests costs Cal.com
// one GET per link, and a Cal.com outage costs each visitor at most one timeout.

const { getConfig } = require("../config");

/** What a check can say about a link. Nothing else ever leaves this module. */
const LINK_OUTCOMES = Object.freeze(["ok", "not_found", "unreachable"]);

// The event type is gone (or was never there). 410 is how a CDN says the same thing.
const NOT_FOUND_STATUSES = Object.freeze([404, 410]);

/** Map an HTTP status to an outcome. Anything not clearly fine or clearly gone is "unreachable". */
function classifyStatus(status) {
  if (status >= 200 && status < 300) {
    return "ok";
  }
  return NOT_FOUND_STATUSES.includes(status) ? "not_found" : "unreachable";
}

/**
 * A link checker with its own cache.
 *
 * @param {{ fetchImpl?: Function, now?: () => number, timeoutMs: number, cacheMs: number }} options
 *   `fetchImpl` and `now` are injected so tests never touch the network or the clock.
 * @returns {(url: string) => Promise<{ outcome: string, httpStatus: number|null, errorCode: string|null }>}
 *   Never rejects: a thrown error of any kind is `unreachable`.
 */
function createLinkChecker({ fetchImpl = fetch, now = Date.now, timeoutMs, cacheMs }) {
  const cache = new Map();

  async function probe(url) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Only the status matters; don't hold the connection open for a 150 KB page.
      try {
        await response.body?.cancel?.();
      } catch {
        // The status is already in hand; a body that will not close changes nothing.
      }
      return { outcome: classifyStatus(response.status), httpStatus: response.status, errorCode: null };
    } catch (error) {
      return {
        outcome: "unreachable",
        httpStatus: null,
        errorCode: error?.name === "TimeoutError" ? "TIMEOUT" : (error?.cause?.code ?? error?.code ?? error?.name ?? "ERROR"),
      };
    }
  }

  return async function checkBookingLink(url) {
    const cached = cache.get(url);
    if (cached && cached.expiresAt > now()) {
      return cached.result;
    }

    const result = await probe(url);
    cache.set(url, { result, expiresAt: now() + cacheMs });
    return result;
  };
}

let shared = null;

/**
 * Check one booking link with the process-wide checker, built from config on first use so
 * its cache is shared by every turn.
 */
function checkBookingLink(url) {
  if (shared === null) {
    const { booking } = getConfig();
    shared = createLinkChecker({ timeoutMs: booking.checkTimeoutMs, cacheMs: booking.checkCacheMs });
  }
  return shared(url);
}

module.exports = { checkBookingLink, createLinkChecker, classifyStatus, LINK_OUTCOMES };
