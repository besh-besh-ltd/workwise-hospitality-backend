import db from '../config/dbConn.js';
import {
  scopeTuplesFilter,
  windowSql,
  FRAME,
  bidOpen,
  bidClosed,
  hasBidEnd,
  realQuote,
  pricedItem,
  hasRealQuote,
  liveRoundExists,
  spendStatusSql,
  lineVariant,
  approvalItemKey,
  myPendingApprovalsFrom,
  DISAGREE_SQL,
  LEAF_CATEGORY_JOIN,
  round1,
  round2,
} from './dashboard/dashboardMetrics.js';
import negotiationModel from './negotiationModel.js';
import rfqModel from './rfqModel.js';
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
 * "Now" for bid-window purposes, as a TIMESTAMP.
 *
 * `tbl_rfq.bid_end_date` is `text NOT NULL` holding a NAIVE IST wall-clock
 * string (see app/helper/quoteVisibility.js — QUOTE_VISIBILITY_TIMEZONE). It
 * carries no offset, so comparing it with `NOW()` / `CURRENT_DATE` resolves
 * through the Postgres SESSION timezone — UTC on RDS. Every bid-window test
 * here compares at wall-clock precision against this IST "now" (the old
 * `DATE(bid_end_date) < IST_TODAY` calendar-day twin is gone: day-granular
 * expiry counted RFQs that closed earlier today as still open).
 *
 * Why the IST pin matters: `bid_end_date::timestamp` is
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
 * Deliberately NOT applied to `r.timestamp`, `i.created_at` or
 * `nr.created_at`: those are session-naive columns defaulted from
 * CURRENT_TIMESTAMP, so plain `NOW()` is already frame-consistent for them.
 *
 * The `start_date`/`end_date` range is NOT compared with BETWEEN any more. The
 * old claim here — that a bare 'YYYY-MM-DD' against a session-naive column is
 * "naive-IST vs naive-IST" — was false twice over: those columns hold UTC wall
 * clock on prod, and `BETWEEN … AND '<today>'` stops at 00:00, so everything
 * created today was excluded. Every window now goes through
 * dashboardMetrics.windowSql, which is half-open and knows each column's frame.
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
  // Same predicate as buildScopeExistsClause OR-composed over `permissions`,
  // but with the caller's scope tuples materialised once per query (an
  // InitPlan) instead of a correlated role/permission join per row — see
  // dashboardMetrics.scopeTuplesFilter.
  return scopeTuplesFilter(user_id, alias, params, permissions);
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
/**
 * @param {object|null} knownUser - the already-loaded `req.user` row, when the
 *   caller has one. The auth middleware SELECTs the whole tbl_users row before
 *   any handler runs, so re-reading id/user_type/company_id here was a second
 *   round trip for data already in hand — once per widget, ~30 per dashboard
 *   load. The row is only trusted when its id matches `user_id`; anything else
 *   falls back to the authoritative lookup, so a mismatched hand-off can never
 *   widen scope. Scope stays derived from user_id, never from client input.
 */
