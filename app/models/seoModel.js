import db from '../config/dbConn.js';

const seoModel = {
    productSlugSitemap: async (limit = 50000, offset = 0) => {
      // Run count and data queries in parallel for lower latency (async/await)
      const countQuery = `
        SELECT COUNT(*) as total
        FROM tbl_product_variant pv
        WHERE pv.slug IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM tbl_product_variant_vendor_mapping pvvm
            WHERE pvvm.product_variant_id = pv.id
              AND pvvm.status = TRUE
              AND pvvm.is_approved = TRUE
          )
      `;

      const dataQuery = `
        SELECT pv.slug
        FROM tbl_product_variant pv
        WHERE pv.slug IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM tbl_product_variant_vendor_mapping pvvm
            WHERE pvvm.product_variant_id = pv.id
              AND pvvm.status = TRUE
              AND pvvm.is_approved = TRUE
          )
        LIMIT $1 OFFSET $2
      `;

      const [countResult, data] = await Promise.all([
        db.one(countQuery),
        db.any(dataQuery, [limit, offset])
      ]);

      return {
        productSlugList: data,
        total: parseInt(countResult.total)
      };
    },

    // Generate vendor sitemap URL parts ensuring each URL has at least one vendor
    // for the specific location filters (state/city). We prefetch India states/cities
    // and, per product variant, compute the set of available state_ids and city_ids
    // from active, approved vendors.
    vendorSitemapUrls: async function* (limit = 50000, offset = 0) {
      const baseUrl = process.env.FRONTEND_URL || 'https://letsworkwise.com';

      // Fetch countries, states and cities once
      const [countries, states, cities] = await Promise.all([
        db.any(`
          SELECT id, country_name
          FROM tbl_location_country
          ORDER BY country_name ASC
        `),
        db.any(`
          SELECT id, state_name 
          FROM tbl_location_states 
          WHERE country_id = 1
          ORDER BY state_name ASC
        `),
        db.any(`
          SELECT tlc.id, tlc.city_name, tlc.state_id, tls.state_name
          FROM tbl_location_cities tlc
          JOIN tbl_location_states tls ON tlc.state_id = tls.id
          WHERE tls.country_id = 1
          ORDER BY tlc.city_name ASC
        `)
      ]);

      // Iterate products in batches and produce filtered URLs with global offset/limit handling
      const productBatchSize = 200; // moderate batch to control memory and DB load
      let productOffset = 0;
      let yielded = 0;
      let skipped = 0;

      while (yielded < limit) {
        const products = await db.any(
          `SELECT pv.id, pv.slug
           FROM tbl_product_variant pv
           WHERE pv.slug IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM tbl_product_variant_vendor_mapping pvvm
               WHERE pvvm.product_variant_id = pv.id
                 AND pvvm.status = TRUE
                 AND pvvm.is_approved = TRUE
             )
           ORDER BY pv.slug
           LIMIT $1 OFFSET $2`,
          [productBatchSize, productOffset]
        );

        if (!products.length) break; // no more products

        for (const p of products) {
          // Normalize product slug to avoid stray spaces around hyphens in URLs
          const productSlug = (p.slug || '')
            .toLowerCase()
            .trim()
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-');
          // For each product, determine available states and cities where at least one vendor exists
          const [availableCountries, availableStates, availableCities] = await Promise.all([
            db.any(
              `SELECT DISTINCT u.country::int AS country_id
               FROM tbl_product_variant_vendor_mapping pvvm
               JOIN tbl_users u ON u.id = pvvm.vendor_id
               WHERE pvvm.product_variant_id = $1
                 AND pvvm.status = TRUE AND pvvm.is_approved = TRUE
                 AND u.is_deleted = 0 AND u.status = 1
                 AND u.country IS NOT NULL
              `,
              [p.id]
            ),
            db.any(
              `SELECT DISTINCT u.state AS state_id
               FROM tbl_product_variant_vendor_mapping pvvm
               JOIN tbl_users u ON u.id = pvvm.vendor_id
               WHERE pvvm.product_variant_id = $1
                 AND pvvm.status = TRUE AND pvvm.is_approved = TRUE
                 AND u.is_deleted = 0 AND u.status = 1
                 AND u.state IS NOT NULL
              `,
              [p.id]
            ),
            db.any(
              `SELECT DISTINCT u.city AS city_id
               FROM tbl_product_variant_vendor_mapping pvvm
               JOIN tbl_users u ON u.id = pvvm.vendor_id
               WHERE pvvm.product_variant_id = $1
                 AND pvvm.status = TRUE AND pvvm.is_approved = TRUE
                 AND u.is_deleted = 0 AND u.status = 1
                 AND u.city IS NOT NULL
              `,
              [p.id]
            )
          ]);

          const availableCountryIds = new Set(availableCountries.map(s => s.country_id));
          const availableStateIds = new Set(availableStates.map(s => s.state_id));
          const availableCityIds = new Set(availableCities.map(c => c.city_id));

          // Emit country URLs that have at least one vendor
          for (const k of countries) {
            if (!availableCountryIds.has(k.id)) continue;
            if (skipped < offset) {
              skipped++;
              continue;
            }
            const countrySlug = (k.country_name || '').toLowerCase().replace(/\s+/g, '');
            yield `<url>\n  <loc>${baseUrl}/vendor/${productSlug}-${countrySlug}</loc>\n  <changefreq>weekly</changefreq>\n  <priority>0.5</priority>\n</url>\n`;
            yielded++;
            if (yielded >= limit) return;
          }

          // Emit state URLs that have at least one vendor
          for (const s of states) {
            if (!availableStateIds.has(s.id)) continue;
            if (skipped < offset) {
              skipped++;
              continue;
            }
            const stateSlug = (s.state_name || '').toLowerCase().replace(/\s+/g, '');
            yield `<url>\n  <loc>${baseUrl}/vendor/${productSlug}-${stateSlug}</loc>\n  <changefreq>weekly</changefreq>\n  <priority>0.5</priority>\n</url>\n`;
            yielded++;
            if (yielded >= limit) return;
          }

          // Emit city URLs that have at least one vendor
          for (const c of cities) {
            if (!availableCityIds.has(c.id)) continue;
            if (skipped < offset) {
              skipped++;
              continue;
            }
            const citySlug = (c.city_name || '').toLowerCase().replace(/\s+/g, '');
            const stateSlug = (c.state_name || '').toLowerCase().replace(/\s+/g, '');
            yield `<url>\n  <loc>${baseUrl}/vendor/${productSlug}-${citySlug}-${stateSlug}</loc>\n  <changefreq>weekly</changefreq>\n  <priority>0.5</priority>\n</url>\n`;
            yielded++;
            if (yielded >= limit) return;
          }
        }

        productOffset += products.length;
      }
    },
getVendorSitemapTotal: async () => {
  // Count only product-location combinations that actually have at least one vendor
  const [{ eligible_countries_count }] = await db.any(`
    SELECT COUNT(*) AS eligible_countries_count
    FROM (
      SELECT pv.id AS product_variant_id, lcn.id AS country_id
      FROM tbl_product_variant pv
      JOIN tbl_product_variant_vendor_mapping pvvm_check ON pvvm_check.product_variant_id = pv.id
      JOIN tbl_users u_check ON u_check.id = pvvm_check.vendor_id
      JOIN tbl_location_country lcn ON u_check.country::int = lcn.id
      WHERE pv.slug IS NOT NULL
        AND pvvm_check.status = TRUE AND pvvm_check.is_approved = TRUE
        AND u_check.is_deleted = 0 AND u_check.status = 1
        AND u_check.country IS NOT NULL
      GROUP BY pv.id, lcn.id
    ) t
  `);

  const [{ eligible_states_count }] = await db.any(`
    SELECT COUNT(*) AS eligible_states_count
    FROM (
      SELECT pv.id AS product_variant_id, tls.id AS state_id
      FROM tbl_product_variant pv
      CROSS JOIN tbl_location_states tls
      WHERE tls.country_id = 1 AND pv.slug IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM tbl_product_variant_vendor_mapping pvvm
        JOIN tbl_users u ON u.id = pvvm.vendor_id
        WHERE pvvm.product_variant_id = pv.id
          AND pvvm.status = TRUE AND pvvm.is_approved = TRUE
          AND u.is_deleted = 0 AND u.status = 1
          AND u.state IS NOT NULL
          AND u.state = tls.id
      )
    ) t
  `);

  const [{ eligible_cities_count }] = await db.any(`
    SELECT COUNT(*) AS eligible_cities_count
    FROM (
      SELECT pv.id AS product_variant_id, tlc.id AS city_id
      FROM tbl_product_variant pv
      JOIN tbl_product_variant_vendor_mapping pvvm_check ON pvvm_check.product_variant_id = pv.id
      JOIN tbl_users u_check ON u_check.id = pvvm_check.vendor_id
      JOIN tbl_location_cities tlc ON u_check.city = tlc.id
      JOIN tbl_location_states tls ON tlc.state_id = tls.id
      WHERE pv.slug IS NOT NULL
        AND pvvm_check.status = TRUE AND pvvm_check.is_approved = TRUE
        AND u_check.is_deleted = 0 AND u_check.status = 1
        AND u_check.city IS NOT NULL
        AND tls.country_id = 1
      GROUP BY pv.id, tlc.id
    ) t
  `);

  const totalUrls = parseInt(eligible_countries_count) + parseInt(eligible_states_count) + parseInt(eligible_cities_count);

  return {
    totalUrls
  };
}


}


export default seoModel;
