import db, { pgp } from '../config/dbConn.js';

const hospitalityModel = {
  createCompany: async (companyObj) => {
    return db.one(
      `INSERT INTO tbl_hospitality_companies
        (buyer_company_id, name, region, contact_email, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING *`,
      [
        companyObj.buyer_company_id,
        companyObj.name,
        companyObj.region,
        companyObj.contact_email,
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
           updated_by = $4,
           updated_at = NOW()
       WHERE id = $5 AND buyer_company_id = $6 AND is_deleted = 0
       RETURNING *`,
      [
        companyObj.name,
        companyObj.region,
        companyObj.contact_email,
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
        (hospitality_company_id, name, city, keys, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING *`,
      [
        hotelObj.hospitality_company_id,
        hotelObj.name,
        hotelObj.city,
        hotelObj.keys,
        hotelObj.status,
        hotelObj.created_by
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
      `SELECT id FROM tbl_users WHERE id IN ($1:csv) AND company_id = $2 AND is_deleted = 0`,
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
  }
};

export default hospitalityModel;


