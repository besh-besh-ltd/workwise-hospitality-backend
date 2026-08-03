import db from '../config/dbConn.js';

// ── IST bid-window clock ─────────────────────────────────────────────
//
// Every predicate in this file that touches `tbl_rfq.bid_end_date` must use
// the constant below instead of `CURRENT_DATE` / `NOW()`.
//
// `bid_end_date` is `text NOT NULL` holding a NAIVE IST wall-clock string
// (e.g. '2026-03-14T11:00'), the same shape app/helper/quoteVisibility.js
// reads under QUOTE_VISIBILITY_TIMEZONE = Asia/Kolkata. It carries no offset,
// so the moment it is compared against a `timestamptz` clock Postgres resolves
// the naive side **through the session timezone**. Production's session
// timezone is UTC (verified on the live DB: `current_setting('TimeZone')` = UTC;
// the app sets no PGOPTIONS, no PGTZ and issues no `SET timezone`), so every
// such comparison silently asks the wrong question.

/**
 * "Now" for bid-window purposes, as a TIMESTAMP.
 *
 * THE ONLY CLOCK IN THIS FILE. Every `bid_end_date` predicate here compares at
 * wall-clock precision — "the bid window is still open", "closes within the
 * next 24h", "closes within the next 3 days", "the bid window is over".
 *
 * WHY THERE IS NO `IST_TODAY` DAY-GRANULAR TWIN ANY MORE
 * Three sites used to compare `DATE(bid_end_date)` against the IST calendar
 * day: `getOpportunities`.pending_quotes, `getOpportunities`.closing_soon and
 * `getInsights`.missed_count. Rounding to a calendar day means an RFQ whose bid
 * closed at 09:00 IST still counted as a live opportunity — and stayed out of
 * the missed count — until IST midnight, so for up to 15 hours the vendor
 * dashboard invited a vendor to quote on a bid they could no longer win. The
 * deadline's actual time now decides, which also puts these three counts in
 * agreement with the timestamp family below, with the buyer dashboard, and with
 * `bid_ended` in rfqModel.js — all of which already compared at moment
 * precision. Do not reintroduce `::date` here: a day-granular predicate next to
 * a moment-granular one is how the same RFQ ends up "open" on one card and
 * "closed" on the card beside it.
 *
 * Note this also narrowed closing_soon's 3-day window from "closes on a
 * calendar day between today and today+3" (up to ~96h, and inclusive of bids
 * that had already closed earlier today) to a rolling 72h from now. See the
 * site itself.
 *
 * WHY IT IS NOT `NOW()`
 * `bid_end_date::timestamp` is naive; `NOW()` is `timestamptz`; Postgres
 * promotes the naive side to `timestamptz` through the session timezone. So
 * `bid_end_date::timestamp > NOW()` really asks "is this IST wall-clock string,
 * reinterpreted as session-local time, in the future?". On production's UTC
 * session an 11:00 IST deadline is read as the instant 11:00 UTC — 16:30 IST.
 * Every bid-window boundary lands 5h30m LATE, all day, every day.
 *
 * On the vendor surfaces in this file that meant, with a UTC session:
 *   • `new_rfqs_unviewed` (the "still open" gate) counted RFQs whose bid window
 *     had already closed up to 5h30m earlier — the vendor was told to go quote
 *     on a dead RFQ;
 *   • `closing_soon` covered real deadlines from 5h30m in the PAST to 18h30m
 *     ahead instead of 0–24h, so it advertised already-closed RFQs as urgent
 *     and stayed silent on every bid closing 18h30m–24h out — exactly the ones
 *     a vendor still has time to act on.
 *
 * `pending_quotes`, `closing_soon` and `missed_count` now live in this family
 * too, so they carry the same exposure: written with `NOW()` they would each be
 * 5h30m out on production rather than merely a day coarse.
 *
 * The error is `5h30m − session_offset`, so it CHANGES SIGN east of IST rather
 * than shrinking: on an Asia/Singapore session (+8) it is 2h30m early instead
 * of 5h30m late. A test seeded to catch one direction passes against the buggy
 * code under the other, which is why the boundary suites straddle both.
 *
 * Deliberately NOT applied to `r.timestamp`, `po.created_at`, `q.timestamp` or
 * `nr.created_at`. Those are real `timestamp` columns defaulted from
 * `CURRENT_TIMESTAMP`, i.e. written under the same session timezone they are
 * later read under, so plain `NOW()` is already frame-consistent for them and
 * shifting them to IST would *introduce* the skew this removes.
 *
 * Also NOT applied to `nr.end_date` (negotiation round deadline) or
 * `vhcs.end_date` (subscription expiry). Neither is a `bid_end_date` string;
 * the negotiation module reads its column as UTC-naive by its own convention
 * (negotiationModel.js:513 uses `now() AT TIME ZONE 'UTC'`), and the
 * subscription column is a real `date`. Wrapping either in IST here would put
 * this file out of step with the module that owns the column.
 */
