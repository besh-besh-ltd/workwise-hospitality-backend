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

  deleteUserRoleScopes: (userId) => {
    return db.none(
      `DELETE FROM tbl_user_role_scopes WHERE user_id = $1`,
      [userId]
    );
  },

  /* -------------------- ROLES -------------------- */

  getRoles: () => {
    return db.any(`
      SELECT id, title, description
      FROM tbl_roles
      ORDER BY title
    `);
  },

  getPermissionsByRoleId: (roleId) => {
    return db.any(`
      SELECT p.id, p.resource, p.action
      FROM tbl_role_permissions rp
      JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1
    `, [roleId]);
  },
  createRole: async ({ title, description }) => {
    const [role] = await db.any(
      `
      INSERT INTO tbl_roles (title, description)
      VALUES ($1, $2)
      RETURNING id, title
      `,
      [title.trim(), description || null]
    );

    return role;
  },
  assignPermissionsToRole: async (roleId, permissionIds = []) => {
    if (!permissionIds.length) return;

    return db.tx(t =>
      t.batch(
        permissionIds.map(pid =>
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
  }

};

export default rbacModel;
