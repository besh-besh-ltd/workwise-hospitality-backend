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
 // Assuming db is a configured database client (e.g., pg-promise)
 vendorSitemapUrls: async function* (limit = 50000, offset = 0) {
  // 1) Get only states and cities for India (country_id = 1)
  const [states, cities] = await Promise.all([
    db.any(`
      SELECT id, state_name 
      FROM tbl_location_states 
      WHERE country_id = 1
      ORDER BY state_name ASC
    `),
    db.any(`
      SELECT tlc.city_name, tlc.state_id, tls.state_name
      FROM tbl_location_cities tlc
      JOIN tbl_location_states tls ON tlc.state_id = tls.id
      WHERE tls.country_id = 1
      ORDER BY tlc.city_name ASC
    `)
  ]);

  const statesCount = states.length;
  const totalCities = cities.length;
  const rowsPerProduct = statesCount + totalCities;
  if (rowsPerProduct === 0) return;

  // 2) Compute which products are needed for this page
  const startIndex = offset;
  const endIndexExclusive = offset + limit;
  const firstProductIndex = Math.floor(startIndex / rowsPerProduct);
  const lastProductIndexInclusive = Math.floor((endIndexExclusive - 1) / rowsPerProduct);
  const productCountNeeded = Math.max(1, lastProductIndexInclusive - firstProductIndex + 1);

  // 3) Fetch only the required product slugs
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

  // 4) Generate URLs one at a time
  let produced = 0;
  const baseUrl = process.env.FRONTEND_URL || 'https://letsworkwise.com';

  for (let i = 0; i < productSlugs.length; i++) {
    const productGlobalStart = (firstProductIndex + i) * rowsPerProduct;
    const productLocalStartOffset = Math.max(0, startIndex - productGlobalStart);
    const productLocalEndExclusive = Math.min(rowsPerProduct, endIndexExclusive - productGlobalStart);
    if (productLocalStartOffset >= productLocalEndExclusive) continue;

    const slug = productSlugs[i].slug;

    // a) States segment
    const stateStart = Math.max(0, productLocalStartOffset);
    const stateEnd = Math.min(statesCount, productLocalEndExclusive);
    for (let s = stateStart; s < stateEnd; s++) {
      yield `<url>
  <loc>${baseUrl}/vendor/${slug}-${states[s].state_name}</loc>
  <changefreq>weekly</changefreq>
  <priority>0.5</priority>
</url>\n`;
      produced++;
      if (produced >= limit) return;
    }

    // b) Cities segment
    const citySegmentStart = Math.max(statesCount, productLocalStartOffset);
    const cityLocalStart = Math.max(0, citySegmentStart - statesCount);
    const cityLocalEndExclusive = Math.min(totalCities, productLocalEndExclusive - statesCount);
    for (let c = cityLocalStart; c < cityLocalEndExclusive; c++) {
      yield `<url>
  <loc>${baseUrl}/vendor/${slug}-${cities[c].city_name}-${cities[c].state_name}</loc>
  <changefreq>weekly</changefreq>
  <priority>0.5</priority>
</url>\n`;
      produced++;
      if (produced >= limit) return;
    }
  }
},
getVendorSitemapTotal: async () => {
  const [{ total_products }] = await db.any(`
    SELECT COUNT(*) AS total_products
    FROM tbl_product_variant pv
    WHERE pv.slug IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM tbl_product_variant_vendor_mapping pvvm
        WHERE pvvm.product_variant_id = pv.id
          AND pvvm.status = TRUE
          AND pvvm.is_approved = TRUE
      )
  `);

  const [{ states_count }] = await db.any(`
    SELECT COUNT(*) AS states_count 
    FROM tbl_location_states 
    WHERE country_id = 1
  `);

  const [{ cities_count }] = await db.any(`
    SELECT COUNT(*) AS cities_count
    FROM tbl_location_cities tlc
    JOIN tbl_location_states tls ON tlc.state_id = tls.id
    WHERE tls.country_id = 1
  `);

  const rowsPerProduct = parseInt(states_count) + parseInt(cities_count);
  const totalProducts = parseInt(total_products);

  return {
    totalUrls: totalProducts * rowsPerProduct,
    rowsPerProduct,
    totalProducts
  };
}


}


export default seoModel;
