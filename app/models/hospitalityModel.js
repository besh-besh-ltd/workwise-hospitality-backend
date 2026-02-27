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
         msme, delivery_address, created_by, updated_by, fee_amount, email, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $17, $18, $19)
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
        hotelObj.fee_amount,
        hotelObj.email || null,
        hotelObj.payment_status || 'onboarding'
      ]
    );
  },

  createHOFromCompany: async (companyId, createdBy) => {
    return db.one(
      `INSERT INTO tbl_hospitality_company_hotels
        (hospitality_company_id, name, full_address, state, gst, pan,
         bank_account_number, bank_name, ifsc_code, account_holder_name,
         msme, email, delivery_address, status, payment_status, keys,
         fee_amount, created_by, updated_by)
       SELECT
         c.id, c.name, c.registered_office_address, NULL, c.gst, c.pan,
         c.bank_account_number, c.bank_name, c.ifsc_code, c.account_holder_name,
         c.msme, c.contact_email, c.corporate_office_address, 'Active', 'active', 0,
         0, $2, $2
       FROM tbl_hospitality_companies c
       WHERE c.id = $1 AND c.is_deleted = 0
       RETURNING *`,
      [companyId, createdBy]
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

  updateHotel: async (hotelId, hotelObj, companyId) => {
    return db.one(
      `UPDATE tbl_hospitality_company_hotels
       SET name = $1,
           city = $2,
           keys = $3,
           status = $4,
           full_address = $5,
           state = $6,
           gst = $7,
           pan = $8,
           bank_account_number = $9,
           bank_name = $10,
           ifsc_code = $11,
           account_holder_name = $12,
           msme = $13,
           delivery_address = $14,
           updated_by = $15,
           email = $18,
           fee_amount = $19,
           updated_at = NOW()
       WHERE id = $16 AND hospitality_company_id = $17 AND is_deleted = 0
       RETURNING *`,
      [
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
        hotelObj.updated_by,
        hotelId,
        companyId,
        hotelObj.email || null,
        hotelObj.fee_amount
      ]
    );
  },

  updateHotelPaymentStatus: async (hotelId, paymentStatus) => {
    return db.oneOrNone(
      `UPDATE tbl_hospitality_company_hotels
       SET payment_status = $1,
           status = CASE
                      WHEN $1 = 'active' THEN 'Active'
                      WHEN $1 = 'pending' THEN 'Pending Payment'
                      WHEN $1 = 'onboarding' THEN 'Pending Onboarding'
                      ELSE status
                    END,
           updated_at = NOW()
       WHERE id = $2 AND is_deleted = 0
       RETURNING *`,
      [paymentStatus, hotelId]
    );
  },

  getHotelPaymentDetails: async (hotelId) => {
    return db.oneOrNone(
      `SELECT h.id, h.name, h.email, h.fee_amount, h.payment_status, h.status,
              c.name as company_name, c.id as company_id, h.created_by
       FROM tbl_hospitality_company_hotels h
       JOIN tbl_hospitality_companies c ON c.id = h.hospitality_company_id
       WHERE h.id = $1 AND h.is_deleted = 0`,
      [hotelId]
    );
  },

  getHotelsByIds: async (hotelIds) => {
    return db.any(
      `SELECT h.*,
              c.name as company_name,
              c.contact_email as company_email
       FROM tbl_hospitality_company_hotels h
       JOIN tbl_hospitality_companies c ON c.id = h.hospitality_company_id
       WHERE h.id = ANY($1::int[]) AND h.is_deleted = 0
       ORDER BY h.name`,
      [hotelIds]
    );
  },

  createHotelPayment: async (paymentObj) => {
    return db.one(
      `INSERT INTO tbl_vendor_payments
         (vendor_id, amount, currency, payment_status, razorpay_order_id, payment_type, receipt, before_payment_response)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        paymentObj.user_id,
        paymentObj.amount,
        paymentObj.currency || 'INR',
        paymentObj.payment_status || 'created',
        paymentObj.razorpay_order_id,
        'hospitality',
        paymentObj.receipt,
        paymentObj.before_payment_response || null
      ]
    );
  },

  getHotelPayment: async (hotelId) => {
    return db.oneOrNone(
      `SELECT id, payment_status, razorpay_order_id, razorpay_payment_id, amount, receipt
       FROM tbl_vendor_payments
       WHERE payment_type = 'hospitality'
         AND receipt LIKE $1
       ORDER BY id DESC LIMIT 1`,
      [`HOTEL-${hotelId}-%`]
    );
  },

  getPaymentById: async (paymentId) => {
    return db.oneOrNone(
      `SELECT id, amount, receipt, razorpay_order_id, razorpay_payment_id
       FROM tbl_vendor_payments WHERE id = $1`,
      [paymentId]
    );
  },

  updateHotelPayment: async (paymentId, updateObj) => {
    return db.oneOrNone(
      `UPDATE tbl_vendor_payments
       SET razorpay_payment_id = COALESCE($1, razorpay_payment_id),
           razorpay_signature = COALESCE($2, razorpay_signature),
           payment_status = COALESCE($3, payment_status),
           after_payment_response = COALESCE($4, after_payment_response)
       WHERE id = $5
       RETURNING *`,
      [
        updateObj.razorpay_payment_id || null,
        updateObj.razorpay_signature || null,
        updateObj.payment_status || null,
        updateObj.after_payment_response || null,
        paymentId
      ]
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

    // When no mapping_type filter is set, deduplicate by user_id
    // so users with both company-level and hotel-level access appear only once
    const distinctClause = mappingType === null
      ? 'DISTINCT ON (hum.user_id)' : '';
    const orderClause = mappingType === null
      ? 'ORDER BY hum.user_id, hum.mapping_type ASC, hum.created_at DESC'
      : 'ORDER BY hum.created_at DESC';

    return db.any(
      `SELECT ${distinctClause}
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
       ${orderClause}`,
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
        hum.id,
        hum.user_id,
        hum.mapping_type,
        hum.hospitality_company_id,
        hum.hospitality_hotel_id,
        hum.auto_map_projects,
        hum.created_by,
        hum.created_at,
        hc.name AS company_name,
        hh.name AS hotel_name
       FROM tbl_hospitality_user_mappings hum
       JOIN tbl_hospitality_companies hc ON hc.id = hum.hospitality_company_id
       LEFT JOIN tbl_hospitality_company_hotels hh ON hh.id = hum.hospitality_hotel_id
       WHERE hum.user_id = $1
         AND hc.is_deleted = 0
         AND (hh.id IS NULL OR hh.is_deleted = 0)

       UNION ALL

       SELECT
        (SELECT MIN(hum.id) FROM tbl_hospitality_user_mappings hum
         WHERE hum.user_id = $1 AND hum.hospitality_company_id = hc.id AND hum.mapping_type = 0) AS id,
        $1::int AS user_id,
        1 AS mapping_type,
        hc.id AS hospitality_company_id,
        hh.id AS hospitality_hotel_id,
        false AS auto_map_projects,
        NULL::int AS created_by,
        NOW() AS created_at,
        hc.name AS company_name,
        hh.name AS hotel_name
       FROM tbl_hospitality_companies hc
       JOIN tbl_hospitality_company_hotels hh
         ON hh.hospitality_company_id = hc.id AND hh.is_deleted = 0
       WHERE hc.is_deleted = 0
         AND EXISTS (
           SELECT 1 FROM tbl_hospitality_user_mappings hum
           WHERE hum.user_id = $1
             AND hum.hospitality_company_id = hc.id
             AND hum.mapping_type = 0
         )
         AND NOT EXISTS (
           SELECT 1 FROM tbl_hospitality_user_mappings hum2
           WHERE hum2.user_id = $1
             AND hum2.hospitality_company_id = hc.id
             AND hum2.hospitality_hotel_id = hh.id
             AND hum2.mapping_type = 1
         )`,
      [userId]
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




/**
 * Recomputes vendor eligibility for all products in an RFQ when hotels change.
 * For each product, calls getEligibleVendorsForVariant with new hotel_ids,
 * then diffs against current vendors to add/remove mappings.
 *
 * @param {number} rfq_id
 * @param {number[]} hotel_ids - The new set of hotel IDs
 * @param {object} txContext - pg-promise transaction context (t)
 * @returns {{ recomputed: true, products: Array, productsWithNoVendors: Array }}
 */
recomputeVendorsForRfq: async (rfq_id, hotel_ids, txContext) => {
  const ctx = txContext || db;

  // Get all products for this RFQ
  const rfqProducts = await ctx.any(
    `SELECT rp.id AS rfq_product_id, rp.product_variant_id, rp.variant,
            COALESCE(pv.name, '') AS product_name
     FROM tbl_rfq_products rp
     LEFT JOIN tbl_product_variant pv ON pv.id = rp.product_variant_id
     WHERE rp.rfq_id = $1`,
    [rfq_id]
  );

  const results = [];
  const productsWithNoVendors = [];

  for (const product of rfqProducts) {
    // Get eligible vendors for this variant + new hotels
    const eligibleRows = await hospitalityModel.getEligibleVendorsForVariant(
      product.product_variant_id,
      hotel_ids
    );
    const eligibleVendorIds = new Set(eligibleRows.map(r => r.vendor_id));

    // Get current vendors for this product
    const currentVendors = await ctx.any(
      `SELECT user_id FROM tbl_rfq_product_vendors
       WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3`,
      [rfq_id, product.product_variant_id, product.variant]
    );
    const currentVendorIds = new Set(currentVendors.map(v => v.user_id));

    // Compute diff
    const toAdd = [...eligibleVendorIds].filter(id => !currentVendorIds.has(id));
    const toRemove = [...currentVendorIds].filter(id => !eligibleVendorIds.has(id));

    // Insert new vendor mappings
    for (const vendorId of toAdd) {
      await ctx.none(
        `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [rfq_id, product.product_variant_id, vendorId, product.variant]
      );
    }

    // Remove stale vendor mappings
    if (toRemove.length > 0) {
      await ctx.none(
        `DELETE FROM tbl_rfq_product_vendors
         WHERE rfq_id = $1 AND product_variant_id = $2 AND variant = $3
           AND user_id IN ($4:csv)`,
        [rfq_id, product.product_variant_id, product.variant, toRemove]
      );
    }

    const remaining = eligibleVendorIds.size;

    results.push({
      rfq_product_id: product.rfq_product_id,
      product_name: product.product_name,
      added: toAdd.length,
      removed: toRemove.length,
      remaining
    });

    if (remaining === 0) {
      productsWithNoVendors.push({
        rfq_product_id: product.rfq_product_id,
        product_name: product.product_name
      });
    }
  }

  return {
    recomputed: true,
    products: results,
    productsWithNoVendors
  };
},

/**
 * Get all active hotel and category subscriptions for a vendor
 * Returns both hotels and categories the vendor is mapped to
 *
 * @param {number} vendorId - The vendor's user ID
 * @returns {Promise<Object>} Object with hotels and categories arrays
 */
getVendorHotelCategoryMappings: async (vendorId) => {
  const result = await db.any(
    `
    SELECT
      s.id AS subscription_id,
      s.item_type,
      s.item_id,
      s.start_date,
      s.end_date,
      s.fee_amount,
      CASE
        WHEN s.item_type = 'hotel' THEN h.name
        WHEN s.item_type = 'category' THEN c.title
      END AS item_name,
      CASE
        WHEN s.item_type = 'hotel' THEN h.city
        ELSE NULL
      END AS city,
      CASE
        WHEN s.item_type = 'hotel' THEN h.full_address
        ELSE NULL
      END AS full_address,
      CASE
        WHEN s.item_type = 'category' THEN c.parent_id
        ELSE NULL
      END AS parent_id,
      CASE
        WHEN s.item_type = 'category' THEN parent.title
        ELSE NULL
      END AS parent_category_name
    FROM tbl_vendor_hotel_category_subscription s
    LEFT JOIN tbl_hospitality_company_hotels h
      ON h.id = s.item_id AND s.item_type = 'hotel' AND h.is_deleted = 0
    LEFT JOIN tbl_category c
      ON c.id = s.item_id AND s.item_type = 'category' AND c.is_deleted = 0
    LEFT JOIN tbl_category parent
      ON parent.id = c.parent_id AND parent.is_deleted = 0
    WHERE s.vendor_id = $1
      AND s.status = 'active'
      AND CURRENT_DATE BETWEEN s.start_date AND s.end_date
      AND (
        (s.item_type = 'hotel' AND h.id IS NOT NULL) OR
        (s.item_type = 'category' AND c.id IS NOT NULL)
      )
    ORDER BY s.item_type, item_name
    `,
    [vendorId]
  );

  // Separate hotels and categories
  const hotels = result
    .filter(row => row.item_type === 'hotel')
    .map(row => ({
      subscription_id: row.subscription_id,
      hotel_id: row.item_id,
      hotel_name: row.item_name,
      city: row.city,
      full_address: row.full_address,
      start_date: row.start_date,
      end_date: row.end_date,
      fee_amount: row.fee_amount
    }));

  const categories = result
    .filter(row => row.item_type === 'category')
    .map(row => ({
      subscription_id: row.subscription_id,
      category_id: row.item_id,
      category_name: row.item_name,
      parent_id: row.parent_id,
      parent_category_name: row.parent_category_name,
      start_date: row.start_date,
      end_date: row.end_date,
      fee_amount: row.fee_amount
    }));

  return { hotels, categories };
},

  // ── Admin Vendor Subscription Management ──────────────────────────

  getVendorSubscriptionMappingsAdmin: async (vendorId) => {
    const result = await db.any(
      `SELECT
        s.id AS subscription_id,
        s.item_type,
        s.item_id,
        s.start_date,
        s.end_date,
        s.fee_amount,
        s.status,
        s.payment_id,
        CASE
          WHEN s.item_type = 'hotel' THEN h.name
          WHEN s.item_type = 'category' THEN c.title
          WHEN s.item_type = 'subcategory' THEN sc.title
        END AS item_name,
        CASE
          WHEN s.item_type = 'hotel' THEN h.city
          ELSE NULL
        END AS city,
        CASE
          WHEN s.item_type = 'hotel' THEN hc.name
          ELSE NULL
        END AS company_name,
        CASE
          WHEN s.item_type = 'category' THEN parent.id
          ELSE NULL
        END AS parent_id,
        CASE
          WHEN s.item_type = 'category' THEN parent.title
          ELSE NULL
        END AS parent_category_name,
        CASE
          WHEN s.item_type = 'subcategory' THEN sc_parent.id
          ELSE NULL
        END AS subcategory_parent_id,
        CASE
          WHEN s.item_type = 'subcategory' THEN sc_parent.title
          ELSE NULL
        END AS subcategory_parent_name,
        vp.payment_status
       FROM tbl_vendor_hotel_category_subscription s
       LEFT JOIN tbl_hospitality_company_hotels h
         ON h.id = s.item_id AND s.item_type = 'hotel'
       LEFT JOIN tbl_hospitality_companies hc
         ON hc.id = h.hospitality_company_id
       LEFT JOIN tbl_category c
         ON c.id = s.item_id AND s.item_type = 'category' AND c.is_deleted = 0
       LEFT JOIN tbl_category parent
         ON parent.id = c.parent_id AND parent.is_deleted = 0
       LEFT JOIN tbl_category sc
         ON sc.id = s.item_id AND s.item_type = 'subcategory' AND sc.is_deleted = 0
       LEFT JOIN tbl_category sc_parent
         ON sc_parent.id = sc.parent_id AND sc_parent.is_deleted = 0
       LEFT JOIN tbl_vendor_payments vp
         ON vp.id = s.payment_id
       WHERE s.vendor_id = $1
       ORDER BY s.item_type, s.status, item_name`,
      [vendorId]
    );

    const hotels = result
      .filter(row => row.item_type === 'hotel')
      .map(row => ({
        subscription_id: row.subscription_id,
        hotel_id: row.item_id,
        hotel_name: row.item_name,
        city: row.city,
        company_name: row.company_name,
        start_date: row.start_date,
        end_date: row.end_date,
        fee_amount: row.fee_amount,
        status: row.status,
        payment_status: row.payment_status
      }));

    const categories = result
      .filter(row => row.item_type === 'category')
      .map(row => ({
        subscription_id: row.subscription_id,
        category_id: row.item_id,
        category_name: row.item_name,
        parent_id: row.parent_id,
        parent_category_name: row.parent_category_name,
        start_date: row.start_date,
        end_date: row.end_date,
        fee_amount: row.fee_amount,
        status: row.status,
        payment_status: row.payment_status
      }));

    const subcategories = result
      .filter(row => row.item_type === 'subcategory')
      .map(row => ({
        subscription_id: row.subscription_id,
        subcategory_id: row.item_id,
        subcategory_name: row.item_name,
        parent_id: row.subcategory_parent_id,
        parent_category_name: row.subcategory_parent_name,
        start_date: row.start_date,
        end_date: row.end_date,
        fee_amount: row.fee_amount,
        status: row.status,
        payment_status: row.payment_status
      }));

    return { hotels, categories, subcategories };
  },

  updateVendorSubscriptionStatus: async (subscriptionId, status) => {
    return db.one(
      `UPDATE tbl_vendor_hotel_category_subscription
       SET status = $2
       WHERE id = $1
       RETURNING *`,
      [subscriptionId, status]
    );
  },

  getSubscriptionById: async (subscriptionId) => {
    return db.oneOrNone(
      `SELECT * FROM tbl_vendor_hotel_category_subscription WHERE id = $1`,
      [subscriptionId]
    );
  },

  getActiveCategorySubscriptions: async (vendorId, excludeCategoryId) => {
    return db.any(
      `SELECT * FROM tbl_vendor_hotel_category_subscription
       WHERE vendor_id = $1 AND item_type IN ('category', 'subcategory') AND status = 'active' AND item_id != $2`,
      [vendorId, excludeCategoryId]
    );
  },

  deleteVendorSubscription: async (subscriptionId) => {
    const result = await db.result(
      `DELETE FROM tbl_vendor_hotel_category_subscription WHERE id = $1`,
      [subscriptionId]
    );
    return result.rowCount;
  },

  getAllHotelsForAdmin: async () => {
    return db.any(
      `SELECT
        h.id,
        h.name,
        h.city,
        hc.id AS company_id,
        hc.name AS company_name
       FROM tbl_hospitality_company_hotels h
       JOIN tbl_hospitality_companies hc ON hc.id = h.hospitality_company_id
       WHERE h.is_deleted = 0
       ORDER BY hc.name, h.name`
    );
  },

  getVendorSubscriptionCounts: async (vendorIds) => {
    if (!vendorIds?.length) return [];
    return db.any(
      `SELECT
        s.vendor_id,
        COUNT(*) FILTER (WHERE s.item_type = 'category' AND s.status = 'active' AND CURRENT_DATE BETWEEN s.start_date AND s.end_date) AS active_categories,
        COUNT(*) FILTER (WHERE s.item_type = 'subcategory' AND s.status = 'active' AND CURRENT_DATE BETWEEN s.start_date AND s.end_date) AS active_subcategories,
        COUNT(*) FILTER (WHERE s.item_type = 'hotel' AND s.status = 'active' AND CURRENT_DATE BETWEEN s.start_date AND s.end_date) AS active_hotels,
        CASE
          WHEN COUNT(*) FILTER (WHERE s.status = 'active' AND CURRENT_DATE BETWEEN s.start_date AND s.end_date) > 0 THEN 'active'
          WHEN COUNT(*) FILTER (WHERE s.status = 'pending') > 0 THEN 'pending'
          WHEN COUNT(*) FILTER (WHERE s.end_date < CURRENT_DATE) > 0 THEN 'expired'
          ELSE 'none'
        END AS subscription_status
       FROM tbl_vendor_hotel_category_subscription s
       WHERE s.vendor_id = ANY($1)
       GROUP BY s.vendor_id`,
      [vendorIds]
    );
  },

  getUsersForHotelWithPassword: async (companyId, hotelId) => {
    return db.any(
      `SELECT DISTINCT ON (u.id)
        u.id AS user_id,
        u.name,
        u.email,
        u.employee_code,
        u.password,
        hum.mapping_type
       FROM tbl_hospitality_user_mappings hum
       JOIN tbl_users u ON u.id = hum.user_id
       WHERE hum.hospitality_company_id = $1
         AND (
           (hum.mapping_type = 1 AND hum.hospitality_hotel_id = $2)
           OR hum.mapping_type = 0
         )
       ORDER BY u.id, hum.mapping_type DESC`,
      [companyId, hotelId]
    );
  },

};

export default hospitalityModel;


