/**
 * Role-scope tuples, made readable for the activity trail.
 *
 * `update_user_detail` already computes exactly which (role, unit, department,
 * process) grants a save adds and removes — it needs them to hand pending
 * approvals to the right people. Until now none of it reached the trail, so a
 * change to who approves a business unit's purchase orders read only "X updated
 * a user account", and changes by an administrator without a hospitality
 * mapping were not recorded at all. RFQ 536263's step-2 approver changed that
 * way on 15 Sep and the only surviving record was raw rows in the audit table.
 *
 * Tuples arrive in the controller's diff shape, where 0 stands for "none"
 * (company-wide, every department, every process).
 */
import db from '../../config/dbConn.js';

const idOrNull = (v) => (v === undefined || v === null || Number(v) === 0 ? null : Number(v));

const lookup = async (sql, ids) => {
  if (ids.length === 0) return new Map();
  const rows = await db.any(sql, [ids]);
  return new Map(rows.map((r) => [Number(r.id), r.label]));
};

/**
 * @param {Array<{role_id, company_id, hotel_id, department_id, process_id}>} scopes
 * @returns {Promise<Array<{role_id, role, company_id, hotel_id, hotel,
 *                          department_id, department, process_id, process}>>}
 */
export async function labelRoleScopes(scopes = []) {
  const items = scopes.map((s) => ({
    role_id: Number(s.role_id),
    company_id: idOrNull(s.company_id),
    hotel_id: idOrNull(s.hotel_id),
    department_id: idOrNull(s.department_id),
    process_id: idOrNull(s.process_id),
  }));
  if (items.length === 0) return [];

  const ids = (key) => [...new Set(items.map((i) => i[key]).filter((v) => v !== null))];
  const [roles, hotels, departments, processes] = await Promise.all([
    lookup('SELECT id, title AS label FROM tbl_roles WHERE id = ANY($1::int[])', ids('role_id')),
    lookup('SELECT id, name AS label FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[])', ids('hotel_id')),
    lookup('SELECT id, title AS label FROM tbl_department WHERE id = ANY($1::int[])', ids('department_id')),
    lookup('SELECT id, name AS label FROM tbl_approval_processes WHERE id = ANY($1::int[])', ids('process_id')),
  ]);

  return items.map((i) => ({
    role_id: i.role_id,
    role: roles.get(i.role_id) || `role #${i.role_id}`,
    company_id: i.company_id,
    hotel_id: i.hotel_id,
    hotel: i.hotel_id === null ? null : hotels.get(i.hotel_id) || `unit #${i.hotel_id}`,
    department_id: i.department_id,
    department: i.department_id === null ? null : departments.get(i.department_id) || `department #${i.department_id}`,
    process_id: i.process_id,
    process: i.process_id === null ? null : processes.get(i.process_id) || `process #${i.process_id}`,
  }));
}
