import db from '../config/dbConn.js';
import { buildScopeExistsClause } from '../services/authorizationService.js';
import negotiationModel from './negotiationModel.js';
import { isCompanyAdmin } from '../middleware/companyAdmin.js';

/**
 * Dashboard queries scope by buyer_company_id (covers ALL hospitality companies
 * under the same buyer account) + hotel_ids (intersected with user's allowed set)
 * + the caller's RBAC scope rows (company × hotel × department × process).
 *
 * Param convention:
 *   $1 = buyer_company_id (from tbl_hospitality_companies.buyer_company_id)
 *   $2 = start_date
 *   $3 = end_date
 *   $4 = hotel_ids (always provided — user's allowed scope)
 *   $5.. = per-query extras, then the RBAC params appended by scopeFilter()
 */

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Company scope: matches any hospitality_company under the same buyer account.
 * Uses a subquery so we don't need to pass an array of company IDs.
 *
 * SECURITY NOTE — this predicate is NOT a tenant boundary on its own.
 * `buyer_company_id` is the BILLING account. In production, buyer_company_id 13
 * resolves to EIGHT distinct legal entities (Orchid Hotels Pune Pvt Ltd, Kamat
 * Hotels India Ltd, Phileein, SLPD, Zaffiro, Envotel, ILEX, Chandi). Any widget
 * relying on companyScope() alone shows all eight to every user of any one of
 * them. Always pair it with hotelFilter() AND scopeFilter().
 */
function companyScope(alias = 'r') {
  return `${alias}.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)`;
}

function hotelFilter(alias = 'r', paramIdx = 4) {
  return `AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = ${alias}.id AND rhm.hotel_id = ANY($${paramIdx}))`;
}

/**
 * "Today" for bid-window purposes, as a DATE.
 *
 * `tbl_rfq.bid_end_date` is `text NOT NULL` holding a NAIVE IST wall-clock
 * string (see app/helper/quoteVisibility.js — QUOTE_VISIBILITY_TIMEZONE). It
 * carries no offset, so any comparison against `CURRENT_DATE` / `DATE(NOW())`
 * silently resolves through the Postgres SESSION timezone. That is wrong on
 * every deployment whose session timezone is not Asia/Kolkata — notably RDS,
 * which defaults to UTC. Between 18:30 and 24:00 UTC (00:00–05:30 IST) the UTC
 * calendar day still lags the IST one, so a bid that closed at the end of the
 * IST day is not yet reported as closed and every day-count is short by one.
 *
 * `CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'` pins the boundary to IST
 * regardless of session timezone — the same idiom already used for
 * `bid_end_date` in rfqModel.js (:4247, :13236) and hospitalityModel.js (:2005),
 * and the SQL-side twin of arcTime.js / quoteVisibility.js.
 */
const IST_TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`;

/**
 * "Now" for bid-window purposes, as a TIMESTAMP.
 *
 * The timestamp-granularity twin of IST_TODAY. It exists for the predicates
 * that compare `bid_end_date` at wall-clock precision rather than by calendar
 * day — "closes within the next 24h", "bid window already passed".
 *
 * Same root cause, strictly worse blast radius. `bid_end_date::timestamp` is
 * naive; `NOW()` is `timestamptz`; Postgres resolves the mixed comparison by
 * promoting the naive side to `timestamptz` **through the session timezone**.
 * So `bid_end_date::timestamp < NOW()` really asks "is this IST wall-clock
 * string, reinterpreted as session-local time, in the past?". Production's
 * session timezone is UTC (verified on the live DB: `current_setting('TimeZone')`
 * = UTC; the app sets no PGOPTIONS, no PGTZ and issues no `SET timezone`), so
 * an 11:00 IST deadline is read as the instant 11:00 UTC — 16:30 IST. Every
 * bid-window boundary lands 5h30m LATE, all day, every day, not only during
 * the 18:30–24:00 UTC window in which the `::date` twin above skews. The error
 * is `5h30m − session_offset`, so it flips sign east of IST rather than
 * vanishing: on an Asia/Singapore session (+8) it is 2h30m early instead.
 *
 * On the status banner, with production's UTC session, that means:
 *   • `closed_no_quotes` only fires once a bid has been closed for MORE than
 *     5h30m, so the "vendors aren't biting" alarm — the one signal that alone
 *     forces `critical` mode — is 5h30m late every single time;
 *   • `closing_soon` covers real deadlines from 5h30m in the PAST to 18h30m
 *     ahead instead of 0–24h, so it advertises already-dead RFQs as still open
 *     and stays silent on every bid closing 18h30m–24h out.
 *
 * `CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'` returns IST wall clock as a
 * naive `timestamp`, putting both sides of the comparison in the same frame
 * under any session timezone.
 *
 * Deliberately NOT applied to `r.timestamp`, `i.created_at`, `po.created_at` or
 * `nr.created_at`. Those are real `timestamp` columns defaulted from
 * `CURRENT_TIMESTAMP`, i.e. written under the same session timezone they are
 * later read under, so plain `NOW()` is already frame-consistent for them and
 * shifting them to IST would *introduce* the skew this removes.
 *
 * Also deliberately NOT applied to the `$4`/`$5` date-range parameters. Those
 * arrive from the FE as bare `YYYY-MM-DD` strings built with local-time
 * `moment().format(...)` (frontend/components/dashboard/buyer/index.js
 * getDateRange), never `toISOString()`, and Postgres resolves an untyped
 * parameter in `<timestamp> BETWEEN $4 AND $5` to `timestamp without time
 * zone` — so that branch is already naive-IST vs naive-IST and carries no
 * session-timezone dependence at all. Wrapping it would break it.
 */
const IST_NOW = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')`;

// ── RBAC scope (company × hotel × department × process) ──────────────
//
// Before this, dashboardModel.js contained ZERO references to
// tbl_user_role_scopes and no /dashboard-v2 route carried acl(). Scope came
// only from tbl_hospitality_user_mappings, which is company-or-hotel granular
// and carries no department or process axis — so those two axes were
// structurally unenforceable, and any widget that also skipped hotelFilter()
// crossed legal-entity boundaries inside one billing account.
//
// The authoritative predicate is now buildScopeExistsClause() from
// authorizationService — the same EXISTS shape the RFQ listing uses
// (rfqModel.js:3923-3936) and the same one commit 92604b60 adopted for the PO
// dashboard. Measured on production: 93 of 232 active mapped users already see
// ZERO RFQs in the RFQ listing while the dashboard showed them all 441 RFQs of
// all eight legal entities. After this change the two surfaces agree.
//
// Permission choice mirrors poDashboardModel's documented rationale: the clause
// OR-composes across the read permissions a given widget's persona plausibly
// holds, because the seeded buyer roles do not all carry every entity-specific
// read permission (production: awarding.read 253 users, rfq/boq.read 251,
// te.read 249, negotiation/quote-compare.read 250, out of 254). All variants
// enforce the identical 4-axis tuple, so the OR widens *who* sees a widget,
// never *which* rows any one of them sees.
const RFQ_SCOPE_PERMISSIONS = ['rfq.read', 'boq.read', 'awarding.read'];
const TECH_SCOPE_PERMISSIONS = ['te.read', 'rfq.read', 'boq.read'];
const COMMERCIAL_SCOPE_PERMISSIONS = ['quote-compare.read', 'negotiation.read', 'rfq.read', 'boq.read'];

/**
 * Build the RBAC scope fragment for an already-joined tbl_rfq alias.
 *
 * MUTATES `params`: appends the RBAC bind values at the end, so it must be
 * called AFTER every other param for that query has been pushed. Returns an
 * `AND (...)` fragment ready to splice into the WHERE/JOIN condition.
 *
 * The alias must expose hospitality_company_id, hotel_id, department_id and
 * process_id — tbl_rfq and tbl_approval_instances both do.
 *
 * @param {number} user_id     always req.user.id — never a client-supplied id
 * @param {string} alias       SQL alias of the scoped entity (usually 'r')
 * @param {any[]} params       the query's bind array (mutated)
 * @param {string[]} permissions
 */
function scopeFilter(user_id, alias, params, permissions = RFQ_SCOPE_PERMISSIONS) {
  let i = params.length + 1;
  const clauses = [];
  for (const perm of permissions) {
    const built = buildScopeExistsClause(user_id, perm, alias, i);
    clauses.push(built.clause);
    params.push(...built.params);
    i += built.paramsConsumed;
  }
  return `AND (${clauses.join(' OR ')})`;
}

/**
 * Resolves a user's full hospitality scope from tbl_hospitality_user_mappings.
 *
 * Returns { buyer_company_id, hotel_ids }
 *  - buyer_company_id: the parent buyer company that owns all hospitality companies
 *  - hotel_ids: array of hotel IDs the user is allowed to see
 *
 * For company-level mappings (mapping_type=0): includes ALL hotels in that company
 * For hotel-level mappings (mapping_type=1): includes only those specific hotels
 * Merges across ALL hospitality companies the user is mapped to.
 *
 * If selectedHotelIds are provided, intersects with the allowed set.
 */
