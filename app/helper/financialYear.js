// backend/app/helper/financialYear.js
//
// Indian Financial Year helpers — backend port of frontend/utils/financialYear.js
// (`fyStartYearOf` / `fyLabel` / `currentFy`). FY "YYYY-YY+1" runs
// 1 Apr YYYY → 31 Mar YYYY+1.
//
// Unlike the frontend version (which uses the browser's local `Date`), this
// module derives the FY from IST WALL-CLOCK via app/helper/arcTime.js
// (`arcMomentIst` / `nowIst`) — the same convention already used for ARC
// submission-window boundaries. A UTC production runtime evaluating bare
// `new Date().getFullYear()/getMonth()` would misclassify the 31-Mar/1-Apr
// boundary by a day (an ARC created at 00:30 IST on 1-Apr is still 31-Mar in
// UTC); routing through arcTime.js avoids that class of bug entirely (see
// arc.submissionWindow.tz.test.js for the equivalent fix in that module).
//
// Used by the ARC contract-serial generator (arcModel.nextArcNumber, called
// from arcController.js / arcManualController.js) and reusable by any future
// PO/MR serial that needs an FY-scoped number.

import { arcMomentIst, nowIst } from './arcTime.js';

// The FY *start year* for an IST moment (Jan–Mar belong to the previous FY).
function fyStartYearFromIstMoment(m) {
  const y = m.year();
  const mo = m.month(); // 0=Jan … 11=Dec
  return mo >= 3 ? y : y - 1; // Apr (3) onward → this year; Jan–Mar → previous FY
}

// Canonical label, e.g. 2026 → "2026-27".
export function fyLabel(startYear) {
  const end = (startYear + 1) % 100;
  return `${startYear}-${String(end).padStart(2, '0')}`;
}

/**
 * FY label ("2026-27") for a given date/moment/string, computed from its IST
 * wall-clock. Accepts anything `arcMomentIst` understands (Date instance,
 * moment, naive "YYYY-MM-DD HH:mm:ss" string treated AS IST wall-clock, or a
 * zoned/ISO string with an explicit offset). Defaults to the current IST
 * instant when called with no argument.
 *
 * @param {string|Date|import('moment-timezone').Moment|null} [date]
 * @returns {string} e.g. "2026-27"
 */
export function financialYearOf(date) {
  const m = date == null ? nowIst() : arcMomentIst(date);
  if (!m) throw new Error('financialYearOf: invalid date');
  return fyLabel(fyStartYearFromIstMoment(m));
}

/** Current Indian FY label from IST "now" (Asia/Kolkata). */
export function currentFinancialYearIst() {
  return financialYearOf();
}

export default { fyLabel, financialYearOf, currentFinancialYearIst };
