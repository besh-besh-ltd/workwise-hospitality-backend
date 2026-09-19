// ============================================================================
// reportsModel.js
// ----------------------------------------------------------------------------
// Read-only query layer for the Reports module.
//
// SECURITY: every query ANDs buildScopeClause() from ./scope/poScope.js — the
// same predicate the PO dashboard uses, not a copy of it. Tenant identity is
// derived from req.user in the controller and never read from the body or
// query; headers narrow an already-scoped set and can never widen it.
//
// ── Two decisions that every spend query in here depends on ────────────────
//
// 1. WHAT COUNTS AS SPEND. A PO is spend once it has cleared internal
//    approval. Drafts, pending approvals and anything rejected or cancelled
//    are commitments that never happened, and including them would make the
//    reports disagree with finance on the first row. SPEND_STATUSES is the
//    single definition; it matches the "approved" bucket the PO dashboard
//    already shows.
//
// 2. HOW A PO LINE REACHES A CATEGORY. tbl_product_categories maps a product
//    to BOTH its parent and its leaf category — 11,405 of 11,500 products in
//    staging have exactly two rows. Joining through it naively counts every
//    rupee twice: measured on staging, true spend Rs 7,36,29,816 reports as
//    Rs 15,09,11,261. LEAF_CATEGORY_JOIN picks exactly one category per line
//    and is the only sanctioned way to get from a line to a category.
//    Note top-level categories carry parent_id = 0, not NULL.
// ============================================================================

import db from "../config/dbConn.js";
import { buildScopeClause } from "./scope/poScope.js";

/**
 * Statuses that represent committed spend.
 *
 * Deliberately excludes draft / pending_approval / acceptance_pending (not yet
 * committed) and rejected / rejected_by_vendor / cancelled (never happened).
 */
export const SPEND_STATUSES = [
  "approved",
  "sent",
  "invoice_raised",
  "dispatched",
  "GRN",
  "completed",
];

/** Rows above this are built in the background rather than streamed inline. */
export const SYNC_ROW_LIMIT = 2000;

/** Hard ceiling on any single report, background or not. */
export const REPORT_ROW_CAP = 50000;

/**
 * Exactly one category per PO line, preferring the leaf over its parent.
 *
 * Requires `pv` (tbl_product_variant) in scope. See the double-count note at
 * the top of this file — do not reach a category any other way.
 */
const LEAF_CATEGORY_JOIN = `
  LEFT JOIN LATERAL (
    SELECT c.id, c.title, c.parent_id
      FROM tbl_product_categories pc
      JOIN tbl_category c ON c.id = pc.category_id
     WHERE pc.product_id = pv.product_id
       AND COALESCE(c.is_deleted, 0) = 0
     ORDER BY (COALESCE(c.parent_id, 0) <> 0) DESC, c.id
     LIMIT 1
  ) cat ON TRUE`;

/**
 * A vendor's display name.
 *
 * organization_name is dead in practice (7 of 91 vendors in staging carry it)
 * while every vendor resolves through tbl_company, so the company name leads.
 * `name` is the last resort so a row can never render blank.
 */
const VENDOR_NAME = `COALESCE(NULLIF(TRIM(vc.company_name), ''),
                              NULLIF(TRIM(v.organization_name), ''),
                              v.name)`;

/**
 * The FROM/JOIN/WHERE skeleton shared by the spend reports.
 *
 * `values` is mutated with the bound parameters. Returns the SQL plus the next
 * free placeholder index so callers can keep binding.
 */
function spendBase(scope, { from, to }, values, startIndex) {
  let i = startIndex;

  const fromIdx = i++;
  values.push(from);
  const toIdx = i++;
  values.push(to);
  const statusIdx = i++;
  values.push(SPEND_STATUSES);

  const scoped = buildScopeClause(scope, values, i);
  i = scoped.nextIndex;

  // The FY window is Indian wall-clock; created_at is an absolute instant.
  // Comparing the two without AT TIME ZONE moves every boundary by 5h30m and
  // silently files the first evening of April into the previous year.
  const where = `
      po.status = ANY($${statusIdx}::po_status[])
      AND po.created_at >= ($${fromIdx}::date AT TIME ZONE 'Asia/Kolkata')
      AND po.created_at <  ($${toIdx}::date  AT TIME ZONE 'Asia/Kolkata')
      AND ${scoped.clause}`;

  return { where, nextIndex: i };
}

/**
 * Report 1.4 — Spend by Vendor.
 *
 * One row per vendor that transacted in the window, with the prior-year
 * comparison, the vendor's largest category, and whether they are MSME
 * (which carries a 45-day payment obligation under MSMED Act s.15) or on an
 * active rate contract.
 *
 * Share % and cumulative % are computed by the caller from these amounts so
 * the Pareto cut and the sheet always agree.
 */
