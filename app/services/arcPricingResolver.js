import db from '../config/dbConn.js';

/**
 * ARC Pricing Resolver
 *
 * Single source of truth for "what is the current effective price for this
 * contract line on this date?" — used by every call-off PO release so the
 * pricing is consistent and amendment-aware.
 *
 * Behaviour:
 *   1. Look up any tbl_arc_amendment row with status IN ('approved','live')
 *      whose [amendment_from, amendment_to] window covers `asOfDate` and
 *      whose payload targets the requested contract line.
 *   2. If found, return the amended values + applied_amendment_id
 *      (price → unit_rate overlay, qty → committed_qty_effective overlay).
 *   3. Otherwise return the original line values.
 *
 * Returned shape:
 *   {
 *     unit_rate:           NUMERIC,
 *     gst_pct:             NUMERIC,
 *     charges:             JSONB,
 *     payment_terms:       VARCHAR,
 *     delivery_terms:      VARCHAR,
 *     applied_amendment_id: BIGINT | null,
 *     contract_line: { ... }  // full original row for caller introspection
 *   }
 *
 * The function is read-only — it never mutates contract or amendment rows.
 */
export async function resolveCurrentPrice(arcContractLineId, asOfDate = null, txContext = null) {
  if (!arcContractLineId) {
    throw new Error('resolveCurrentPrice: arcContractLineId is required');
  }
  const runner = txContext || db;
  const line = await runner.oneOrNone(
    `SELECT cl.*, c.status AS contract_status, c.arc_id, c.vendor_id
       FROM tbl_arc_contract_line cl
       JOIN tbl_arc_contract c ON c.id = cl.arc_contract_id
      WHERE cl.id = $1`,
    [arcContractLineId]
  );
  if (!line) {
    throw new Error(`resolveCurrentPrice: contract line ${arcContractLineId} not found`);
  }

  // Amendment overlay (Phase C). Window-driven, not status-flip-driven:
  // an 'approved' amendment whose window covers asOfDate is just as
  // effective as a 'live' one — the lifecycle cron's approved→live flip is
  // bookkeeping for display, never a pricing gate. The overlapping-window
  // guard at request time guarantees at most one in-flight amendment per
  // (contract line × date), so LIMIT 1 is exact, not heuristic.
  const effectiveAt = asOfDate || new Date();
  // Local-calendar day — toISOString() would shift the day for TZs east of
  // UTC, mispricing the window boundary days.
  const d = effectiveAt instanceof Date ? effectiveAt : new Date(effectiveAt);
  const effectiveDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const overlay = await runner.oneOrNone(
    `SELECT am.id, am.amendment_type, am.payload
       FROM tbl_arc_amendment am
      WHERE am.arc_contract_id = $1
        AND am.status IN ('approved', 'live')
        AND am.amendment_type IN ('price', 'qty')
        AND (am.payload->>'arc_contract_line_id')::bigint = $2
        AND am.amendment_from <= $3::date
        AND (am.amendment_to IS NULL OR am.amendment_to >= $3::date)
      ORDER BY am.amendment_from DESC, am.id DESC
      LIMIT 1`,
    [line.arc_contract_id, line.id, effectiveDay]
  );

  const amendedRate = overlay?.amendment_type === 'price' && Number(overlay.payload?.new_rate) > 0
    ? Number(overlay.payload.new_rate)
    : null;
  const amendedQty = overlay?.amendment_type === 'qty' && Number(overlay.payload?.new_qty) > 0
    ? Number(overlay.payload.new_qty)
    : null;

  return {
    unit_rate:           amendedRate ?? line.unit_rate,
    gst_pct:             line.gst_pct,
    charges:             line.charges,
    payment_terms:       line.payment_terms,
    delivery_terms:      line.delivery_terms,
    // Effective committed quantity — qty amendments overlay the cap during
    // their window; callers checking remaining headroom should use this.
    committed_qty_effective: amendedQty ?? line.committed_qty,
    applied_amendment_id: overlay?.id ?? null,
    contract_line:       line,
  };
}