async function resolveUserScope(user_id, selectedHotelIds = []) {
  // Check user type
  const userInfo = await db.oneOrNone(
    // `id` is selected because the capability check below needs it: the
    // capability lives on the user's granted role scopes, not on the row.
    `SELECT id, user_type, company_id FROM tbl_users WHERE id = $1`,
    [user_id]
  );

  if (!userInfo) return null;

  let buyer_company_id;
  let allAllowed = [];

  if (await isCompanyAdmin(userInfo)) {
    // A company administrator: full access to every hospitality company under
    // their own parent buyer company. Read from the capability rather than
    // user_type 7, so an administrator promoted the new way — an ordinary
    // buyer holding company.admin — gets the same dashboard, not a blank one.
    if (!userInfo.company_id) return null;

    buyer_company_id = userInfo.company_id;

    const allHotels = await db.any(
      `SELECT hch.id FROM tbl_hospitality_company_hotels hch
       JOIN tbl_hospitality_companies hc ON hc.id = hch.hospitality_company_id
       WHERE hc.buyer_company_id = $1 AND hch.is_deleted = 0`,
      [buyer_company_id]
    );

    if (allHotels.length === 0) return null;
    allAllowed = allHotels.map((h) => h.id);
  } else {
    // Non-admin: use explicit hospitality user mappings
    const mappings = await db.any(
      `SELECT hum.hospitality_company_id, hum.hospitality_hotel_id, hum.mapping_type,
              hc.buyer_company_id
       FROM tbl_hospitality_user_mappings hum
       JOIN tbl_hospitality_companies hc ON hc.id = hum.hospitality_company_id
       WHERE hum.user_id = $1`,
      [user_id]
    );

    if (mappings.length === 0) return null;

    buyer_company_id = mappings[0].buyer_company_id;

    const companyLevelIds = mappings
      .filter((m) => m.mapping_type === 0)
      .map((m) => m.hospitality_company_id);

    const hotelLevelIds = mappings
      .filter((m) => m.mapping_type === 1 && m.hospitality_hotel_id)
      .map((m) => m.hospitality_hotel_id);

    let companyHotelIds = [];
    if (companyLevelIds.length > 0) {
      const rows = await db.any(
        `SELECT id FROM tbl_hospitality_company_hotels
         WHERE hospitality_company_id = ANY($1) AND is_deleted = 0`,
        [companyLevelIds]
      );
      companyHotelIds = rows.map((h) => h.id);
    }

    allAllowed = [...new Set([...companyHotelIds, ...hotelLevelIds])];
  }

  // Intersect with user's filter selection
  let effective;
  if (selectedHotelIds.length > 0) {
    effective = selectedHotelIds.filter((id) => allAllowed.includes(id));
  } else {
    effective = allAllowed;
  }

  return {
    buyer_company_id,
    hotel_ids: effective,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 1. Action Center
// ─────────────────────────────────────────────────────────────────────
async function getActionCenterData(buyer_company_id, user_id, hotel_ids = [], start_date, end_date) {
  const hasDates = start_date && end_date;
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];

  const dateFilterRfq = hasDates ? 'AND r.timestamp BETWEEN $2 AND $3' : '';
  const dateFilterPo = hasDates ? 'AND po.created_at BETWEEN $2 AND $3' : '';

  // Pending approvals: user-specific queue scoped to their companies
  // Uses the same logic as the counts API (getPendingApprovalCountsByEntityType)
  const pendingApprovalsQuery = db.one(
    `SELECT COUNT(*)::INTEGER as count
     FROM tbl_approval_instances i
     JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
     JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
     WHERE i.status = 'PENDING'
     AND sa.approver_user_id = $5
     AND sa.status = 'PENDING'
     AND s.step_order = i.current_step
     AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
     AND NOT (
       i.entity_type IN ('RFQ', 'TENDER')
       AND EXISTS (SELECT 1 FROM tbl_rfq r WHERE r.id = i.entity_id AND r.is_published = 1)
     )
     AND i.created_at BETWEEN $2 AND $3
     AND i.hotel_id = ANY($4)`,
    [...params, user_id]
  );

  // The four RFQ-rooted counts all get the canonical 4-axis RBAC predicate.
  // Each builds its own param array because scopeFilter appends bind values.
  const awaitingParams = [...params];
  const rfqsAwaitingQuery = db.one(
    `SELECT COUNT(*) as count FROM tbl_rfq r
     WHERE ${companyScope()} AND r.is_published = 1 AND r.status = 1
     AND NOT EXISTS (SELECT 1 FROM tbl_quotes q WHERE q.rfq_id = r.id)
     ${dateFilterRfq} ${hf} ${scopeFilter(user_id, 'r', awaitingParams)}`,
    awaitingParams
  );

  // RFQs ending soon: any RFQ (tender or not) whose bid_end_date is within 3 days
  const endingSoonParams = [...params];
  const rfqsEndingSoonQuery = db.one(
    `SELECT COUNT(*) as count FROM tbl_rfq r
     WHERE ${companyScope()} AND r.is_published = 1 AND r.status = 1
     AND r.bid_end_date != '' AND DATE(r.bid_end_date) BETWEEN ${IST_TODAY} AND ${IST_TODAY} + INTERVAL '3 days'
     ${hf} ${scopeFilter(user_id, 'r', endingSoonParams)}`,
    endingSoonParams
  );

  const posAwaitingParams = [...params];
  const posAwaitingQuery = db.one(
    `SELECT COUNT(*) as count
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq r ON r.id = po.rfq_id
     WHERE ${companyScope()} AND po.status = 'acceptance_pending'
     ${dateFilterPo} ${hf} ${scopeFilter(user_id, 'r', posAwaitingParams)}`,
    posAwaitingParams
  );

  // Only count rejected POs where no replacement PO exists for the same product
  const rejectedParams = [...params];
  const rejectedVendorsQuery = db.one(
    `SELECT COUNT(*) as count
     FROM tbl_rfq_purchase_order po
     JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
     JOIN tbl_rfq r ON r.id = po.rfq_id
     WHERE ${companyScope()} AND po.status = 'rejected_by_vendor'
     AND NOT EXISTS (
       SELECT 1 FROM tbl_rfq_purchase_order po2
       JOIN tbl_purchase_order_product pop2 ON pop2.purchase_order_id = po2.id
       WHERE po2.rfq_id = po.rfq_id
       AND pop2.rfq_product_id = pop.rfq_product_id
       AND po2.id != po.id
       AND po2.status NOT IN ('rejected_by_vendor', 'cancelled')
     )
     ${dateFilterPo} ${hf} ${scopeFilter(user_id, 'r', rejectedParams)}`,
    rejectedParams
  );

  const [pa, ra, es, poa, rv] = await Promise.all([
    pendingApprovalsQuery, rfqsAwaitingQuery, rfqsEndingSoonQuery, posAwaitingQuery, rejectedVendorsQuery,
  ]);

  return {
    pending_approvals: parseInt(pa.count, 10),
    rfqs_awaiting: parseInt(ra.count, 10),
    rfqs_ending_soon: parseInt(es.count, 10),
    pos_awaiting: parseInt(poa.count, 10),
    rejected_vendors: parseInt(rv.count, 10),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 1b. No-response detail (drill-down behind the "No responses" card)
//     Same base set as the Action Centre rfqs_awaiting count (published,
//     OPEN, zero quotes), segregated by bid window (Sr 228):
//       active  — bid_end_date still in the future (or unset)
//       expired — bid_end_date already passed
// ─────────────────────────────────────────────────────────────────────
async function getNoResponseDetail(buyer_company_id, user_id, hotel_ids = [], start_date, end_date) {
  const hf = hotelFilter();
  const hasDates = start_date && end_date;
  const dateFilter = hasDates ? 'AND r.timestamp BETWEEN $2 AND $3' : '';
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params);

  const rows = await db.any(
    `SELECT
       r.id,
       r.rfq_no,
       r.title,
       r.bid_end_date,
       (SELECT hch.name
          FROM tbl_rfq_hotel_mappings rhm0
          JOIN tbl_hospitality_company_hotels hch ON hch.id = rhm0.hotel_id
          WHERE rhm0.rfq_id = r.id AND rhm0.hotel_id = ANY($4)
          LIMIT 1) as hotel_name,
       (SELECT COUNT(*) FROM tbl_rfq_product_vendors rpv WHERE rpv.rfq_id = r.id) as invited_vendor_count,
       CASE
         WHEN r.bid_end_date IS NOT NULL AND r.bid_end_date != ''
              AND DATE(r.bid_end_date) < ${IST_TODAY}
         THEN true ELSE false
       END as is_expired
     FROM tbl_rfq r
     WHERE ${companyScope()} AND r.is_published = 1 AND r.status = 1
     AND NOT EXISTS (SELECT 1 FROM tbl_quotes q WHERE q.rfq_id = r.id)
     ${dateFilter} ${hf} ${sc}
     ORDER BY r.bid_end_date ASC NULLS LAST`,
    params
  );

  const shape = (r) => ({
    id: r.id,
    rfq_no: r.rfq_no,
    title: r.title,
    bid_end_date: r.bid_end_date,
    hotel_name: r.hotel_name,
    invited_vendor_count: parseInt(r.invited_vendor_count, 10),
  });

  return {
    active: rows.filter((r) => !r.is_expired).map(shape),
    expired: rows.filter((r) => r.is_expired).map(shape),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 2. Procurement Snapshot
// ─────────────────────────────────────────────────────────────────────
async function getProcurementSnapshotData(buyer_company_id, user_id, hotel_ids = [], start_date, end_date) {
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  // One shared fragment: every query below binds the identical param array, so
  // the RBAC values can be appended once and reused across all seven.
  const sc = scopeFilter(user_id, 'r', params);

  const totalRfqsQuery = db.one(
    `SELECT COUNT(*) as count FROM tbl_rfq r
     WHERE ${companyScope()} AND r.timestamp BETWEEN $2 AND $3 ${hf} ${sc}`,
    params
  );

  const activeTendersQuery = db.one(
    `SELECT COUNT(*) as count FROM tbl_rfq r
     WHERE ${companyScope()} AND r.is_tender = 1 AND r.is_published = 1 AND r.status = 1 ${hf} ${sc}`,
    params
  );

  // Active RFQs: currently live (published, OPEN). Reflects current state, so
  // intentionally NOT date-filtered (matches active_tenders semantics).
  const activeRfqsQuery = db.one(
    `SELECT COUNT(*) as count FROM tbl_rfq r
     WHERE ${companyScope()} AND r.is_published = 1 AND r.status = 1 ${hf} ${sc}`,
    params
  );

  // Closed RFQs: in CLOSED state (status=2), scoped to the selected period
  // via the RFQ creation timestamp.
  const closedRfqsQuery = db.one(
    `SELECT COUNT(*) as count FROM tbl_rfq r
     WHERE ${companyScope()} AND r.status = 2 AND r.timestamp BETWEEN $2 AND $3 ${hf} ${sc}`,
    params
  );

  // Item 5 (D): exclude draft and cancelled POs to match total_spend's basis
  // (total_spend already filters po.status NOT IN ('draft','cancelled')).
  // This ensures pos_issued and the SpendBreakupModal's "across N purchase
  // orders" subtitle are drawn from the same PO population.
  const posIssuedQuery = db.one(
    `SELECT COUNT(*) as count
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq r ON r.id = po.rfq_id
     WHERE ${companyScope()} AND po.created_at BETWEEN $2 AND $3
     AND po.status NOT IN ('draft', 'cancelled') ${hf} ${sc}`,
    params
  );

  // Total Spend with a Base / GST / Total breakup (Sr 235). total_price is the
  // authoritative all-in line value; GST is derived per line from charges_meta
  // (percentage-of-basic unless tax_mode='absolute'), matching the PO-detail
  // pricing roll-up in poDashboardModel.js. Base = Total − GST so the three
  // figures always reconcile.
  const totalSpendQuery = db.one(
    `SELECT
       COALESCE(SUM(pop.total_price), 0) as total_incl_gst,
       COALESCE(SUM(
         CASE
           WHEN (pop.charges_meta->>'tax') IS NULL THEN 0
           WHEN pop.charges_meta->>'tax_mode' = 'absolute'
             THEN (pop.charges_meta->>'tax')::numeric
           ELSE (pop.unit_price * pop.quantity) * (pop.charges_meta->>'tax')::numeric / 100
         END
       ), 0) as total_gst
     FROM tbl_rfq_purchase_order po
     JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
     JOIN tbl_rfq r ON r.id = po.rfq_id
     WHERE ${companyScope()} AND po.created_at BETWEEN $2 AND $3
     AND po.status NOT IN ('draft', 'cancelled') ${hf} ${sc}`,
    params
  );

  // Avg turnaround: RFQ publish → finalization
  const avgTurnaroundQuery = db.one(
    `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (qf.timestamp - r.tender_publish_date)) / 86400), 0) as avg_turnaround
     FROM tbl_quote_finalization qf
     JOIN tbl_rfq r ON r.id = qf.rfq_id
     WHERE ${companyScope()} AND qf.timestamp BETWEEN $2 AND $3
     AND r.tender_publish_date IS NOT NULL ${hf} ${sc}`,
    params
  );

  const [tr, ar, cr, at, pi, ts, avt] = await Promise.all([
    totalRfqsQuery, activeRfqsQuery, closedRfqsQuery, activeTendersQuery, posIssuedQuery, totalSpendQuery, avgTurnaroundQuery,
  ]);

  const totalInclGst = parseFloat(ts.total_incl_gst);
  const totalGst = parseFloat(ts.total_gst);
  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    total_rfqs: parseInt(tr.count, 10),
    active_rfqs: parseInt(ar.count, 10),
    closed_rfqs: parseInt(cr.count, 10),
    active_tenders: parseInt(at.count, 10),
    pos_issued: parseInt(pi.count, 10),
    // total_spend kept as the all-in figure for backward compatibility.
    total_spend: totalInclGst,
    spend_breakup: {
      base_excl_gst: round2(totalInclGst - totalGst),
      total_gst: round2(totalGst),
      total_incl_gst: round2(totalInclGst),
    },
    avg_turnaround: parseFloat(parseFloat(avt.avg_turnaround).toFixed(1)),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 3. Negotiation Savings
// ─────────────────────────────────────────────────────────────────────
//
// ONE DEFINITION OF "SAVED", SHARED WITH THE NEGOTIATION MODULE.
//
// Every savings figure on this dashboard is priced by
// negotiationModel.getNegotiationParentSavings — the same function that prices
// the negotiation listing's parent cards and agrees with the round-detail
// page's `cumulative` tile. The dashboard does NOT carry its own copy of the
// maths, so the two surfaces cannot drift apart again.
//
// WHAT IT REPLACED, AND WHY (all measured against production 2026-08-01):
//
//   The widget used to join `tbl_negotiation_rounds nr ON ... AND
//   nr.round_number = 1` for the baseline and take the last round as achieved.
//   That was wrong three times over and under-reported by ~23×:
//
//   1. It only saw 274 of 441 quote pairs. 167 pairs sit on RFQs with no round
//      numbered 1 — legacy numbering is PER PRODUCT and the current allocator
//      is RFQ-wide, so "round 1" is not a thing every RFQ has — and those
//      contributed NOTHING.
//   2. 243 of the 274 it did see (89%) compared a round against ITSELF. On a
//      single-round negotiation round 1 IS the last round, so the delta is
//      exactly ₹0. The real baseline for a first round is the vendor's
//      ORIGINAL RFQ quote, in tbl_quote_item_history, which it never read.
//   3. What survived was then inflated by a clamp: suppressing genuine price
//      RISES instead of subtracting them turned a real ₹3,15,379 into
//      ₹4,26,825.
//
//   Over the whole production dataset, all-time, all hotels:
//     OLD  274 pairs · baseline ₹4,07,77,896 · saved ₹3,15,379
//          (₹4,26,825 once the rises are clamped away)
//     NEW  427 pairs · baseline ₹8,03,94,568 · saved ₹98,45,639
//   The negotiation module reports ₹98,45,639 on ₹8,04,14,568 over 428 pairs —
//   the same saved figure to the rupee. The one-pair, ₹20,000 baseline gap is
//   RFQ 344, which the Sr-240 exclusion below drops (its only PO was rejected)
//   and which saved ₹0 anyway.
//
// THE RULE, in full: per (vendor, rfq_product) pair, over the parent's
// NON-CANCELLED rounds, BASELINE from the EARLIEST round via the ladder
// previous_price → quote_history → prior_round → current_quote, ACHIEVED from
// the LATEST round. SIGNED and NEVER clamped — 7 production RFQs genuinely
// ended higher than they started, and hiding that is what caused this.
//
// ⚠️ SECURITY: getNegotiationParentSavings reads tbl_quotes / tbl_quote_items /
// tbl_quote_item_history and carries NO scope predicate of its own. Every
// caller below feeds it ONLY rfq ids that already survived a scoped query
// (companyScope + hotelFilter + the RBAC scopeFilter, or created_by = the
// caller). Never hand it ids from a request body, a facet or a filter.
const EMPTY_SAVINGS = Object.freeze({
  baseline: 0, achieved: 0, saved: 0, pairs: 0, parents: 0,
  baseline_awarded: 0, achieved_awarded: 0, saved_awarded: 0, pairs_awarded: 0,
});

async function priceNegotiations(rfqIds) {
  const ids = [...new Set((rfqIds || []).map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return { ...EMPTY_SAVINGS };
  const rows = await negotiationModel.getNegotiationParentSavings(ids);
  const sum = (key) => rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
  const baseline = sum('baseline_total');
  const achieved = sum('achieved_total');
  const baselineAwarded = sum('baseline_total_awarded');
  const achievedAwarded = sum('achieved_total_awarded');
  return {
    baseline,
    achieved,
    saved: baseline - achieved,
    pairs: sum('pairs_counted'),
    // RFQs that actually produced a priced pair — an RFQ whose rounds carry no
    // vendor response is in scope but contributes nothing and is not counted.
    parents: rows.filter((r) => (Number(r.pairs_counted) || 0) > 0).length,
    baseline_awarded: baselineAwarded,
    achieved_awarded: achievedAwarded,
    saved_awarded: baselineAwarded - achievedAwarded,
    pairs_awarded: sum('pairs_counted_awarded'),
  };
}

async function getNegotiationSavingsData(buyer_company_id, user_id, hotel_ids = [], start_date, end_date) {
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params);

  const scopedRfqs = await db.any(
    `SELECT DISTINCT nr.rfq_id
       FROM tbl_negotiation_rounds nr
       JOIN tbl_rfq r ON r.id = nr.rfq_id
      WHERE ${companyScope()} AND nr.created_at BETWEEN $2 AND $3 ${hf} ${sc}
        -- Sr 240: exclude Terminated/Rejected RFQs. WITHDRAWN (status=5) is the
        -- terminated/rejected-by-us state; also drop RFQs whose only PO was
        -- rejected by the vendor (no surviving non-rejected/cancelled PO).
        AND r.status <> 5
        AND NOT (
          EXISTS (SELECT 1 FROM tbl_rfq_purchase_order po WHERE po.rfq_id = r.id)
          AND NOT EXISTS (
            SELECT 1 FROM tbl_rfq_purchase_order po2
            WHERE po2.rfq_id = r.id
            AND po2.status NOT IN ('rejected_by_vendor', 'cancelled')
          )
        )`,
    params
  );

  const totals = await priceNegotiations(scopedRfqs.map((r) => r.rfq_id));

  return {
    // SIGNED. A negative total means the negotiations in this window ended
    // above their baseline — that is a real outcome, not a rendering problem.
    total_savings: totals.saved,
    market_baseline: totals.baseline,
    negotiated_total: totals.achieved,
    negotiation_count: totals.pairs,
    // The realised benefit: the same maths restricted to the vendor whose quote
    // was actually APPROVED. Additive — the headline above stays all-vendor, on
    // the same basis as the negotiation listing's primary figure — so the FE can
    // surface both without either number changing meaning.
    awarded: {
      total_savings: totals.saved_awarded,
      market_baseline: totals.baseline_awarded,
      negotiated_total: totals.achieved_awarded,
      negotiation_count: totals.pairs_awarded,
    },
    top_category_saving: { name: null, percentage: 0 },
    cost_avoidance: totals.saved,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 4. Cost Intelligence
// ─────────────────────────────────────────────────────────────────────
async function getCostIntelligenceData(buyer_company_id, user_id, hotel_ids = [], start_date, end_date, product_variant_id = null, duration_type = 'past7days') {
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params);

  // Item selector — ordered by purchase VALUE so the highest-spend (A-class)
  // items lead the dropdown (Sr 301), not an arbitrary first item (Sr 302).
  let topProducts = await db.any(
    `WITH item_value AS (
       SELECT rp.product_variant_id,
         SUM(pop.total_price) as value,
         COUNT(DISTINCT po.id) as order_count
       FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       JOIN tbl_rfq r ON r.id = po.rfq_id
       WHERE ${companyScope()} AND po.created_at BETWEEN $2 AND $3
       AND po.status NOT IN ('draft', 'cancelled') ${hf} ${sc}
       GROUP BY rp.product_variant_id
     )
     SELECT iv.product_variant_id, pv.name as product_name, iv.order_count, iv.value
     FROM item_value iv
     JOIN tbl_product_variant pv ON pv.id = iv.product_variant_id
     ORDER BY iv.value DESC NULLS LAST
     LIMIT 8`,
    params
  );

  // Fallback: items with RFQ activity but no PO spend yet, so the widget still
  // shows something when nothing has been purchased in the period.
  if (topProducts.length === 0) {
    topProducts = await db.any(
      `SELECT rp.product_variant_id, pv.name as product_name, COUNT(*) as order_count, 0 as value
       FROM tbl_rfq_products rp
       JOIN tbl_rfq r ON r.id = rp.rfq_id AND ${companyScope()}
       JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
       WHERE r.timestamp BETWEEN $2 AND $3 ${hf} ${sc}
       GROUP BY rp.product_variant_id, pv.name
       ORDER BY order_count DESC
       LIMIT 8`,
      params
    );
  }

  if (topProducts.length === 0) {
    return { top_products: [], price_trend: { labels: [], avg: [], max: [], min: [] }, vendor_comparison: [], benchmark: null };
  }

  const pid = product_variant_id || topProducts[0].product_variant_id;

  // Time granularity: day for short ranges, month for long ones (Sr 301
  // "month-wise"). Falls back to span-based detection for custom/FY ranges.
  const truncMap = {
    past7days: 'day',
    past15days: 'day',
    currentMonth: 'day',
    past6months: 'month',
  };
  let trunc = truncMap[duration_type];
  if (!trunc) {
    const spanDays = (new Date(end_date) - new Date(start_date)) / 86400000;
    trunc = Number.isFinite(spanDays) && spanDays > 62 ? 'month' : 'day';
  }

  // The three per-item panels bind $5 = the selected variant, so they need
  // their own param array: `params` already carries the RBAC values appended
  // above and pushing pid onto it would land at $11, not $5.
  //
  // `product_variant_id` arrives from the query string. It is NOT validated
  // against a whitelist — it does not need to be, because the same 4-axis
  // scope filter is applied to every panel below. Asking for an item outside
  // your scope returns an empty trend, an empty vendor list and a null
  // benchmark rather than another business unit's price history.
  const pidParams = [buyer_company_id, start_date, end_date, hotel_ids, pid];
  const pidSc = scopeFilter(user_id, 'r', pidParams);

  // Generate complete time series with gaps filled as nulls
  // Then LEFT JOIN actual price data onto it
  const priceTrendQuery = db.any(
    `WITH series AS (
       SELECT generate_series(
         DATE_TRUNC('${trunc}', $2::timestamp),
         DATE_TRUNC('${trunc}', $3::timestamp),
         '1 ${trunc}'::interval
       ) as period
     ),
     prices AS (
       -- Per-UNIT prices so the trend is comparable across orders and against
       -- the per-unit benchmark (best price paid). Line totals (qi.total_price)
       -- scale with quantity and are NOT a valid price-benchmark basis.
       SELECT DATE_TRUNC('${trunc}', q.timestamp) as period,
         AVG(qi.unit_price) as avg_price,
         MAX(qi.unit_price) as max_price,
         MIN(qi.unit_price) as min_price
       FROM tbl_quote_items qi
       JOIN tbl_quotes q ON q.id = qi.quote_id
       JOIN tbl_rfq r ON r.id = q.rfq_id AND ${companyScope()}
       WHERE qi.product_variant_id = $5
       AND q.timestamp BETWEEN $2 AND $3 ${hf} ${pidSc}
       GROUP BY DATE_TRUNC('${trunc}', q.timestamp)
     )
     SELECT s.period, p.avg_price, p.max_price, p.min_price
     FROM series s
     LEFT JOIN prices p ON p.period = s.period
     ORDER BY s.period`,
    pidParams
  );

  // Vendor comparison using per-UNIT price (consistent with the trend + benchmark).
  const vendorComparisonQuery = db.any(
    `SELECT u.name as vendor_name, COALESCE(c.company_name, u.organization_name) as company_name,
       AVG(qi.unit_price) as avg_price
     FROM tbl_quote_items qi
     JOIN tbl_quotes q ON q.id = qi.quote_id
     JOIN tbl_rfq r ON r.id = q.rfq_id AND ${companyScope()}
     JOIN tbl_users u ON u.id = q.created_by
     LEFT JOIN tbl_company c ON c.id = u.company_id
     WHERE qi.product_variant_id = $5
     AND q.timestamp BETWEEN $2 AND $3 ${hf} ${pidSc}
     GROUP BY u.id, u.name, c.company_name, u.organization_name
     ORDER BY avg_price ASC LIMIT 5`,
    pidParams
  );

  // Benchmark = best (lowest) unit price ever PAID for this item (all-time,
  // value-based) — the reference the client wants purchases compared against
  // (Sr 299/300/301). No date filter: "previously paid" spans history.
  const benchmarkQuery = db.oneOrNone(
    `SELECT MIN(pop.unit_price) as benchmark_price, MAX(po.created_at) as last_purchased_at
     FROM tbl_purchase_order_product pop
     JOIN tbl_rfq_purchase_order po ON po.id = pop.purchase_order_id
     JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
     JOIN tbl_rfq r ON r.id = po.rfq_id
     WHERE ${companyScope()} AND rp.product_variant_id = $5
     AND po.status NOT IN ('draft', 'cancelled') ${hf} ${pidSc}`,
    pidParams
  );

  const [priceTrend, vendorComparison, benchmarkRow] = await Promise.all([
    priceTrendQuery, vendorComparisonQuery, benchmarkQuery,
  ]);
  const bestPrice = vendorComparison.length > 0 ? parseFloat(vendorComparison[0].avg_price) : null;

  // Latest non-zero average in the trend = the "current" price level.
  const avgSeries = priceTrend
    .map((pt) => (pt.avg_price ? parseFloat(pt.avg_price) : null))
    .filter((v) => v != null && v > 0);
  const currentPrice = avgSeries.length ? avgSeries[avgSeries.length - 1] : null;
  const benchmarkPrice = benchmarkRow && benchmarkRow.benchmark_price != null
    ? parseFloat(benchmarkRow.benchmark_price) : null;
  const vsBenchmarkPct = benchmarkPrice && currentPrice
    ? parseFloat((((currentPrice - benchmarkPrice) / benchmarkPrice) * 100).toFixed(1))
    : null;

  return {
    top_products: topProducts.map((p) => ({
      product_variant_id: p.product_variant_id,
      product_name: p.product_name,
      order_count: parseInt(p.order_count, 10),
      value: p.value != null ? parseFloat(parseFloat(p.value).toFixed(2)) : 0,
    })),
    selected_product_variant_id: pid,
    granularity: trunc,
    benchmark: {
      product_variant_id: pid,
      benchmark_price: benchmarkPrice != null ? parseFloat(benchmarkPrice.toFixed(2)) : null,
      current_price: currentPrice != null ? parseFloat(currentPrice.toFixed(2)) : null,
      vs_benchmark_pct: vsBenchmarkPct,
      last_purchased_at: benchmarkRow ? benchmarkRow.last_purchased_at : null,
    },
    price_trend: {
      labels: priceTrend.map((pt) => pt.period),
      avg: priceTrend.map((pt) => pt.avg_price ? parseFloat(parseFloat(pt.avg_price).toFixed(2)) : 0),
      max: priceTrend.map((pt) => pt.max_price ? parseFloat(parseFloat(pt.max_price).toFixed(2)) : 0),
      min: priceTrend.map((pt) => pt.min_price ? parseFloat(parseFloat(pt.min_price).toFixed(2)) : 0),
    },
    vendor_comparison: vendorComparison.map((vc) => ({
      vendor_name: vc.vendor_name,
      company_name: vc.company_name,
      avg_price: parseFloat(parseFloat(vc.avg_price).toFixed(2)),
      is_best: parseFloat(vc.avg_price) === bestPrice,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 5. Category Insights
//    Aggregates spend FIRST, then resolves a bucket label per product variant
//    to avoid row multiplication. The `dimension` param (Sr 296) selects the
//    grouping label:
//      category    — top-level category (rolls a sub-category up to its parent)
//      subcategory — the category the product is mapped to (the leaf)
//      item        — the product variant itself
//    Top 12 buckets are returned; the remainder collapse into an "Others" row.
// ─────────────────────────────────────────────────────────────────────
function categoryLabelCte(dimension) {
  if (dimension === 'item') {
    return `product_bucket AS (
       SELECT pv.id as product_variant_id,
         COALESCE(NULLIF(pv.name, ''), 'Unknown item') as bucket_name
       FROM tbl_product_variant pv
     )`;
  }
  if (dimension === 'subcategory') {
    return `product_bucket AS (
       SELECT DISTINCT ON (pv.id)
         pv.id as product_variant_id,
         COALESCE(cat.title, 'Uncategorized') as bucket_name
       FROM tbl_product_variant pv
       LEFT JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
       LEFT JOIN tbl_category cat ON cat.id = pc.category_id
       ORDER BY pv.id, cat.title
     )`;
  }
  // default: top-level category (parent of the mapped category when nested).
  return `product_bucket AS (
       SELECT DISTINCT ON (pv.id)
         pv.id as product_variant_id,
         COALESCE(parent.title, cat.title, 'Uncategorized') as bucket_name
       FROM tbl_product_variant pv
       LEFT JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
       LEFT JOIN tbl_category cat ON cat.id = pc.category_id
       LEFT JOIN tbl_category parent ON parent.id = cat.parent_id
       ORDER BY pv.id, COALESCE(parent.title, cat.title)
     )`;
}

async function getCategoryInsightsData(buyer_company_id, user_id, hotel_ids = [], start_date, end_date, dimension = 'category') {
  const dim = ['category', 'subcategory', 'item'].includes(dimension) ? dimension : 'category';
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params);

  const rows = await db.any(
    `WITH product_spend AS (
       SELECT
         rp.product_variant_id,
         SUM(pop.total_price) as spend_amount,
         COUNT(DISTINCT r.id) as rfq_count
       FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       JOIN tbl_rfq r ON r.id = po.rfq_id
       WHERE ${companyScope()} AND po.created_at BETWEEN $2 AND $3
       AND po.status NOT IN ('draft', 'cancelled') ${hf} ${sc}
       GROUP BY rp.product_variant_id
     ),
     ${categoryLabelCte(dim)}
     SELECT
       COALESCE(pb.bucket_name, 'Uncategorized') as category_name,
       SUM(ps.spend_amount) as spend_amount,
       SUM(ps.rfq_count) as rfq_count
     FROM product_spend ps
     LEFT JOIN product_bucket pb ON pb.product_variant_id = ps.product_variant_id
     GROUP BY pb.bucket_name
     ORDER BY spend_amount DESC`,
    params
  );

  const totalSpend = rows.reduce((sum, c) => sum + parseFloat(c.spend_amount), 0);

  // Keep the top 12 buckets readable; collapse the long tail into "Others".
  const TOP_N = 12;
  const top = rows.slice(0, TOP_N);
  const rest = rows.slice(TOP_N);
  const buckets = top.map((c) => ({
    category_name: c.category_name,
    spend_amount: parseFloat(c.spend_amount),
    rfq_count: parseInt(c.rfq_count, 10),
  }));
  if (rest.length > 0) {
    buckets.push({
      category_name: 'Others',
      spend_amount: rest.reduce((s, c) => s + parseFloat(c.spend_amount), 0),
      rfq_count: rest.reduce((s, c) => s + parseInt(c.rfq_count, 10), 0),
    });
  }

  return {
    dimension: dim,
    categories: buckets.map((c) => ({
      ...c,
      percentage: totalSpend > 0
        ? parseFloat(((c.spend_amount / totalSpend) * 100).toFixed(1))
        : 0,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 5b. ABC Analysis (Pareto) — classify procured items into A/B/C tiers by
//     cumulative contribution to the chosen metric (value=spend or
//     volume=quantity), respecting the selected period (Sr 297/298/303).
//       A: items making up the first ~70% of the metric
//       B: the next ~20% (70–90%)
//       C: the bottom ~10% (90–100%)
//     An item is assigned by the cumulative % BEFORE it, so the largest item
//     is always A and the boundary item is included in the higher tier.
// ─────────────────────────────────────────────────────────────────────
async function getAbcAnalysisData(buyer_company_id, user_id, hotel_ids = [], start_date, end_date, metric = 'value') {
  const m = metric === 'volume' ? 'volume' : 'value';
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params);
  const round2 = (n) => Math.round(n * 100) / 100;

  const rows = await db.any(
    `WITH item_spend AS (
       SELECT
         rp.product_variant_id,
         SUM(pop.total_price) as value,
         SUM(pop.quantity) as volume
       FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       JOIN tbl_rfq r ON r.id = po.rfq_id
       WHERE ${companyScope()} AND po.created_at BETWEEN $2 AND $3
       AND po.status NOT IN ('draft', 'cancelled') ${hf} ${sc}
       GROUP BY rp.product_variant_id
     )
     SELECT
       it.product_variant_id,
       COALESCE(NULLIF(pv.name, ''), 'Unknown item') as name,
       COALESCE(it.value, 0) as value,
       COALESCE(it.volume, 0) as volume
     FROM item_spend it
     LEFT JOIN tbl_product_variant pv ON pv.id = it.product_variant_id
     ORDER BY (CASE WHEN '${m}' = 'volume' THEN it.volume ELSE it.value END) DESC NULLS LAST`,
    params
  );

  const metricOf = (r) => parseFloat(m === 'volume' ? r.volume : r.value) || 0;
  const total = rows.reduce((s, r) => s + metricOf(r), 0);

  let cumulative = 0;
  const classified = rows.map((r, i) => {
    const prevPct = total > 0 ? (cumulative / total) * 100 : 0;
    cumulative += metricOf(r);
    let cls = 'C';
    if (prevPct < 70) cls = 'A';
    else if (prevPct < 90) cls = 'B';
    return {
      product_variant_id: r.product_variant_id,
      name: r.name,
      value: round2(parseFloat(r.value) || 0),
      volume: round2(parseFloat(r.volume) || 0),
      class: cls,
      rank: i + 1,
    };
  });

  const classes = ['A', 'B', 'C'].map((c) => {
    const items = classified.filter((x) => x.class === c);
    const classMetric = items.reduce((s, x) => s + (m === 'volume' ? x.volume : x.value), 0);
    return {
      class: c,
      item_count: items.length,
      value: round2(items.reduce((s, x) => s + x.value, 0)),
      volume: round2(items.reduce((s, x) => s + x.volume, 0)),
      metric_pct: total > 0 ? parseFloat(((classMetric / total) * 100).toFixed(1)) : 0,
      item_pct: classified.length > 0 ? parseFloat(((items.length / classified.length) * 100).toFixed(1)) : 0,
    };
  });

  return {
    metric: m,
    total_items: classified.length,
    total_value: round2(classified.reduce((s, x) => s + x.value, 0)),
    total_volume: round2(classified.reduce((s, x) => s + x.volume, 0)),
    classes,
    items: classified.slice(0, 50), // top 50 for display; classification uses all
  };
}

// ─────────────────────────────────────────────────────────────────────
// 6. Workflow Efficiency — derived from actual table timestamps
//    Each stage duration computed from real columns, not lifecycle table.
// ─────────────────────────────────────────────────────────────────────
async function getWorkflowEfficiencyData(buyer_company_id, user_id, hotel_ids = [], start_date, end_date) {
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params);

  const stages = await db.any(
    `WITH scoped_rfqs AS (
       SELECT r.id, r.timestamp as created_at, r.tender_publish_date
       FROM tbl_rfq r
       WHERE ${companyScope()} AND r.timestamp BETWEEN $2 AND $3 ${hf} ${sc}
     ),

     -- 1. Draft → RFQ Approval submitted
     rfq_approval AS (
       SELECT 'rfq_approval' as stage,
         COUNT(*) as rfq_count,
         AVG(EXTRACT(EPOCH FROM (ai.completed_at - ai.created_at)) / 3600) as avg_hours
       FROM tbl_approval_instances ai
       JOIN scoped_rfqs sr ON sr.id = ai.entity_id
       WHERE ai.entity_type IN ('RFQ', 'TENDER') AND ai.completed_at IS NOT NULL
     ),

     -- 2. Published → First quote received
     quote_wait AS (
       SELECT 'quote_wait' as stage,
         COUNT(*) as rfq_count,
         AVG(EXTRACT(EPOCH FROM (first_quote - sr.tender_publish_date)) / 3600) as avg_hours
       FROM scoped_rfqs sr
       JOIN LATERAL (
         SELECT MIN(q.timestamp) as first_quote
         FROM tbl_quotes q WHERE q.rfq_id = sr.id
       ) fq ON fq.first_quote IS NOT NULL
       WHERE sr.tender_publish_date IS NOT NULL
     ),

     -- 3. Technical Evaluation: time from bid_end_date to tech eval completion
     tech_evaluation AS (
       SELECT 'tech_evaluation' as stage,
         COUNT(DISTINCT te.rfq_id) as rfq_count,
         AVG(EXTRACT(EPOCH FROM (last_eval.evaluated_at - DATE(r.bid_end_date))) / 3600) as avg_hours
       FROM tbl_rfq_product_tech_evaluation te
       JOIN scoped_rfqs sr ON sr.id = te.rfq_id
       JOIN tbl_rfq r ON r.id = te.rfq_id AND r.bid_end_date != ''
       JOIN LATERAL (
         SELECT MAX(cv.timestamp) as evaluated_at
         FROM tbl_rfq_product_tech_evaluation_cleared_vendors cv
         WHERE cv.tbl_rfq_product_tech_evaluation_id = te.id
       ) last_eval ON last_eval.evaluated_at IS NOT NULL
     ),

     -- 4. Technical Approval
     tech_approval AS (
       SELECT 'tech_approval' as stage,
         COUNT(*) as rfq_count,
         AVG(EXTRACT(EPOCH FROM (ai.completed_at - ai.created_at)) / 3600) as avg_hours
       FROM tbl_approval_instances ai
       JOIN scoped_rfqs sr ON sr.id = COALESCE((ai.metadata->>'rfq_id')::int, ai.entity_id)
       WHERE ai.entity_type = 'TECHNICAL' AND ai.completed_at IS NOT NULL
     ),

     -- 5. Negotiation duration
     negotiation AS (
       SELECT 'negotiation' as stage,
         COUNT(DISTINCT nr.rfq_id) as rfq_count,
         AVG(EXTRACT(EPOCH FROM (COALESCE(nr.closed_at, nr.approved_at) - nr.created_at)) / 3600) as avg_hours
       FROM tbl_negotiation_rounds nr
       JOIN scoped_rfqs sr ON sr.id = nr.rfq_id
       WHERE nr.closed_at IS NOT NULL OR nr.approved_at IS NOT NULL
     ),

     -- 6. Commercial Evaluation: time from quotes received to vendor finalization
     commercial_evaluation AS (
       SELECT 'commercial_evaluation' as stage,
         COUNT(DISTINCT qf.rfq_id) as rfq_count,
         AVG(EXTRACT(EPOCH FROM (qf.timestamp - fq.first_quote)) / 3600) as avg_hours
       FROM tbl_quote_finalization qf
       JOIN scoped_rfqs sr ON sr.id = qf.rfq_id
       JOIN LATERAL (
         SELECT MIN(q.timestamp) as first_quote FROM tbl_quotes q WHERE q.rfq_id = qf.rfq_id
       ) fq ON fq.first_quote IS NOT NULL
     ),

     -- 7. Commercial approval (negotiation quote approval)
     commercial_approval AS (
       SELECT 'commercial_approval' as stage,
         COUNT(*) as rfq_count,
         AVG(EXTRACT(EPOCH FROM (ai.completed_at - ai.created_at)) / 3600) as avg_hours
       FROM tbl_approval_instances ai
       JOIN scoped_rfqs sr ON sr.id = (ai.metadata->>'rfq_id')::int
       WHERE ai.entity_type = 'NEGOTIATION_QUOTE' AND ai.completed_at IS NOT NULL
       AND ai.metadata->>'rfq_id' IS NOT NULL
     ),

     -- 5. PO approval
     po_approval AS (
       SELECT 'po_approval' as stage,
         COUNT(*) as rfq_count,
         AVG(EXTRACT(EPOCH FROM (ai.completed_at - ai.created_at)) / 3600) as avg_hours
       FROM tbl_approval_instances ai
       JOIN scoped_rfqs sr ON sr.id = (ai.metadata->>'rfq_id')::int
       WHERE ai.entity_type = 'PO' AND ai.completed_at IS NOT NULL
       AND ai.metadata->>'rfq_id' IS NOT NULL
     ),

     -- 6. Vendor action on PO
     vendor_action AS (
       SELECT 'vendor_action' as stage,
         COUNT(*) as rfq_count,
         AVG(EXTRACT(EPOCH FROM (po.vendor_action_at - po.created_at)) / 3600) as avg_hours
       FROM tbl_rfq_purchase_order po
       JOIN scoped_rfqs sr ON sr.id = po.rfq_id
       WHERE po.vendor_action_at IS NOT NULL
     )

     SELECT * FROM rfq_approval WHERE rfq_count > 0
     UNION ALL SELECT * FROM quote_wait WHERE rfq_count > 0
     UNION ALL SELECT * FROM tech_evaluation WHERE rfq_count > 0
     UNION ALL SELECT * FROM tech_approval WHERE rfq_count > 0
     UNION ALL SELECT * FROM negotiation WHERE rfq_count > 0
     UNION ALL SELECT * FROM commercial_evaluation WHERE rfq_count > 0
     UNION ALL SELECT * FROM commercial_approval WHERE rfq_count > 0
     UNION ALL SELECT * FROM po_approval WHERE rfq_count > 0
     UNION ALL SELECT * FROM vendor_action WHERE rfq_count > 0`,
    params
  );

  if (stages.length === 0) return { stages: [] };

  return {
    stages: stages.map((s) => ({
      stage_name: s.stage,
      rfq_count: parseInt(s.rfq_count, 10),
      avg_dwell_time_hours: parseFloat(parseFloat(s.avg_hours || 0).toFixed(1)),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 7. Smart Insights
// ─────────────────────────────────────────────────────────────────────
async function getSmartInsightsData(buyer_company_id, user_id, hotel_ids = [], start_date, end_date) {
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params);
  // Second alias for the benchmark LATERAL below, correlated on r2.
  const sc2 = scopeFilter(user_id, 'r2', params);

  // CROSS-TENANT LEAK (P0, fixed here).
  //
  // The `market` LATERAL used to read tbl_quote_items with NO predicate other
  // than the product variant:
  //     SELECT AVG(qi2.unit_price) FROM tbl_quote_items qi2
  //      WHERE qi2.product_variant_id = qi.product_variant_id
  // — every quote from every buyer on the platform. That average was then
  // rendered verbatim into the insight copy at the bottom of this function
  // ("Market: ₹…"), so one tenant's negotiated unit prices reached another
  // tenant's screen. Verified on production: 3 product variants are quoted by
  // both buyer_company 13 and 90, and for OVAL TABLE (variant 13038) the
  // HAVING below is satisfied — company 13's own average of ₹6,800 (₹11,000 +
  // ₹2,600 over two quotes) is compared against a "market" of ₹4,533.33, a
  // figure only reachable by averaging in company 90's ₹0.00 row. A number
  // arithmetically impossible from company 13's own data was being rendered
  // to company 13 as their market benchmark.
  //
  // The LATERAL now walks quote → rfq → the same company/hotel/RBAC scope as
  // the outer query. The comparison it expresses becomes "this period's price
  // vs YOUR OWN all-time average for this item" (the LATERAL stays deliberately
  // date-unbounded, which is what made it a useful baseline in the first place).
  const priceDeviationsQuery = db.any(
    `SELECT pv.name as product_name,
       AVG(qi.unit_price) as user_avg_price,
       market.avg_price as market_avg_price,
       ROUND(((AVG(qi.unit_price) - market.avg_price) / market.avg_price * 100)::numeric, 1) as deviation_pct
     FROM tbl_quote_items qi
     JOIN tbl_quotes q ON q.id = qi.quote_id
     JOIN tbl_rfq r ON r.id = q.rfq_id AND ${companyScope()}
     JOIN tbl_product_variant pv ON pv.id = qi.product_variant_id
     CROSS JOIN LATERAL (
       SELECT AVG(qi2.unit_price) as avg_price
       FROM tbl_quote_items qi2
       JOIN tbl_quotes q2 ON q2.id = qi2.quote_id
       JOIN tbl_rfq r2 ON r2.id = q2.rfq_id AND ${companyScope('r2')}
       WHERE qi2.product_variant_id = qi.product_variant_id
       ${hotelFilter('r2')} ${sc2}
     ) market
     WHERE q.timestamp BETWEEN $2 AND $3 ${hf} ${sc} AND market.avg_price > 0
     GROUP BY pv.name, market.avg_price
     HAVING AVG(qi.unit_price) > market.avg_price * 1.15
     LIMIT 3`,
    params
  );

  const bestVendorQuery = db.oneOrNone(
    `SELECT u.name as vendor_name, COALESCE(c.company_name, u.organization_name) as company_name,
       COUNT(*) as best_price_count
     FROM tbl_quote_items qi
     JOIN tbl_quotes q ON q.id = qi.quote_id
     JOIN tbl_rfq r ON r.id = q.rfq_id AND ${companyScope()}
     JOIN tbl_users u ON u.id = q.created_by
     LEFT JOIN tbl_company c ON c.id = u.company_id
     WHERE q.timestamp BETWEEN $2 AND $3 ${hf} ${sc}
     -- The MIN() subquery is correlated on qi.rfq_id, so it can only ever read
     -- quotes belonging to the same RFQ (and therefore the same tenant).
     AND qi.unit_price = (
       SELECT MIN(qi2.unit_price) FROM tbl_quote_items qi2
       WHERE qi2.rfq_id = qi.rfq_id AND qi2.product_variant_id = qi.product_variant_id
     )
     GROUP BY u.id, u.name, c.company_name, u.organization_name
     ORDER BY best_price_count DESC LIMIT 1`,
    params
  );

  const periodDuration = `($3::timestamp - $2::timestamp)`;
  const spendTrendQuery = db.oneOrNone(
    `WITH current_spend AS (
       SELECT COALESCE(SUM(pop.total_price), 0) as total
       FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       JOIN tbl_rfq r ON r.id = po.rfq_id
       WHERE ${companyScope()} AND po.created_at BETWEEN $2 AND $3
       AND po.status NOT IN ('draft', 'cancelled') ${hf} ${sc}
     ),
     previous_spend AS (
       SELECT COALESCE(SUM(pop.total_price), 0) as total
       FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       JOIN tbl_rfq r ON r.id = po.rfq_id
       WHERE ${companyScope()}
       AND po.created_at BETWEEN ($2::timestamp - ${periodDuration}) AND $2
       AND po.status NOT IN ('draft', 'cancelled') ${hf} ${sc}
     )
     SELECT cs.total as current_spend, ps.total as previous_spend,
       CASE WHEN ps.total > 0
         THEN ROUND(((cs.total - ps.total) / ps.total * 100)::numeric, 1)
         ELSE 0
       END as change_pct
     FROM current_spend cs, previous_spend ps`,
    params
  );

  // Sr 299: items paid in-period ABOVE the best price previously paid for them
  // (value-based benchmark, same as the Price benchmarking widget). Ordered by
  // in-period spend so the highest-impact (A-class) items surface first.
  const benchmarkDeviationsQuery = db.any(
    `WITH item_po AS (
       SELECT rp.product_variant_id,
         SUM(pop.total_price) as period_value,
         (ARRAY_AGG(pop.unit_price ORDER BY po.created_at DESC))[1] as latest_price
       FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       JOIN tbl_rfq r ON r.id = po.rfq_id
       WHERE ${companyScope()} AND po.created_at BETWEEN $2 AND $3
       AND po.status NOT IN ('draft', 'cancelled') ${hf} ${sc}
       GROUP BY rp.product_variant_id
     ),
     benchmark AS (
       SELECT rp.product_variant_id, MIN(pop.unit_price) as best_price
       FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       JOIN tbl_rfq r ON r.id = po.rfq_id
       WHERE ${companyScope()} AND po.status NOT IN ('draft', 'cancelled') ${hf} ${sc}
       GROUP BY rp.product_variant_id
     )
     SELECT pv.name as product_name, ip.latest_price, b.best_price, ip.period_value,
       ROUND(((ip.latest_price - b.best_price) / b.best_price * 100)::numeric, 1) as above_pct
     FROM item_po ip
     JOIN benchmark b ON b.product_variant_id = ip.product_variant_id
     JOIN tbl_product_variant pv ON pv.id = ip.product_variant_id
     WHERE b.best_price > 0 AND ip.latest_price > b.best_price * 1.1
     ORDER BY ip.period_value DESC
     LIMIT 3`,
    params
  );

  const [priceDeviations, bestVendor, spendTrend, benchmarkDeviations] = await Promise.all([
    priceDeviationsQuery, bestVendorQuery, spendTrendQuery, benchmarkDeviationsQuery,
  ]);

  const insights = [];

  benchmarkDeviations.forEach((bd) => {
    insights.push({
      type: 'benchmark_alert',
      severity: parseFloat(bd.above_pct) > 25 ? 'high' : 'medium',
      title: `${bd.product_name} above price benchmark`,
      description: `Latest purchase is ${bd.above_pct}% above the best price paid.<br/>Benchmark: ₹${parseFloat(bd.best_price).toFixed(2)}, Latest: ₹${parseFloat(bd.latest_price).toFixed(2)}.`,
      action_label: 'View benchmarking',
      action_url: '/dashboard/buyer',
    });
  });

  priceDeviations.forEach((pd) => {
    insights.push({
      type: 'price_alert',
      severity: parseFloat(pd.deviation_pct) > 25 ? 'high' : 'medium',
      title: `${pd.product_name} priced above market`,
      description: `Paying ${pd.deviation_pct}% above market average.<br/>Market: ₹${parseFloat(pd.market_avg_price).toFixed(2)}, Yours: ₹${parseFloat(pd.user_avg_price).toFixed(2)}.`,
      action_label: 'Review Quotes',
      action_url: '/rfq?product=' + encodeURIComponent(pd.product_name),
    });
  });

  if (bestVendor) {
    insights.push({
      type: 'vendor_optimization',
      severity: 'low',
      title: `${bestVendor.company_name || bestVendor.vendor_name} offers best pricing`,
      description: `Lowest price on ${bestVendor.best_price_count} product(s) this period. Consider consolidating orders.`,
      action_label: 'View Vendor',
      action_url: '/vendors',
    });
  }

  if (spendTrend && parseFloat(spendTrend.previous_spend) > 0) {
    const pct = parseFloat(spendTrend.change_pct);
    const dir = pct > 0 ? 'increased' : 'decreased';
    insights.push({
      type: 'spend_trend',
      severity: Math.abs(pct) > 20 ? 'high' : Math.abs(pct) > 10 ? 'medium' : 'low',
      title: `Spend ${dir} by ${Math.abs(pct)}%`,
      description: `Procurement spend has ${dir} by ${Math.abs(pct)}% compared to the previous period.`,
      action_label: 'View Spend Report',
      action_url: '/dashboard/spend',
    });
  }

  return { insights };
}

// ─────────────────────────────────────────────────────────────────────
// 8. Pending Approvals (detailed list for modal)
// ─────────────────────────────────────────────────────────────────────
// Hotel scope: this list is the drill-down behind the Action Centre's
// `pending_approvals` badge, and its count sibling in getActionCenterData
// already filters `i.hotel_id = ANY(...)`. This query did not, so the badge and
// the list it opens disagreed — and the list leaked approvals filed at business
// units outside the caller's scope, including RFQ titles, ARC numbers and the
// hotel name. The approver-is-me predicate bounded the damage but not the axis.
async function getPendingApprovalsDetail(buyer_company_id, user_id, hotel_ids = [], start_date, end_date) {
  return db.any(
    `SELECT
       i.id as approval_id,
       i.entity_type,
       i.entity_id,
       i.metadata,
       i.current_step,
       s.step_order,
       i.created_at,
       ROUND(EXTRACT(EPOCH FROM (NOW() - i.created_at)) / 3600) as waiting_hours,
       -- Resolve the owning RFQ id for all RFQ-family types.
       -- RFQ/TENDER: entity_id IS the rfq id.
       -- TECHNICAL/NEGOTIATION/NEGOTIATION_QUOTE/PO: rfq_id is stored in
       -- metadata->>'rfq_id'; fall back to entity_id if missing/non-numeric.
       CASE
         WHEN i.entity_type IN ('RFQ','TENDER') THEN i.entity_id
         WHEN i.entity_type IN ('TECHNICAL','NEGOTIATION','NEGOTIATION_QUOTE','PO')
           THEN COALESCE(NULLIF(i.metadata->>'rfq_id','')::int, i.entity_id)
         ELSE NULL
       END as rfq_ref_id,
       -- entity_title and entity_rfq_no are now populated for ALL RFQ-family
       -- types via the LEFT JOIN on rfq_ref_id below.
       r.title as entity_title,
       r.rfq_no as entity_rfq_no,
       -- ARC enrichment: resolve the parent rate-contract id + number for the
       -- ARC_* entity types so the Action Centre can deep-link to the right
       -- stage tab. ARC_TECH/ARC_COMMITTEE/ARC_PUBLISH.entity_id IS the arc id;
       -- an amendment's entity_id is the amendment id → hop through its contract.
       CASE
         WHEN i.entity_type IN ('ARC_TECH','ARC_COMMITTEE','ARC_PUBLISH') THEN i.entity_id
         WHEN i.entity_type = 'ARC_AMENDMENT' THEN amdc.arc_id
         ELSE NULL
       END as arc_id,
       ac.arc_number as arc_number,
       ac.title as arc_title,
       hch.name as hotel_name,
       (SELECT COUNT(*) FROM tbl_approval_policy_steps ps
        WHERE ps.approval_policy_id = i.approval_policy_id) as total_steps
     FROM tbl_approval_instances i
     JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
     JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
     -- Join tbl_rfq on the resolved rfq_ref_id (covers RFQ/TENDER/TECHNICAL/
     -- NEGOTIATION/NEGOTIATION_QUOTE/PO in one shot; non-RFQ rows get NULL).
     LEFT JOIN tbl_rfq r ON r.id = (
       CASE
         WHEN i.entity_type IN ('RFQ','TENDER') THEN i.entity_id
         WHEN i.entity_type IN ('TECHNICAL','NEGOTIATION','NEGOTIATION_QUOTE','PO')
           THEN COALESCE(NULLIF(i.metadata->>'rfq_id','')::int, i.entity_id)
         ELSE NULL
       END
     )
     LEFT JOIN tbl_arc_amendment amd  ON i.entity_type = 'ARC_AMENDMENT' AND amd.id = i.entity_id
     LEFT JOIN tbl_arc_contract amdc  ON amdc.id = amd.arc_contract_id
     LEFT JOIN tbl_arc ac ON
       (i.entity_type IN ('ARC_TECH','ARC_COMMITTEE','ARC_PUBLISH') AND ac.id = i.entity_id)
       OR (i.entity_type = 'ARC_AMENDMENT' AND ac.id = amdc.arc_id)
     LEFT JOIN tbl_hospitality_company_hotels hch ON hch.id = i.hotel_id
     WHERE i.status = 'PENDING'
     AND sa.approver_user_id = $2
     AND sa.status = 'PENDING'
     AND s.step_order = i.current_step
     AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
     AND NOT (
       i.entity_type IN ('RFQ', 'TENDER')
       AND EXISTS (SELECT 1 FROM tbl_rfq r2 WHERE r2.id = i.entity_id AND r2.is_published = 1)
     )
     AND i.created_at BETWEEN $3 AND $4
     AND i.hotel_id = ANY($5)
     ORDER BY i.created_at ASC`,
    [buyer_company_id, user_id, start_date, end_date, hotel_ids]
  );
}

// ─────────────────────────────────────────────────────────────────────
// 9. Rejected POs (detail list for modal)
// ─────────────────────────────────────────────────────────────────────
async function getRejectedPOsDetail(buyer_company_id, user_id, hotel_ids = []) {
  const params = [buyer_company_id, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params);
  return db.any(
    `SELECT
       po.id as po_id,
       po.rfq_id,
       po.status,
       po.created_at,
       po.vendor_action_at as rejected_at,
       r.title as rfq_title,
       r.rfq_no,
       u_vendor.name as vendor_name,
       COALESCE(c_vendor.company_name, u_vendor.organization_name) as vendor_company,
       hch.name as hotel_name,
       (SELECT STRING_AGG(COALESCE(pv.name, 'Product'), ', ' ORDER BY pop2.id)
        FROM tbl_purchase_order_product pop2
        LEFT JOIN tbl_rfq_products rp ON rp.id = pop2.rfq_product_id
        LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
        WHERE pop2.purchase_order_id = po.id
       ) as product_names,
       COALESCE(SUM(pop.total_price), 0) as po_value
     FROM tbl_rfq_purchase_order po
     JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
     JOIN tbl_rfq r ON r.id = po.rfq_id
     LEFT JOIN tbl_users u_vendor ON u_vendor.id = po.finalized_vendor_id
     LEFT JOIN tbl_company c_vendor ON c_vendor.id = u_vendor.company_id
     LEFT JOIN tbl_rfq_hotel_mappings rhm ON rhm.rfq_id = r.id
     LEFT JOIN tbl_hospitality_company_hotels hch ON hch.id = rhm.hotel_id
     WHERE ${companyScope()} AND po.status = 'rejected_by_vendor'
     AND NOT EXISTS (
       SELECT 1 FROM tbl_rfq_purchase_order po2
       JOIN tbl_purchase_order_product pop2 ON pop2.purchase_order_id = po2.id
       WHERE po2.rfq_id = po.rfq_id
       AND pop2.rfq_product_id = pop.rfq_product_id
       AND po2.id != po.id
       AND po2.status NOT IN ('rejected_by_vendor', 'cancelled')
     )
     AND rhm.hotel_id = ANY($2)
     ${sc}
     GROUP BY po.id, po.rfq_id, po.status, po.created_at, po.vendor_action_at,
       r.title, r.rfq_no, u_vendor.name, c_vendor.company_name, u_vendor.organization_name, hch.name
     ORDER BY po.vendor_action_at DESC NULLS LAST`,
    params
  );
}

// ═══════════════════════════════════════════════════════════════════
// Role-aware dashboard — persona widget queries
//
// Each query scopes data by buyer_company_id (via tbl_hospitality_companies)
// + hotel_ids array (via tbl_rfq_hotel_mappings for RFQ-rooted data, or
// tbl_approval_instances.hotel_id for approval-rooted data) + user_id
// (always req.user.id — backend never trusts client-supplied user id).
// ═══════════════════════════════════════════════════════════════════

// ── RFQ Creator: my_drafts ─────────────────────────────────────────
async function getMyDraftsData(buyer_company_id, user_id, hotel_ids, start_date, end_date) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, oldest_updated_at: null, items: [] };
  }
  // Drafts: is_published=0 AND status NOT IN (5 withdrawn, 2 closed).
  // Date filter applies on r.timestamp (creation/touch time).
  const dateClause = start_date && end_date
    ? `AND r."timestamp" BETWEEN $4::timestamp AND $5::timestamp`
    : "";
  const params = start_date && end_date
    ? [buyer_company_id, user_id, hotel_ids, start_date, end_date]
    : [buyer_company_id, user_id, hotel_ids];
  const rows = await db.any(
    `SELECT r.id, r.rfq_no, r.title,
            r."timestamp" AS updated_at,
            (SELECT COUNT(*)::int FROM tbl_rfq_products rp WHERE rp.rfq_id = r.id) AS product_count
     FROM tbl_rfq r
     WHERE ${companyScope()}
       AND r.is_published = 0
       AND r.status NOT IN (5, 2)
       AND r.created_by = $2
       AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm
                   WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3))
       ${dateClause}
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 50`,
    params
  );
  const items = rows.map((r) => ({
    id: r.id,
    rfq_no: r.rfq_no,
    title: r.title,
    product_count: r.product_count,
    updated_at: r.updated_at,
  }));
  const count = items.length;
  // Oldest is the LAST item after DESC sort.
  const oldest = items.length ? items[items.length - 1].updated_at : null;
  return { count, oldest_updated_at: oldest, items };
}

// ── RFQ Creator: my_active_rfqs ────────────────────────────────────
async function getMyActiveRfqsData(buyer_company_id, user_id, hotel_ids, start_date, end_date) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { total: 0, stages: [] };
  }
  const dateClause = start_date && end_date
    ? `AND r."timestamp" BETWEEN $4::timestamp AND $5::timestamp`
    : "";
  const params = start_date && end_date
    ? [buyer_company_id, user_id, hotel_ids, start_date, end_date]
    : [buyer_company_id, user_id, hotel_ids];
  // "Live" = is_published=1 AND status=1 (Open).
  // Derive stage from joined sub-state:
  //   awaiting_vendor_quotes — no quotes yet
  //   quote_compare          — has quotes, no live negotiation round
  //   negotiation            — has live negotiation round (status != CLOSED)
  //   awaiting_approval      — has PENDING approval instance for the RFQ
  //   awarded                — has at least one PO
  const rows = await db.any(
    `WITH live_rfqs AS (
       SELECT r.id, r."timestamp" AS created_ts
       FROM tbl_rfq r
       WHERE ${companyScope()}
         AND r.is_published = 1
         AND r.status = 1
         AND r.created_by = $2
         AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm
                     WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3))
         ${dateClause}
     ),
     stage_assignment AS (
       SELECT
         lr.id AS rfq_id,
         lr.created_ts,
         CASE
           WHEN EXISTS (SELECT 1 FROM tbl_rfq_purchase_order po WHERE po.rfq_id = lr.id)
             THEN 'awarded'
           WHEN EXISTS (
             SELECT 1 FROM tbl_approval_instances i
             WHERE i.entity_id = lr.id
               AND i.entity_type IN ('RFQ', 'TENDER')
               AND i.status = 'PENDING'
           )
             THEN 'awaiting_approval'
           WHEN EXISTS (
             SELECT 1 FROM tbl_negotiation_rounds nr
             WHERE nr.rfq_id = lr.id
               AND nr.status NOT IN ('CLOSED')
           )
             THEN 'negotiation'
           WHEN EXISTS (SELECT 1 FROM tbl_quotes q WHERE q.rfq_id = lr.id)
             THEN 'quote_compare'
           ELSE 'awaiting_vendor_quotes'
         END AS stage
       FROM live_rfqs lr
     )
     SELECT stage,
            COUNT(*)::int AS count,
            EXTRACT(EPOCH FROM (NOW() - MIN(created_ts)))::int AS oldest_age_seconds
     FROM stage_assignment
     GROUP BY stage`,
    params
  );
  const stages = rows.map((r) => ({
    stage: r.stage,
    count: r.count,
    oldest_age_days: Math.floor((r.oldest_age_seconds || 0) / 86400),
  }));
  const total = stages.reduce((s, r) => s + r.count, 0);
  return { total, stages };
}

// ── RFQ Creator: my_no_response_rfqs ───────────────────────────────
async function getMyNoResponseRfqsData(buyer_company_id, user_id, hotel_ids, start_date, end_date) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, silent_vendor_count: 0, items: [] };
  }
  // Live RFQs of this user whose bid_end_date is still in the future.
  // RFQs whose bid window has already closed move to the urgent-attention
  // widget (getMyRfqsBidClosedNoQuotesData) — not surfaced here so
  // creators can focus on RFQs they can still salvage.
  const dateClause = start_date && end_date
    ? `AND r."timestamp" BETWEEN $4::timestamp AND $5::timestamp`
    : "";
  const params = start_date && end_date
    ? [buyer_company_id, user_id, hotel_ids, start_date, end_date]
    : [buyer_company_id, user_id, hotel_ids];
  const rows = await db.any(
    `WITH my_live_rfqs AS (
       SELECT r.id, r.rfq_no, r.title, r.bid_end_date
       FROM tbl_rfq r
       WHERE ${companyScope()}
         AND r.is_published = 1
         AND r.status = 1
         AND r.created_by = $2
         AND r.bid_end_date IS NOT NULL
         AND r.bid_end_date != ''
         AND DATE(r.bid_end_date) >= ${IST_TODAY}
         AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm
                     WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3))
         ${dateClause}
     ),
     vendor_status AS (
       SELECT
         rpv.rfq_id,
         rpv.user_id AS vendor_id,
         EXISTS (
           SELECT 1 FROM tbl_quotes q
           WHERE q.rfq_id = rpv.rfq_id AND q.created_by = rpv.user_id
         ) AS has_responded
       FROM tbl_rfq_product_vendors rpv
       WHERE rpv.rfq_id IN (SELECT id FROM my_live_rfqs)
       GROUP BY rpv.rfq_id, rpv.user_id
     ),
     rfq_silent_counts AS (
       SELECT
         vs.rfq_id,
         COUNT(*) FILTER (WHERE has_responded = false)::int AS silent_count,
         COUNT(*)::int AS total_count
       FROM vendor_status vs
       GROUP BY vs.rfq_id
     )
     SELECT mlr.id, mlr.rfq_no, mlr.title, mlr.bid_end_date,
            rsc.silent_count AS silent_vendor_count,
            rsc.total_count AS total_vendor_count
     FROM my_live_rfqs mlr
     JOIN rfq_silent_counts rsc ON rsc.rfq_id = mlr.id
     WHERE rsc.silent_count > 0
     ORDER BY rsc.silent_count DESC, mlr.bid_end_date ASC
     LIMIT 50`,
    params
  );
  const items = rows.map((r) => ({
    id: r.id,
    rfq_no: r.rfq_no,
    title: r.title,
    bid_end_date: r.bid_end_date,
    silent_vendor_count: r.silent_vendor_count,
    total_vendor_count: r.total_vendor_count,
  }));
  const silent_vendor_count = items.reduce(
    (s, r) => s + r.silent_vendor_count,
    0
  );
  return { count: items.length, silent_vendor_count, items };
}

// ── RFQ Creator: my_rfqs_bid_closed_no_quotes ─────────────────────
// RFQs whose bid_end_date has passed but no vendor responded.
// High-urgency: the creator may need to re-publish, extend the bid
// window, or escalate to procurement.
async function getMyRfqsBidClosedNoQuotesData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, items: [] };
  }
  const rows = await db.any(
    `SELECT r.id, r.rfq_no, r.title, r.bid_end_date,
            (${IST_TODAY} - DATE(r.bid_end_date))::int AS days_overdue
     FROM tbl_rfq r
     WHERE ${companyScope()}
       AND r.is_published = 1
       AND r.created_by = $2
       AND r.bid_end_date IS NOT NULL
       AND r.bid_end_date != ''
       AND DATE(r.bid_end_date) < ${IST_TODAY}
       AND r.status IN (1, 2)
       AND NOT EXISTS (SELECT 1 FROM tbl_quotes q WHERE q.rfq_id = r.id)
       AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm
                   WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3))
     ORDER BY r.bid_end_date ASC
     LIMIT 50`,
    [buyer_company_id, user_id, hotel_ids]
  );
  return {
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      rfq_no: r.rfq_no,
      title: r.title,
      bid_end_date: r.bid_end_date,
      days_overdue: r.days_overdue,
    })),
  };
}

// ── Tech Evaluator: my_tech_evals_pending ─────────────────────────
async function getMyTechEvalsPendingData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, oldest_opened_at: null, items: [] };
  }
  // Tech evals share a queue — tbl_rfq_product_tech_evaluation has no
  // per-user assignment column (verified against the production schema), so
  // "my" cannot mean "assigned to me".
  //
  // The previous comment here claimed "the dashboard permission gate has
  // already filtered out users who shouldn't see this widget". THAT GATE DOES
  // NOT EXIST — no /dashboard-v2 route carries acl() or any permission check,
  // and this model had no RBAC join at all. The widget was therefore
  // buyer-ACCOUNT-wide: every incomplete tech-eval across all eight legal
  // entities under one buyer_company_id.
  //
  // "My" now means the tightest binding the schema supports: evaluations whose
  // RFQ falls inside THIS caller's own role-scope tuple (company × hotel ×
  // department × process) and for which they hold a technical read permission.
  // A Procurement-scoped evaluator no longer sees Engineering's queue.
  const params = [buyer_company_id, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params, TECH_SCOPE_PERMISSIONS);
  const rows = await db.any(
    `SELECT te.id,
            te.rfq_id,
            te.tbl_rfq_product_id AS product_id,
            te."timestamp" AS opened_at,
            r.rfq_no,
            pv.name AS product_name
     FROM tbl_rfq_product_tech_evaluation te
     JOIN tbl_rfq r ON r.id = te.rfq_id AND ${companyScope()}
     JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id
     JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
     WHERE te.is_complete = false
       AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm
                   WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($2))
       ${sc}
     ORDER BY te."timestamp" ASC
     LIMIT 50`,
    params
  );
  const items = rows.map((r) => ({
    id: r.id,
    rfq_id: r.rfq_id,
    product_id: r.product_id,
    rfq_no: r.rfq_no,
    product_name: r.product_name,
    opened_at: r.opened_at,
  }));
  return {
    count: items.length,
    oldest_opened_at: items.length ? items[0].opened_at : null,
    items,
  };
}

// ── Tech Evaluator: tech_evals_with_vendor_disagreements ──────────
async function getTechEvalsWithDisagreementsData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, total_disagreement_clauses: 0, items: [] };
  }
  // Same treatment as getMyTechEvalsPendingData: this rollup exposed vendor
  // disagreement counts and product names for every business unit under the
  // billing account.
  const params = [buyer_company_id, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params, TECH_SCOPE_PERMISSIONS);
  const rows = await db.any(
    `WITH disagreements AS (
       SELECT te.id            AS tech_eval_id,
              te.rfq_id        AS rfq_id,
              te.tbl_rfq_product_id AS rfq_product_id,
              c.id             AS clause_id,
              vr.vendor_id     AS vendor_id
       FROM tbl_rfq_product_tech_evaluation te
       JOIN tbl_rfq_product_tech_evaluation_clauses c
         ON c.tbl_rfq_product_tech_evaluation_id = te.id
       JOIN tbl_rfq_product_tech_evaluation_vendors_response vr
         ON vr.tbl_rfq_product_tech_evaluation_clauses_id = c.id
       JOIN tbl_rfq r ON r.id = te.rfq_id AND ${companyScope()}
       WHERE te.is_complete = false
         AND LOWER(TRIM(vr.vendor_response)) = 'disagree'
         AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm
                     WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($2))
         ${sc}
     ),
     per_eval AS (
       SELECT
         tech_eval_id,
         rfq_id,
         rfq_product_id,
         COUNT(DISTINCT vendor_id)::int AS disagreeing_vendor_count,
         COUNT(DISTINCT clause_id)::int AS disagreeing_clause_count
       FROM disagreements
       GROUP BY tech_eval_id, rfq_id, rfq_product_id
     )
     SELECT pe.tech_eval_id AS id,
            pe.rfq_id,
            pe.rfq_product_id AS product_id,
            pe.disagreeing_vendor_count,
            pe.disagreeing_clause_count,
            r.rfq_no,
            pv.name AS product_name
     FROM per_eval pe
     JOIN tbl_rfq r ON r.id = pe.rfq_id
     JOIN tbl_rfq_products rp ON rp.id = pe.rfq_product_id
     JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
     ORDER BY pe.disagreeing_vendor_count DESC, pe.disagreeing_clause_count DESC
     LIMIT 50`,
    params
  );
  const items = rows.map((r) => ({
    id: r.id,
    rfq_id: r.rfq_id,
    product_id: r.product_id,
    rfq_no: r.rfq_no,
    product_name: r.product_name,
    disagreeing_vendor_count: r.disagreeing_vendor_count,
    disagreeing_clause_count: r.disagreeing_clause_count,
  }));
  const total_disagreement_clauses = items.reduce(
    (s, r) => s + r.disagreeing_clause_count,
    0
  );
  return { count: items.length, total_disagreement_clauses, items };
}

