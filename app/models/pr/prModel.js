// Purchase Requisitions (PR) — database access layer.
//
// Raw, parameterised SQL only. Authorization lives in services/pr/prAccess.js
// and is applied by the controller BEFORE any of these run; nothing here trusts
// a client-supplied tenant id.
//
// Dates: required_by_date is a DATE. node-pg would parse it into a JS Date at
// the server's local midnight, which serialises as the PREVIOUS day in UTC for
// IST. Every read returns it as 'YYYY-MM-DD' text instead.

import db from '../../config/dbConn.js';
import { USABLE_VARIANT_SQL, FIRST_CATEGORY_SQL } from '../../services/pr/prCatalog.js';
import { prGrantRowsSql } from '../../services/pr/prAccess.js';

// ---------------------------------------------------------------------------
// Derived line progress — single source of truth (spec §4.2). `l` = line alias, `p` = PR alias.
// Live link = RFQ product still exists (FK cascade) AND (RFQ not closed/withdrawn OR a live PO exists for it).
// ---------------------------------------------------------------------------
export const LIVE_PO_EXISTS = (lk) => `EXISTS (
  SELECT 1 FROM tbl_rfq_purchase_order po_l
    JOIN tbl_purchase_order_product pop_l ON pop_l.purchase_order_id = po_l.id
   WHERE po_l.rfq_id = ${lk}.rfq_id AND pop_l.rfq_product_id = ${lk}.rfq_product_id
     AND po_l.status NOT IN ('rejected','rejected_by_vendor','cancelled','draft'))`;
export const LIVE_LINK_EXISTS = (l) => `EXISTS (
  SELECT 1 FROM tbl_pr_line_rfq lk JOIN tbl_rfq r ON r.id = lk.rfq_id
   WHERE lk.pr_line_id = ${l}.id AND (r.status NOT IN (2,5) OR ${LIVE_PO_EXISTS('lk')}))`;
export const LINE_PROGRESS_SQL = (l, p) => `CASE
  WHEN ${l}.status = 'cancelled' THEN 'cancelled'
  WHEN ${l}.status = 'closed' THEN 'closed'
  WHEN ${p}.status <> 'approved' THEN 'pending'
  WHEN EXISTS (SELECT 1 FROM tbl_pr_line_rfq lk WHERE lk.pr_line_id = ${l}.id AND ${LIVE_PO_EXISTS('lk')}) THEN 'ordered'
  WHEN ${LIVE_LINK_EXISTS(l)} THEN 'in_sourcing'
  WHEN ${l}.line_kind = 'free_text' AND ${l}.mapped_variant_id IS NULL
       AND EXISTS (SELECT 1 FROM tbl_pr_catalog_request cr WHERE cr.pr_line_id = ${l}.id AND cr.status = 'open') THEN 'awaiting_catalog'
  WHEN ${l}.line_kind = 'free_text' AND ${l}.mapped_variant_id IS NULL THEN 'needs_mapping'
  ELSE 'in_pool' END`;

/**
 * Σ ROUND(quantity × estimated_unit_price, 2) over the PR's ACTIVE lines, as an
 * exact NUMERIC with 2 decimals (0.00 when there are none). `p` = PR alias.
 * The only formula for a PR's value: submit stores it, lists/detail show it live.
 */
export const estimateTotalSql = (p) => `(
  SELECT COALESCE(SUM(ROUND(_et_l.quantity * _et_l.estimated_unit_price, 2)), 0::numeric(18,2))
    FROM tbl_purchase_requisition_line _et_l
   WHERE _et_l.pr_id = ${p}.id AND _et_l.status = 'active')`;

// Every column of tbl_purchase_requisition, with the DATE as text.
const PR_COLUMN_NAMES = [
  'id', 'pr_number', 'title', 'pr_type', 'hospitality_company_id', 'hotel_id', 'department_id', 'process_id',
  'urgency', 'required_by_date', 'justification', 'delivery_location', 'status', 'revision', 'estimated_total',
  'raised_by', 'submitted_at', 'approved_at', 'approval_instance_id', 'assigned_buyer_id', 'assigned_at',
  'returned_note', 'cancelled_reason', 'created_at', 'updated_at',
];
const PR_COLUMNS = (a, { except = [] } = {}) => PR_COLUMN_NAMES
  .filter((c) => !except.includes(c))
  .map((c) => (c === 'required_by_date' ? `to_char(${a}.required_by_date, 'YYYY-MM-DD') AS required_by_date` : `${a}.${c}`))
  .join(', ');

