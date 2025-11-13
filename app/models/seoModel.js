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

  // Fetch all locations once
  const [countries, states, cities] = await Promise.all([
    db.any(`SELECT id, country_name FROM tbl_location_country ORDER BY country_name ASC`),
    db.any(`SELECT id, state_name FROM tbl_location_states WHERE country_id = 1 ORDER BY state_name ASC`),
    db.any(`
      SELECT tlc.id, tlc.city_name, tlc.state_id, tls.state_name
      FROM tbl_location_cities tlc
      JOIN tbl_location_states tls ON tlc.state_id = tls.id
      WHERE tls.country_id = 1
      ORDER BY tlc.city_name ASC
    `)
  ]);

  // Fetch all product-vendor-location mappings in one query
  const mappings = await db.any(`
    SELECT pv.id AS product_id, pv.slug, u.country AS country_id, u.state AS state_id, u.city AS city_id
    FROM tbl_product_variant pv
    JOIN tbl_product_variant_vendor_mapping pvvm ON pvvm.product_variant_id = pv.id
    JOIN tbl_users u ON u.id = pvvm.vendor_id
    WHERE pv.slug IS NOT NULL
      AND pvvm.status = TRUE
      AND pvvm.is_approved = TRUE
      AND u.is_deleted = 0
      AND u.status = 1
    ORDER BY pv.slug
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  // Group mappings by product
  const productMap = new Map();
  for (const row of mappings) {
    const slug = row.slug.toLowerCase().trim().replace(/\s+/g, '-').replace(/-+/g, '-');
    if (!productMap.has(slug)) productMap.set(slug, { countries: new Set(), states: new Set(), cities: new Set() });
    const entry = productMap.get(slug);
    if (row.country_id) entry.countries.add(row.country_id);
    if (row.state_id) entry.states.add(row.state_id);
    if (row.city_id) entry.cities.add(row.city_id);
  }

  // Yield sitemap URLs
  for (const [slug, locs] of productMap) {
    for (const c of countries) {
      if (!locs.countries.has(c.id)) continue;
      yield `<url><loc>${baseUrl}/vendor/${slug}-${c.country_name.toLowerCase().replace(/\s+/g,'')}</loc><changefreq>weekly</changefreq><priority>0.5</priority></url>\n`;
    }
    for (const s of states) {
      if (!locs.states.has(s.id)) continue;
      yield `<url><loc>${baseUrl}/vendor/${slug}-${s.state_name.toLowerCase().replace(/\s+/g,'')}</loc><changefreq>weekly</changefreq><priority>0.5</priority></url>\n`;
    }
    for (const c of cities) {
      if (!locs.cities.has(c.id)) continue;
      yield `<url><loc>${baseUrl}/vendor/${slug}-${c.city_name.toLowerCase().replace(/\s+/g,'')}-${c.state_name.toLowerCase().replace(/\s+/g,'')}</loc><changefreq>weekly</changefreq><priority>0.5</priority></url>\n`;
    }
  }
},

getCategoryAndVariantUrls: async function* (limit = 50000, offset = 0) {
  const baseUrl = process.env.FRONTEND_URL || 'https://letsworkwise.com';

  let yielded = 0;

  // Define escapeXml inside the generator
  const escapeXml = (str) => {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  };

  // -------------------------------
  // 1️⃣ Categories
  // -------------------------------
  const categories = await db.any(`
    SELECT DISTINCT c.id, c.title, c.slug
    FROM tbl_category c
    LEFT JOIN tbl_product_categories pc ON pc.category_id = c.id
    LEFT JOIN tbl_product p ON p.id = pc.product_id
    LEFT JOIN tbl_product_variant v ON v.product_id = p.id AND v.is_approve = 1
    WHERE c.slug IS NOT NULL
      AND (p.id IS NOT NULL OR v.id IS NOT NULL)
    ORDER BY c.id
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  for (const cat of categories) {
    const slugRaw = (cat.slug || cat.title).toLowerCase().trim().replace(/\s+/g, '-');
    const slug = escapeXml(slugRaw);
    yield `<url>\n  <loc>${baseUrl}/vendor/${slug}-category${cat.id}</loc>\n  <priority>1.0</priority>\n</url>\n`;
    yielded++;
    if (yielded >= limit) return;
  }

  // -------------------------------
  // 2️⃣ Product variants
  // -------------------------------
  const variants = await db.any(`
    SELECT v.id, v.slug
    FROM tbl_product_variant v
    WHERE v.is_approve = 1
      AND v.slug IS NOT NULL
    ORDER BY v.id
    LIMIT $1 OFFSET $2
  `, [limit - yielded, 0]);

  for (const variant of variants) {
    const slugRaw = variant.slug.toLowerCase().trim().replace(/\s+/g, '-');
    const slug = escapeXml(slugRaw);
    yield `<url>\n  <loc>${baseUrl}/vendor/${slug}</loc>\n  <priority>0.8</priority>\n</url>\n`;
    yielded++;
    if (yielded >= limit) return;
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
},
getCategorySitemapTotal: async () => {
  // Count total categories with at least one product or variant
  const [{ total_categories }] = await db.any(`
    SELECT COUNT(DISTINCT c.id) AS total_categories
    FROM tbl_category c
    LEFT JOIN tbl_product_categories pc ON pc.category_id = c.id
    LEFT JOIN tbl_product p ON p.id = pc.product_id
    LEFT JOIN tbl_product_variant v ON v.product_id = p.id AND v.is_approve = 1
    WHERE c.slug IS NOT NULL
      AND (p.id IS NOT NULL OR v.id IS NOT NULL)
  `);

  // Count total approved variants
  const [{ total_variants }] = await db.any(`
    SELECT COUNT(DISTINCT v.id) AS total_variants
    FROM tbl_product_variant v
    WHERE v.is_approve = 1
      AND v.slug IS NOT NULL
  `);

  const totalUrls = parseInt(total_categories) + parseInt(total_variants);

  return { totalUrls };
}



}


export default seoModel;
