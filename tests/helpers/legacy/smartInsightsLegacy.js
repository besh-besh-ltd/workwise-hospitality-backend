// FROZEN ORACLE — do not edit, do not import from production code.
//
// Verbatim copy of dashboardModel.getSmartInsightsData and the private scope
// helpers it uses, as they stood on origin/main (719ba386) before the scoped-
// CTE rewrite (portal perf plan 2026-10, item 1.2). The only addition is the
// `unlimited` option, which removes the LIMITs so the parity suite can check
// that the rewrite picks its rows from exactly the same candidate set.

import db from "../../../app/config/dbConn.js";
import { buildScopeExistsClause } from "../../../app/services/authorizationService.js";

function companyScope(alias = 'r') {
  return `${alias}.hospitality_company_id IN (SELECT id FROM tbl_hospitality_companies WHERE buyer_company_id = $1)`;
}

function hotelFilter(alias = 'r', paramIdx = 4) {
  return `AND EXISTS (SELECT 1 FROM tbl_rfq_hotel_mappings rhm WHERE rhm.rfq_id = ${alias}.id AND rhm.hotel_id = ANY($${paramIdx}))`;
}

const RFQ_SCOPE_PERMISSIONS = ['rfq.read', 'boq.read', 'awarding.read'];

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

async function getSmartInsightsData(buyer_company_id, user_id, hotel_ids = [], start_date, end_date, { unlimited = false } = {}) {
  // ORACLE-ONLY knob: `unlimited` drops the LIMITs so the suite can see every
  // candidate row the old SQL would have chosen from. Off = verbatim behaviour.
  const L = (n) => (unlimited ? '' : `LIMIT ${n}`);
  const one = unlimited ? db.any.bind(db) : db.oneOrNone.bind(db);
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
     ${L(3)}`,
    params
  );

  const bestVendorQuery = one(
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
     ORDER BY best_price_count DESC ${L(1)}`,
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
     ${L(3)}`,
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

  if (bestVendor && !unlimited) {
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

  if (unlimited) return { insights, raw: { priceDeviations, bestVendor, spendTrend, benchmarkDeviations } };
  return { insights };
}

export const getSmartInsightsDataLegacy = getSmartInsightsData;
