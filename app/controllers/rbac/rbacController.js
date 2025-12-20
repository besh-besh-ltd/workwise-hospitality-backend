import rbacModel from "../../models/rbacModel.js";

const rbacController = {

  /* -------------------- DEPARTMENTS -------------------- */
  getDepartments: async (req, res) => {
    try {
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
      console.error("createRoleWithPermissions error:", err);
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
    console.error("updateRoleWithPermissions error:", err);
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
      console.error("getAllPermissionsGrouped error:", err);
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

        const permissions =
        await rbacModel.getUserPermissions(
            userId,
            companyId,
            hotelId
        );

        /**
         * Combine + deduplicate
         * {
         *   tender: ['read','create']
         * }
         */
        const grouped = {};

        for (const p of permissions) {
        if (!grouped[p.resource]) {
            grouped[p.resource] = new Set();
        }
        grouped[p.resource].add(p.action);
        }

        // Convert Set → Array
        Object.keys(grouped).forEach(resource => {
        grouped[resource] = Array.from(grouped[resource]);
        });

        return res.json({
        status: true,
        data: grouped
        });

    } catch (err) {
        console.error("getMyPermissionsGrouped error:", err);
        return res.status(500).json({
        status: false,
        message: "Failed to fetch permissions"
        });
    }
    },
};

export default rbacController;
