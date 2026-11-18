// ============================================================================
// ARC audit times leave the API in India wall-clock time
// ============================================================================
//
// The ARC screens read every naive ARC timestamp as India (IST) wall clock.
// That is how the buyer enters the submission window and contract dates, how
// a Manual ARC stores the times typed into it, and how `terms_accepted_at` is
// written (`NOW() AT TIME ZONE 'Asia/Kolkata'`).
//
// The server-stamped audit columns are different. A vendor's `submitted_at`,
// an invitation's `responded_at`, `created_at`/`updated_at` and friends come
// from `CURRENT_TIMESTAMP` / `NOW()` / a column DEFAULT, on a database that runs
// in UTC, into `timestamp without time zone` columns. So a quote sent at
// 15:13 IST is stored as `09:43`, and the buyer's vendor response tracker
// printed "Submitted · 09:43" (REQ-2026-0093).
//
// `istAuditTimes` moves those columns to IST at the API boundary, in the same
// naive `YYYY-MM-DD HH:mm:ss` shape the screens already parse, so no screen has
// to change. Nothing stored changes and no backend logic reads the converted
// value: convert only the payload, after the work is done.
//
// Do NOT use it on:
//   - a Manual ARC's rows: their times were typed in IST already;
//   - `terms_accepted_at`, `submission_*_at`, `contract_*_at`: IST already;
//   - the negotiation tables: they leave as ISO instants (see app/helper/dbTime.js).

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

/**
 * A UTC timestamp as IST wall clock, `YYYY-MM-DD HH:mm:ss`.
 *
 * A naive string is read as UTC; a string with its own zone (`Z`, `+05:30`) or a
 * `Date` is honoured as the instant it names. A date-only or unparseable value
 * comes back untouched.
 */
export function utcToIstWallClock(value) {
  if (value == null || value === '') return value;
  let ms;
  if (value instanceof Date) {
    ms = value.getTime();
  } else {
    const s = String(value).trim();
    if (DATE_ONLY.test(s)) return value;
    const m = s.match(NAIVE);
    if (m) {
      const millis = Number(`${m[7] || ''}000`.slice(0, 3));
      ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), millis);
    } else {
      ms = new Date(s).getTime();
    }
  }
  if (Number.isNaN(ms)) return value;
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// The server-stamped (UTC) time columns of each ARC row a screen shows.
export const ARC_AUDIT_FIELDS = {
  arc:          ['created_at', 'updated_at'],
  invitation:   ['invited_at', 'responded_at'],
  // Not terms_accepted_at: it is written in IST.
  quote:        ['submitted_at', 'withdrawn_at', 'tech_submitted_at', 'created_at', 'updated_at'],
  quoteVersion: ['submitted_at', 'created_at'],
};

/** Convert `fields` of one row (in place) from UTC to IST wall clock. Returns the row. */
export function istAuditTimes(row, fields) {
  if (!row || typeof row !== 'object') return row;
  for (const f of fields) {
    if (row[f] != null && row[f] !== '') row[f] = utcToIstWallClock(row[f]);
  }
  return row;
}