const IST_TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`;

// Header columns a caller may write through insertPr/updateHeader.
const WRITABLE_HEADER = [
  'title', 'pr_type', 'hospitality_company_id', 'hotel_id', 'department_id', 'urgency', 'required_by_date',
  'justification', 'delivery_location', 'status', 'revision', 'estimated_total', 'submitted_at', 'approved_at',
  'approval_instance_id', 'assigned_buyer_id', 'assigned_at', 'returned_note', 'cancelled_reason',
];

/** Today's calendar date in IST, 'YYYY-MM-DD' (session-timezone independent). */
export async function istToday(t = db) {
  const row = await t.one(`SELECT to_char(${IST_TODAY}, 'YYYY-MM-DD') AS d`);
  return row.d;
}

/**
 * 'PR-<IST year>-<base36(seq)>', mirroring mrController.generateMrNumber's
 * shape. `seq` is drawn from the table's own id sequence: sequence values are
 * never handed out twice, so the number is unique without a retry loop and
 * without a lock (ids and numbers are independent; the id sequence just skips).
 */
export async function nextPrNumber(t = db) {
  const row = await t.one(
    `SELECT nextval(pg_get_serial_sequence('public.tbl_purchase_requisition', 'id')) AS seq,
            EXTRACT(YEAR FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::int AS yyyy`);
  return `PR-${row.yyyy}-${BigInt(row.seq).toString(36).toUpperCase().padStart(5, '0')}`;
}

/** Insert a draft header. `header` must carry pr_number and raised_by. */
export async function insertPr(t, header) {
  const cols = ['pr_number', 'raised_by', ...WRITABLE_HEADER.filter((k) => header[k] !== undefined)];
  const vals = cols.map((k) => header[k]);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  return t.one(
    `INSERT INTO tbl_purchase_requisition AS p (${cols.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING ${PR_COLUMNS('p')}`,
    vals
  );
}

/** Patch whitelisted header columns; always bumps updated_at. */
export async function updateHeader(t, prId, patch) {
  const keys = WRITABLE_HEADER.filter((k) => patch[k] !== undefined);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  sets.push('updated_at = NOW()');
  return t.one(
    `UPDATE tbl_purchase_requisition p SET ${sets.join(', ')} WHERE p.id = $1 RETURNING ${PR_COLUMNS('p')}`,
    [prId, ...keys.map((k) => patch[k])]
  );
}

/**
 * Replace every line of a PR (DELETE + INSERT, same transaction). Lines are
 * numbered 1..n in the given order. Money/quantities travel as strings and are
 * cast to NUMERIC in SQL, never through a JS float.
 * Deleting a line cascades its clauses, line attachments and review links.
 */
export async function replaceLines(t, prId, lines) {
  await t.none(`DELETE FROM tbl_purchase_requisition_line WHERE pr_id = $1`, [prId]);
  if (!lines.length) return [];
  const rows = lines.map((l, i) => ({
    line_no: i + 1,
    line_kind: l.line_kind,
    product_variant_id: l.product_variant_id ?? null,
    free_text_name: l.free_text_name ?? null,
    category_id: l.category_id,
    quantity: String(l.quantity),
    uom: l.uom,
    estimated_unit_price: String(l.estimated_unit_price),
    specification: l.specification ?? null,
    suggested_vendor_note: l.suggested_vendor_note ?? null,
  }));
  return t.any(
    `INSERT INTO tbl_purchase_requisition_line
       (pr_id, line_no, line_kind, product_variant_id, free_text_name, category_id,
        quantity, uom, estimated_unit_price, specification, suggested_vendor_note)
     SELECT $1, x.line_no, x.line_kind, x.product_variant_id, x.free_text_name, x.category_id,
            x.quantity::numeric, x.uom, x.estimated_unit_price::numeric, x.specification, x.suggested_vendor_note
       FROM jsonb_to_recordset($2::jsonb) AS x(
              line_no int, line_kind text, product_variant_id int, free_text_name text, category_id int,
              quantity text, uom text, estimated_unit_price text, specification text, suggested_vendor_note text)
      ORDER BY x.line_no
     RETURNING id, line_no`,
    [prId, JSON.stringify(rows)]
  );
}

/** Row-lock a PR for a state change. null if it does not exist. */
export async function lockPr(t, prId) {
  return t.oneOrNone(`SELECT ${PR_COLUMNS('p')} FROM tbl_purchase_requisition p WHERE p.id = $1 FOR UPDATE`, [prId]);
}

export async function getPrRow(prId, t = db) {
  return t.oneOrNone(`SELECT ${PR_COLUMNS('p')} FROM tbl_purchase_requisition p WHERE p.id = $1`, [prId]);
}

/**
 * New draft copied from `srcId` for `raisedBy`: same header (required_by_date
 * moved up to today IST if it is in the past), every line re-numbered 1..n with
 * stored status / mapping / closure reset. Clauses and attachments are NOT
 * copied (they belong to the source's review), nor is any workflow state.
 */
export async function copyPr(t, srcId, { prNumber, raisedBy }) {
  const pr = await t.one(
    `INSERT INTO tbl_purchase_requisition AS p
       (pr_number, title, pr_type, hospitality_company_id, hotel_id, department_id, process_id, urgency,
        required_by_date, justification, delivery_location, raised_by)
     SELECT $2, s.title, s.pr_type, s.hospitality_company_id, s.hotel_id, s.department_id, s.process_id, s.urgency,
            GREATEST(s.required_by_date, ${IST_TODAY}), s.justification, s.delivery_location, $3
       FROM tbl_purchase_requisition s
      WHERE s.id = $1
     RETURNING ${PR_COLUMNS('p')}`,
    [srcId, prNumber, raisedBy]
  );
  await t.none(
    `INSERT INTO tbl_purchase_requisition_line
       (pr_id, line_no, line_kind, product_variant_id, free_text_name, category_id,
        quantity, uom, estimated_unit_price, specification, suggested_vendor_note)
     SELECT $2, ROW_NUMBER() OVER (ORDER BY s.line_no, s.id), s.line_kind, s.product_variant_id, s.free_text_name,
            s.category_id, s.quantity, s.uom, s.estimated_unit_price, s.specification, s.suggested_vendor_note
       FROM tbl_purchase_requisition_line s
      WHERE s.pr_id = $1`,
    [srcId, pr.id]
  );
  return pr;
}

/**
 * Everything the detail page renders.
 * @returns {Promise<{pr, lines, attachments, reviews, events, comments}|null>}
 *   lines[] carry clauses[], attachments[], progress and links[] (RFQ + POs);
 *   top-level attachments[] are the PR-level ones (no line).
 *   pr.estimated_total is the live Σ for draft/returned, else the value stored at submit.
 */
export async function getDetail(prId, t = db) {
  return t.task(async (c) => {
    const pr = await c.oneOrNone(
      `SELECT ${PR_COLUMNS('p', { except: ['estimated_total'] })},
              CASE WHEN p.status IN ('draft','returned') THEN ${estimateTotalSql('p')} ELSE p.estimated_total END
                AS estimated_total,
              h.name AS hotel_name, d.title AS department_name,
              ru.name AS raised_by_name, bu.name AS assigned_buyer_name
         FROM tbl_purchase_requisition p
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = p.hotel_id
         LEFT JOIN tbl_department d ON d.id = p.department_id
         LEFT JOIN tbl_users ru ON ru.id = p.raised_by
         LEFT JOIN tbl_users bu ON bu.id = p.assigned_buyer_id
        WHERE p.id = $1`,
      [prId]
    );
    if (!pr) return null;

    const lines = await c.any(
      `SELECT l.id, l.line_no, l.line_kind, l.product_variant_id, pv.name AS variant_name, prod.name AS product_name,
              l.free_text_name, l.category_id, cat.title AS category_title,
              l.quantity, l.uom, l.estimated_unit_price,
              ROUND(l.quantity * l.estimated_unit_price, 2) AS line_value,
              l.specification, l.suggested_vendor_note,
              l.status, l.close_reason, l.closed_by, l.closed_at,
              l.mapped_variant_id, mpv.name AS mapped_variant_name, l.mapped_by, l.mapped_at,
              ${LINE_PROGRESS_SQL('l', 'p')} AS progress
         FROM tbl_purchase_requisition_line l
         JOIN tbl_purchase_requisition p ON p.id = l.pr_id
         LEFT JOIN tbl_product_variant pv ON pv.id = l.product_variant_id
         LEFT JOIN tbl_product prod ON prod.id = pv.product_id
         LEFT JOIN tbl_product_variant mpv ON mpv.id = l.mapped_variant_id
         LEFT JOIN tbl_category cat ON cat.id = l.category_id
        WHERE l.pr_id = $1
        ORDER BY l.line_no`,
      [prId]
    );

    const clauses = await c.any(
      `SELECT cl.id, cl.pr_line_id, cl.clause_text, cl.clause_type, cl.weightage, cl.added_by,
              u.name AS added_by_name, cl.created_at
         FROM tbl_pr_line_clause cl
         JOIN tbl_purchase_requisition_line l ON l.id = cl.pr_line_id
         LEFT JOIN tbl_users u ON u.id = cl.added_by
        WHERE l.pr_id = $1
        ORDER BY cl.id`,
      [prId]
    );

    const attachments = await c.any(
      `SELECT a.id, a.pr_line_id, a.kind, a.file_url, a.file_name, a.uploaded_by,
              u.name AS uploaded_by_name, a.created_at
         FROM tbl_pr_attachment a
         LEFT JOIN tbl_users u ON u.id = a.uploaded_by
        WHERE a.pr_id = $1
        ORDER BY a.id`,
      [prId]
    );

    const links = await c.any(
      `SELECT lk.id, lk.pr_line_id, lk.rfq_id, r.rfq_no, r.title AS rfq_title, r.status AS rfq_status,
              lk.rfq_product_id, lk.quantity, lk.converted_by, lk.created_at,
              (r.status NOT IN (2,5) OR ${LIVE_PO_EXISTS('lk')}) AS is_live,
              COALESCE((
                SELECT json_agg(json_build_object('po_id', x.id, 'po_number', x.po_number, 'status', x.status) ORDER BY x.id)
                  FROM (SELECT DISTINCT po.id, po.po_number, po.status
                          FROM tbl_rfq_purchase_order po
                          JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
                         WHERE po.rfq_id = lk.rfq_id AND pop.rfq_product_id = lk.rfq_product_id) x
              ), '[]'::json) AS pos
         FROM tbl_pr_line_rfq lk
         JOIN tbl_purchase_requisition_line l ON l.id = lk.pr_line_id
         JOIN tbl_rfq r ON r.id = lk.rfq_id
        WHERE l.pr_id = $1
        ORDER BY lk.id`,
      [prId]
    );

    const reviews = await c.any(
      `SELECT rv.id, rv.revision, rv.department_id, d.title AS department_title, rv.status,
              rv.acted_by, u.name AS acted_by_name, rv.acted_at, rv.note, rv.self_reviewed, rv.created_at,
              COALESCE((SELECT json_agg(rl.pr_line_id ORDER BY rl.pr_line_id)
                          FROM tbl_pr_review_line rl WHERE rl.review_id = rv.id), '[]'::json) AS line_ids
         FROM tbl_pr_review rv
         LEFT JOIN tbl_department d ON d.id = rv.department_id
         LEFT JOIN tbl_users u ON u.id = rv.acted_by
        WHERE rv.pr_id = $1
        ORDER BY rv.revision DESC, d.title, rv.id`,
      [prId]
    );

    const events = await c.any(
      `SELECT e.id, e.pr_line_id, e.revision, e.actor_id, u.name AS actor_name, e.event_type, e.payload, e.created_at
         FROM tbl_pr_event e
         LEFT JOIN tbl_users u ON u.id = e.actor_id
        WHERE e.pr_id = $1
        ORDER BY e.id`,
      [prId]
    );

    const comments = await c.any(
      `SELECT cm.id, cm.author_id, u.name AS author_name, cm.body, cm.created_at
         FROM tbl_pr_comment cm
         LEFT JOIN tbl_users u ON u.id = cm.author_id
        WHERE cm.pr_id = $1
        ORDER BY cm.created_at, cm.id`,
      [prId]
    );

    const byLine = (rows) => {
      const m = new Map();
      for (const r of rows) {
        if (r.pr_line_id == null) continue;
        if (!m.has(r.pr_line_id)) m.set(r.pr_line_id, []);
        m.get(r.pr_line_id).push(r);
      }
      return m;
    };
    const clausesBy = byLine(clauses);
    const attachmentsBy = byLine(attachments);
    const linksBy = byLine(links);

    return {
      pr,
      lines: lines.map((l) => ({
        ...l,
        clauses: clausesBy.get(l.id) || [],
        attachments: attachmentsBy.get(l.id) || [],
        links: linksBy.get(l.id) || [],
      })),
      attachments: attachments.filter((a) => a.pr_line_id == null),
      reviews,
      events: events.map((e) => ({ ...e, id: Number(e.id) })),
      comments,
    };
  });
}

// ---------------------------------------------------------------------------
// Reference lookups + pickers
// ---------------------------------------------------------------------------

/** The hotel's own company (never the client's). null for unknown/deleted hotels. */
export async function hotelCell(hotelId, t = db) {
  return t.oneOrNone(
    `SELECT h.id AS hotel_id, h.hospitality_company_id
       FROM tbl_hospitality_company_hotels h
      WHERE h.id = $1 AND COALESCE(h.is_deleted, 0) = 0`,
    [hotelId]
  );
}

export async function departmentExists(departmentId, t = db) {
  const row = await t.one(`SELECT EXISTS (SELECT 1 FROM tbl_department WHERE id = $1) AS ok`, [departmentId]);
  return row.ok === true;
}

/** Of `categoryIds`, the ones that are active and not deleted. */
export async function activeCategoryIds(categoryIds, t = db) {
  const ids = [...new Set((categoryIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return new Set();
  const rows = await t.any(
    `SELECT id FROM tbl_category WHERE id = ANY($1::int[]) AND status = 1 AND is_deleted = 0`, [ids]);
  return new Set(rows.map((r) => Number(r.id)));
}

/** Hotels where the user holds pr.create on at least one department (create-form picker). */
export async function formHotels(userId, t = db) {
  return t.any(
    `SELECT DISTINCT h.id, h.name, h.city, h.hospitality_company_id
       FROM (${prGrantRowsSql('$1', 'create')}) g
       JOIN tbl_hospitality_company_hotels h
         ON h.hospitality_company_id = g.company_id
        AND (g.hotel_id IS NULL OR g.hotel_id = h.id)
      WHERE COALESCE(h.is_deleted, 0) = 0
      ORDER BY h.name, h.id`,
    [userId]
  );
}

/** Departments at the hotel where the user holds pr.create (a NULL-department grant = all). */
export async function formDepartments(userId, { companyId, hotelId }, t = db) {
  return t.any(
    `WITH g AS (${prGrantRowsSql('$1', 'create')})
     SELECT d.id, d.title
       FROM tbl_department d
      WHERE EXISTS (SELECT 1 FROM g
                     WHERE g.company_id = $2
                       AND (g.hotel_id IS NULL OR g.hotel_id = $3)
                       AND (g.department_id IS NULL OR g.department_id = d.id))
      ORDER BY d.title, d.id`,
    [userId, companyId, hotelId]
  );
}

const likePattern = (q) => `%${String(q).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** Usable catalog variants matching `q` (variant name, product name or slug), with their PR category. */
export async function searchItems({ q, limit = 25 }, t = db) {
  return t.any(
    `SELECT pv.id AS variant_id, pv.name AS variant_name, p.name AS product_name, pv.slug,
            cat.id AS category_id, cat.title AS category_title
       FROM tbl_product_variant pv
       JOIN tbl_product p ON p.id = pv.product_id
       JOIN tbl_category cat ON cat.id = ${FIRST_CATEGORY_SQL('p.id')}
      WHERE ${USABLE_VARIANT_SQL}
        AND (pv.name ILIKE $1 OR p.name ILIKE $1 OR pv.slug ILIKE $1)
      ORDER BY pv.name, pv.id
      LIMIT $2`,
    [likePattern(q), limit]
  );
}

/** Active, non-deleted categories (title match), top-level parent_id as null. */
export async function searchCategories({ q = '', limit = 50 }, t = db) {
  return t.any(
    `SELECT c.id, c.title, NULLIF(c.parent_id, 0) AS parent_id
       FROM tbl_category c
      WHERE c.status = 1 AND c.is_deleted = 0
        AND ($1 = '' OR c.title ILIKE $2)
      ORDER BY c.title, c.id
      LIMIT $3`,
    [q, likePattern(q), limit]
  );
}

export default {
  LIVE_PO_EXISTS, LIVE_LINK_EXISTS, LINE_PROGRESS_SQL, estimateTotalSql,
  istToday, nextPrNumber, insertPr, updateHeader, replaceLines, lockPr, getPrRow, copyPr, getDetail,
  hotelCell, departmentExists, activeCategoryIds, formHotels, formDepartments, searchItems, searchCategories,
};
