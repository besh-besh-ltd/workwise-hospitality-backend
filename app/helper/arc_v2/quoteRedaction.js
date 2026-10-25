// Commercial-side redaction of ARC quote lines the technical committee ruled
// out. Their commercial terms must never reach a buyer's browser: pricing is
// stripped server-side and the line is kept as a marker so a matrix can show a
// locked cell.
//
// A line is ruled out when its item carries technical clauses and the vendor is
// not on that item's qualified list, or when the vendor failed the ARC-wide
// (universal) clauses — which applies to clause-less items too, and which
// `qualifiedByItem` cannot express because it omits those items entirely.
//
// Shared by the commercial evaluation read and the negotiation approval bundle.

/**
 * @param {object[]} quotes            arcEvalModel.listAllQuotesForArc rows
 * @param {object}   qualifiedByItem   arcEvalModel.qualifiedVendorsByItem map
 * @param {Set<number>} universallyFailed arcEvalModel.universallyFailedVendorIds
 */
export function redactDisqualifiedQuotes(quotes, qualifiedByItem, universallyFailed) {
  return (quotes || []).map((q) => {
    const allowed = qualifiedByItem[Number(q.arc_item_id)];
    const itemDisq = allowed && !allowed.includes(Number(q.vendor_id));
    const univDisq = universallyFailed.has(Number(q.vendor_id));
    if (itemDisq || univDisq) {
      return {
        quote_id: q.quote_id, vendor_id: q.vendor_id, vendor_name: q.vendor_name,
        submitted_at: q.submitted_at, quote_line_id: q.quote_line_id, arc_item_id: q.arc_item_id,
        rate: null, gst_pct: null, charges: null, lead_time_days: null, moq: null,
        // Phase 2 — null out engine output for technically-disqualified vendors
        // so the commercial evaluator never sees their pricing.
        line_pricing: null,
        technically_disqualified: true,
        // Distinct marker so the FE can label the ARC-wide reason.
        ...(univDisq ? { universally_disqualified: true } : {}),
      };
    }
    return q;
  });
}

export default { redactDisqualifiedQuotes };
