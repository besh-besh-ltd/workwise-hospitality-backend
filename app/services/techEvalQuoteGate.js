/**
 * Server-side gate: a vendor may not quote a product whose technical evaluation
 * clauses they have not answered.
 *
 * WHY THIS EXISTS. Technical evaluation was "mandatory" only in the browser.
 * Both vendor clients gate it — SendQuoteWizard via `evalGateOk`, the legacy
 * send-quote page via `hasPendingTechEval` — but both derive that gate from
 * `product.tech_evaluation_status`, and both FAIL OPEN when it is absent:
 *
 *     has_tech_eval: !!p.tech_evaluation_status?.has_tech_eval   // undefined -> false
 *     const ts = techEvalStatuses[p.id]; return ts && ts.has_tech_eval && ...
 *
 * With the flag missing the wizard drops the Technical evaluation step from
 * `visibleSteps` entirely and `evalGateOk` returns true, while the legacy page
 * simply enables Send. Neither asks the server.
 *
 * And the server did not ask either. The only technical check on quote
 * submission lived inside `if (isReverseAuction && ...)` in createQuote, so it
 * ran for 52 reverse-auction RFQs and skipped the other 623. `updateQuoteItems`
 * had no technical check at all.
 *
 * Observed on RFQ 536289 (reverse_auction = 0): six products each carrying one
 * clause, 31 vendors invited, one vendor quoted all six TE-bearing lines on
 * 8 Aug — inside the bid window, ten days after the clauses were created — and
 * answered none. The buyer's Technical Evaluation screen was then correctly
 * blank, because there was nothing to score, and the RFQ could not proceed.
 *
 * NOT THE SAME RULE as technicalQualificationService. That service asks whether
 * a vendor has *cleared* evaluation, and gates award/finalization. This asks the
 * earlier question — has the vendor *answered* — and gates quoting. A vendor
 * quoting has not been evaluated yet, so acceptance status cannot be required
 * here; that is why the reverse-auction check (`status !== 1`) could not simply
 * be reused for ordinary RFQs.
 *
 * `sampling` clauses are excluded, matching every other count in the codebase
 * (rfqModel's tech_evaluation_status CTEs and the clients' own totals).
 */
import db from '../config/dbConn.js';

// A line carrying no price, no comment and no attachment is not being quoted —
// it goes out as a skipped line. Mirrors the same skip in updateQuoteItems, so
// a vendor is never blocked by a line they are not actually submitting.
const isMeaningful = (p) =>
  (p?.comment != null && String(p.comment).trim() !== '') ||
  (Array.isArray(p?.document_files) && p.document_files.length > 0) ||
  (p?.unit_price !== '' && p?.unit_price != null && Number(p.unit_price) > 0);

const UNANSWERED_SQL = `
  SELECT rp.id AS rfq_product_id,
         COALESCE(NULLIF(TRIM(pv.name), ''), 'Product ' || rp.id) AS product_name,
         COUNT(DISTINCT c.id)::int AS clauses,
         COUNT(DISTINCT vr.tbl_rfq_product_tech_evaluation_clauses_id)::int AS answered
    FROM tbl_rfq_products rp
    JOIN tbl_rfq_product_tech_evaluation TE ON TE.tbl_rfq_product_id = rp.id
    JOIN tbl_rfq_product_tech_evaluation_clauses c
         ON c.tbl_rfq_product_tech_evaluation_id = TE.id
        AND (c.clause_type <> 'sampling' OR c.clause_type IS NULL)
    LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
    LEFT JOIN tbl_rfq_product_tech_evaluation_vendors_response vr
         ON vr.tbl_rfq_product_tech_evaluation_clauses_id = c.id
        AND vr.vendor_id = $2
        AND COALESCE(TRIM(vr.vendor_response), '') NOT IN ('', 'N/A')
   WHERE rp.rfq_id = $1
     AND (rp.product_variant_id, rp.variant) IN
         (SELECT (x->>'pv')::int, (x->>'v')::int FROM jsonb_array_elements($3::jsonb) x)
   GROUP BY rp.id, pv.name
  HAVING COUNT(DISTINCT vr.tbl_rfq_product_tech_evaluation_clauses_id) < COUNT(DISTINCT c.id)
   ORDER BY product_name`;

/**
 * @returns {Promise<Array<{rfq_product_id:number, product_name:string, clauses:number, answered:number}>>}
 *          One entry per line being quoted that still has unanswered clauses.
 *          Empty when the vendor is clear, or when no quoted line has an
 *          evaluation at all.
 */
export async function findUnansweredTechEvalLines(
  { rfq_id, vendor_id, products },
  txContext = null
) {
  const t = txContext || db;
  // `> 0`, not just isFinite: Number(null) and Number('') are both 0, so an
  // absent id would otherwise sail through and query for rfq 0 / vendor 0.
  const rfqId = Number(rfq_id);
  const vendorId = Number(vendor_id);
  if (!(rfqId > 0) || !(vendorId > 0)) return [];

  const keys = (Array.isArray(products) ? products : [])
    .filter((p) => p && p.product_id != null && isMeaningful(p))
    .map((p) => ({ pv: Number(p.product_id), v: Number(p.variant ?? 0) }))
    .filter((k) => Number.isFinite(k.pv) && Number.isFinite(k.v));
  if (keys.length === 0) return [];

  return t.any(UNANSWERED_SQL, [rfqId, vendorId, JSON.stringify(keys)]);
}

/** Names every offending product — the FE surfaces `message` verbatim. */
export function unansweredTechEvalMessage(rows) {
  const names = rows.map((r) => `${r.product_name} (${r.answered}/${r.clauses} answered)`);
  return (
    'Technical evaluation must be completed before you can submit a quote for ' +
    `${rows.length === 1 ? 'this product' : 'these products'}: ${names.join(', ')}.`
  );
}

export default { findUnansweredTechEvalLines, unansweredTechEvalMessage };
