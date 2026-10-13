// Purchase Requisitions (PR) — database access layer.
//
// Raw, parameterised SQL only. Authorization lives in services/pr/prAccess.js
// and is applied by the controller BEFORE any of these run; nothing here trusts
// a client-supplied tenant id. Shared SQL fragments and constants come from the
// leaf module services/pr/prConstants.js (no business logic is imported here).
//
// Dates: required_by_date is a DATE. node-pg would parse it into a JS Date at
// the server's local midnight, which serialises as the PREVIOUS day in UTC for
// IST. Every read returns it as 'YYYY-MM-DD' text instead.

import db from '../../config/dbConn.js';
import {
  LIVE_PO_EXISTS, LIVE_LINK_EXISTS, LINE_PROGRESS_SQL, estimateTotalSql,
  IST_TODAY_SQL, USABLE_VARIANT_SQL, FIRST_CATEGORY_SQL, prGrantRowsSql,
  POOL_PROGRESSES, NO_REVIEWER_LABEL, NO_APPROVER_LABEL, REVIEWER_EXISTS_SQL,
} from '../../services/pr/prConstants.js';
import { readableScopeSql } from '../../services/pr/prAccess.js';

// Line progress + PR value fragments live in prConstants; re-exported here as
// the model's public SQL surface (lists, detail, pool, KPIs).
export { LIVE_PO_EXISTS, LIVE_LINK_EXISTS, LINE_PROGRESS_SQL, estimateTotalSql };

// Every column of the PR row, with required_by_date re-selected as text. The
// later column of the same name wins in node-pg's row object (pg/lib/result.js
// parseRow assigns fields in order), so `p.*` stays the single column list.
const PR_SELECT = (a) => `${a}.*, to_char(${a}.required_by_date, 'YYYY-MM-DD') AS required_by_date`;

// Header columns a caller may write through insertPr/updateHeader.
const WRITABLE_HEADER = [
  'title', 'pr_type', 'hospitality_company_id', 'hotel_id', 'department_id', 'urgency', 'required_by_date',
  'justification', 'delivery_location', 'status', 'revision', 'estimated_total', 'submitted_at', 'approved_at',
  'approval_instance_id', 'assigned_buyer_id', 'assigned_at', 'returned_note', 'cancelled_reason',
];

