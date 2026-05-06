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

  /**
   * Insert one or more (user, role) scope rows.
   *
   * Each scope shape supports two forms:
   *   - BU-scoped: { user_id, role_id, company_id, hotel_id?, department_id? }
   *     → row has is_network_scope=0 (default) and the BU columns set.
   *   - Network-scoped: { user_id, role_id, is_network_scope: 1 }
   *     → row has is_network_scope=1 and ALL of company_id/hotel_id/
   *       department_id forced to NULL (the CHECK constraint refuses
   *       any other shape; we sanitise here so callers can pass mixed
   *       payloads safely).
   *
   * Network-scoped grants are exclusively for Group ARC entities. They
   * do NOT cross-pollinate with BU-scoped grants — see migration 004
   * for the architectural rationale.
   */
  assignUserRoleScopes: (scopes = [], t = null) => {
    if (!scopes.length) return Promise.resolve();

    const params = [];
    const placeholders = scopes.map((s) => {
      const base = params.length;
      const isNetwork = s.is_network_scope === 1 || s.is_network_scope === true ? 1 : 0;
      // Network-scope rows MUST be all-NULL on BU columns (enforced by
      // the CHECK constraint). Force-null here so a sloppy caller can't
      // smuggle a hotel_id past the constraint and either fail noisily
      // or — worse — succeed against a future relaxation of the check.
      const companyId = isNetwork ? null : (s.company_id ?? null);
      const hotelId = isNetwork ? null : (s.hotel_id || null);
      const departmentId = isNetwork ? null : (s.department_id || null);
      params.push(s.user_id, s.role_id, companyId, hotelId, departmentId, isNetwork);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });
    const run = (tx) => tx.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, is_network_scope)
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
   * Per-hotel permission resolution.
   *
   * The existing getUserPermissionsForHotels returns the UNION of every
   * permission the user holds across ALL the supplied hotels. That's
   * the right shape for "can the user act on this set" decisions, but
   * useless when you need to filter a hotel-picker dropdown — you have
   * to know per-hotel what the user can do, NOT what they can do
   * somewhere in the set.
   *
   * Returns a flat array of {hotel_id, resource, action} tuples so the
   * caller can group as needed. Each row means: "for this hotel, the
   * user has this resource.action". Unauthorised hotels yield no rows.
   */
  getUserPermissionsPerHotel: async (userId, hotelIds = [], key = null) => {
    if (!hotelIds || hotelIds.length === 0) return [];
    const params = [userId, hotelIds];
    let moduleFilter = '';
    if (key) {
      params.push(key);
      moduleFilter = `AND p.resource = $${params.length}`;
    }
    return db.any(
      `
      WITH requested_hotels AS (
        SELECT h.id AS hotel_id, h.hospitality_company_id
          FROM tbl_hospitality_company_hotels h
         WHERE h.id IN ($2:csv) AND h.is_deleted = 0
      )
      SELECT DISTINCT rh.hotel_id, p.resource, p.action
        FROM requested_hotels rh
        JOIN tbl_user_role_scopes urs
          ON urs.user_id = $1
         AND urs.is_network_scope = 0
         AND urs.company_id = rh.hospitality_company_id
         AND (urs.hotel_id IS NULL OR urs.hotel_id = rh.hotel_id)
        JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
        JOIN tbl_permissions p ON p.id = rp.permission_id
       WHERE 1=1 ${moduleFilter}
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
        urs.department_id,
        urs.is_network_scope
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
        urs.company_id, urs.hotel_id, urs.department_id,
        urs.is_network_scope
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
  },

  /**
   * Network-scope sister of getUsersWithModuleActionsForHotels.
   *
   * Returns active users who hold ALL of the requested
   * (resource.action) permissions via NETWORK-scope role grants
   * (is_network_scope = 1), restricted to the supplied tenant
   * (parent tbl_company.id). Used by the Tender Lifecycle Journey
   * to resolve "who can act on this stage?" for Group ARC tenders,
   * where the BU-scope resolver returns nobody (Group ARC is
   * BU-agnostic — its approvers/evaluators live at network scope).
   *
   * The tenant filter prevents tenant A's journey from listing
   * tenant B's network admins.
   */
  getUsersWithNetworkModuleActions: async (resource = null, actions = [], tenantCompanyId = null) => {
    if (!resource || !actions.length) return [];
    const requiredPermissionKeys = actions.map((a) => `${resource}.${a}`);
    return db.any(
      `
      SELECT DISTINCT u.id, u.name, u.email
        FROM tbl_users u
        JOIN tbl_user_role_scopes urs ON urs.user_id = u.id
        JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
        JOIN tbl_permissions p ON p.id = rp.permission_id
       WHERE u.is_deleted = 0
         AND u.status = 1
         AND urs.is_network_scope = 1
         AND ($3::int IS NULL OR u.company_id = $3)
       GROUP BY u.id, u.name, u.email
      HAVING COUNT(DISTINCT CASE
        WHEN (p.resource || '.' || p.action) IN ($1:csv) THEN (p.resource || '.' || p.action)
      END) = $2
       ORDER BY u.name ASC
      `,
      [requiredPermissionKeys, requiredPermissionKeys.length, tenantCompanyId]
    );
  },

  /* -------------------- NETWORK-SCOPE (Group ARC) -------------------- */
  //
  // Network-scope grants (tbl_user_role_scopes.is_network_scope = 1) are
  // the EXCLUSIVE permission axis for Group ARC entities. They do not
  // overlap with BU-scoped grants — a user holding te.read at hotel A1
  // cannot evaluate a Group ARC tender that covers A1; they need a
  // separate network-scope te.read grant. The functions below are the
  // canonical way for controllers to ask "does this user hold X at
  // network scope?" without joining tbl_user_role_scopes by hand.

  /**
   * Return the distinct (resource, action) permission pairs a user
   * holds via NETWORK-SCOPE role grants only. Used by Group ARC
   * entity controllers to render the user's permitted actions on
   * Group ARC tenders.
   */
  getUserNetworkPermissions: async (userId) => {
    if (!userId) return [];
    return db.any(
      `
      SELECT DISTINCT p.resource, p.action
      FROM tbl_user_role_scopes urs
      JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
      JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE urs.user_id = $1 AND urs.is_network_scope = 1
      ORDER BY p.resource, p.action
      `,
      [userId]
    );
  },

  /**
   * Boolean: does this user hold ANY of the given permission keys at
   * network scope? Pass an array of "resource.action" strings. Returns
   * true if at least one is granted via a network-scope role.
   *
   * Use this in controllers that gate a Group ARC list/detail endpoint:
   *   if (!await rbacModel.userHasAnyNetworkPermission(userId, ['te.read'])) return 403;
   *
   * Tenant scoping is implicit: the user's tbl_users.company_id is
   * the tenant boundary. We don't filter by tenant here because this
   * helper is asking "does THIS user hold the perm" — the user's own
   * identity is the scope.
   */
  userHasAnyNetworkPermission: async (userId, permKeys = []) => {
    if (!userId || !Array.isArray(permKeys) || permKeys.length === 0) return false;
    const row = await db.oneOrNone(
      `
      SELECT 1
      FROM tbl_user_role_scopes urs
      JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
      JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE urs.user_id = $1
        AND urs.is_network_scope = 1
        AND (p.resource || '.' || p.action) = ANY($2::text[])
      LIMIT 1
      `,
      [userId, permKeys]
    );
    return !!row;
  },

  /**
   * Roles that have ALL the given (resource, action) permissions.
   * Used by the Global ARC Hierarchy wizard to filter the role-source
   * picker per stage. e.g. for TENDER show only roles holding
   * tender.approve; for ARC show only roles holding arc.approve.
   *
   * When opts.tenant_company_id is supplied, each role row is enriched
   * with its `users` array — active users holding that role via a
   * network-scope grant within the tenant. The wizard renders these
   * users under the picked role so admins see "ARC Approver — 3 users
   * eligible" rather than "No users available".
   *
   * @param {string[]} permKeys  e.g. ['arc.approve']
   * @param {Object}   [opts]
   * @param {number}   [opts.tenant_company_id]  Parent tbl_company.id.
   *   When set, includes per-role network-scope users for that tenant.
   *   When unset, returns roles only (legacy shape).
   */
  getRolesWithAllPermissions: async (permKeys = [], opts = {}) => {
    if (!Array.isArray(permKeys) || permKeys.length === 0) return [];
    const tenantId = opts.tenant_company_id ?? null;
    const roles = await db.any(
      `
      SELECT r.id, r.title
      FROM tbl_roles r
      WHERE EXISTS (
        SELECT 1
        FROM tbl_role_permissions rp
        JOIN tbl_permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = r.id
          AND (p.resource || '.' || p.action) = ANY($1::text[])
        GROUP BY rp.role_id
        HAVING COUNT(DISTINCT (p.resource || '.' || p.action)) = $2
      )
      ORDER BY r.title
      `,
      [permKeys, permKeys.length]
    );
    if (!tenantId || roles.length === 0) {
      return roles.map((r) => ({ ...r, users: [] }));
    }
    // Per-role network-scope holders within the tenant.
    const roleIds = roles.map((r) => r.id);
    const usersByRole = await db.any(
      `
      SELECT urs.role_id, u.id, u.name, u.email
      FROM tbl_user_role_scopes urs
      JOIN tbl_users u ON u.id = urs.user_id
      WHERE urs.role_id = ANY($1::int[])
        AND urs.is_network_scope = 1
        AND u.status = 1
        AND u.company_id = $2
      ORDER BY u.name
      `,
      [roleIds, tenantId]
    );
    const grouped = new Map();
    usersByRole.forEach((row) => {
      if (!grouped.has(row.role_id)) grouped.set(row.role_id, []);
      grouped.get(row.role_id).push({ id: row.id, name: row.name, email: row.email });
    });
    return roles.map((r) => ({ ...r, users: grouped.get(r.id) || [] }));
  },

  /**
   * Active users holding ALL the given permissions at NETWORK scope,
   * scoped to a specific tenant (parent tbl_company.id) when supplied.
   *
   * The Global ARC Hierarchy wizard's USER picker calls this so it
   * only shows valid candidates per stage. e.g. at the TENDER stage,
   * only users with tender.approve via a network-scope grant. The
   * tenant filter prevents the wizard for tenant A from listing
   * tenant B's network admins.
   *
   * @param {string[]} permKeys  e.g. ['tender.approve']
   * @param {Object}   [opts]
   * @param {number}   [opts.tenant_company_id]  Parent tbl_company.id.
   *   When set, restricts the result to users belonging to that tenant.
   *   When unset, returns network-scope holders across the network
   *   (this should only be used for cross-tenant admin tooling).
   */
  /**
   * Active users holding ALL the given permissions at BU scope, scoped
   * to a specific hotel within a tenant. Network-scope grants are
   * EXCLUDED — those govern Group ARC only and must not cross-pollinate
   * into the BU-wide hierarchy wizard.
   *
   * @param {string[]} permKeys  e.g. ['tender.approve']
   * @param {Object}   opts
   * @param {number}   [opts.tenant_company_id]  Parent tbl_company.id.
   * @param {number}   [opts.hotel_id]  Match urs.hotel_id (NULL = company-wide
   *                                    grant, allowed; mismatched value rejected).
   */
  getUsersWithAllBuPermissions: async (permKeys = [], opts = {}) => {
    if (!Array.isArray(permKeys) || permKeys.length === 0) return [];
    const tenantId = opts.tenant_company_id ?? null;
    const hotelId = opts.hotel_id ?? null;
    return db.any(
      `
      SELECT u.id, u.name, u.email
      FROM tbl_users u
      WHERE u.status = 1
        AND ($3::int IS NULL OR u.company_id = $3)
        AND EXISTS (
          SELECT 1
          FROM tbl_user_role_scopes urs
          JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
          JOIN tbl_permissions p ON p.id = rp.permission_id
          WHERE urs.user_id = u.id
            AND urs.is_network_scope = 0
            AND ($4::int IS NULL OR urs.hotel_id IS NULL OR urs.hotel_id = $4)
            AND (p.resource || '.' || p.action) = ANY($1::text[])
          GROUP BY urs.user_id
          HAVING COUNT(DISTINCT (p.resource || '.' || p.action)) = $2
        )
      ORDER BY u.name
      `,
      [permKeys, permKeys.length, tenantId, hotelId]
    );
  },

  /**
   * Roles holding ALL the given permissions, with each role enriched
   * with its BU-scope holders matching the given (tenant, hotel). Used
   * by the BU-wide hierarchy wizard's role picker preview ("Role X — N
   * users eligible") so it shows accurate eligibility for the chosen
   * business unit. Network-scope holders are EXCLUDED from users[].
   *
   * @param {string[]} permKeys
   * @param {Object}   opts
   * @param {number}   [opts.tenant_company_id]
   * @param {number}   [opts.hotel_id]
   */
  getRolesWithAllPermissionsForBu: async (permKeys = [], opts = {}) => {
    if (!Array.isArray(permKeys) || permKeys.length === 0) return [];
    const tenantId = opts.tenant_company_id ?? null;
    const hotelId = opts.hotel_id ?? null;
    const roles = await db.any(
      `
      SELECT r.id, r.title
      FROM tbl_roles r
      WHERE EXISTS (
        SELECT 1
        FROM tbl_role_permissions rp
        JOIN tbl_permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = r.id
          AND (p.resource || '.' || p.action) = ANY($1::text[])
        GROUP BY rp.role_id
        HAVING COUNT(DISTINCT (p.resource || '.' || p.action)) = $2
      )
      ORDER BY r.title
      `,
      [permKeys, permKeys.length]
    );
    if (roles.length === 0) {
      return [];
    }
    const roleIds = roles.map((r) => r.id);
    const usersByRole = await db.any(
      `
      SELECT urs.role_id, u.id, u.name, u.email
      FROM tbl_user_role_scopes urs
      JOIN tbl_users u ON u.id = urs.user_id
      WHERE urs.role_id = ANY($1::int[])
        AND urs.is_network_scope = 0
        AND u.status = 1
        AND ($2::int IS NULL OR u.company_id = $2)
        AND ($3::int IS NULL OR urs.hotel_id IS NULL OR urs.hotel_id = $3)
      ORDER BY u.name
      `,
      [roleIds, tenantId, hotelId]
    );
    const grouped = new Map();
    usersByRole.forEach((row) => {
      if (!grouped.has(row.role_id)) grouped.set(row.role_id, []);
      // De-dupe per role: a user may hold the role at company-wide AND
      // hotel-specific scope; we still surface them once.
      const existing = grouped.get(row.role_id);
      if (!existing.find((u) => u.id === row.id)) {
        existing.push({ id: row.id, name: row.name, email: row.email });
      }
    });
    return roles.map((r) => ({ ...r, users: grouped.get(r.id) || [] }));
  },

  getUsersWithAllNetworkPermissions: async (permKeys = [], opts = {}) => {
    if (!Array.isArray(permKeys) || permKeys.length === 0) return [];
    const tenantId = opts.tenant_company_id ?? null;
    return db.any(
      `
      SELECT u.id, u.name, u.email
      FROM tbl_users u
      WHERE u.status = 1
        AND ($3::int IS NULL OR u.company_id = $3)
        AND EXISTS (
          SELECT 1
          FROM tbl_user_role_scopes urs
          JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
          JOIN tbl_permissions p ON p.id = rp.permission_id
          WHERE urs.user_id = u.id
            AND urs.is_network_scope = 1
            AND (p.resource || '.' || p.action) = ANY($1::text[])
          GROUP BY urs.user_id
          HAVING COUNT(DISTINCT (p.resource || '.' || p.action)) = $2
        )
      ORDER BY u.name
      `,
      [permKeys, permKeys.length, tenantId]
    );
  },

};

export default rbacModel;
