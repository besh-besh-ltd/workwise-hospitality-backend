/**
 * "Is this technical evaluation stuck?" — ONE predicate, every screen.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Until Oct 2026 eight separate queries answered "stuck" by testing
 *
 *     blocked_insufficient_vendors = TRUE AND total_passed_verified = 0
 *
 * That is true for ever once it is true: it ignores the bid window and it
 * ignores vendors still waiting to be evaluated. RFQ #536894 (tbl_rfq 1488,
 * tech eval 537) hit exactly that. Round 1 failed both quoted vendors, no
 * replacement existed, the evaluation was closed as blocked, and when the
 * client extended the deadline to let more vendors quote, every screen still
 * said "stuck" and nothing reopened.
 *
 * A line is stuck only while ALL of these hold (plan 2026-10-21, "Tech-stuck
 * product"):
 *   - the evaluation is blocked for want of vendors,
 *   - nobody has passed it,
 *   - bidding is closed (an open window means more vendors can still quote),
 *   - and no vendor is waiting to be evaluated (an "eligible unscored
 *     responder" — answered the clauses, quoted the line, has no verdict).
 *
 * Every caller builds its SQL from these functions. Do not re-derive any of
 * them inline: two copies of a predicate drift, and the drift is the bug.
 *
 * Aliases are SQL identifiers chosen by the calling code (never user input);
 * they are checked anyway so a typo fails loudly instead of building bad SQL.
 */

// bid_end_date is naive IST wall-clock text, so "now" must be IST wall-clock
// too. Bare NOW()/CURRENT_TIMESTAMP resolves through the session zone, which is
// UTC in production and IST on a Homebrew Postgres — see CLAUDE.md.
const IST_NOW = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')`;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VENDOR_EXPR = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name, what) {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`techEvalStuck: invalid ${what} alias ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Bidding is open: bid_end_date parses to a moment later than IST now.
 *
 * Accepts every shape production holds — 'YYYY-MM-DD HH24:MI[:SS]' and the ISO
 * 'YYYY-MM-DDTHH24:MI[:SS[.mmm]][Z]' form (a timestamp WITHOUT time zone
 * ignores a trailing zone, which is the wall-clock reading the rest of the
 * codebase applies). Empty, blank, NULL, or text that does not start with a
 * date reads as CLOSED rather than raising: 31 production rows hold '' and a
 * bare cast would abort the whole listing query for every user.
 *
 * NOT fully cast-proof: a value that starts like a date but is not one
 * ('2026-10-25 25:00', '2026-02-30') still raises on the CAST, exactly as every
 * other bid_end_date cast in this codebase does. Production values are
 * well-formed; making this total would need a plpgsql helper (a migration).
 *
 * @param {{ rfq: string }} aliases  alias of a tbl_rfq row
 * @returns {string} SQL boolean expression, never NULL
 */
export function bidWindowOpenSql({ rfq }) {
  const r = ident(rfq, 'rfq');
  return `COALESCE(
    (CASE WHEN TRIM(${r}.bid_end_date) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
          THEN CAST(TRIM(${r}.bid_end_date) AS TIMESTAMP)
     END) > ${IST_NOW},
    FALSE)`;
}

/**
 * An eligible unscored responder exists for evaluation `te` (optionally: the
 * given vendor is one). A vendor who
 *   - has at least one answer on a NON-sampling clause of `te` (sampling rows
 *     are created by the buyer while scoring, so they say nothing about the
 *     vendor), AND
 *   - holds a priced, non-regret quote covering `te`'s line — the same test
 *     getReserveTechEvalVendors applies before promoting anyone, so this never
 *     counts a vendor the replacement engine would refuse, AND
 *   - has no tbl_rfq_product_tech_evaluation_cleared_vendors row on `te`.
 *
 * @param {{ te: string, vendor?: string }} aliases
 *   te     alias of a tbl_rfq_product_tech_evaluation row
 *   vendor optional qualified column (e.g. 'vr.vendor_id') to ask about one vendor
 * @returns {string} SQL boolean expression (EXISTS …)
 */