async function resolveUserScope(user_id, selectedHotelIds = [], knownUser = null) {
  const canUseKnownUser =
    knownUser &&
    Number(knownUser.id) === Number(user_id) &&
    knownUser.user_type !== undefined &&
    knownUser.company_id !== undefined;

  const userInfo = canUseKnownUser
    ? { id: knownUser.id, user_type: knownUser.user_type, company_id: knownUser.company_id }
    : await db.oneOrNone(
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
// Shared SQL for the cross-role cards
// ─────────────────────────────────────────────────────────────────────

/**
 * The RFQ is visible to this caller: company + hotel mapping + RBAC 4-axis.
 * Assumes $1 = buyer_company_id and $4 = hotel_ids. MUTATES params.
 */
function rfqVisible(user_id, alias, params, permissions = RFQ_SCOPE_PERMISSIONS) {
  return `${companyScope(alias)} ${hotelFilter(alias)} ${scopeFilter(user_id, alias, params, permissions)}`;
}

/**
 * Committed-spend PO lines visible to the caller, in the selected window.
 *
 * D1 — the same population as Reports 1.1: SPEND_STATUSES, IST half-open
 * window on po.created_at (timestamptz), line totals. RFQ-backed POs are
 * scoped through their RFQ (company, hotel mapping, RBAC); ARC call-off POs
 * (rfq_id NULL) through their rate contract, at the hotel that raised the
 * requisition — the same rule poScope.buildScopeClause applies.
 *
 * Assumes $1 = buyer_company_id, $2/$3 = window, $4 = hotel_ids. MUTATES
 * params. Returns the body of a CTE exposing: po_id, rfq_id, created_at,
 * total_price, unit_price, quantity, charges_meta, product_variant_id,
 * rfq_product_id, finalized_vendor_id.
 */
function committedLinesSql(user_id, params, { dated = true } = {}) {
  const status = spendStatusSql(params);
  const rfqScope = scopeFilter(user_id, 'r', params, RFQ_SCOPE_PERMISSIONS);
  const arcScope = scopeFilter(user_id, 'aa', params, RFQ_SCOPE_PERMISSIONS);
  return `
    SELECT po.id AS po_id, po.rfq_id, po.created_at, po.finalized_vendor_id,
           pop.total_price, pop.unit_price, pop.quantity, pop.charges_meta,
           pop.rfq_product_id,
           ${lineVariant('pop', 'rp')} AS product_variant_id
      FROM tbl_rfq_purchase_order po
      JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
      LEFT JOIN tbl_rfq_products rp ON rp.id = pop.rfq_product_id
      LEFT JOIN tbl_rfq r ON r.id = po.rfq_id
     WHERE ${status}
       ${dated ? `AND ${windowSql('po.created_at', FRAME.TZ, 2, 3)}` : ''}
       AND (
         (r.id IS NOT NULL AND ${companyScope('r')} ${hotelFilter('r')} ${rfqScope})
         OR (po.rfq_id IS NULL AND po.is_call_off = TRUE AND EXISTS (
           SELECT 1
             FROM tbl_arc_contract cc
             JOIN tbl_arc arc_row ON arc_row.id = cc.arc_id
             LEFT JOIN tbl_material_requisition mr_row ON mr_row.id = po.source_mr_id
             CROSS JOIN LATERAL (
               SELECT arc_row.hospitality_company_id,
                      COALESCE(mr_row.hotel_id, arc_row.hotel_id) AS hotel_id,
                      arc_row.department_id,
                      arc_row.process_id
             ) aa
            WHERE cc.id = po.arc_contract_id
              AND ${companyScope('aa')}
              AND aa.hotel_id = ANY($4)
              ${arcScope}
         ))
       )`;
}

/**
 * A PO that was rejected (by the vendor, or internally in approval) and for
 * which at least one of its lines has no live replacement PO yet — i.e. it
 * still needs someone to re-award. Returns a WHERE fragment on alias `po`.
 */
const rejectedAwaitingReplacement = (statusSql) => `
  ${statusSql}
  AND EXISTS (
    SELECT 1 FROM tbl_purchase_order_product pop_r
     WHERE pop_r.purchase_order_id = po.id
       AND NOT EXISTS (
         SELECT 1 FROM tbl_rfq_purchase_order po2
           JOIN tbl_purchase_order_product pop2 ON pop2.purchase_order_id = po2.id
          WHERE po2.rfq_id = po.rfq_id
            AND pop2.rfq_product_id = pop_r.rfq_product_id
            AND po2.id <> po.id
            AND po2.status NOT IN ('rejected_by_vendor', 'rejected', 'cancelled')
       )
  )`;

/** Vendor display name — organization_name is dead; company leads. */
const vendorName = (u, c) =>
  `COALESCE(NULLIF(TRIM(${c}.company_name), ''), NULLIF(TRIM(${u}.name), ''), 'Vendor')`;

// ─────────────────────────────────────────────────────────────────────
// 1. Action Center
//
// Every tile is a QUEUE (SPEC rule 2): none of them is windowed by the date
// range. start_date/end_date are accepted for signature compatibility only.
// ─────────────────────────────────────────────────────────────────────
async function getActionCenterData(buyer_company_id, user_id, hotel_ids = []) {
  const params = [buyer_company_id, null, null, hotel_ids];

  // Pending approvals: distinct actionable items (SPEC rule 3). Several
  // approval instances can sit on one decision — prod has an approver with 50
  // PENDING instances across 3 RFQs.
  const pendingApprovalsQuery = db.one(
    `SELECT COUNT(DISTINCT ${approvalItemKey('i')})::int AS items,
            COUNT(DISTINCT i.id)::int AS instances
     ${myPendingApprovalsFrom(2, 1, 3)}`,
    [buyer_company_id, user_id, hotel_ids]
  );

  // "No responses": published, still-open RFQs with no real (non-regret)
  // quote — the same base set the drill-down lists (active + expired).
  const awaitingParams = [...params];
  const rfqsAwaitingQuery = db.one(
    `SELECT COUNT(*)::int AS count FROM tbl_rfq r
     WHERE r.is_published = 1 AND r.status = 1
       AND NOT ${hasRealQuote('r')}
       AND ${rfqVisible(user_id, 'r', awaitingParams)}`,
    awaitingParams
  );

  // Ending soon: bid window still OPEN and closing within 72h (exact IST
  // time). The old DATE() comparison also counted bids that had already
  // closed earlier today.
  const endingSoonParams = [...params];
  const rfqsEndingSoonQuery = db.one(
    `SELECT COUNT(*)::int AS count FROM tbl_rfq r
     WHERE r.is_published = 1 AND r.status = 1
       AND ${hasBidEnd('r')}
       AND r.bid_end_date::timestamp > ${IST_NOW}
       AND r.bid_end_date::timestamp <= ${IST_NOW} + INTERVAL '72 hours'
       AND ${rfqVisible(user_id, 'r', endingSoonParams)}`,
    endingSoonParams
  );

  const posAwaitingParams = [...params];
  const posAwaitingQuery = db.one(
    `SELECT COUNT(*)::int AS count
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq r ON r.id = po.rfq_id
     WHERE po.status = 'acceptance_pending'
       AND ${rfqVisible(user_id, 'r', posAwaitingParams)}`,
    posAwaitingParams
  );

  // Rejected POs still needing a re-award. Counts POs, not product lines.
  const rejectedParams = [...params];
  const rejectedQuery = db.one(
    `SELECT COUNT(*) FILTER (WHERE po.status = 'rejected_by_vendor')::int AS by_vendor,
            COUNT(*) FILTER (WHERE po.status = 'rejected')::int AS in_approval
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq r ON r.id = po.rfq_id
     WHERE ${rejectedAwaitingReplacement(`po.status IN ('rejected_by_vendor', 'rejected')`)}
       AND ${rfqVisible(user_id, 'r', rejectedParams)}`,
    rejectedParams
  );

  const [pa, ra, es, poa, rj] = await Promise.all([
    pendingApprovalsQuery, rfqsAwaitingQuery, rfqsEndingSoonQuery, posAwaitingQuery, rejectedQuery,
  ]);

  return {
    pending_approvals: pa.items,
    pending_approval_instances: pa.instances,
    rfqs_awaiting: ra.count,
    rfqs_ending_soon: es.count,
    pos_awaiting: poa.count,
    rejected_vendors: rj.by_vendor,
    rejected_in_approval: rj.in_approval,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 1b. No-response detail (drill-down behind the "No responses" tile)
//     Same base set as Action Centre `rfqs_awaiting`: published, OPEN, no
//     real quote. Split by the bid window at exact IST time:
//       active  — bid window still open (or no deadline)
//       expired — bid window has passed
//     Undated, like the tile (a queue). A regret is a response but not an
//     offer, so regret-only RFQs stay here and carry regret_count.
// ─────────────────────────────────────────────────────────────────────
async function getNoResponseDetail(buyer_company_id, user_id, hotel_ids = []) {
  const params = [buyer_company_id, null, null, hotel_ids];
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
          ORDER BY rhm0.hotel_id
          LIMIT 1) AS hotel_name,
       (SELECT COUNT(DISTINCT rpv.user_id) FROM tbl_rfq_product_vendors rpv WHERE rpv.rfq_id = r.id AND rpv.routed_from_vendor_id IS NULL)::int AS invited_vendor_count,
       (SELECT COUNT(*) FROM tbl_quotes qr WHERE qr.rfq_id = r.id AND qr.is_regret = 1)::int AS regret_count,
       ${bidClosed('r')} AS is_expired
     FROM tbl_rfq r
     WHERE r.is_published = 1 AND r.status = 1
       AND NOT ${hasRealQuote('r')}
       AND ${rfqVisible(user_id, 'r', params)}
     ORDER BY (CASE WHEN ${hasBidEnd('r')} THEN r.bid_end_date::timestamp END) ASC NULLS LAST, r.id`,
    params
  );

  const shape = (r) => ({
    id: r.id,
    rfq_no: r.rfq_no,
    title: r.title,
    bid_end_date: r.bid_end_date,
    hotel_name: r.hotel_name,
    invited_vendor_count: r.invited_vendor_count,
    regret_count: r.regret_count,
  });

  return {
    active: rows.filter((r) => !r.is_expired).map(shape),
    expired: rows.filter((r) => r.is_expired).map(shape),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 2. Procurement Snapshot
// ─────────────────────────────────────────────────────────────────────
async function getProcurementSnapshotData(buyer_company_id, user_id, hotel_ids = [], start_date = null, end_date = null) {
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  const rfqWin = windowSql('r.timestamp', FRAME.SESSION, 2, 3);

  // RFQ state counts in ONE scan. Current-state counts (open / in progress)
  // are not windowed; created-in-period counts are.
  const rfqParams = [...params];
  const rfqCountsQuery = db.one(
    `SELECT
       COUNT(*) FILTER (WHERE ${rfqWin})::int AS total_rfqs,
       COUNT(*) FILTER (WHERE r.is_published = 1 AND r.status = 1 AND ${bidOpen('r')})::int AS active_rfqs,
       COUNT(*) FILTER (WHERE r.is_published = 1 AND r.status = 1 AND ${bidClosed('r')})::int AS in_progress_rfqs,
       COUNT(*) FILTER (WHERE r.status = 2 AND ${rfqWin})::int AS closed_rfqs,
       COUNT(*) FILTER (WHERE r.is_tender = 1 AND r.is_published = 1 AND r.status = 1)::int AS active_tenders
     FROM tbl_rfq r
     WHERE ${rfqVisible(user_id, 'r', rfqParams)}`,
    rfqParams
  );

  // Committed spend (D1) with its Base / GST / Total breakup (Sr 235). GST is
  // derived per line from charges_meta exactly as the PO-detail roll-up does
  // (the PO header carries no tax total); Base = Total − GST so the three
  // figures always reconcile.
  const spendParams = [...params];
  const spendQuery = db.one(
    `WITH lines AS (${committedLinesSql(user_id, spendParams)})
     SELECT COUNT(DISTINCT po_id)::int AS pos_issued,
            COALESCE(SUM(total_price), 0)::float8 AS total_incl_gst,
            COALESCE(SUM(
              CASE
                WHEN (charges_meta->>'tax') IS NULL OR (charges_meta->>'tax') !~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 0
                WHEN charges_meta->>'tax_mode' = 'absolute' THEN (charges_meta->>'tax')::numeric
                ELSE (unit_price * quantity) * (charges_meta->>'tax')::numeric / 100
              END
            ), 0)::float8 AS total_gst
       FROM lines`,
    spendParams
  );

  // Turnaround: per RFQ, publish → FIRST vendor finalisation, for RFQs first
  // finalised in the window. The old figure averaged per finalisation ROW
  // (2,233 rows over 392 RFQs on prod), weighting multi-product RFQs.
  // tender_publish_date is naive IST; qf.timestamp is session-naive — both are
  // lifted to instants before subtracting.
  const tatParams = [...params];
  const turnaroundQuery = db.one(
    `WITH per_rfq AS (
       SELECT r.id,
              EXTRACT(EPOCH FROM (MIN(qf.timestamp)::timestamptz
                                  - (r.tender_publish_date AT TIME ZONE 'Asia/Kolkata'))) / 86400 AS days,
              MIN(qf.timestamp) AS first_final
         FROM tbl_quote_finalization qf
         JOIN tbl_rfq r ON r.id = qf.rfq_id
        WHERE r.tender_publish_date IS NOT NULL
          AND ${rfqVisible(user_id, 'r', tatParams)}
        GROUP BY r.id, r.tender_publish_date
     )
     SELECT COUNT(*)::int AS n,
            AVG(days)::float8 AS mean,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY days))::float8 AS median,
            (percentile_cont(0.9) WITHIN GROUP (ORDER BY days))::float8 AS p90
       FROM per_rfq
      WHERE days >= 0 AND ${windowSql('first_final', FRAME.SESSION, 2, 3)}`,
    tatParams
  );

  const [rc, sp, tat] = await Promise.all([rfqCountsQuery, spendQuery, turnaroundQuery]);

  const totalInclGst = Number(sp.total_incl_gst) || 0;
  const totalGst = Number(sp.total_gst) || 0;

  return {
    total_rfqs: rc.total_rfqs,
    active_rfqs: rc.active_rfqs,
    in_progress_rfqs: rc.in_progress_rfqs,
    closed_rfqs: rc.closed_rfqs,
    active_tenders: rc.active_tenders,
    pos_issued: sp.pos_issued,
    total_spend: round2(totalInclGst),
    spend_breakup: {
      base_excl_gst: round2(totalInclGst - totalGst),
      total_gst: round2(totalGst),
      total_incl_gst: round2(totalInclGst),
    },
    // Mean per RFQ, kept for compatibility; the card should show the median.
    avg_turnaround: tat.n > 0 ? round1(tat.mean) : 0,
    turnaround_days: {
      median: tat.n > 0 ? round1(tat.median) : null,
      p90: tat.n > 0 ? round1(tat.p90) : null,
      n: tat.n,
    },
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
// maths, so the two surfaces cannot drift apart. See that function for the
// baseline ladder, the unit-vs-line normalisation and why values are signed.
//
// D2: the HEADLINE is the AWARDED (realised) saving — only the vendor whose
// quote was approved. On prod FYTD the all-vendor figure (₹1.81 Cr) overstated
// the realised one (₹1.27 Cr) by counting price cuts from vendors who lost.
// The all-vendor figure is still returned, as `all_vendors`.
//
// ⚠️ SECURITY: getNegotiationParentSavings carries NO scope predicate of its
// own. Every caller below feeds it ONLY rfq ids that already survived a scoped
// query. Never hand it ids from a request body, a facet or a filter.
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

async function getNegotiationSavingsData(buyer_company_id, user_id, hotel_ids = [], start_date = null, end_date = null) {
  const params = [buyer_company_id, start_date, end_date, hotel_ids];

  const scopedRfqs = await db.any(
    `SELECT DISTINCT nr.rfq_id
       FROM tbl_negotiation_rounds nr
       JOIN tbl_rfq r ON r.id = nr.rfq_id
      WHERE ${windowSql('nr.created_at', FRAME.SESSION, 2, 3)}
        AND ${rfqVisible(user_id, 'r', params)}
        -- Sr 240: exclude Terminated/Rejected RFQs. WITHDRAWN (status=5) is the
        -- terminated/rejected-by-us state; also drop RFQs whose only PO was
        -- rejected (no surviving live PO).
        AND r.status <> 5
        AND NOT (
          EXISTS (SELECT 1 FROM tbl_rfq_purchase_order po WHERE po.rfq_id = r.id)
          AND NOT EXISTS (
            SELECT 1 FROM tbl_rfq_purchase_order po2
            WHERE po2.rfq_id = r.id
            AND po2.status NOT IN ('rejected_by_vendor', 'rejected', 'cancelled')
          )
        )`,
    params
  );

  const totals = await priceNegotiations(scopedRfqs.map((r) => r.rfq_id));
  const awarded = {
    total_savings: round2(totals.saved_awarded),
    market_baseline: round2(totals.baseline_awarded),
    negotiated_total: round2(totals.achieved_awarded),
    negotiation_count: totals.pairs_awarded,
  };

  return {
    basis: 'awarded',
    // Headline = realised (awarded) savings. SIGNED: negative means the
    // awarded negotiations in this window ended above their baseline.
    ...awarded,
    savings_pct: totals.baseline_awarded > 0
      ? round1(((totals.baseline_awarded - totals.achieved_awarded) / totals.baseline_awarded) * 100)
      : null,
    rfq_count: totals.parents,
    all_vendors: {
      total_savings: round2(totals.saved),
      market_baseline: round2(totals.baseline),
      negotiated_total: round2(totals.achieved),
      negotiation_count: totals.pairs,
    },
    // Kept for existing consumers; identical to the headline.
    awarded,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 4. Cost Intelligence (Price benchmarking)
//
// Paid-vs-paid. The old card compared the AVERAGE OF ALL VENDORS' QUOTES with
// the MINIMUM PRICE EVER PAID, over rejected POs too, and flagged SMART TV
// (variant 2247) ~38% "above benchmark" when both prices were really paid —
// for a 43" and a 55" set bought under the same catalogue variant.
//
//   benchmark_price — lowest unit price PAID on a committed PO (all time)
//   current_price   — unit price on the most recent committed PO in window
//   price_trend     — priced (non-regret) quote unit prices per period;
//                     periods with no quotes are null, never ₹0
//   spec_variation  — true when this item was bought/quoted under more than
//                     one distinct spec text in scope. Specs are free text on
//                     tbl_rfq_products_specs (the per-RFQ `variant` index is not
//                     a stable spec id), so a like-for-like key cannot be
//                     derived; the card shows the comparison as indicative and
//                     Smart Insights raises no benchmark alarm for it.
// ─────────────────────────────────────────────────────────────────────

/** Spec text signature of an RFQ product line, quantity excluded. */
const specSignatureSql = (rfqIdExpr, variantIdExpr, specVariantExpr) => `(
  SELECT string_agg(lower(regexp_replace(trim(s.title), '\\s+', ' ', 'g')) || '=' ||
                    lower(regexp_replace(trim(s.value), '\\s+', ' ', 'g')), ';'
                    ORDER BY lower(trim(s.title)), lower(trim(s.value)))
    FROM tbl_rfq_products_specs s
   WHERE s.rfq_id = ${rfqIdExpr}
     AND s.product_variant_id = ${variantIdExpr}
     AND s.variant = ${specVariantExpr}
     AND lower(trim(s.title)) <> 'quantity'
)`;

async function getCostIntelligenceData(buyer_company_id, user_id, hotel_ids = [], start_date = null, end_date = null, product_variant_id = null) {
  const params = [buyer_company_id, start_date, end_date, hotel_ids];

  // Item selector: highest committed spend in the window, restricted to items
  // that also have at least one priced quote in the window — otherwise the
  // card opens on an item whose trend is empty (LGSF STEEL, the #2 item on
  // prod, had all its quotes before 1 April).
  const topParams = [...params];
  const topLines = committedLinesSql(user_id, topParams);
  const qScope = scopeFilter(user_id, 'rq', topParams);
  const topProducts = await db.any(
    `WITH lines AS (${topLines}),
     item_value AS (
       SELECT product_variant_id, SUM(total_price) AS value, COUNT(DISTINCT po_id) AS order_count
         FROM lines WHERE product_variant_id IS NOT NULL
        GROUP BY product_variant_id
     ),
     quoted AS (
       SELECT DISTINCT qi.product_variant_id
         FROM tbl_quote_items qi
         JOIN tbl_quotes q ON q.id = qi.quote_id
         JOIN tbl_rfq rq ON rq.id = q.rfq_id
        WHERE ${pricedItem('qi')} AND ${realQuote('q')}
          AND ${windowSql('q.timestamp', FRAME.SESSION, 2, 3)}
          AND ${companyScope('rq')} ${hotelFilter('rq')} ${qScope}
     )
     SELECT iv.product_variant_id, pv.name AS product_name, iv.order_count, iv.value
       FROM item_value iv
       JOIN quoted qd ON qd.product_variant_id = iv.product_variant_id
       JOIN tbl_product_variant pv ON pv.id = iv.product_variant_id
      ORDER BY iv.value DESC NULLS LAST, iv.product_variant_id
      LIMIT 8`,
    topParams
  );

  const empty = {
    top_products: [],
    selected_product_variant_id: null,
    granularity: null,
    benchmark: null,
    price_trend: { labels: [], avg: [], max: [], min: [] },
    vendor_comparison: [],
  };
  if (topProducts.length === 0 && !product_variant_id) return empty;

  const pid = product_variant_id || topProducts[0].product_variant_id;

  // Granularity: month for long ranges, day for short. "All" (no start) is
  // monthly and starts at the first priced quote, not at a hardcoded date.
  const spanDays = start_date && end_date
    ? (new Date(end_date) - new Date(start_date)) / 86400000
    : Infinity;
  const trunc = spanDays > 62 ? 'month' : 'day';

  // The per-item panels bind $5 = the selected variant. The same 4-axis scope
  // applies to every panel, so asking for an out-of-scope item returns empty
  // panels, never another business unit's prices.
  const pidParams = [buyer_company_id, start_date, end_date, hotel_ids, pid];
  const pidSc = scopeFilter(user_id, 'r', pidParams);

  const priceTrendQuery = db.any(
    `WITH prices AS (
       -- Bucket on the IST calendar, not the session's (UTC on prod).
       SELECT DATE_TRUNC('${trunc}', q.timestamp::timestamptz AT TIME ZONE 'Asia/Kolkata') AS period,
              AVG(qi.unit_price) AS avg_price,
              MAX(qi.unit_price) AS max_price,
              MIN(qi.unit_price) AS min_price
         FROM tbl_quote_items qi
         JOIN tbl_quotes q ON q.id = qi.quote_id
         JOIN tbl_rfq r ON r.id = q.rfq_id
        WHERE qi.product_variant_id = $5
          AND ${pricedItem('qi')} AND ${realQuote('q')}
          AND ${windowSql('q.timestamp', FRAME.SESSION, 2, 3)}
          AND ${companyScope('r')} ${hotelFilter('r')} ${pidSc}
        GROUP BY 1
     ),
     bounds AS (
       SELECT COALESCE(DATE_TRUNC('${trunc}', ($2::date)::timestamp), MIN(period)) AS lo,
              -- Never plot the future: an open-ended or far-future end stops today (IST).
              LEAST(COALESCE(DATE_TRUNC('${trunc}', ($3::date)::timestamp), MAX(period)),
                    DATE_TRUNC('${trunc}', ${IST_NOW})) AS hi
         FROM prices
     ),
     series AS (
       SELECT generate_series(b.lo, b.hi, '1 ${trunc}'::interval) AS period
         FROM bounds b WHERE b.lo IS NOT NULL AND b.hi IS NOT NULL
     )
     SELECT s.period, p.avg_price, p.max_price, p.min_price
       FROM series s
       LEFT JOIN prices p ON p.period = s.period
      ORDER BY s.period`,
    pidParams
  );

  // Vendor comparison: average priced (non-regret) unit quote per vendor.
  const vendorParams = [buyer_company_id, start_date, end_date, hotel_ids, pid];
  const vendorSc = scopeFilter(user_id, 'r', vendorParams);
  const vendorComparisonQuery = db.any(
    `SELECT u.id AS vendor_id, u.name AS vendor_name, ${vendorName('u', 'c')} AS company_name,
            AVG(qi.unit_price) AS avg_price, COUNT(*)::int AS quote_count
       FROM tbl_quote_items qi
       JOIN tbl_quotes q ON q.id = qi.quote_id
       JOIN tbl_rfq r ON r.id = q.rfq_id
       JOIN tbl_users u ON u.id = q.created_by
       LEFT JOIN tbl_company c ON c.id = u.company_id
      WHERE qi.product_variant_id = $5
        AND ${pricedItem('qi')} AND ${realQuote('q')}
        AND ${windowSql('q.timestamp', FRAME.SESSION, 2, 3)}
        AND ${companyScope('r')} ${hotelFilter('r')} ${vendorSc}
      GROUP BY u.id, u.name, c.company_name
      ORDER BY avg_price ASC, u.id
      LIMIT 5`,
    vendorParams
  );

  // Benchmark (all-time best PAID) + current (latest PAID in window) + spec
  // variation, all over committed lines for this variant.
  const benchParams = [buyer_company_id, start_date, end_date, hotel_ids];
  const allLines = committedLinesSql(user_id, benchParams, { dated: false });
  benchParams.push(pid);
  const pIdx = benchParams.length;
  const benchmarkQuery = db.one(
    `WITH lines AS (${allLines}),
     item AS (
       SELECT l.*, ${specSignatureSql('l.rfq_id', 'l.product_variant_id', 'rp_s.variant')} AS sig
         FROM lines l
         LEFT JOIN tbl_rfq_products rp_s ON rp_s.id = l.rfq_product_id
        WHERE l.product_variant_id = $${pIdx} AND l.unit_price > 0
     )
     SELECT
       (SELECT MIN(unit_price) FROM item)::float8 AS benchmark_price,
       (SELECT MAX(created_at) FROM item) AS last_purchased_at,
       (SELECT unit_price FROM item
         WHERE ${windowSql('created_at', FRAME.TZ, 2, 3)}
         ORDER BY created_at DESC, po_id DESC LIMIT 1)::float8 AS current_price,
       (SELECT COUNT(DISTINCT COALESCE(sig, '')) FROM item)::int AS spec_signatures`,
    benchParams
  );

  const [priceTrend, vendorComparison, bench] = await Promise.all([
    priceTrendQuery, vendorComparisonQuery, benchmarkQuery,
  ]);

  const bestPrice = vendorComparison.length ? Number(vendorComparison[0].avg_price) : null;
  const benchmarkPrice = bench.benchmark_price != null ? Number(bench.benchmark_price) : null;
  const currentPrice = bench.current_price != null ? Number(bench.current_price) : null;
  const vsBenchmarkPct = benchmarkPrice && currentPrice != null
    ? round1(((currentPrice - benchmarkPrice) / benchmarkPrice) * 100)
    : null;
  const num = (v) => (v == null ? null : round2(Number(v)));

  return {
    top_products: topProducts.map((p) => ({
      product_variant_id: p.product_variant_id,
      product_name: p.product_name,
      order_count: parseInt(p.order_count, 10),
      value: round2(Number(p.value) || 0),
    })),
    selected_product_variant_id: pid,
    granularity: trunc,
    benchmark: {
      product_variant_id: pid,
      benchmark_price: num(benchmarkPrice),
      current_price: num(currentPrice),
      vs_benchmark_pct: vsBenchmarkPct,
      last_purchased_at: bench.last_purchased_at || null,
      spec_variation: bench.spec_signatures > 1,
      basis: 'paid_vs_paid',
    },
    // Gaps are null (not 0) so the chart breaks the line instead of diving to ₹0.
    price_trend: {
      labels: priceTrend.map((pt) => pt.period),
      avg: priceTrend.map((pt) => num(pt.avg_price)),
      max: priceTrend.map((pt) => num(pt.max_price)),
      min: priceTrend.map((pt) => num(pt.min_price)),
    },
    vendor_comparison: vendorComparison.map((vc) => ({
      vendor_id: vc.vendor_id,
      vendor_name: vc.vendor_name,
      company_name: vc.company_name,
      avg_price: round2(Number(vc.avg_price)),
      quote_count: vc.quote_count,
      is_best: Number(vc.avg_price) === bestPrice,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 5. Category Insights (Spend by category)
//    Committed spend (D1), each PO line placed in exactly ONE category via
//    Reports' LEAF_CATEGORY_JOIN. tbl_product_categories maps a product to
//    both its parent and its leaf; the old DISTINCT ON … ORDER BY title picked
//    between them alphabetically and filed 36% of prod spend under a
//    top-level name. `dimension`:
//      category    — the leaf's top-level parent
//      subcategory — the leaf itself
//      item        — the product variant
//    Top 12 buckets; the rest collapse into "Others". rfq_count counts
//    DISTINCT RFQs per bucket (it summed per-variant counts before).
// ─────────────────────────────────────────────────────────────────────
async function getCategoryInsightsData(buyer_company_id, user_id, hotel_ids = [], start_date = null, end_date = null, dimension = 'category') {
  const dim = ['category', 'subcategory', 'item'].includes(dimension) ? dimension : 'category';
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  const lines = committedLinesSql(user_id, params);

  const bucketExpr = {
    category: `COALESCE(parent_cat.title, cat.title, 'Uncategorized')`,
    subcategory: `COALESCE(cat.title, 'Uncategorized')`,
    item: `COALESCE(NULLIF(pv.name, ''), 'Unknown item')`,
  }[dim];

  const rows = await db.any(
    `WITH lines AS (${lines})
     SELECT ${bucketExpr} AS category_name,
            SUM(l.total_price)::float8 AS spend_amount,
            COUNT(DISTINCT l.rfq_id)::int AS rfq_count,
            COUNT(DISTINCT l.po_id)::int AS po_count
       FROM lines l
       LEFT JOIN tbl_product_variant pv ON pv.id = l.product_variant_id
       ${LEAF_CATEGORY_JOIN}
       LEFT JOIN tbl_category parent_cat ON parent_cat.id = NULLIF(cat.parent_id, 0)
      GROUP BY 1
      ORDER BY spend_amount DESC, 1`,
    params
  );

  const totalSpend = rows.reduce((sum, c) => sum + (Number(c.spend_amount) || 0), 0);

  const TOP_N = 12;
  const top = rows.slice(0, TOP_N);
  const rest = rows.slice(TOP_N);
  const buckets = top.map((c) => ({
    category_name: c.category_name,
    spend_amount: round2(Number(c.spend_amount)),
    rfq_count: c.rfq_count,
    po_count: c.po_count,
  }));
  if (rest.length > 0) {
    buckets.push({
      category_name: 'Others',
      spend_amount: round2(rest.reduce((s, c) => s + Number(c.spend_amount), 0)),
      // Distinct across buckets is not additive; "Others" reports bucket count.
      rfq_count: null,
      po_count: null,
      bucket_count: rest.length,
    });
  }

  return {
    dimension: dim,
    total_spend: round2(totalSpend),
    categories: buckets.map((c) => ({
      ...c,
      percentage: totalSpend > 0 ? round1((c.spend_amount / totalSpend) * 100) : 0,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 5b. ABC Analysis (Pareto) — procured items classified by committed spend
//     VALUE (Sr 297/298/303). "By volume" was removed: it summed quantities
//     across mixed units (nos, kg, box), which is not a quantity of anything.
//       A: items making up the first ~70% of value
//       B: the next ~20% (70–90%)
//       C: the bottom ~10% (90–100%)
//     An item is assigned by the cumulative % BEFORE it, so the largest item
//     is always A and the boundary item is included in the higher tier.
// ─────────────────────────────────────────────────────────────────────
async function getAbcAnalysisData(buyer_company_id, user_id, hotel_ids = [], start_date = null, end_date = null) {
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  const lines = committedLinesSql(user_id, params);

  const rows = await db.any(
    `WITH lines AS (${lines})
     SELECT l.product_variant_id,
            COALESCE(NULLIF(pv.name, ''), 'Unknown item') AS name,
            SUM(l.total_price)::float8 AS value
       FROM lines l
       LEFT JOIN tbl_product_variant pv ON pv.id = l.product_variant_id
      GROUP BY l.product_variant_id, pv.name
      ORDER BY value DESC NULLS LAST, l.product_variant_id`,
    params
  );

  const total = rows.reduce((s, r) => s + (Number(r.value) || 0), 0);

  let cumulative = 0;
  const classified = rows.map((r, i) => {
    const prevPct = total > 0 ? (cumulative / total) * 100 : 0;
    cumulative += Number(r.value) || 0;
    let cls = 'C';
    if (prevPct < 70) cls = 'A';
    else if (prevPct < 90) cls = 'B';
    return {
      product_variant_id: r.product_variant_id,
      name: r.name,
      value: round2(Number(r.value) || 0),
      class: cls,
      rank: i + 1,
    };
  });

  const classes = ['A', 'B', 'C'].map((c) => {
    const items = classified.filter((x) => x.class === c);
    const classValue = items.reduce((s, x) => s + x.value, 0);
    return {
      class: c,
      item_count: items.length,
      value: round2(classValue),
      metric_pct: total > 0 ? round1((classValue / total) * 100) : 0,
      item_pct: classified.length > 0 ? round1((items.length / classified.length) * 100) : 0,
    };
  });

  return {
    metric: 'value',
    total_items: classified.length,
    total_value: round2(total),
    classes,
    items: classified.slice(0, 50), // top 50 for display; classification uses all
  };
}

// ─────────────────────────────────────────────────────────────────────
// 6. Workflow Efficiency (Stage turnaround)
//
// For RFQs CREATED in the window (a cohort), how long each stage took. Each
// stage reports n (distinct RFQs), median, P90 and mean hours. Means alone
// were dominated by outliers; n was an instance count (176 "RFQs" in
// commercial approval against 51 RFQs created, for one prod user).
//
//   rfq_approval          RFQ/TENDER approval, created → completed, APPROVED only
//   quote_wait            publish → first real (non-regret) quote
//   tech_evaluation       bid close (exact IST) → last vendor cleared
//   tech_approval         TECHNICAL approval, APPROVED only (RFQ from metadata;
//                         entity_id is the round id, never the RFQ)
//   negotiation           round published/created → closed, ENDED/COMPLETED rounds
//   commercial_evaluation bid close → first vendor finalisation
//   commercial_approval   NEGOTIATION_QUOTE approval, APPROVED only (RFQ via
//                         the rfq_product the instance is keyed on)
//   po_approval           PO approval, APPROVED only (RFQ via the PO)
//   vendor_action         PO raised → vendor accepted/rejected
//
// Cancelled and rejected approvals are excluded — they are not a turnaround,
// and approvals decided within a minute are reported as instant_count rather
// than averaged in.
// Every duration is computed between instants (naive-IST and session-naive
// columns are lifted first) and negative durations are dropped as bad data.
// ─────────────────────────────────────────────────────────────────────
async function getWorkflowEfficiencyData(buyer_company_id, user_id, hotel_ids = [], start_date = null, end_date = null) {
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  const vis = rfqVisible(user_id, 'r', params);
  const bidEndTs = `(CASE WHEN ${hasBidEnd('r')} THEN r.bid_end_date::timestamp AT TIME ZONE 'Asia/Kolkata' END)`;

  const stages = await db.any(
    `WITH scoped_rfqs AS (
       SELECT r.id, r.tender_publish_date, ${bidEndTs} AS bid_end_at
         FROM tbl_rfq r
        WHERE ${windowSql('r.timestamp', FRAME.SESSION, 2, 3)} AND ${vis}
     ),
     durations AS (
       SELECT 'rfq_approval' AS stage, sr.id AS rfq_id,
              EXTRACT(EPOCH FROM (ai.completed_at - ai.created_at)) / 3600 AS hours
         FROM tbl_approval_instances ai
         JOIN scoped_rfqs sr ON sr.id = ai.entity_id
        WHERE ai.entity_type IN ('RFQ', 'TENDER') AND ai.status = 'APPROVED' AND ai.completed_at IS NOT NULL
       UNION ALL
       SELECT 'quote_wait', sr.id,
              EXTRACT(EPOCH FROM (fq.first_quote::timestamptz - (sr.tender_publish_date AT TIME ZONE 'Asia/Kolkata'))) / 3600
         FROM scoped_rfqs sr
         JOIN LATERAL (
           SELECT MIN(q.timestamp) AS first_quote FROM tbl_quotes q
            WHERE q.rfq_id = sr.id AND ${realQuote('q')}
         ) fq ON fq.first_quote IS NOT NULL
        WHERE sr.tender_publish_date IS NOT NULL
       UNION ALL
       SELECT 'tech_evaluation', sr.id,
              EXTRACT(EPOCH FROM (le.evaluated_at::timestamptz - sr.bid_end_at)) / 3600
         FROM scoped_rfqs sr
         JOIN LATERAL (
           SELECT MAX(cv.timestamp) AS evaluated_at
             FROM tbl_rfq_product_tech_evaluation te
             JOIN tbl_rfq_product_tech_evaluation_cleared_vendors cv
               ON cv.tbl_rfq_product_tech_evaluation_id = te.id
            WHERE te.rfq_id = sr.id
         ) le ON le.evaluated_at IS NOT NULL
        WHERE sr.bid_end_at IS NOT NULL
       UNION ALL
       SELECT 'tech_approval', sr.id,
              EXTRACT(EPOCH FROM (ai.completed_at - ai.created_at)) / 3600
         FROM tbl_approval_instances ai
         JOIN scoped_rfqs sr ON sr.id = CASE WHEN (ai.metadata->>'rfq_id') ~ '^[0-9]+$'
                                             THEN (ai.metadata->>'rfq_id')::int END
        WHERE ai.entity_type = 'TECHNICAL' AND ai.status = 'APPROVED' AND ai.completed_at IS NOT NULL
       UNION ALL
       SELECT 'negotiation', sr.id,
              EXTRACT(EPOCH FROM (nr.closed_at - COALESCE(nr.published_at, nr.created_at))) / 3600
         FROM tbl_negotiation_rounds nr
         JOIN scoped_rfqs sr ON sr.id = nr.rfq_id
        WHERE nr.status IN ('ENDED', 'COMPLETED') AND nr.closed_at IS NOT NULL
       UNION ALL
       SELECT 'commercial_evaluation', sr.id,
              EXTRACT(EPOCH FROM (ff.first_final::timestamptz - sr.bid_end_at)) / 3600
         FROM scoped_rfqs sr
         JOIN LATERAL (
           SELECT MIN(qf.timestamp) AS first_final FROM tbl_quote_finalization qf WHERE qf.rfq_id = sr.id
         ) ff ON ff.first_final IS NOT NULL
        WHERE sr.bid_end_at IS NOT NULL
       UNION ALL
       SELECT 'commercial_approval', sr.id,
              EXTRACT(EPOCH FROM (ai.completed_at - ai.created_at)) / 3600
         FROM tbl_approval_instances ai
         JOIN tbl_rfq_products rp_ca ON rp_ca.id = ai.entity_id
         JOIN scoped_rfqs sr ON sr.id = rp_ca.rfq_id
        WHERE ai.entity_type = 'NEGOTIATION_QUOTE' AND ai.status = 'APPROVED' AND ai.completed_at IS NOT NULL
       UNION ALL
       SELECT 'po_approval', sr.id,
              EXTRACT(EPOCH FROM (ai.completed_at - ai.created_at)) / 3600
         FROM tbl_approval_instances ai
         JOIN tbl_rfq_purchase_order po_a ON po_a.id = ai.entity_id
         JOIN scoped_rfqs sr ON sr.id = po_a.rfq_id
        WHERE ai.entity_type = 'PO' AND ai.status = 'APPROVED' AND ai.completed_at IS NOT NULL
       UNION ALL
       SELECT 'vendor_action', sr.id,
              EXTRACT(EPOCH FROM (po.vendor_action_at::timestamptz - po.created_at)) / 3600
         FROM tbl_rfq_purchase_order po
         JOIN scoped_rfqs sr ON sr.id = po.rfq_id
        WHERE po.vendor_action_at IS NOT NULL
     )
     , classified AS (
       -- An approval decided within a minute of being raised was not waited
       -- on (the raiser approving their own step, or an instant sign-off):
       -- 110 of 390 RFQ and 174 of 333 TECHNICAL approvals on prod. Left in,
       -- they pull the stage median to 0h, so they are reported separately.
       SELECT d.*,
              (d.stage IN ('rfq_approval', 'tech_approval', 'commercial_approval', 'po_approval')
               AND d.hours < 1.0 / 60) AS instant
         FROM durations d
        WHERE d.hours IS NOT NULL AND d.hours >= 0
     )
     SELECT stage,
            COUNT(DISTINCT rfq_id) FILTER (WHERE NOT instant)::int AS rfq_count,
            COUNT(*) FILTER (WHERE NOT instant)::int AS samples,
            COUNT(*) FILTER (WHERE instant)::int AS instant_count,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY hours) FILTER (WHERE NOT instant))::float8 AS median_hours,
            (percentile_cont(0.9) WITHIN GROUP (ORDER BY hours) FILTER (WHERE NOT instant))::float8 AS p90_hours,
            (AVG(hours) FILTER (WHERE NOT instant))::float8 AS avg_hours
       FROM classified
      GROUP BY stage
     HAVING COUNT(*) FILTER (WHERE NOT instant) > 0`,
    params
  );

  const ORDER = [
    'rfq_approval', 'quote_wait', 'tech_evaluation', 'tech_approval', 'negotiation',
    'commercial_evaluation', 'commercial_approval', 'po_approval', 'vendor_action',
  ];
  stages.sort((a, b) => ORDER.indexOf(a.stage) - ORDER.indexOf(b.stage));

  return {
    stages: stages.map((s) => ({
      stage_name: s.stage,
      rfq_count: s.rfq_count,
      samples: s.samples,
      instant_count: s.instant_count,
      median_hours: round1(s.median_hours),
      p90_hours: round1(s.p90_hours),
      // Mean, kept for compatibility. Show the median.
      avg_dwell_time_hours: round1(s.avg_hours),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 7. Smart Insights (rule-based)
//
// Emits NO URLs (SPEC "Link contract" §4): each insight carries
//   action: { type, params }
// naming a frontend dashboardLinks builder, which resolves it to a real route.
// Descriptions are plain text; figures go in `details`.
// ─────────────────────────────────────────────────────────────────────
async function getSmartInsightsData(buyer_company_id, user_id, hotel_ids = [], start_date = null, end_date = null) {
  // 1. Benchmark alerts — the latest committed PO price for an item is >10%
  //    above the best price previously paid for it. Items bought under more
  //    than one spec text are skipped (see Cost Intelligence: not comparable).
  const bParams = [buyer_company_id, start_date, end_date, hotel_ids];
  const bLines = committedLinesSql(user_id, bParams, { dated: false });
  const benchmarkDeviationsQuery = db.any(
    `WITH lines AS (${bLines}),
     item AS (
       SELECT l.*, ${specSignatureSql('l.rfq_id', 'l.product_variant_id', 'rp_s.variant')} AS sig
         FROM lines l
         LEFT JOIN tbl_rfq_products rp_s ON rp_s.id = l.rfq_product_id
        WHERE l.product_variant_id IS NOT NULL AND l.unit_price > 0
     ),
     per_item AS (
       SELECT product_variant_id,
              MIN(unit_price) AS best_price,
              COUNT(DISTINCT COALESCE(sig, '')) AS sigs,
              SUM(total_price) FILTER (WHERE ${windowSql('created_at', FRAME.TZ, 2, 3)}) AS period_value,
              (ARRAY_AGG(unit_price ORDER BY created_at DESC, po_id DESC)
                 FILTER (WHERE ${windowSql('created_at', FRAME.TZ, 2, 3)}))[1] AS latest_price,
              (ARRAY_AGG(po_id ORDER BY created_at DESC, po_id DESC)
                 FILTER (WHERE ${windowSql('created_at', FRAME.TZ, 2, 3)}))[1] AS latest_po_id
         FROM item
        GROUP BY product_variant_id
     )
     SELECT pv.name AS product_name, pi.product_variant_id, pi.latest_po_id,
            pi.latest_price::float8, pi.best_price::float8,
            pi.period_value::float8,
            ROUND(((pi.latest_price - pi.best_price) / pi.best_price * 100)::numeric, 1)::float8 AS above_pct
       FROM per_item pi
       JOIN tbl_product_variant pv ON pv.id = pi.product_variant_id
      WHERE pi.sigs = 1 AND pi.best_price > 0 AND pi.latest_price > pi.best_price * 1.1
      ORDER BY pi.period_value DESC NULLS LAST, pi.product_variant_id
      LIMIT 3`,
    bParams
  );

  // 2. Price alerts — items quoted in the window at >15% above the caller's
  //    OWN all-time average quote for them (priced, non-regret quotes only).
  //    Aggregated once per item instead of a per-row LATERAL.
  const pParams = [buyer_company_id, start_date, end_date, hotel_ids];
  const pSc = scopeFilter(user_id, 'r', pParams);
  const priceDeviationsQuery = db.any(
    `WITH q_items AS (
       SELECT qi.product_variant_id, qi.unit_price, q.rfq_id, q.timestamp AS quoted_at, q.id AS quote_id,
              ${windowSql('q.timestamp', FRAME.SESSION, 2, 3)} AS in_window
         FROM tbl_quote_items qi
         JOIN tbl_quotes q ON q.id = qi.quote_id
         JOIN tbl_rfq r ON r.id = q.rfq_id
        WHERE ${pricedItem('qi')} AND ${realQuote('q')}
          AND ${companyScope('r')} ${hotelFilter('r')} ${pSc}
     ),
     agg AS (
       SELECT product_variant_id,
              AVG(unit_price) AS own_avg,
              AVG(unit_price) FILTER (WHERE in_window) AS period_avg,
              COUNT(*) FILTER (WHERE in_window) AS period_n,
              COUNT(*) AS n,
              -- The RFQ carrying the item's most recent in-window quote: what
              -- "Review quotes" opens (a product-name list search only matches
              -- RFQ titles, so it landed on an empty list).
              (ARRAY_AGG(rfq_id ORDER BY quoted_at DESC, quote_id DESC) FILTER (WHERE in_window))[1] AS latest_rfq_id
         FROM q_items GROUP BY product_variant_id
     )
     SELECT pv.name AS product_name, a.product_variant_id, a.latest_rfq_id,
            a.period_avg::float8 AS user_avg_price, a.own_avg::float8 AS market_avg_price,
            ROUND(((a.period_avg - a.own_avg) / a.own_avg * 100)::numeric, 1)::float8 AS deviation_pct
       FROM agg a
       JOIN tbl_product_variant pv ON pv.id = a.product_variant_id
      WHERE a.period_n > 0 AND a.n > a.period_n AND a.own_avg > 0
        AND a.period_avg > a.own_avg * 1.15
      ORDER BY deviation_pct DESC, a.product_variant_id
      LIMIT 3`,
    pParams
  );

  // 3. Vendor with the most best-price lines in the window. Only priced,
  //    non-regret quotes compete — a ₹0 regret line is not a best price (one
  //    prod vendor had 188 "wins", all at ₹0).
  const vParams = [buyer_company_id, start_date, end_date, hotel_ids];
  const vSc = scopeFilter(user_id, 'r', vParams);
  const bestVendorQuery = db.oneOrNone(
    `WITH priced AS (
       SELECT qi.rfq_id, qi.product_variant_id, qi.variant, qi.unit_price, q.created_by AS vendor_id
         FROM tbl_quote_items qi
         JOIN tbl_quotes q ON q.id = qi.quote_id
         JOIN tbl_rfq r ON r.id = q.rfq_id
        WHERE ${pricedItem('qi')} AND ${realQuote('q')}
          AND ${windowSql('q.timestamp', FRAME.SESSION, 2, 3)}
          AND ${companyScope('r')} ${hotelFilter('r')} ${vSc}
     ),
     grp AS (
       SELECT rfq_id, product_variant_id, variant,
              MIN(unit_price) AS best, COUNT(DISTINCT vendor_id) AS vendors
         FROM priced GROUP BY rfq_id, product_variant_id, variant
     ),
     wins AS (
       -- A "win" needs competition: lines quoted by a single vendor don't count.
       SELECT DISTINCT p.vendor_id, p.rfq_id, p.product_variant_id, p.variant
         FROM priced p
         JOIN grp g ON g.rfq_id = p.rfq_id AND g.product_variant_id = p.product_variant_id
                   AND g.variant IS NOT DISTINCT FROM p.variant
        WHERE g.vendors > 1 AND p.unit_price = g.best
     )
     SELECT u.id AS vendor_id, u.name AS vendor_name, ${vendorName('u', 'c')} AS company_name,
            COUNT(*)::int AS best_price_count
       FROM wins w
       JOIN tbl_users u ON u.id = w.vendor_id
       LEFT JOIN tbl_company c ON c.id = u.company_id
      GROUP BY u.id, u.name, c.company_name
      ORDER BY best_price_count DESC, u.id
      LIMIT 1`,
    vParams
  );

  // 4. Committed spend vs the immediately preceding period of equal length.
  //    Only when the window is bounded on both sides.
  let spendTrendQuery = Promise.resolve(null);
  if (start_date && end_date) {
    const days = Math.round((new Date(end_date) - new Date(start_date)) / 86400000) + 1;
    const prevEnd = new Date(new Date(`${start_date}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
    const prevStart = new Date(new Date(`${prevEnd}T00:00:00Z`).getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const curParams = [buyer_company_id, start_date, end_date, hotel_ids];
    const curLines = committedLinesSql(user_id, curParams);
    const prevParams = [buyer_company_id, prevStart, prevEnd, hotel_ids];
    const prevLines = committedLinesSql(user_id, prevParams);
    spendTrendQuery = Promise.all([
      db.one(`WITH lines AS (${curLines}) SELECT COALESCE(SUM(total_price), 0)::float8 AS total FROM lines`, curParams),
      db.one(`WITH lines AS (${prevLines}) SELECT COALESCE(SUM(total_price), 0)::float8 AS total FROM lines`, prevParams),
    ]).then(([c, p]) => ({ current: c.total, previous: p.total }));
  }

  const [benchmarkDeviations, priceDeviations, bestVendor, spendTrend] = await Promise.all([
    benchmarkDeviationsQuery, priceDeviationsQuery, bestVendorQuery, spendTrendQuery,
  ]);

  const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const insights = [];

  benchmarkDeviations.forEach((bd) => {
    insights.push({
      type: 'benchmark_alert',
      severity: bd.above_pct > 25 ? 'high' : 'medium',
      title: `${bd.product_name} above price benchmark`,
      description: `Latest purchase is ${bd.above_pct}% above the best price ever paid for it.`,
      details: [
        { label: 'Best paid (all time)', value: inr(bd.best_price) },
        { label: 'Latest', value: inr(bd.latest_price) },
      ],
      action_label: 'Open latest PO',
      action: { type: 'poDetail', params: { poId: bd.latest_po_id } },
    });
  });

  priceDeviations.forEach((pd) => {
    insights.push({
      type: 'price_alert',
      severity: pd.deviation_pct > 25 ? 'high' : 'medium',
      title: `${pd.product_name} quoted above your usual price`,
      description: `Quotes this period average ${pd.deviation_pct}% above your own history for this item.`,
      details: [
        { label: 'Your usual', value: inr(pd.market_avg_price) },
        { label: 'This period', value: inr(pd.user_avg_price) },
      ],
      action_label: 'Review quotes',
      action: { type: 'quoteCompare', params: { rfqId: pd.latest_rfq_id } },
    });
  });

  if (bestVendor) {
    insights.push({
      type: 'vendor_optimization',
      severity: 'low',
      title: `${bestVendor.company_name} offers best pricing`,
      description: `Lowest price on ${bestVendor.best_price_count} competitive quote line(s) this period. Consider consolidating orders.`,
      details: [],
      action_label: 'View their POs',
      action: { type: 'poList', params: { search: bestVendor.company_name } },
    });
  }

  // A previous period with little committed spend (typically before the client
  // was on the platform) turns into "+700%" headlines that describe adoption,
  // not spending. One rule: compare only when the previous period had spend and
  // the change is at most +300% (current ≤ 4× previous). Decreases are always
  // comparable (they cannot exceed −100%).
  const SPEND_TREND_MAX_INCREASE_PCT = 300;
  const trendPct = spendTrend && spendTrend.previous > 0
    ? ((spendTrend.current - spendTrend.previous) / spendTrend.previous) * 100
    : null;
  if (trendPct !== null && trendPct <= SPEND_TREND_MAX_INCREASE_PCT) {
    const pct = round1(((spendTrend.current - spendTrend.previous) / spendTrend.previous) * 100);
    const dir = pct > 0 ? 'increased' : 'decreased';
    insights.push({
      type: 'spend_trend',
      severity: Math.abs(pct) > 20 ? 'high' : Math.abs(pct) > 10 ? 'medium' : 'low',
      title: `Spend ${dir} by ${Math.abs(pct)}%`,
      description: `Committed spend has ${dir} by ${Math.abs(pct)}% compared with the previous period of the same length.`,
      details: [
        { label: 'This period', value: inr(spendTrend.current) },
        { label: 'Previous', value: inr(spendTrend.previous) },
      ],
      action_label: 'Open spend reports',
      action: { type: 'reports', params: {} },
    });
  }

  return { insights };
}