/** Today's calendar date in IST, 'YYYY-MM-DD' (session-timezone independent). */
export async function istToday(t = db) {
  const row = await t.one(`SELECT to_char(${IST_TODAY_SQL}, 'YYYY-MM-DD') AS d`);
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
     RETURNING ${PR_SELECT('p')}`,
    vals
  );
}

/** Patch whitelisted header columns; always bumps updated_at. */
export async function updateHeader(t, prId, patch) {
  const keys = WRITABLE_HEADER.filter((k) => patch[k] !== undefined);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  sets.push('updated_at = NOW()');
  return t.one(
    `UPDATE tbl_purchase_requisition p SET ${sets.join(', ')} WHERE p.id = $1 RETURNING ${PR_SELECT('p')}`,
    [prId, ...keys.map((k) => patch[k])]
  );
}

/** Ids of the PR's current lines. */
export async function lineIds(prId, t = db) {
  return t.map(`SELECT id FROM tbl_purchase_requisition_line WHERE pr_id = $1`, [prId], (r) => Number(r.id));
}

const LINE_RECORD = `line_no int, line_kind text, product_variant_id int, free_text_name text, category_id int,
              quantity text, uom text, estimated_unit_price text, specification text, suggested_vendor_note text`;

/**
 * Make the PR's lines exactly `lines`, in that order, PRESERVING LINE IDENTITY:
 *   - a line carrying `id` is updated in place, so its clauses, attachments and
 *     review links survive (the caller must have verified the id is one of this
 *     PR's lines — see lineIds; a stray id is refused here as a programming error);
 *   - a line without `id` is inserted;
 *   - a current line absent from `lines` is deleted, cascading its clauses,
 *     line attachments and review links.
 * Lines are renumbered 1..n in the given order. Quantities and money travel as
 * strings and are cast to NUMERIC in SQL, never through a JS float.
 * @returns {Promise<{kept: number, added: number, removed: number}>}
 */
export async function replaceLines(t, prId, lines) {
  const rows = lines.map((l, i) => ({
    id: l.id ?? null,
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
  const kept = rows.filter((r) => r.id != null);
  const added = rows.filter((r) => r.id == null);

  const removed = await t.result(
    `DELETE FROM tbl_purchase_requisition_line WHERE pr_id = $1 AND NOT (id = ANY($2::int[]))`,
    [prId, kept.map((r) => r.id)]);

  if (kept.length) {
    // Park the survivors on negative numbers first: UNIQUE (pr_id, line_no) is
    // checked row by row, so a reorder (1 ↔ 2) would collide mid-statement.
    await t.none(`UPDATE tbl_purchase_requisition_line SET line_no = -line_no WHERE pr_id = $1`, [prId]);
    const updated = await t.result(
      `UPDATE tbl_purchase_requisition_line l
          SET line_no = x.line_no, line_kind = x.line_kind,
              product_variant_id = x.product_variant_id, free_text_name = x.free_text_name,
              category_id = x.category_id, quantity = x.quantity::numeric, uom = x.uom,
              estimated_unit_price = x.estimated_unit_price::numeric,
              specification = x.specification, suggested_vendor_note = x.suggested_vendor_note,
              mapped_variant_id = CASE WHEN x.line_kind = 'catalog' THEN NULL ELSE l.mapped_variant_id END,
              mapped_by         = CASE WHEN x.line_kind = 'catalog' THEN NULL ELSE l.mapped_by END,
              mapped_at         = CASE WHEN x.line_kind = 'catalog' THEN NULL ELSE l.mapped_at END,
              updated_at = NOW()
         FROM jsonb_to_recordset($2::jsonb) AS x(id int, ${LINE_RECORD})
        WHERE l.pr_id = $1 AND l.id = x.id`,
      [prId, JSON.stringify(kept)]);
    if (updated.rowCount !== kept.length) {
      throw new Error(`replaceLines: ${kept.length - updated.rowCount} line id(s) do not belong to PR ${prId}`);
    }
  }

  if (added.length) {
    await t.none(
      `INSERT INTO tbl_purchase_requisition_line
         (pr_id, line_no, line_kind, product_variant_id, free_text_name, category_id,
          quantity, uom, estimated_unit_price, specification, suggested_vendor_note)
       SELECT $1, x.line_no, x.line_kind, x.product_variant_id, x.free_text_name, x.category_id,
              x.quantity::numeric, x.uom, x.estimated_unit_price::numeric, x.specification, x.suggested_vendor_note
         FROM jsonb_to_recordset($2::jsonb) AS x(${LINE_RECORD})
        ORDER BY x.line_no`,
      [prId, JSON.stringify(added)]);
  }

  return { kept: kept.length, added: added.length, removed: removed.rowCount };
}

/** Row-lock a PR for a state change. null if it does not exist. */
export async function lockPr(t, prId) {
  return t.oneOrNone(`SELECT ${PR_SELECT('p')} FROM tbl_purchase_requisition p WHERE p.id = $1 FOR UPDATE`, [prId]);
}

export async function getPrRow(prId, t = db) {
  return t.oneOrNone(`SELECT ${PR_SELECT('p')} FROM tbl_purchase_requisition p WHERE p.id = $1`, [prId]);
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
            GREATEST(s.required_by_date, ${IST_TODAY_SQL}), s.justification, s.delivery_location, $3
       FROM tbl_purchase_requisition s
      WHERE s.id = $1
     RETURNING ${PR_SELECT('p')}`,
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
      `SELECT ${PR_SELECT('p')},
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

// ---------------------------------------------------------------------------
// Listing, KPIs, duplicate hints (spec §4.2 derived progress, §8)
// ---------------------------------------------------------------------------
const sqlList = (arr) => arr.map((v) => `'${v}'`).join(', ');

/**
 * Header progress from the PR's line progress (spec §4.2). Lateral join that
 * exposes hp.header_progress; `p` = PR alias (must already be in FROM).
 *   not approved / no live line      → NULL
 *   nothing left to source or order  → completed (some closed) | ordered (all ordered)
 *   some ordered, others not done    → partly_ordered
 *   sourcing + pool                  → partly_in_sourcing
 *   only sourcing                    → in_sourcing
 *   only pool                        → in_queue
 * Cancelled lines are ignored; closed lines are terminal.
 */
const HEADER_PROGRESS_JOIN = (p) => `LEFT JOIN LATERAL (
  SELECT CASE
           WHEN ${p}.status <> 'approved' OR c.live = 0 THEN NULL
           WHEN c.pool + c.src = 0 THEN CASE WHEN c.closed > 0 THEN 'completed' ELSE 'ordered' END
           WHEN c.ord > 0 THEN 'partly_ordered'
           WHEN c.src > 0 AND c.pool > 0 THEN 'partly_in_sourcing'
           WHEN c.src > 0 THEN 'in_sourcing'
           ELSE 'in_queue' END AS header_progress
    FROM (SELECT count(*) FILTER (WHERE x.prog <> 'cancelled') AS live,
                 count(*) FILTER (WHERE x.prog IN (${sqlList(POOL_PROGRESSES)})) AS pool,
                 count(*) FILTER (WHERE x.prog = 'in_sourcing') AS src,
                 count(*) FILTER (WHERE x.prog = 'ordered') AS ord,
                 count(*) FILTER (WHERE x.prog = 'closed') AS closed
            FROM (SELECT ${LINE_PROGRESS_SQL('l', p)} AS prog
                    FROM tbl_purchase_requisition_line l WHERE l.pr_id = ${p}.id) x) c
) hp ON true`;

/** Who holds the PR right now, as the label shown in the list. `p` = PR alias. */
const NOW_WITH_SQL = (p) => `CASE ${p}.status
  WHEN 'draft' THEN 'You'
  WHEN 'returned' THEN 'You'
  WHEN 'approved' THEN COALESCE(
    (SELECT bu.name FROM tbl_users bu WHERE bu.id = ${p}.assigned_buyer_id), 'Purchase team')
  WHEN 'in_review' THEN (
    SELECT CASE
             WHEN count(*) = 0 THEN 'Technical review'
             WHEN count(*) FILTER (WHERE NOT z.elig) > 0
               THEN '${NO_REVIEWER_LABEL} (' || string_agg(z.title, ', ' ORDER BY z.title) FILTER (WHERE NOT z.elig) || ')'
             ELSE 'Technical review: ' || string_agg(z.title, ', ' ORDER BY z.title) END
      FROM (SELECT d.title, ${REVIEWER_EXISTS_SQL(p, 'rv')} AS elig
              FROM tbl_pr_review rv JOIN tbl_department d ON d.id = rv.department_id
             WHERE rv.pr_id = ${p}.id AND rv.revision = ${p}.revision AND rv.status = 'pending') z)
  WHEN 'pending_approval' THEN COALESCE((
    SELECT CASE WHEN a.n = 0 THEN '${NO_APPROVER_LABEL}'
                ELSE 'Approval step ' || a.step_order || ': ' || array_to_string(a.names[1:3], ', ')
                     || CASE WHEN a.n > 3 THEN ' +' || (a.n - 3) ELSE '' END END
      FROM (SELECT ai.current_step AS step_order, count(asa.id) AS n,
                   array_agg(u.name ORDER BY asa.id) FILTER (WHERE asa.id IS NOT NULL) AS names
              FROM tbl_approval_instances ai
              LEFT JOIN tbl_approval_instance_steps st
                     ON st.approval_instance_id = ai.id AND st.step_order = ai.current_step AND st.status = 'PENDING'
              LEFT JOIN tbl_approval_step_approvers asa
                     ON asa.approval_instance_step_id = st.id AND asa.status = 'PENDING' AND asa.removed_at IS NULL
              LEFT JOIN tbl_users u ON u.id = asa.approver_user_id
             WHERE ai.id = ${p}.approval_instance_id AND ai.entity_type = 'PR' AND ai.entity_id = ${p}.id
             GROUP BY ai.current_step) a), '${NO_APPROVER_LABEL}')
  ELSE NULL END`;

/**
 * WHERE fragment over PR alias p: readable scope (skipped for super admin, who
 * canReadPr() admits everywhere), the tab and the free-text search. $1 = user.
 */
function scopeWhere(user, { tab, q }, superAdmin) {
  const params = [user.id];
  const conds = [];
  if (tab === 'mine') conds.push('p.raised_by = $1');
  else if (!superAdmin) conds.push(readableScopeSql(user.id, 'p', 1).clause);
  if (q) {
    params.push(likePattern(q));
    const n = `$${params.length}`;
    conds.push(`(p.pr_number ILIKE ${n} OR p.title ILIKE ${n} OR EXISTS (
      SELECT 1 FROM tbl_purchase_requisition_line ql
        LEFT JOIN tbl_product_variant qpv ON qpv.id = COALESCE(ql.product_variant_id, ql.mapped_variant_id)
        LEFT JOIN tbl_product qprod ON qprod.id = qpv.product_id
       WHERE ql.pr_id = p.id
         AND (ql.free_text_name ILIKE ${n} OR qpv.name ILIKE ${n} OR qprod.name ILIKE ${n})))`);
  }
  return { conds, params };
}

/**
 * Paginated PR list + facet counts. `user` = req.user (scope is derived from it).
 * filters: { tab, status, hotelId, departmentId, prType, urgency, progress, q, page, pageSize }
 * Facets are over the tab+q+scope set only, so they never change with the
 * facet filters (MrAllPage semantics).
 */
export async function list(user, filters, superAdmin = false, t = db) {
  const { tab, q, page, pageSize } = filters;
  const base = scopeWhere(user, { tab, q }, superAdmin);
  const params = [...base.params];
  const conds = [...base.conds];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  if (filters.status) conds.push(`p.status = ${bind(filters.status)}`);
  if (filters.hotelId) conds.push(`p.hotel_id = ${bind(filters.hotelId)}`);
  if (filters.departmentId) conds.push(`p.department_id = ${bind(filters.departmentId)}`);
  if (filters.prType) conds.push(`p.pr_type = ${bind(filters.prType)}`);
  if (filters.urgency) conds.push(`p.urgency = ${bind(filters.urgency)}`);
  if (filters.progress) conds.push(`hp.header_progress = ${bind(filters.progress)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const innerJoin = filters.progress ? HEADER_PROGRESS_JOIN('p') : '';

  return t.task(async (c) => {
    const total = Number((await c.one(
      `SELECT count(*) AS n FROM tbl_purchase_requisition p ${innerJoin} ${where}`, params)).n);

    const limit = bind(pageSize);
    const offset = bind((page - 1) * pageSize);
    const rows = await c.any(
      `SELECT p.id, p.pr_number, p.title, p.status, hp.header_progress,
              h.name AS hotel_name, d.title AS department_name, ru.name AS raised_by_name,
              CASE WHEN p.status IN ('draft','returned') THEN ${estimateTotalSql('p')} ELSE p.estimated_total END
                AS estimated_total,
              (SELECT count(*)::int FROM tbl_purchase_requisition_line lc
                WHERE lc.pr_id = p.id AND lc.status = 'active') AS line_count,
              to_char(p.required_by_date, 'YYYY-MM-DD') AS required_by_date,
              p.urgency, p.pr_type, p.submitted_at, p.approved_at, p.created_at,
              ${NOW_WITH_SQL('p')} AS now_with
         FROM (SELECT p.* FROM tbl_purchase_requisition p ${innerJoin} ${where}
                ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit} OFFSET ${offset}) p
         ${HEADER_PROGRESS_JOIN('p')}
         LEFT JOIN tbl_hospitality_company_hotels h ON h.id = p.hotel_id
         LEFT JOIN tbl_department d ON d.id = p.department_id
         LEFT JOIN tbl_users ru ON ru.id = p.raised_by
        ORDER BY p.created_at DESC, p.id DESC`,
      params);

    const fw = base.conds.length ? `WHERE ${base.conds.join(' AND ')}` : '';
    const facetRows = await c.any(
      `WITH s AS (SELECT p.status, p.hotel_id, p.department_id, p.pr_type, p.urgency
                    FROM tbl_purchase_requisition p ${fw})
       SELECT 'status' AS k, status::text AS v, count(*)::int AS n FROM s GROUP BY status
       UNION ALL SELECT 'hotel', hotel_id::text, count(*)::int FROM s GROUP BY hotel_id
       UNION ALL SELECT 'department', department_id::text, count(*)::int FROM s GROUP BY department_id
       UNION ALL SELECT 'pr_type', pr_type::text, count(*)::int FROM s GROUP BY pr_type
       UNION ALL SELECT 'urgency', urgency::text, count(*)::int FROM s GROUP BY urgency`,
      base.params);
    const facets = { status: {}, hotel: {}, department: {}, pr_type: {}, urgency: {} };
    for (const f of facetRows) facets[f.k][f.v] = f.n;

    const labels = { hotel: {}, department: {} };
    const hotelIds = Object.keys(facets.hotel).map(Number);
    if (hotelIds.length) {
      for (const r of await c.any(`SELECT id, name FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[])`, [hotelIds])) {
        labels.hotel[r.id] = r.name;
      }
    }
    const deptIds = Object.keys(facets.department).map(Number);
    if (deptIds.length) {
      for (const r of await c.any(`SELECT id, title FROM tbl_department WHERE id = ANY($1::int[])`, [deptIds])) {
        labels.department[r.id] = r.title;
      }
    }
    return { rows, total, facets, facet_labels: labels };
  });
}

/**
 * Dashboard counters for the readable set.
 *   open               drafts + in review + pending approval + returned
 *   awaiting_me        pending reviews I am eligible for + PRs whose CURRENT approval
 *                      step has a PENDING row of mine + returned PRs I raised
 *   in_purchase_queue  approved PRs with at least one line waiting for the purchase team
 *   avg_days_to_approval  mean(approved_at - submitted_at) days, 1 decimal, approved in last 90 days
 */
export async function kpis(user, superAdmin = false, t = db) {
  const scope = superAdmin ? 'TRUE' : readableScopeSql(user.id, 'p', 1).clause;
  const row = await t.one(
    `SELECT
       count(*) FILTER (WHERE p.status IN ('draft','in_review','pending_approval','returned'))::int AS open,
       count(*) FILTER (WHERE p.status = 'approved' AND EXISTS (
         SELECT 1 FROM tbl_purchase_requisition_line l
          WHERE l.pr_id = p.id AND ${LINE_PROGRESS_SQL('l', 'p')} IN (${sqlList(POOL_PROGRESSES)})))::int AS in_purchase_queue,
       ROUND(AVG(EXTRACT(EPOCH FROM (p.approved_at - p.submitted_at)) / 86400.0)
             FILTER (WHERE p.status = 'approved' AND p.approved_at >= NOW() - INTERVAL '90 days'
                       AND p.submitted_at IS NOT NULL)::numeric, 1) AS avg_days_to_approval
       FROM tbl_purchase_requisition p
      WHERE ${scope}`,
    [user.id]);
  const awaiting = await t.one(
    `SELECT count(*)::int AS n FROM tbl_purchase_requisition p
      WHERE (p.status = 'returned' AND p.raised_by = $1)
         OR (p.status = 'in_review' AND EXISTS (
              SELECT 1 FROM tbl_pr_review rv
               WHERE rv.pr_id = p.id AND rv.revision = p.revision AND rv.status = 'pending'
                 AND EXISTS (SELECT 1 FROM (${prGrantRowsSql('$1', 'evaluate')}) g
                              WHERE g.company_id = p.hospitality_company_id
                                AND (g.hotel_id IS NULL OR g.hotel_id = p.hotel_id)
                                AND (g.department_id IS NULL OR g.department_id = rv.department_id))))
         OR (p.status = 'pending_approval' AND EXISTS (
              SELECT 1 FROM tbl_approval_instances ai
                JOIN tbl_approval_instance_steps st
                  ON st.approval_instance_id = ai.id AND st.step_order = ai.current_step AND st.status = 'PENDING'
                JOIN tbl_approval_step_approvers asa ON asa.approval_instance_step_id = st.id
               WHERE ai.id = p.approval_instance_id AND ai.entity_type = 'PR' AND ai.entity_id = p.id
                 AND ai.status = 'PENDING'
                 AND asa.approver_user_id = $1 AND asa.status = 'PENDING' AND asa.removed_at IS NULL))`,
    [user.id]);
  return {
    open: row.open,
    awaiting_me: awaiting.n,
    in_purchase_queue: row.in_purchase_queue,
    avg_days_to_approval: row.avg_days_to_approval === null ? null : Number(row.avg_days_to_approval),
  };
}

/**
 * Open PRs (same company, last 30 days, not terminal, an ACTIVE line whose
 * effective variant is `variantId`) and live RFQs containing the variant.
 * `readable` for PRs is the one list/point-read predicate; RFQ readability is
 * decided by the caller (it needs the rfq.read scope check). Titles are only
 * selected for readable rows — never leaked to others.
 */
export async function duplicates(user, { companyId, variantId }, superAdmin = false, t = db) {
  const readable = superAdmin ? 'TRUE' : readableScopeSql(user.id, 'p', 3).clause;
  const prs = await t.any(
    `SELECT p.id, p.pr_number AS number, h.name AS hotel_name, d.title AS department_name, p.created_at,
            CASE WHEN ${readable} THEN p.title END AS title,
            (${readable}) AS readable
       FROM tbl_purchase_requisition p
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = p.hotel_id
       LEFT JOIN tbl_department d ON d.id = p.department_id
      WHERE p.hospitality_company_id = $1
        AND p.status <> 'rejected' AND p.status <> 'cancelled'
        AND p.created_at >= NOW() - INTERVAL '30 days'
        AND EXISTS (SELECT 1 FROM tbl_purchase_requisition_line l
                     WHERE l.pr_id = p.id AND l.status = 'active'
                       AND COALESCE(l.product_variant_id, l.mapped_variant_id) = $2)
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 50`,
    [companyId, variantId, user.id]);
  const rfqs = await t.any(
    `SELECT r.id, r.rfq_no AS number, r.title, r."timestamp" AS created_at, r.created_by,
            r.hospitality_company_id, r.hotel_id, r.department_id, r.process_id,
            h.name AS hotel_name, d.title AS department_name
       FROM tbl_rfq r
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = r.hotel_id
       LEFT JOIN tbl_department d ON d.id = r.department_id
      WHERE r.hospitality_company_id = $1
        AND r.status NOT IN (2, 5)
        AND r."timestamp" >= NOW() - INTERVAL '30 days'
        AND EXISTS (SELECT 1 FROM tbl_rfq_products rp WHERE rp.rfq_id = r.id AND rp.product_variant_id = $2)
      ORDER BY r."timestamp" DESC, r.id DESC
      LIMIT 50`,
    [companyId, variantId]);
  return { prs, rfqs };
}

export default {
  LIVE_PO_EXISTS, LIVE_LINK_EXISTS, LINE_PROGRESS_SQL, estimateTotalSql,
  istToday, nextPrNumber, insertPr, updateHeader, lineIds, replaceLines, lockPr, getPrRow, copyPr, getDetail,
  list, kpis, duplicates, hotelCell, departmentExists, activeCategoryIds, formHotels, formDepartments, searchItems, searchCategories,
};
