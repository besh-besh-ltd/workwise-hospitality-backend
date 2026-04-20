import db from '../config/dbConn.js';

/**
 * Dashboard queries scope by buyer_company_id (covers ALL hospitality companies
 * under the same buyer account) + hotel_ids (intersected with user's allowed set).
 *
 * Param convention:
 *   $1 = buyer_company_id (from tbl_hospitality_companies.buyer_company_id)
 *   $2 = start_date
 *   $3 = end_date
 *   $4 = hotel_ids (always provided — user's allowed scope)
 */

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Company scope: matches any hospitality_company under the same buyer account.
 * Uses a subquery so we don't need to pass an array of company IDs.
 */
function companyScope(alias = 'r') {
  return `${alias}.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)`;
}

function hotelFilter(alias = 'r', paramIdx = 4) {
  return `AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = ${alias}.id AND rhm.hotel_id = ANY($${paramIdx}))`;
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
    `SELECT user_type, company_id FROM tbl_users WHERE id = $1`,
    [user_id]
  );

  if (!userInfo) return null;

  let buyer_company_id;
  let allAllowed = [];

  if (parseInt(userInfo.user_type) === 7) {
    // Admin (user_type=7): full access to all hospitality companies under their company
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

  const rfqsAwaitingQuery = db.one(
    `SELECT COUNT(*) as count FROM tbl_rfq r
     WHERE ${companyScope()} AND r.is_published = 1 AND r.status = 1
     AND NOT EXISTS (SELECT 1 FROM tbl_quotes q WHERE q.rfq_id = r.id)
     ${dateFilterRfq} ${hf}`,
    params
  );

  // RFQs ending soon: any RFQ (tender or not) whose bid_end_date is within 3 days
  const rfqsEndingSoonQuery = db.one(
    `SELECT COUNT(*) as count FROM tbl_rfq r
     WHERE ${companyScope()} AND r.is_published = 1 AND r.status = 1
     AND r.bid_end_date != '' AND DATE(r.bid_end_date) BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
     ${hf}`,
    params
  );

  const posAwaitingQuery = db.one(
    `SELECT COUNT(*) as count
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq r ON r.id = po.rfq_id
     WHERE ${companyScope()} AND po.status = 'acceptance_pending'
     ${dateFilterPo} ${hf}`,
    params
  );

  // Only count rejected POs where no replacement PO exists for the same product
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
     ${dateFilterPo} ${hf}`,
    params
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
// 2. Procurement Snapshot
// ─────────────────────────────────────────────────────────────────────
async function getProcurementSnapshotData(buyer_company_id, hotel_ids = [], start_date, end_date) {
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];

  const totalRfqsQuery = db.one(
    `SELECT COUNT(*) as count FROM tbl_rfq r
     WHERE ${companyScope()} AND r.timestamp BETWEEN $2 AND $3 ${hf}`,
    params
  );

  const activeTendersQuery = db.one(
    `SELECT COUNT(*) as count FROM tbl_rfq r
     WHERE ${companyScope()} AND r.is_tender = 1 AND r.is_published = 1 AND r.status = 1 ${hf}`,
    params
  );

  const posIssuedQuery = db.one(
    `SELECT COUNT(*) as count
     FROM tbl_rfq_purchase_order po
     JOIN tbl_rfq r ON r.id = po.rfq_id
     WHERE ${companyScope()} AND po.created_at BETWEEN $2 AND $3 ${hf}`,
    params
  );

  // Total Spend: approved POs, using total_price (includes tax, freight, packaging)
  const totalSpendQuery = db.one(
    `SELECT COALESCE(SUM(pop.total_price), 0) as total_spend
     FROM tbl_rfq_purchase_order po
     JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
     JOIN tbl_rfq r ON r.id = po.rfq_id
     WHERE ${companyScope()} AND po.created_at BETWEEN $2 AND $3
     AND po.status NOT IN ('draft', 'cancelled') ${hf}`,
    params
  );

  // Avg turnaround: RFQ publish → finalization
  const avgTurnaroundQuery = db.one(
    `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (qf.timestamp - r.tender_publish_date)) / 86400), 0) as avg_turnaround
     FROM tbl_quote_finalization qf
     JOIN tbl_rfq r ON r.id = qf.rfq_id
     WHERE ${companyScope()} AND qf.timestamp BETWEEN $2 AND $3
     AND r.tender_publish_date IS NOT NULL ${hf}`,
    params
  );

  const [tr, at, pi, ts, avt] = await Promise.all([
    totalRfqsQuery, activeTendersQuery, posIssuedQuery, totalSpendQuery, avgTurnaroundQuery,
  ]);

  return {
    total_rfqs: parseInt(tr.count, 10),
    active_tenders: parseInt(at.count, 10),
    pos_issued: parseInt(pi.count, 10),
    total_spend: parseFloat(ts.total_spend),
    avg_turnaround: parseFloat(parseFloat(avt.avg_turnaround).toFixed(1)),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 3. Negotiation Savings
//    Compares round 1 quoted_price (initial vendor offer) with the
//    LAST round quoted_price for the same vendor+product (final negotiated price).
// ─────────────────────────────────────────────────────────────────────
async function getNegotiationSavingsData(buyer_company_id, hotel_ids = [], start_date, end_date) {
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];

  const savingsQuery = db.oneOrNone(
    `WITH scoped_rfqs AS (
       SELECT DISTINCT nr.rfq_id
       FROM tbl_negotiation_rounds nr
       JOIN tbl_rfq r ON r.id = nr.rfq_id
       WHERE ${companyScope()} AND nr.created_at BETWEEN $2 AND $3 ${hf}
     ),
     round1 AS (
       SELECT sr.rfq_id, nrq.vendor_id, nrq.rfq_product_id, nrq.quoted_price
       FROM scoped_rfqs sr
       JOIN tbl_negotiation_rounds nr ON nr.rfq_id = sr.rfq_id AND nr.round_number = 1
       JOIN tbl_negotiation_round_quotes nrq ON nrq.negotiation_round_id = nr.id
       WHERE nrq.quoted_price IS NOT NULL AND nrq.quoted_price > 0
     ),
     last_round AS (
       SELECT DISTINCT ON (nr.rfq_id, nrq.vendor_id, nrq.rfq_product_id)
         nr.rfq_id, nrq.vendor_id, nrq.rfq_product_id, nrq.quoted_price
       FROM scoped_rfqs sr
       JOIN tbl_negotiation_rounds nr ON nr.rfq_id = sr.rfq_id
       JOIN tbl_negotiation_round_quotes nrq ON nrq.negotiation_round_id = nr.id
       WHERE nrq.quoted_price IS NOT NULL AND nrq.quoted_price > 0
       ORDER BY nr.rfq_id, nrq.vendor_id, nrq.rfq_product_id, nr.round_number DESC
     )
     SELECT
       COALESCE(SUM(r1.quoted_price), 0) as market_baseline,
       COALESCE(SUM(lr.quoted_price), 0) as negotiated_total,
       COALESCE(SUM(r1.quoted_price) - SUM(lr.quoted_price), 0) as total_savings,
       COUNT(*) as negotiation_count
     FROM round1 r1
     JOIN last_round lr ON lr.rfq_id = r1.rfq_id
       AND lr.vendor_id = r1.vendor_id
       AND lr.rfq_product_id = r1.rfq_product_id`,
    params
  );

  const marketBaseline = savingsQuery ? parseFloat(savingsQuery.market_baseline) : 0;
  const negotiatedTotal = savingsQuery ? parseFloat(savingsQuery.negotiated_total) : 0;
  const totalSavings = savingsQuery ? parseFloat(savingsQuery.total_savings) : 0;

  return {
    total_savings: Math.max(totalSavings, 0),
    market_baseline: marketBaseline,
    negotiated_total: negotiatedTotal,
    negotiation_count: savingsQuery ? parseInt(savingsQuery.negotiation_count, 10) : 0,
    top_category_saving: { name: null, percentage: 0 },
    cost_avoidance: Math.max(totalSavings, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 4. Cost Intelligence
// ─────────────────────────────────────────────────────────────────────
async function getCostIntelligenceData(buyer_company_id, hotel_ids = [], start_date, end_date, product_variant_id = null, duration_type = 'past7days') {
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];

  const topProducts = await db.any(
    `SELECT rp.product_variant_id, pv.name as product_name, COUNT(*) as order_count
     FROM tbl_rfq_products rp
     JOIN tbl_rfq r ON r.id = rp.rfq_id AND ${companyScope()}
     JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
     WHERE r.timestamp BETWEEN $2 AND $3 ${hf}
     GROUP BY rp.product_variant_id, pv.name
     ORDER BY order_count DESC
     LIMIT 5`,
    params
  );

  if (topProducts.length === 0) {
    return { top_products: [], price_trend: { labels: [], data: [] }, vendor_comparison: [] };
  }

  const pid = product_variant_id || topProducts[0].product_variant_id;

  // Time granularity based on duration
  const truncMap = {
    past7days: 'day',
    past15days: 'day',
    currentMonth: 'day',
    past6months: 'month',
  };
  const trunc = truncMap[duration_type] || 'day';

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
       SELECT DATE_TRUNC('${trunc}', q.timestamp) as period,
         AVG(qi.total_price) as avg_price,
         MAX(qi.total_price) as max_price,
         MIN(qi.total_price) as min_price
       FROM tbl_quote_items qi
       JOIN tbl_quotes q ON q.id = qi.quote_id
       JOIN tbl_rfq r ON r.id = q.rfq_id AND ${companyScope()}
       WHERE qi.product_variant_id = $5
       AND q.timestamp BETWEEN $2 AND $3 ${hf}
       GROUP BY DATE_TRUNC('${trunc}', q.timestamp)
     )
     SELECT s.period, p.avg_price, p.max_price, p.min_price
     FROM series s
     LEFT JOIN prices p ON p.period = s.period
     ORDER BY s.period`,
    [...params, pid]
  );

  // Vendor comparison using total_price
  const vendorComparisonQuery = db.any(
    `SELECT u.name as vendor_name, COALESCE(c.company_name, u.organization_name) as company_name,
       AVG(qi.total_price) as avg_price
     FROM tbl_quote_items qi
     JOIN tbl_quotes q ON q.id = qi.quote_id
     JOIN tbl_rfq r ON r.id = q.rfq_id AND ${companyScope()}
     JOIN tbl_users u ON u.id = q.created_by
     LEFT JOIN tbl_company c ON c.id = u.company_id
     WHERE qi.product_variant_id = $5
     AND q.timestamp BETWEEN $2 AND $3 ${hf}
     GROUP BY u.id, u.name, c.company_name, u.organization_name
     ORDER BY avg_price ASC LIMIT 5`,
    [...params, pid]
  );

  const [priceTrend, vendorComparison] = await Promise.all([priceTrendQuery, vendorComparisonQuery]);
  const bestPrice = vendorComparison.length > 0 ? parseFloat(vendorComparison[0].avg_price) : null;

  return {
    top_products: topProducts.map((p) => ({
      product_variant_id: p.product_variant_id,
      product_name: p.product_name,
      order_count: parseInt(p.order_count, 10),
    })),
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
//    Aggregates spend FIRST, then joins category to avoid row multiplication.
//    Uses a single category per product (picks the first alphabetically).
// ─────────────────────────────────────────────────────────────────────
async function getCategoryInsightsData(buyer_company_id, hotel_ids = [], start_date, end_date) {
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];

  const categories = await db.any(
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
       AND po.status NOT IN ('draft', 'cancelled') ${hf}
       GROUP BY rp.product_variant_id
     ),
     product_category AS (
       SELECT DISTINCT ON (pv.id)
         pv.id as product_variant_id,
         COALESCE(cat.title, 'Uncategorized') as category_name
       FROM tbl_product_variant pv
       LEFT JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
       LEFT JOIN tbl_category cat ON cat.id = pc.category_id
       ORDER BY pv.id, cat.title
     )
     SELECT
       COALESCE(pcg.category_name, 'Uncategorized') as category_name,
       SUM(ps.spend_amount) as spend_amount,
       SUM(ps.rfq_count) as rfq_count
     FROM product_spend ps
     LEFT JOIN product_category pcg ON pcg.product_variant_id = ps.product_variant_id
     GROUP BY pcg.category_name
     ORDER BY spend_amount DESC`,
    params
  );

  const totalSpend = categories.reduce((sum, c) => sum + parseFloat(c.spend_amount), 0);

  return {
    categories: categories.map((c) => ({
      category_name: c.category_name,
      spend_amount: parseFloat(c.spend_amount),
      rfq_count: parseInt(c.rfq_count, 10),
      percentage: totalSpend > 0
        ? parseFloat(((parseFloat(c.spend_amount) / totalSpend) * 100).toFixed(1))
        : 0,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 6. Workflow Efficiency — derived from actual table timestamps
//    Each stage duration computed from real columns, not lifecycle table.
// ─────────────────────────────────────────────────────────────────────
async function getWorkflowEfficiencyData(buyer_company_id, hotel_ids = [], start_date, end_date) {
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];

  const stages = await db.any(
    `WITH scoped_rfqs AS (
       SELECT r.id, r.timestamp as created_at, r.tender_publish_date
       FROM tbl_rfq r
       WHERE ${companyScope()} AND r.timestamp BETWEEN $2 AND $3 ${hf}
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
async function getSmartInsightsData(buyer_company_id, hotel_ids = [], start_date, end_date) {
  const hf = hotelFilter();
  const params = [buyer_company_id, start_date, end_date, hotel_ids];

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
       FROM tbl_quote_items qi2 WHERE qi2.product_variant_id = qi.product_variant_id
     ) market
     WHERE q.timestamp BETWEEN $2 AND $3 ${hf} AND market.avg_price > 0
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
     WHERE q.timestamp BETWEEN $2 AND $3 ${hf}
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
       AND po.status NOT IN ('draft', 'cancelled') ${hf}
     ),
     previous_spend AS (
       SELECT COALESCE(SUM(pop.total_price), 0) as total
       FROM tbl_rfq_purchase_order po
       JOIN tbl_purchase_order_product pop ON pop.purchase_order_id = po.id
       JOIN tbl_rfq r ON r.id = po.rfq_id
       WHERE ${companyScope()}
       AND po.created_at BETWEEN ($2::timestamp - ${periodDuration}) AND $2
       AND po.status NOT IN ('draft', 'cancelled') ${hf}
     )
     SELECT cs.total as current_spend, ps.total as previous_spend,
       CASE WHEN ps.total > 0
         THEN ROUND(((cs.total - ps.total) / ps.total * 100)::numeric, 1)
         ELSE 0
       END as change_pct
     FROM current_spend cs, previous_spend ps`,
    params
  );

  const [priceDeviations, bestVendor, spendTrend] = await Promise.all([
    priceDeviationsQuery, bestVendorQuery, spendTrendQuery,
  ]);

  const insights = [];

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
async function getPendingApprovalsDetail(buyer_company_id, user_id, start_date, end_date) {
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
       CASE WHEN i.entity_type IN ('RFQ', 'TENDER') THEN r.title ELSE NULL END as entity_title,
       CASE WHEN i.entity_type IN ('RFQ', 'TENDER') THEN r.rfq_no ELSE NULL END as entity_rfq_no,
       hch.name as hotel_name,
       (SELECT COUNT(*) FROM tbl_approval_policy_steps ps
        WHERE ps.approval_policy_id = i.approval_policy_id) as total_steps
     FROM tbl_approval_instances i
     JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
     JOIN tbl_approval_step_approvers sa ON sa.approval_instance_step_id = s.id
     LEFT JOIN tbl_rfq r ON i.entity_type IN ('RFQ','TENDER') AND r.id = i.entity_id
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
     ORDER BY i.created_at ASC`,
    [buyer_company_id, user_id, start_date, end_date]
  );
}

// ─────────────────────────────────────────────────────────────────────
// 9. Rejected POs (detail list for modal)
// ─────────────────────────────────────────────────────────────────────
async function getRejectedPOsDetail(buyer_company_id, hotel_ids = []) {
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
     GROUP BY po.id, po.rfq_id, po.status, po.created_at, po.vendor_action_at,
       r.title, r.rfq_no, u_vendor.name, c_vendor.company_name, u_vendor.organization_name, hch.name
     ORDER BY po.vendor_action_at DESC NULLS LAST`,
    [buyer_company_id, hotel_ids]
  );
}

export default {
  resolveUserScope,
  getActionCenterData,
  getProcurementSnapshotData,
  getNegotiationSavingsData,
  getCostIntelligenceData,
  getCategoryInsightsData,
  getWorkflowEfficiencyData,
  getSmartInsightsData,
  getPendingApprovalsDetail,
  getRejectedPOsDetail,
};
