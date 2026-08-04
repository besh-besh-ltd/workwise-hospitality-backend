// Runtime grant/revoke of tbl_user_role_scopes rows for tests.
//
// Fixture users each carry ONE role. Several product behaviours need a user
// with two: the RFQ listing gates on rfq.read (roles 2 / 4) while the
// "Awaiting your evaluation" group gates on quote-compare.read + .create
// (role 8, which carries NO rfq.read). A user holding only role 8 never
// reaches the listing at all, so an evaluation test built on such a user
// would assert on a row that is never returned.
//
// This mirrors production: the reporting user holds role 8 for the evaluation
// permission plus roles 17/18 for rfq.read.
//
// Always revoke in afterEach — these rows are global and would otherwise leak
// across suites sharing the Jest process (maxWorkers is 1).

/**
 * @param {object} t pg-promise db or transaction
 * @param {object} opts
 * @param {number} opts.userId
 * @param {number} opts.roleId
 * @param {number} opts.companyId  tbl_hospitality_companies.id
 * @param {number|null} [opts.hotelId]
 * @param {number|null} [opts.departmentId]
 * @param {number|null} [opts.processId]
 * @returns {Promise<number>} the new tbl_user_role_scopes.id
 */
export async function grantRoleScope(t, opts) {
  const row = await t.one(
    `INSERT INTO tbl_user_role_scopes
       (user_id, role_id, company_id, hotel_id, department_id, process_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      opts.userId,
      opts.roleId,
      opts.companyId,
      opts.hotelId ?? null,
      opts.departmentId ?? null,
      opts.processId ?? null,
    ]
  );
  return Number(row.id);
}

/**
 * @param {object} t pg-promise db or transaction
 * @param {number[]} ids
 */
export async function revokeRoleScopes(t, ids) {
  if (!ids || !ids.length) return;
  await t.none(`DELETE FROM tbl_user_role_scopes WHERE id = ANY($1::int[])`, [ids]);
}

export default { grantRoleScope, revokeRoleScopes };
