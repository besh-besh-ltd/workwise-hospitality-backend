/**
 * Technical Qualification Service
 *
 * ONE predicate deciding whether a vendor may be AWARDED a product line, shared
 * by every write path that can create an award. Do not re-derive it inline.
 *
 * WHY THIS IS A SERVICE AND NOT TWO COPIES OF A QUERY
 * ---------------------------------------------------
 * The technical gate historically lived ENTIRELY at the read layer:
 * rfqModel.getQuotesByRfqById2 / getQuotesByRfqByIdByProduct are called with
 * TA_Vendors = 'TA', which appends `vendorCondition` (rfqModel.js L6527 and
 * L6911 — the same SQL, written out twice) to drop a technically disqualified
 * vendor's quotation rows. quoteCompareViewModel then renders the cell as
 * TECH_FAILED / TECH_PENDING and the FE never builds a payload for them.
 *
 * Suppression at the read layer is a UI affordance, not an authorization check.
 * Every write path that inserts into tbl_quote_finalization has to repeat the
 * decision, and the moment it is repeated by hand it drifts. That is not
 * hypothetical: the sibling active-negotiation guard read the `rfq_product_id`
 * COLUMN while the real round coverage lived in the `products` JSONB, so it
 * silently never fired for multi-product rounds. `coversProductSql`
 * (negotiationModel.js L64) is the fix pattern — one exported predicate, N call
 * sites. This service is that pattern for the technical verdict.
 *
 * THE PREDICATE (mirrors `vendorCondition` EXACTLY)
 * -------------------------------------------------
 * Two conditions, ANDed. Deliberately not stricter than the read layer: a write
 * gate stricter than the read gate refuses a vendor the buyer can actually see
 * and click, which is an unfixable dead end in the UI.
 *
 *   Condition 1 (RFQ level)     — the RFQ has no technical evaluation anywhere,
 *                                 OR this vendor passed at least one product.
 *   Condition 2 (product level) — THIS product has no technical evaluation,
 *                                 OR this vendor passed THIS product.
 *
 * The three verdict states, and why each lands where it does:
 *   status = 1 (passed)  -> ALLOW. The only state the read gate lets past.
 *   status = 0 (failed)  -> BLOCK. The explicit disqualification.
 *   no verdict row yet   -> BLOCK, but only where an evaluation is CONFIGURED.
 *     Nobody has judged this vendor, so there is no clearance to rely on;
 *     awarding now would let a buyer skip their own technical gate simply by
 *     awarding before it completes. The read layer already behaves this way —
 *     `OR EXISTS (... status = 1)` is false when the row is absent, and
 *     quoteCompareViewModel labels the cell TECH_PENDING, so the buyer cannot
 *     select it either.
 *
 * It keys on `status`, NOT `is_verified`.
 *
 * Both conditions lead with NOT EXISTS, so an RFQ with no technical evaluation
 * configured — the overwhelmingly common case — falls straight through and
 * every product stays awardable. That is the regression that matters most; it
 * is pinned by tests in BOTH suites that consume this service.
 *
 * IF YOU EDIT `vendorCondition` IN rfqModel.js, EDIT THIS TOO (and vice versa).
 * They are twins by design: the write gate must never diverge from what the
 * buyer's comparison screen lets them select.
 */

import db from '../config/dbConn.js';

/**
 * Thrown by assertVendorsTechnicallyQualified. Carries statusCode so that a
 * controller-level formatErrorResponse surfaces it as a 400 with the message
 * intact rather than a generic 500.
 */
export class TechnicalQualificationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TechnicalQualificationError';
    this.statusCode = 400;
    this.code = 'TECHNICAL_QUALIFICATION_BLOCKED';
    this.details = details;
  }
}

/** Disqualification reasons. Exported so callers can branch without regexing the message. */
export const TECH_QUALIFICATION_REASON = Object.freeze({
  CLEARED: 'CLEARED',
  PRODUCT_PENDING: 'PRODUCT_PENDING',
  PRODUCT_FAILED: 'PRODUCT_FAILED',
  RFQ_NOT_CLEARED: 'RFQ_NOT_CLEARED',
});

