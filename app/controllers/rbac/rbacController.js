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

};

export default rbacController;
