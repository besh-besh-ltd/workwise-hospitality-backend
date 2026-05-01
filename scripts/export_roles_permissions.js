/**
 * Export Users with Roles, Permissions, Scopes & Departments to Excel
 *
 * Queries the live database and produces an Excel workbook with:
 *   Sheet 1 — Users & Roles       (one row per user-role-scope assignment)
 *   Sheet 2 — Users & Permissions  (one row per user-permission with scope)
 *   Sheet 3 — Users & Departments  (one row per user-department)
 *   Sheet 4 — Roles Master         (all roles with their permissions)
 *   Sheet 5 — Departments Master   (all departments)
 *
 * Usage:  node scripts/export_roles_permissions.js
 * Output: scripts/users_roles_permissions.xlsx
 */

import dotenv from 'dotenv';
import pg from 'pg-promise';
import ExcelJS from 'exceljs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, 'users_roles_permissions.xlsx');

// ─── DB connection ──────────────────────────────────────────────────────────
const pgp = pg();
const db = pgp({
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  host: process.env.HOST,
  port: process.env.DATABASE_PORT,
  ssl: { rejectUnauthorized: false },
});

// ─── User-type label map ─────────────────────────────���──────────────────────
const USER_TYPE_LABELS = {
  1: 'Admin',
  2: 'Buyer / Procurement',
  3: 'Vendor',
  4: 'Vendor Sub-user',
  5: 'Subadmin',
  7: 'Company Admin',
  8: 'Top Management',
  9: 'Finance',
  10: 'Engineering',
};

// ─── Styling helpers ────────────────────────────────────────────────────────
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E79' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
const BORDER = {
  top: { style: 'thin' }, bottom: { style: 'thin' },
  left: { style: 'thin' }, right: { style: 'thin' },
};

function styleSheet(sheet) {
  // Headers
  const hdr = sheet.getRow(1);
  hdr.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.border = BORDER;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  hdr.height = 28;

  // Data rows
  sheet.eachRow((row, num) => {
    if (num === 1) return;
    row.eachCell(cell => {
      cell.border = BORDER;
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    if (num % 2 === 0) {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'EBF5FB' } };
      });
    }
  });

  // Auto-width
  sheet.columns.forEach(col => {
    let max = 12;
    col.eachCell({ includeEmpty: false }, cell => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 4, 55);
  });
}

// ─── Queries ──────────────────────────��─────────────────────────────────────

async function fetchUsersWithRoles() {
  return db.any(`
    SELECT
      u.id              AS user_id,
      u.name            AS user_name,
      u.email           AS user_email,
      u.mobile          AS user_mobile,
      u.user_type,
      u.status          AS user_status,
      r.id              AS role_id,
      r.title           AS role_name,
      r.description     AS role_description,
      CASE WHEN r.created_by IS NULL THEN 'System' ELSE 'Custom' END AS role_type,
      urs.company_id    AS scope_company_id,
      hc.name           AS scope_company_name,
      urs.hotel_id      AS scope_hotel_id,
      hh.name           AS scope_hotel_name,
      urs.department_id AS scope_department_id,
      COALESCE(dep.title, 'ALL') AS scope_department_name
    FROM tbl_users u
    JOIN tbl_user_role_scopes urs ON urs.user_id = u.id
    JOIN tbl_roles r             ON r.id = urs.role_id
    LEFT JOIN tbl_hospitality_companies hc ON hc.id = urs.company_id
    LEFT JOIN tbl_hospitality_company_hotels hh ON hh.id = urs.hotel_id
    LEFT JOIN tbl_department dep ON dep.id = urs.department_id
    WHERE u.is_deleted = 0
    ORDER BY u.name, r.title
  `);
}

