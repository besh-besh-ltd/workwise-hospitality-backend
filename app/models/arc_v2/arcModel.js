import db from '../../config/dbConn.js';
import { logger } from '../../util/logger.js';

/**
 * ARC v2 — Core model
 *
 * Database access layer for tbl_arc and its directly-owned tables:
 * tbl_arc_item, tbl_arc_invitation, tbl_arc_item_history_snapshot.
 * Tech-eval and comm-eval models live in arcEvaluationModel.js; contract
 * model in arcContractModel.js; MR model under app/models/mr/.
 *
 * Pattern follows the existing codebase: pg-promise via `db`, every function
 * accepts an optional txContext so it composes into transactions.
 */
const arcModel = {
  // ============================================================
  // ARC root
  // ============================================================

  /**
   * Create a draft ARC. Most fields are nullable so the wizard can save
   * partially-complete state; arcController.publish() enforces full-fill
   * before flipping status to 'floated'.
   */
  createDraft: async (data, txContext = null) => {
    const runner = txContext || db;
    const {
      arc_number,
      title,
      description = null,
      category_id,
      sub_category_ids = [],
      hospitality_company_id,
      hotel_id,
      department_id,
      process_id,
      submission_start_at = null,
      submission_end_at = null,
      contract_start_at = null,
      contract_end_at = null,
      technical_response_required = false,
      sample_required = false,
      eligibility_type = 'open',
      escalation_clause_json = {},
      payment_terms_expected = null,
      delivery_expected = null,
      penalty_clause = null,
      created_by,
    } = data;
    return runner.one(
      `INSERT INTO tbl_arc
         (arc_number, title, description, category_id, sub_category_ids,
          hospitality_company_id, hotel_id, department_id, process_id,
          status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          technical_response_required, sample_required, eligibility_type,
          escalation_clause_json, payment_terms_expected, delivery_expected, penalty_clause,
          created_by)
       VALUES
         ($1, $2, $3, $4, $5::jsonb,
          $6, $7, $8, $9,
          'draft',
          $10, $11, $12, $13,
          $14, $15, $16,
          $17::jsonb, $18, $19, $20,
          $21)
       RETURNING *`,
      [
        arc_number, title, description, category_id, JSON.stringify(sub_category_ids),
        hospitality_company_id, hotel_id, department_id, process_id,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at,
        technical_response_required, sample_required, eligibility_type,
        JSON.stringify(escalation_clause_json || {}), payment_terms_expected, delivery_expected, penalty_clause,
        created_by,
      ]
    );
  },

  updateDraft: async (id, patch, txContext = null) => {
    const runner = txContext || db;
    // Only allow these fields to be patched on draft.
    const allowed = [
      'title','description','category_id','sub_category_ids','department_id','process_id',
      'submission_start_at','submission_end_at','contract_start_at','contract_end_at',
      'technical_response_required','sample_required','eligibility_type',
      'escalation_clause_json','payment_terms_expected','delivery_expected','penalty_clause',
    ];
    const setParts = [];
    const values = [];
    let p = 1;
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        const v = patch[key];
        if (key === 'sub_category_ids' || key === 'escalation_clause_json') {
          setParts.push(`${key} = $${p++}::jsonb`);
          values.push(JSON.stringify(v ?? (key === 'sub_category_ids' ? [] : {})));
        } else {
          setParts.push(`${key} = $${p++}`);
          values.push(v);
        }
      }
    }
    if (setParts.length === 0) {
      return runner.oneOrNone(`SELECT * FROM tbl_arc WHERE id = $1`, [id]);
    }
    setParts.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    return runner.one(
      `UPDATE tbl_arc SET ${setParts.join(', ')}
        WHERE id = $${p} AND status = 'draft'
       RETURNING *`,
      values
    );
  },

  setStatus: async (id, status, extras = {}, txContext = null) => {
    const runner = txContext || db;
    const cols = ['status = $1', 'updated_at = CURRENT_TIMESTAMP'];
    const args = [status];
    let p = 2;
    if (extras.closed_reason !== undefined) { cols.push(`closed_reason = $${p++}`); args.push(extras.closed_reason); }
    args.push(id);
    return runner.oneOrNone(
      `UPDATE tbl_arc SET ${cols.join(', ')} WHERE id = $${p} RETURNING *`,
      args
    );
  },

  getById: async (id, txContext = null) => {
    return (txContext || db).oneOrNone(`SELECT * FROM tbl_arc WHERE id = $1`, [id]);
  },

  getByNumber: async (arcNumber, txContext = null) => {
    return (txContext || db).oneOrNone(`SELECT * FROM tbl_arc WHERE arc_number = $1`, [arcNumber]);
  },

  /**
   * List ARCs with optional status-group filter, scoped by hospitality_company
   * + (optional hotel_ids / department_ids).
   *
   * statusGroup values map to the lifecycle buckets surfaced by the sidebar
   * (plan §6.4): drafts, ongoing, approved, active, ended, all.
   */
  list: async ({
    hospitality_company_id,
    hotel_ids = null,
    department_ids = null,
    statusGroup = 'all',
    page = 1,
    limit = 20,
  }, txContext = null) => {
    const runner = txContext || db;
    // tbl_hospitality_company_hotels (joined as `h` below) also has a
    // `hospitality_company_id` column; alias every filter column to `a.`
    // so Postgres doesn't error with "column reference is ambiguous".
    const conditions = ['a.hospitality_company_id = $1'];
    const args = [hospitality_company_id];
    let p = 2;
    if (Array.isArray(hotel_ids) && hotel_ids.length > 0) {
      conditions.push(`a.hotel_id = ANY($${p++}::int[])`);
      args.push(hotel_ids);
    }
    if (Array.isArray(department_ids) && department_ids.length > 0) {
      conditions.push(`a.department_id = ANY($${p++}::int[])`);
      args.push(department_ids);
    }
    const statusSets = STATUS_GROUPS[statusGroup] || null;
    if (statusSets) {
      conditions.push(`a.status = ANY($${p++}::varchar[])`);
      args.push(statusSets);
    }
    args.push(limit);
    args.push((page - 1) * limit);
    const where = `WHERE ${conditions.join(' AND ')}`;
    const [rows, count] = await Promise.all([
      runner.any(
        `SELECT a.id, a.arc_number, a.title, a.status, a.category_id, a.hotel_id,
                a.department_id, a.submission_start_at, a.submission_end_at,
                a.contract_start_at, a.contract_end_at, a.created_at, a.updated_at,
                a.created_by, u.name AS created_by_name,
                cat.title AS category_title,
                h.name AS hotel_name, h.city AS hotel_city,
                d.title AS department_title,
                COALESCE(item_agg.item_count, 0)::int AS item_count,
                COALESCE(item_agg.item_names, '[]'::json) AS item_names,
                COALESCE(item_agg.product_variant_ids, '[]'::json) AS product_variant_ids,
                COALESCE(inv_agg.invited_count, 0)::int AS invited_count,
                COALESCE(inv_agg.submitted_count, 0)::int AS submitted_count,
                COALESCE(award_agg.awarded_vendor_names, '[]'::json) AS awarded_vendor_names,
                COALESCE(award_agg.awarded_vendor_ids, '[]'::json) AS awarded_vendor_ids,
                COALESCE(line_agg.total_committed_value, 0)::numeric AS committed_value,
                COALESCE(line_agg.total_consumed_value, 0)::numeric AS consumed_value,
                COALESCE(co_agg.call_off_count, 0)::int AS call_off_count,
                COALESCE(amend_agg.requested_amendments, 0)::int AS requested_amendments,
                COALESCE(amend_agg.active_amendments, 0)::int AS active_amendments
           FROM tbl_arc a
           LEFT JOIN tbl_users u ON u.id = a.created_by
           LEFT JOIN tbl_category cat ON cat.id = a.category_id
           LEFT JOIN tbl_hospitality_company_hotels h ON h.id = a.hotel_id
           LEFT JOIN tbl_department d ON d.id = a.department_id
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS item_count,
                    json_agg(pv.name ORDER BY ai.id) FILTER (WHERE pv.name IS NOT NULL) AS item_names,
                    json_agg(ai.product_variant_id ORDER BY ai.id) AS product_variant_ids
               FROM tbl_arc_item ai
               LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
              WHERE ai.arc_id = a.id
           ) item_agg ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS invited_count,
                    COUNT(*) FILTER (WHERE status = 'submitted') AS submitted_count
               FROM tbl_arc_invitation
              WHERE arc_id = a.id
           ) inv_agg ON TRUE
           LEFT JOIN LATERAL (
             SELECT json_agg(DISTINCT uvend.name) AS awarded_vendor_names,
                    json_agg(DISTINCT c.vendor_id) AS awarded_vendor_ids
               FROM tbl_arc_contract c
               LEFT JOIN tbl_users uvend ON uvend.id = c.vendor_id
              WHERE c.arc_id = a.id
           ) award_agg ON TRUE
           LEFT JOIN LATERAL (
             SELECT SUM(cl.unit_rate * cl.committed_qty) AS total_committed_value,
                    SUM(cl.unit_rate * cl.consumed_qty) AS total_consumed_value
               FROM tbl_arc_contract_line cl
               JOIN tbl_arc_contract c ON c.id = cl.arc_contract_id
              WHERE c.arc_id = a.id
           ) line_agg ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS call_off_count
               FROM tbl_arc_callof_po cp
               JOIN tbl_arc_contract c ON c.id = cp.arc_contract_id
              WHERE c.arc_id = a.id
           ) co_agg ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*) FILTER (WHERE am.status = 'requested')           AS requested_amendments,
                    COUNT(*) FILTER (WHERE am.status IN ('approved','live'))  AS active_amendments
               FROM tbl_arc_amendment am
               JOIN tbl_arc_contract c ON c.id = am.arc_contract_id
              WHERE c.arc_id = a.id
           ) amend_agg ON TRUE
           ${where}
          ORDER BY a.created_at DESC
          LIMIT $${p} OFFSET $${p + 1}`,
        args
      ),
      runner.one(`SELECT COUNT(*)::int AS c FROM tbl_arc a ${where}`, args.slice(0, args.length - 2)),
    ]);
    return { data: rows, total: count.c, page, limit };
  },

  /**
   * Dashboard KPI counts per status-group — feeds the sidebar live badges.
   */
  dashboardCounts: async ({ hospitality_company_id, hotel_ids = null, department_ids = null }, txContext = null) => {
    const runner = txContext || db;
    const conditions = ['hospitality_company_id = $1'];
    const args = [hospitality_company_id];
    let p = 2;
    if (Array.isArray(hotel_ids) && hotel_ids.length > 0) {
      conditions.push(`hotel_id = ANY($${p++}::int[])`);
      args.push(hotel_ids);
    }
    if (Array.isArray(department_ids) && department_ids.length > 0) {
      conditions.push(`department_id = ANY($${p++}::int[])`);
      args.push(department_ids);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const rows = await runner.any(
      `SELECT status, COUNT(*)::int AS c FROM tbl_arc ${where} GROUP BY status`,
      args
    );
    const counts = { drafts: 0, ongoing: 0, approved: 0, active: 0, ended: 0, all: 0 };
    for (const r of rows) {
      counts.all += r.c;
      for (const [grp, statuses] of Object.entries(STATUS_GROUPS)) {
        if (grp === 'all') continue;
        if (statuses.includes(r.status)) counts[grp] += r.c;
      }
    }
    return counts;
  },

  // ============================================================
  // ARC items
  // ============================================================

  addItem: async (arcId, data, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_arc_item
         (arc_id, product_variant_id, spec_text, target_price,
          indicative_qty, uom, spec_attachment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [arcId, data.product_variant_id, data.spec_text || null, data.target_price ?? null,
       data.indicative_qty, data.uom || null, data.spec_attachment_id ?? null]
    );
  },

  updateItem: async (itemId, patch, txContext = null) => {
    const runner = txContext || db;
    const allowed = ['spec_text','target_price','indicative_qty','uom','spec_attachment_id'];
    const setParts = []; const values = []; let p = 1;
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        setParts.push(`${key} = $${p++}`);
        values.push(patch[key]);
      }
    }
    if (setParts.length === 0) {
      return runner.oneOrNone(`SELECT * FROM tbl_arc_item WHERE id = $1`, [itemId]);
    }
    setParts.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(itemId);
    return runner.one(
      `UPDATE tbl_arc_item SET ${setParts.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
  },

  removeItem: async (itemId, txContext = null) => {
    return (txContext || db).none(`DELETE FROM tbl_arc_item WHERE id = $1`, [itemId]);
  },

  listItems: async (arcId, txContext = null) => {
    return (txContext || db).any(
      `SELECT ai.*, pv.name AS variant_name, pv.slug AS variant_slug
         FROM tbl_arc_item ai
         LEFT JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
        WHERE ai.arc_id = $1
        ORDER BY ai.id`,
      [arcId]
    );
  },

  // ============================================================
  // Invitations
  // ============================================================

  setInvitations: async (arcId, vendorIds, txContext = null) => {
    const runner = txContext || db;
    if (!Array.isArray(vendorIds) || vendorIds.length === 0) {
      await runner.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [arcId]);
      return [];
    }
    // Idempotent upsert; remove vendors no longer in the list.
    await runner.none(
      `DELETE FROM tbl_arc_invitation
        WHERE arc_id = $1 AND vendor_id <> ALL($2::int[])`,
      [arcId, vendorIds]
    );
    for (const vid of vendorIds) {
      await runner.none(
        `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
         VALUES ($1, $2, 'invited')
         ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
        [arcId, vid]
      );
    }
    return runner.any(`SELECT * FROM tbl_arc_invitation WHERE arc_id = $1`, [arcId]);
  },

  recordVendorResponse: async (arcId, vendorId, status, txContext = null) => {
    return (txContext || db).oneOrNone(
      `UPDATE tbl_arc_invitation
          SET status = $3, responded_at = CASE WHEN $3 IN ('submitted','declined') THEN CURRENT_TIMESTAMP ELSE responded_at END
        WHERE arc_id = $1 AND vendor_id = $2
       RETURNING *`,
      [arcId, vendorId, status]
    );
  },

  listInvitations: async (arcId, txContext = null) => {
    return (txContext || db).any(
      `SELECT i.*, u.name AS vendor_name, u.email AS vendor_email
         FROM tbl_arc_invitation i
         LEFT JOIN tbl_users u ON u.id = i.vendor_id
        WHERE i.arc_id = $1
        ORDER BY i.invited_at`,
      [arcId]
    );
  },

  // ============================================================
  // History snapshot (past-3y consumption frozen at float time)
  // ============================================================

  upsertHistorySnapshot: async (arcItemId, snapshots, txContext = null) => {
    const runner = txContext || db;
    for (const s of snapshots) {
      await runner.none(
        `INSERT INTO tbl_arc_item_history_snapshot
           (arc_item_id, year_offset, consumed_qty, last_rate, last_vendor_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (arc_item_id, year_offset) DO UPDATE
           SET consumed_qty   = EXCLUDED.consumed_qty,
               last_rate      = EXCLUDED.last_rate,
               last_vendor_id = EXCLUDED.last_vendor_id`,
        [arcItemId, s.year_offset, s.consumed_qty ?? 0, s.last_rate ?? null, s.last_vendor_id ?? null]
      );
    }
  },

  getHistorySnapshot: async (arcItemId, txContext = null) => {
    return (txContext || db).any(
      `SELECT * FROM tbl_arc_item_history_snapshot
        WHERE arc_item_id = $1
        ORDER BY year_offset`,
      [arcItemId]
    );
  },

  // ============================================================
  // Category → Department resolution (powers the wizard picker)
  // ============================================================

  getDepartmentsForCategoryAndUser: async ({ category_id, user_id, hospitality_company_id }, txContext = null) => {
    // Intersection of (departments mapped to the category) ∩ (departments the
    // user is scoped to via tbl_user_role_scopes for this company).
    return (txContext || db).any(
      `SELECT DISTINCT d.id, d.title
         FROM tbl_category_department cd
         JOIN tbl_department d ON d.id = cd.department_id
        WHERE cd.category_id = $1
          AND EXISTS (
            SELECT 1 FROM tbl_user_role_scopes urs
             WHERE urs.user_id = $2
               AND urs.company_id = $3
               AND (urs.department_id = d.id OR urs.department_id IS NULL)
          )
        ORDER BY d.title`,
      [category_id, user_id, hospitality_company_id]
    );
  },

  // ============================================================
  // Vendor eligibility for ARC (category-based — mirrors RFQ's variant-based
  // helper but joins through tbl_product_categories at category granularity).
  // ============================================================

  getEligibleVendorsForCategory: async ({ category_id, hotel_id }, txContext = null) => {
    return (txContext || db).any(
      `SELECT DISTINCT u.id, u.name, u.email
         FROM tbl_users u
         JOIN tbl_vendor_hotel_category_subscription vhcs
           ON vhcs.vendor_id = u.id
        WHERE u.user_type = 3
          AND u.status = 1
          AND vhcs.status IN ('active','expired')
          AND (
            (vhcs.item_type = 'hotel'    AND vhcs.item_id = $2)
            OR
            (vhcs.item_type = 'category' AND vhcs.item_id = $1)
          )
        ORDER BY u.name`,
      [category_id, hotel_id]
    );
  },
};

const STATUS_GROUPS = {
  drafts:   ['draft'],
  ongoing:  ['floated','submission_closed',
             'tech_eval_in_progress','tech_eval_approved','tech_eval_rejected',
             'comm_eval_in_progress','comm_eval_finalized',
             'committee_review','committee_sent_back'],
  approved: ['committee_approved','contract_generated','awaiting_vendor_acceptance'],
  active:   ['contract_active','expiring_soon'],
  ended:    ['expired','terminated','closed_no_award','committee_rejected'],
};

export default arcModel;
export { STATUS_GROUPS };
