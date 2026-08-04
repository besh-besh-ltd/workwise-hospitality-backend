// Negotiation metrics for the quote-comparison summary export.
//
// WHY THIS EXISTS, AND WHY IT DOES NOT INVENT A FORMULA
//
// "How much was negotiated and saved" has no single answer in this codebase —
// there are several savings-shaped calculations with different baselines
// (LPR-vs-L1 on the comparison view, the negotiation ladder, PO vendor spread,
// price-anomaly drift, market deviation), and the PO dashboard reports a
// hard-coded zero. A downloaded report that quietly picks one of those, or
// worse invents a new one, will disagree with the dashboards the same user is
// looking at, and the number stops being trusted.
//
// So this reuses negotiationModel.getNegotiationParentSavings — the only
// definition that is shared across surfaces AND asserted to the rupee against
// the dashboard widget (tests/services/dashboard.negotiationSavingsLadder.test.js).
// It is signed, not clamped: prices genuinely go up sometimes, and a floor of
// zero would hide it.
//
// Note this deliberately answers a DIFFERENT question from the comparison
// view's own `potentialSavings` (baseline LPR vs the L1 mix). That one is
// "what could we have paid"; this one is "what did negotiation actually move".
// The export prints both, labelled, rather than blending them.
import db from '../config/dbConn.js';
import negotiationModel from '../models/negotiationModel.js';

const money = (v) => Math.round(Number(v || 0) * 100) / 100;

const pct = (part, whole) =>
  Math.abs(Number(whole || 0)) > 0.005
    ? Math.round((Number(part) / Number(whole)) * 10000) / 100
    : null;

/**
 * Round counts for one RFQ.
 *
 * Counts DISTINCT rounds rather than reading `round_number`: the stored column
 * is a legacy per-product counter, while every UI surface shows a computed
 * position (ROW_NUMBER over the parent). Counting rows keeps this report and
 * the screen in agreement.
 *
 * ARC-sourced rounds are excluded — they belong to a rate contract, not to
 * this RFQ's quote comparison, and the savings ladder excludes them too.
 */
async function getRoundCounts(rfqId) {
  const row = await db.oneOrNone(
    `SELECT
       COUNT(*)::int                                                        AS rounds_created,
       COUNT(*) FILTER (WHERE status <> 'CANCELLED')::int                   AS rounds_ran,
       COUNT(*) FILTER (WHERE status = 'CANCELLED')::int                    AS rounds_cancelled,
       COUNT(*) FILTER (WHERE status IN ('ENDED', 'COMPLETED'))::int        AS rounds_ended,
       COUNT(*) FILTER (WHERE status = 'EXPIRED')::int                      AS rounds_expired,
       COUNT(DISTINCT rfq_product_id) FILTER (
         WHERE status <> 'CANCELLED' AND rfq_product_id IS NOT NULL)::int    AS products_negotiated
     FROM tbl_negotiation_rounds
     WHERE rfq_id = $1
       AND COALESCE(source_type, 'RFQ') <> 'ARC'`,
    [rfqId]
  );
  return (
    row || {
      rounds_created: 0, rounds_ran: 0, rounds_cancelled: 0,
      rounds_ended: 0, rounds_expired: 0, products_negotiated: 0,
    }
  );
}

/**
 * Build the negotiation metrics block for one RFQ.
 *
 * ⚠️ SECURITY: getNegotiationParentSavings reads tbl_quotes / tbl_quote_items /
 * tbl_quote_item_history and applies NO scope of its own — it trusts the ids it
 * is handed. Callers MUST have already authorised this rfqId (the quote
 * comparison controller does so with assertCanReadParentRfq before calling
 * here). Never pass an id straight off a request without that gate.
 *
 * @param {number|string} rfqId  an ALREADY-AUTHORISED rfq id
 */
export async function buildNegotiationMetrics(rfqId) {
  const id = Number(rfqId);
  if (!Number.isFinite(id)) return null;

  const [rows, counts] = await Promise.all([
    negotiationModel.getNegotiationParentSavings([id]),
    getRoundCounts(id),
  ]);

  const s = rows && rows.length ? rows[0] : null;

  // No negotiation, or no comparable pair on any line: report absence rather
  // than a zero. "₹0 saved" and "not measurable" look identical in a
  // spreadsheet and mean very different things — in production 26 of 125
  // negotiated RFQs have no price history to form a baseline from.
  if (!s || Number(s.pairs_counted || 0) === 0) {
    return {
      available: false,
      ...counts,
      pairs_counted: 0,
      baseline_total: null, achieved_total: null,
      gain_value: null, gain_pct: null,
      pairs_counted_awarded: 0,
      baseline_total_awarded: null, achieved_total_awarded: null,
      gain_value_awarded: null, gain_pct_awarded: null,
      baseline_sources: s?.baseline_sources || null,
    };
  }

  const baseline = money(s.baseline_total);
  const achieved = money(s.achieved_total);
  const baselineAwarded = money(s.baseline_total_awarded);
  const achievedAwarded = money(s.achieved_total_awarded);

  return {
    available: true,
    ...counts,
    // Every line that had a comparable before/after pair.
    pairs_counted: Number(s.pairs_counted || 0),
    baseline_total: baseline,
    achieved_total: achieved,
    gain_value: money(baseline - achieved),
    gain_pct: pct(baseline - achieved, baseline),
    // Restricted to lines actually awarded — the figure that reflects money
    // the business will really spend, and the one worth putting in front of
    // finance.
    pairs_counted_awarded: Number(s.pairs_counted_awarded || 0),
    baseline_total_awarded: baselineAwarded,
    achieved_total_awarded: achievedAwarded,
    gain_value_awarded: money(baselineAwarded - achievedAwarded),
    gain_pct_awarded: pct(baselineAwarded - achievedAwarded, baselineAwarded),
    // Provenance: how each line's baseline was established
    // (previous_price / prior_round / quote_history / current_quote / none).
    // Printed on the export so the number can be defended rather than argued.
    baseline_sources: s.baseline_sources || null,
  };
}

export default { buildNegotiationMetrics };