// ─────────────────────────────────────────────────────────────────────
// 8. Pending Approvals (drill-down behind the Action Centre badge)
//
// ONE ROW PER ACTIONABLE ITEM, from the same predicate as the badge
// (dashboardMetrics.myPendingApprovalsFrom), so the count on the tile always
// equals the rows in the modal. Undated (a queue). `instance_count` says how
// many approval instances collapsed into the row.
//
// Entity ids resolve per SPEC rule 6 — never guessed from entity_id:
//   RFQ/TENDER         entity_id is the RFQ
//   TECHNICAL          RFQ in metadata->>'rfq_id' (entity_id is the round)
//   NEGOTIATION_QUOTE  entity_id is tbl_rfq_products.id → its RFQ
//   NEGOTIATION        entity_id / metadata round_id is the round → its RFQ
//   PO                 entity_id is the PO → its RFQ
//   ARC_*              arc id (amendments hop through their contract)
// ─────────────────────────────────────────────────────────────────────
async function getPendingApprovalsDetail(buyer_company_id, user_id, hotel_ids = []) {
  return db.any(
    `WITH mine AS (
       SELECT i.*, ${approvalItemKey('i')} AS item_key, s.step_order
       ${myPendingApprovalsFrom(2, 1, 3)}
     ),
     resolved AS (
       SELECT m.*,
              CASE
                WHEN m.entity_type IN ('RFQ', 'TENDER') THEN m.entity_id
                WHEN m.entity_type = 'TECHNICAL' AND (m.metadata->>'rfq_id') ~ '^[0-9]+$'
                  THEN (m.metadata->>'rfq_id')::int
                WHEN m.entity_type = 'NEGOTIATION_QUOTE' THEN rp_nq.rfq_id
                WHEN m.entity_type = 'NEGOTIATION' THEN nr_n.rfq_id
                WHEN m.entity_type = 'PO' THEN po_p.rfq_id
                ELSE NULL
              END AS rfq_id,
              CASE WHEN m.entity_type = 'PO' THEN m.entity_id END AS po_id,
              po_p.po_number
         FROM mine m
         LEFT JOIN tbl_rfq_products rp_nq
           ON m.entity_type = 'NEGOTIATION_QUOTE' AND rp_nq.id = m.entity_id
         LEFT JOIN tbl_negotiation_rounds nr_n
           ON m.entity_type = 'NEGOTIATION' AND nr_n.id = COALESCE(
                CASE WHEN (m.metadata->>'round_id') ~ '^[0-9]+$' THEN (m.metadata->>'round_id')::int END,
                m.entity_id)
         LEFT JOIN tbl_rfq_purchase_order po_p
           ON m.entity_type = 'PO' AND po_p.id = m.entity_id
     ),
     items AS (
       SELECT DISTINCT ON (item_key) item_key, id, entity_type, entity_id, metadata, current_step,
              step_order, created_at, hotel_id, approval_policy_id, rfq_id, po_id, po_number,
              COUNT(*) OVER (PARTITION BY item_key)::int AS instance_count
         FROM resolved
        ORDER BY item_key, created_at ASC, id ASC
     )
     SELECT
       it.id AS approval_id,
       it.item_key,
       it.instance_count,
       it.entity_type,
       it.entity_id,
       it.metadata,
       it.current_step,
       it.step_order,
       it.created_at,
       ROUND(EXTRACT(EPOCH FROM (NOW() - it.created_at)) / 3600) AS waiting_hours,
       it.rfq_id,
       it.rfq_id AS rfq_ref_id,
       it.po_id,
       it.po_number,
       r.title AS entity_title,
       r.rfq_no AS entity_rfq_no,
       CASE
         WHEN it.entity_type IN ('ARC_TECH', 'ARC_COMMITTEE', 'ARC_PUBLISH') THEN it.entity_id
         WHEN it.entity_type = 'ARC_AMENDMENT' THEN amdc.arc_id
         ELSE NULL
       END AS arc_id,
       ac.arc_number,
       ac.title AS arc_title,
       hch.name AS hotel_name,
       (SELECT COUNT(*) FROM tbl_approval_policy_steps ps
         WHERE ps.approval_policy_id = it.approval_policy_id)::int AS total_steps
     FROM items it
     LEFT JOIN tbl_rfq r ON r.id = it.rfq_id
     LEFT JOIN tbl_arc_amendment amd ON it.entity_type = 'ARC_AMENDMENT' AND amd.id = it.entity_id
     LEFT JOIN tbl_arc_contract amdc ON amdc.id = amd.arc_contract_id
     LEFT JOIN tbl_arc ac ON
       (it.entity_type IN ('ARC_TECH', 'ARC_COMMITTEE', 'ARC_PUBLISH') AND ac.id = it.entity_id)
       OR (it.entity_type = 'ARC_AMENDMENT' AND ac.id = amdc.arc_id)
     LEFT JOIN tbl_hospitality_company_hotels hch ON hch.id = it.hotel_id
     ORDER BY it.created_at ASC, it.id ASC`,
    [buyer_company_id, user_id, hotel_ids]
  );
}

