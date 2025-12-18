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
      const rows = await rbacModel.getRoles();
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
      });

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
  }
};

export default rbacController;