export function eligibleUnscoredResponderSql({ te, vendor = null }) {
  const t = ident(te, 'te');
  if (vendor !== null && !VENDOR_EXPR.test(vendor)) {
    throw new Error(`techEvalStuck: invalid vendor expression ${JSON.stringify(vendor)}`);
  }
  return `EXISTS (
    SELECT 1
      FROM tbl_rfq_product_tech_evaluation_vendors_response _eur_vr
      JOIN tbl_rfq_product_tech_evaluation_clauses _eur_c
        ON _eur_c.id = _eur_vr.tbl_rfq_product_tech_evaluation_clauses_id
      JOIN tbl_rfq_products _eur_rp ON _eur_rp.id = ${t}.tbl_rfq_product_id
     WHERE _eur_c.tbl_rfq_product_tech_evaluation_id = ${t}.id
       AND (_eur_c.clause_type <> 'sampling' OR _eur_c.clause_type IS NULL)
       ${vendor ? `AND _eur_vr.vendor_id = ${vendor}` : ''}
       AND EXISTS (
         SELECT 1
           FROM tbl_quotes _eur_q
           JOIN tbl_quote_items _eur_qi ON _eur_qi.quote_id = _eur_q.id
          WHERE _eur_q.rfq_id = ${t}.rfq_id
            AND _eur_q.created_by = _eur_vr.vendor_id
            AND _eur_q.is_regret <> 1
            AND _eur_qi.product_variant_id = _eur_rp.product_variant_id
            AND COALESCE(_eur_qi.variant, 0) = COALESCE(_eur_rp.variant, 0)
            AND _eur_qi.total_price > 0
       )
       AND NOT EXISTS (
         SELECT 1 FROM tbl_rfq_product_tech_evaluation_cleared_vendors _eur_cv
          WHERE _eur_cv.tbl_rfq_product_tech_evaluation_id = ${t}.id
            AND _eur_cv.vendor_id = _eur_vr.vendor_id
       )
  )`;
}

/**
 * Evaluation `te` is blocked for want of vendors and nobody has passed it.
 * The raw "blocked with zero passed" fact, NULL-safe (always TRUE/FALSE). On its
 * own it does NOT mean stuck — see techStuckSql — but it is what
 * products_with_cleared must exclude (a line nobody passed has cleared nobody,
 * stuck or reopened) and what a deadline extension may reopen.
 */
export function techBlockedNoPassSql({ te }) {
  const t = ident(te, 'te');
  return `(${t}.blocked_insufficient_vendors IS TRUE AND COALESCE(${t}.total_passed_verified, 0) = 0)`;
}

/**
 * The line behind evaluation `te` is technically stuck right now: blocked for
 * want of vendors, nobody passed, bidding closed, and nobody left to evaluate.
 * The only way forward is to extend the bid deadline (which reopens it — see
 * reopenStuckTechEvals in rfqController) or to close the RFQ.
 *
 * @param {{ te: string, rfq: string }} aliases
 *   te  alias of a tbl_rfq_product_tech_evaluation row
 *   rfq alias of the tbl_rfq row that evaluation belongs to
 * @returns {string} SQL boolean expression
 */
export function techStuckSql({ te, rfq }) {
  const t = ident(te, 'te');
  return `(
    ${techBlockedNoPassSql({ te: t })}
    AND NOT ${bidWindowOpenSql({ rfq })}
    AND NOT ${eligibleUnscoredResponderSql({ te: t })}
  )`;
}

/**
 * Evaluation `te` may be reopened by a bid-deadline extension: it is stuck now,
 * OR it is blocked with nobody passed and still locked as complete. The second
 * arm covers an evaluation locked while bidding was still open (before the
 * keep-open rule in handleTechnicalPostApproval existed): it is not stuck —
 * bidding is open — yet without this an extension would leave it locked, and a
 * vendor quoting in the new window could never be evaluated.
 *
 * The caller must still check, on the row as written, that the window is open.
 */
export function techReopenCandidateSql({ te, rfq }) {
  const t = ident(te, 'te');
  return `(
    ${techStuckSql({ te: t, rfq })}
    OR (${techBlockedNoPassSql({ te: t })} AND ${t}.is_complete IS TRUE)
  )`;
}

/**
 * Evaluation `te` is locked as complete, blocked with nobody passed, yet a
 * vendor is waiting to be evaluated (an eligible unscored responder). Nothing
 * can be edited (it is not stuck) and every submit would be refused as already
 * complete — so the submit path treats it as open: it lifts the lock in its own
 * transaction and carries the new vendor into the next round. Any other gate
 * that refuses work on a complete evaluation must make the same exception.
 */
export function techRecoverableSql({ te }) {
  const t = ident(te, 'te');
  return `(
    ${techBlockedNoPassSql({ te: t })}
    AND ${t}.is_complete IS TRUE
    AND ${eligibleUnscoredResponderSql({ te: t })}
  )`;
}

/**
 * The evaluation was reopened by a deadline extension: still blocked, but no
 * longer locked as complete. (Plan definition "Reopened".)
 */
export function techReopenedSql({ te }) {
  const t = ident(te, 'te');
  return `(${t}.blocked_insufficient_vendors IS TRUE AND ${t}.is_complete IS NOT TRUE)`;
}

export default {
  bidWindowOpenSql,
  eligibleUnscoredResponderSql,
  techBlockedNoPassSql,
  techStuckSql,
  techReopenCandidateSql,
  techRecoverableSql,
  techReopenedSql,
};
