import db from "../config/dbConn.js";

const rbacModel = {

  /* -------------------- DEPARTMENTS -------------------- */

  getDepartments: () => {
    return db.any(`
      SELECT id, title
      FROM tbl_department
      ORDER BY title
    `);
  },

  assignUserDepartments: (userId, departmentIds = []) => {
    if (!departmentIds.length) return Promise.resolve();

    const values = departmentIds.map(depId => ({
      user_id: userId,
      department_id: depId
    }));

    return db.tx(t =>
      t.batch(
        values.map(v =>
          t.none(
            `INSERT INTO tbl_user_department (user_id, department_id)
             VALUES ($1, $2)`,
            [v.user_id, v.department_id]
          )
        )
      )
    );
  },

  deleteUserDepartments: (userId) => {
    return db.none(
      `DELETE FROM tbl_user_department WHERE user_id = $1`,
      [userId]
    );
  },

  getUserDepartments: (userId) => {
    return db.any(
      `
      SELECT d.id, d.title
      FROM tbl_user_department ud
      JOIN tbl_department d ON d.id = ud.department_id
      WHERE ud.user_id = $1
      ORDER BY d.title
      `,
      [userId]
    );
  },

  /* -------------------- ROLES & SCOPES -------------------- */

  assignUserRoleScopes: (scopes = []) => {
    if (!scopes.length) return Promise.resolve();

    return db.tx(t =>
      t.batch(
        scopes.map(s =>
          t.none(
            `
            INSERT INTO tbl_user_role_scopes
              (user_id, role_id, company_id, hotel_id, department_id)
            VALUES ($1, $2, $3, $4, $5)
            `,
            [
              s.user_id,
              s.role_id,
              s.company_id,
              s.hotel_id || null,
              s.department_id || null
            ]
          )
        )
      )
    );
  },
  getUserPermissions: async (userId, companyId, hotelId = null) => {
    return db.any(
      `
      SELECT DISTINCT
        p.resource,
        p.action
      FROM tbl_user_role_scopes urs
      JOIN tbl_role_permissions rp
        ON rp.role_id = urs.role_id
      JOIN tbl_permissions p
        ON p.id = rp.permission_id
      WHERE urs.user_id = $1
        AND urs.company_id = $2
        AND (
          urs.hotel_id IS NULL
          OR urs.hotel_id = $3
        )
      `,
      [userId, companyId, hotelId]
    );
  },

  /**
   * Get user permissions for multiple hotels across potentially multiple companies.
   * Infers company_id from each hotel and includes both company-level and hotel-specific permissions.
   * @param {number} userId - The authenticated user's ID
   * @param {number[]} hotelIds - Array of hotel IDs to check permissions for
   * @param {string|null} key - Optional resource/module filter (e.g., "tender")
   */
  getUserPermissionsForHotels: async (userId, hotelIds = [], key = null) => {
    if (!hotelIds || hotelIds.length === 0) {
      return [];
    }

    const params = [userId, hotelIds];
    let moduleFilter = '';

    if (key) {
      moduleFilter = 'AND p.resource = $3';
      params.push(key);
    }

    return db.any(
      `
      WITH hotel_companies AS (
        SELECT DISTINCT
          h.id AS hotel_id,
          h.hospitality_company_id
        FROM tbl_hospitality_company_hotels h
        WHERE h.id IN ($2:csv)
          AND h.is_deleted = 0
      ),
      relevant_companies AS (
        SELECT DISTINCT hospitality_company_id
        FROM hotel_companies
      )
      SELECT DISTINCT
        p.resource,
        p.action
      FROM tbl_user_role_scopes urs
      JOIN tbl_role_permissions rp
        ON rp.role_id = urs.role_id
      JOIN tbl_permissions p
        ON p.id = rp.permission_id
      WHERE urs.user_id = $1
        AND urs.company_id IN (SELECT hospitality_company_id FROM relevant_companies)
        AND (
          urs.hotel_id IS NULL
          OR urs.hotel_id IN ($2:csv)
        )
        ${moduleFilter}
      `,
      params
    );
  },

  /**
   * Validate hotel IDs exist and return their company mappings.
   */
  getHotelCompanyMappings: async (hotelIds = []) => {
    if (!hotelIds || hotelIds.length === 0) {
      return [];
    }

    return db.any(
      `
      SELECT
        id AS hotel_id,
        hospitality_company_id
      FROM tbl_hospitality_company_hotels
      WHERE id IN ($1:csv)
        AND is_deleted = 0
      `,
      [hotelIds]
    );
  },

  deleteUserRoleScopes: (userId) => {
    return db.none(
      `DELETE FROM tbl_user_role_scopes WHERE user_id = $1`,
      [userId]
    );
  },

  getUserRoleScopes: (userId) => {
    return db.any(
      `
      SELECT
        urs.id,
        urs.user_id,
        urs.role_id,
        r.title AS role_title,
        urs.company_id,
        urs.hotel_id,
        urs.department_id
      FROM tbl_user_role_scopes urs
      JOIN tbl_roles r
        ON r.id = urs.role_id
      WHERE urs.user_id = $1
      ORDER BY r.title
      `,
      [userId]
    );
  },

  /* -------------------- ROLES -------------------- */

  getRoles: (user) => {
    return db.any(`
      SELECT *
      FROM tbl_roles
      WHERE created_by IS NULL OR created_by = $1
      ORDER BY title
    `, [user.id]);
  },

  getPermissionsByRoleId: (roleId) => {
    return db.any(`
      SELECT p.id, p.resource, p.action
      FROM tbl_role_permissions rp
      JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1
    `, [roleId]);
  },
  createRole: async ({ title, description }, createdBy) => {
    const [role] = await db.any(
      `
      INSERT INTO tbl_roles (title, description, created_by)
      VALUES ($1, $2, $3)
      RETURNING id, title, created_by
      `,
      [title.trim(), description || null, createdBy]
    );

    return role;
  },
  getRoleById: async (roleId) => {
    return db.oneOrNone(
      `
      SELECT id, title, description, created_by
      FROM tbl_roles
      WHERE id = $1
      `,
      [roleId]
    );
  },
  updateRole: async (roleId, { title, description }) => {
    return db.none(
      `
      UPDATE tbl_roles
      SET title = $1,
          description = $2
      WHERE id = $3
      `,
      [title.trim(), description || null, roleId]
    );
  },
  deleteRolePermissions: async (roleId) => {
    return db.none(
      `
      DELETE FROM tbl_role_permissions
      WHERE role_id = $1
      `,
      [roleId]
    );
  },
  assignPermissionsToRole: async (roleId, permissionIds = []) => {
    if (!permissionIds.length) return;

    // Remove duplicates
    const uniqueIds = [...new Set(permissionIds)];

    return db.tx(t =>
      t.batch(
        uniqueIds.map(pid =>
          t.none(
            `
            INSERT INTO tbl_role_permissions (role_id, permission_id)
            VALUES ($1, $2)
            `,
            [roleId, pid]
          )
        )
      )
    );
  },
  getAllPermissions: () => {
    return db.any(`
      SELECT id, resource, action
      FROM tbl_permissions
      ORDER BY resource, action
    `);
  },

  /**
   * Get users who have BOTH read AND write permissions for ANY of the specified resources
   * (OR logic between resources, AND logic within each resource pair)
   * @param {number} companyId - The hospitality company ID
   * @param {number|null} hotelId - The hotel ID
   * @param {Array<string>} resources - e.g., ['quote-compare', 'negotiation']
   * @returns {Promise<Array>} - Users with id, name, email
   */
  getUsersWithResourcePermissionPairs: async (companyId, hotelId = null, resources = []) => {
    if (!companyId || !resources.length) {
      return [];
    }

    // Build conditions for each resource (user needs BOTH read AND write for that resource)
    // Example: ('quote-compare', 'read'), ('quote-compare', 'write') OR ('negotiation', 'read'), ('negotiation', 'write')

    const params = hotelId ? [companyId, hotelId] : [companyId];
    let paramIndex = params.length + 1;

    const resourceConditions = resources.map(resource => {
      const readIdx = paramIndex++;
      const writeIdx = paramIndex++;
      params.push(`${resource}.read`, `${resource}.write`);
      return `(
        SELECT COUNT(DISTINCT p2.resource || '.' || p2.action)
        FROM tbl_user_role_scopes urs2
        JOIN tbl_role_permissions rp2 ON rp2.role_id = urs2.role_id
        JOIN tbl_permissions p2 ON p2.id = rp2.permission_id
        WHERE urs2.user_id = u.id
          AND urs2.company_id = $1
          AND (urs2.hotel_id IS NULL ${hotelId ? 'OR urs2.hotel_id = $2' : ''})
          AND (p2.resource || '.' || p2.action) IN ($${readIdx}, $${writeIdx})
      ) = 2`;
    }).join(' OR ');

    return db.any(
      `
      SELECT DISTINCT
        u.id,
        u.name,
        u.email
      FROM tbl_users u
      WHERE u.is_deleted = 0
        AND u.status = 1
        AND (${resourceConditions})
      `,
      params
    );
  }

};

export default rbacModel;
