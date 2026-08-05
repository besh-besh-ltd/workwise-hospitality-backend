import db from '../../config/dbConn.js';

/**
 * ARC v2 — Amendment model.
 *
 * Persists vendor- or buyer-initiated time-bounded amendments per plan §4.7.
 * `payload` JSONB carries every type-specific field so the schema stays a
 * single table; the controller validates the shape per type.
 */
const arcAmendmentModel = {
  /**
   * Vendor-safe projection. The approval_chain JSONB and edit-history rows
   * carry buyer approver identities (names + user ids) which must never
   * leave the tenant boundary — vendors only see numbered levels.
   * Pure function (no DB): both vendor endpoints funnel through it.
   */
  vendorView: (am) => {
    const chain = Array.isArray(am.approval_chain) ? am.approval_chain : [];
    const levelOf = (userId) => {
      const idx = chain.findIndex(
        (s) => Array.isArray(s.approver_user_ids) && s.approver_user_ids.map(Number).includes(Number(userId))
      );
      return idx >= 0 ? idx + 1 : null;
    };
    // eslint-disable-next-line no-unused-vars
    const { approval_chain, requested_by, decided_by, ...rest } = am;
    return {
      ...rest,
      total_steps: chain.length,
      chain: chain.map((s, i) => ({
        level: i + 1,
        status: s.status || 'pending',
        decided_at: s.decided_at || null,
        comment: s.comment || null,
      })),
      edit_history: (Array.isArray(am.edit_history) ? am.edit_history : []).map((e) => ({
        field_changed: e.field_changed,
        before_value: e.before_value,
        after_value: e.after_value,
        changed_at: e.changed_at,
        comment: e.comment || null,
        level: levelOf(e.changed_by),
      })),
    };
  },

  createRequest: async (data, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO public.tbl_arc_amendment
         (arc_contract_id, amendment_type, amendment_from, amendment_to,
          status, reason, payload, requested_by,
          approval_chain, current_step)
       VALUES ($1, $2, $3, $4, 'requested', $5, $6::jsonb, $7,
               $8::jsonb, 1)
       RETURNING *`,
      [
        data.arc_contract_id,
        data.amendment_type,
        data.amendment_from,
        data.amendment_to || null,
        data.reason,
        JSON.stringify(data.payload || {}),
        data.requested_by,
        JSON.stringify(data.approval_chain || []),
      ]
    );
  },

  // buildApprovalChain + applyDecision were the snapshot-only path. Both
  // were removed when the controller pivoted to use the central engine —
  // generalModel.createApprovalInstance and submitApprovalAction now own
  // chain construction and decision recording. The approval_chain JSONB
  // on the row is a render cache refreshed by refreshChainCache() in
  // the controller after every engine touch.

  // ============================================================
  // Edit history — buyer counter-offers (edit-then-approve)
  // ============================================================

  /**
   * Record per-field diffs for an edit-then-approve. `edits` is
   * [{ field_changed, before_value, after_value }]. Comment applies to
   * the whole batch (one buyer action).
   */
  recordEdits: async (amendmentId, edits, { changed_by, comment = null }, txContext = null) => {
    const runner = txContext || db;
    const rows = [];
    for (const e of edits) {
      rows.push(await runner.one(
        `INSERT INTO public.tbl_arc_amendment_edit_history
           (arc_amendment_id, field_changed, before_value, after_value, changed_by, comment)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
         RETURNING *`,
        [
          amendmentId,
          e.field_changed,
          JSON.stringify(e.before_value ?? null),
          JSON.stringify(e.after_value ?? null),
          changed_by,
          comment,
        ]
      ));
    }
    return rows;
  },

  listEdits: async (amendmentId, txContext = null) => {
    return (txContext || db).any(
      `SELECT eh.*, u.name AS changed_by_name
         FROM public.tbl_arc_amendment_edit_history eh
         LEFT JOIN public.tbl_users u ON u.id = eh.changed_by
        WHERE eh.arc_amendment_id = $1
        ORDER BY eh.changed_at DESC, eh.id DESC`,
      [amendmentId]
    );
  },

  // Lists every amendment for any contract under an ARC. The active page
  // surfaces these in the "Amendments" aside card and the audit trail.
  listForArc: async (arcId, txContext = null) => {
    return (txContext || db).any(
      `SELECT am.*,
              c.vendor_id,
              u.name AS requested_by_name,
              v.name AS vendor_name
         FROM public.tbl_arc_amendment am
         JOIN public.tbl_arc_contract  c ON c.id = am.arc_contract_id
         LEFT JOIN public.tbl_users u ON u.id = am.requested_by
         LEFT JOIN public.tbl_users v ON v.id = c.vendor_id
        WHERE c.arc_id = $1
        ORDER BY am.created_at DESC`,
      [arcId]
    );
  },

  // Every amendment across all of a vendor's contracts — powers the vendor
  // "My Amendments" page. Joined with contract/ARC/BU context so the page
  // can search + filter client-side without N detail fetches.
  listForVendor: async (vendorId, txContext = null) => {
    return (txContext || db).any(
      `SELECT am.*,
              c.arc_id,
              c.status            AS contract_status,
              a.arc_number,
              a.title             AS arc_title,
              a.hotel_id,
              a.category_id,
              a.contract_start_at,
              a.contract_end_at,
              cat.title           AS category_title,
              h.name              AS hotel_name,
              ub.name             AS buyer_name,
              ad.id               AS addendum_id,
              ad.status           AS addendum_status,
              ad.addendum_number,
              ad.document_s3_url  AS addendum_url
         FROM public.tbl_arc_amendment am
         JOIN public.tbl_arc_contract c ON c.id = am.arc_contract_id
         JOIN public.tbl_arc a          ON a.id = c.arc_id
         LEFT JOIN public.tbl_arc_amendment_document ad ON ad.arc_amendment_id = am.id
         LEFT JOIN public.tbl_category cat ON cat.id = a.category_id
         LEFT JOIN public.tbl_hospitality_company_hotels h ON h.id = a.hotel_id
         LEFT JOIN public.tbl_users ub ON ub.id = a.created_by
        WHERE c.vendor_id = $1
        ORDER BY am.created_at DESC, am.id DESC`,
      [vendorId]
    );
  },

  listForContract: async (arcContractId, txContext = null) => {
    return (txContext || db).any(
      `SELECT * FROM public.tbl_arc_amendment
        WHERE arc_contract_id = $1
        ORDER BY created_at DESC`,
      [arcContractId]
    );
  },

  getById: async (id, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT * FROM public.tbl_arc_amendment WHERE id = $1`,
      [id]
    );
  },

  /**
   * One-in-flight guard. While an amendment is requested / approved /
   * awaiting_signature / live:
   *   - no second amendment may target the SAME contract line, regardless
   *     of effective window;
   *   - no second TERM extension may be raised while one is in flight.
   * Scopes are independent — a pending term extension does not block item
   * amendments, and vice versa. Returns the conflicting row or null.
   */
  findInFlightConflict: async ({ arc_contract_id, amendment_type, arc_contract_line_id, product_variant_id }, txContext = null) => {
    const runner = txContext || db;
    if (amendment_type === 'term') {
      return runner.oneOrNone(
        `SELECT id, amendment_type, amendment_from, amendment_to, status
           FROM public.tbl_arc_amendment
          WHERE arc_contract_id = $1
            AND amendment_type = 'term'
            AND status IN ('requested','approved','awaiting_signature','live')
          ORDER BY created_at DESC
          LIMIT 1`,
        [arc_contract_id]
      );
    }
    if (amendment_type === 'item_add') {
      return runner.oneOrNone(
        `SELECT id, amendment_type, amendment_from, amendment_to, status
           FROM public.tbl_arc_amendment
          WHERE arc_contract_id = $1
            AND amendment_type = 'item_add'
            AND status IN ('requested','approved','awaiting_signature','live')
            AND (payload->>'product_variant_id')::bigint = $2::bigint
          ORDER BY created_at DESC
          LIMIT 1`,
        [arc_contract_id, product_variant_id]
      );
    }
    // price / qty / item_remove — anything in flight on the same line blocks.
    return runner.oneOrNone(
      `SELECT id, amendment_type, amendment_from, amendment_to, status
         FROM public.tbl_arc_amendment
        WHERE arc_contract_id = $1
          AND status IN ('requested','approved','awaiting_signature','live')
          AND (payload->>'arc_contract_line_id')::bigint = $2::bigint
        ORDER BY created_at DESC
        LIMIT 1`,
      [arc_contract_id, arc_contract_line_id]
    );
  },

  setStatus: async (id, status, extras = {}, txContext = null) => {
    const runner = txContext || db;
    const sets = ['status = $1', 'updated_at = CURRENT_TIMESTAMP'];
    const args = [status];
    let p = 2;
    if (extras.approval_instance_id !== undefined) { sets.push(`approval_instance_id = $${p++}`); args.push(extras.approval_instance_id); }
    if (extras.decided_by !== undefined)           { sets.push(`decided_by = $${p++}`); args.push(extras.decided_by); }
    if (extras.decided_at !== undefined)           { sets.push(`decided_at = $${p++}`); args.push(extras.decided_at); }
    args.push(id);
    return runner.oneOrNone(
      `UPDATE public.tbl_arc_amendment SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      args
    );
  },
};

export default arcAmendmentModel;
