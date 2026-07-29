import db from '../config/dbConn.js';

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

  const pendingQuotesQuery = db.one(
    `SELECT COUNT(DISTINCT rpv.rfq_id) as count
     FROM tbl_rfq_product_vendors rpv
     JOIN tbl_rfq r ON r.id = rpv.rfq_id AND r.is_published = 1 AND r.status = 1
     LEFT JOIN tbl_quotes q ON q.rfq_id = rpv.rfq_id AND q.created_by = $1
     WHERE rpv.user_id = $1 AND q.id IS NULL
     AND (r.bid_end_date = '' OR DATE(r.bid_end_date) >= CURRENT_DATE)`, [vendor_id]);

  const closingSoonQuery = db.one(
    `SELECT COUNT(DISTINCT rpv.rfq_id) as count
     FROM tbl_rfq_product_vendors rpv
     JOIN tbl_rfq r ON r.id = rpv.rfq_id AND r.is_published = 1 AND r.status = 1
     LEFT JOIN tbl_quotes q ON q.rfq_id = rpv.rfq_id AND q.created_by = $1
     WHERE rpv.user_id = $1 AND q.id IS NULL
     AND r.bid_end_date != '' AND DATE(r.bid_end_date) BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'`, [vendor_id]);

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

  // Missed RFQs
  const missedQuery = db.one(
    `SELECT COUNT(DISTINCT rpv.rfq_id) as count
     FROM tbl_rfq_product_vendors rpv
     JOIN tbl_rfq r ON r.id = rpv.rfq_id
     LEFT JOIN tbl_quotes q ON q.rfq_id = rpv.rfq_id AND q.created_by = $1
     WHERE rpv.user_id = $1 AND q.id IS NULL
     AND r.timestamp BETWEEN $2 AND $3
     AND (r.status != 1 OR (r.bid_end_date != '' AND DATE(r.bid_end_date) < CURRENT_DATE))`, params);

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
        AND (r.bid_end_date IS NULL OR r.bid_end_date = '' OR r.bid_end_date::timestamp > NOW())
        ${hasDates ? 'AND r.timestamp BETWEEN $2 AND $3' : ''}`,
    params
  );

  // 2. Closing soon — bid window ends in <24h AND vendor hasn't quoted.
  //    Also returns the soonest RFQ so the FE can name it in the subline.
  const closingSoonP = db.oneOrNone(
    `SELECT COUNT(DISTINCT rpv.rfq_id)::INTEGER AS count,
            (SELECT json_build_object('id', _r.id, 'title', _r.title, 'rfq_no', _r.rfq_no)
               FROM tbl_rfq _r
               JOIN tbl_rfq_product_vendors _rpv ON _rpv.rfq_id = _r.id
              WHERE _rpv.user_id = $1
                AND _r.is_published = 1
                AND _r.status = 1
                AND _r.bid_end_date IS NOT NULL AND _r.bid_end_date != ''
                AND _r.bid_end_date::timestamp BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
                AND NOT EXISTS (
                  SELECT 1 FROM tbl_quotes _q
                   WHERE _q.rfq_id = _r.id AND _q.created_by = $1
                )
              ORDER BY _r.bid_end_date::timestamp ASC
              LIMIT 1) AS soonest
       FROM tbl_rfq_product_vendors rpv
       JOIN tbl_rfq r ON r.id = rpv.rfq_id
      WHERE rpv.user_id = $1
        AND r.is_published = 1
        AND r.status = 1
        AND r.bid_end_date IS NOT NULL AND r.bid_end_date != ''
        AND r.bid_end_date::timestamp BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
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