async function fetchUsersWithPermissions() {
  return db.any(`
    SELECT
      u.id            AS user_id,
      u.name          AS user_name,
      u.email         AS user_email,
      u.user_type,
      r.title         AS role_name,
      p.resource,
      p.action,
      (p.resource || '.' || p.action) AS permission_key,
      urs.company_id  AS scope_company_id,
      hc.name         AS scope_company_name,
      urs.hotel_id    AS scope_hotel_id,
      hh.name         AS scope_hotel_name,
      urs.department_id AS scope_department_id,
      COALESCE(dep.title, 'ALL') AS scope_department_name
    FROM tbl_users u
    JOIN tbl_user_role_scopes urs   ON urs.user_id = u.id
    JOIN tbl_role_permissions rp    ON rp.role_id = urs.role_id
    JOIN tbl_permissions p          ON p.id = rp.permission_id
    JOIN tbl_roles r                ON r.id = urs.role_id
    LEFT JOIN tbl_hospitality_companies hc ON hc.id = urs.company_id
    LEFT JOIN tbl_hospitality_company_hotels hh ON hh.id = urs.hotel_id
    LEFT JOIN tbl_department dep ON dep.id = urs.department_id
    WHERE u.is_deleted = 0
    ORDER BY u.name, r.title, p.resource, p.action
  `);
}

async function fetchUsersWithDepartments() {
  return db.any(`
    SELECT
      u.id          AS user_id,
      u.name        AS user_name,
      u.email       AS user_email,
      u.user_type,
      d.id          AS department_id,
      d.title       AS department_name,
      d.access_type AS department_access_type
    FROM tbl_users u
    JOIN tbl_user_department ud ON ud.user_id = u.id
    JOIN tbl_department d       ON d.id = ud.department_id
    WHERE u.is_deleted = 0
    ORDER BY u.name, d.title
  `);
}

async function fetchRolesMaster() {
  return db.any(`
    SELECT
      r.id          AS role_id,
      r.title       AS role_name,
      r.description AS role_description,
      CASE WHEN r.created_by IS NULL THEN 'System' ELSE 'Custom' END AS role_type,
      COALESCE(
        STRING_AGG(p.resource || '.' || p.action, ', ' ORDER BY p.resource, p.action),
        '(no permissions)'
      ) AS permissions
    FROM tbl_roles r
    LEFT JOIN tbl_role_permissions rp ON rp.role_id = r.id
    LEFT JOIN tbl_permissions p       ON p.id = rp.permission_id
    GROUP BY r.id, r.title, r.description, r.created_by
    ORDER BY r.title
  `);
}

async function fetchDepartmentsMaster() {
  return db.any(`
    SELECT
      d.id,
      d.title,
      d.access_type,
      COUNT(ud.user_id) AS user_count
    FROM tbl_department d
    LEFT JOIN tbl_user_department ud ON ud.department_id = d.id
    GROUP BY d.id, d.title, d.access_type
    ORDER BY d.title
  `);
}

// ─── Build Excel ────────────────────────────────────────────────────────────

