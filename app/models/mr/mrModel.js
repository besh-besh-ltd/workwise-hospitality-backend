import db from '../../config/dbConn.js';

/**
 * MR (Material Requisition) — Database access layer.
 *
 * Contracted-items-only in this phase: every tbl_material_requisition_item must reference an
 * active tbl_arc_contract_line. The controller (mrController) gates the UI
 * picker AND revalidates at submit time; this model layer enforces the
 * data shape but trusts callers for higher-level validation.
 */

const STATUS_GROUPS_MR = {
  drafts:      ['draft'],
  pending:     ['pending_approval'],
  approved:    ['approved'],
  po_released: ['po_released'],
  cancelled:   ['rejected','cancelled'],
};

const mrModel = {
  createDraft: async (data, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_material_requisition
         (mr_number, title, hospitality_company_id, hotel_id, department_id,
          cost_center, urgency, required_by_date, justification, delivery_location,
          status, raised_by)
       VALUES
         ($1, $2, $3, $4, $5,
          $6, COALESCE($7, 'normal'), $8, $9, $10,
          'draft', $11)
       RETURNING *`,
      [
        data.mr_number, data.title, data.hospitality_company_id, data.hotel_id, data.department_id,
        data.cost_center || null, data.urgency || null, data.required_by_date || null,
        data.justification || null, data.delivery_location || null,
        data.raised_by,
      ]
    );
  },

  // Resolve a contract line with its contract + parent ARC scope, for
  // server-side validation of MR items (audit CO2/CO4). Returns null if the
  // line id doesn't exist.
  getContractLineDetail: async (lineId, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT cl.id              AS line_id,
              cl.arc_contract_id,
              cl.arc_item_id,
              cl.unit_rate,
              cl.committed_qty,
              cl.consumed_qty,
              (cl.committed_qty - cl.consumed_qty) AS remaining_qty,
              c.status           AS contract_status,
              c.vendor_id,
              c.arc_id,
              a.hotel_id,
              a.department_id,
              ai.product_variant_id
         FROM tbl_arc_contract_line cl
         JOIN tbl_arc_contract c ON c.id = cl.arc_contract_id
         JOIN tbl_arc a          ON a.id = c.arc_id
         JOIN tbl_arc_item ai    ON ai.id = cl.arc_item_id
        WHERE cl.id = $1`,
      [lineId]
    );
  },

  // Hotels the user can raise an MR for — the same accessible set used for
  // authorization (hotel-level mappings + every hotel under a company-level
  // mapping). Scoped to the user; never depends on a client-supplied company.
  accessibleHotels: async (userId, txContext = null) => {
    return (txContext || db).any(
      `WITH user_hotels AS (
         SELECT DISTINCT hum.hospitality_hotel_id AS hotel_id
           FROM tbl_hospitality_user_mappings hum
          WHERE hum.user_id = $1 AND hum.mapping_type = 1 AND hum.hospitality_hotel_id IS NOT NULL
         UNION
         SELECT DISTINCT h.id AS hotel_id
           FROM tbl_hospitality_user_mappings hum
           JOIN tbl_hospitality_company_hotels h ON h.hospitality_company_id = hum.hospitality_company_id
          WHERE hum.user_id = $1 AND hum.mapping_type = 0 AND hum.hospitality_hotel_id IS NULL AND h.is_deleted = 0
       )
       SELECT h.id, h.name, h.city, h.hospitality_company_id
         FROM tbl_hospitality_company_hotels h
         JOIN user_hotels uh ON uh.hotel_id = h.id
        WHERE h.is_deleted = 0
        ORDER BY h.name`,
      [userId]
    );
  },

  // Departments the user is mapped to at a hotel (role-scope membership, not a
  // specific permission). A NULL-department scope at the hotel = all-departments
  // grant → return every department.
  hotelDepartmentsForUser: async (userId, hotelId, txContext = null) => {
    return (txContext || db).any(
      `WITH hotel_company AS (
         SELECT hospitality_company_id FROM tbl_hospitality_company_hotels
          WHERE id = $2 AND is_deleted = 0 LIMIT 1
       ),
       has_all AS (
         SELECT EXISTS (
           SELECT 1 FROM tbl_user_role_scopes urs
            WHERE urs.user_id = $1
              AND urs.company_id = (SELECT hospitality_company_id FROM hotel_company)
              AND (urs.hotel_id IS NULL OR urs.hotel_id = $2)
              AND urs.department_id IS NULL
         ) AS all_depts
       )
       SELECT d.id, d.title
         FROM tbl_department d
        WHERE (SELECT all_depts FROM has_all) = true
           OR d.id IN (
             SELECT urs.department_id FROM tbl_user_role_scopes urs
              WHERE urs.user_id = $1
                AND urs.company_id = (SELECT hospitality_company_id FROM hotel_company)
                AND (urs.hotel_id IS NULL OR urs.hotel_id = $2)
                AND urs.department_id IS NOT NULL
           )
        ORDER BY d.title`,
      [userId, hotelId]
    );
  },

  addItem: async (mrId, data, txContext = null) => {
    const runner = txContext || db;
    return runner.one(
      `INSERT INTO tbl_material_requisition_item
         (mr_id, product_variant_id, quantity, uom,
          arc_contract_id, arc_contract_line_id, matched_unit_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [mrId, data.product_variant_id, data.quantity, data.uom || null,
       data.arc_contract_id, data.arc_contract_line_id, data.matched_unit_rate ?? null]
    );
  },

  setItems: async (mrId, items, txContext = null) => {
    const runner = txContext || db;
    await runner.none(`DELETE FROM tbl_material_requisition_item WHERE mr_id = $1`, [mrId]);
    const inserted = [];
    for (const it of items) {
      inserted.push(await mrModel.addItem(mrId, it, runner));
    }
    return inserted;
  },

  getById: async (id, txContext = null) => {
    return (txContext || db).oneOrNone(
      `SELECT m.*, u.name AS raised_by_name, u.email AS raised_by_email,
              h.name AS hotel_name, d.title AS department_name
         FROM tbl_material_requisition m
         LEFT JOIN tbl_users u ON u.id = m.raised_by
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = m.hotel_id
         LEFT JOIN tbl_department d ON d.id = m.department_id
        WHERE m.id = $1`,
      [id]
    );
  },

  // Labelled steps of an approval policy — for the create-page routing preview.
  policySteps: async (policyId, txContext = null) => {
    return (txContext || db).any(
      `SELECT s.step_order, s.decision_rule, s.approver_source_type, s.approver_source_id,
              CASE s.approver_source_type
                WHEN 'ROLE'       THEN r.title
                WHEN 'USER'       THEN u.name
                WHEN 'DEPARTMENT' THEN 'Department head'
                ELSE s.approver_source_type
              END AS approver_label
         FROM tbl_approval_policy_steps s
         LEFT JOIN tbl_roles r ON s.approver_source_type = 'ROLE' AND r.id = s.approver_source_id
         LEFT JOIN tbl_users u ON s.approver_source_type = 'USER' AND u.id = s.approver_source_id
        WHERE s.approval_policy_id = $1
        ORDER BY s.step_order`,
      [policyId]
    );
  },

  listItems: async (mrId, txContext = null) => {
    return (txContext || db).any(
      `SELECT mi.*, pv.name AS variant_name, pv.slug AS variant_slug,
              c.vendor_id, c.arc_id,
              uv.name AS vendor_name, uv.email AS vendor_email,
              a.arc_number, a.title AS arc_title
         FROM tbl_material_requisition_item mi
         LEFT JOIN tbl_product_variant pv ON pv.id = mi.product_variant_id
         LEFT JOIN tbl_arc_contract c ON c.id = mi.arc_contract_id
         LEFT JOIN tbl_users uv ON uv.id = c.vendor_id
         LEFT JOIN tbl_arc a ON a.id = c.arc_id
        WHERE mi.mr_id = $1
        ORDER BY mi.id`,
      [mrId]
    );
  },

  // Call-off PO(s) released from this MR — links the approval chain's final
  // "PO released" row to the actual purchase order.
  callOffPos: async (mrId, txContext = null) => {
    return (txContext || db).any(
      `SELECT cp.po_id, cp.arc_contract_id, cp.released_at,
              po.po_number, po.status AS po_status
         FROM tbl_arc_callof_po cp
         LEFT JOIN tbl_rfq_purchase_order po ON po.id = cp.po_id
        WHERE cp.mr_id = $1
        ORDER BY cp.released_at DESC`,
      [mrId]
    );
  },

  setStatus: async (id, status, extras = {}, txContext = null) => {
    const runner = txContext || db;
    const sets = ['status = $1', 'updated_at = CURRENT_TIMESTAMP'];
    const args = [status];
    let p = 2;
    if (extras.submitted_at) { sets.push(`submitted_at = $${p++}`); args.push(extras.submitted_at); }
    if (extras.approval_instance_id !== undefined) {
      sets.push(`approval_instance_id = $${p++}`);
      args.push(extras.approval_instance_id);
    }
    args.push(id);
    return runner.oneOrNone(
      `UPDATE tbl_material_requisition SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      args
    );
  },

  list: async ({
    hospitality_company_ids = null, // number[] (scope) | null (super admin = all)
    hotel_ids = null,
    department_ids = null,
    raised_by = null,
    statusGroup = 'all',
    page = 1,
    limit = 20,
  }, txContext = null) => {
    const runner = txContext || db;
    // null = no company filter (super admin); an array (incl. empty) scopes to
    // exactly those companies — empty array deliberately matches nothing.
    const conditions = [];
    const args = [];
    let p = 1;
    if (hospitality_company_ids !== null) {
      conditions.push(`m.hospitality_company_id = ANY($${p++}::int[])`);
      args.push(Array.isArray(hospitality_company_ids) ? hospitality_company_ids : []);
    }
    if (Array.isArray(hotel_ids) && hotel_ids.length > 0) {
      conditions.push(`m.hotel_id = ANY($${p++}::int[])`);
      args.push(hotel_ids);
    }
    if (Array.isArray(department_ids) && department_ids.length > 0) {
      conditions.push(`m.department_id = ANY($${p++}::int[])`);
      args.push(department_ids);
    }
    if (raised_by) {
      conditions.push(`m.raised_by = $${p++}`);
      args.push(raised_by);
    }
    const statuses = STATUS_GROUPS_MR[statusGroup] || null;
    if (statuses) {
      conditions.push(`m.status = ANY($${p++}::varchar[])`);
      args.push(statuses);
    }
    args.push(limit);
    args.push((page - 1) * limit);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    // Per-row aggregates (item value, vendors, products, categories) come from a
    // LATERAL over the MR's items + their contract/ARC — powers the faceted
    // All-MRs listing without N+1 round-trips.
    const [rows, count] = await Promise.all([
      runner.any(
        `SELECT m.id, m.mr_number, m.title, m.status, m.hotel_id, m.department_id,
                m.urgency, m.required_by_date, m.submitted_at, m.created_at, m.updated_at,
                m.raised_by, u.name AS raised_by_name,
                h.name AS hotel_name, d.title AS department_name,
                agg.item_count, agg.total_est_value,
                agg.item_names, agg.product_variant_ids,
                agg.vendor_ids, agg.vendor_names,
                agg.category_ids, agg.category_titles,
                COALESCE(po.call_off_count, 0) AS call_off_count
           FROM tbl_material_requisition m
           LEFT JOIN tbl_users u ON u.id = m.raised_by
           LEFT JOIN tbl_hospitality_company_hotels h ON h.id = m.hotel_id
           LEFT JOIN tbl_department d ON d.id = m.department_id
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS item_count,
                    COALESCE(SUM(mi.quantity * COALESCE(mi.matched_unit_rate, 0)), 0)::numeric AS total_est_value,
                    COALESCE(json_agg(DISTINCT pv.name)     FILTER (WHERE pv.name IS NOT NULL),   '[]'::json) AS item_names,
                    COALESCE(json_agg(DISTINCT pv.id)       FILTER (WHERE pv.id IS NOT NULL),     '[]'::json) AS product_variant_ids,
                    COALESCE(json_agg(DISTINCT c.vendor_id) FILTER (WHERE c.vendor_id IS NOT NULL), '[]'::json) AS vendor_ids,
                    COALESCE(json_agg(DISTINCT uv.name)     FILTER (WHERE uv.name IS NOT NULL),   '[]'::json) AS vendor_names,
                    COALESCE(json_agg(DISTINCT a.category_id) FILTER (WHERE a.category_id IS NOT NULL), '[]'::json) AS category_ids,
                    COALESCE(json_agg(DISTINCT cat.title)   FILTER (WHERE cat.title IS NOT NULL),  '[]'::json) AS category_titles
               FROM tbl_material_requisition_item mi
               LEFT JOIN tbl_product_variant pv ON pv.id = mi.product_variant_id
               LEFT JOIN tbl_arc_contract c ON c.id = mi.arc_contract_id
               LEFT JOIN tbl_users uv ON uv.id = c.vendor_id
               LEFT JOIN tbl_arc a ON a.id = c.arc_id
               LEFT JOIN tbl_category cat ON cat.id = a.category_id
              WHERE mi.mr_id = m.id
           ) agg ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS call_off_count
               FROM tbl_arc_callof_po cp WHERE cp.mr_id = m.id
           ) po ON TRUE
           ${where}
          ORDER BY m.created_at DESC
          LIMIT $${p} OFFSET $${p + 1}`,
        args
      ),
      runner.one(`SELECT COUNT(*)::int AS c FROM tbl_material_requisition m ${where}`, args.slice(0, args.length - 2)),
    ]);
    return { data: rows, total: count.c, page, limit };
  },

  // Of the given MR ids, which currently have an MR approval waiting on the
  // user (current-step pending approver). Mirrors arcModel.getPendingForUserArcIds.
  getPendingMrIds: async (mrIds, userId, txContext = null) => {
    if (!Array.isArray(mrIds) || mrIds.length === 0 || !userId) return [];
    const rows = await (txContext || db).any(
      `SELECT DISTINCT i.entity_id AS mr_id
         FROM tbl_approval_instances i
         JOIN tbl_approval_instance_steps s
           ON s.approval_instance_id = i.id AND s.step_order = i.current_step
         JOIN tbl_approval_step_approvers sa
           ON sa.approval_instance_step_id = s.id
        WHERE i.entity_type = 'MR'
          AND i.status = 'PENDING'
          AND i.entity_id = ANY($1::int[])
          AND sa.approver_user_id = $2
          AND sa.status = 'PENDING'`,
      [mrIds.map(Number), Number(userId)]
    );
    return rows.map((r) => Number(r.mr_id));
  },

  dashboardCounts: async ({ hospitality_company_ids = null, hotel_ids = null, department_ids = null, raised_by = null }, txContext = null) => {
    const runner = txContext || db;
    const conditions = [];
    const args = [];
    let p = 1;
    if (hospitality_company_ids !== null) {
      conditions.push(`hospitality_company_id = ANY($${p++}::int[])`);
      args.push(Array.isArray(hospitality_company_ids) ? hospitality_company_ids : []);
    }
    if (Array.isArray(hotel_ids) && hotel_ids.length > 0) {
      conditions.push(`hotel_id = ANY($${p++}::int[])`);
      args.push(hotel_ids);
    }
    if (Array.isArray(department_ids) && department_ids.length > 0) {
      conditions.push(`department_id = ANY($${p++}::int[])`);
      args.push(department_ids);
    }
    if (raised_by) {
      conditions.push(`raised_by = $${p++}`);
      args.push(raised_by);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : 'WHERE TRUE';
    const rows = await runner.any(
      `SELECT status, COUNT(*)::int AS c FROM tbl_material_requisition ${where} GROUP BY status`,
      args
    );
    const counts = { drafts: 0, pending: 0, approved: 0, po_released: 0, cancelled: 0, all: 0 };
    for (const r of rows) {
      counts.all += r.c;
      for (const [grp, statuses] of Object.entries(STATUS_GROUPS_MR)) {
        if (statuses.includes(r.status)) counts[grp] += r.c;
      }
    }
    return counts;
  },

  /**
   * Single-source-of-truth analytics for the MR dashboard. Returns status +
   * value breakdowns, MR→PO conversion, avg approval time, overdue count, and
   * breakdowns by department / hotel / urgency / month, top requesters, and a
   * recent-MR feed. All scoped by the same filters as list/dashboardCounts.
   */
  analytics: async ({ hospitality_company_ids = null, hotel_ids = null, department_ids = null, raised_by = null }, txContext = null) => {
    const runner = txContext || db;
    const conditions = [];
    const args = [];
    let p = 1;
    if (hospitality_company_ids !== null) {
      conditions.push(`m.hospitality_company_id = ANY($${p++}::int[])`);
      args.push(Array.isArray(hospitality_company_ids) ? hospitality_company_ids : []);
    }
    if (Array.isArray(hotel_ids) && hotel_ids.length > 0) { conditions.push(`m.hotel_id = ANY($${p++}::int[])`); args.push(hotel_ids); }
    if (Array.isArray(department_ids) && department_ids.length > 0) { conditions.push(`m.department_id = ANY($${p++}::int[])`); args.push(department_ids); }
    if (raised_by) { conditions.push(`m.raised_by = $${p++}`); args.push(raised_by); }
    // 'WHERE TRUE' fallback so the `${where} AND …` queries below stay valid
    // when there's no company filter (super admin).
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : 'WHERE TRUE';
    // Reusable per-MR value LATERAL.
    const VAL = `LEFT JOIN LATERAL (SELECT COALESCE(SUM(mi.quantity * COALESCE(mi.matched_unit_rate,0)),0)::numeric AS val
                   FROM tbl_material_requisition_item mi WHERE mi.mr_id = m.id) v ON TRUE`;

    const [byStatus, byDept, byHotel, byUrgency, byMonth, topReq, cycle, overdue, recent] = await Promise.all([
      runner.any(`SELECT m.status, COUNT(*)::int AS count, COALESCE(SUM(v.val),0)::numeric AS value
                    FROM tbl_material_requisition m ${VAL} ${where} GROUP BY m.status`, args),
      runner.any(`SELECT m.department_id, d.title AS department_name, COUNT(*)::int AS count, COALESCE(SUM(v.val),0)::numeric AS value
                    FROM tbl_material_requisition m LEFT JOIN tbl_department d ON d.id = m.department_id ${VAL}
                   ${where} GROUP BY m.department_id, d.title ORDER BY count DESC`, args),
      runner.any(`SELECT m.hotel_id, h.name AS hotel_name, COUNT(*)::int AS count, COALESCE(SUM(v.val),0)::numeric AS value
                    FROM tbl_material_requisition m LEFT JOIN tbl_hospitality_company_hotels h ON h.id = m.hotel_id ${VAL}
                   ${where} GROUP BY m.hotel_id, h.name ORDER BY count DESC`, args),
      runner.any(`SELECT m.urgency, COUNT(*)::int AS count FROM tbl_material_requisition m ${where} GROUP BY m.urgency`, args),
      runner.any(`SELECT to_char(date_trunc('month', m.created_at), 'YYYY-MM') AS month, COUNT(*)::int AS count
                    FROM tbl_material_requisition m ${where}
                      AND m.created_at >= (date_trunc('month', NOW()) - INTERVAL '5 months')
                   GROUP BY 1 ORDER BY 1`, args),
      runner.any(`SELECT m.raised_by, u.name AS raised_by_name, COUNT(*)::int AS count
                    FROM tbl_material_requisition m LEFT JOIN tbl_users u ON u.id = m.raised_by
                   ${where} GROUP BY m.raised_by, u.name ORDER BY count DESC LIMIT 6`, args),
      runner.one(`SELECT AVG(EXTRACT(EPOCH FROM (m.updated_at - m.submitted_at)) / 86400.0) AS avg_days
                    FROM tbl_material_requisition m
                   ${where} AND m.status IN ('approved','po_released') AND m.submitted_at IS NOT NULL`, args),
      runner.one(`SELECT COUNT(*)::int AS c FROM tbl_material_requisition m
                   ${where} AND m.required_by_date < CURRENT_DATE
                     AND m.status NOT IN ('po_released','cancelled','rejected')`, args),
      runner.any(`SELECT m.id, m.mr_number, m.title, m.status, m.urgency, m.created_at,
                         h.name AS hotel_name, d.title AS department_name, u.name AS raised_by_name,
                         COALESCE(v.val,0)::numeric AS total_est_value
                    FROM tbl_material_requisition m
                    LEFT JOIN tbl_hospitality_company_hotels h ON h.id = m.hotel_id
                    LEFT JOIN tbl_department d ON d.id = m.department_id
                    LEFT JOIN tbl_users u ON u.id = m.raised_by
                    ${VAL}
                   ${where} ORDER BY m.created_at DESC LIMIT 8`, args),
    ]);

    const totals = { all: 0, draft: 0, pending_approval: 0, approved: 0, po_released: 0, rejected: 0, cancelled: 0,
                     total_value: 0, pending_value: 0, po_released_value: 0 };
    for (const r of byStatus) {
      totals.all += r.count;
      totals[r.status] = (totals[r.status] || 0) + r.count;
      totals.total_value += Number(r.value);
      if (r.status === 'pending_approval') totals.pending_value += Number(r.value);
      if (r.status === 'po_released') totals.po_released_value += Number(r.value);
    }
    const convDenom = (totals.approved || 0) + (totals.po_released || 0);
    const conversion_rate = convDenom > 0 ? Math.round((totals.po_released / convDenom) * 1000) / 10 : null;

    return {
      totals,
      conversion_rate,
      avg_approval_days: cycle.avg_days != null ? Math.round(Number(cycle.avg_days) * 10) / 10 : null,
      overdue_count: overdue.c,
      by_status: byStatus,
      by_department: byDept,
      by_hotel: byHotel,
      by_urgency: byUrgency,
      by_month: byMonth,
      top_requesters: topReq,
      recent,
    };
  },

  /**
   * The picker query for MR-create. Returns products that:
   *   - have at least one tbl_arc_contract_line on an active ARC contract for
   *     the user's hotel,
   *   - whose parent ARC's department_id matches the user's department, and
   *   - optionally match a search query against product name/slug.
   *
   * Multiple active contracts on the same (product × hotel × department) are
   * returned as separate rows — the picker forces the user to choose one.
   */
  searchContractedItems: async ({ hotel_id, department_id, query = null, limit = 25 }, txContext = null) => {
    const runner = txContext || db;
    const args = [hotel_id, department_id];
    let qFilter = '';
    let p = 3;
    if (query && query.trim()) {
      qFilter = `AND (pv.name ILIKE $${p} OR pv.slug ILIKE $${p})`;
      args.push(`%${query.trim()}%`);
      p++;
    }
    args.push(limit);
    return runner.any(
      `SELECT cl.id            AS arc_contract_line_id,
              cl.unit_rate     AS current_rate,
              cl.committed_qty,
              cl.consumed_qty,
              (cl.committed_qty - cl.consumed_qty) AS remaining_qty,
              c.id             AS arc_contract_id,
              c.vendor_id,
              a.id             AS arc_id,
              a.arc_number,
              a.title          AS arc_title,
              ai.id            AS arc_item_id,
              ai.uom,
              pv.id            AS product_variant_id,
              pv.name          AS variant_name,
              pv.slug          AS variant_slug,
              uvend.name       AS vendor_name
         FROM tbl_arc_contract_line cl
         JOIN tbl_arc_contract c    ON c.id = cl.arc_contract_id AND c.status IN ('active','expiring_soon')
         JOIN tbl_arc a             ON a.id = c.arc_id AND a.hotel_id = $1 AND a.department_id = $2
         JOIN tbl_arc_item ai       ON ai.id = cl.arc_item_id
         JOIN tbl_product_variant pv ON pv.id = ai.product_variant_id
         LEFT JOIN tbl_users uvend  ON uvend.id = c.vendor_id
        WHERE (cl.committed_qty - cl.consumed_qty) > 0
          ${qFilter}
        ORDER BY pv.name, c.vendor_id
        LIMIT $${p}`,
      args
    );
  },
};

export default mrModel;
export { STATUS_GROUPS_MR };