// ── Tech Evaluator: tech_eval_throughput ──────────────────────────
async function getTechEvalThroughputData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return {
      current_period_avg_hours: null,
      prior_period_avg_hours: null,
      delta_pct: null,
      unit: "hrs",
      sparkline: [],
    };
  }
  // Throughput = avg(completed_at - opened_at). We approximate
  // "completed_at" as the latest vendor-response score_timestamp on any
  // clause under a complete tech-eval — that's when scoring closed.
  // Current vs prior period: last 30 days vs previous 30 days.
  //
  // A rollup rather than a list, but it was still averaging over every
  // business unit in the billing account, so a hotel-scoped evaluator was
  // benchmarked against other legal entities' turnaround.
  const params = [buyer_company_id, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params, TECH_SCOPE_PERMISSIONS);
  const row = await db.oneOrNone(
    `WITH completed_evals AS (
       SELECT te.id,
              te."timestamp" AS opened_at,
              MAX(vr.score_timestamp) AS completed_at
       FROM tbl_rfq_product_tech_evaluation te
       JOIN tbl_rfq_product_tech_evaluation_clauses c
         ON c.tbl_rfq_product_tech_evaluation_id = te.id
       JOIN tbl_rfq_product_tech_evaluation_vendors_response vr
         ON vr.tbl_rfq_product_tech_evaluation_clauses_id = c.id
       JOIN tbl_rfq r ON r.id = te.rfq_id AND ${companyScope()}
       WHERE te.is_complete = true
         AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm
                     WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($2))
         ${sc}
       GROUP BY te.id, te."timestamp"
     )
     SELECT
       AVG(EXTRACT(EPOCH FROM (completed_at - opened_at)) / 3600.0)
         FILTER (WHERE completed_at >= NOW() - INTERVAL '30 days') AS current_avg,
       AVG(EXTRACT(EPOCH FROM (completed_at - opened_at)) / 3600.0)
         FILTER (WHERE completed_at >= NOW() - INTERVAL '60 days'
                  AND completed_at <  NOW() - INTERVAL '30 days') AS prior_avg
     FROM completed_evals`,
    params
  );
  const sparkRows = await db.any(
    `WITH completed_evals AS (
       SELECT te."timestamp" AS opened_at,
              MAX(vr.score_timestamp) AS completed_at
       FROM tbl_rfq_product_tech_evaluation te
       JOIN tbl_rfq_product_tech_evaluation_clauses c
         ON c.tbl_rfq_product_tech_evaluation_id = te.id
       JOIN tbl_rfq_product_tech_evaluation_vendors_response vr
         ON vr.tbl_rfq_product_tech_evaluation_clauses_id = c.id
       JOIN tbl_rfq r ON r.id = te.rfq_id AND ${companyScope()}
       WHERE te.is_complete = true
         AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm
                     WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($2))
         ${sc}
       GROUP BY te.id, te."timestamp"
     )
     SELECT
       FLOOR(EXTRACT(EPOCH FROM (NOW() - completed_at)) / (86400 * 7))::int AS weeks_ago,
       AVG(EXTRACT(EPOCH FROM (completed_at - opened_at)) / 3600.0) AS avg_hours
     FROM completed_evals
     WHERE completed_at >= NOW() - INTERVAL '28 days'
     GROUP BY weeks_ago
     ORDER BY weeks_ago DESC`,
    params
  );
  const rawSparkline = [0, 0, 0, 0];
  for (const r of sparkRows) {
    const idx = 3 - r.weeks_ago;
    if (idx >= 0 && idx <= 3) rawSparkline[idx] = Number(r.avg_hours) || 0;
  }
  const curHours = row?.current_avg != null ? Number(row.current_avg) : null;
  const priorHours = row?.prior_avg != null ? Number(row.prior_avg) : null;
  let delta_pct = null;
  if (curHours != null && priorHours != null && priorHours > 0) {
    delta_pct = ((curHours - priorHours) / priorHours) * 100;
  }
  return scaleThroughput(curHours, priorHours, delta_pct, rawSparkline);
}

