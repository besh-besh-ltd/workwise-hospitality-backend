import rbacModel from "../../models/rbacModel.js";
import { logError } from '../../helper/common.js';
import { logger } from '../../util/logger.js';

/**
 * Aggregate rows of {resource, action, hotel_id, department_id, process_id}
 * into the Shape A response: per-resource actions + scope summary.
 *
 *   {
 *     rfq: {
 *       actions: ['read', 'create'],
 *       scope: {
 *         hotels:      { all: false, ids: [12, 17] },
 *         departments: { all: true,  ids: [] },
 *         processes:   { all: false, ids: [3, 5] }
 *       }
 *     }
 *   }
 *
 * NULL on a scope column = "all" on that axis (wildcard). Non-null values are
 * collected as the explicit subset.
 */
const buildPermissionsShape = (rows) => {
  const byResource = {};
  for (const r of rows) {
    const resource = r.resource;
    if (!byResource[resource]) {
      byResource[resource] = {
        actions: new Set(),
        hotels: { all: false, ids: new Set() },
        departments: { all: false, ids: new Set() },
        processes: { all: false, ids: new Set() },
      };
    }
    const entry = byResource[resource];
    entry.actions.add(r.action);

    if (r.hotel_id == null) entry.hotels.all = true;
    else entry.hotels.ids.add(r.hotel_id);

    if (r.department_id == null) entry.departments.all = true;
    else entry.departments.ids.add(r.department_id);

    if (r.process_id == null) entry.processes.all = true;
    else entry.processes.ids.add(r.process_id);
  }

  const shaped = {};
  for (const [resource, e] of Object.entries(byResource)) {
    shaped[resource] = {
      actions: Array.from(e.actions),
      scope: {
        hotels:      { all: e.hotels.all,      ids: e.hotels.all      ? [] : Array.from(e.hotels.ids) },
        departments: { all: e.departments.all, ids: e.departments.all ? [] : Array.from(e.departments.ids) },
        processes:   { all: e.processes.all,   ids: e.processes.all   ? [] : Array.from(e.processes.ids) },
      },
    };
  }
  return shaped;
};

