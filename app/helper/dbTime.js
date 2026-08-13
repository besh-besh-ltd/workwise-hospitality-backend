// ============================================================================
// THE NAIVE-TIMESTAMP CONTRACT
// ============================================================================
//
// `app/config/dbConn.js:31` installs a type parser for OID 1114
// (`timestamp without time zone`) that returns the raw text:
//
//     pgp.pg.types.setTypeParser(1114, (s) => s);
//
// So every one of those columns arrives in Node as a bare, unlabelled string —
// `"2026-08-13 07:00:00"` — with nothing in it saying which zone the digits
// belong to.
//
// For the negotiation tables the answer is UTC. `tbl_negotiation_rounds`
// timestamps are written as UTC (`negotiationController` normalises inbound
// with `moment.utc(...)` before persisting; `cronManager` appends `'Z'` when it
// reads them back), so `07:00` is 07:00 UTC — 12:30 IST.
//
// Nothing on the wire said so, and roughly thirty frontend call sites each
// guessed independently. Half of them guessed "local wall clock", which is
// exactly the 5h30m defect reported as tickets 1 and 2: one component rendered
// a round's end date as `07:00 AM` for the approver and `12:30 PM` for the
// creator, off the same row.
//
// These helpers close the contract at the API boundary. A negotiation
// timestamp leaves this server as an ISO-8601 instant with an explicit offset,
// so no consumer has to guess again. Do not "fix" a renderer downstream of a
// naive string — serialize it here instead.
//
// NOT for the naive-IST columns. `tbl_rfq.bid_end_date`,
// `tender_publish_date`, `vendor_clarification_date` and the ARC submission
// window store IST wall clock, not UTC. Those go through
// `getBidEndMomentIst` in `app/helper/quoteVisibility.js`; feeding one to
// `parseAsUTC` shifts it 5h30m the other way.

/**
 * Parse a database timestamp as UTC when it carries no zone information.
 *
 * A value that already declares an offset (`Z` or `+05:30`) is honoured as
 * written; a `Date` passes through untouched.
 */
export const parseAsUTC = (dateValue) => {
  if (!dateValue) return null;
  if (dateValue instanceof Date) return dateValue;
  const str = String(dateValue);
  if (str.includes('+') || str.includes('Z')) return new Date(str);
  return new Date(str.replace(' ', 'T') + 'Z');
};

/** The same value as an ISO-8601 instant, or null when it is unusable. */
export const isoOrNull = (v) => {
  const d = parseAsUTC(v);
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

/**
 * Every timestamp column a negotiation round row can carry.
 *
 * The list lives here rather than in `negotiationModel` because both the RFQ
 * and the ARC models serialize against it and neither should import the other.
 * Listing queries alias some of these (`round_created_at`, `first_round_at`,
 * `last_activity_at`, `next_deadline`) and pass their own key list.
 */
export const NEGOTIATION_TIMESTAMP_KEYS = [
  'end_date',
  'created_at',
  'updated_at',
  'approved_at',
  'published_at',
  'closed_at',
];

/**
 * Rewrite the named keys of one row in place as ISO-8601 instants.
 *
 * Mutates and returns the row — the same idiom as `normalizeProductNames` in
 * `negotiationModel`, so a query can chain both over its result set. A key
 * that is absent stays absent (never introduce a field a consumer did not
 * already have); a key that is null stays null.
 */
export const withIsoTimestamps = (row, keys = NEGOTIATION_TIMESTAMP_KEYS) => {
  if (!row) return row;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    if (row[key] == null) continue;
    row[key] = isoOrNull(row[key]);
  }
  return row;
};
