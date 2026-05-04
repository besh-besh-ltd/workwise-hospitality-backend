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

  /**
   * Get departments the user can create RFQs/Tenders in, based on their role scopes.
   * Derives company_id from the hotel_id via tbl_hospitality_company_hotels.
   * If the user has a scope with department_id IS NULL (hotel/company-wide grant),
   * returns all departments. Otherwise, returns only the specifically scoped departments.
   */
  getDepartmentsForUserScope: (userId, hotelId, resource, action) => {
    return db.any(`
      WITH hotel_company AS (
        SELECT hospitality_company_id
        FROM tbl_hospitality_company_hotels
        WHERE id = $2 AND is_deleted = 0
        LIMIT 1
      ),
      user_scopes AS (
        SELECT DISTINCT urs.department_id
        FROM tbl_user_role_scopes urs
        JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
        JOIN tbl_permissions p ON p.id = rp.permission_id
        WHERE urs.user_id = $1
          AND urs.company_id = (SELECT hospitality_company_id FROM hotel_company)
          AND (urs.hotel_id IS NULL OR urs.hotel_id = $2)
          AND p.resource = $3
          AND p.action = $4
      )
      SELECT d.id, d.title
      FROM tbl_department d
      WHERE
        -- If any scope has NULL department (all-departments grant), return all
        EXISTS (SELECT 1 FROM user_scopes WHERE department_id IS NULL)
        -- Otherwise, only return departments matching specific scopes
        OR d.id IN (SELECT department_id FROM user_scopes WHERE department_id IS NOT NULL)
      ORDER BY d.title
    `, [userId, hotelId, resource, action]);
  },

  assignUserDepartments: (userId, departmentIds = [], t = null) => {
    if (!departmentIds.length) return Promise.resolve();

    // Single multi-row INSERT instead of N individual inserts
    const values = departmentIds.map((_, i) => `($1, $${i + 2})`).join(', ');
    const params = [userId, ...departmentIds];
    const run = (tx) => tx.none(
      `INSERT INTO tbl_user_department (user_id, department_id) VALUES ${values}`,
      params
    );

    return t ? run(t) : db.tx(run);
  },

  deleteUserDepartments: (userId, t = db) => {
    return t.none(
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

  getUserDepartmentsBatch: (userIds) => {
    return db.any(
      `
      SELECT ud.user_id, d.id, d.title
      FROM tbl_user_department ud
      JOIN tbl_department d ON d.id = ud.department_id
      WHERE ud.user_id = ANY($1::int[])
      ORDER BY ud.user_id, d.title
      `,
      [userIds]
    );
  },

  /* -------------------- ROLES & SCOPES -------------------- */

  assignUserRoleScopes: (scopes = [], t = null) => {
    if (!scopes.length) return Promise.resolve();

    // Single multi-row INSERT instead of N individual inserts
    const params = [];
    const placeholders = scopes.map((s) => {
      const base = params.length;
      params.push(s.user_id, s.role_id, s.company_id, s.hotel_id || null, s.department_id || null);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });
    const run = (tx) => tx.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ${placeholders.join(', ')}`,
      params
    );

    return t ? run(t) : db.tx(run);
  },
  getUserPermissions: async (userId, companyId, hotelId = null, departmentId = null) => {
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
        AND (
          $4::int IS NULL
          OR urs.department_id = $4
          OR urs.department_id IS NULL
        )
      `,
      [userId, companyId, hotelId, departmentId]
    );
  },

  /**
   * Get user permissions for multiple hotels across potentially multiple companies.
   * Infers company_id from each hotel and includes both company-level and hotel-specific permissions.
   * @param {number} userId - The authenticated user's ID
   * @param {number[]} hotelIds - Array of hotel IDs to check permissions for
   * @param {string|null} key - Optional resource/module filter (e.g., "tender")
   */
  getUserPermissionsForHotels: async (userId, hotelIds = [], key = null, departmentId = null) => {
    if (!hotelIds || hotelIds.length === 0) {
      return [];
    }

    const params = [userId, hotelIds];
    let moduleFilter = '';
    let paramIdx = 3;

    if (key) {
      moduleFilter = `AND p.resource = $${paramIdx}`;
      params.push(key);
      paramIdx++;
    }

    const deptParamIdx = paramIdx;
    params.push(departmentId);

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
        AND (
          $${deptParamIdx}::int IS NULL
          OR urs.department_id = $${deptParamIdx}
          OR urs.department_id IS NULL
        )
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

  deleteUserRoleScopes: (userId, t = db) => {
    return t.none(
      `DELETE FROM tbl_user_role_scopes WHERE user_id = $1`,
      [userId]
    );
  },

  /**
   * Delete role scopes for a user within a specific company/hotel scope.
   * - companyId only (hotelId=null): removes all scopes for that company
   * - companyId + hotelId: removes scopes scoped to that specific hotel
   * Returns the count of deleted rows.
   */
  deleteUserRoleScopesForMapping: (userId, companyId, hotelId = null, t = db) => {
    if (hotelId) {
      return t.result(
        `DELETE FROM tbl_user_role_scopes
         WHERE user_id = $1 AND company_id = $2 AND hotel_id = $3`,
        [userId, companyId, hotelId]
      ).then(r => r.rowCount);
    }
    return t.result(
      `DELETE FROM tbl_user_role_scopes
       WHERE user_id = $1 AND company_id = $2`,
      [userId, companyId]
    ).then(r => r.rowCount);
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

  getUserRoleScopesBatch: (userIds) => {
    return db.any(
      `
      SELECT urs.id, urs.user_id, urs.role_id,
        r.title AS role_title,
        urs.company_id, urs.hotel_id, urs.department_id
      FROM tbl_user_role_scopes urs
      JOIN tbl_roles r
        ON r.id = urs.role_id
      WHERE urs.user_id = ANY($1::int[])
      ORDER BY urs.user_id, r.title
      `,
      [userIds]
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
  },

  /**
   * Get users who have all required actions for a module/resource within hotel + department scope.
   * This mirrors the permission evaluation used by the frontend `useModulePermissions` hook.
   */
  getUsersWithModuleActionsForHotels: async (hotelIds = [], resource = null, actions = [], departmentId = null) => {
    if (!hotelIds || hotelIds.length === 0 || !resource || !actions.length) {
      return [];
    }

    const requiredPermissionKeys = actions.map((action) => `${resource}.${action}`);
    const params = [hotelIds, requiredPermissionKeys, departmentId, requiredPermissionKeys.length];

    return db.any(
      `
      WITH hotel_companies AS (
        SELECT DISTINCT
          h.id AS hotel_id,
          h.hospitality_company_id
        FROM tbl_hospitality_company_hotels h
        WHERE h.id IN ($1:csv)
          AND h.is_deleted = 0
      )
      SELECT DISTINCT
        u.id,
        u.name,
        u.email
      FROM tbl_users u
      JOIN tbl_user_role_scopes urs ON urs.user_id = u.id
      JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
      JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE u.is_deleted = 0
        AND u.status = 1
        AND urs.company_id IN (SELECT hospitality_company_id FROM hotel_companies)
        AND (
          urs.hotel_id IS NULL
          OR urs.hotel_id IN ($1:csv)
        )
        AND (
          $3::int IS NULL
          OR urs.department_id = $3
          OR urs.department_id IS NULL
        )
      GROUP BY u.id, u.name, u.email
      HAVING COUNT(DISTINCT CASE
        WHEN (p.resource || '.' || p.action) IN ($2:csv) THEN (p.resource || '.' || p.action)
      END) = $4
      ORDER BY u.name ASC
      `,
      params
    );
  }

};

export default rbacModel;
