// Emailed-link vendor tokens (tbl_vendor_rfq_tokens_non_login.token, a BIGINT).
//
// A token is exchanged for a vendor session by POST /users/verify-vendor-token, so it
// must be unguessable. It used to be `Date.now() + Math.random() * 1e6`, numeric
// addition, i.e. the mint time give or take ~17 minutes: anyone who knew roughly when a
// link was sent (a co-invitee on the same RFQ, from their own link) could enumerate it.
//
// Now: a uniformly random 18-digit positive integer, 10^17 <= t < 10^18 (about 59.6
// bits), from crypto.randomBytes with rejection sampling, so there is no modulo bias.
// It fits a signed BIGINT (max ~9.22e18) and keeps the shape existing links have.
// Returned as a decimal STRING: it exceeds Number.MAX_SAFE_INTEGER, and pg binds and
// returns int8 as strings anyway, so nothing ever rounds it through a JS number.

import crypto from "crypto";

const MIN = 10n ** 17n; // smallest 18-digit number
const SPAN = 9n * 10n ** 17n; // 10^18 - 10^17
const TWO_64 = 1n << 64n;
const LIMIT = TWO_64 - (TWO_64 % SPAN); // largest multiple of SPAN within 64 bits

/** A fresh unguessable emailed-link token: an 18-digit decimal string. */
export function generateEmailLinkToken() {
  for (;;) {
    const v = crypto.randomBytes(8).readBigUInt64BE(0);
    if (v < LIMIT) return (MIN + (v % SPAN)).toString();
  }
}

export default { generateEmailLinkToken };
