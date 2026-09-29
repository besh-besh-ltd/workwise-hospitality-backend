// ============================================================================
// dashboardMetrics.js
// ----------------------------------------------------------------------------
// The ONE definition of every concept the buyer dashboard counts or sums.
//
// Before this module each widget carried its own copy of "what is spend",
// "what is a pending approval", "what is a live negotiation round", and the
// copies disagreed on the same screen (banner said 4 RFQs ended without
// quotes, the drill-down it opened listed 2; spend was ₹33.96 Cr on the
// dashboard and ₹29.84 Cr in Reports for the same user and window). Every
// widget now composes these fragments instead. See docs/dashboard_v3/SPEC.md.
//
// All fragments are plain SQL strings. Anything that binds a value takes the
// placeholder index it should reference (or appends to a caller's `params`
// array and says so), so they drop into the existing $N-numbered queries.
// ============================================================================

import { SPEND_STATUSES, LEAF_CATEGORY_JOIN, lineVariant as reportsLineVariant } from '../reportsModel.js';

export { SPEND_STATUSES, LEAF_CATEGORY_JOIN };

// ── Dates ────────────────────────────────────────────────────────────────

/**
 * Accept only a real `YYYY-MM-DD` calendar day; anything else is "no bound".
 * The FE sends IST calendar days built with local-time moment(); a malformed
 * value must widen to "all time" rather than 500 the widget.
 */