/** Helper: pick the most readable unit (hrs vs days) based on the current
 *  period's magnitude. When current_avg is >= 48h we switch to days so the
 *  number is human-friendly (e.g. 234h → 9.8 days). */
function scaleThroughput(currentHours, priorHours, deltaPct, sparklineHours) {
  const useDays = currentHours != null && currentHours >= 48;
  if (!useDays) {
    return {
      current_period_avg_hours: currentHours,
      prior_period_avg_hours: priorHours,
      // Mirror FE expectation: also expose current_period_avg (unit-agnostic).
      current_period_avg: currentHours,
      prior_period_avg: priorHours,
      delta_pct: deltaPct,
      unit: "hrs",
      sparkline: sparklineHours,
    };
  }
  const div = 24;
  return {
    current_period_avg_hours: currentHours,
    prior_period_avg_hours: priorHours,
    current_period_avg: currentHours / div,
    prior_period_avg: priorHours != null ? priorHours / div : null,
    delta_pct: deltaPct,
    unit: "days",
    sparkline: sparklineHours.map((h) => (h ? h / div : 0)),
  };
}

// ── Tech Approver: my_tech_approvals_pending ──────────────────────
async function getMyTechApprovalsPendingData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) return { count: 0, items: [] };
  const rows = await db.any(
    `SELECT i.id,
            i.entity_id AS rfq_id,
            i.created_at AS submitted_at
     FROM tbl_approval_instances i
     JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
     JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
     WHERE i.status = 'PENDING'
       AND i.entity_type = 'TECHNICAL'
       AND sa.approver_user_id = $2
       AND sa.status = 'PENDING'
       AND s.step_order = i.current_step
       AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
       AND i.hotel_id = ANY($3)
     ORDER BY i.created_at DESC
     LIMIT 50`,
    [buyer_company_id, user_id, hotel_ids]
  );
  return {
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      rfq_id: r.rfq_id,
      submitted_at: r.submitted_at,
    })),
  };
}

