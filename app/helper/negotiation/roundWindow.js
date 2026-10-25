// The shortest window a negotiation round may be opened with.
//
// A round's deadline is fixed when it is CREATED, but the round only reaches a
// vendor once every approver has signed off, so approval time comes out of the
// vendor's window. Production ARC-2026-27-0006 opened eight rounds with
// deadlines 4–64 minutes out; seven lapsed before the three approvers they
// needed could act, and no vendor ever saw one. RFQ rounds lapse the same way
// (about a quarter never reached a vendor).
//
// This is a floor, not the fix for that coupling: the window still starts at
// creation. Shared by the RFQ and ARC create endpoints so the two cannot drift.

export const MIN_ROUND_WINDOW_MINUTES = 120;

export const ROUND_WINDOW_TOO_SHORT_MESSAGE =
  'The round deadline must be at least 2 hours from now, so approvers have time to approve and vendors have time to respond.';

/**
 * @param {Date|string} endDate  an instant (a string must carry its offset or Z)
 * @param {Date} now
 * @returns {string|null} the refusal message, or null when the window is long enough.
 *   Callers check "in the future" first and keep their own message for that.
 */
export function roundWindowError(endDate, now = new Date()) {
  const end = endDate instanceof Date ? endDate : new Date(endDate);
  if (Number.isNaN(end.getTime())) return null;
  return end.getTime() - now.getTime() < MIN_ROUND_WINDOW_MINUTES * 60_000
    ? ROUND_WINDOW_TOO_SHORT_MESSAGE
    : null;
}