// ─────────────────────────────────────────────────────────────────────
// 9. Rejected POs (drill-down behind the Action Centre "rejected" tiles)
//    Same predicate as the tiles (rejected, a line still without a live
//    replacement PO), undated like them. One row per PO; the value is summed
//    in a sub-select so a multi-hotel RFQ can never multiply it.
//    rejection_source: 'vendor' (rejected_by_vendor) | 'approval' (rejected).
// ─────────────────────────────────────────────────────────────────────
async function getRejectedPOsDetail(buyer_company_id, user_id, hotel_ids = []) {
  const params = [buyer_company_id, null, null, hotel_ids];
  return db.any(
    `SELECT
       po.id AS po_id,
       po.po_number,
       po.rfq_id,
       po.status,
       CASE WHEN po.status = 'rejected_by_vendor' THEN 'vendor' ELSE 'approval' END AS rejection_source,
       po.created_at,
       COALESCE(po.vendor_action_at::timestamptz, po.updated_at) AS rejected_at,
       po.vendor_rejection_reason AS rejection_reason,
       r.title AS rfq_title,
       r.rfq_no,
       u_vendor.name AS vendor_name,
       ${vendorName('u_vendor', 'c_vendor')} AS vendor_company,
       (SELECT hch.name FROM tbl_rfq_hotel_mappings rhm
          JOIN tbl_hospitality_company_hotels hch ON hch.id = rhm.hotel_id
         WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($4)
         ORDER BY rhm.hotel_id LIMIT 1) AS hotel_name,
       (SELECT STRING_AGG(COALESCE(pv.name, 'Product'), ', ' ORDER BY pop2.id)
          FROM tbl_purchase_order_product pop2
          LEFT JOIN tbl_rfq_products rp ON rp.id = pop2.rfq_product_id
          LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
         WHERE pop2.purchase_order_id = po.id) AS product_names,
       (SELECT COALESCE(SUM(pop3.total_price), 0) FROM tbl_purchase_order_product pop3
         WHERE pop3.purchase_order_id = po.id)::float8 AS po_value
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq r ON r.id = po.rfq_id
     LEFT JOIN tbl_users u_vendor ON u_vendor.id = po.finalized_vendor_id
     LEFT JOIN tbl_company c_vendor ON c_vendor.id = u_vendor.company_id
     WHERE ${rejectedAwaitingReplacement(`po.status IN ('rejected_by_vendor', 'rejected')`)}
       AND ${rfqVisible(user_id, 'r', params)}
     ORDER BY COALESCE(po.vendor_action_at::timestamptz, po.updated_at) DESC NULLS LAST, po.id DESC`,
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

// ═════════════════════════════════════════════════════════════════════
//  Persona widgets — SPEC "Widget catalogue v1" (docs/dashboard_v3/SPEC.md)
//
//  Conventions shared by every function below:
//    · QUEUES are undated (SPEC rule 2): drafts, active RFQs, no-response,
//      closed-without-quotes, evaluations pending, disagreements, quote
//      compares, live negotiations and every "awaiting me" approval list.
//      Only period metrics (savings pipeline, recently approved POs, PO value
//      by stage, approval turnaround) honour start_date / end_date.
//    · Lists return a TRUE `count` (window function before LIMIT) next to a
//      capped `items` list (SPEC rule 4) — the old `count = rows.length`
//      after `LIMIT 50` silently stopped at 50.
//    · Every query is bounded by the buyer account ($1), the effective hotel
//      set, and either `created_by = me`, the caller's RBAC scope tuples, or
//      the caller being a pending approver — never by a client-supplied id.
// ═════════════════════════════════════════════════════════════════════

const PERSONA_LIST_LIMIT = 20;

/**
 * Company bound for the caller's OWN RFQs (created_by = me). Early drafts can
 * carry hospitality_company_id NULL (prod: 4 of user 322/392's 12 drafts), and
 * companyScope() alone hid them from their own creator. Every caller pairs this
 * with created_by = me AND a mapping to one of the caller's allowed hotels, so
 * the tenant stays bounded by the hotel.
 */
const ownRfqCompany = (alias = 'r') => `(${companyScope(alias)} OR ${alias}.hospitality_company_id IS NULL)`;

/**
 * A PO's value as the sum of its line totals — the D1 spend basis
 * (committedLinesSql, Reports 1.1). Joined as one pre-aggregated row per PO,
 * so it never multiplies the rows of the query it sits in, and an INNER join
 * keeps only POs that have lines (the snapshot's `pos_issued` population).
 *
 * Aggregated once rather than as a per-PO scalar subquery:
 * tbl_purchase_order_product has no index on purchase_order_id, so the scalar
 * form sequentially scanned the table once per PO (~100 ms for 515 POs on
 * prod); one grouped scan is ~2 ms.
 */
const poLinesJoin = (po = 'po', alias = 'plt') =>
  `JOIN (SELECT purchase_order_id, COALESCE(SUM(total_price), 0) AS lines_total
           FROM tbl_purchase_order_product
          GROUP BY purchase_order_id) ${alias} ON ${alias}.purchase_order_id = ${po}.id`;

/** The RFQ is mapped to one of the effective hotels ($idx). */
const rfqMapped = (alias, idx) =>
  `EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = ${alias}.id AND rhm.hotel_id = ANY($${idx}))`;

/**
 * A saved draft: the (status = 1, is_published = 0) pair a new RFQ is
 * inserted with. Status 3/4 (awaiting publish approval) is NOT a draft — it
 * is somebody's approval to-do — and 2/5 are closed / withdrawn. Same rule
 * as the RFQ listing's 'drafts' bucket (rfqController.getRfqListView).
 */
const isDraft = (a = 'r') => `(${a}.is_published = 0 AND ${a}.status NOT IN (2, 3, 4, 5))`;

/** A PO line on this RFQ product that is still live (not rejected / cancelled). */
const livePoForProduct = (rfqIdExpr, rfqProductIdExpr) => `EXISTS (
  SELECT 1 FROM tbl_rfq_purchase_order po_l
    JOIN tbl_purchase_order_product pop_l ON pop_l.purchase_order_id = po_l.id
   WHERE po_l.rfq_id = ${rfqIdExpr}
     AND pop_l.rfq_product_id = ${rfqProductIdExpr}
     AND po_l.status NOT IN ('rejected', 'rejected_by_vendor', 'cancelled', 'draft'))`;

/**
 * When the step an approver sits on actually started: step 1 starts with the
 * instance; step n starts when the last earlier step completed. Every step
 * row is inserted with its instance (prod: 11 of 3,868 later steps were
 * created later), so `s.created_at` would measure from submission and
 * inflate the turnaround of every later step (67% of PO approvals happen at
 * step ≥ 2: 52h from creation vs 19h from step start).
 */
const stepStartedAt = (i = 'i', s = 's') => `GREATEST(${i}.created_at, COALESCE((
    SELECT MAX(p_prev.completed_at) FROM tbl_approval_instance_steps p_prev
     WHERE p_prev.approval_instance_id = ${i}.id AND p_prev.step_order < ${s}.step_order
  ), ${i}.created_at))`;

/** Lifecycle keys → labels, identical to the RFQ listing's STATUS_META. */
const LIFECYCLE_LABELS = Object.freeze({
  RFQ_APPROVAL: 'RFQ Approval',
  AWAITING_QUOTES: 'Awaiting Quotes',
  TECHNICAL_AWAITING_QUOTES: 'Awaiting Quotes',
  TECHNICAL_EVALUATING: 'Technical Evaluation',
  TECHNICAL_APPROVING: 'Technical Approval',
  TECHNICAL_REJECTED: 'Technical Rejected',
  RFQ_STUCK_TECHNICAL: 'Stuck · Technical',
  RFQ_STUCK_COMMERCIAL: 'Ended · No Quotes',
  COMMERCIAL_EVALUATION: 'Commercial Evaluation',
  NEGOTIATION_ONGOING: 'Negotiation',
  QUOTATION_APPROVAL: 'Quote Approval',
  AWAITING_PO: 'Awaiting PO',
  PO_APPROVAL: 'PO Approval',
  PO_VENDOR_REJECTED: 'PO Vendor Rejected',
  APPROVED_COMPLETED: 'Completed',
});
const LIFECYCLE_ORDER = Object.keys(LIFECYCLE_LABELS);

/**
 * Lifecycle stage per RFQ — the SAME computation the RFQ listing and detail
 * page use (rfqModel.computeLifecycleStages), with the listing's fallback for
 * RFQs the CASE leaves unclassified. Never re-derived here: the old ad-hoc
 * CASE treated every ENDED negotiation round as live and put 23 RFQs "under
 * negotiation" when one was.
 */
async function lifecycleStagesFor(rows) {
  if (!rows.length) return new Map();
  const map = await rfqModel.computeLifecycleStages(rows.map((r) => Number(r.id)));
  const out = new Map();
  for (const r of rows) {
    const s = Number(r.status);
    const stage = map[Number(r.id)] || (s === 3 || s === 4 ? 'RFQ_APPROVAL' : 'AWAITING_QUOTES');
    out.set(Number(r.id), stage);
  }
  return out;
}

const ageDays = (ts) => {
  if (!ts) return null;
  const ms = Date.now() - new Date(ts).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86400000)) : null;
};