// ── Tech Approver: tech_approval_oldest_pending ───────────────────
async function getTechApprovalOldestPendingData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) return { items: [] };
  const rows = await db.any(
    `SELECT i.id,
            i.entity_id AS rfq_id,
            i.initiated_by,
            u.name AS submitted_by_name,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - i.created_at)) / 86400)::int AS age_days
     FROM tbl_approval_instances i
     JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
     JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
     LEFT JOIN tbl_users u ON u.id = i.initiated_by
     WHERE i.status = 'PENDING'
       AND i.entity_type = 'TECHNICAL'
       AND sa.approver_user_id = $2
       AND sa.status = 'PENDING'
       AND s.step_order = i.current_step
       AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
       AND i.hotel_id = ANY($3)
     ORDER BY i.created_at ASC
     LIMIT 5`,
    [buyer_company_id, user_id, hotel_ids]
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      rfq_id: r.rfq_id,
      submitted_by_name: r.submitted_by_name,
      age_days: r.age_days,
    })),
  };
}

// Shared helper: approval throughput for a given entity_type and user.
// Computes current-30d avg, prior-30d avg, delta %, and a 4-week sparkline.
async function approvalThroughput(buyer_company_id, user_id, hotel_ids, entity_type) {
  const row = await db.oneOrNone(
    `WITH my_acted AS (
       SELECT i.id,
              i.created_at,
              sa.acted_at
       FROM tbl_approval_instances i
       JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
       JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
       WHERE sa.approver_user_id = $2
         AND sa.status = 'APPROVED'
         AND sa.acted_at IS NOT NULL
         AND i.entity_type = $4
         AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
         AND i.hotel_id = ANY($3)
     )
     SELECT
       AVG(EXTRACT(EPOCH FROM (acted_at - created_at)) / 3600.0)
         FILTER (WHERE acted_at >= NOW() - INTERVAL '30 days') AS current_avg,
       AVG(EXTRACT(EPOCH FROM (acted_at - created_at)) / 3600.0)
         FILTER (WHERE acted_at >= NOW() - INTERVAL '60 days'
                  AND acted_at <  NOW() - INTERVAL '30 days') AS prior_avg
     FROM my_acted`,
    [buyer_company_id, user_id, hotel_ids, entity_type]
  );
  const sparkRows = await db.any(
    `WITH my_acted AS (
       SELECT i.created_at, sa.acted_at
       FROM tbl_approval_instances i
       JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
       JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
       WHERE sa.approver_user_id = $2
         AND sa.status = 'APPROVED'
         AND sa.acted_at IS NOT NULL
         AND i.entity_type = $4
         AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
         AND i.hotel_id = ANY($3)
     )
     SELECT FLOOR(EXTRACT(EPOCH FROM (NOW() - acted_at)) / (86400 * 7))::int AS weeks_ago,
            AVG(EXTRACT(EPOCH FROM (acted_at - created_at)) / 3600.0) AS avg_hours
     FROM my_acted
     WHERE acted_at >= NOW() - INTERVAL '28 days'
     GROUP BY weeks_ago
     ORDER BY weeks_ago DESC`,
    [buyer_company_id, user_id, hotel_ids, entity_type]
  );
  const rawSparkline = [0, 0, 0, 0];
  for (const r of sparkRows) {
    const idx = 3 - r.weeks_ago;
    if (idx >= 0 && idx <= 3) rawSparkline[idx] = Number(r.avg_hours) || 0;
  }
  const curHours = row?.current_avg != null ? Number(row.current_avg) : null;
  const priorHours = row?.prior_avg != null ? Number(row.prior_avg) : null;
  let delta_pct = null;
  if (curHours != null && priorHours != null && priorHours > 0) {
    delta_pct = ((curHours - priorHours) / priorHours) * 100;
  }
  return scaleThroughput(curHours, priorHours, delta_pct, rawSparkline);
}

