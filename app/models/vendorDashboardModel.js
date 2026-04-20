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

export default { getOpportunities, getPerformance, getInsights };
