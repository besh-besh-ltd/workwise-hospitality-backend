// Purchase Requisitions — shared constants and SQL fragments.
//
// A LEAF module: it imports nothing, so models, services and controllers can
// all depend on it without layering cycles (a model must never import a
// controller or a service's business logic to get a status list or a predicate).
//
// SQL fragments are pure strings over documented aliases. The only values that
// are ever interpolated are developer constants and `$n` placeholders, both
// validated where a caller supplies them.

// ---------------------------------------------------------------------------
// Statuses and enums (mirror the CHECKs in migrations/20261013101000_pr_tables.sql)
// ---------------------------------------------------------------------------
export const PR_STATUSES = Object.freeze(['draft', 'in_review', 'pending_approval', 'returned', 'approved', 'rejected', 'cancelled']);
/** The requester may edit, submit or cancel. */
export const EDITABLE_STATUSES = Object.freeze(['draft', 'returned']);
/** The requester may withdraw back to draft. */
export const WITHDRAWABLE_STATUSES = Object.freeze(['in_review', 'pending_approval']);
export const TERMINAL_STATUSES = Object.freeze(['rejected', 'cancelled']);
export const PR_TYPES = Object.freeze(['goods', 'service', 'capex']);
export const URGENCIES = Object.freeze(['low', 'normal', 'urgent']);
export const LINE_KINDS = Object.freeze(['catalog', 'free_text']);
export const LINE_STATUSES = Object.freeze(['active', 'cancelled', 'closed']);

// ---------------------------------------------------------------------------
// Validation limits
// ---------------------------------------------------------------------------
export const MAX_LINES = 200;
export const QTY_RE = /^\d{1,15}(\.\d{1,3})?$/;          // NUMERIC(18,3)
export const PRICE_RE = /^\d{1,16}(\.\d{1,2})?$/;        // NUMERIC(18,2)
export const PRICE_MAX_INT_DIGITS = 14;                  // ≤ 99,999,999,999,999.99
export const TOTAL_MAX_PAISE = 999999999999999999n;      // Σ must fit estimated_total NUMERIC(18,2)
export const MAX_LEN = Object.freeze({
  title: 200, justification: 4000, delivery_location: 1000, free_text_name: 300, uom: 50,
  specification: 20000, suggested_vendor_note: 2000, reason: 2000,
});

const PLACEHOLDER_RE = /^\$\d+$/;
const assertPlaceholder = (fn, p) => {
  if (!PLACEHOLDER_RE.test(String(p))) throw new Error(`${fn}: expected a $n placeholder, got '${p}'`);
};

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
/** Today's calendar date in IST, independent of the Postgres session timezone. */
export const IST_TODAY_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
// The RFQ "usable" predicate, copied from rfqModel.searchProduct
// (matched_variants) — keep the two in step. Aliases: pv = tbl_product_variant,
// p = tbl_product.
export const USABLE_VARIANT_SQL =
  'p.status = 1 AND p.is_deleted = 0 AND p.is_review = 0 AND p.is_approve = 1 AND pv.is_approve = 1';

// The category a product is filed under for PR purposes: its lowest category
// id that exists in tbl_category. `productIdExpr` is a SQL column expression.
export const FIRST_CATEGORY_SQL = (productIdExpr) => `(
  SELECT _fc_pc.category_id
    FROM tbl_product_categories _fc_pc
    JOIN tbl_category _fc_cat ON _fc_cat.id = _fc_pc.category_id
   WHERE _fc_pc.product_id = ${productIdExpr}
   ORDER BY _fc_pc.category_id
   LIMIT 1)`;

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------
/**
 * Scope rows of the user bound at `userParam` that grant pr.<action> and can
 * apply to a PR (process wildcard — PR.process_id is always NULL). Columns:
 * company_id, hotel_id, department_id. Same axis semantics as
 * authorizationService.assertUserHasScope, so a picker built on this offers
 * exactly what prAccess.assertPerm admits.
 */
export const prGrantRowsSql = (userParam, action) => {
  assertPlaceholder('prGrantRowsSql', userParam);
  if (!/^[a-z]+$/.test(action)) throw new Error(`prGrantRowsSql: invalid action '${action}'`);
  return `
    SELECT _g_urs.company_id, _g_urs.hotel_id, _g_urs.department_id
      FROM tbl_user_role_scopes _g_urs
      JOIN tbl_role_permissions _g_rp ON _g_rp.role_id = _g_urs.role_id
      JOIN tbl_permissions _g_perm ON _g_perm.id = _g_rp.permission_id
     WHERE _g_urs.user_id = ${userParam}
       AND _g_urs.process_id IS NULL
       AND _g_perm.resource::text = 'pr'
       AND _g_perm.action::text = '${action}'`;
};

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

// ---------------------------------------------------------------------------
// Review / approval "who holds it" fragments (lists and KPIs)
// ---------------------------------------------------------------------------
export const HEADER_PROGRESSES = Object.freeze([
  'in_queue', 'partly_in_sourcing', 'in_sourcing', 'partly_ordered', 'ordered', 'completed',
]);
/** Line progresses that mean "waiting for the purchase team to pick it up". */
export const POOL_PROGRESSES = Object.freeze(['in_pool', 'needs_mapping', 'awaiting_catalog']);
export const NO_REVIEWER_LABEL = 'No eligible reviewer — contact your admin';
export const NO_APPROVER_LABEL = 'No eligible approver — contact your admin';

/**
 * Is there ANY user who may review PR `p`'s department `rv` (a tbl_pr_review
 * alias)? Same axis semantics as prGrantRowsSql / assertUserHasScope with the
 * review's department as the entity department: company exact, hotel and
 * department exact-or-wildcard, process wildcard-only.
 */
export const REVIEWER_EXISTS_SQL = (p, rv) => `EXISTS (
  SELECT 1
    FROM tbl_user_role_scopes _rx_urs
    JOIN tbl_role_permissions _rx_rp ON _rx_rp.role_id = _rx_urs.role_id
    JOIN tbl_permissions _rx_perm ON _rx_perm.id = _rx_rp.permission_id
   WHERE _rx_urs.company_id = ${p}.hospitality_company_id
     AND (_rx_urs.hotel_id IS NULL OR _rx_urs.hotel_id = ${p}.hotel_id)
     AND (_rx_urs.department_id IS NULL OR _rx_urs.department_id = ${rv}.department_id)
     AND _rx_urs.process_id IS NULL
     AND _rx_perm.resource::text = 'pr' AND _rx_perm.action::text = 'evaluate')`;

/** The in_review label when departments have no evaluator. Single source for SQL and JS callers. */
export const noReviewerLabel = (deptTitles) => `${NO_REVIEWER_LABEL} (${deptTitles.join(', ')})`;
/** SQL form of noReviewerLabel; `titlesExpr` is a SQL text expression (already aggregated). */
export const NO_REVIEWER_LABEL_SQL = (titlesExpr) => `'${NO_REVIEWER_LABEL} (' || ${titlesExpr} || ')'`;
