import db from "../config/dbConn.js";

export const handleGetProducts = async (search_key) => {
  return await db.tx(async t => {
    const term = (search_key || '').trim();

    if (!term) {
      // For public API, return an empty array on empty search
      return [];
    }

    const products = await t.any(
      `
      SELECT DISTINCT
        pv.id AS product_id,
        pv.name AS product_name,
        -- p.id AS product_id,
        -- p.name AS product_name,
        p.description,
        pv.slug AS slug,
        c.title AS category_name,
        c.id AS category_id,
        c.parent_id AS parent_category_id,
        similarity(pv.name, $1) AS similarity_score,
        ts_rank_cd(
          to_tsvector('english', pv.name),
          plainto_tsquery('english', $1)
        ) AS rank
      FROM tbl_product_variant pv
      JOIN tbl_product_variant_vendor_mapping pvvm
        ON pvvm.product_variant_id = pv.id
       AND pvvm.status = TRUE
       AND pvvm.is_approved = TRUE
      JOIN tbl_users u
        ON u.id = pvvm.vendor_id
      JOIN tbl_product p
        ON pv.product_id = p.id
      JOIN tbl_product_categories pc
        ON p.id = pc.product_id
      JOIN tbl_category c
        ON pc.category_id = c.id
      WHERE
        p.status = 1
        AND p.is_deleted = 0
        AND p.is_review = 0
        AND p.is_approve = 1
        AND pv.is_approve = 1
        AND (
          pv.slug = $1
          OR to_tsvector('english', pv.name)
               @@ plainto_tsquery('english', $1)
          OR similarity(pv.name, $1) > 0.1
        )
      ORDER BY
        rank DESC,
        similarity_score DESC
      LIMIT 50;
      `,
      [term]
    );

    return products;
  });
};

export const handleGetVendors = async (product_id) => {
  return await db.tx(async t => {
    const vendors = await t.any(
      `
      SELECT DISTINCT
        u.id,
        u.name,
        u.email,
        u.mobile,
        -- u.organization_name,
        -- u.subscription_plan_id,
        u.company_id,
        c.company_name,
        c.profile,
        c.location,
        c.website,
        RANDOM() AS group_rand
      FROM tbl_product_variant_vendor_mapping pvv
      JOIN tbl_product_variant pv
        ON pv.id = pvv.product_variant_id
      JOIN tbl_users u
        ON u.id = pvv.vendor_id
      LEFT JOIN tbl_company c
        ON c.id = u.company_id
      WHERE
        -- support both variant.id and variant.product_id as "product_id" for the API
        (pv.id = $1 OR pv.product_id = $1)
        AND pv.is_deleted = 0
        AND pv.status = 1
        AND pv.is_approve = 1
        AND pvv.status = TRUE
        AND pvv.is_approved = TRUE
        AND u.status = 1
        AND u.is_deleted = 0
        AND c.is_private = 0
      ORDER BY
        group_rand,
        c.company_name,
        u.name ASC

      LIMIT 5
      `,
      [product_id]
    );

    return vendors;
  });
};

export const handleAddPublicUsers = async (userData) => {
  const {
    username,
    email,
    mobile,
    company_name,
    platform,
    element
  } = userData;

  return db.tx(async (t) => {
    const query = `
      INSERT INTO tbl_public_users (
        username,
        email,
        mobile,
        created_at,
        company_name,
        platform,
        element
      )
      VALUES ($1, $2, $3, NOW(), $4, $5, $6)
      RETURNING 
        id,
        username,
        email,
        mobile,
        company_name,
        platform,
        element,
        created_at;
    `;

    const values = [
      username,
      email,
      mobile,
      company_name,
      platform,
      element
    ];

    const newUser = await t.one(query, values);
    return newUser;
  });
};


export const fetchPublicUsers = async ({
  page = 1,
  limit = 10,
  startDate = null,
  endDate = null,
  search = ""
}) => {

  const offset = (page - 1) * limit;
  let whereClauses = ["1=1"];
  const params = [];

  // Date filter
  if (startDate && endDate) {
    params.push(startDate, endDate);
    whereClauses.push(`created_at BETWEEN $${params.length - 1} AND $${params.length}`);
  }

  // Optional search (by name, email, company)
  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    whereClauses.push(
      `(username ILIKE $${idx} OR email ILIKE $${idx} OR company_name ILIKE $${idx})`
    );
  }

  // Pagination params
  params.push(limit, offset);

  const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const dataQuery = `
    SELECT 
      id,
      username,
      email,
      mobile,
      company_name,
      platform,
      element,
      created_at
    FROM tbl_public_users
    ${whereSQL}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length};
  `;

  const countQuery = `
    SELECT COUNT(*) AS total_items
    FROM tbl_public_users
    ${whereSQL};
  `;

  try {
    const [data, totalResult] = await Promise.all([
      db.any(dataQuery, params),
      db.one(countQuery, params.slice(0, params.length - 2)) // count query uses only filters
    ]);

    const totalItems = Number(totalResult.total_items);
    const totalPages = Math.ceil(totalItems / limit);

    return {
      data,
      pagination: {
        current_page: page,
        items_per_page: limit,
        total_items: totalItems,
        total_pages: totalPages,
        has_next: page < totalPages,
        has_prev: page > 1
      }
    };

  } catch (err) {
    throw new Error(err.message || err);
  }
};
