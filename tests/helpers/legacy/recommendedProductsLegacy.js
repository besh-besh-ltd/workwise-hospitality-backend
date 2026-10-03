// FROZEN ORACLE — do not edit, do not import from production code.
//
// Verbatim copy of rfqModel.getRecommendedProducts as it stood on origin/main (719ba386) before
// the perf rewrite (portal perf plan 2026-10). The equivalence suite runs this
// and the live implementation against the same seeded data and requires the
// same rows in the same order, so the rewrite can be proven a pure
// optimisation. If you deliberately change the production behaviour, update
// the assertion in the suite rather than this file.

import db from "../../../app/config/dbConn.js";

const legacy = {
  getRecommendedProducts: async ({ user_id, hotel_ids = [], staged_variant_ids = [], limit = 5 }) => {
    if (!Array.isArray(hotel_ids) || hotel_ids.length === 0) {
      return [];
    }

    const params = [user_id, hotel_ids];
    let pIdx = 3;

    const stagedParam = staged_variant_ids.length > 0
      ? `$${pIdx++}::int[]`
      : null;
    if (staged_variant_ids.length > 0) params.push(staged_variant_ids);

    const limitParam = `$${pIdx++}`;
    params.push(limit);

    const stagedCategoriesCte = stagedParam
      ? `staged_categories AS (
           SELECT DISTINCT pc.category_id
           FROM tbl_product_variant pv
           JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
           WHERE pv.id = ANY(${stagedParam})
         ),`
      : `staged_categories AS (
           SELECT NULL::bigint AS category_id WHERE FALSE
         ),`;

    const stagedExcludeClause = stagedParam
      ? `AND pv.id <> ALL(${stagedParam})`
      : '';

    const q = `
      WITH
      -- Eligible vendors for the requested hotels (active or expired subs)
      eligible_hotel_vendors AS (
        SELECT DISTINCT s.vendor_id
        FROM tbl_vendor_hotel_category_subscription s
        WHERE s.item_type = 'hotel'
          AND s.item_id = ANY($2)
          AND s.status IN ('active', 'expired')
      ),

      -- User's previous variants from their own RFQs (last 24 months window)
      user_history_variants AS (
        SELECT rp.product_variant_id AS variant_id, COUNT(*)::int AS history_count
        FROM tbl_rfq_products rp
        JOIN tbl_rfq r ON r.id = rp.rfq_id
        WHERE r.created_by = $1
          AND r.timestamp > NOW() - INTERVAL '24 months'
        GROUP BY rp.product_variant_id
      ),

      -- Categories from currently staged variants (to find similar items)
      ${stagedCategoriesCte}

      -- Platform-wide popularity (last 12 months) — fallback when no signal
      popular_variants AS (
        SELECT rp.product_variant_id AS variant_id, COUNT(*)::int AS popularity
        FROM tbl_rfq_products rp
        JOIN tbl_rfq r ON r.id = rp.rfq_id
        WHERE r.timestamp > NOW() - INTERVAL '12 months'
        GROUP BY rp.product_variant_id
      ),

      -- Candidate variants: must have at least one eligible vendor for selected hotels
      candidate_variants AS (
        SELECT DISTINCT
          pv.id AS variant_id,
          pv.product_id,
          pv.name AS variant_name,
          pv.slug,
          p.name AS product_name,
          p.description
        FROM tbl_product_variant pv
        JOIN tbl_product p ON p.id = pv.product_id
        JOIN tbl_product_variant_vendor_mapping pvvm ON pvvm.product_variant_id = pv.id
        JOIN eligible_hotel_vendors ehv ON ehv.vendor_id = pvvm.vendor_id
        WHERE p.status = 1
          AND p.is_deleted = 0
          AND p.is_review = 0
          AND p.is_approve = 1
          AND pv.is_approve = 1
          AND pvvm.status = TRUE
          AND pvvm.is_approved = TRUE
          ${stagedExcludeClause}
      ),

      -- Vendor count per variant scoped to the selected hotels (active or expired)
      vendor_counts AS (
        SELECT pvvm.product_variant_id AS variant_id,
               COUNT(DISTINCT pvvm.vendor_id)::int AS vendor_count
        FROM tbl_product_variant_vendor_mapping pvvm
        JOIN eligible_hotel_vendors ehv ON ehv.vendor_id = pvvm.vendor_id
        WHERE pvvm.status = TRUE AND pvvm.is_approved = TRUE
        GROUP BY pvvm.product_variant_id
      ),

      -- Per-variant category info (one row per variant, picks first category)
      variant_category AS (
        SELECT DISTINCT ON (pc.product_id)
          pc.product_id,
          c.id AS category_id,
          c.title AS category_name
        FROM tbl_product_categories pc
        JOIN tbl_category c ON c.id = pc.category_id
        WHERE c.is_deleted = 0
        ORDER BY pc.product_id, c.id
      ),

      scored AS (
        SELECT
          cv.variant_id,
          cv.product_id,
          cv.variant_name,
          cv.product_name,
          cv.description,
          cv.slug,
          vcat.category_id,
          vcat.category_name,
          COALESCE(vc.vendor_count, 0) AS vendor_count,
          -- Personalization: 100 base, +20 per past use (max 200)
          CASE WHEN uh.history_count > 0 THEN 100 + LEAST(uh.history_count * 20, 100) ELSE 0 END AS user_history_score,
          -- Category match with staged: flat 50 if matches
          CASE WHEN sc.category_id IS NOT NULL THEN 50 ELSE 0 END AS category_match_score,
          -- Popularity: log-scaled (0–30 typical)
          COALESCE(LEAST(pv_pop.popularity, 30), 0) AS popularity_score
        FROM candidate_variants cv
        LEFT JOIN vendor_counts vc ON vc.variant_id = cv.variant_id
        LEFT JOIN variant_category vcat ON vcat.product_id = cv.product_id
        LEFT JOIN user_history_variants uh ON uh.variant_id = cv.variant_id
        LEFT JOIN popular_variants pv_pop ON pv_pop.variant_id = cv.variant_id
        LEFT JOIN staged_categories sc ON sc.category_id = vcat.category_id
      )

      SELECT
        variant_id,
        product_id,
        variant_name,
        product_name,
        description,
        slug,
        category_id,
        category_name,
        vendor_count,
        (user_history_score + category_match_score + popularity_score) AS score
      FROM scored
      WHERE vendor_count > 0
      ORDER BY
        score DESC,
        user_history_score DESC,
        popularity_score DESC,
        product_name ASC
      LIMIT ${limitParam};
    `;

    return new Promise((resolve, reject) => {
      db.query(q, params)
        .then((data) => resolve(data))
        .catch((err) => reject(new Error(err)));
    });
  }
};

export const getRecommendedProductsLegacy = legacy.getRecommendedProducts;