// ── RFQ Creator: my_drafts (queue) ───────────────────────────────────
async function getMyDraftsData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, oldest_created_at: null, items: [] };
  }
  const rows = await db.any(
    `SELECT r.id, r.rfq_no, r.title, r."timestamp" AS created_at,
            (SELECT COUNT(*)::int FROM tbl_rfq_products rp WHERE rp.rfq_id = r.id) AS product_count,
            COUNT(*) OVER ()::int AS total_count,
            MIN(r."timestamp") OVER () AS oldest_created_at
       FROM tbl_rfq r
      WHERE ${ownRfqCompany()}
        AND ${isDraft('r')}
        AND r.created_by = $2
        AND ${rfqMapped('r', 3)}
      ORDER BY r."timestamp" DESC NULLS LAST, r.id DESC
      LIMIT $4`,
    [buyer_company_id, user_id, hotel_ids, PERSONA_LIST_LIMIT]
  );
  return {
    count: rows[0]?.total_count || 0,
    oldest_created_at: rows[0]?.oldest_created_at || null,
    items: rows.map((r) => ({
      id: r.id,
      rfq_no: r.rfq_no,
      title: r.title,
      product_count: r.product_count,
      created_at: r.created_at,
    })),
  };
}

// ── RFQ Creator: my_active_rfqs (queue) ──────────────────────────────
// Every RFQ I created that is past draft and not finished: awaiting publish
// approval, live, or somewhere in evaluation / award. Staged by the shared
// lifecycle computation; completed RFQs (all products on an approved PO) are
// not "active" and are left out.
async function getMyActiveRfqsData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) return { total: 0, stages: [] };
  const rows = await db.any(
    `SELECT r.id, r.status, r."timestamp" AS created_at
       FROM tbl_rfq r
      WHERE ${ownRfqCompany()}
        AND r.created_by = $2
        AND r.status NOT IN (2, 5)
        AND NOT ${isDraft('r')}
        AND ${rfqMapped('r', 3)}`,
    [buyer_company_id, user_id, hotel_ids]
  );
  const stageOf = await lifecycleStagesFor(rows);
  const groups = new Map();
  for (const r of rows) {
    const stage = stageOf.get(Number(r.id));
    if (stage === 'APPROVED_COMPLETED') continue;
    const g = groups.get(stage) || { stage, label: LIFECYCLE_LABELS[stage] || stage, count: 0, oldest: null };
    g.count += 1;
    if (!g.oldest || new Date(r.created_at) < new Date(g.oldest)) g.oldest = r.created_at;
    groups.set(stage, g);
  }
  const stages = [...groups.values()]
    .sort((a, b) => LIFECYCLE_ORDER.indexOf(a.stage) - LIFECYCLE_ORDER.indexOf(b.stage))
    .map((g) => ({ stage: g.stage, label: g.label, count: g.count, oldest_age_days: ageDays(g.oldest) }));
  return { total: stages.reduce((s, g) => s + g.count, 0), stages };
}