const rbacController = {

  /* -------------------- DEPARTMENTS -------------------- */
  getDepartments: async (req, res) => {
    try {
      const userId = req.user?.id;
      const hotelId = req.query.hotel_id ? parseInt(req.query.hotel_id) : null;
      const resource = req.query.resource || null;

      // When hotel and resource context are provided, filter by user's role scopes
      if (userId && hotelId && resource) {
        const rows = await rbacModel.getDepartmentsForUserScope(userId, hotelId, resource, 'create');
        return res.json({ status: true, data: rows });
      }

      // Fallback: return all departments (backward compatibility)
      const rows = await rbacModel.getDepartments();
      return res.json({ status: true, data: rows });
    } catch (err) {
      return res.status(500).json({ status: false, message: err.message });
    }
  },

  /* -------------------- ROLES -------------------- */
  getRoles: async (req, res) => {
    try {
      const rows = await rbacModel.getRoles(req.user);
      return res.json({ status: true, data: rows });
    } catch (err) {
      return res.status(500).json({ status: false, message: err.message });
    }
  },

  /* -------------------- PERMISSIONS (GROUPED) -------------------- */
  getPermissionsForRole: async (req, res) => {
    try {
      const { roleId } = req.params;

      const permissions =
        await rbacModel.getPermissionsByRoleId(roleId);

      /**
       * Group by resource
       * {
       *   tender: ["read", "create"]
       * }
       */
      const grouped = {};
      for (const p of permissions) {
        if (!grouped[p.resource]) grouped[p.resource] = [];
        grouped[p.resource].push(p.action);
      }

      return res.json({
        status: true,
        data: grouped
      });
    } catch (err) {
      return res.status(500).json({
        status: false,
        message: err.message
      });
    }
  },

  createRoleWithPermissions: async (req, res) => {
    try {
      const { title, description, permission_ids = [] } = req.body;
      const { id: userId } = req.user;

      if (!title || !permission_ids.length) {
        return res.status(400).json({
          status: false,
          message: "Role title and permissions are required"
        });
      }

      // Create role
      const role = await rbacModel.createRole({
        title,
        description
      }, userId);

      // Assign permissions
      await rbacModel.assignPermissionsToRole(
        role.id,
        permission_ids
      );

      return res.status(201).json({
        status: true,
        message: "Role created successfully",
        data: {
          role_id: role.id
        }
      });

    } catch (err) {
      logError("createRoleWithPermissions error", err);
      return res.status(500).json({
        status: false,
        message: "Failed to create role"
    });
    }
  },
  updateRoleWithPermissions: async (req, res) => {
  try {
    const { roleId } = req.params;
    const { title, description, permission_ids = [] } = req.body;
    const userId = req.user.id;

    if (!title || !permission_ids.length) {
      return res.status(400).json({
        status: false,
        message: "Role title and permissions are required"
      });
    }

    // 1️⃣ Fetch role & validate ownership
    const role = await rbacModel.getRoleById(roleId);

    if (!role) {
      return res.status(404).json({
        status: false,
        message: "Role not found"
      });
    }

    // System role protection
    if (role.created_by === null) {
      return res.status(403).json({
        status: false,
        message: "System roles cannot be modified"
      });
    }

    // Ownership check
    if (role.created_by !== userId) {
      return res.status(403).json({
        status: false,
        message: "You are not allowed to edit this role"
      });
    }

    // 2️⃣ Update role meta
    await rbacModel.updateRole(roleId, {
      title,
      description
    });

    // 3️⃣ Replace permissions
    await rbacModel.deleteRolePermissions(roleId);
    await rbacModel.assignPermissionsToRole(roleId, permission_ids);

    return res.json({
      status: true,
      message: "Role updated successfully"
    });

  } catch (err) {
    logError("updateRoleWithPermissions error", err);
    return res.status(500).json({
      status: false,
      message: "Failed to update role"
    });
  }
},
  /* -------------------- USER ROLE SCOPES -------------------- */
  getUserRoleScopes: async (req, res) => {
    try {
      const { userId } = req.params;

      const scopes = await rbacModel.getUserRoleScopes(userId);

      return res.json({
        status: true,
        data: scopes
      });
    } catch (err) {
      return res.status(500).json({
        status: false,
        message: err.message
      });
    }
  },
  getBatchUserRoleScopes: async (req, res) => {
    try {
      const userIdsParam = req.query.user_ids;
      if (!userIdsParam) {
        return res.status(400).json({
          status: false,
          message: 'user_ids query parameter is required'
        });
      }
      const userIds = userIdsParam.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id));
      if (!userIds.length) {
        return res.status(400).json({
          status: false,
          message: 'No valid user IDs provided'
        });
      }

      const scopes = await rbacModel.getUserRoleScopesBatch(userIds);

      const grouped = {};
      for (const scope of scopes) {
        if (!grouped[scope.user_id]) {
          grouped[scope.user_id] = [];
        }
        grouped[scope.user_id].push(scope);
      }

      return res.json({
        status: true,
        data: grouped
      });
    } catch (err) {
      return res.status(500).json({
        status: false,
        message: err.message
      });
    }
  },
  getUserDepartments: async (req, res) => {
    try {
      const { userId } = req.params;

      const departments = await rbacModel.getUserDepartments(userId);

      return res.json({
        status: true,
        data: departments
      });
    } catch (err) {
      return res.status(500).json({
        status: false,
        message: err.message
      });
    }
  },
  getBatchUserDepartments: async (req, res) => {
    try {
      const userIdsParam = req.query.user_ids;
      if (!userIdsParam) {
        return res.status(400).json({
          status: false,
          message: 'user_ids query parameter is required'
        });
      }
      const userIds = userIdsParam.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id));
      if (!userIds.length) {
        return res.status(400).json({
          status: false,
          message: 'No valid user IDs provided'
        });
      }

      const departments = await rbacModel.getUserDepartmentsBatch(userIds);

      const grouped = {};
      for (const dept of departments) {
        if (!grouped[dept.user_id]) {
          grouped[dept.user_id] = [];
        }
        grouped[dept.user_id].push(dept);
      }

      return res.json({
        status: true,
        data: grouped
      });
    } catch (err) {
      return res.status(500).json({
        status: false,
        message: err.message
      });
    }
  },
  getAllPermissionsGrouped: async (req, res) => {
    try {
      const permissions = await rbacModel.getAllPermissions();

      /**
       * Group by resource
       */
      const grouped = {};
      for (const p of permissions) {
        if (!grouped[p.resource]) grouped[p.resource] = [];
        grouped[p.resource].push({
          id: p.id,
          action: p.action
        });
      }

      return res.json({
        status: true,
        data: grouped
      });

    } catch (err) {
      logError("getAllPermissionsGrouped error", err);
      return res.status(500).json({
        status: false,
        message: "Failed to fetch permissions"
      });
    }
  },
  getMyPermissionsGrouped: async (req, res) => {
    try {
        const userId = req.user.id;

        const companyId =
        req.headers["x-company-id"] || req.user.company_id;

        const hotelId =
        req.headers["x-hotel-id"] ||
        req.query.hotel_id ||
        null;

        let departmentId = null;
        if (req.headers["x-department-id"]) {
            const id = parseInt(req.headers["x-department-id"], 10);
            if (!isNaN(id) && id > 0) departmentId = id;
        } else if (req.query.department_id) {
            const id = parseInt(req.query.department_id, 10);
            if (!isNaN(id) && id > 0) departmentId = id;
        }

        const permissions =
        await rbacModel.getUserPermissions(
            userId,
            companyId,
            hotelId,
            departmentId
        );

        // Shape A: per-resource actions + scope (hotels / departments / processes).
        const shaped = buildPermissionsShape(permissions);

        return res.json({
        status: true,
        data: shaped
        });

    } catch (err) {
        logError("getMyPermissionsGrouped error", err);
        return res.status(500).json({
        status: false,
        message: "Failed to fetch permissions"
        });
    }
    },

  /**
   * POST /rbac/me/permissions/bulk
   * Get permissions for multiple hotels, combining permissions from all relevant hospitality companies.
   */
  getMyPermissionsForHotels: async (req, res) => {
    try {
      const userId = req.user.id;
      const { hotel_ids, key, department_id } = req.body;

      // Validation: hotel_ids must be a non-empty array
      if (!hotel_ids || !Array.isArray(hotel_ids)) {
        return res.status(400).json({
          status: false,
          message: "hotel_ids must be provided as an array"
        });
      }

      // Normalize: ensure all IDs are integers and deduplicate
      const normalizedHotelIds = [...new Set(
        hotel_ids
          .map(id => parseInt(id, 10))
          .filter(id => !isNaN(id) && id > 0)
      )];

      // Edge case: empty array after normalization
      if (normalizedHotelIds.length === 0) {
        return res.status(400).json({
          status: false,
          message: "hotel_ids array must contain at least one valid hotel ID"
        });
      }

      // Step 1: Validate hotels exist and get their company mappings
      const hotelMappings = await rbacModel.getHotelCompanyMappings(normalizedHotelIds);

      const validHotelIds = hotelMappings.map(m => m.hotel_id);
      const invalidHotelIds = normalizedHotelIds.filter(id => !validHotelIds.includes(id));
      const companyIds = [...new Set(hotelMappings.map(m => m.hospitality_company_id))];

      // Edge case: no valid hotels found
      if (validHotelIds.length === 0) {
        return res.status(404).json({
          status: false,
          message: "None of the provided hotel IDs exist",
          data: {
            requested_hotel_ids: normalizedHotelIds,
            invalid_hotel_ids: invalidHotelIds
          }
        });
      }

      // Step 2: Get permissions for valid hotels (optionally filtered by key)
      // All resources are department-scoped — always pass department_id through
      const effectiveDeptId = department_id ? parseInt(department_id, 10) : null;

      const permissions = await rbacModel.getUserPermissionsForHotels(
        userId,
        validHotelIds,
        key || null,
        effectiveDeptId
      );

      // Shape A: per-resource actions + scope (hotels / departments / processes).
      const shaped = buildPermissionsShape(permissions);

      return res.json({
        status: true,
        data: {
          permissions: shaped,
          meta: {
            requested_hotel_ids: normalizedHotelIds,
            valid_hotel_ids: validHotelIds,
            invalid_hotel_ids: invalidHotelIds,
            company_ids: companyIds,
            module_filter: key || null
          }
        }
      });

    } catch (err) {
      logError("getMyPermissionsForHotels error", err);
      return res.status(500).json({
        status: false,
        message: "Failed to fetch permissions"
      });
    }
  },
};

export default rbacController;