const IST_NOW = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')`;

/**
 * `bid_end_date` cast to a comparable naive timestamp, EMPTY-SAFE.
 *
 * `bid_end_date` is `text NOT NULL` but a real share of rows carry `''` — an
 * RFQ published with no deadline. `''::timestamp` does not return NULL, it
 * raises `invalid input syntax for type timestamp: ""` and aborts the WHOLE
 * query, so one such row 500s the entire dashboard endpoint. That is not
 * hypothetical: it is the incident documented at hospitalityModel.js:1999,
 * where an unguarded cast silently zeroed out every new vendor's RFQ backfill.
 *
 * It is tempting to lean on the `bid_end_date = ''` / `!= ''` conjunct sitting
 * next to the cast, but Postgres does not guarantee left-to-right evaluation of
 * AND/OR, and whether it happens to short-circuit is a property of the PLAN,
 * not of the SQL. Measured on 20k rows, 40 of them `''`:
 *
 *     WHERE bid != '' AND bid::timestamp > now()               -- OK
 *     WHERE (bid = '' OR bid::timestamp > now())               -- OK
 *     ... FROM t JOIN g ON g.id = t.id
 *     WHERE g.ok AND t.bid::timestamp > now()                  -- ERROR
 *
 * The last one is the same guard, still on every row, merely moved onto a
 * joined relation — and it raises. Nothing about the predicate changed; the
 * plan did. Adding a join, or letting the planner re-cost one, is enough.
 *
 * `NULLIF` moves the guard INSIDE the expression, where no plan can reorder
 * around it: an empty deadline becomes NULL, every comparison against it yields
 * NULL, and NULL is not true, so the row simply fails the predicate instead of
 * killing the query. All three shapes above are safe with it.
 *
 * The `= ''` / `!= ''` conjuncts are kept anyway — they still carry the
 * INTENT (does an RFQ with no deadline count here or not?), which differs per
 * site and is not derivable from the NULLIF alone:
 *   • pending_quotes — `''` is INCLUDED. No deadline means the window has not
 *     closed, so the RFQ is still an opportunity. Preserved from the pre-change
 *     behaviour verbatim; flipping it would silently drop live opportunities.
 *   • closing_soon / missed_count — `''` is EXCLUDED. Neither "closes within
 *     3 days" nor "the vendor let it lapse" is meaningful without a deadline.
 *
 * Parameterised by alias because the status-banner `soonest` sub-select ranges
 * over `_r` rather than `r`; both need the same protection.
 *
 * This is NOT theoretical: production currently holds 36 RFQs with
 * bid_end_date = '', one of which (id 744 / rfq_no 536286) is published and
 * live, so the vendor status banner is one planner decision away from 500ing
 * for every vendor.
 */
const bidEndTs = (alias = 'r') => `NULLIF(${alias}.bid_end_date, '')::timestamp`;
const BID_END_TS = bidEndTs('r');