async function main() {
  console.log('Querying database...');

  const [usersRoles, usersPerms, usersDepts, rolesMaster, deptsMaster] = await Promise.all([
    fetchUsersWithRoles(),
    fetchUsersWithPermissions(),
    fetchUsersWithDepartments(),
    fetchRolesMaster(),
    fetchDepartmentsMaster(),
  ]);

  console.log(`  Users with roles:       ${usersRoles.length} rows`);
  console.log(`  Users with permissions: ${usersPerms.length} rows`);
  console.log(`  Users with departments: ${usersDepts.length} rows`);
  console.log(`  Roles master:           ${rolesMaster.length} rows`);
  console.log(`  Departments master:     ${deptsMaster.length} rows`);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Workwise Hospitality';
  wb.created = new Date();

  // ── Sheet 1: Users & Roles ──
  const s1 = wb.addWorksheet('Users & Roles');
  s1.columns = [
    { header: 'User ID',            key: 'user_id',              width: 10 },
    { header: 'Name',               key: 'user_name',            width: 22 },
    { header: 'Email',              key: 'user_email',           width: 30 },
    { header: 'Mobile',             key: 'user_mobile',          width: 16 },
    { header: 'User Type ID',       key: 'user_type',            width: 13 },
    { header: 'User Type',          key: 'user_type_label',      width: 20 },
    { header: 'Status',             key: 'user_status_label',    width: 10 },
    { header: 'Role ID',            key: 'role_id',              width: 10 },
    { header: 'Role Name',          key: 'role_name',            width: 22 },
    { header: 'Role Type',          key: 'role_type',            width: 12 },
    { header: 'Role Description',   key: 'role_description',     width: 35 },
    { header: 'Scope: Company ID',  key: 'scope_company_id',     width: 16 },
    { header: 'Scope: Company',     key: 'scope_company_name',   width: 25 },
    { header: 'Scope: Hotel ID',    key: 'scope_hotel_id',       width: 14 },
    { header: 'Scope: Hotel',       key: 'scope_hotel_name',     width: 25 },
    { header: 'Scope: Dept ID',     key: 'scope_department_id',  width: 14 },
    { header: 'Scope: Department',  key: 'scope_department_name', width: 20 },
  ];
  for (const r of usersRoles) {
    s1.addRow({
      ...r,
      user_type_label: USER_TYPE_LABELS[r.user_type] || `Type ${r.user_type}`,
      user_status_label: r.user_status === 1 ? 'Active' : 'Inactive',
    });
  }
  styleSheet(s1);
  s1.autoFilter = { from: 'A1', to: 'Q1' };

  // ── Sheet 2: Users & Permissions ──
  const s2 = wb.addWorksheet('Users & Permissions');
  s2.columns = [
    { header: 'User ID',           key: 'user_id',              width: 10 },
    { header: 'Name',              key: 'user_name',            width: 22 },
    { header: 'Email',             key: 'user_email',           width: 30 },
    { header: 'User Type',         key: 'user_type_label',      width: 20 },
    { header: 'Via Role',          key: 'role_name',            width: 22 },
    { header: 'Resource',          key: 'resource',             width: 16 },
    { header: 'Action',            key: 'action',               width: 12 },
    { header: 'Permission Key',    key: 'permission_key',       width: 24 },
    { header: 'Scope: Company',    key: 'scope_company_name',   width: 25 },
    { header: 'Scope: Hotel',      key: 'scope_hotel_name',     width: 25 },
    { header: 'Scope: Department', key: 'scope_department_name', width: 20 },
  ];
  for (const r of usersPerms) {
    s2.addRow({
      ...r,
      user_type_label: USER_TYPE_LABELS[r.user_type] || `Type ${r.user_type}`,
    });
  }
  styleSheet(s2);
  s2.autoFilter = { from: 'A1', to: 'K1' };

  // ── Sheet 3: Users & Departments ──
  const s3 = wb.addWorksheet('Users & Departments');
  s3.columns = [
    { header: 'User ID',                key: 'user_id',                 width: 10 },
    { header: 'Name',                   key: 'user_name',               width: 22 },
    { header: 'Email',                  key: 'user_email',              width: 30 },
    { header: 'User Type',              key: 'user_type_label',         width: 20 },
    { header: 'Department ID',          key: 'department_id',           width: 14 },
    { header: 'Department Name',        key: 'department_name',         width: 22 },
    { header: 'Department Access Type', key: 'department_access_type',  width: 22 },
  ];
  for (const r of usersDepts) {
    s3.addRow({
      ...r,
      user_type_label: USER_TYPE_LABELS[r.user_type] || `Type ${r.user_type}`,
    });
  }
  styleSheet(s3);
  s3.autoFilter = { from: 'A1', to: 'G1' };

  // ── Sheet 4: Roles Master ──
  const s4 = wb.addWorksheet('Roles Master');
  s4.columns = [
    { header: 'Role ID',     key: 'role_id',          width: 10 },
    { header: 'Role Name',   key: 'role_name',        width: 22 },
    { header: 'Type',        key: 'role_type',        width: 12 },
    { header: 'Description', key: 'role_description', width: 35 },
    { header: 'Permissions', key: 'permissions',      width: 80 },
  ];
  for (const r of rolesMaster) s4.addRow(r);
  styleSheet(s4);

  // ── Sheet 5: Departments Master ──
  const s5 = wb.addWorksheet('Departments Master');
  s5.columns = [
    { header: 'Department ID', key: 'id',           width: 14 },
    { header: 'Department',    key: 'title',        width: 22 },
    { header: 'Access Type',   key: 'access_type',  width: 16 },
    { header: 'User Count',    key: 'user_count',   width: 14 },
  ];
  for (const r of deptsMaster) s5.addRow(r);
  styleSheet(s5);

  // ── Write ──
  await wb.xlsx.writeFile(OUTPUT);
  console.log(`\nExcel exported to: ${OUTPUT}`);

  pgp.end();
}

main().catch(err => {
  console.error('Export failed:', err);
  pgp.end();
  process.exit(1);
});
