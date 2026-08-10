// Shared fixture: makes a user eligible to be RESOLVED as an ARC approver.
//
// USER-source approval steps are permission-gated at instance creation: a user
// named on a step whose resource they hold no read+approve for has that step
// DROPPED, and a policy whose every step drops is REFUSED (the request 400s
// rather than silently producing an instance nobody can act on).
//
// Suites that seed their own `('USER', someFixtureUser)` policy steps therefore
// have to give that user the matching ARC permissions, exactly as production
// would. Call this after seeding the policy.
//
// Deliberately DEDICATED roles rather than system roles such as 'ARC Approver':
// no policy in these suites names them, so granting them cannot change any
// ROLE-source approver set the suites assert on. They grant only read +
// approve — never `evaluate` — so requireArcPermission gates on the
// /evaluation endpoints keep behaving as before (see arcEvalPerms.js).
//
// One role PER RESOURCE, not one role for all four. The roles are shared across
// suites (they run sequentially against one database), so a single role would
// accumulate every resource any suite ever asked for, and a caller that wanted
// only `arc-tech` would silently receive all four. Per-resource roles keep each
// grant exactly as narrow as it was requested.

import { db as sharedDb } from "../setup/db.js";

const ROLE_ID_BY_RESOURCE = {
  "arc": 89301,
  "arc-tech": 89302,
  "arc-comm": 89303,
  "arc-committee": 89304,
  // Not ARC resources, but reached through the same gate by suites in this
  // area: MR and PO entity types map to `awarding`, RFQ maps to `rfq`.
  // See ENTITY_APPROVE_RESOURCE_MAP in app/models/generalModel.js.
  "awarding": 89305,
  "rfq": 89306,
};
const ARC_RESOURCES = ["arc", "arc-tech", "arc-comm", "arc-committee"];

/**
 * @param db            pg-promise db/tx
 * @param userIds       number | number[] — the users named on USER-source steps
 * @param hospitality   hospitality company id the policy belongs to
 * @param hotel         hotel id, or null for a company-wide grant (default)
 * @param resources     optional subset of ARC resources to grant. Defaults to
 *                      all four, which is fine for suites that only care that
 *                      the approver resolves. Suites that assert an EXACT
 *                      permissions payload (e.g. the lifecycle `permissions`
 *                      block) should pass just the resource their policy's
 *                      entity_type maps to, so the grant stays legible in the
 *                      assertion instead of blanketing all four.
 * @param department    optional department id to scope the grant to. Pass this
 *                      whenever the suite also asserts DEPARTMENT scoping: a
 *                      department-NULL row covers every department, so an
 *                      unscoped grant silently widens the user's reach and a
 *                      "refuses a department they have no scope for" test
 *                      starts returning 200. The resolver accepts a
 *                      department-scoped row for that department, so narrowing
 *                      it costs nothing.
 */
export async function ensureArcApprovable(
  db, userIds, hospitality, hotel = null, resources = ARC_RESOURCES, department = null
) {
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  if (!ids.length) return;

  for (const resource of resources) {
    const roleId = ROLE_ID_BY_RESOURCE[resource];
    if (!roleId) throw new Error(`ensureArcApprovable: unknown ARC resource '${resource}'`);

    await db.none(
      `INSERT INTO tbl_roles (id, title, description, created_by)
       VALUES ($1, $2, 'read+approve for USER-source approval steps', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [roleId, `ARC Approver Eligibility Fixture (${resource})`]
    );

    // Selected from tbl_permissions rather than inserted at fixed ids, so this
    // tracks whatever the schema seed actually defines for these resources.
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, p.id FROM tbl_permissions p
        WHERE p.resource::text = $2
          AND p.action IN ('read', 'approve')
          AND NOT EXISTS (SELECT 1 FROM tbl_role_permissions rp
                          WHERE rp.role_id = $1 AND rp.permission_id = p.id)`,
      [roleId, resource]
    );

    for (const userId of ids) {
      await db.none(
        `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
         SELECT $1, $2, $3, $4, $5, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM tbl_user_role_scopes s
             WHERE s.user_id = $1 AND s.role_id = $2 AND s.company_id = $3
               AND s.hotel_id IS NOT DISTINCT FROM $4
               AND s.department_id IS NOT DISTINCT FROM $5
               AND s.process_id IS NULL)`,
        [userId, roleId, hospitality, hotel, department]
      );
    }
  }
}

/**
 * Same thing for a non-ARC resource — `awarding` (MR / PO entity types) or
 * `rfq`. Spelled separately so the call site names the resource explicitly.
 */
export async function ensureApprovable(
  db, userIds, resource, hospitality, hotel = null, department = null
) {
  return ensureArcApprovable(db, userIds, hospitality, hotel, [resource], department);
}

export async function cleanupArcApprovable(db) {
  const roleIds = Object.values(ROLE_ID_BY_RESOURCE);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = ANY($1::int[])`, [roleIds]);
  await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = ANY($1::int[])`, [roleIds]);
  await db.none(`DELETE FROM tbl_roles WHERE id = ANY($1::int[])`, [roleIds]);
}

// Self-cleaning. These grants MUST NOT outlive the suite that made them: a
// company-wide (department-NULL) grant makes a department-scoped user look
// company-wide, and a later suite asserting "a department-scoped user sees ONLY
// their department" then fails — a contamination that reproduces only in a full
// shard run, never when that suite runs alone.
//
// Registered at import time (module scope of the importing test file), which is
// the one place Jest allows hook registration. Suites run sequentially
// (maxWorkers: 1), so tearing the roles down after each file is safe: every
// suite re-seeds what it needs in its own beforeAll.
if (typeof afterAll === "function") {
  afterAll(async () => {
    await cleanupArcApprovable(sharedDb);
  });
}
