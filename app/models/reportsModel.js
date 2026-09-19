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

/**
 * Report 1.2 sheet 3 — the category x property grid, returned long rather than
 * pivoted. Pivoting in SQL would mean building the column list dynamically
 * from data, which is how a report query becomes an injection surface; the
 * definition reshapes it instead.
 */
export async function spendByCategoryProperty(scope, { from, to }, { level = "parent" } = {}) {
  const values = [];
  const base = spendBase(scope, { from, to }, values, 1);

  const groupExpr =
    level === "parent" ? `COALESCE(NULLIF(cat.parent_id, 0), cat.id)` : `cat.id`;

  return db.any(
    `SELECT ${groupExpr}                        AS category_id,
            cc.title                            AS category,
            COALESCE(rfq.hotel_id, mr.hotel_id) AS hotel_id,
            h.name                              AS hotel_name,
            SUM(pop.total_price)::float8        AS amount
       FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
       LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
       LEFT JOIN tbl_product_variant pv ON pv.id = pop.product_variant_id
       ${LEAF_CATEGORY_JOIN}
       LEFT JOIN tbl_category cc ON cc.id = ${groupExpr}
       LEFT JOIN tbl_hospitality_company_hotels h
              ON h.id = COALESCE(rfq.hotel_id, mr.hotel_id)
      WHERE ${base.where}
        AND cat.id IS NOT NULL
      GROUP BY 1, 2, 3, 4
      ORDER BY 2, 4
      LIMIT ${REPORT_ROW_CAP}`,
    values
  );
}

/**
 * Report 1.3 sheet 3 — items bought at materially different rates across
 * properties.
 *
 * The rate is derived as value / quantity per property rather than read off
 * unit_price, because a line's unit_price does not carry the charges folded
 * into its total, and the number a buyer can act on is what was actually paid
 * per unit. Items bought at only one property are excluded — there is nothing
 * to compare — as are zero quantities, which would divide by zero.
 */