async function getTechApprovalThroughputData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return {
      current_period_avg_hours: null,
      prior_period_avg_hours: null,
      delta_pct: null,
      unit: "hrs",
      sparkline: [],
    };
  }
  return approvalThroughput(buyer_company_id, user_id, hotel_ids, "TECHNICAL");
}

// ── Commercial Evaluator: my_quote_compares ───────────────────────
async function getMyQuoteComparesData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) return { count: 0, items: [] };
  // Quote-compare stage = live RFQ with quotes, no negotiation round, no PO.
  // No per-user assignment column exists, and the "dashboard permission gate"
  // this comment used to appeal to was never implemented — so the widget was
  // billing-account-wide. "My" now means the caller's own role-scope tuple
  // plus a commercial read permission.
  const params = [buyer_company_id, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params, COMMERCIAL_SCOPE_PERMISSIONS);
  const rows = await db.any(
    `WITH qc_rfqs AS (
       SELECT r.id, r.rfq_no, r.title, r."timestamp" AS entered_qc_at,
              (SELECT COUNT(DISTINCT q.created_by) FROM tbl_quotes q WHERE q.rfq_id = r.id) AS vendor_count
       FROM tbl_rfq r
       WHERE ${companyScope()}
         AND r.is_published = 1 AND r.status = 1
         AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm
                     WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($2))
         AND EXISTS (SELECT 1 FROM tbl_quotes q WHERE q.rfq_id = r.id)
         AND NOT EXISTS (
           SELECT 1 FROM tbl_negotiation_rounds nr
           WHERE nr.rfq_id = r.id
             AND nr.status NOT IN ('CLOSED', 'COMPLETED', 'EXPIRED')
         )
         AND NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order po WHERE po.rfq_id = r.id)
         ${sc}
     )
     SELECT * FROM qc_rfqs
     ORDER BY entered_qc_at ASC
     LIMIT 50`,
    params
  );
  return {
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      rfq_no: r.rfq_no,
      title: r.title,
      vendor_count: Number(r.vendor_count) || 0,
      entered_qc_at: r.entered_qc_at,
    })),
  };
}

