// FROZEN ORACLE — do not edit, do not import from production code.
//
// Verbatim copy of rfqModel.searchProduct as it stood on origin/main (719ba386) before
// the perf rewrite (portal perf plan 2026-10). The equivalence suite runs this
// and the live implementation against the same seeded data and requires the
// same rows in the same order, so the rewrite can be proven a pure
// optimisation. If you deliberately change the production behaviour, update
// the assertion in the suite rather than this file.

import db from "../../../app/config/dbConn.js";

const legacy = {
  searchProduct: async (
    search_key,
    category_id,
    approved_by_id,
    _locationFilters = {},
    hotel_ids = []
  ) => {
    const normalizedSearchKey = (search_key || '').trim();
    const isSearchAll = normalizedSearchKey.toLowerCase() === 'all';

    const params = [normalizedSearchKey];
    let paramIdx = 2;

    const categoryParam = category_id ? `$${paramIdx++}` : null;
    if (category_id) params.push(category_id);

    const approvedByParam = approved_by_id ? `$${paramIdx++}` : null;
    if (approved_by_id) params.push(approved_by_id);

    let hotelIdsParam = null;
    if (Array.isArray(hotel_ids) && hotel_ids.length > 0) {
      hotelIdsParam = `$${paramIdx++}`;
      params.push(hotel_ids);
    }

    const candidateLimitParam = `$${paramIdx++}`;
    params.push(isSearchAll ? 500 : 200);

    const searchCondition = isSearchAll
      ? 'TRUE'
      : `(
          pv.slug = $1
          OR to_tsvector('english', pv.name) @@ plainto_tsquery('english', $1)
          OR to_tsvector('english', p.name) @@ plainto_tsquery('english', $1)
          OR similarity(pv.name, $1) > 0.1
          OR similarity(p.name, $1) > 0.1
        )`;

    // Include vendors with active OR expired subscriptions in vendor count.
    // Expired vendors are included in RFQs but blocked from actions until they renew.
    const vendorCountCte = hotelIdsParam
      ? `
      vendor_counts AS (
        SELECT pvvm.product_variant_id AS variant_id,
               pc.category_id,
               COUNT(DISTINCT pvvm.vendor_id)::int AS vendor_count
        FROM tbl_product_variant_vendor_mapping pvvm
        JOIN matched_variants mv ON mv.variant_id = pvvm.product_variant_id
        JOIN product_categories pc ON pc.product_id = mv.product_id
        JOIN tbl_vendor_hotel_category_subscription vhcs_cat
          ON vhcs_cat.vendor_id = pvvm.vendor_id
          AND vhcs_cat.item_type = 'category'
          AND vhcs_cat.item_id = pc.category_id
          AND vhcs_cat.status IN ('active', 'expired')
        JOIN tbl_vendor_hotel_category_subscription vhcs_hotel
          ON vhcs_hotel.vendor_id = pvvm.vendor_id
          AND vhcs_hotel.item_type = 'hotel'
          AND vhcs_hotel.item_id = ANY(${hotelIdsParam})
          AND vhcs_hotel.status IN ('active', 'expired')
        WHERE pvvm.status = TRUE
          AND pvvm.is_approved = TRUE
        GROUP BY pvvm.product_variant_id, pc.category_id
      )`
      : `
      vendor_counts AS (
        SELECT pvvm.product_variant_id AS variant_id,
               NULL::bigint AS category_id,
               COUNT(DISTINCT pvvm.vendor_id)::int AS vendor_count
        FROM tbl_product_variant_vendor_mapping pvvm
        JOIN matched_variants mv ON mv.variant_id = pvvm.product_variant_id
        WHERE pvvm.status = TRUE
          AND pvvm.is_approved = TRUE
        GROUP BY pvvm.product_variant_id
      )`;

    const q = `
      WITH matched_variants AS (
        SELECT pv.id AS variant_id,
               pv.product_id,
               pv.name AS variant_name,
               pv.slug,
               p.name AS product_name,
               p.description,
               CONCAT(pv.name, ' - ', p.name) AS unified_name,
               ${
                 isSearchAll
                   ? '0::float AS similarity_score, 0::float AS rank'
                   : `GREATEST(
                        similarity(pv.name, $1),
                        similarity(p.name, $1)
                      ) AS similarity_score,
                      GREATEST(
                        ts_rank_cd(to_tsvector('english', pv.name), plainto_tsquery('english', $1)),
                        ts_rank_cd(to_tsvector('english', p.name), plainto_tsquery('english', $1))
                      ) AS rank`
               }
        FROM tbl_product_variant pv
        JOIN tbl_product p ON pv.product_id = p.id
        WHERE p.status = 1
          AND p.is_deleted = 0
          AND p.is_review = 0
          AND p.is_approve = 1
          AND pv.is_approve = 1
          AND ${searchCondition}
        ORDER BY
          CASE WHEN pv.slug = $1 THEN 0 ELSE 1 END,
          rank DESC,
          similarity_score DESC,
          pv.id ASC
        LIMIT ${candidateLimitParam}
      ),
      product_categories AS (
        SELECT pc.product_id,
               c.id AS category_id,
               c.title AS category_name,
               c.parent_id
        FROM tbl_product_categories pc
        JOIN tbl_category c ON c.id = pc.category_id
        ${categoryParam ? `WHERE c.id = ${categoryParam}` : ''}
      ),
      ${vendorCountCte}
      SELECT *
      FROM (
        SELECT DISTINCT
               mv.product_id,
               mv.product_name,
               mv.unified_name,
               mv.variant_id,
               mv.variant_name,
               mv.description,
               mv.slug,
               pc.category_name,
               pc.category_id,
               pc.parent_id AS parent_category_id,
               img.new_image_name AS image_url,
               COALESCE(vc.vendor_count, 0) AS vendor_count,
               mv.similarity_score,
               mv.rank
        FROM matched_variants mv
        JOIN product_categories pc ON pc.product_id = mv.product_id
        LEFT JOIN LATERAL (
          SELECT tpi.new_image_name
          FROM tbl_product_images tpi
          WHERE tpi.product_id = mv.product_id
          LIMIT 1
        ) img ON TRUE
        LEFT JOIN vendor_counts vc
          ON vc.variant_id = mv.variant_id
         ${hotelIdsParam ? 'AND vc.category_id = pc.category_id' : ''}
        ${
          approvedByParam
            ? `WHERE EXISTS (
                SELECT 1
                FROM tbl_vendorapprove_product_mapping vum
                WHERE vum.product_id = mv.product_id
                  AND (vum.vendor_approve_id = ${approvedByParam} OR vum.vendor_approve_id IS NULL)
              )`
            : ''
        }
      ) ranked_results
      ORDER BY
        CASE WHEN ranked_results.slug = $1 THEN 0 ELSE 1 END,
        ranked_results.rank DESC,
        ranked_results.similarity_score DESC,
        ranked_results.unified_name ASC;
    `;

    return new Promise(function (resolve, reject) {
      db.query(q, params)
        .then(function (data) {
          resolve(data);
        })
        .catch(function (err) {
          let error = new Error(err);
          reject(error);
        });
    });
  }
};

export const searchProductLegacy = legacy.searchProduct;
