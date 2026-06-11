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
      `SELECT m.*, u.name AS raised_by_name, u.email AS raised_by_email
         FROM tbl_material_requisition m
         LEFT JOIN tbl_users u ON u.id = m.raised_by
        WHERE m.id = $1`,
      [id]
    );
  },

  listItems: async (mrId, txContext = null) => {
    return (txContext || db).any(
      `SELECT mi.*, pv.name AS variant_name, pv.slug AS variant_slug,
              c.vendor_id, c.arc_id
         FROM tbl_material_requisition_item mi
         LEFT JOIN tbl_product_variant pv ON pv.id = mi.product_variant_id
         LEFT JOIN tbl_arc_contract c ON c.id = mi.arc_contract_id
        WHERE mi.mr_id = $1
        ORDER BY mi.id`,
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
    hospitality_company_id,
    hotel_ids = null,
    department_ids = null,
    raised_by = null,
    statusGroup = 'all',
    page = 1,
    limit = 20,
  }, txContext = null) => {
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
    if (raised_by) {
      conditions.push(`raised_by = $${p++}`);
      args.push(raised_by);
    }
    const statuses = STATUS_GROUPS_MR[statusGroup] || null;
    if (statuses) {
      conditions.push(`status = ANY($${p++}::varchar[])`);
      args.push(statuses);
    }
    args.push(limit);
    args.push((page - 1) * limit);
    const where = `WHERE ${conditions.join(' AND ')}`;
    const [rows, count] = await Promise.all([
      runner.any(
        `SELECT m.id, m.mr_number, m.title, m.status, m.hotel_id, m.department_id,
                m.urgency, m.required_by_date, m.submitted_at, m.created_at, m.updated_at,
                m.raised_by, u.name AS raised_by_name
           FROM tbl_material_requisition m
           LEFT JOIN tbl_users u ON u.id = m.raised_by
           ${where}
          ORDER BY m.created_at DESC
          LIMIT $${p} OFFSET $${p + 1}`,
        args
      ),
      runner.one(`SELECT COUNT(*)::int AS c FROM tbl_material_requisition ${where}`, args.slice(0, args.length - 2)),
    ]);
    return { data: rows, total: count.c, page, limit };
  },

  dashboardCounts: async ({ hospitality_company_id, hotel_ids = null, department_ids = null, raised_by = null }, txContext = null) => {
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
    if (raised_by) {
      conditions.push(`raised_by = $${p++}`);
      args.push(raised_by);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
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
         JOIN tbl_arc_contract c    ON c.id = cl.arc_contract_id AND c.status = 'active'
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