export function normalizeDate(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

/**
 * Storage frame of a timestamp column. The dashboard window is always an IST
 * calendar-day range; how that range maps onto a column depends on how the
 * column was written.
 *
 *   TZ      — `timestamptz` (tbl_rfq_purchase_order.created_at). An instant.
 *   SESSION — naive `timestamp` defaulted from CURRENT_TIMESTAMP / now(), i.e.
 *             written as session-local wall clock (UTC on prod, IST on a
 *             developer's Homebrew Postgres). tbl_rfq.timestamp,
 *             tbl_approval_instances.created_at/completed_at, tbl_quotes.timestamp,
 *             tbl_negotiation_rounds.created_at/closed_at, tbl_quote_finalization.
 *   IST     — naive IST wall clock written by the app: tbl_rfq.bid_end_date
 *             (text) and tbl_rfq.tender_publish_date.
 */
export const FRAME = Object.freeze({ TZ: 'tz', SESSION: 'session', IST: 'ist' });

// IST midnight of calendar day $n as an absolute instant. NOTE the ::timestamp
// hop: `'2026-04-01'::date AT TIME ZONE 'Asia/Kolkata'` resolves the DATE
// through the *session* zone first (timestamptz wins the implicit cast) and on
// a UTC session yields 05:30 naive — every boundary 5h30m off. Casting the date
// to a naive timestamp first makes AT TIME ZONE mean "this wall clock is IST".
const istMidnight = (idx, plusDays = 0) =>
  `(($${idx}::date + ${plusDays})::timestamp AT TIME ZONE 'Asia/Kolkata')`;

function boundExpr(frame, idx, plusDays) {
  switch (frame) {
    case FRAME.TZ:
      return istMidnight(idx, plusDays);
    case FRAME.SESSION:
      // timestamptz → timestamp converts to session-local wall clock, i.e. the
      // frame the column was written in. Bound stays on the parameter side so
      // an index on the column remains usable.
      return `${istMidnight(idx, plusDays)}::timestamp`;
    case FRAME.IST:
      return `($${idx}::date + ${plusDays})::timestamp`;
    default:
      throw new Error(`dashboardMetrics.windowSql: unknown frame '${frame}'`);
  }
}

/**
 * Half-open IST window predicate: [start 00:00 IST, (end + 1 day) 00:00 IST).
 * NULL-tolerant on both sides — a missing start means "since the beginning",
 * a missing end means "up to now". Returns an SQL boolean expression (no
 * leading AND).
 *
 * @param {string} col       column expression (e.g. 'po.created_at'); for the
 *                           text column bid_end_date pass 'r.bid_end_date::timestamp'
 * @param {string} frame     one of FRAME
 * @param {number} startIdx  placeholder index bound to start_date (or null)
 * @param {number} endIdx    placeholder index bound to end_date (or null)
 */
export function windowSql(col, frame, startIdx, endIdx) {
  return `(($${startIdx}::date IS NULL OR ${col} >= ${boundExpr(frame, startIdx, 0)})
      AND ($${endIdx}::date IS NULL OR ${col} < ${boundExpr(frame, endIdx, 1)}))`;
}

// ── IST "now" for naive-IST columns (bid_end_date, tender_publish_date) ──
export const IST_NOW = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')`;

/** bid_end_date is a naive-IST text column; '' / NULL mean "no deadline". */
export const hasBidEnd = (a = 'r') =>
  `(${a}.bid_end_date IS NOT NULL AND ${a}.bid_end_date <> '')`;

/** Bid window still open: no deadline, or the deadline is in the future. */
export const bidOpen = (a = 'r') =>
  `(NOT ${hasBidEnd(a)} OR ${a}.bid_end_date::timestamp > ${IST_NOW})`;

/** Bid window has passed (exact time, IST). */
export const bidClosed = (a = 'r') =>
  `(${hasBidEnd(a)} AND ${a}.bid_end_date::timestamp <= ${IST_NOW})`;

// ── Quotes ───────────────────────────────────────────────────────────────

/** A quote that is a real offer, not a regret. */
export const realQuote = (q = 'q') => `(${q}.is_regret IS NULL OR ${q}.is_regret <> 1)`;

/**
 * A priced quote line: excludes ₹0 regret lines (5% of prod quote items),
 * which would otherwise drag MIN/AVG to zero and crown a regretting vendor
 * "best price".
 */
export const pricedItem = (qi = 'qi') => `(${qi}.unit_price IS NOT NULL AND ${qi}.unit_price > 0)`;

/** The RFQ has at least one real (non-regret) quote. */
export const hasRealQuote = (r = 'r') =>
  `EXISTS (SELECT 1 FROM tbl_quotes q_rq WHERE q_rq.rfq_id = ${r}.id AND ${realQuote('q_rq')})`;

// ── Negotiation rounds ───────────────────────────────────────────────────

/**
 * Statuses of a round that is still in flight. Prod carries ENDED, EXPIRED,
 * CANCELLED, COMPLETED and PENDING_APPROVAL (ACTIVE when a round is open);
 * `CLOSED` never occurs, which is why the old `NOT IN ('CLOSED', ...)` test
 * treated every ENDED round as live. Same set negotiationModel uses.
 */
export const LIVE_ROUND_STATUSES = Object.freeze(['PENDING_APPROVAL', 'ACTIVE']);

export const liveRoundExists = (r = 'r') =>
  `EXISTS (SELECT 1 FROM tbl_negotiation_rounds nr_live
            WHERE nr_live.rfq_id = ${r}.id
              AND nr_live.status IN ('PENDING_APPROVAL', 'ACTIVE'))`;

// ── Spend ────────────────────────────────────────────────────────────────

/**
 * Committed-spend predicate on a PO aliased `po` — D1: same statuses as
 * Reports 1.1. Appends SPEND_STATUSES to `params` and returns the fragment.
 */
export function spendStatusSql(params, po = 'po') {
  params.push(SPEND_STATUSES);
  return `${po}.status = ANY($${params.length}::po_status[])`;
}

/**
 * Variant of a PO line — Reports' definition (reportsModel.lineVariant), so the
 * dashboard and Reports resolve a line to the same item. Callers here join the
 * rfq_product as `rp`, hence the different default alias.
 */
export const lineVariant = (pop = 'pop', rp = 'rp') => reportsLineVariant(pop, rp);

// ── Approvals ────────────────────────────────────────────────────────────

/**
 * The actionable item an approval instance represents. Several instances can
 * sit on one decision — prod has one approver with 50 PENDING
 * NEGOTIATION_QUOTE instances across 3 RFQs — so queues count DISTINCT items.
 * NEGOTIATION_QUOTE and TECHNICAL collapse to their RFQ (entity_id is the
 * rfq_product / round id respectively); everything else is its entity.
 */
export const approvalItemKey = (i = 'i') =>
  `(${i}.entity_type || ':' || CASE
      WHEN ${i}.entity_type IN ('NEGOTIATION_QUOTE', 'TECHNICAL')
           AND (${i}.metadata->>'rfq_id') ~ '^[0-9]+$'
        THEN (${i}.metadata->>'rfq_id')
      ELSE ${i}.entity_id::text
    END)`;

/**
 * FROM + WHERE for "approval steps sitting on me right now".
 *
 * Mirrors generalModel.getPendingApprovalCountsByEntityType (the nav badge):
 *   · I am a PENDING, not-removed approver on the instance's CURRENT, PENDING
 *     step (a REMOVED approver keeps a tombstone row — see getPendingNegotiationParentIds);
 *   · NULL-hotel instances are included (company-level approvals);
 *   · a publish approval on an already-published RFQ is not actionable;
 *   · a NEGOTIATION round whose vendor window has closed is not actionable.
 * Deliberately NOT date-filtered (SPEC rule 2: queues are never windowed) and
 * without the badge's 7-day recency cut — the dashboard is the full queue.
 *
 * @param {number} userIdx    placeholder bound to req.user.id
 * @param {number} buyerIdx   placeholder bound to buyer_company_id
 * @param {number} hotelsIdx  placeholder bound to the effective hotel_ids
 */
export function myPendingApprovalsFrom(userIdx, buyerIdx, hotelsIdx) {
  return `
    FROM tbl_approval_instances i
    JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
    JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
   WHERE i.status = 'PENDING'
     AND s.status = 'PENDING'
     AND s.step_order = i.current_step
     AND sa.approver_user_id = $${userIdx}
     AND sa.status = 'PENDING'
     AND sa.removed_at IS NULL
     AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $${buyerIdx})
     AND (i.hotel_id IS NULL OR i.hotel_id = ANY($${hotelsIdx}))
     AND NOT (
       i.entity_type IN ('RFQ', 'TENDER')
       AND EXISTS (SELECT 1 FROM tbl_rfq r_pub WHERE r_pub.id = i.entity_id AND r_pub.is_published = 1)
     )
     AND NOT (
       i.entity_type IN ('NEGOTIATION', 'ARC_NEGOTIATION')
       AND EXISTS (
         SELECT 1 FROM tbl_negotiation_rounds nr_dead
          WHERE nr_dead.id = COALESCE(
                  CASE WHEN (i.metadata->>'round_id') ~ '^[0-9]+$'
                       THEN (i.metadata->>'round_id')::int END,
                  i.entity_id)
            AND nr_dead.end_date IS NOT NULL
            AND nr_dead.end_date <= (now() AT TIME ZONE 'UTC')
       )
     )`;
}

// ── Scope (company × hotel × department × process) ───────────────────────

/**
 * Per-request materialised RBAC scope.
 *
 * Same semantics as authorizationService.buildScopeExistsClause OR-composed
 * over `permissions`, but the caller's allowed (company, hotel, department,
 * process) tuples are computed ONCE by an uncorrelated sub-select — Postgres
 * plans it as an InitPlan — instead of re-joining tbl_user_role_scopes →
 * tbl_role_permissions → tbl_permissions for every candidate row. On prod
 * that correlated EXISTS ran ~800× per widget query (~130 ms each).
 *
 * MUTATES `params` (appends user id + permission list). Call after every
 * other param for the query has been pushed. Returns an `AND (...)` fragment.
 * The alias must expose hospitality_company_id, hotel_id, department_id and
 * process_id.
 */
export function scopeTuplesFilter(userId, alias, params, permissions) {
  if (!alias || /[^a-zA-Z0-9_]/.test(alias)) {
    throw new Error(`scopeTuplesFilter: invalid alias '${alias}'`);
  }
  params.push(userId);
  const u = params.length;
  params.push(permissions);
  const p = params.length;
  return `AND EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(COALESCE((
             SELECT jsonb_agg(DISTINCT jsonb_build_object(
                      'c', urs.company_id, 'h', urs.hotel_id,
                      'd', urs.department_id, 'p', urs.process_id))
               FROM tbl_user_role_scopes urs
               JOIN tbl_role_permissions rp_s ON rp_s.role_id = urs.role_id
               JOIN tbl_permissions p_s ON p_s.id = rp_s.permission_id
              WHERE urs.user_id = $${u}
                AND (p_s.resource || '.' || p_s.action) = ANY($${p}::text[])
           ), '[]'::jsonb)) AS st(c int, h int, d int, p int)
     WHERE st.c = ${alias}.hospitality_company_id
       AND (st.h IS NULL OR st.h = ${alias}.hotel_id)
       AND (${alias}.department_id IS NULL OR st.d IS NULL OR st.d = ${alias}.department_id)
       AND (st.p IS NULL OR st.p = ${alias}.process_id)
  )`;
}

// ── Stats helpers ────────────────────────────────────────────────────────

export const round1 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10) / 10);
export const round2 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);