// ── Commercial Evaluator: my_active_negotiations ──────────────────
async function getMyActiveNegotiationsData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, total_silent_vendors: 0, items: [] };
  }
  // Active rounds led by user. Silent vendors = invited (vendor_ids[])
  // minus those with quote rows for this round.
  const rows = await db.any(
    `WITH my_rounds AS (
       SELECT nr.id, nr.rfq_id, nr.round_number, nr.end_date, nr.vendor_ids,
              r.rfq_no, r.title AS rfq_title
       FROM tbl_negotiation_rounds nr
       JOIN tbl_rfq r ON r.id = nr.rfq_id AND ${companyScope()}
       WHERE nr.created_by = $2
         AND nr.status NOT IN ('CLOSED', 'COMPLETED', 'EXPIRED')
         AND nr.end_date IS NOT NULL
         AND nr.end_date > NOW()
         AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm
                     WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3))
     ),
     responded AS (
       SELECT mr.id AS round_id,
              COUNT(DISTINCT nrq.vendor_id)::int AS responded_count
       FROM my_rounds mr
       LEFT JOIN tbl_negotiation_round_quotes nrq
         ON nrq.negotiation_round_id = mr.id
       GROUP BY mr.id
     )
     SELECT mr.id, mr.rfq_id, mr.round_number, mr.end_date,
            mr.rfq_no, mr.rfq_title,
            COALESCE(array_length(mr.vendor_ids, 1), 0)::int AS invited_count,
            COALESCE(r.responded_count, 0) AS responded_count,
            GREATEST(
              COALESCE(array_length(mr.vendor_ids, 1), 0) - COALESCE(r.responded_count, 0),
              0
            )::int AS silent_vendor_count
     FROM my_rounds mr
     LEFT JOIN responded r ON r.round_id = mr.id
     ORDER BY mr.end_date ASC NULLS LAST`,
    [buyer_company_id, user_id, hotel_ids]
  );
  const items = rows.map((r) => ({
    id: r.id,
    rfq_id: r.rfq_id,
    rfq_no: r.rfq_no,
    rfq_title: r.rfq_title,
    round_number: r.round_number,
    round_end_date: r.end_date,
    silent_vendor_count: r.silent_vendor_count,
  }));
  const total_silent_vendors = items.reduce(
    (s, r) => s + r.silent_vendor_count,
    0
  );
  return { count: items.length, total_silent_vendors, items };
}

// ── Commercial Evaluator: savings_pipeline ────────────────────────
async function getSavingsPipelineData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return {
      total_savings: 0,
      prior_period_savings: 0,
      negotiation_count: 0,
      avg_savings_pct: 0,
    };
  }
  // Negotiations LED BY this user, priced by the shared ladder (see
  // getNegotiationSavingsData). Two windows: current 30d vs prior 30d, keyed on
  // when the negotiation closed.
  //
  // "Led by" used to mean `round_number = 1 AND created_by = $2`. That read the
  // stored column, which under legacy per-product numbering carried one row per
  // PRODUCT — so a 3-product RFQ produced three my_rfqs rows with three
  // different closed_at values and multiplied its own quote rows threefold —
  // and under RFQ-wide numbering carries at most one row per RFQ, which would
  // have dropped every negotiation the user opened on a later product. It is
  // now the RFQ's EARLIEST non-cancelled round: numbering-invariant, exactly
  // one row per RFQ, and the honest reading of who opened the negotiation.
  const computePeriod = async (intervalStart, intervalEnd) => {
    const rows = await db.any(
      `SELECT r.id AS rfq_id
         FROM tbl_rfq r
         JOIN LATERAL (
           SELECT nr.created_by, nr.closed_at
             FROM tbl_negotiation_rounds nr
            WHERE nr.rfq_id = r.id
              AND nr.status <> 'CANCELLED'
            ORDER BY nr.created_at, nr.id
            LIMIT 1
         ) first_round ON TRUE
        WHERE ${companyScope()}
          AND first_round.created_by = $2
          AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm
                      WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3))
          AND ${intervalStart === null
            ? 'TRUE'
            : `(first_round.closed_at IS NULL OR (first_round.closed_at >= NOW() - INTERVAL '${intervalEnd}' AND first_round.closed_at < NOW() - INTERVAL '${intervalStart}'))`}`,
      [buyer_company_id, user_id, hotel_ids]
    );
    const totals = await priceNegotiations(rows.map((r) => r.rfq_id));
    return {
      // Signed value: positive = saved, negative = lost (negotiated above
      // baseline). FE renders losses in red.
      savings: totals.saved,
      baseline: totals.baseline,
      final: totals.achieved,
      negotiation_count: totals.parents,
    };
  };

  const current = await computePeriod("0 days", "30 days");
  const prior = await computePeriod("30 days", "60 days");
  const avg_savings_pct = current.baseline > 0
    ? (current.savings / current.baseline) * 100
    : 0;
  return {
    total_savings: current.savings,
    prior_period_savings: prior.savings,
    negotiation_count: current.negotiation_count,
    avg_savings_pct,
  };
}

// ── Commercial Approver: my_commercial_approvals_pending ─────────
async function getMyCommercialApprovalsPendingData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, total_value: 0, top_by_value: [] };
  }
  const rows = await db.any(
    `SELECT i.id,
            i.entity_id AS po_id,
            i.created_at,
            po.po_number,
            po.total_value,
            po.rfq_id,
            r.rfq_no,
            r.title,
            u.name AS vendor_name,
            c.company_name AS vendor_company
     FROM tbl_approval_instances i
     JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
     JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
     JOIN tbl_rfq_purchase_order po ON po.id = i.entity_id
     JOIN tbl_rfq r ON r.id = po.rfq_id
     LEFT JOIN tbl_users u ON u.id = po.finalized_vendor_id
     LEFT JOIN tbl_company c ON c.id = u.company_id
     WHERE i.status = 'PENDING'
       AND i.entity_type = 'PO'
       AND sa.approver_user_id = $2
       AND sa.status = 'PENDING'
       AND s.step_order = i.current_step
       AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
       AND i.hotel_id = ANY($3)
     ORDER BY po.total_value DESC NULLS LAST, i.created_at DESC`,
    [buyer_company_id, user_id, hotel_ids]
  );
  const items = rows.map((r) => ({
    id: r.id,
    po_id: r.po_id,
    rfq_id: r.rfq_id,
    rfq_no: r.rfq_no,
    title: r.title,
    vendor_name: r.vendor_company || r.vendor_name,
    value: Number(r.total_value) || 0,
  }));
  const total_value = items.reduce((s, r) => s + r.value, 0);
  return {
    count: items.length,
    total_value,
    top_by_value: items.slice(0, 3),
  };
}

// ── Commercial Approver: deals_with_price_anomalies ──────────────
async function getDealsWithPriceAnomaliesData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) return { count: 0, items: [] };
  // For each pending PO approval on this user, compare unit_price on the
  // line item against the most recent COMPLETED PO for the same product
  // variant. If the awarded price is materially higher (≥10%), flag it.
  //
  // The `last_paid` CTE below applied companyScope() but NOT hotelFilter(),
  // so the "last paid" figure — and the product name attached to it — could be
  // sourced from any of the eight legal entities sharing the billing account.
  // An approver at one hotel was shown another company's unit price as their
  // own baseline, and the response body carried it as `last_paid_unit_price`.
  const params = [buyer_company_id, user_id, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params);
  const rows = await db.any(
    `WITH my_pending AS (
       SELECT i.id AS instance_id, po.id AS po_id, po.rfq_id, pop.id AS pop_id,
              pop.rfq_product_id, rp.product_variant_id,
              pop.unit_price AS awarded_unit_price,
              po.total_value
       FROM tbl_approval_instances i
       JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
       JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
       JOIN tbl_rfq_purchase_order po ON po.id = i.entity_id
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       WHERE i.status = 'PENDING'
         AND i.entity_type = 'PO'
         AND sa.approver_user_id = $2
         AND sa.status = 'PENDING'
         AND s.step_order = i.current_step
         AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
         AND i.hotel_id = ANY($3)
     ),
     last_paid AS (
       -- Most recent completed PO unit_price per product_variant, restricted
       -- to the caller's own hotels AND role scope — not merely to the
       -- billing account.
       SELECT DISTINCT ON (rp.product_variant_id)
         rp.product_variant_id,
         pop.unit_price AS last_paid_unit_price,
         po.created_at
       FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
       JOIN tbl_rfq r ON r.id = po.rfq_id AND ${companyScope()}
       WHERE po.status = 'completed'
       ${hotelFilter('r', 3)} ${sc}
       ORDER BY rp.product_variant_id, po.created_at DESC
     )
     SELECT mp.po_id, mp.rfq_id, mp.product_variant_id,
            mp.awarded_unit_price,
            lp.last_paid_unit_price,
            ((mp.awarded_unit_price - lp.last_paid_unit_price) / lp.last_paid_unit_price * 100) AS drift_pct,
            pv.name AS product_name
     FROM my_pending mp
     JOIN last_paid lp ON lp.product_variant_id = mp.product_variant_id
     JOIN tbl_product_variant pv ON pv.id = mp.product_variant_id
     WHERE lp.last_paid_unit_price > 0
       AND mp.awarded_unit_price > lp.last_paid_unit_price
       AND ((mp.awarded_unit_price - lp.last_paid_unit_price) / lp.last_paid_unit_price * 100) >= 10
     ORDER BY drift_pct DESC
     LIMIT 50`,
    params
  );
  const items = rows.map((r) => ({
    id: r.po_id,
    rfq_id: r.rfq_id,
    product_name: r.product_name,
    awarded_unit_price: Number(r.awarded_unit_price) || 0,
    last_paid_unit_price: Number(r.last_paid_unit_price) || 0,
    drift_pct: Number(r.drift_pct) || 0,
  }));
  return { count: items.length, items };
}

async function getCommercialApprovalThroughputData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return {
      current_period_avg_hours: null,
      prior_period_avg_hours: null,
      delta_pct: null,
      unit: "hrs",
      sparkline: [],
    };
  }
  return approvalThroughput(buyer_company_id, user_id, hotel_ids, "PO");
}

// ── Awarding P1/P2: my_award_approvals_pending ───────────────────
async function getMyAwardApprovalsPendingData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, total_value: 0, items: [] };
  }
  // Award approvals = NEGOTIATION_QUOTE entity_type (per backend convention).
  // Value derives from the underlying PO created/linked to the negotiation
  // quote (or 0 if no PO yet). We surface RFQ + vendor for context.
  const rows = await db.any(
    `SELECT i.id,
            i.entity_id AS negotiation_quote_id,
            i.created_at AS submitted_at,
            nrq.rfq_product_id,
            nrq.vendor_id,
            COALESCE(nrq.quoted_price, 0) AS quoted_price,
            r.id AS rfq_id,
            r.rfq_no,
            r.title,
            u.name AS vendor_name,
            c.company_name AS vendor_company
     FROM tbl_approval_instances i
     JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
     JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
     LEFT JOIN tbl_negotiation_round_quotes nrq ON nrq.id = i.entity_id
     LEFT JOIN tbl_negotiation_rounds nr ON nr.id = nrq.negotiation_round_id
     LEFT JOIN tbl_rfq r ON r.id = nr.rfq_id
     LEFT JOIN tbl_users u ON u.id = nrq.vendor_id
     LEFT JOIN tbl_company c ON c.id = u.company_id
     WHERE i.status = 'PENDING'
       AND i.entity_type = 'NEGOTIATION_QUOTE'
       AND sa.approver_user_id = $2
       AND sa.status = 'PENDING'
       AND s.step_order = i.current_step
       AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
       AND i.hotel_id = ANY($3)
     ORDER BY i.created_at DESC
     LIMIT 50`,
    [buyer_company_id, user_id, hotel_ids]
  );
  const items = rows.map((r) => ({
    id: r.id,
    rfq_id: r.rfq_id,
    rfq_no: r.rfq_no,
    title: r.title,
    vendor_name: r.vendor_company || r.vendor_name,
    value: Number(r.quoted_price) || 0,
    submitted_at: r.submitted_at,
  }));
  const total_value = items.reduce((s, r) => s + r.value, 0);
  return { count: items.length, total_value, items };
}

