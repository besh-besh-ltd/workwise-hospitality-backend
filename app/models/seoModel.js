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

    // Generate vendor sitemap URL parts efficiently without large DB joins
    // Strategy: Determine how many rows each product contributes, compute the product slice
    // needed for the requested global offset/limit, fetch only that small product slice,
    // then construct URLs in memory using pre-fetched states and cities.
    vendorSitemapUrls: async (limit = 50000, offset = 0) => {
      // 1) Get total states and total cities (for per-product row count)
      const [states, cities] = await Promise.all([
        db.any(`SELECT id, state_name FROM tbl_location_states ORDER BY state_name ASC`),
        db.any(`SELECT tlc.city_name, tlc.state_id, tls.state_name FROM tbl_location_cities tlc JOIN tbl_location_states tls ON tlc.state_id = tls.id ORDER BY tlc.city_name ASC`)
      ]);

      const statesCount = states.length;
      const totalCities = cities.length;
      const rowsPerProduct = statesCount + totalCities;
      if (rowsPerProduct === 0) return [];

      // 2) Compute which products are needed for this page
      const startIndex = offset; // global start
      const endIndexExclusive = offset + limit; // global end (exclusive)
      const firstProductIndex = Math.floor(startIndex / rowsPerProduct);
      const lastProductIndexInclusive = Math.floor((endIndexExclusive - 1) / rowsPerProduct);
      const productCountNeeded = Math.max(1, lastProductIndexInclusive - firstProductIndex + 1);

      // 3) Fetch only the required product slugs (approved & active vendors)
      const productSlugs = await db.any(
        `SELECT pv.slug
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
        [productCountNeeded, firstProductIndex]
      );

      // 4) Build only the required range within these products
      const results = [];
      let produced = 0;

      for (let i = 0; i < productSlugs.length; i++) {
        const productGlobalStart = (firstProductIndex + i) * rowsPerProduct;
        const productLocalStartOffset = Math.max(0, startIndex - productGlobalStart);
        const productLocalEndExclusive = Math.min(rowsPerProduct, endIndexExclusive - productGlobalStart);
        if (productLocalStartOffset >= productLocalEndExclusive) continue;

        const slug = productSlugs[i].slug;

        // a) States segment covers indices [0, statesCount)
        const stateStart = Math.max(0, productLocalStartOffset);
        const stateEnd = Math.min(statesCount, productLocalEndExclusive);
        for (let s = stateStart; s < stateEnd; s++) {
          results.push({
            loc: `/vendor/${slug}-${states[s].state_name}`,
            changefreq: 'weekly',
            priority: 0.5
          });
          produced++;
          if (produced >= limit) return results;
        }

        // b) Cities segment covers indices [statesCount, statesCount + totalCities)
        const citySegmentStart = Math.max(statesCount, productLocalStartOffset);
        const cityLocalStart = Math.max(0, citySegmentStart - statesCount);
        const cityLocalEndExclusive = Math.min(totalCities, productLocalEndExclusive - statesCount);
        for (let c = cityLocalStart; c < cityLocalEndExclusive; c++) {
          results.push({
            loc: `/vendor/${slug}-${cities[c].city_name}-${cities[c].state_name}`,
            changefreq: 'weekly',
            priority: 0.5
          });
          produced++;
          if (produced >= limit) return results;
        }
      }

      return results;
    }
}


export default seoModel;
