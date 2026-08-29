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
          -- ::text, not a bare enum comparison. The resource value arrives
          -- straight from ?resource= on GET /rbac/departments
          -- (rbacController.getDepartments), so an uncast p.resource = $3 makes
          -- Postgres coerce the PARAMETER to resource_type and any non-label
          -- value raises "invalid input value for enum resource_type" -- a 500
          -- from a query string. In text space it simply matches nothing.
          AND p.resource::text = $3
          AND p.action::text = $4
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

  /**
   * Role ids that carry the `company.admin` capability.
   *
   * Resolved from the permission rather than hardcoded to a title, so a
   * company that builds its own administrator role — or renames the seeded one
   * — is still recognised. Nothing should ever decide administration by
   * matching a string.
   */
  rolesGrantingCompanyAdmin: async () => {
    return db.map(
      `SELECT DISTINCT rp.role_id
         FROM tbl_role_permissions rp
         JOIN tbl_permissions p ON p.id = rp.permission_id
        WHERE p.resource = 'company' AND p.action = 'admin'`,
      [],
      (r) => Number(r.role_id)
    );
  },

  assignUserRoleScopes: (scopes = [], t = null) => {
    if (!scopes.length) return Promise.resolve();

    // Single multi-row INSERT instead of N individual inserts
    const params = [];
    const placeholders = scopes.map((s) => {
      const base = params.length;
      params.push(
        s.user_id,
        s.role_id,
        s.company_id,
        s.hotel_id || null,
        s.department_id || null,
        s.process_id || null
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });
    const run = (tx) => tx.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
       VALUES ${placeholders.join(', ')}`,
      params
    );

    // uq_user_role_scope_tuple already refuses an exact duplicate. Without
    // this, that refusal surfaced as a raw Postgres 23505 and the caller's
    // generic catch turned it into a bare 500 — the admin was told the server
    // had failed, when in fact they had asked for something they already had
    // (UM-7). Rethrown as a named error the controller can report properly.
    const withDuplicateContext = (err) => {
      if (err?.code === '23505' && String(err?.constraint || '').includes('user_role_scope')) {
        const duplicate = new Error('This role assignment already exists for this user.');
        duplicate.code = 'DUPLICATE_ROLE_SCOPE';
        duplicate.status = 409;
        throw duplicate;
      }
      throw err;
    };

    return (t ? run(t) : db.tx(run)).catch(withDuplicateContext);
  },
  getUserPermissions: async (userId, companyId, hotelId = null, departmentId = null) => {
    return db.any(
      `
      SELECT DISTINCT
        p.resource,
        p.action,
        urs.hotel_id,
        urs.department_id,
        urs.process_id
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
      // ::text for the same reason as getDepartmentsForUserScope above: `key`
      // is the client's ?key= on GET /rbac/my-permissions, and a bare enum
      // comparison turns an unknown value into a 500 instead of an empty result.
      moduleFilter = `AND p.resource::text = $${paramIdx}`;
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
        p.action,
        urs.hotel_id,
        urs.department_id,
        urs.process_id
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

  /**
   * Return every hotel id the given user can access.
   *
   *  - Hotel-level mappings (mapping_type = 1) contribute their specific
   *    hospitality_hotel_id directly.
   *  - Company-level mappings (mapping_type = 0, hospitality_hotel_id NULL)
   *    contribute ALL hotels under those hospitality companies.
   *
   * Used by the dashboard's "All Business Units" view — when the FE passes
   * hotel_ids: [] we expand it to this full set so the permission lookup
   * returns the union of grants across everything the user can reach.
   */
  getAllAccessibleHotelIds: async (userId) => {
    const rows = await db.any(
      `
      WITH user_hotel_scope AS (
        -- Direct hotel-level mappings
        SELECT DISTINCT hum.hospitality_hotel_id AS hotel_id
        FROM tbl_hospitality_user_mappings hum
        WHERE hum.user_id = $1
          AND hum.mapping_type = 1
          AND hum.hospitality_hotel_id IS NOT NULL

        UNION

        -- Expand company-level mappings to every hotel under those companies
        SELECT DISTINCT h.id AS hotel_id
        FROM tbl_hospitality_user_mappings hum
        JOIN tbl_hospitality_company_hotels h
          ON h.hospitality_company_id = hum.hospitality_company_id
        WHERE hum.user_id = $1
          AND hum.mapping_type = 0
          AND hum.hospitality_hotel_id IS NULL
          AND h.is_deleted = 0
      )
      SELECT hotel_id FROM user_hotel_scope
      `,
      [userId]
    );
    return rows.map((r) => r.hotel_id);
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
        urs.department_id,
        urs.process_id,
        proc.name AS process_name,
        proc.process_type
      FROM tbl_user_role_scopes urs
      JOIN tbl_roles r
        ON r.id = urs.role_id
      LEFT JOIN tbl_approval_processes proc
        ON proc.id = urs.process_id
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
        urs.company_id, urs.hotel_id, urs.department_id,
        urs.process_id,
        proc.name AS process_name,
        proc.process_type
      FROM tbl_user_role_scopes urs
      JOIN tbl_roles r
        ON r.id = urs.role_id
      LEFT JOIN tbl_approval_processes proc
        ON proc.id = urs.process_id
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
  // The three functions below take an OPTIONAL transaction context, following
  // the same convention as generalModel's createApprovalPolicy / insertPolicySteps.
  //
  // WHY IT MATTERS HERE: a role edit REPLACES its permissions
  // (deleteRolePermissions then assignPermissionsToRole). Run on the root `db`
  // those are two independent transactions, so between them the role visibly
  // holds ZERO permissions. Any createApprovalInstance landing in that window
  // fails roleHasReadAndApprovePermission (generalModel.js:2237) and silently
  // drops the role's step — permanently, since instance steps are a snapshot
  // and nothing rebuilds them. Passing one `t` through closes the window.
  updateRole: async (roleId, { title, description }, t = db) => {
    return t.none(
      `
      UPDATE tbl_roles
      SET title = $1,
          description = $2
      WHERE id = $3
      `,
      [title.trim(), description || null, roleId]
    );
  },
  deleteRolePermissions: async (roleId, t = db) => {
    return t.none(
      `
      DELETE FROM tbl_role_permissions
      WHERE role_id = $1
      `,
      [roleId]
    );
  },
  assignPermissionsToRole: async (roleId, permissionIds = [], t = null) => {
    if (!permissionIds.length) return;

    // Remove duplicates
    const uniqueIds = [...new Set(permissionIds)];

    const run = (tx) =>
      tx.batch(
        uniqueIds.map(pid =>
          tx.none(
            `
            INSERT INTO tbl_role_permissions (role_id, permission_id)
            VALUES ($1, $2)
            `,
            [roleId, pid]
          )
        )
      );

    // Join the caller's transaction when given one; otherwise open our own, so
    // the standalone callers (createRoleWithPermissions) are unchanged.
    return t ? run(t) : db.tx(run);
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
   * Get users who have all required actions for a module/resource within
   * hotel + department + process scope.
   * This mirrors the permission evaluation used by the frontend `useModulePermissions` hook.
   *
   * `processId` is the 4th RBAC scope axis. It is optional and trailing so the
   * existing call sites are unaffected: omitting it yields NULL and the
   * predicate short-circuits to TRUE. Pass it wherever the entity carries a
   * process, so this helper agrees with buildScopeExistsClause
   * (authorizationService.js) and with getAllBuyerRfq's rfq.read filter, both
   * of which already enforce the axis.
   */
  getUsersWithModuleActionsForHotels: async (hotelIds = [], resource = null, actions = [], departmentId = null, processId = null) => {
    if (!hotelIds || hotelIds.length === 0 || !resource || !actions.length) {
      return [];
    }

    const requiredPermissionKeys = actions.map((action) => `${resource}.${action}`);
    const params = [hotelIds, requiredPermissionKeys, departmentId, requiredPermissionKeys.length, processId];

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
        -- Exclude vendors. NULL-safe on purpose: user_type is nullable, and a
        -- bare inequality would evaluate to NULL and silently drop those rows.
        AND (u.user_type IS NULL OR u.user_type <> 3)
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
        AND (
          $5::int IS NULL
          OR urs.process_id IS NULL
          OR urs.process_id = $5
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