// ── RFQ Creator: my_no_response_rfqs (queue) ─────────────────────────
// My live RFQs whose bid window is still open (exact IST time) and where at
// least one invited vendor has not responded at all. A regret IS a response
// — the vendor answered — so it does not make a vendor "silent".
async function getMyNoResponseRfqsData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, silent_vendor_count: 0, items: [] };
  }
  const rows = await db.any(
    `WITH my_live AS (
       SELECT r.id, r.rfq_no, r.title, r.bid_end_date
         FROM tbl_rfq r
        WHERE ${ownRfqCompany()}
          AND r.is_published = 1
          AND r.status = 1
          AND r.created_by = $2
          AND ${bidOpen('r')}
          AND ${rfqMapped('r', 3)}
     ),
     invited AS (
       SELECT DISTINCT rpv.rfq_id, rpv.user_id AS vendor_id
         FROM tbl_rfq_product_vendors rpv
        WHERE rpv.rfq_id IN (SELECT id FROM my_live)
     ),
     per_rfq AS (
       SELECT iv.rfq_id,
              COUNT(*)::int AS total_vendor_count,
              COUNT(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM tbl_quotes q WHERE q.rfq_id = iv.rfq_id AND q.created_by = iv.vendor_id
              ))::int AS silent_vendor_count
         FROM invited iv
        GROUP BY iv.rfq_id
     )
     SELECT ml.id, ml.rfq_no, ml.title, ml.bid_end_date,
            pr.silent_vendor_count, pr.total_vendor_count,
            COUNT(*) OVER ()::int AS total_count,
            SUM(pr.silent_vendor_count) OVER ()::int AS total_silent
       FROM my_live ml
       JOIN per_rfq pr ON pr.rfq_id = ml.id
      WHERE pr.silent_vendor_count > 0
      ORDER BY NULLIF(ml.bid_end_date, '') ASC NULLS LAST, pr.silent_vendor_count DESC, ml.id
      LIMIT $4`,
    [buyer_company_id, user_id, hotel_ids, PERSONA_LIST_LIMIT]
  );
  return {
    count: rows[0]?.total_count || 0,
    silent_vendor_count: rows[0]?.total_silent || 0,
    items: rows.map((r) => ({
      id: r.id,
      rfq_no: r.rfq_no,
      title: r.title,
      bid_end_date: r.bid_end_date,
      silent_vendor_count: r.silent_vendor_count,
      total_vendor_count: r.total_vendor_count,
    })),
  };
}

// ── RFQ Creator: my_rfqs_bid_closed_no_quotes (queue) ────────────────
// My open (status 1) published RFQs whose bid window has passed (exact IST
// time) without a single REAL quote. Regret-only RFQs belong here — nobody
// offered a price. Closed RFQs (status 2) were already dealt with.
async function getMyRfqsBidClosedNoQuotesData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) return { count: 0, items: [] };
  const rows = await db.any(
    `SELECT r.id, r.rfq_no, r.title, r.bid_end_date,
            FLOOR(EXTRACT(EPOCH FROM (${IST_NOW} - r.bid_end_date::timestamp)) / 86400)::int AS days_overdue,
            (SELECT COUNT(DISTINCT q.created_by)::int FROM tbl_quotes q
              WHERE q.rfq_id = r.id AND q.is_regret = 1) AS regret_count,
            COUNT(*) OVER ()::int AS total_count
       FROM tbl_rfq r
      WHERE ${ownRfqCompany()}
        AND r.is_published = 1
        AND r.status = 1
        AND r.created_by = $2
        AND ${bidClosed('r')}
        AND NOT ${hasRealQuote('r')}
        AND ${rfqMapped('r', 3)}
      ORDER BY r.bid_end_date::timestamp ASC, r.id
      LIMIT $4`,
    [buyer_company_id, user_id, hotel_ids, PERSONA_LIST_LIMIT]
  );
  return {
    count: rows[0]?.total_count || 0,
    items: rows.map((r) => ({
      id: r.id,
      rfq_no: r.rfq_no,
      title: r.title,
      bid_end_date: r.bid_end_date,
      days_overdue: r.days_overdue,
      regret_count: r.regret_count,
    })),
  };
}

// ── Tech Evaluator: tech evaluations pending (queue) ─────────────────
// tbl_rfq_product_tech_evaluation has no per-user assignment, so this is the
// SHARED queue inside the caller's RBAC scope (title: "Technical evaluations
// pending", not "My"). Only evaluations someone can act on now:
//   · RFQ published and open (status 1) — not closed, not unpublished;
//   · bid window closed — before that the quotes are sealed;
//   · at least one real quote — otherwise there is nothing to evaluate;
//   · no live PO on the product — it was already awarded;
//   · not already submitted — no PENDING TECHNICAL approval for the product.
// On prod this cut 212 open rows to the ≤78 that are actually actionable.
async function getMyTechEvalsPendingData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, oldest_waiting_since: null, items: [] };
  }
  const params = [buyer_company_id, hotel_ids, PERSONA_LIST_LIMIT];
  const sc = scopeFilter(user_id, 'r', params, TECH_SCOPE_PERMISSIONS);
  const rows = await db.any(
    `SELECT te.id, te.rfq_id, te.tbl_rfq_product_id AS rfq_product_id,
            te."timestamp" AS opened_at,
            r.bid_end_date AS waiting_since,
            r.rfq_no, r.title AS rfq_title,
            pv.name AS product_name,
            COUNT(*) OVER ()::int AS total_count
       FROM tbl_rfq_product_tech_evaluation te
       JOIN tbl_rfq r ON r.id = te.rfq_id AND ${companyScope()}
       JOIN tbl_rfq_products rp ON rp.id = te.tbl_rfq_product_id
       LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
      WHERE te.is_complete = false
        AND r.is_published = 1
        AND r.status = 1
        AND ${bidClosed('r')}
        AND ${hasRealQuote('r')}
        AND NOT ${livePoForProduct('te.rfq_id', 'te.tbl_rfq_product_id')}
        AND NOT EXISTS (
          SELECT 1 FROM tbl_approval_instances ti
           WHERE ti.entity_type = 'TECHNICAL'
             AND ti.status = 'PENDING'
             AND (ti.metadata->>'rfq_product_id') = te.tbl_rfq_product_id::text
        )
        AND ${rfqMapped('r', 2)}
        ${sc}
      ORDER BY r.bid_end_date::timestamp ASC, te.id
      LIMIT $3`,
    params
  );
  return {
    count: rows[0]?.total_count || 0,
    oldest_waiting_since: rows[0]?.waiting_since || null,
    items: rows.map((r) => ({
      id: r.id,
      rfq_id: r.rfq_id,
      rfq_product_id: r.rfq_product_id,
      rfq_no: r.rfq_no,
      rfq_title: r.rfq_title,
      product_name: r.product_name,
      opened_at: r.opened_at,
      waiting_since: r.waiting_since,
    })),
  };
}

// ── Tech Evaluator: vendor disagreements (queue) ─────────────────────
// DISAGREE_SQL (dashboardMetrics) matches prod's stored 'I Dont Agree'; the
// RFQ list's `filters.vendor_disagreement` uses the same predicate.

async function getTechEvalsWithDisagreementsData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, total_disagreement_clauses: 0, items: [] };
  }
  const params = [buyer_company_id, hotel_ids, PERSONA_LIST_LIMIT];
  const sc = scopeFilter(user_id, 'r', params, TECH_SCOPE_PERMISSIONS);
  const rows = await db.any(
    `WITH disagreements AS (
       SELECT te.id AS tech_eval_id, te.rfq_id, te.tbl_rfq_product_id AS rfq_product_id,
              c.id AS clause_id, vr.vendor_id
         FROM tbl_rfq_product_tech_evaluation te
         JOIN tbl_rfq_product_tech_evaluation_clauses c
           ON c.tbl_rfq_product_tech_evaluation_id = te.id
         JOIN tbl_rfq_product_tech_evaluation_vendors_response vr
           ON vr.tbl_rfq_product_tech_evaluation_clauses_id = c.id
         JOIN tbl_rfq r ON r.id = te.rfq_id AND ${companyScope()}
        WHERE te.is_complete = false
          AND r.status = 1
          AND ${DISAGREE_SQL('vr.vendor_response')}
          AND ${rfqMapped('r', 2)}
          ${sc}
     ),
     per_eval AS (
       SELECT tech_eval_id, rfq_id, rfq_product_id,
              COUNT(DISTINCT vendor_id)::int AS disagreeing_vendor_count,
              COUNT(DISTINCT clause_id)::int AS disagreeing_clause_count
         FROM disagreements
        GROUP BY tech_eval_id, rfq_id, rfq_product_id
     )
     SELECT pe.tech_eval_id AS id, pe.rfq_id, pe.rfq_product_id,
            pe.disagreeing_vendor_count, pe.disagreeing_clause_count,
            r.rfq_no, r.title AS rfq_title, pv.name AS product_name,
            COUNT(*) OVER ()::int AS total_count,
            SUM(pe.disagreeing_clause_count) OVER ()::int AS total_clauses
       FROM per_eval pe
       JOIN tbl_rfq r ON r.id = pe.rfq_id
       JOIN tbl_rfq_products rp ON rp.id = pe.rfq_product_id
       LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
      ORDER BY pe.disagreeing_vendor_count DESC, pe.disagreeing_clause_count DESC, pe.tech_eval_id
      LIMIT $3`,
    params
  );
  return {
    count: rows[0]?.total_count || 0,
    total_disagreement_clauses: rows[0]?.total_clauses || 0,
    items: rows.map((r) => ({
      id: r.id,
      rfq_id: r.rfq_id,
      rfq_product_id: r.rfq_product_id,
      rfq_no: r.rfq_no,
      rfq_title: r.rfq_title,
      product_name: r.product_name,
      disagreeing_vendor_count: r.disagreeing_vendor_count,
      disagreeing_clause_count: r.disagreeing_clause_count,
    })),
  };
}

// ── Approvals awaiting me (shared by the four approval widgets) ──────
//
// The SAME predicate (dashboardMetrics.myPendingApprovalsFrom) and the SAME
// item key (approvalItemKey) as the Action Centre badge and its drill-down,
// so each widget's count is exactly its entity types' share of the badge.
// Entity ids resolve per SPEC rule 6 and are never guessed from entity_id:
//   TECHNICAL          RFQ + rfq_product in metadata (entity_id is the round)
//   NEGOTIATION_QUOTE  entity_id is tbl_rfq_products.id; value + vendor from
//                      the po_payload the approval will turn into a PO
//   PO                 entity_id is the PO
//   RFQ / TENDER       entity_id is the RFQ
// Several instances can sit on one item (prod: 50 NEGOTIATION_QUOTE
// instances across 3 RFQs for one approver); values are taken once per
// underlying product / PO (the latest instance), never summed per instance.
async function myPendingApprovalItems(buyer_company_id, user_id, hotel_ids, entityTypes, limit = PERSONA_LIST_LIMIT) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, total_value: 0, oldest_waiting_since: null, items: [] };
  }
  const rows = await db.any(
    `WITH mine AS (
       SELECT i.id, i.entity_type, i.entity_id, i.metadata, i.created_at, i.initiated_by, i.hotel_id,
              ${approvalItemKey('i')} AS item_key,
              ${stepStartedAt('i', 's')} AS step_started_at
       ${myPendingApprovalsFrom(2, 1, 3)}
         AND i.entity_type = ANY($4::text[])
     ),
     resolved AS (
       SELECT m.*,
              CASE
                WHEN m.entity_type IN ('RFQ', 'TENDER') THEN m.entity_id
                WHEN m.entity_type = 'TECHNICAL' AND (m.metadata->>'rfq_id') ~ '^[0-9]+$'
                  THEN (m.metadata->>'rfq_id')::int
                WHEN m.entity_type = 'NEGOTIATION_QUOTE' THEN rp_nq.rfq_id
                WHEN m.entity_type = 'PO' THEN po_p.rfq_id
              END AS rfq_id,
              CASE
                WHEN m.entity_type = 'NEGOTIATION_QUOTE' THEN m.entity_id
                WHEN m.entity_type = 'TECHNICAL' AND (m.metadata->>'rfq_product_id') ~ '^[0-9]+$'
                  THEN (m.metadata->>'rfq_product_id')::int
              END AS rfq_product_id,
              CASE WHEN m.entity_type = 'PO' THEN m.entity_id END AS po_id,
              po_p.po_number,
              CASE
                WHEN m.entity_type = 'PO' THEN po_p.total_value
                WHEN m.entity_type = 'NEGOTIATION_QUOTE'
                     AND (m.metadata #>> '{po_payload,total_value}') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                  THEN (m.metadata #>> '{po_payload,total_value}')::numeric
              END AS value,
              CASE
                WHEN m.entity_type = 'PO' THEN po_p.finalized_vendor_id
                WHEN m.entity_type = 'NEGOTIATION_QUOTE' AND (m.metadata->>'vendor_id') ~ '^[0-9]+$'
                  THEN (m.metadata->>'vendor_id')::int
              END AS vendor_id
         FROM mine m
         LEFT JOIN tbl_rfq_products rp_nq
           ON m.entity_type = 'NEGOTIATION_QUOTE' AND rp_nq.id = m.entity_id
         LEFT JOIN tbl_rfq_purchase_order po_p
           ON m.entity_type = 'PO' AND po_p.id = m.entity_id
     ),
     named AS (
       SELECT rs.*, COALESCE(pv.name, NULLIF(rs.metadata->>'product_name', '')) AS product_name
         FROM resolved rs
         LEFT JOIN tbl_rfq_products rp ON rp.id = rs.rfq_product_id
         LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
     ),
     latest_value AS (
       SELECT DISTINCT ON (item_key, COALESCE(po_id, rfq_product_id, id)) item_key, value
         FROM named
        ORDER BY item_key, COALESCE(po_id, rfq_product_id, id), created_at DESC, id DESC
     ),
     item_value AS (
       SELECT item_key, SUM(value) AS value FROM latest_value GROUP BY item_key
     ),
     items AS (
       SELECT n.item_key,
              MIN(n.entity_type) AS entity_type,
              (ARRAY_AGG(n.id ORDER BY n.created_at, n.id))[1] AS approval_id,
              COUNT(*)::int AS instance_count,
              MIN(n.rfq_id) AS rfq_id,
              MIN(n.po_id) AS po_id,
              MIN(n.po_number) AS po_number,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT n.rfq_product_id), NULL) AS rfq_product_ids,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT n.product_name), NULL) AS product_names,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT n.vendor_id), NULL) AS vendor_ids,
              MIN(n.created_at) AS submitted_at,
              MIN(n.step_started_at) AS waiting_since,
              (ARRAY_AGG(n.initiated_by ORDER BY n.created_at, n.id))[1] AS initiated_by,
              (ARRAY_AGG(n.hotel_id ORDER BY n.created_at, n.id))[1] AS hotel_id
         FROM named n
        GROUP BY n.item_key
     )
     SELECT it.*, iv.value,
            r.rfq_no, r.title AS rfq_title,
            ub.name AS submitted_by_name,
            hch.name AS hotel_name,
            (SELECT ARRAY_AGG(DISTINCT ${vendorName('vu', 'vc')})
               FROM tbl_users vu LEFT JOIN tbl_company vc ON vc.id = vu.company_id
              WHERE vu.id = ANY(it.vendor_ids)) AS vendor_names,
            COUNT(*) OVER ()::int AS total_count,
            SUM(iv.value) OVER () AS total_value,
            MIN(it.waiting_since) OVER () AS oldest_waiting_since
       FROM items it
       LEFT JOIN item_value iv ON iv.item_key = it.item_key
       LEFT JOIN tbl_rfq r ON r.id = it.rfq_id
       LEFT JOIN tbl_users ub ON ub.id = it.initiated_by
       LEFT JOIN tbl_hospitality_company_hotels hch ON hch.id = it.hotel_id
      ORDER BY it.waiting_since ASC, it.approval_id ASC
      LIMIT $5`,
    [buyer_company_id, user_id, hotel_ids, entityTypes, limit]
  );
  return {
    count: rows[0]?.total_count || 0,
    total_value: rows[0]?.total_value != null ? round2(rows[0].total_value) : 0,
    oldest_waiting_since: rows[0]?.oldest_waiting_since || null,
    items: rows.map((r) => ({
      approval_id: r.approval_id,
      item_key: r.item_key,
      entity_type: r.entity_type,
      instance_count: r.instance_count,
      rfq_id: r.rfq_id,
      rfq_no: r.rfq_no,
      rfq_title: r.rfq_title,
      rfq_product_ids: r.rfq_product_ids || [],
      product_names: r.product_names || [],
      po_id: r.po_id,
      po_number: r.po_number,
      vendor_names: r.vendor_names || [],
      value: r.value != null ? round2(r.value) : null,
      submitted_at: r.submitted_at,
      waiting_since: r.waiting_since,
      age_days: ageDays(r.waiting_since),
      submitted_by_name: r.submitted_by_name,
      hotel_name: r.hotel_name,
    })),
  };
}