// The product line is addressed EITHER by its tbl_rfq_products.id ($5) — what
// the negotiation paths carry — OR by (product_variant_id, variant) ($2, $3) —
// what POST /rfq/finalize carries off the comparison sheet. One CTE resolves
// both so there is exactly one copy of the verdict SQL below it.
const VERDICT_SQL = `
  WITH rp AS (
    SELECT id
      FROM tbl_rfq_products
     WHERE rfq_id = $1
       AND (
         ($5::int IS NOT NULL AND id = $5::int)
         OR ($5::int IS NULL AND product_variant_id = $2::int AND variant = $3::int)
       )
     ORDER BY id
     LIMIT 1
  )
  SELECT
    EXISTS (
      SELECT 1 FROM tbl_rfq_product_tech_evaluation te WHERE te.rfq_id = $1
    ) AS rfq_has_tech,
    EXISTS (
      SELECT 1
        FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
        JOIN tbl_rfq_product_tech_evaluation te
          ON te.id = cv.tbl_rfq_product_tech_evaluation_id
       WHERE te.rfq_id = $1 AND cv.vendor_id = $4 AND cv.status = 1
    ) AS vendor_passed_any_product,
    EXISTS (
      SELECT 1 FROM tbl_rfq_product_tech_evaluation te
       WHERE te.tbl_rfq_product_id = (SELECT id FROM rp)
    ) AS product_has_tech,
    EXISTS (
      SELECT 1
        FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
        JOIN tbl_rfq_product_tech_evaluation te
          ON te.id = cv.tbl_rfq_product_tech_evaluation_id
       WHERE te.tbl_rfq_product_id = (SELECT id FROM rp)
         AND cv.vendor_id = $4 AND cv.status = 1
    ) AS vendor_passed_this_product,
    (
      SELECT cv.status
        FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
        JOIN tbl_rfq_product_tech_evaluation te
          ON te.id = cv.tbl_rfq_product_tech_evaluation_id
       WHERE te.tbl_rfq_product_id = (SELECT id FROM rp)
         AND cv.vendor_id = $4
       ORDER BY cv.id DESC LIMIT 1
    ) AS product_verdict_status,
    (
      SELECT cv.calculated_score
        FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
        JOIN tbl_rfq_product_tech_evaluation te
          ON te.id = cv.tbl_rfq_product_tech_evaluation_id
       WHERE te.tbl_rfq_product_id = (SELECT id FROM rp)
         AND cv.vendor_id = $4
       ORDER BY cv.id DESC LIMIT 1
    ) AS product_calculated_score,
    (
      SELECT te.minimum_passing_score
        FROM tbl_rfq_product_tech_evaluation te
       WHERE te.tbl_rfq_product_id = (SELECT id FROM rp)
       ORDER BY te.id DESC LIMIT 1
    ) AS product_minimum_passing_score`;

// The buyer reads these strings verbatim, and "failed" vs "not yet evaluated"
// call for completely different next actions (pick another vendor / re-float,
// versus finish the evaluation). Keep them distinct.
//
// `subject` is the sentence-initial noun phrase and `object` its mid-sentence
// form. Single-vendor callers leave them at the defaults and get exactly the
// wording POST /rfq/finalize has always emitted; multi-vendor callers pass a
// vendor label so each line names WHICH vendor was refused.
function verdictToDecision(v, subject = 'This vendor', object = 'this vendor') {
  const clearedAtRfqLevel = !v.rfq_has_tech || v.vendor_passed_any_product;
  const clearedAtProductLevel = !v.product_has_tech || v.vendor_passed_this_product;

  if (clearedAtRfqLevel && clearedAtProductLevel) {
    return { qualified: true, reason: TECH_QUALIFICATION_REASON.CLEARED, message: null, verdict: v };
  }

  if (v.product_has_tech && v.product_verdict_status === null) {
    return {
      qualified: false,
      reason: TECH_QUALIFICATION_REASON.PRODUCT_PENDING,
      message:
        `Technical evaluation for this product has not been completed for ${object}. ` +
        `Vendor finalization is restricted until a technical result is recorded.`,
      verdict: v,
    };
  }

  if (v.product_has_tech) {
    const score = v.product_calculated_score;
    const minScore = v.product_minimum_passing_score;
    const scoreDetail =
      score !== null && minScore !== null
        ? ` (scored ${Math.round(Number(score))} against a minimum of ${Number(minScore)})`
        : '';
    return {
      qualified: false,
      reason: TECH_QUALIFICATION_REASON.PRODUCT_FAILED,
      message:
        `${subject} failed the technical evaluation for this product${scoreDetail}. ` +
        `A technically disqualified vendor cannot be finalized.`,
      verdict: v,
    };
  }

  // Product-level evaluation absent, but the vendor cleared nothing anywhere in
  // an RFQ that does run technical evaluation.
  return {
    qualified: false,
    reason: TECH_QUALIFICATION_REASON.RFQ_NOT_CLEARED,
    message:
      `${subject} has not cleared the technical evaluation for this RFQ. ` +
      `Vendor finalization is restricted to technically qualified vendors.`,
    verdict: v,
  };
}

/**
 * Decide whether ONE vendor may be awarded ONE product line.
 *
 * Address the line either by rfq_product_id, or by (product_variant_id, variant)
 * — whichever the caller already holds. Both resolve to the same row.
 *
 * @param {Object}  target
 * @param {number}  target.rfq_id
 * @param {number}  target.vendor_id
 * @param {number} [target.rfq_product_id]      tbl_rfq_products.id
 * @param {number} [target.product_variant_id]  used only when rfq_product_id is absent
 * @param {number} [target.variant]             used only when rfq_product_id is absent
 * @param {string} [target.subject]             sentence-initial vendor label
 * @param {string} [target.object]              mid-sentence vendor label
 * @param {Object} [txContext]                  pg-promise task/transaction
 * @returns {Promise<{qualified:boolean, reason:string, message:?string, verdict:Object}>}
 */