export async function interPropertyRateVariance(
  scope,
  { from, to },
  { minProperties = 2, minSpread = 0.1 } = {}
) {
  const values = [];
  const base = spendBase(scope, { from, to }, values, 1);
  const minPropsIdx = base.nextIndex;
  values.push(minProperties);
  const minSpreadIdx = minPropsIdx + 1;
  values.push(minSpread);

  return db.any(
    `WITH per_property AS (
       -- Keyed on the UNIT as well as the item. Without that, a variant bought
       -- in boxes at one property and in pieces at another compares directly
       -- and reports an 86x "rate variance" that is really a unit mismatch —
       -- observed on staging before this was added.
       SELECT pop.product_variant_id                AS variant_id,
              LOWER(TRIM(pop.unit))                 AS unit,
              COALESCE(rfq.hotel_id, mr.hotel_id)   AS hotel_id,
              SUM(pop.total_price)                  AS value,
              SUM(pop.quantity)                     AS qty
         FROM tbl_rfq_purchase_order po
         JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
         LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
         LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
        WHERE ${base.where}
          AND pop.product_variant_id IS NOT NULL
        GROUP BY 1, 2, 3
       HAVING SUM(pop.quantity) > 0
     ),
     rated AS (
       SELECT variant_id, unit, hotel_id, value, qty, (value / qty) AS unit_rate
         FROM per_property
     ),
     spread AS (
       SELECT variant_id,
              unit,
              COUNT(DISTINCT hotel_id)      AS properties,
              MIN(unit_rate)                AS min_rate,
              MAX(unit_rate)                AS max_rate,
              SUM(value)                    AS total_value,
              SUM(qty)                      AS total_qty,
              (SUM(value) / NULLIF(SUM(qty), 0)) AS wtd_avg_rate
         FROM rated
        GROUP BY 1, 2
       HAVING COUNT(DISTINCT hotel_id) >= $${minPropsIdx}
          AND MIN(unit_rate) > 0
          -- Only report a gap worth acting on. The approved sample uses the
          -- same 10% floor.
          AND (MAX(unit_rate) - MIN(unit_rate)) / MIN(unit_rate) >= $${minSpreadIdx}
     )
     SELECT s.variant_id,
            COALESCE(NULLIF(TRIM(pv.name), ''), p.name, 'Item ' || s.variant_id) AS item_name,
            s.unit                    AS unit,
            s.properties::int         AS properties,
            s.min_rate::float8        AS min_rate,
            s.max_rate::float8        AS max_rate,
            s.wtd_avg_rate::float8    AS wtd_avg_rate,
            s.total_value::float8     AS total_value,
            s.total_qty::float8       AS total_qty,
            -- What buying everything at the cheapest observed rate would have
            -- cost less. An upper bound, not a promise: it assumes the low
            -- rate was available everywhere.
            (s.total_value - (s.min_rate * s.total_qty))::float8 AS save_potential
       FROM spread s
       LEFT JOIN tbl_product_variant pv ON pv.id = s.variant_id
       LEFT JOIN tbl_product p ON p.id = pv.product_id
      ORDER BY (s.total_value - (s.min_rate * s.total_qty)) DESC
      LIMIT 200`,
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
// Purchase orders and approvals
//
// TIMESTAMP CONTRACT — read before touching anything below.
//
// The approval tables are `timestamp without time zone` holding UTC, and
// dbConn.js sets a type parser that hands them to Node as RAW STRINGS rather
// than Dates. Any elapsed time must therefore be computed in SQL; doing it in
// JavaScript means parsing a naive string in the server's local zone, which is
// wrong by the local offset and silently correct on a UTC box.
//
// "Now" for those columns is NOW() AT TIME ZONE 'UTC' — a naive UTC timestamp
// comparable with the column. NOW() alone is a timestamptz and comparing the
// two makes Postgres coerce, not convert.
//
// tbl_rfq_purchase_order.created_at, by contrast, IS timestamptz. Different
// table, different rule.
// ---------------------------------------------------------------------------

/** Statuses where an order is raised but not yet closed out. */
export const OPEN_PO_STATUSES = ["approved", "sent", "dispatched", "invoice_raised", "acceptance_pending"];

/**
 * The PO-level scope skeleton, without the spend window or status filter —
 * PO-operational reports ask "what is open right now", not "what did we spend".
 */
function poBase(scope, values, startIndex) {
  const scoped = buildScopeClause(scope, values, startIndex);
  return { where: scoped.clause, nextIndex: scoped.nextIndex };
}

/**
 * Report 3.1 — every open purchase order with its age.
 *
 * Age is measured from the PO date. The approved sample ages against an
 * expected delivery date and shows how much of each order is still
 * outstanding; neither exists here — there is no promised-delivery column and
 * no goods-receipt quantity anywhere — so the column is labelled "Days Open"
 * rather than implying a missed delivery that was never scheduled.
 */
export async function openPoRegister(scope) {
  const values = [];
  let i = 1;
  const statusIdx = i++;
  values.push(OPEN_PO_STATUSES);
  const base = poBase(scope, values, i);

  return db.any(
    `SELECT po.id,
            po.po_number,
            po.created_at,
            po.status::text                         AS status,
            po.total_value::float8                  AS total_value,
            h.name                                  AS hotel_name,
            d.title                                 AS department,
            ${VENDOR_NAME}                          AS vendor_name,
            rfq.rfq_no                              AS rfq_no,
            (EXTRACT(EPOCH FROM (NOW() - po.created_at)) / 86400.0)::int AS days_open
       FROM tbl_rfq_purchase_order po
       LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
       LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
       LEFT JOIN tbl_hospitality_company_hotels h
              ON h.id = COALESCE(rfq.hotel_id, mr.hotel_id)
       LEFT JOIN tbl_department d
              ON d.id = COALESCE(rfq.department_id, mr.department_id)
       LEFT JOIN tbl_users v  ON v.id = po.finalized_vendor_id
       LEFT JOIN tbl_company vc ON vc.id = v.company_id
      WHERE po.status = ANY($${statusIdx}::po_status[])
        AND ${base.where}
      ORDER BY po.created_at ASC
      LIMIT ${REPORT_ROW_CAP}`,
    values
  );
}

/**
 * Report 3.2 — approvals still waiting, and who they are waiting on.
 *
 * One row per (pending approver, pending step). A step with decision rule ANY
 * lists every approver who could act, because any one of them is the
 * bottleneck until somebody does.
 */
export async function pendingPoApprovals(scope) {
  const values = [];
  const base = poBase(scope, values, 1);

  return db.any(
    `SELECT po.id                                   AS po_id,
            po.po_number,
            po.total_value::float8                  AS total_value,
            po.created_at                           AS po_created_at,
            h.name                                  AS hotel_name,
            d.title                                 AS department,
            ${VENDOR_NAME}                          AS vendor_name,
            s.step_order::int                       AS step_order,
            s.decision_rule                         AS decision_rule,
            s.created_at                            AS step_opened_at,
            ps.sla_hours::int                       AS sla_hours,
            a.approver_user_id                      AS approver_id,
            au.name                                 AS approver_name,
            au.designation                          AS approver_designation,
            (EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - s.created_at)) / 3600.0)::float8
                                                    AS hours_pending
       FROM tbl_approval_instances ai
       JOIN tbl_rfq_purchase_order po
              ON po.id = ai.entity_id AND ai.entity_type = 'PO'
       JOIN tbl_approval_instance_steps s
              ON s.approval_instance_id = ai.id AND s.status = 'PENDING'
       JOIN tbl_approval_step_approvers a
              ON a.approval_instance_step_id = s.id AND a.status = 'PENDING'
       LEFT JOIN tbl_approval_policy_steps ps ON ps.id = s.policy_step_id
       LEFT JOIN tbl_users au ON au.id = a.approver_user_id
       LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
       LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
       LEFT JOIN tbl_hospitality_company_hotels h
              ON h.id = COALESCE(rfq.hotel_id, mr.hotel_id)
       LEFT JOIN tbl_department d
              ON d.id = COALESCE(rfq.department_id, mr.department_id)
       LEFT JOIN tbl_users v  ON v.id = po.finalized_vendor_id
       LEFT JOIN tbl_company vc ON vc.id = v.company_id
      WHERE ai.status = 'PENDING'
        AND ${base.where}
      ORDER BY s.created_at ASC
      LIMIT ${REPORT_ROW_CAP}`,
    values
  );
}

/**
 * Report 6.1 — turnaround on approvals that COMPLETED in the window.
 *
 * Measured on completed instances only: a still-pending approval has no
 * turnaround yet, and counting its elapsed time as a TAT would drag the
 * average towards whatever is currently stuck.
 */
export async function poApprovalTat(scope, { from, to }) {
  const values = [];
  let i = 1;
  const fromIdx = i++;
  values.push(from);
  const toIdx = i++;
  values.push(to);
  const base = poBase(scope, values, i);

  return db.any(
    `SELECT ai.id                                   AS instance_id,
            po.id                                   AS po_id,
            po.po_number,
            po.total_value::float8                  AS total_value,
            ai.status                               AS status,
            ai.created_at                           AS submitted_at,
            ai.completed_at                         AS completed_at,
            (EXTRACT(EPOCH FROM (ai.completed_at - ai.created_at)) / 3600.0)::float8 AS tat_hours
       FROM tbl_approval_instances ai
       JOIN tbl_rfq_purchase_order po
              ON po.id = ai.entity_id AND ai.entity_type = 'PO'
       LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
       LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
      WHERE ai.completed_at IS NOT NULL
        AND ai.completed_at >= (($${fromIdx}::date AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'UTC')
        AND ai.completed_at <  (($${toIdx}::date  AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'UTC')
        AND ${base.where}
      ORDER BY ai.completed_at DESC
      LIMIT ${REPORT_ROW_CAP}`,
    values
  );
}

/** Report 6.1 sheet 2 — per-approver decision time over the same window. */
export async function poApprovalTatByApprover(scope, { from, to }) {
  const values = [];
  let i = 1;
  const fromIdx = i++;
  values.push(from);
  const toIdx = i++;
  values.push(to);
  const base = poBase(scope, values, i);

  return db.any(
    `SELECT a.approver_user_id                      AS approver_id,
            au.name                                 AS approver_name,
            au.designation                          AS approver_designation,
            s.step_order::int                       AS step_order,
            COUNT(*)::int                           AS decisions,
            AVG(EXTRACT(EPOCH FROM (a.acted_at - s.created_at)) / 3600.0)::float8 AS avg_hours,
            PERCENTILE_CONT(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (a.acted_at - s.created_at)) / 3600.0
            )::float8                               AS median_hours,
            PERCENTILE_CONT(0.9) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (a.acted_at - s.created_at)) / 3600.0
            )::float8                               AS p90_hours,
            MAX(ps.sla_hours)::int                  AS sla_hours,
            COUNT(*) FILTER (
              WHERE ps.sla_hours IS NOT NULL
                AND EXTRACT(EPOCH FROM (a.acted_at - s.created_at)) / 3600.0 > ps.sla_hours
            )::int                                  AS breaches
       FROM tbl_approval_step_approvers a
       JOIN tbl_approval_instance_steps s ON s.id = a.approval_instance_step_id
       JOIN tbl_approval_instances ai ON ai.id = s.approval_instance_id
       JOIN tbl_rfq_purchase_order po
              ON po.id = ai.entity_id AND ai.entity_type = 'PO'
       LEFT JOIN tbl_approval_policy_steps ps ON ps.id = s.policy_step_id
       LEFT JOIN tbl_users au ON au.id = a.approver_user_id
       LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
       LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
      WHERE a.acted_at IS NOT NULL
        AND a.status IN ('APPROVED', 'REJECTED')
        AND a.acted_at >= (($${fromIdx}::date AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'UTC')
        AND a.acted_at <  (($${toIdx}::date  AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'UTC')
        AND ${base.where}
      GROUP BY 1, 2, 3, 4
      ORDER BY decisions DESC, avg_hours DESC
      LIMIT ${REPORT_ROW_CAP}`,
    values
  );
}

/** Report 6.1 sheet 3 — where in the chain the time actually goes. */
export async function poApprovalTatByStage(scope, { from, to }) {
  const values = [];
  let i = 1;
  const fromIdx = i++;
  values.push(from);
  const toIdx = i++;
  values.push(to);
  const base = poBase(scope, values, i);

  return db.any(
    `SELECT s.step_order::int                       AS step_order,
            COUNT(*)::int                           AS approvals,
            AVG(EXTRACT(EPOCH FROM (s.completed_at - s.created_at)) / 3600.0)::float8 AS avg_hours,
            PERCENTILE_CONT(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (s.completed_at - s.created_at)) / 3600.0
            )::float8                               AS median_hours,
            PERCENTILE_CONT(0.9) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (s.completed_at - s.created_at)) / 3600.0
            )::float8                               AS p90_hours,
            MAX(ps.sla_hours)::int                  AS sla_hours
       FROM tbl_approval_instance_steps s
       JOIN tbl_approval_instances ai ON ai.id = s.approval_instance_id
       JOIN tbl_rfq_purchase_order po
              ON po.id = ai.entity_id AND ai.entity_type = 'PO'
       LEFT JOIN tbl_approval_policy_steps ps ON ps.id = s.policy_step_id
       LEFT JOIN tbl_rfq rfq ON rfq.id = po.rfq_id
       LEFT JOIN tbl_material_requisition mr ON mr.id = po.source_mr_id
      WHERE s.completed_at IS NOT NULL
        AND s.status = 'APPROVED'
        AND s.completed_at >= (($${fromIdx}::date AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'UTC')
        AND s.completed_at <  (($${toIdx}::date  AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'UTC')
        AND ${base.where}
      GROUP BY 1
      ORDER BY 1`,
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
  spendByCategoryProperty,
  interPropertyRateVariance,
  spendTotals,
  OPEN_PO_STATUSES,
  openPoRegister,
  pendingPoApprovals,
  poApprovalTat,
  poApprovalTatByApprover,
  poApprovalTatByStage,
  permittedReportActions,
  recordExport,
  listExports,
};
