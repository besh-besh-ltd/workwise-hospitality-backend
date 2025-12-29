import db, { pgp } from '../config/dbConn.js';

const hospitalityModel = {
  createCompany: async (companyObj) => {
    return db.one(
      `INSERT INTO tbl_hospitality_companies
        (buyer_company_id, name, region, contact_email, registered_office_address, 
         corporate_office_address, gst, pan, bank_account_number, bank_name, 
         ifsc_code, account_holder_name, msme, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
       RETURNING *`,
      [
        companyObj.buyer_company_id,
        companyObj.name,
        companyObj.region,
        companyObj.contact_email,
        companyObj.registered_office_address || null,
        companyObj.corporate_office_address || null,
        companyObj.gst || null,
        companyObj.pan || null,
        companyObj.bank_account_number || null,
        companyObj.bank_name || null,
        companyObj.ifsc_code || null,
        companyObj.account_holder_name || null,
        companyObj.msme || null,
        companyObj.created_by
      ]
    );
  },

  updateCompany: async (companyId, companyObj, buyerCompanyId) => {
    return db.one(
      `UPDATE tbl_hospitality_companies
       SET name = $1,
           region = $2,
           contact_email = $3,
           registered_office_address = $4,
           corporate_office_address = $5,
           gst = $6,
           pan = $7,
           bank_account_number = $8,
           bank_name = $9,
           ifsc_code = $10,
           account_holder_name = $11,
           msme = $12,
           updated_by = $13,
           updated_at = NOW()
       WHERE id = $14 AND buyer_company_id = $15 AND is_deleted = 0
       RETURNING *`,
      [
        companyObj.name,
        companyObj.region,
        companyObj.contact_email,
        companyObj.registered_office_address || null,
        companyObj.corporate_office_address || null,
        companyObj.gst || null,
        companyObj.pan || null,
        companyObj.bank_account_number || null,
        companyObj.bank_name || null,
        companyObj.ifsc_code || null,
        companyObj.account_holder_name || null,
        companyObj.msme || null,
        companyObj.updated_by,
        companyId,
        buyerCompanyId
      ]
    );
  },

  getCompaniesByBuyer: async (buyerCompanyId) => {
    return db.any(
      `SELECT 
        hc.*,
        COALESCE(hotel_stats.total_hotels, 0) AS total_hotels
       FROM tbl_hospitality_companies hc
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS total_hotels
         FROM tbl_hospitality_company_hotels hh
         WHERE hh.hospitality_company_id = hc.id
           AND hh.is_deleted = 0
       ) AS hotel_stats ON true
       WHERE hc.buyer_company_id = $1
         AND hc.is_deleted = 0
       ORDER BY hc.created_at DESC`,
      [buyerCompanyId]
    );
  },

  getCompanyById: async (companyId) => {
    return db.oneOrNone(
      `SELECT * FROM tbl_hospitality_companies
       WHERE id = $1 AND is_deleted = 0`,
      [companyId]
    );
  },

  createHotel: async (hotelObj) => {
    return db.one(
      `INSERT INTO tbl_hospitality_company_hotels
        (hospitality_company_id, name, city, keys, status, full_address, state,
         gst, pan, bank_account_number, bank_name, ifsc_code, account_holder_name,
         msme, delivery_address, created_by, updated_by, fee_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $17)
       RETURNING *`,
      [
        hotelObj.hospitality_company_id,
        hotelObj.name,
        hotelObj.city,
        hotelObj.keys,
        hotelObj.status,
        hotelObj.full_address || null,
        hotelObj.state || null,
        hotelObj.gst || null,
        hotelObj.pan || null,
        hotelObj.bank_account_number || null,
        hotelObj.bank_name || null,
        hotelObj.ifsc_code || null,
        hotelObj.account_holder_name || null,
        hotelObj.msme || null,
        hotelObj.delivery_address || null,
        hotelObj.created_by,
        hotelObj.fee_amount
      ]
    );
  },

  getHotelsByCompany: async (companyId) => {
    return db.any(
      `SELECT * FROM tbl_hospitality_company_hotels
       WHERE hospitality_company_id = $1
         AND is_deleted = 0
       ORDER BY created_at DESC`,
      [companyId]
    );
  },

  getHotelById: async (hotelId) => {
    return db.oneOrNone(
      `SELECT * FROM tbl_hospitality_company_hotels
       WHERE id = $1 AND is_deleted = 0`,
      [hotelId]
    );
  },

  insertUserMappings: async (rows) => {
    if (!rows?.length) {
      return [];
    }
    const columnSet = new pgp.helpers.ColumnSet(
      [
        'user_id',
        'hospitality_company_id',
        'hospitality_hotel_id',
        'mapping_type',
        'auto_map_projects',
        'created_by'
      ],
      { table: 'tbl_hospitality_user_mappings' }
    );
    const query =
      pgp.helpers.insert(rows, columnSet) +
      ` ON CONFLICT (user_id, mapping_type, hospitality_company_id, hospitality_hotel_id)
        DO UPDATE SET auto_map_projects = EXCLUDED.auto_map_projects
        RETURNING *`;
    return db.any(query);
  },

  insertProjectMappings: async (rows) => {
    if (!rows?.length) {
      return [];
    }

    const columnSet = new pgp.helpers.ColumnSet(
      [
        'project_id',
        'hospitality_company_id',
        'hospitality_hotel_id',
        'mapping_type',
        'created_by'
      ],
      { table: 'tbl_hospitality_project_mappings' }
    );

    const query =
      pgp.helpers.insert(rows, columnSet) +
      ` ON CONFLICT (project_id, mapping_type, hospitality_company_id, hospitality_hotel_id)
        DO NOTHING
        RETURNING *`;
    return db.any(query);
  },

  getProjectMappingsForContext: async (companyId, mappingType, hotelId = null) => {
    return db.any(
      `SELECT project_id
       FROM tbl_hospitality_project_mappings
       WHERE hospitality_company_id = $1
         AND mapping_type = $2
         AND (
              (mapping_type = 0 AND hospitality_hotel_id IS NULL)
              OR (mapping_type = 1 AND hospitality_hotel_id = $3)
         )`,
      [companyId, mappingType, hotelId]
    );
  },

  getAutoMapUsersForContext: async (companyId, mappingType, hotelId = null) => {
    return db.any(
      `SELECT user_id
       FROM tbl_hospitality_user_mappings
       WHERE hospitality_company_id = $1
         AND mapping_type = $2
         AND auto_map_projects = true
         AND (
              (mapping_type = 0 AND hospitality_hotel_id IS NULL)
              OR (mapping_type = 1 AND hospitality_hotel_id = $3)
         )`,
      [companyId, mappingType, hotelId]
    );
  },

  filterUsersByCompany: async (userIds = [], companyId) => {
    if (!userIds.length) {
      return [];
    }
    return db.any(
      `SELECT id FROM tbl_users WHERE id IN ($1:csv) AND company_id = $2 AND status = 1 AND is_deleted = 0`,
      [userIds, companyId]
    );
  },

  filterProjectsByCompany: async (projectIds = [], companyId) => {
    if (!projectIds.length) {
      return [];
    }
    return db.any(
      `SELECT p.id
       FROM tbl_projects p
       JOIN tbl_users u ON u.id = p.user_id
       WHERE p.id IN ($1:csv)
         AND u.company_id = $2`,
      [projectIds, companyId]
    );
  },

  // Get active category subscriptions for a vendor
  getActiveVendorCategoryIds: async (vendorId) => {
    return db.any(
      `SELECT item_id AS category_id
       FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1
         AND item_type = 'category'
         AND status = 'active'
         AND start_date <= CURRENT_DATE
         AND end_date >= CURRENT_DATE`,
      [vendorId]
    );
  },

  getUserMappingsForCompany: async (
    companyId,
    mappingType = null,
    hotelId = null
  ) => {
    const params = [companyId];
    let idx = 2;
    let whereClause = '';

    if (mappingType !== null && (mappingType === 0 || mappingType === 1)) {
      whereClause += ` AND hum.mapping_type = $${idx}`;
      params.push(mappingType);
      idx += 1;
    }

    if (mappingType === 1 && hotelId) {
      whereClause += ` AND hum.hospitality_hotel_id = $${idx}`;
      params.push(hotelId);
      idx += 1;
    }

    return db.any(
      `SELECT 
        hum.*,
        u.name,
        u.email,
        u.mobile,
        COALESCE(hh.name, '') AS hotel_name
       FROM tbl_hospitality_user_mappings hum
       JOIN tbl_users u ON u.id = hum.user_id
       LEFT JOIN tbl_hospitality_company_hotels hh ON hh.id = hum.hospitality_hotel_id
       WHERE hum.hospitality_company_id = $1
         ${whereClause}
       ORDER BY hum.created_at DESC`,
      params
    );
  },

  getMappedUserIds: async (companyId, mappingType, hotelId = null) => {
    return db.any(
      `SELECT DISTINCT user_id
       FROM tbl_hospitality_user_mappings
       WHERE hospitality_company_id = $1
         AND mapping_type = $2
         AND (
              (mapping_type = 0 AND hospitality_hotel_id IS NULL)
              OR (mapping_type = 1 AND hospitality_hotel_id = $3)
         )`,
      [companyId, mappingType, hotelId]
    );
  },

  getMappedProjectIds: async (companyId, mappingType, hotelId = null) => {
    return db.any(
      `SELECT DISTINCT project_id
       FROM tbl_hospitality_project_mappings
       WHERE hospitality_company_id = $1
         AND mapping_type = $2
         AND (
              (mapping_type = 0 AND hospitality_hotel_id IS NULL)
              OR (mapping_type = 1 AND hospitality_hotel_id = $3)
         )`,
      [companyId, mappingType, hotelId]
    );
  },

  getProjectIdsForContext: async (companyId, hotelId = null) => {
    if (!companyId) {
      return [];
    }
    if (hotelId) {
      return db.any(
        `SELECT DISTINCT project_id
         FROM tbl_hospitality_project_mappings
         WHERE hospitality_company_id = $1
           AND mapping_type = 1
           AND hospitality_hotel_id = $2`,
        [companyId, hotelId]
      );
    }
    return db.any(
      `SELECT DISTINCT project_id
       FROM tbl_hospitality_project_mappings
       WHERE hospitality_company_id = $1`,
      [companyId]
    );
  },

  getProjectMappings: async (projectId) => {
    return db.any(
      `SELECT 
        hpm.*,
        hc.name AS company_name,
        hh.name AS hotel_name
       FROM tbl_hospitality_project_mappings hpm
       JOIN tbl_hospitality_companies hc ON hc.id = hpm.hospitality_company_id
       LEFT JOIN tbl_hospitality_company_hotels hh ON hh.id = hpm.hospitality_hotel_id
       WHERE hpm.project_id = $1
         AND hc.is_deleted = 0
         AND (hh.id IS NULL OR hh.is_deleted = 0)`,
      [projectId]
    );
  },

  getUserMappings: async (userId) => {
    return db.any(
      `SELECT 
        hum.*,
        hc.name AS company_name,
        hh.name AS hotel_name
       FROM tbl_hospitality_user_mappings hum
       JOIN tbl_hospitality_companies hc ON hc.id = hum.hospitality_company_id
       LEFT JOIN tbl_hospitality_company_hotels hh ON hh.id = hum.hospitality_hotel_id
       WHERE hum.user_id = $1
         AND hc.is_deleted = 0
         AND (hh.id IS NULL OR hh.is_deleted = 0)`,
      [userId]
    );
  },
  getHotelsByIds: async (ids = []) => {
    if (!ids || !ids.length) {
      return [];
    }
    return db.any(
      `SELECT id, fee_amount
       FROM tbl_hospitality_company_hotels
       WHERE id IN ($1:csv) AND is_deleted = 0`,
      [ids]
    );
  },
  createVendorPayment: async (paymentObj) => {
    return db.one(
      `INSERT INTO tbl_vendor_payments
         (vendor_id, razorpay_order_id, razorpay_payment_id, razorpay_signature, amount, currency, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        paymentObj.vendor_id,
        paymentObj.razorpay_order_id,
        paymentObj.razorpay_payment_id,
        paymentObj.razorpay_signature,
        paymentObj.amount,
        paymentObj.currency,
        paymentObj.payment_status
      ]
    );
  },
  getVendorPaymentByOrderId: async (orderId) => {
    return db.any(
      `SELECT * FROM tbl_vendor_payments WHERE razorpay_order_id = $1`,
      [orderId]
    );
  },
  createVendorHotelCategorySubscription: async (rows) => {
    if (!rows?.length) {
      return [];
    }
    const columnSet = new pgp.helpers.ColumnSet(
      [
        'vendor_id',
        'item_type',
        'item_id',
        'fee_amount',
        'start_date',
        'end_date',
        'status',
        'payment_id'
      ],
      { table: 'tbl_vendor_hotel_category_subscription' }
    );
    const query =
      pgp.helpers.insert(rows, columnSet) +
      ` ON CONFLICT (vendor_id, item_type, item_id, end_date)
        DO UPDATE SET fee_amount = EXCLUDED.fee_amount
        RETURNING *`;
    return db.any(query);
  },

  getPendingSubscriptionsForVendor: async (vendorId) => {
    return db.any(
      `SELECT 
        vhcs.*,
        vp.razorpay_order_id,
        vp.amount,
        vp.payment_status,
        vp.id AS payment_id
       FROM tbl_vendor_hotel_category_subscription vhcs
       LEFT JOIN tbl_vendor_payments vp ON vp.id = vhcs.payment_id
       WHERE vhcs.vendor_id = $1
         AND vhcs.status = 'active'
         AND (
           vp.id IS NULL 
           OR vp.payment_status IN ('created', 'pending')
         )
       ORDER BY COALESCE(vp.created_at, vhcs.start_date) DESC, vhcs.id DESC`,
      [vendorId]
    );
  },

  hasValidPaidSubscription: async (vendorId) => {
    // Check if vendor has any successful payment AND active subscriptions that haven't expired
    // Subscriptions expire on March 31st of the financial year
    const result = await db.oneOrNone(
      `SELECT 
         (SELECT COUNT(*) FROM tbl_vendor_payments 
          WHERE vendor_id = $1 AND payment_status IN ('paid', 'success')) as payment_count,
         (SELECT COUNT(*) FROM tbl_vendor_hotel_category_subscription 
          WHERE vendor_id = $1 AND status = 'active' AND end_date >= CURRENT_DATE) as subscription_count`,
      [vendorId]
    );
    return result && parseInt(result.payment_count) > 0 && parseInt(result.subscription_count) > 0;
  },

  updatePendingSubscriptionsPaymentId: async (vendorId, newPaymentId) => {
    return db.none(
      `UPDATE tbl_vendor_hotel_category_subscription
       SET payment_id = $1
       WHERE vendor_id = $2
         AND payment_id IN (
           SELECT id FROM tbl_vendor_payments
           WHERE vendor_id = $2
             AND payment_status IN ('created', 'pending')
         )`,
      [newPaymentId, vendorId]
    );
  },

  deleteProjectMappings: async (projectId, companyId, mappingType, hotelId = null) => {
    return db.result(
      `DELETE FROM tbl_hospitality_project_mappings
       WHERE project_id = $1
         AND hospitality_company_id = $2
         AND mapping_type = $3
         AND (
              (mapping_type = 0 AND hospitality_hotel_id IS NULL)
              OR (mapping_type = 1 AND hospitality_hotel_id = $4)
         )`,
      [projectId, companyId, mappingType, hotelId]
    );
  },

  deleteUserMappings: async (userId, companyId, mappingType, hotelId = null) => {
    return db.result(
      `DELETE FROM tbl_hospitality_user_mappings
       WHERE user_id = $1
         AND hospitality_company_id = $2
         AND mapping_type = $3
         AND (
              (mapping_type = 0 AND hospitality_hotel_id IS NULL)
              OR (mapping_type = 1 AND hospitality_hotel_id = $4)
         )`,
      [userId, companyId, mappingType, hotelId]
    );
  },

  getUserContexts: async (userId) => {
    return db.any(
      `SELECT 
        hum.id,
        hum.user_id,
        hum.mapping_type,
        hum.hospitality_company_id,
        hc.name AS company_name,
        hum.hospitality_hotel_id,
        hh.name AS hotel_name,
        hum.auto_map_projects,
        hum.created_at
       FROM tbl_hospitality_user_mappings hum
       JOIN tbl_hospitality_companies hc
         ON hc.id = hum.hospitality_company_id
        AND hc.is_deleted = 0
       LEFT JOIN tbl_hospitality_company_hotels hh
         ON hh.id = hum.hospitality_hotel_id
        AND hh.is_deleted = 0
       WHERE hum.user_id = $1`,
      [userId]
    );
  },

  userHasContext: async (userId, companyId, hotelId = null) => {
    const params = [userId, companyId];
    let condition = '';
    if (hotelId) {
      params.push(hotelId);
      condition = `AND hum.hospitality_hotel_id = $3 AND hum.mapping_type = 1`;
    } else {
      condition = `AND hum.mapping_type = 0 AND hum.hospitality_hotel_id IS NULL`;
    }

    const row = await db.oneOrNone(
      `SELECT 1
       FROM tbl_hospitality_user_mappings hum
       WHERE hum.user_id = $1
         AND hum.hospitality_company_id = $2
         ${condition}`,
      params
    );

    if (!row && hotelId) {
      // allow company level access to cover hotels
      const companyLevelAccess = await db.oneOrNone(
        `SELECT 1
         FROM tbl_hospitality_user_mappings hum
         WHERE hum.user_id = $1
           AND hum.hospitality_company_id = $2
           AND hum.mapping_type = 0
           AND hum.hospitality_hotel_id IS NULL`,
        [userId, companyId]
      );
      return Boolean(companyLevelAccess);
    }

    return Boolean(row);
  },

  saveCompanyDocument: async (companyId, documentType, documentUrl, documentNumber = null) => {
    return db.one(
      `INSERT INTO tbl_hospitality_company_documents
        (hospitality_company_id, document_type, document_url, document_number)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (hospitality_company_id, document_type)
       DO UPDATE SET document_url = EXCLUDED.document_url,
                     document_number = EXCLUDED.document_number,
                     updated_at = NOW()
       RETURNING *`,
      [companyId, documentType, documentUrl, documentNumber]
    );
  },

  getCompanyDocuments: async (companyId) => {
    return db.any(
      `SELECT * FROM tbl_hospitality_company_documents
       WHERE hospitality_company_id = $1
       ORDER BY created_at DESC`,
      [companyId]
    );
  },

  saveHotelDocument: async (hotelId, documentType, documentUrl, documentNumber = null) => {
    return db.one(
      `INSERT INTO tbl_hospitality_hotel_documents
        (hospitality_hotel_id, document_type, document_url, document_number)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (hospitality_hotel_id, document_type)
       DO UPDATE SET document_url = EXCLUDED.document_url,
                     document_number = EXCLUDED.document_number,
                     updated_at = NOW()
       RETURNING *`,
      [hotelId, documentType, documentUrl, documentNumber]
    );
  },

  getHotelDocuments: async (hotelId) => {
    return db.any(
      `SELECT * FROM tbl_hospitality_hotel_documents
       WHERE hospitality_hotel_id = $1
       ORDER BY created_at DESC`,
      [hotelId]
    );
  },

  getCompaniesWithHotels: async (buyerCompanyId) => {
    const rows = await db.any(
      `
      SELECT
        hc.id AS company_id,
        hc.name AS company_name,
        hc.region,
        h.id AS hotel_id,
        h.name AS hotel_name,
        h.city,
        h.status
      FROM tbl_hospitality_companies hc
      LEFT JOIN tbl_hospitality_company_hotels h
        ON h.hospitality_company_id = hc.id
       AND h.is_deleted = 0
      WHERE hc.buyer_company_id = $1
        AND hc.is_deleted = 0
      ORDER BY hc.name, h.name
      `,
      [buyerCompanyId]
    );

    /**
     * Transform into:
     * [
     *   {
     *     company_id,
     *     company_name,
     *     hotels: [...]
     *   }
     * ]
     */
    const map = {};
    for (const row of rows) {
      if (!map[row.company_id]) {
        map[row.company_id] = {
          company_id: row.company_id,
          company_name: row.company_name,
          region: row.region,
          hotels: []
        };
      }

      if (row.hotel_id) {
        map[row.company_id].hotels.push({
          hotel_id: row.hotel_id,
          hotel_name: row.hotel_name,
          city: row.city,
          status: row.status
        });
      }
    }

    return Object.values(map);
  },

/**
 * Returns the list of eligible vendors for a given product variant.
 * Eligibility logic:
 * 1. Vendor must be explicitly mapped to the product variant.
 * 2. Vendor must have an ACTIVE subscription for at least one
 *    category associated with the product.
 * 3. Vendor must have an ACTIVE subscription for at least one
 *    of the provided hotel IDs.
 * 4. Subscriptions are considered valid only if the current date
 *    falls within the subscription start and end dates.
 * Vendors failing any of the above conditions are excluded.
 */
getEligibleVendorsForVariant: async (variantId, hotelIds) => {
  return db.any(
    `WITH vp AS (
    SELECT product_id
    FROM tbl_product_variant
    WHERE id = $1
      AND is_deleted = 0
),

variant_vendors AS (
    SELECT DISTINCT vendor_id
    FROM tbl_product_variant_vendor_mapping
    WHERE product_variant_id = $1
),

product_categories AS (
    SELECT DISTINCT pc.category_id
    FROM tbl_product_categories pc
    JOIN vp ON vp.product_id = pc.product_id
),

eligible_category_vendors AS (
    SELECT DISTINCT s.vendor_id
    FROM tbl_vendor_hotel_category_subscription s
    JOIN product_categories pc
        ON pc.category_id = s.item_id
    JOIN variant_vendors vv
        ON vv.vendor_id = s.vendor_id
    WHERE s.item_type = 'category'
      AND s.status = 'active'
      AND CURRENT_DATE BETWEEN s.start_date AND s.end_date
),

eligible_hotel_vendors AS (
    SELECT DISTINCT s.vendor_id
    FROM tbl_vendor_hotel_category_subscription s
    JOIN variant_vendors vv
        ON vv.vendor_id = s.vendor_id
    WHERE s.item_type = 'hotel'
      AND s.item_id = ANY ($2)
      AND s.status = 'active'
      AND CURRENT_DATE BETWEEN s.start_date AND s.end_date
)

SELECT vv.vendor_id
FROM variant_vendors vv
JOIN eligible_category_vendors ecv ON ecv.vendor_id = vv.vendor_id
JOIN eligible_hotel_vendors ehv ON ehv.vendor_id = vv.vendor_id;
`,
    [variantId, hotelIds]
  );
},


/**
 * @created_by: Mukul jatav
 * Synchronizes RFQ ↔ Hotel mappings using a "desired state" approach.
 
 * HOW IT WORKS:
 * 1. Frontend sends the FINAL list of hotel_ids for an RFQ.
 * 2. Backend treats this list as the single source of truth.
 * 3. Inside a DB transaction:
 *    - Deletes mappings that are no longer present in the incoming list.
 *    - Inserts only missing mappings using a single bulk SQL statement.
 * 4. Database unique constraint (rfq_id, hotel_id) guarantees safety.
 *
 * WHY THIS APPROACH:
 * - Idempotent: same request can be safely retried multiple times.
 * - Prevents duplicate key violations without extra JS checks.
 * - Backend owns business logic; frontend stays simple.
 * - Uses set-based SQL (UNNEST + ON CONFLICT) which is faster and safer
 * - Handles add/remove/update in one API call.
 * - Safe against race conditions and partial failures (transactional).
 * - Scales well as hotel counts grow.
 * - Easy to extend with validations (e.g., lock updates after RFQ publish).
* This follows a desired-state reconciliation pattern used in, declarative systems and large-scale backends for safe state syncing.
 */
 reconcileRFQHotels: async ( rfq_id, hotel_ids = [], created_by ) => {
  if (!rfq_id) {
    throw new Error("rfq_id is required");
  }

  // Normalize & de-duplicate
  const incomingHotelIds = [...new Set(hotel_ids.map(Number))];

  return db.tx(async (t) => {
    /**
     * STEP 1: Delete removed mappings
     * - Simple & fast
     */
    await t.none(
      `
        DELETE FROM tbl_rfq_hotel_mappings
        WHERE rfq_id = $1
        AND hotel_id NOT IN (
          SELECT UNNEST($2::int[])
        )
      `,
      [rfq_id, incomingHotelIds]
    );

    /**
     * STEP 2: Insert new mappings
     * - Single SQL statement
     * - Conflict-safe
     */
    if (incomingHotelIds.length > 0) {
      await t.none(
        `
          INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by)
          SELECT $1, hotel_id, $3
          FROM UNNEST($2::int[]) AS hotel_id
          ON CONFLICT (rfq_id, hotel_id) DO NOTHING
        `,
        [rfq_id, incomingHotelIds, created_by]
      );
    }

    return {
      rfq_id,
      hotels: incomingHotelIds,
    };
  });
},





};

export default hospitalityModel;