export async function spendByVendor(scope, { from, to, priorFrom, priorTo }) {
  const values = [];
  let i = 1;

  const cur = spendBase(scope, { from, to }, values, i);
  i = cur.nextIndex;
  const prev = spendBase(scope, { from: priorFrom, to: priorTo }, values, i);
  i = prev.nextIndex;

  const sql = `
    WITH current_spend AS (
      SELECT po.finalized_vendor_id       AS vendor_id,
             SUM(pop.total_price)         AS amount,
             COUNT(DISTINCT po.id)        AS po_count,
             MAX(po.created_at)           AS last_po_at
        FROM tbl_rfq_purchase_order po
        JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
        LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
       WHERE ${cur.where}
       GROUP BY 1
    ),
    prior_spend AS (
      SELECT po.finalized_vendor_id AS vendor_id,
             SUM(pop.total_price)   AS amount
        FROM tbl_rfq_purchase_order po
        JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
        LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
       WHERE ${prev.where}
       GROUP BY 1
    ),
    -- The vendor's largest category this window. One category per line via
    -- LEAF_CATEGORY_JOIN, so this cannot double-count.
    vendor_category AS (
      SELECT vendor_id, title
        FROM (
          SELECT po.finalized_vendor_id AS vendor_id,
                 cat.title,
                 SUM(pop.total_price) AS amount,
                 ROW_NUMBER() OVER (
                   PARTITION BY po.finalized_vendor_id
                   ORDER BY SUM(pop.total_price) DESC NULLS LAST, cat.title
                 ) AS rn
            FROM tbl_rfq_purchase_order po
            JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
            LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
            LEFT JOIN tbl_product_variant pv ON pv.id = pop.product_variant_id
            ${LEAF_CATEGORY_JOIN}
           WHERE ${cur.where}
             AND cat.title IS NOT NULL
           GROUP BY 1, 2
        ) ranked
       WHERE rn = 1
    )
    SELECT cs.vendor_id,
           ${VENDOR_NAME}                      AS vendor_name,
           vc.gstin                            AS gstin,
           vcat.title                          AS primary_category,
           cs.amount::float8                   AS amount,
           cs.po_count::int                    AS po_count,
           cs.last_po_at                       AS last_po_at,
           ps.amount::float8                   AS prior_amount,
           EXISTS (
             SELECT 1 FROM tbl_vendor_documents vd
              WHERE vd.vendor_id = cs.vendor_id AND vd.document_type = 'msme'
           )                                   AS is_msme,
           EXISTS (
             SELECT 1 FROM tbl_arc_contract ac
              WHERE ac.vendor_id = cs.vendor_id
                AND ac.status NOT IN ('terminated', 'expired')
           )                                   AS on_contract
      FROM current_spend cs
      JOIN tbl_users v ON v.id = cs.vendor_id
      LEFT JOIN tbl_company vc ON vc.id = v.company_id
      LEFT JOIN prior_spend ps ON ps.vendor_id = cs.vendor_id
      LEFT JOIN vendor_category vcat ON vcat.vendor_id = cs.vendor_id
     WHERE cs.amount IS NOT NULL AND cs.amount <> 0
     ORDER BY cs.amount DESC
     LIMIT ${REPORT_ROW_CAP}`;

  return db.any(sql, values);
}

/**
 * Row estimate for the sync-vs-background decision. Counts vendors, which is
 * what spendByVendor returns one row per.
 */
export async function spendByVendorRowEstimate(scope, { from, to }) {
  const values = [];
  const base = spendBase(scope, { from, to }, values, 1);
  const row = await db.one(
    `SELECT COUNT(DISTINCT po.finalized_vendor_id)::int AS n
       FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
      WHERE ${base.where}`,
    values
  );
  return row.n;
}

/**
 * Report 1.1 sheet 1 — spend per calendar month across the window, with the
 * same month of the prior year beside it.
 *
 * generate_series drives the rows rather than the data, so a month with no
 * spend appears as a zero instead of silently vanishing and making a 12-month
 * report render 9 rows.
 */
