import db from '../../config/dbConn.js';
import crypto from 'crypto';

/**
 * ARC v2 — Contract + OTP signature model.
 *
 * One contract per (arc_id, vendor_id) — multiple per ARC for split-vendor
 * awards. Lines carry the originally-awarded values + consumed_qty maintained
 * by callOffPoService.releaseForMr.
 */
const arcContractModel = {
  createContract: async (data, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_contract
         (arc_id, vendor_id, document_s3_url, status, awaiting_until)
       VALUES ($1, $2, $3, 'awaiting_acceptance', $4)
       ON CONFLICT (arc_id, vendor_id) DO UPDATE
         SET document_s3_url = EXCLUDED.document_s3_url,
             status          = EXCLUDED.status,
             awaiting_until  = EXCLUDED.awaiting_until,
             updated_at      = CURRENT_TIMESTAMP
       RETURNING *`,
      [data.arc_id, data.vendor_id, data.document_s3_url || null, data.awaiting_until || null]
    );
  },

  addLine: async (arcContractId, line, txContext = null) => {
    return (txContext || db).one(
      `INSERT INTO tbl_arc_contract_line
         (arc_contract_id, arc_item_id, unit_rate, gst_pct, charges,
          payment_terms, delivery_terms, committed_qty, awarded_quote_snapshot)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb)
       RETURNING *`,
      [arcContractId, line.arc_item_id, line.unit_rate, line.gst_pct ?? null,
       JSON.stringify(line.charges || []),
       line.payment_terms || null, line.delivery_terms || null,
       line.committed_qty, JSON.stringify(line.awarded_quote_snapshot || {})]
    );
  },

  getById: async (id, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT c.*, u.name AS vendor_name, u.email AS vendor_email, a.arc_number, a.title AS arc_title
         FROM tbl_arc_contract c
         LEFT JOIN tbl_users u ON u.id = c.vendor_id
         LEFT JOIN tbl_arc a   ON a.id = c.arc_id
        WHERE c.id = $1`,
      [id]
    );
  },

  listForArc: async (arcId, txContext = null) => {
    return (txContext || db).any(
      `SELECT c.*, u.name AS vendor_name, u.email AS vendor_email
         FROM tbl_arc_contract c
         LEFT JOIN tbl_users u ON u.id = c.vendor_id
        WHERE c.arc_id = $1
        ORDER BY c.id`,
      [arcId]
    );
  },

  listForVendor: async (vendorId, statusFilter = null, txContext = null) => {
    const args = [vendorId];
    const where = ['c.vendor_id = $1'];
    if (statusFilter && statusFilter.length > 0) {
      where.push(`c.status = ANY($2::varchar[])`);
      args.push(statusFilter);
    }
    return (txContext || db).any(
      `SELECT c.*, a.arc_number, a.title AS arc_title, a.contract_start_at, a.contract_end_at,
              a.hotel_id, a.category_id,
              cat.title AS category_title,
              h.name AS hotel_name,
              ub.name AS buyer_name,
              COALESCE(line_agg.committed_value, 0)::numeric AS committed_value,
              COALESCE(line_agg.consumed_value, 0)::numeric  AS consumed_value,
              COALESCE(co_agg.call_off_count, 0)::int        AS call_off_count,
              co_agg.last_call_off_number,
              co_agg.last_call_off_at
         FROM tbl_arc_contract c
         JOIN tbl_arc a ON a.id = c.arc_id
         LEFT JOIN tbl_category cat ON cat.id = a.category_id
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
         LEFT JOIN tbl_users ub ON ub.id = a.created_by
         LEFT JOIN LATERAL (
           SELECT SUM(cl.unit_rate * cl.committed_qty) AS committed_value,
                  SUM(cl.unit_rate * cl.consumed_qty)  AS consumed_value
             FROM tbl_arc_contract_line cl
            WHERE cl.arc_contract_id = c.id
         ) line_agg ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS call_off_count,
                  MAX(po.po_number) FILTER (WHERE cp.released_at = latest.max_at) AS last_call_off_number,
                  latest.max_at AS last_call_off_at
             FROM tbl_arc_callof_po cp
             LEFT JOIN tbl_rfq_purchase_order po ON po.id = cp.po_id
            CROSS JOIN (
              SELECT MAX(released_at) AS max_at
                FROM tbl_arc_callof_po
               WHERE arc_contract_id = c.id
            ) latest
            WHERE cp.arc_contract_id = c.id
            GROUP BY latest.max_at
         ) co_agg ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY c.created_at DESC`,
      args
    );
  },

  listLines: async (arcContractId, txContext = null) => {
    return (txContext || db).any(
      `SELECT cl.*, ai.product_variant_id, pv.name AS variant_name, pv.slug AS variant_slug
         FROM tbl_arc_contract_line cl
         LEFT JOIN tbl_arc_item ai ON ai.id = cl.arc_item_id
         LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
        WHERE cl.arc_contract_id = $1
        ORDER BY cl.id`,
      [arcContractId]
    );
  },

  setStatus: async (id, status, extras = {}, txContext = null) => {
    const runner = txContext || db;
    const sets = ['status = $1', 'updated_at = CURRENT_TIMESTAMP'];
    const args = [status];
    let p = 2;
    if (extras.document_hash) { sets.push(`document_hash = $${p++}`); args.push(extras.document_hash); }
    if (extras.signed_by_vendor_at) { sets.push(`signed_by_vendor_at = $${p++}`); args.push(extras.signed_by_vendor_at); }
    if (extras.terminated_at) { sets.push(`terminated_at = $${p++}`); args.push(extras.terminated_at); }
    if (extras.terminated_reason) { sets.push(`terminated_reason = $${p++}`); args.push(extras.terminated_reason); }
    args.push(id);
    return runner.oneOrNone(
      `UPDATE tbl_arc_contract SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      args
    );
  },

  // ============================================================
  // OTP signature
  // ============================================================

  createOtp: async (arcContractId, vendorUserId, { ttlSeconds = 600 } = {}, txContext = null) => {
    const runner = txContext || db;
    const code = (Math.floor(Math.random() * 900000) + 100000).toString();
    const otpHash = crypto.createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await runner.none(
      `INSERT INTO tbl_arc_contract_signature_otp
         (arc_contract_id, vendor_user_id, otp_hash, expires_at, attempts)
       VALUES ($1, $2, $3, $4, 0)`,
      [arcContractId, vendorUserId, otpHash, expiresAt]
    );
    return { code, expiresAt };
  },

  verifyOtp: async (arcContractId, vendorUserId, code, { maxAttempts = 5 } = {}, txContext = null) => {
    const runner = txContext || db;
    const candidate = await runner.oneOrNone(
      `SELECT * FROM tbl_arc_contract_signature_otp
        WHERE arc_contract_id = $1 AND vendor_user_id = $2 AND verified_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [arcContractId, vendorUserId]
    );
    if (!candidate) return { ok: false, reason: 'no_otp' };
    if (candidate.attempts >= maxAttempts) return { ok: false, reason: 'too_many_attempts' };
    if (new Date(candidate.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    if (hash !== candidate.otp_hash) {
      await runner.none(
        `UPDATE tbl_arc_contract_signature_otp SET attempts = attempts + 1 WHERE id = $1`,
        [candidate.id]
      );
      return { ok: false, reason: 'mismatch' };
    }
    await runner.none(
      `UPDATE tbl_arc_contract_signature_otp SET verified_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [candidate.id]
    );
    return { ok: true };
  },

  // ============================================================
  // Consumption rollup (for active-contract dashboard)
  // ============================================================

  consumptionForContract: async (arcContractId, txContext = null) => {
    return (txContext || db).any(
      `SELECT cl.id              AS arc_contract_line_id,
              cl.arc_item_id,
              ai.product_variant_id,
              pv.name             AS variant_name,
              pv.slug             AS variant_slug,
              ai.uom,
              ai.spec_text,
              ai.target_price,
              ai.indicative_qty,
              cl.unit_rate,
              cl.gst_pct,
              cl.charges,
              cl.payment_terms,
              cl.delivery_terms,
              cl.committed_qty,
              cl.consumed_qty,
              (cl.committed_qty - cl.consumed_qty) AS remaining_qty,
              CASE WHEN cl.committed_qty = 0 THEN 0
                   ELSE ROUND((cl.consumed_qty / cl.committed_qty) * 100, 2)
              END AS pct_used,
              cl.awarded_quote_snapshot,
              subc.title AS sub_category_title
         FROM tbl_arc_contract_line cl
         LEFT JOIN tbl_arc_item ai ON ai.id = cl.arc_item_id
         LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
         LEFT JOIN tbl_arc_contract c ON c.id = cl.arc_contract_id
         LEFT JOIN tbl_arc a ON a.id = c.arc_id
         LEFT JOIN LATERAL (
           SELECT cat.title
             FROM tbl_product_categories pc
             JOIN tbl_category cat ON cat.id = pc.category_id
            WHERE pc.product_id = pv.product_id
              AND a.sub_category_ids @> to_jsonb(pc.category_id)
            ORDER BY cat.title
            LIMIT 1
         ) subc ON TRUE
        WHERE cl.arc_contract_id = $1
        ORDER BY cl.id`,
      [arcContractId]
    );
  },
};

export default arcContractModel;
