import { getBidEndMomentIst, istNow } from './quoteVisibility.js';

/**
 * ARC v2 — IST submission-window time helpers.
 *
 * All ARC submission-window columns (`submission_start_at`, `submission_end_at`)
 * are stored as `timestamp without time zone` representing IST wall-clock, matching
 * the RFQ `bid_end_date` convention in quoteVisibility.js.  On a UTC production
 * runtime, comparing those columns with `new Date()` shifts the boundary by +5:30.
 *
 * This module is a thin wrapper over the RFQ primitives so there is ONE IST
 * timezone convention shared by both modules — no second magic offset anywhere.
 *
 * Exports (API stable for controllers + models):
 *   arcMomentIst(raw)     — parse a naive ARC timestamp string|Date as IST (null-safe)
 *   nowIst()              — current instant as an IST moment
 *   windowNotOpen(arc)    — true if submission_start_at is still in the future (IST)
 *   windowClosed(arc)     — true if submission_end_at is in the past (IST)
 */

/**
 * Parse a naive ARC timestamp string or Date object as an IST moment.
 * Delegates to the RFQ helper which handles all common Postgres date formats,
 * zoned strings, and moment objects.  Returns null for null/empty input.
 *
 * @param {string|Date|import('moment-timezone').Moment|null|undefined} raw
 * @returns {import('moment-timezone').Moment|null}
 */
export const arcMomentIst = (raw) => getBidEndMomentIst(raw);

/**
 * Current instant as a moment in IST.
 * @returns {import('moment-timezone').Moment}
 */
export const nowIst = () => istNow();

/**
 * Returns true when the submission window has NOT opened yet:
 * `submission_start_at` is in the future relative to IST now.
 * Returns false when submission_start_at is absent (no pre-open gate).
 *
 * @param {{ submission_start_at?: string|Date|null }} arc
 */
export const windowNotOpen = (arc) => {
  if (!arc.submission_start_at) return false;
  const start = arcMomentIst(arc.submission_start_at);
  return !!start && nowIst().isBefore(start);
};

/**
 * Returns true when the submission window has CLOSED:
 * `submission_end_at` is in the past (or exactly now) relative to IST now.
 * Returns false when submission_end_at is absent (no close gate).
 *
 * @param {{ submission_end_at?: string|Date|null }} arc
 */
export const windowClosed = (arc) => {
  if (!arc.submission_end_at) return false;
  const end = arcMomentIst(arc.submission_end_at);
  return !!end && nowIst().isSameOrAfter(end);
};