export async function spendByMonth(scope, { from, to, priorFrom, priorTo }) {
  const values = [];
  let i = 1;
  const cur = spendBase(scope, { from, to }, values, i);
  i = cur.nextIndex;
  const prev = spendBase(scope, { from: priorFrom, to: priorTo }, values, i);
  i = prev.nextIndex;

  const fromIdx = i++;
  values.push(from);
  const toIdx = i++;
  values.push(to);

  const monthExpr = (alias) =>
    `date_trunc('month', ${alias}.created_at AT TIME ZONE 'Asia/Kolkata')`;

  return db.any(
    `WITH months AS (
       SELECT generate_series(
                $${fromIdx}::date,
                ($${toIdx}::date - INTERVAL '1 day'),
                INTERVAL '1 month'
              )::date AS month_start
     ),
     cur AS (
       SELECT ${monthExpr("po")} AS m, SUM(pop.total_price) AS amount
         FROM tbl_rfq_purchase_order po
         JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
         LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
        WHERE ${cur.where}
        GROUP BY 1
     ),
     prev AS (
       -- Shifted forward a year so it lines up with the current month on the
       -- same row; the comparison is like-for-like month, not a running total.
       SELECT (${monthExpr("po")} + INTERVAL '1 year') AS m,
              SUM(pop.total_price) AS amount
         FROM tbl_rfq_purchase_order po
         JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
         LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
        WHERE ${prev.where}
        GROUP BY 1
     )
     SELECT m.month_start,
            COALESCE(c.amount, 0)::float8 AS amount,
            COALESCE(p.amount, 0)::float8 AS prior_amount
       FROM months m
       LEFT JOIN cur  c ON c.m = m.month_start
       LEFT JOIN prev p ON p.m = m.month_start
      ORDER BY m.month_start`,
    values
  );
}

/** Report 1.1 sheet 2 — spend per property, with the prior period beside it. */
export async function spendByProperty(scope, { from, to, priorFrom, priorTo }) {
  const values = [];
  let i = 1;
  const cur = spendBase(scope, { from, to }, values, i);
  i = cur.nextIndex;
  const prev = spendBase(scope, { from: priorFrom, to: priorTo }, values, i);
  i = prev.nextIndex;

  // A PO reaches its property through the RFQ, or through the MR for a
  // call-off. COALESCE over both or the call-offs silently disappear.
  const hotelExpr = `COALESCE(rfq.hotel_id, mr.hotel_id)`;
  const joinMr = `LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id`;

  return db.any(
    `WITH cur AS (
       SELECT ${hotelExpr} AS hotel_id,
              SUM(pop.total_price) AS amount,
              COUNT(DISTINCT po.id) AS po_count
         FROM tbl_rfq_purchase_order po
         JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
         LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
         ${joinMr}
        WHERE ${cur.where}
        GROUP BY 1
     ),
     prev AS (
       SELECT ${hotelExpr} AS hotel_id, SUM(pop.total_price) AS amount
         FROM tbl_rfq_purchase_order po
         JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
         LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
         ${joinMr}
        WHERE ${prev.where}
        GROUP BY 1
     )
     SELECT c.hotel_id,
            h.name  AS hotel_name,
            h.city  AS city,
            NULLIF(h.keys, 0) AS keys,
            c.amount::float8       AS amount,
            c.po_count::int        AS po_count,
            p.amount::float8       AS prior_amount
       FROM cur c
       LEFT JOIN tbl_hospitality_company_hotels h ON h.id = c.hotel_id
       LEFT JOIN prev p ON p.hotel_id = c.hotel_id
      WHERE c.amount IS NOT NULL AND c.amount <> 0
      ORDER BY c.amount DESC
      LIMIT ${REPORT_ROW_CAP}`,
    values
  );
}

/**
 * Report 1.1 sheet 3 / report 1.2 — spend per category.
 *
 * `level` picks the grain: "parent" rolls every leaf up to its top-level
 * category, "leaf" reports the leaf itself. Either way each PO line is counted
 * exactly once — see LEAF_CATEGORY_JOIN.
 */