// ── Awarding P1/P2: recent_awards ─────────────────────────────────
async function getRecentAwardsData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { items: [], total_value: 0 };
  }
  // Recently cleared award approvals by this user, joined to any
  // resulting PO so the FE can link out.
  const rows = await db.any(
    `SELECT i.id,
            sa.acted_at AS awarded_at,
            nrq.quoted_price AS value,
            r.id AS rfq_id,
            r.rfq_no,
            r.title,
            u.name AS vendor_name,
            c.company_name AS vendor_company,
            (SELECT po.id FROM tbl_rfq_purchase_order po WHERE po.rfq_id = r.id
              ORDER BY po.created_at DESC LIMIT 1) AS po_id
     FROM tbl_approval_instances i
     JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
     JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
     LEFT JOIN tbl_negotiation_round_quotes nrq ON nrq.id = i.entity_id
     LEFT JOIN tbl_negotiation_rounds nr ON nr.id = nrq.negotiation_round_id
     LEFT JOIN tbl_rfq r ON r.id = nr.rfq_id
     LEFT JOIN tbl_users u ON u.id = nrq.vendor_id
     LEFT JOIN tbl_company c ON c.id = u.company_id
     WHERE sa.approver_user_id = $2
       AND sa.status = 'APPROVED'
       AND sa.acted_at IS NOT NULL
       AND i.entity_type = 'NEGOTIATION_QUOTE'
       AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
       AND i.hotel_id = ANY($3)
       AND sa.acted_at >= NOW() - INTERVAL '30 days'
     ORDER BY sa.acted_at DESC
     LIMIT 10`,
    [buyer_company_id, user_id, hotel_ids]
  );
  const items = rows.map((r) => ({
    id: r.id,
    rfq_id: r.rfq_id,
    rfq_no: r.rfq_no,
    title: r.title,
    vendor_name: r.vendor_company || r.vendor_name,
    value: Number(r.value) || 0,
    awarded_at: r.awarded_at,
    po_id: r.po_id,
  }));
  const total_value = items.reduce((s, r) => s + r.value, 0);
  return { items, total_value };
}

// ── Awarding P1/P2: award_value_pipeline ──────────────────────────
async function getAwardValuePipelineData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return {
      completed_value: 0,
      completed_po_count: 0,
      ongoing_value: 0,
      ongoing_po_count: 0,
    };
  }
  // BU-level rollup of PO ₹ across the user's hotels.
  //   Completed = PO approved or further downstream (vendor accepted /
  //               sent / GRN / completed).
  //   Ongoing   = pending_approval OR acceptance_pending.
  //
  // This one is a value rollup, not a "my" list, so it is deliberately NOT
  // bound to the caller's user id — binding award ₹ to one approver would
  // misreport the pipeline. It is bound to the caller's SCOPE instead, which
  // is what was missing: the department and process axes were unenforced and
  // the figure summed every business unit in the billing account.
  const pipelineParams = [buyer_company_id, hotel_ids];
  const pipelineScope = scopeFilter(user_id, 'r', pipelineParams);
  const row = await db.one(
    `SELECT
        COALESCE(SUM(CASE WHEN po.status IN ('approved','sent','GRN','completed','invoice_raised','dispatched')
                          THEN po.total_value ELSE 0 END), 0) AS completed_value,
        COUNT(*) FILTER (WHERE po.status IN ('approved','sent','GRN','completed','invoice_raised','dispatched'))::int AS completed_po_count,
        COALESCE(SUM(CASE WHEN po.status IN ('pending_approval','acceptance_pending')
                          THEN po.total_value ELSE 0 END), 0) AS ongoing_value,
        COUNT(*) FILTER (WHERE po.status IN ('pending_approval','acceptance_pending'))::int AS ongoing_po_count
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq r ON r.id = po.rfq_id AND ${companyScope()}
     WHERE EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm
                   WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($2))
     ${pipelineScope}`,
    pipelineParams
  );
  return {
    completed_value: Number(row.completed_value) || 0,
    completed_po_count: row.completed_po_count,
    ongoing_value: Number(row.ongoing_value) || 0,
    ongoing_po_count: row.ongoing_po_count,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Status Banner — single BFF aggregator that powers the dashboard hero.
//
//  Collapses six dimensions into one parallel-fetched payload:
//    1. pending_approvals        (user is the next approver, any entity)
//    2. closing_soon             (user's RFQs whose bid window ends in <24h)
//    3. closed_no_quotes         (user's RFQs past bid window with 0 real quotes)
//    4. quote_compare_ready      (user's RFQs sitting in quote-compare gate)
//    5. po_pending_approval      (POs awaiting an internal approval, scoped)
//    6. weekly_published         (user's RFQs published this calendar week)
//    + weekly_savings_pct        (negotiation savings % this week)
//
//  The FE derives mode (clear / steady / action_needed / critical) from the
//  numbers — we do the same here so two clients can't disagree on tone.
// ─────────────────────────────────────────────────────────────────────
async function getBuyerStatusBannerData(buyer_company_id, user_id, hotel_ids = [], start_date, end_date) {
  // When a date range is supplied (the dashboard always sends one), the
  // period-based counts are bounded to it so the banner reflects the selected
  // range (Sr feedback). Forward-looking signals (closing-soon) stay live.
  const hasDates = !!(start_date && end_date);
  const params = [buyer_company_id, user_id, hotel_ids, start_date, end_date];

  // 1. Approvals where I'm the current-step approver, still pending.
  const pendingApprovalsP = db.one(
    `SELECT COUNT(*)::INTEGER AS count
       FROM tbl_approval_instances i
       JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
       JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
      WHERE i.status = 'PENDING'
        AND sa.approver_user_id = $2
        AND sa.status = 'PENDING'
        AND s.step_order = i.current_step
        AND i.hospitality_company_id IN (
          SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1
        )
        AND NOT (
          i.entity_type IN ('RFQ', 'TENDER')
          AND EXISTS (SELECT 1 FROM tbl_rfq r WHERE r.id = i.entity_id AND r.is_published = 1)
        )
        AND i.hotel_id = ANY($3)
        ${hasDates ? 'AND i.created_at BETWEEN $4 AND $5' : ''}`,
    params
  );

  // 2. Closing soon — *my* published RFQs whose bid window ends in <24h
  //    and still has not received any quotes (the most urgent variant).
  //    Also returns the soonest one for the subline copy.
  const closingSoonP = db.oneOrNone(
    `SELECT COUNT(*)::INTEGER AS count,
            MIN(r.bid_end_date::timestamp) AS soonest_bid_end,
            (SELECT json_build_object('id', _r.id, 'title', _r.title, 'rfq_no', _r.rfq_no)
               FROM tbl_rfq _r
              WHERE _r.created_by = $2
                AND _r.is_published = 1
                AND _r.status = 1
                AND _r.bid_end_date IS NOT NULL AND _r.bid_end_date != ''
                AND _r.bid_end_date::timestamp BETWEEN ${IST_NOW} AND ${IST_NOW} + INTERVAL '24 hours'
                AND _r.hospitality_company_id IN (
                  SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1
                )
                AND EXISTS (
                  SELECT 1 FROM tbl_rfq_hotel_mappings _rhm
                   WHERE _rhm.rfq_id = _r.id AND _rhm.hotel_id = ANY($3)
                )
              ORDER BY _r.bid_end_date::timestamp ASC
              LIMIT 1) AS soonest
       FROM tbl_rfq r
      WHERE r.created_by = $2
        AND r.is_published = 1
        AND r.status = 1
        AND r.bid_end_date IS NOT NULL AND r.bid_end_date != ''
        AND r.bid_end_date::timestamp BETWEEN ${IST_NOW} AND ${IST_NOW} + INTERVAL '24 hours'
        AND r.hospitality_company_id IN (
          SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1
        )
        AND EXISTS (
          SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3)
        )`,
    params
  );

  // 3. Bid passed, zero real quotes — *the* signal that vendors aren't biting.
  //    Drives critical mode; surfaced even when only 1 hits.
  //    NOTE: status = 1 (open) only, matching RFQ_STUCK_COMMERCIAL in the list-view
  //    so the banner count and the "Ended · No Quotes" filtered list agree.
  //    The banner is scoped to r.created_by = me whereas the list-view is scoped to
  //    all RFQs visible to the buyer, so the banner count is a subset of the list —
  //    this is intentional (banner = "your" RFQs; list = "all you can see").
  const closedNoQuotesP = db.one(
    `SELECT COUNT(*)::INTEGER AS count
       FROM tbl_rfq r
      WHERE r.created_by = $2
        AND r.is_published = 1
        AND r.status = 1
        AND r.bid_end_date IS NOT NULL AND r.bid_end_date != ''
        AND r.bid_end_date::timestamp < ${IST_NOW}
        ${hasDates
          // $4/$5 stay bare on purpose — see IST_NOW's comment. They are naive
          // `YYYY-MM-DD` strings from the FE's local-time date picker and
          // Postgres types them as `timestamp without time zone`, so this
          // branch is already IST-vs-IST. `AT TIME ZONE` here would shift the
          // user's selected calendar window by 5h30m.
          ? 'AND r.bid_end_date::timestamp BETWEEN $4 AND $5'
          : `AND r.bid_end_date::timestamp > ${IST_NOW} - INTERVAL '14 days'`}
        AND r.hospitality_company_id IN (
          SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1
        )
        AND EXISTS (
          SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3)
        )
        AND NOT EXISTS (
          SELECT 1 FROM tbl_quotes q WHERE q.rfq_id = r.id AND (q.is_regret IS NULL OR q.is_regret != 1)
        )`,
    params
  );

  // 4. My RFQs sitting in quote-compare gate (quotes in, no live negotiation,
  //    no PO yet). Buyer's window to act on vendor selection.
  const quoteCompareReadyP = db.one(
    `SELECT COUNT(*)::INTEGER AS count
       FROM tbl_rfq r
      WHERE r.created_by = $2
        AND r.is_published = 1
        AND r.status = 1
        AND r.hospitality_company_id IN (
          SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1
        )
        AND EXISTS (
          SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3)
        )
        AND EXISTS (
          SELECT 1 FROM tbl_quotes q WHERE q.rfq_id = r.id
            AND (q.is_regret IS NULL OR q.is_regret != 1)
        )
        AND NOT EXISTS (
          SELECT 1 FROM tbl_negotiation_rounds nr
           WHERE nr.rfq_id = r.id AND nr.status NOT IN ('CLOSED', 'COMPLETED', 'EXPIRED')
        )
        AND NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order po WHERE po.rfq_id = r.id)
        ${hasDates ? 'AND r.timestamp BETWEEN $4 AND $5' : ''}`,
    params
  );

  // 5. POs in acceptance_pending — vendor hasn't acknowledged yet. Surfaced
  //    so the buyer knows they may need to nudge.
  const poAcceptancePendingP = db.one(
    `SELECT COUNT(*)::INTEGER AS count
       FROM tbl_rfq_purchase_order po
       JOIN tbl_rfq r ON r.id = po.rfq_id
      WHERE po.status = 'acceptance_pending'
        AND r.created_by = $2
        AND r.hospitality_company_id IN (
          SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1
        )
        AND EXISTS (
          SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3)
        )
        ${hasDates ? 'AND po.created_at BETWEEN $4 AND $5' : ''}`,
    params
  );

  // 6. Weekly wins — RFQs the user published in the last 7 days (used for
  //    appreciation copy). Bounded to 7 calendar days regardless of NOW().
  const weeklyPublishedP = db.one(
    `SELECT COUNT(*)::INTEGER AS count
       FROM tbl_rfq r
      WHERE r.created_by = $2
        AND r.is_published = 1
        ${hasDates ? 'AND r.timestamp BETWEEN $4 AND $5' : "AND r.timestamp >= NOW() - INTERVAL '7 days'"}
        AND r.hospitality_company_id IN (
          SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1
        )
        AND EXISTS (
          SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3)
        )`,
    params
  );

  // 7. Weekly savings — the user's own RFQs whose rounds *started* this week,
  //    priced by the shared ladder (see getNegotiationSavingsData). The ids are
  //    scoped here; the pricing itself carries no scope of its own.
  const weeklySavingsRfqsP = db.any(
    `SELECT DISTINCT nr.rfq_id
       FROM tbl_negotiation_rounds nr
       JOIN tbl_rfq r ON r.id = nr.rfq_id
      WHERE r.hospitality_company_id IN (
        SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1
      )
        AND r.created_by = $2
        ${hasDates ? 'AND nr.created_at BETWEEN $4 AND $5' : "AND nr.created_at >= NOW() - INTERVAL '7 days'"}
        AND EXISTS (
          SELECT 1 FROM tbl_rfq_hotel_mappings rhm
           WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3)
        )`,
    params
  );

  const [
    pendingApprovals,
    closingSoon,
    closedNoQuotes,
    quoteCompareReady,
    poAcceptancePending,
    weeklyPublished,
    weeklySavingsRfqs,
  ] = await Promise.all([
    pendingApprovalsP,
    closingSoonP,
    closedNoQuotesP,
    quoteCompareReadyP,
    poAcceptancePendingP,
    weeklyPublishedP,
    weeklySavingsRfqsP,
  ]);

  const weeklySavings = await priceNegotiations(weeklySavingsRfqs.map((r) => r.rfq_id));
  const baseline = weeklySavings.baseline;
  const negotiated = weeklySavings.achieved;
  const savings_pct = baseline > 0 ? Math.round(((baseline - negotiated) / baseline) * 1000) / 10 : 0;

  // Mode is derived here so server and client agree on tone.
  const counts = {
    pending_approvals: pendingApprovals.count,
    closing_soon: closingSoon?.count || 0,
    closed_no_quotes: closedNoQuotes.count,
    quote_compare_ready: quoteCompareReady.count,
    po_acceptance_pending: poAcceptancePending.count,
  };
  const totalPending =
    counts.pending_approvals +
    counts.closing_soon +
    counts.quote_compare_ready +
    counts.po_acceptance_pending;

  let mode = 'clear';
  if (counts.closed_no_quotes >= 1 || counts.pending_approvals >= 5) {
    mode = 'critical';
  } else if (counts.closing_soon >= 1 || counts.pending_approvals >= 3) {
    mode = 'action_needed';
  } else if (totalPending > 0) {
    mode = 'steady';
  }

  return {
    mode,
    counts,
    soonest_closing: closingSoon?.soonest || null,
    weekly: {
      rfqs_published: weeklyPublished.count,
      savings_pct,
    },
  };
}

export default {
  resolveUserScope,
  getActionCenterData,
  getProcurementSnapshotData,
  getNegotiationSavingsData,
  getCostIntelligenceData,
  getCategoryInsightsData,
  getAbcAnalysisData,
  getWorkflowEfficiencyData,
  getSmartInsightsData,
  getPendingApprovalsDetail,
  getRejectedPOsDetail,
  getNoResponseDetail,

  // Role-aware widgets — RFQ Creator
  getMyDraftsData,
  getMyActiveRfqsData,
  getMyNoResponseRfqsData,
  getMyRfqsBidClosedNoQuotesData,

  // Role-aware widgets — Technical Evaluator
  getMyTechEvalsPendingData,
  getTechEvalsWithDisagreementsData,
  getTechEvalThroughputData,

  // Role-aware widgets — Technical Approver
  getMyTechApprovalsPendingData,
  getTechApprovalOldestPendingData,
  getTechApprovalThroughputData,
  // Shared approval-throughput helper (Commercial Approver reuses)
  approvalThroughput,

  // Role-aware widgets — Commercial Evaluator / N1
  getMyQuoteComparesData,
  getMyActiveNegotiationsData,
  getSavingsPipelineData: getSavingsPipelineData,

  // Role-aware widgets — Commercial Approver
  getMyCommercialApprovalsPendingData,
  getDealsWithPriceAnomaliesData,
  getCommercialApprovalThroughputData,

  // Role-aware widgets — Awarding P1/P2
  getMyAwardApprovalsPendingData,
  getRecentAwardsData,
  getAwardValuePipelineData,

  // Single-call hero banner aggregator (powers /dashboard/buyer-status-banner).
  getBuyerStatusBannerData,
};