// ─────────────────────────────────────────────────────────────────────
// 1. Opportunity Feed
// ─────────────────────────────────────────────────────────────────────
async function getOpportunities(vendor_id, start_date, end_date) {
  const params = [vendor_id, start_date, end_date];

  const newRfqsQuery = db.one(
    `SELECT COUNT(DISTINCT rpv.rfq_id) as count
     FROM tbl_rfq_product_vendors rpv
     JOIN tbl_rfq r ON r.id = rpv.rfq_id AND r.is_published = 1 AND r.status = 1
     LEFT JOIN tbl_quotes q ON q.rfq_id = rpv.rfq_id AND q.created_by = $1
     WHERE rpv.user_id = $1 AND q.id IS NULL
     AND r.timestamp BETWEEN $2 AND $3`, params);

  // Bids the vendor can still win: the deadline has not passed YET, at IST
  // wall-clock precision. Was `DATE(bid_end_date) >= <IST today>`, which kept
  // an RFQ that closed at 09:00 IST on the feed until IST midnight.
  // An empty deadline still counts as open — see BID_END_TS.
  const pendingQuotesQuery = db.one(
    `SELECT COUNT(DISTINCT rpv.rfq_id) as count
     FROM tbl_rfq_product_vendors rpv
     JOIN tbl_rfq r ON r.id = rpv.rfq_id AND r.is_published = 1 AND r.status = 1
     LEFT JOIN tbl_quotes q ON q.rfq_id = rpv.rfq_id AND q.created_by = $1
     WHERE rpv.user_id = $1 AND q.id IS NULL
     AND (r.bid_end_date = '' OR ${BID_END_TS} > ${IST_NOW})`, [vendor_id]);

  // Urgency counterpart of the above: of those still-open bids, the ones due
  // inside a ROLLING 72 HOURS from this instant.
  //
  // This window changed shape, not just precision. It used to be
  // `DATE(bid_end_date) BETWEEN <IST today> AND <IST today> + 3 days` — every
  // bid whose CLOSING CALENDAR DAY fell in a four-day span, which reached up to
  // ~96h ahead (a bid at 23:59 on day +3, read at 00:01 today) and, worse,
  // reached BACKWARDS: a bid that closed at 09:00 this morning was still being
  // advertised as "closing soon" all day, because its calendar day was still
  // today. Now the count means exactly "closes in the next 72h and has not
  // closed yet" — the lower `BETWEEN` bound of IST_NOW is what excludes bids
  // already past. Expect it to read slightly lower than it used to.
  const closingSoonQuery = db.one(
    `SELECT COUNT(DISTINCT rpv.rfq_id) as count
     FROM tbl_rfq_product_vendors rpv
     JOIN tbl_rfq r ON r.id = rpv.rfq_id AND r.is_published = 1 AND r.status = 1
     LEFT JOIN tbl_quotes q ON q.rfq_id = rpv.rfq_id AND q.created_by = $1
     WHERE rpv.user_id = $1 AND q.id IS NULL
     AND r.bid_end_date != '' AND ${BID_END_TS} BETWEEN ${IST_NOW} AND ${IST_NOW} + INTERVAL '3 days'`, [vendor_id]);

  const posReceivedQuery = db.one(
    `SELECT COUNT(*) as count
     FROM tbl_rfq_purchase_order po
     WHERE po.finalized_vendor_id = $1 AND po.created_at BETWEEN $2 AND $3`, params);

  const [a, b, c, d] = await Promise.all([newRfqsQuery, pendingQuotesQuery, closingSoonQuery, posReceivedQuery]);

  return {
    new_rfqs: parseInt(a.count, 10),
    pending_quotes: parseInt(b.count, 10),
    closing_soon: parseInt(c.count, 10),
    pos_received: parseInt(d.count, 10),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 2. Performance Snapshot — clearer metrics
// ─────────────────────────────────────────────────────────────────────
async function getPerformance(vendor_id, start_date, end_date) {
  const params = [vendor_id, start_date, end_date];

  // Total RFQs invited to
  const invitedQuery = db.one(
    `SELECT COUNT(DISTINCT rpv.rfq_id) as count
     FROM tbl_rfq_product_vendors rpv
     JOIN tbl_rfq r ON r.id = rpv.rfq_id
     WHERE rpv.user_id = $1 AND r.timestamp BETWEEN $2 AND $3`, params);

  // RFQs vendor actually quoted on
  const quotedQuery = db.one(
    `SELECT COUNT(DISTINCT q.rfq_id) as count
     FROM tbl_quotes q
     JOIN tbl_rfq r ON r.id = q.rfq_id
     WHERE q.created_by = $1 AND q.is_regret = 0 AND q.timestamp BETWEEN $2 AND $3`, params);

  // RFQs where vendor quoted AND at least one product was finalized to ANY vendor
  const competedQuery = db.one(
    `SELECT COUNT(DISTINCT q.rfq_id) as count
     FROM tbl_quotes q
     JOIN tbl_rfq r ON r.id = q.rfq_id
     WHERE q.created_by = $1 AND q.is_regret = 0 AND q.timestamp BETWEEN $2 AND $3
     AND EXISTS (SELECT 1 FROM tbl_quote_finalization qf WHERE qf.rfq_id = q.rfq_id)`, params);

  // RFQs where vendor WON (finalized to this vendor)
  const wonQuery = db.one(
    `SELECT COUNT(DISTINCT qf.rfq_id) as count
     FROM tbl_quote_finalization qf
     WHERE qf.vendor_id = $1 AND qf.timestamp BETWEEN $2 AND $3`, params);

  // Total revenue from approved POs
  const revenueQuery = db.one(
    `SELECT COALESCE(SUM(pop.total_price), 0) as total
     FROM tbl_rfq_purchase_order po
     JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
     WHERE po.finalized_vendor_id = $1 AND po.status NOT IN ('draft', 'cancelled')
     AND po.created_at BETWEEN $2 AND $3`, params);

  // POs accepted by vendor
  const posAcceptedQuery = db.one(
    `SELECT COUNT(*) as count
     FROM tbl_rfq_purchase_order po
     WHERE po.finalized_vendor_id = $1 AND po.status IN ('approved', 'sent', 'dispatched', 'GRN', 'completed')
     AND po.created_at BETWEEN $2 AND $3`, params);

  const [invited, quoted, competed, won, revenue, posAccepted] = await Promise.all([
    invitedQuery, quotedQuery, competedQuery, wonQuery, revenueQuery, posAcceptedQuery,
  ]);

  const competedCount = parseInt(competed.count, 10);
  const wonCount = parseInt(won.count, 10);

  return {
    rfqs_invited: parseInt(invited.count, 10),
    rfqs_quoted: parseInt(quoted.count, 10),
    rfqs_finalized: competedCount,
    deals_won: wonCount,
    win_rate: competedCount > 0 ? Math.round((wonCount / competedCount) * 100) : 0,
    total_revenue: parseFloat(revenue.total),
    pos_accepted: parseInt(posAccepted.count, 10),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 3. Insights — revenue trend, top products, business unit performance,
//    response efficiency, win/loss, recent activity
// ─────────────────────────────────────────────────────────────────────
async function getInsights(vendor_id, start_date, end_date) {
  const params = [vendor_id, start_date, end_date];

  // Revenue by month
  const revenueTrendQuery = db.any(
    `WITH series AS (
       SELECT generate_series(
         DATE_TRUNC('month', $2::timestamp),
         DATE_TRUNC('month', $3::timestamp),
         '1 month'::interval
       ) as period
     ),
     rev AS (
       SELECT DATE_TRUNC('month', po.created_at) as period, SUM(pop.total_price) as revenue
       FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       WHERE po.finalized_vendor_id = $1 AND po.status NOT IN ('draft', 'cancelled')
       AND po.created_at BETWEEN $2 AND $3
       GROUP BY DATE_TRUNC('month', po.created_at)
     )
     SELECT s.period, COALESCE(r.revenue, 0) as revenue
     FROM series s LEFT JOIN rev r ON r.period = s.period
     ORDER BY s.period`, params);

  // Top products quoted
  const topProductsQuery = db.any(
    `SELECT pv.name as product_name, COUNT(DISTINCT qi.rfq_id) as times_quoted,
       AVG(qi.total_price) as avg_quote_value
     FROM tbl_quote_items qi
     JOIN tbl_quotes q ON q.id = qi.quote_id AND q.created_by = $1 AND q.is_regret = 0
     JOIN tbl_product_variant pv ON pv.id = qi.product_variant_id
     WHERE q.timestamp BETWEEN $2 AND $3
     GROUP BY pv.name ORDER BY times_quoted DESC LIMIT 5`, params);

  // Business unit performance: RFQs vs Orders per hotel
  const buPerformanceQuery = db.any(
    `SELECT
       hch.name as business_unit,
       COUNT(DISTINCT rpv.rfq_id) as rfqs_received,
       COUNT(DISTINCT CASE
         WHEN po.finalized_vendor_id = $1 AND po.status IN ('approved','sent','dispatched','GRN','completed')
         THEN po.id END) as orders_received
     FROM tbl_rfq_product_vendors rpv
     JOIN tbl_rfq r ON r.id = rpv.rfq_id
     JOIN tbl_rfq_hotel_mappings rhm ON rhm.rfq_id = r.id
     JOIN tbl_hospitality_company_hotels hch ON hch.id = rhm.hotel_id
     LEFT JOIN tbl_rfq_purchase_order po ON po.rfq_id = r.id AND po.finalized_vendor_id = $1
     WHERE rpv.user_id = $1 AND r.timestamp BETWEEN $2 AND $3
     GROUP BY hch.name
     ORDER BY rfqs_received DESC
     LIMIT 8`, params);

  // Response efficiency — detailed
  const responseQuery = db.one(
    `SELECT
       AVG(EXTRACT(EPOCH FROM (q.timestamp - r.tender_publish_date)) / 3600) as avg_response_hours,
       COUNT(DISTINCT q.rfq_id) as responded_count,
       COUNT(DISTINCT q.rfq_id) FILTER (
         WHERE EXTRACT(EPOCH FROM (q.timestamp - r.tender_publish_date)) / 3600 <= 24
       ) as within_24h,
       COUNT(DISTINCT q.rfq_id) FILTER (
         WHERE EXTRACT(EPOCH FROM (q.timestamp - r.tender_publish_date)) / 3600 <= 72
       ) as within_3d
     FROM tbl_quotes q
     JOIN tbl_rfq r ON r.id = q.rfq_id
     WHERE q.created_by = $1 AND q.is_regret = 0
     AND r.tender_publish_date IS NOT NULL
     AND q.timestamp BETWEEN $2 AND $3`, params);

  // Missed RFQs — invited, never quoted, and no longer quotable: either the RFQ
  // left the open state or its deadline has PASSED, at IST wall-clock
  // precision. Was `DATE(bid_end_date) < <IST today>`, which withheld a bid
  // from the response-efficiency card until IST midnight even though the vendor
  // had already lost it that morning. Exact mirror of pending_quotes above, so
  // the two can no longer both claim the same RFQ.
  const missedQuery = db.one(
    `SELECT COUNT(DISTINCT rpv.rfq_id) as count
     FROM tbl_rfq_product_vendors rpv
     JOIN tbl_rfq r ON r.id = rpv.rfq_id
     LEFT JOIN tbl_quotes q ON q.rfq_id = rpv.rfq_id AND q.created_by = $1
     WHERE rpv.user_id = $1 AND q.id IS NULL
     AND r.timestamp BETWEEN $2 AND $3
     AND (r.status != 1 OR (r.bid_end_date != '' AND ${BID_END_TS} < ${IST_NOW}))`, params);

  // Win/Loss with more detail
  const winLossQuery = db.one(
    `WITH competed AS (
       SELECT DISTINCT q.rfq_id
       FROM tbl_quotes q
       JOIN tbl_rfq r ON r.id = q.rfq_id
       WHERE q.created_by = $1 AND q.is_regret = 0 AND q.timestamp BETWEEN $2 AND $3
     ),
     finalized AS (
       SELECT DISTINCT qf.rfq_id, qf.vendor_id
       FROM tbl_quote_finalization qf WHERE qf.rfq_id IN (SELECT rfq_id FROM competed)
     )
     SELECT
       COUNT(DISTINCT CASE WHEN f.vendor_id = $1 THEN c.rfq_id END) as won,
       COUNT(DISTINCT CASE WHEN f.vendor_id IS NOT NULL AND f.vendor_id != $1 THEN c.rfq_id END) as lost,
       COUNT(DISTINCT CASE WHEN f.vendor_id IS NULL THEN c.rfq_id END) as pending
     FROM competed c LEFT JOIN finalized f ON f.rfq_id = c.rfq_id`, params);

  // Recent activity — enriched with buyer company info
  const activityQuery = db.any(
    `(SELECT 'new_rfq' as type, r.rfq_no, r.title, r.timestamp as event_time, r.id as rfq_id,
        (SELECT c.company_name FROM tbl_users u JOIN tbl_company c ON c.id = u.company_id WHERE u.id = r.created_by) as buyer_name
      FROM tbl_rfq_product_vendors rpv
      JOIN tbl_rfq r ON r.id = rpv.rfq_id
      WHERE rpv.user_id = $1 AND r.timestamp BETWEEN $2 AND $3
      ORDER BY r.timestamp DESC LIMIT 4)
     UNION ALL
     (SELECT 'quote_sent' as type, r.rfq_no, r.title, q.timestamp as event_time, r.id as rfq_id, NULL as buyer_name
      FROM tbl_quotes q JOIN tbl_rfq r ON r.id = q.rfq_id
      WHERE q.created_by = $1 AND q.is_regret = 0 AND q.timestamp BETWEEN $2 AND $3
      ORDER BY q.timestamp DESC LIMIT 4)
     UNION ALL
     (SELECT 'po_received' as type, r.rfq_no, r.title, po.created_at as event_time, r.id as rfq_id,
        (SELECT c.company_name FROM tbl_users u JOIN tbl_company c ON c.id = u.company_id WHERE u.id = po.initiated_by) as buyer_name
      FROM tbl_rfq_purchase_order po JOIN tbl_rfq r ON r.id = po.rfq_id
      WHERE po.finalized_vendor_id = $1 AND po.created_at BETWEEN $2 AND $3
      ORDER BY po.created_at DESC LIMIT 4)
     ORDER BY event_time DESC LIMIT 10`, params);

  const [revenueTrend, topProducts, buPerf, response, missed, winLoss, activity] = await Promise.all([
    revenueTrendQuery, topProductsQuery, buPerformanceQuery, responseQuery, missedQuery, winLossQuery, activityQuery,
  ]);

  const avgHours = response.avg_response_hours ? parseFloat(parseFloat(response.avg_response_hours).toFixed(1)) : 0;
  const respondedCount = parseInt(response.responded_count, 10);

  return {
    revenue_trend: {
      labels: revenueTrend.map((r) => r.period),
      data: revenueTrend.map((r) => parseFloat(r.revenue)),
    },
    top_products: topProducts.map((p) => ({
      product_name: p.product_name,
      times_quoted: parseInt(p.times_quoted, 10),
      avg_quote_value: p.avg_quote_value ? parseFloat(parseFloat(p.avg_quote_value).toFixed(2)) : 0,
    })),
    bu_performance: buPerf.map((b) => ({
      business_unit: b.business_unit,
      rfqs_received: parseInt(b.rfqs_received, 10),
      orders_received: parseInt(b.orders_received, 10),
    })),
    response_efficiency: {
      avg_response_hours: avgHours,
      avg_response_days: avgHours > 0 ? parseFloat((avgHours / 24).toFixed(1)) : 0,
      responded_count: respondedCount,
      missed_count: parseInt(missed.count, 10),
      within_24h: parseInt(response.within_24h, 10),
      within_3d: parseInt(response.within_3d, 10),
      on_time_pct: respondedCount > 0 ? Math.round((parseInt(response.within_3d, 10) / respondedCount) * 100) : 0,
    },
    win_loss: {
      won: parseInt(winLoss.won, 10),
      lost: parseInt(winLoss.lost, 10),
      pending: parseInt(winLoss.pending, 10),
    },
    recent_activity: activity.map((a) => ({
      type: a.type,
      rfq_no: a.rfq_no,
      rfq_id: a.rfq_id,
      title: a.title,
      event_time: a.event_time,
      buyer_name: a.buyer_name,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Status Banner — vendor-side hero aggregator. Mirrors the buyer banner
//  but answers vendor-specific questions:
//
//    1. new_rfqs_unviewed      RFQs invited to, never opened
//    2. closing_soon           Invited RFQ where bid window <24h + not quoted
//    3. pending_negotiation    Live negotiation round where vendor hasn't
//                              submitted a quote yet
//    4. po_acceptance_pending  POs sent to me, awaiting my acceptance
//    5. po_in_transit          POs sent / dispatched / GRN (in flight)
//    6. subscription_expiring  Active subscription ending within 30 days
//    + weekly_wins             POs accepted in last 7 days
//    + weekly_revenue          Sum of total_price on those POs
//
//  Mode derivation:
//    critical      → any closed-bid-no-quote on an RFQ the vendor was invited
//                    to but skipped, OR a subscription already expired
//    action_needed → closing_soon ≥ 1, pending_negotiation ≥ 1, OR
//                    po_acceptance_pending ≥ 1, OR subscription_expiring ≥ 1
//    steady        → new_rfqs_unviewed ≥ 1 or po_in_transit ≥ 1
//    clear         → otherwise
// ─────────────────────────────────────────────────────────────────────
async function getStatusBannerData(vendor_id, start_date, end_date) {
  // Period-based counts respect the selected range when supplied; forward-looking
  // signals (closing-soon, pending negotiation, subscription expiry) stay live.
  const hasDates = !!(start_date && end_date);
  const params = [vendor_id, start_date, end_date];

  // 1. New RFQs the vendor was invited to but hasn't opened yet. Uses
  //    tbl_rfq_product_vendors.is_rfq_viewed; treat NULL/0 as "unviewed".
  const newRfqsUnviewedP = db.one(
    `SELECT COUNT(DISTINCT rpv.rfq_id)::INTEGER AS count
       FROM tbl_rfq_product_vendors rpv
       JOIN tbl_rfq r ON r.id = rpv.rfq_id
      WHERE rpv.user_id = $1
        AND r.is_published = 1
        AND r.status = 1
        AND (rpv.is_rfq_viewed IS NULL OR rpv.is_rfq_viewed = 0)
        AND (r.bid_end_date IS NULL OR r.bid_end_date = '' OR ${BID_END_TS} > ${IST_NOW})
        ${hasDates ? 'AND r.timestamp BETWEEN $2 AND $3' : ''}`,
    params
  );

  // 2. Closing soon — bid window ends in <24h AND vendor hasn't quoted.
  //    Also returns the soonest RFQ so the FE can name it in the subline.
  //
  //    The `ORDER BY ${bidEndTs('_r')} ASC` below is intentionally
  //    left un-wrapped: it ranks naive IST strings against EACH OTHER, never
  //    against a clock, so it carries no session-timezone dependence. The rows
  //    it ranks have already been filtered by the IST_NOW window above.
  const closingSoonP = db.oneOrNone(
    `SELECT COUNT(DISTINCT rpv.rfq_id)::INTEGER AS count,
            (SELECT json_build_object('id', _r.id, 'title', _r.title, 'rfq_no', _r.rfq_no)
               FROM tbl_rfq _r
               JOIN tbl_rfq_product_vendors _rpv ON _rpv.rfq_id = _r.id
              WHERE _rpv.user_id = $1
                AND _r.is_published = 1
                AND _r.status = 1
                AND _r.bid_end_date IS NOT NULL AND _r.bid_end_date != ''
                AND ${bidEndTs('_r')} BETWEEN ${IST_NOW} AND ${IST_NOW} + INTERVAL '24 hours'
                AND NOT EXISTS (
                  SELECT 1 FROM tbl_quotes _q
                   WHERE _q.rfq_id = _r.id AND _q.created_by = $1
                )
              ORDER BY ${bidEndTs('_r')} ASC
              LIMIT 1) AS soonest
       FROM tbl_rfq_product_vendors rpv
       JOIN tbl_rfq r ON r.id = rpv.rfq_id
      WHERE rpv.user_id = $1
        AND r.is_published = 1
        AND r.status = 1
        AND r.bid_end_date IS NOT NULL AND r.bid_end_date != ''
        AND ${BID_END_TS} BETWEEN ${IST_NOW} AND ${IST_NOW} + INTERVAL '24 hours'
        AND NOT EXISTS (
          SELECT 1 FROM tbl_quotes q
           WHERE q.rfq_id = r.id AND q.created_by = $1
        )`,
    params
  );

  // 3. Pending negotiation rounds — live (PUBLISHED), not yet ended,
  //    vendor had an original quote (was invited to negotiate), and the
  //    vendor has not yet submitted a quote for THIS round.
  const pendingNegotiationP = db.one(
    `SELECT COUNT(DISTINCT nr.id)::INTEGER AS count
       FROM tbl_negotiation_rounds nr
      WHERE nr.status IN ('PUBLISHED', 'OPEN', 'APPROVED')
        AND nr.end_date > NOW()
        AND EXISTS (
          SELECT 1 FROM tbl_quotes q
           WHERE q.rfq_id = nr.rfq_id AND q.created_by = $1
        )
        AND NOT EXISTS (
          SELECT 1 FROM tbl_negotiation_round_quotes nrq
           WHERE nrq.negotiation_round_id = nr.id
             AND nrq.vendor_id = $1
             AND nrq.quoted_price IS NOT NULL
        )`,
    params
  );

  // 4. POs sent to me awaiting acceptance.
  const poAcceptancePendingP = db.one(
    `SELECT COUNT(*)::INTEGER AS count
       FROM tbl_rfq_purchase_order po
      WHERE po.finalized_vendor_id = $1
        AND po.status = 'acceptance_pending'
        ${hasDates ? 'AND po.created_at BETWEEN $2 AND $3' : ''}`,
    params
  );

  // 5. POs in flight — sent / dispatched / GRN. Excludes 'completed' and
  //    pre-shipment 'approved' (which still needs vendor acceptance).
  const poInTransitP = db.one(
    `SELECT COUNT(*)::INTEGER AS count
       FROM tbl_rfq_purchase_order po
      WHERE po.finalized_vendor_id = $1
        AND po.status IN ('sent', 'dispatched', 'GRN')
        ${hasDates ? 'AND po.created_at BETWEEN $2 AND $3' : ''}`,
    params
  );

  // 6. Subscriptions expiring within 30 days (or already expired but still
  //    flagged 'active' — both indicate the vendor needs to renew).
  const subscriptionExpiringP = db.one(
    `SELECT COUNT(*)::INTEGER AS count
       FROM tbl_vendor_hotel_category_subscription vhcs
      WHERE vhcs.vendor_id = $1
        AND vhcs.status = 'active'
        AND vhcs.end_date IS NOT NULL
        AND vhcs.end_date <= CURRENT_DATE + INTERVAL '30 days'`,
    params
  );

  // 7. Weekly wins + revenue — POs accepted-or-better in last 7 days.
  const weeklyP = db.one(
    `SELECT COUNT(*)::INTEGER AS count,
            COALESCE(SUM(pop.total_price), 0) AS revenue
       FROM tbl_rfq_purchase_order po
       LEFT JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
      WHERE po.finalized_vendor_id = $1
        AND po.status IN ('approved', 'sent', 'dispatched', 'GRN', 'completed')
        ${hasDates ? 'AND po.created_at BETWEEN $2 AND $3' : "AND po.created_at >= NOW() - INTERVAL '7 days'"}`,
    params
  );

  const [
    newRfqsUnviewed,
    closingSoon,
    pendingNegotiation,
    poAcceptancePending,
    poInTransit,
    subscriptionExpiring,
    weekly,
  ] = await Promise.all([
    newRfqsUnviewedP,
    closingSoonP,
    pendingNegotiationP,
    poAcceptancePendingP,
    poInTransitP,
    subscriptionExpiringP,
    weeklyP,
  ]);

  const counts = {
    new_rfqs_unviewed: newRfqsUnviewed.count,
    closing_soon: closingSoon?.count || 0,
    pending_negotiation: pendingNegotiation.count,
    po_acceptance_pending: poAcceptancePending.count,
    po_in_transit: poInTransit.count,
    subscription_expiring: subscriptionExpiring.count,
  };

  // Precedence (lowest → highest): clear < steady < win < action_needed < critical.
  let mode = 'clear';
  if (counts.new_rfqs_unviewed >= 1 || counts.po_in_transit >= 1) {
    mode = 'steady';
  }
  // A PO to accept is a WIN — the vendor was awarded an order. Treated as a
  // positive (green) state rather than an amber warning (Sr 335)...
  if (counts.po_acceptance_pending >= 1) {
    mode = 'win';
  }
  // ...unless something genuinely time-pressured needs them now: a closing bid,
  // an open negotiation round, or a subscription about to lapse.
  if (
    counts.closing_soon >= 1 ||
    counts.pending_negotiation >= 1 ||
    counts.subscription_expiring >= 1
  ) {
    mode = 'action_needed';
  }
  // Subscription lapsing while POs pile up = the one truly critical combination.
  if (counts.subscription_expiring >= 1 && counts.po_acceptance_pending >= 2) {
    mode = 'critical';
  }

  return {
    mode,
    counts,
    soonest_closing: closingSoon?.soonest || null,
    weekly: {
      pos_won: weekly.count,
      revenue: Number(weekly.revenue) || 0,
    },
  };
}

export default { getOpportunities, getPerformance, getInsights, getStatusBannerData };