export async function evaluateVendorTechnicalQualification(
  { rfq_id, vendor_id, rfq_product_id = null, product_variant_id = null, variant = null, subject, object },
  txContext = null
) {
  const t = txContext || db;
  const verdict = await t.one(VERDICT_SQL, [
    rfq_id,
    product_variant_id,
    variant,
    vendor_id,
    rfq_product_id,
  ]);
  return verdictToDecision(verdict, subject, object);
}

// "Vendor Alpha Vendor Pvt Ltd (ID 80101)" — the ID is what makes the refusal
// actionable when two vendors share a display name, so it is never dropped.
async function vendorLabels(vendorIds, t) {
  const rows = await t.any(
    `SELECT u.id,
            COALESCE(NULLIF(TRIM(c.company_name), ''), NULLIF(TRIM(u.name), '')) AS display_name
       FROM tbl_users u
       LEFT JOIN tbl_company c ON c.id = u.company_id
      WHERE u.id = ANY($1::int[])`,
    [vendorIds]
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r.display_name]));
  const label = (id) => {
    const name = byId.get(Number(id));
    return name ? `Vendor ${name} (ID ${id})` : `Vendor ID ${id}`;
  };
  return label;
}

/**
 * Screen a LIST of vendors against one product line, WITHOUT throwing.
 *
 * WHOLESALE, NOT FILTER-AND-CONTINUE. If any vendor in the list is
 * disqualified, the whole award is refused and nothing is written. Reasons:
 *
 *   1. These lists are approved as a UNIT. An approver signed off on
 *      "award A and B"; quietly awarding only A means the approval record no
 *      longer describes what happened, and nobody is told.
 *   2. Downstream metadata is built from the FULL list — the ARC approval
 *      instance names `selected_quotes[0]` as its primary vendor. Dropping a
 *      vendor mid-flight can leave an ARC pointing at a vendor that was never
 *      awarded.
 *   3. A silent partial write is not recoverable through the UI: the approval
 *      instance is already APPROVED, and submitQuotesForApproval refuses a
 *      second pending approval for the same product. A clean refusal leaves the
 *      buyer with an action they can actually take — resubmit without the
 *      disqualified vendor.
 *   4. It matches how these endpoints already behave: an unknown quote id, or a
 *      quote from a still-running round, rejects the entire request too.
 *
 * The message names EVERY refused vendor and the reason for each, because the
 * FE surfaces `message` verbatim.
 *
 * @returns {Promise<{ok:true}|{ok:false, message:string, disqualified:Array}>}
 */
export async function screenVendorsForTechnicalQualification(
  { rfq_id, rfq_product_id = null, product_variant_id = null, variant = null, vendor_ids = [] },
  txContext = null
) {
  const t = txContext || db;

  const ids = [...new Set((vendor_ids || []).map(Number).filter((n) => Number.isFinite(n)))];
  if (!rfq_id || ids.length === 0) return { ok: true };

  const label = await vendorLabels(ids, t);

  const disqualified = [];
  for (const vendorId of ids) {
    const decision = await evaluateVendorTechnicalQualification(
      {
        rfq_id,
        vendor_id: vendorId,
        rfq_product_id,
        product_variant_id,
        variant,
        subject: label(vendorId),
        object: label(vendorId),
      },
      t
    );
    if (!decision.qualified) {
      disqualified.push({ vendor_id: vendorId, reason: decision.reason, message: decision.message });
    }
  }

  if (disqualified.length === 0) return { ok: true };

  // When every selected vendor is disqualified, the per-vendor reasons say
  // everything and "no vendor was awarded" is self-evident. The wholesale rule
  // only needs explaining when it costs the buyer a vendor who WAS qualified —
  // otherwise they would reasonably assume the good vendor went through and
  // never resubmit them.
  const partial = disqualified.length < ids.length;
  const lead = partial
    ? 'No vendor was finalized for this product: the award is refused in full when any selected vendor is technically disqualified. '
    : '';
  const tail = partial
    ? ` Remove the disqualified vendor${disqualified.length > 1 ? 's' : ''} and resubmit the remaining quotes for approval.`
    : '';
  const message = lead + disqualified.map((d) => d.message).join(' ') + tail;

  return { ok: false, message, disqualified };
}

/**
 * Throwing form of screenVendorsForTechnicalQualification.
 *
 * This is the LAST LINE — it sits directly on top of the INSERT into
 * tbl_quote_finalization, so it fires for every caller including ones written
 * later. Callers that own an HTTP response should ALSO pre-flight with
 * screenVendorsForTechnicalQualification before any state is committed, so the
 * refusal is a clean 400 rather than a rolled-back transaction (and, at an
 * approval endpoint, so the approval action is never recorded for an award that
 * is then refused).
 */
export async function assertVendorsTechnicallyQualified(target, txContext = null) {
  const result = await screenVendorsForTechnicalQualification(target, txContext);
  if (!result.ok) {
    throw new TechnicalQualificationError(result.message, { disqualified: result.disqualified });
  }
}

export default {
  evaluateVendorTechnicalQualification,
  screenVendorsForTechnicalQualification,
  assertVendorsTechnicallyQualified,
  TechnicalQualificationError,
  TECH_QUALIFICATION_REASON,
};