const approvalQueueShape = ({ count, total_value, oldest_waiting_since, items }, withValue) => ({
  count,
  ...(withValue ? { total_value } : {}),
  oldest_waiting_since,
  oldest_age_days: ageDays(oldest_waiting_since),
  items,
});

// ── Tech Approver: technical approvals awaiting me (absorbs the old
//    "oldest pending" card: items are oldest-first) ───────────────────
async function getMyTechApprovalsPendingData(buyer_company_id, user_id, hotel_ids) {
  return approvalQueueShape(
    await myPendingApprovalItems(buyer_company_id, user_id, hotel_ids, ['TECHNICAL']), false);
}

// ── RFQ approver: RFQs awaiting my (publish) approval ────────────────
async function getMyRfqApprovalsPendingData(buyer_company_id, user_id, hotel_ids) {
  return approvalQueueShape(
    await myPendingApprovalItems(buyer_company_id, user_id, hotel_ids, ['RFQ', 'TENDER']), false);
}

// ── Commercial Approver: negotiated quotes awaiting me ───────────────
// NEGOTIATION_QUOTE is the quote-approval step (N1 / Commercial Approver on
// prod), not PO approval — the old widget pair had the two swapped.
async function getMyCommercialApprovalsPendingData(buyer_company_id, user_id, hotel_ids) {
  return approvalQueueShape(
    await myPendingApprovalItems(buyer_company_id, user_id, hotel_ids, ['NEGOTIATION_QUOTE']), true);
}

// ── Awarding: POs awaiting my approval ───────────────────────────────
async function getMyAwardApprovalsPendingData(buyer_company_id, user_id, hotel_ids) {
  return approvalQueueShape(
    await myPendingApprovalItems(buyer_company_id, user_id, hotel_ids, ['PO']), true);
}

// ── Commercial Evaluator: ready for quote comparison (queue) ─────────
// The RFQs the lifecycle computation puts in COMMERCIAL_EVALUATION — the same
// stage the RFQ listing's "Commercial Evaluation" facet and "View all" link
// filter on. Bid closed, real quotes in, no live round, nothing awarded yet.
// Shared queue inside the caller's commercial RBAC scope (no assignment).
// Tenders are left out: they are compared in ARC, and the RFQ list this
// widget's "View all" opens excludes them (rfqController passes is_tender = 0),
// so counting them made the card disagree with its own list.
async function getMyQuoteComparesData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) return { count: 0, items: [] };
  const params = [buyer_company_id, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params, COMMERCIAL_SCOPE_PERMISSIONS);
  const candidates = await db.any(
    `SELECT r.id, r.status, r.rfq_no, r.title, r.bid_end_date,
            (SELECT COUNT(DISTINCT q.created_by)::int FROM tbl_quotes q
              WHERE q.rfq_id = r.id AND ${realQuote('q')}) AS vendor_count
       FROM tbl_rfq r
      WHERE ${companyScope()}
        AND r.is_published = 1
        AND r.status = 1
        AND COALESCE(r.is_tender, 0) = 0
        AND ${bidClosed('r')}
        AND ${hasRealQuote('r')}
        AND ${rfqMapped('r', 2)}
        ${sc}`,
    params
  );
  const stageOf = await lifecycleStagesFor(candidates);
  const ready = candidates
    .filter((r) => stageOf.get(Number(r.id)) === 'COMMERCIAL_EVALUATION')
    .sort((a, b) => String(a.bid_end_date).localeCompare(String(b.bid_end_date)) || a.id - b.id);
  return {
    count: ready.length,
    items: ready.slice(0, PERSONA_LIST_LIMIT).map((r) => ({
      id: r.id,
      rfq_no: r.rfq_no,
      title: r.title,
      vendor_count: r.vendor_count,
      bid_closed_at: r.bid_end_date,
    })),
  };
}

// ── Commercial Evaluator: my live negotiation rounds (queue) ─────────
// Rounds I created that are still in flight: ACTIVE with the vendor window
// open, or PENDING_APPROVAL (waiting to go out — shown with its status so it
// is not mistaken for a round vendors can see). end_date is naive UTC.
async function getMyActiveNegotiationsData(buyer_company_id, user_id, hotel_ids) {
  if (!hotel_ids || hotel_ids.length === 0) {
    return { count: 0, awaiting_approval_count: 0, total_silent_vendors: 0, items: [] };
  }
  const rows = await db.any(
    `WITH my_rounds AS (
       SELECT nr.id, nr.rfq_id, nr.round_number, nr.end_date, nr.vendor_ids, nr.status,
              r.rfq_no, r.title AS rfq_title
         FROM tbl_negotiation_rounds nr
         JOIN tbl_rfq r ON r.id = nr.rfq_id AND ${companyScope()}
        WHERE nr.created_by = $2
          AND (
            (nr.status = 'ACTIVE' AND nr.end_date IS NOT NULL AND nr.end_date > (now() AT TIME ZONE 'UTC'))
            OR nr.status = 'PENDING_APPROVAL'
          )
          AND ${rfqMapped('r', 3)}
     ),
     responded AS (
       SELECT mr.id AS round_id, COUNT(DISTINCT nrq.vendor_id)::int AS responded_count
         FROM my_rounds mr
         LEFT JOIN tbl_negotiation_round_quotes nrq ON nrq.negotiation_round_id = mr.id
        GROUP BY mr.id
     ),
     shaped AS (
       SELECT mr.*, COALESCE(array_length(mr.vendor_ids, 1), 0)::int AS invited_count,
              COALESCE(rs.responded_count, 0) AS responded_count
         FROM my_rounds mr LEFT JOIN responded rs ON rs.round_id = mr.id
     )
     SELECT s.*,
            GREATEST(s.invited_count - s.responded_count, 0)::int AS silent_vendor_count,
            COUNT(*) OVER ()::int AS total_count,
            COUNT(*) FILTER (WHERE s.status = 'PENDING_APPROVAL') OVER ()::int AS awaiting_count,
            SUM(CASE WHEN s.status = 'ACTIVE' THEN GREATEST(s.invited_count - s.responded_count, 0) ELSE 0 END)
              OVER ()::int AS total_silent
       FROM shaped s
      ORDER BY (s.status = 'ACTIVE') DESC, s.end_date ASC NULLS LAST, s.id
      LIMIT $4`,
    [buyer_company_id, user_id, hotel_ids, PERSONA_LIST_LIMIT]
  );
  return {
    count: rows[0]?.total_count || 0,
    awaiting_approval_count: rows[0]?.awaiting_count || 0,
    total_silent_vendors: rows[0]?.total_silent || 0,
    items: rows.map((r) => ({
      id: r.id,
      rfq_id: r.rfq_id,
      rfq_no: r.rfq_no,
      rfq_title: r.rfq_title,
      round_number: r.round_number,
      round_status: r.status,
      round_end_date: r.end_date,
      invited_vendor_count: r.invited_count,
      silent_vendor_count: r.status === 'ACTIVE' ? Math.max(r.invited_count - r.responded_count, 0) : null,
    })),
  };
}

// ── Commercial Evaluator: savings pipeline (period) ──────────────────
/** Shift a YYYY-MM-DD by n days (UTC arithmetic on a calendar date). */
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const istToday = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

/**
 * The window the header selected, and the equally long window right before
 * it. "All" (no start_date) has no prior window.
 */