// ── Vendor disagreement ──────────────────────────────────────────────────

/**
 * A technical-evaluation vendor response that disagrees with its clause.
 * Vendors answer in free text; prod stores the negative as 'I Dont Agree'
 * (never 'disagree', which is why an equality check returned 0 forever), so
 * match the normalised forms. Shared by the Vendor disagreements card and the
 * RFQ list's `filters.vendor_disagreement`, so the two cannot drift.
 */
export const DISAGREE_SQL = (col) =>
  `regexp_replace(lower(COALESCE(${col}, '')), '[^a-z]', '', 'g') IN ('idontagree', 'idonotagree', 'disagree', 'idisagree', 'dontagree', 'notagree')`;

/**
 * The RFQ (alias) has an incomplete technical evaluation with at least one
 * disagreeing vendor response — the card's population, per RFQ.
 */
export const hasOpenVendorDisagreement = (alias = 'r') => `EXISTS (
  SELECT 1
    FROM tbl_rfq_product_tech_evaluation te_d
    JOIN tbl_rfq_product_tech_evaluation_clauses c_d ON c_d.tbl_rfq_product_tech_evaluation_id = te_d.id
    JOIN tbl_rfq_product_tech_evaluation_vendors_response vr_d
      ON vr_d.tbl_rfq_product_tech_evaluation_clauses_id = c_d.id
   WHERE te_d.rfq_id = ${alias}.id
     AND te_d.is_complete = false
     AND ${DISAGREE_SQL('vr_d.vendor_response')})`;