export async function spendByCategory(scope, { from, to, priorFrom, priorTo }, { level = "parent" } = {}) {
  const values = [];
  let i = 1;
  const cur = spendBase(scope, { from, to }, values, i);
  i = cur.nextIndex;
  const prev = spendBase(scope, { from: priorFrom, to: priorTo }, values, i);
  i = prev.nextIndex;

  // parent_id = 0 marks a top-level category in this schema — not NULL.
  const groupExpr =
    level === "parent"
      ? `COALESCE(NULLIF(cat.parent_id, 0), cat.id)`
      : `cat.id`;

  const block = (whereClause) => `
       SELECT ${groupExpr} AS category_id,
              SUM(pop.total_price) AS amount,
              COUNT(DISTINCT po.finalized_vendor_id) AS vendor_count,
              COUNT(DISTINCT po.id) AS po_count
         FROM tbl_rfq_purchase_order po
         JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
         LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
         LEFT JOIN tbl_product_variant pv ON pv.id = pop.product_variant_id
         ${LEAF_CATEGORY_JOIN}
        WHERE ${whereClause}
          AND cat.id IS NOT NULL
        GROUP BY 1`;

  return db.any(
    `WITH cur AS (${block(cur.where)}),
          prev AS (${block(prev.where)})
     SELECT c.category_id,
            cc.title               AS category,
            pc.title               AS parent_category,
            c.amount::float8       AS amount,
            c.vendor_count::int    AS vendor_count,
            c.po_count::int        AS po_count,
            p.amount::float8       AS prior_amount
       FROM cur c
       LEFT JOIN tbl_category cc ON cc.id = c.category_id
       LEFT JOIN tbl_category pc ON pc.id = NULLIF(cc.parent_id, 0)
       LEFT JOIN prev p ON p.category_id = c.category_id
      WHERE c.amount IS NOT NULL AND c.amount <> 0
      ORDER BY c.amount DESC
      LIMIT ${REPORT_ROW_CAP}`,
    values
  );
}

/** Headline totals for the period and the one before it. */
export async function spendTotals(scope, { from, to, priorFrom, priorTo }) {
  const values = [];
  let i = 1;
  const cur = spendBase(scope, { from, to }, values, i);
  i = cur.nextIndex;
  const prev = spendBase(scope, { from: priorFrom, to: priorTo }, values, i);
  i = prev.nextIndex;

  return db.one(
    `SELECT
       (SELECT COALESCE(SUM(pop.total_price), 0)::float8
          FROM tbl_rfq_purchase_order po
          JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
          LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
         WHERE ${cur.where}) AS amount,
       (SELECT COALESCE(SUM(pop.total_price), 0)::float8
          FROM tbl_rfq_purchase_order po
          JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
          LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
         WHERE ${prev.where}) AS prior_amount`,
    values
  );
}

// ---------------------------------------------------------------------------
// Entitlement
// ---------------------------------------------------------------------------

/**
 * The `reports.*` actions this user holds, in any of their role scopes.
 *
 * This is the "may you run this report at all" gate and is deliberately
 * scope-blind: holding `reports.spend_by_vendor` for one hotel entitles you to
 * the report, and the row-level predicate then decides which hotels' rows
 * appear in it. Conflating the two would mean a user with access to one of
 * twelve properties could not open the report at all.
 *
 * `resource::text` rather than the enum literal so this keeps working if the
 * code deploys ahead of its migration — the same defensive cast
 * middleware/companyAdmin.js uses for `company.admin`.
 */
export async function permittedReportActions(userId) {
  const rows = await db.any(
    `SELECT DISTINCT p.action::text AS action
       FROM tbl_user_role_scopes urs
       JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE urs.user_id = $1
        AND p.resource::text = 'reports'`,
    [userId]
  );
  return new Set(rows.map((r) => r.action));
}

// ---------------------------------------------------------------------------
// Export ledger
// ---------------------------------------------------------------------------

/**
 * Record that a report was produced.
 *
 * Written for synchronous downloads too, where there is no job to track: the
 * row exists to answer "who pulled this, when, with which filters", which is
 * an audit question, not a queue one.
 */
export async function recordExport({
  reportKey,
  requestedBy,
  hospitalityCompanyId,
  hotelIds = [],
  filters = {},
  mode = "SYNC",
  status = "READY",
  rowCount = null,
}) {
  return db.one(
    `INSERT INTO tbl_report_exports
       (report_key, requested_by, hospitality_company_id, hotel_ids, filters,
        mode, status, row_count, completed_at)
     VALUES ($1, $2, $3, $4::int[], $5::jsonb, $6, $7, $8,
             CASE WHEN $7 = 'READY' THEN now() ELSE NULL END)
     RETURNING id, created_at`,
    [
      reportKey,
      requestedBy,
      hospitalityCompanyId,
      hotelIds,
      JSON.stringify(filters || {}),
      mode,
      status,
      rowCount,
    ]
  );
}

/** The caller's own export history. Never another user's. */
export async function listExports(userId, limit = 50) {
  return db.any(
    `SELECT id, report_key, filters, mode, status, row_count, file_size,
            created_at, completed_at, error
       FROM tbl_report_exports
      WHERE requested_by = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)]
  );
}

export default {
  SPEND_STATUSES,
  SYNC_ROW_LIMIT,
  REPORT_ROW_CAP,
  spendByVendor,
  spendByVendorRowEstimate,
  spendByMonth,
  spendByProperty,
  spendByCategory,
  spendTotals,
  permittedReportActions,
  recordExport,
  listExports,
};