function currentAndPriorWindow(start_date, end_date) {
  const end = end_date || istToday();
  if (!start_date) return { current: { start_date: null, end_date: end }, prior: null };
  const days = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start_date}T00:00:00Z`)) / 86400000) + 1;
  return {
    current: { start_date, end_date: end },
    prior: { start_date: addDays(start_date, -days), end_date: addDays(start_date, -1) },
  };
}

// Negotiations I led — the RFQ's EARLIEST non-cancelled round is mine — that
// have CONCLUDED (no live round left) inside the window. Concluded-at is the
// last non-cancelled round's close (end_date when closed_at was never
// stamped), so a multi-round negotiation lands in the period it finished in,
// not the one its first round closed in. Priced by the shared ladder on the
// awarded basis (D2), with the all-vendor figure alongside.
async function getSavingsPipelineData(buyer_company_id, user_id, hotel_ids, start_date = null, end_date = null) {
  const { current, prior } = currentAndPriorWindow(start_date, end_date);
  const empty = {
    basis: 'awarded', total_savings: 0, prior_period_savings: null, negotiation_count: 0,
    avg_savings_pct: null, all_vendors_savings: 0, window: current, prior_window: prior,
  };
  if (!hotel_ids || hotel_ids.length === 0) return empty;

  const concludedRfqs = async (win) => {
    const rows = await db.any(
      `SELECT r.id AS rfq_id
         FROM tbl_rfq r
         JOIN LATERAL (
           SELECT nr.created_by FROM tbl_negotiation_rounds nr
            WHERE nr.rfq_id = r.id AND nr.status <> 'CANCELLED'
            ORDER BY nr.created_at, nr.id LIMIT 1
         ) first_round ON TRUE
         JOIN LATERAL (
           SELECT MAX(COALESCE(nr.closed_at, nr.end_date)) AS concluded_at
             FROM tbl_negotiation_rounds nr
            WHERE nr.rfq_id = r.id AND nr.status <> 'CANCELLED'
         ) done ON TRUE
        WHERE ${companyScope()}
          AND first_round.created_by = $2
          AND NOT ${liveRoundExists('r')}
          AND done.concluded_at IS NOT NULL
          AND ${windowSql('done.concluded_at', FRAME.SESSION, 4, 5)}
          AND ${rfqMapped('r', 3)}`,
      [buyer_company_id, user_id, hotel_ids, win.start_date, win.end_date]
    );
    return priceNegotiations(rows.map((r) => r.rfq_id));
  };

  const cur = await concludedRfqs(current);
  const pri = prior ? await concludedRfqs(prior) : null;
  return {
    basis: 'awarded',
    total_savings: round2(cur.saved_awarded),
    prior_period_savings: pri ? round2(pri.saved_awarded) : null,
    negotiation_count: cur.parents,
    avg_savings_pct: cur.baseline_awarded > 0
      ? round1((cur.saved_awarded / cur.baseline_awarded) * 100)
      : null,
    all_vendors_savings: round2(cur.saved),
    window: current,
    prior_window: prior,
  };
}

// ── Approvers: approval turnaround (period) ──────────────────────────
// Replaces the three "throughput" cards. For each kind of decision, how long
// did it take once it was actually in front of the caller:
//   tech_eval       my technical evaluations: bid close → my submission
//                   (the TECHNICAL approval instance I initiated; first
//                   submission per product)
//   tech_approval / quote_approval / po_approval / rfq_approval
//                   my decisions: the step reaching me (stepStartedAt) → my
//                   APPROVED/REJECTED action
// Median + P90 + n (means are dominated by a few stale items); decisions
// within a minute are reported as `instant_count` (auto-approvals / same
// person on consecutive steps). Window = decision time, IST calendar days.
const TURNAROUND_TABS = Object.freeze([
  { key: 'tech_eval', label: 'Technical evaluation' },
  { key: 'tech_approval', label: 'Technical approval' },
  { key: 'quote_approval', label: 'Quote approval' },
  { key: 'po_approval', label: 'PO approval' },
  { key: 'rfq_approval', label: 'RFQ approval' },
]);

async function getApprovalTurnaroundData(buyer_company_id, user_id, hotel_ids, start_date = null, end_date = null) {
  const tabs = new Map(TURNAROUND_TABS.map((t) => [t.key, {
    ...t, n: 0, median_hours: null, p90_hours: null, instant_count: 0,
  }]));
  const shape = () => ({ window: { start_date, end_date }, tabs: [...tabs.values()] });
  if (!hotel_ids || hotel_ids.length === 0) return shape();

  const rows = await db.any(
    `WITH decisions AS (
       SELECT CASE i.entity_type
                WHEN 'TECHNICAL' THEN 'tech_approval'
                WHEN 'NEGOTIATION_QUOTE' THEN 'quote_approval'
                WHEN 'PO' THEN 'po_approval'
                ELSE 'rfq_approval'
              END AS tab,
              GREATEST(EXTRACT(EPOCH FROM (sa.acted_at - ${stepStartedAt('i', 's')})) / 3600.0, 0) AS hours
         FROM tbl_approval_step_approvers sa
         JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
         JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
        WHERE sa.approver_user_id = $2
          AND sa.status IN ('APPROVED', 'REJECTED')
          AND sa.acted_at IS NOT NULL
          AND sa.removed_at IS NULL
          AND i.entity_type IN ('TECHNICAL', 'NEGOTIATION_QUOTE', 'PO', 'RFQ', 'TENDER')
          AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
          AND (i.hotel_id IS NULL OR i.hotel_id = ANY($3))
          AND ${windowSql('sa.acted_at', FRAME.SESSION, 4, 5)}
     ),
     evaluations AS (
       SELECT DISTINCT ON (i.metadata->>'rfq_product_id')
              'tech_eval' AS tab,
              GREATEST(EXTRACT(EPOCH FROM (
                i.created_at - (r.bid_end_date::timestamp AT TIME ZONE 'Asia/Kolkata')::timestamp
              )) / 3600.0, 0) AS hours
         FROM tbl_approval_instances i
         JOIN tbl_rfq r ON (i.metadata->>'rfq_id') ~ '^[0-9]+$' AND r.id = (i.metadata->>'rfq_id')::int
        WHERE i.entity_type = 'TECHNICAL'
          AND i.initiated_by = $2
          AND ${hasBidEnd('r')}
          AND i.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
          AND ${rfqMapped('r', 3)}
          AND ${windowSql('i.created_at', FRAME.SESSION, 4, 5)}
        ORDER BY i.metadata->>'rfq_product_id', i.created_at, i.id
     ),
     unioned AS (
       SELECT tab, hours FROM decisions
       UNION ALL
       SELECT tab, hours FROM evaluations
     )
     SELECT tab,
            COUNT(*)::int AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY hours) AS median_hours,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY hours) AS p90_hours,
            COUNT(*) FILTER (WHERE hours < 1.0 / 60)::int AS instant_count
       FROM unioned
      GROUP BY tab`,
    [buyer_company_id, user_id, hotel_ids, start_date, end_date]
  );
  for (const r of rows) {
    const t = tabs.get(r.tab);
    if (!t) continue;
    t.n = r.n;
    t.median_hours = round1(r.median_hours);
    t.p90_hours = round1(r.p90_hours);
    t.instant_count = r.instant_count;
  }
  return shape();
}

// ── Awarding: recently approved POs (period) ─────────────────────────
// Committed POs (D1: SPEND_STATUSES, with lines — the snapshot's population)
// in the caller's scope whose internal approval completed inside the window
// (last 30 days when no range is selected), newest first. A PO approved
// internally but still awaiting vendor acceptance, or later rejected by the
// vendor, is not committed spend and is not listed. The population is a
// subset of committed spend: a PO committed without an approval instance has
// no approval date and never appears. The award is the PO — NEGOTIATION_QUOTE
// ids are rfq_product ids, which is why the old version, joining them to
// round quotes, showed other RFQs' numbers.
async function getRecentAwardsData(buyer_company_id, user_id, hotel_ids, start_date = null, end_date = null) {
  const win = start_date || end_date
    ? { start_date, end_date }
    : { start_date: addDays(istToday(), -29), end_date: istToday() };
  if (!hotel_ids || hotel_ids.length === 0) return { count: 0, total_value: 0, window: win, items: [] };
  const params = [buyer_company_id, win.start_date, win.end_date, hotel_ids, user_id, PERSONA_LIST_LIMIT];
  const committed = spendStatusSql(params, 'po');
  const sc = scopeFilter(user_id, 'r', params, RFQ_SCOPE_PERMISSIONS);
  const rows = await db.any(
    `WITH approved AS (
       SELECT DISTINCT ON (po.id)
              po.id AS po_id, po.po_number, plt.lines_total AS total_value, po.status, po.rfq_id,
              po.finalized_vendor_id, i.id AS instance_id, i.completed_at AS approved_at
         FROM tbl_rfq_purchase_order po
         ${poLinesJoin('po')}
         JOIN tbl_approval_instances i
           ON i.entity_type = 'PO' AND i.entity_id = po.id AND i.status = 'APPROVED'
         JOIN tbl_rfq r ON r.id = po.rfq_id
        WHERE ${companyScope()}
          AND ${rfqMapped('r', 4)}
          AND ${committed}
          AND i.completed_at IS NOT NULL
          AND ${windowSql('i.completed_at', FRAME.SESSION, 2, 3)}
          ${sc}
        ORDER BY po.id, i.completed_at DESC
     )
     SELECT a.*, r.rfq_no, r.title AS rfq_title,
            ${vendorName('vu', 'vc')} AS vendor_name,
            EXISTS (
              SELECT 1 FROM tbl_approval_instance_steps s2
                JOIN tbl_approval_step_approvers sa2 ON sa2.approval_instance_step_id = s2.id
               WHERE s2.approval_instance_id = a.instance_id
                 AND sa2.approver_user_id = $5 AND sa2.status = 'APPROVED'
            ) AS approved_by_me,
            COUNT(*) OVER ()::int AS total_count,
            SUM(a.total_value) OVER () AS total_value_all
       FROM approved a
       JOIN tbl_rfq r ON r.id = a.rfq_id
       LEFT JOIN tbl_users vu ON vu.id = a.finalized_vendor_id
       LEFT JOIN tbl_company vc ON vc.id = vu.company_id
      ORDER BY a.approved_at DESC, a.po_id DESC
      LIMIT $6`,
    params
  );
  return {
    count: rows[0]?.total_count || 0,
    total_value: rows[0] ? round2(rows[0].total_value_all) : 0,
    window: win,
    items: rows.map((r) => ({
      po_id: r.po_id,
      po_number: r.po_number,
      rfq_id: r.rfq_id,
      rfq_no: r.rfq_no,
      rfq_title: r.rfq_title,
      vendor_name: r.vendor_name,
      value: round2(r.total_value),
      status: r.status,
      approved_at: r.approved_at,
      approved_by_me: r.approved_by_me,
    })),
  };
}

// ── Awarding: PO value by stage (period) ─────────────────────────────
// Every PO in the caller's scope raised inside the window, bucketed by where
// it stands. Valued at the sum of its line totals — the figure Reports 1.1 and
// the snapshot's spend sum (committedLinesSql); the header total_value can
// carry charges the lines don't, which made the committed buckets disagree
// with spend by ₹21.5 L on prod. Drafts and
// cancelled POs never happened and are left out; rejected POs are shown so
// the rejection rate is visible, but are not part of `committed_value`.
const PO_STAGE_BUCKETS = Object.freeze([
  { key: 'in_approval', label: 'In approval', statuses: ['pending_approval'] },
  { key: 'awaiting_acceptance', label: 'Awaiting vendor acceptance', statuses: ['acceptance_pending'] },
  { key: 'approved', label: 'Approved', statuses: ['approved'] },
  { key: 'in_fulfilment', label: 'In fulfilment', statuses: ['sent', 'dispatched', 'GRN', 'invoice_raised'] },
  { key: 'completed', label: 'Completed', statuses: ['completed'] },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected', 'rejected_by_vendor'] },
]);

async function getAwardValuePipelineData(buyer_company_id, user_id, hotel_ids, start_date = null, end_date = null) {
  const stages = PO_STAGE_BUCKETS.map(({ key, label }) => ({ key, label, value: 0, po_count: 0 }));
  const empty = { committed_value: 0, committed_po_count: 0, pending_value: 0, pending_po_count: 0, stages };
  if (!hotel_ids || hotel_ids.length === 0) return empty;
  const params = [buyer_company_id, start_date, end_date, hotel_ids];
  const sc = scopeFilter(user_id, 'r', params, RFQ_SCOPE_PERMISSIONS);
  const rows = await db.any(
    `SELECT po.status::text AS status,
            COUNT(*)::int AS po_count,
            COALESCE(SUM(plt.lines_total), 0) AS value
       FROM tbl_rfq_purchase_order po
       ${poLinesJoin('po')}
       JOIN tbl_rfq r ON r.id = po.rfq_id
      WHERE ${companyScope()}
        AND ${rfqMapped('r', 4)}
        AND po.status NOT IN ('draft', 'cancelled')
        AND ${windowSql('po.created_at', FRAME.TZ, 2, 3)}
        ${sc}
      GROUP BY po.status`,
    params
  );
  const byStatus = new Map(rows.map((r) => [r.status, r]));
  for (const [idx, bucket] of PO_STAGE_BUCKETS.entries()) {
    for (const st of bucket.statuses) {
      const r = byStatus.get(st);
      if (!r) continue;
      stages[idx].value += Number(r.value) || 0;
      stages[idx].po_count += r.po_count;
    }
    stages[idx].value = round2(stages[idx].value);
  }
  const sumOf = (keys) => stages.filter((s) => keys.includes(s.key));
  const committed = sumOf(['approved', 'in_fulfilment', 'completed']);
  const pending = sumOf(['in_approval', 'awaiting_acceptance']);
  return {
    committed_value: round2(committed.reduce((s, x) => s + x.value, 0)),
    committed_po_count: committed.reduce((s, x) => s + x.po_count, 0),
    pending_value: round2(pending.reduce((s, x) => s + x.value, 0)),
    pending_po_count: pending.reduce((s, x) => s + x.po_count, 0),
    stages,
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
async function getBuyerStatusBannerData(buyer_company_id, user_id, hotel_ids = [], start_date = null, end_date = null) {
  // Every count below is a QUEUE about the caller's own work and is NOT
  // windowed by the date range (SPEC rule 2) — only the `period` stats are.
  // Definitions come from dashboardMetrics so the banner agrees with the
  // Action Centre and the drill-downs it opens.
  const params = [buyer_company_id, user_id, hotel_ids, start_date, end_date];
  const mine = `r.created_by = $2
        AND r.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)
        AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = r.id AND rhm.hotel_id = ANY($3))`;

  // 1. Approvals waiting on me — distinct actionable items, same predicate as
  //    the Action Centre badge and the pending-approvals list.
  const pendingApprovalsP = db.one(
    `SELECT COUNT(DISTINCT ${approvalItemKey('i')})::int AS count
     ${myPendingApprovalsFrom(2, 1, 3)}`,
    params
  );

  // 2. My published RFQs whose bid window closes in the next 24h (exact IST).
  //    Also returns the soonest one for the subline copy.
  const closingSoonP = db.one(
    `WITH c AS (
       SELECT r.id, r.title, r.rfq_no, r.bid_end_date::timestamp AS bid_end
         FROM tbl_rfq r
        WHERE ${mine}
          AND r.is_published = 1 AND r.status = 1
          AND ${hasBidEnd('r')}
          AND r.bid_end_date::timestamp > ${IST_NOW}
          AND r.bid_end_date::timestamp <= ${IST_NOW} + INTERVAL '24 hours'
     )
     SELECT COUNT(*)::int AS count,
            MIN(bid_end) AS soonest_bid_end,
            (SELECT json_build_object('id', c2.id, 'title', c2.title, 'rfq_no', c2.rfq_no)
               FROM c c2 ORDER BY c2.bid_end ASC, c2.id LIMIT 1) AS soonest
       FROM c`,
    params
  );

  // 3. Bid passed with no real offer — *the* signal that vendors aren't biting,
  //    and alone drives critical mode. Same definition as the no-response
  //    drill-down's `expired` group (published, OPEN, bid closed at exact IST
  //    time, no non-regret quote), restricted to the caller's own RFQs.
  const closedNoQuotesP = db.one(
    `SELECT COUNT(*)::int AS count
       FROM tbl_rfq r
      WHERE ${mine}
        AND r.is_published = 1 AND r.status = 1
        AND ${bidClosed('r')}
        AND NOT ${hasRealQuote('r')}`,
    params
  );

  // 4. My RFQs ready for quote comparison: bid closed (quotes are sealed until
  //    then), at least one real quote, no round in flight, no PO yet.
  const quoteCompareReadyP = db.one(
    `SELECT COUNT(*)::int AS count
       FROM tbl_rfq r
      WHERE ${mine}
        AND r.is_published = 1 AND r.status = 1
        AND ${bidClosed('r')}
        AND ${hasRealQuote('r')}
        AND NOT ${liveRoundExists('r')}
        AND NOT EXISTS (SELECT 1 FROM tbl_rfq_purchase_order po WHERE po.rfq_id = r.id)`,
    params
  );

  // 5. My POs the vendor hasn't acknowledged yet.
  const poAcceptancePendingP = db.one(
    `SELECT COUNT(*)::int AS count
       FROM tbl_rfq_purchase_order po
       JOIN tbl_rfq r ON r.id = po.rfq_id
      WHERE po.status = 'acceptance_pending' AND ${mine}`,
    params
  );

  // 6. Period stats (the only windowed part): RFQs I published, and the
  //    realised (awarded, D2) savings % on my RFQs negotiated in the window.
  //    Without a window, the last 7 days.
  const hasWindow = !!(start_date || end_date);
  const rfqWin = hasWindow
    ? windowSql('r.timestamp', FRAME.SESSION, 4, 5)
    : `r.timestamp >= (NOW() - INTERVAL '7 days')::timestamp`;
  const nrWin = hasWindow
    ? windowSql('nr.created_at', FRAME.SESSION, 4, 5)
    : `nr.created_at >= (NOW() - INTERVAL '7 days')::timestamp`;

  const periodPublishedP = db.one(
    `SELECT COUNT(*)::int AS count FROM tbl_rfq r
      WHERE ${mine} AND r.is_published = 1 AND ${rfqWin}`,
    params
  );
  const periodSavingsRfqsP = db.any(
    `SELECT DISTINCT nr.rfq_id
       FROM tbl_negotiation_rounds nr
       JOIN tbl_rfq r ON r.id = nr.rfq_id
      WHERE ${mine} AND ${nrWin}`,
    params
  );

  const [
    pendingApprovals,
    closingSoon,
    closedNoQuotes,
    quoteCompareReady,
    poAcceptancePending,
    periodPublished,
    periodSavingsRfqs,
  ] = await Promise.all([
    pendingApprovalsP,
    closingSoonP,
    closedNoQuotesP,
    quoteCompareReadyP,
    poAcceptancePendingP,
    periodPublishedP,
    periodSavingsRfqsP,
  ]);

  const savings = await priceNegotiations(periodSavingsRfqs.map((r) => r.rfq_id));
  const savings_pct = savings.baseline_awarded > 0
    ? round1(((savings.baseline_awarded - savings.achieved_awarded) / savings.baseline_awarded) * 100)
    : 0;

  // Mode is derived here so server and client agree on tone.
  const counts = {
    pending_approvals: pendingApprovals.count,
    closing_soon: closingSoon.count,
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

  const period = {
    rfqs_published: periodPublished.count,
    savings_pct,
    savings_basis: 'awarded',
    windowed: hasWindow,
  };

  return {
    mode,
    counts,
    soonest_closing: closingSoon.soonest || null,
    period,
    // Deprecated alias of `period` — it was never weekly when a range is set.
    weekly: { rfqs_published: period.rfqs_published, savings_pct },
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

  // Role-aware widgets — approval queues (one shared predicate)
  getMyTechApprovalsPendingData,
  getMyRfqApprovalsPendingData,
  getMyCommercialApprovalsPendingData,
  getMyAwardApprovalsPendingData,
  getApprovalTurnaroundData,

  // Role-aware widgets — Commercial Evaluator / N1
  getMyQuoteComparesData,
  getMyActiveNegotiationsData,
  getSavingsPipelineData,

  // Role-aware widgets — Awarding
  getRecentAwardsData,
  getAwardValuePipelineData,

  // Single-call hero banner aggregator (powers /dashboard/buyer-status-banner).
  getBuyerStatusBannerData,
};
