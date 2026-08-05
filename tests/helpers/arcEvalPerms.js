// Shared fixture: ARC evaluation permissions for suites that exercise the
// /arc-v2/evaluation endpoints, which are gated by requireArcPermission
// (arc-tech.* / arc-comm.* in the ARC's own hotel scope).
//
// Seeds a single fixture role holding arc-tech.read/evaluate and
// arc-comm.read/evaluate, then scopes it to the given users at the given
// hotel (department NULL = matches any). IDs sit in the 951xx block so they
// can't collide with staging-seeded rows or other suites' fixtures (suites
// run sequentially with maxWorkers:1; ON CONFLICT keeps re-seeding benign).
import { IDS } from "../fixtures/ids.js";

const ROLE_ID = 95100;
const PERMS = [
  { id: 95101, resource: "arc-tech", action: "read" },
  { id: 95102, resource: "arc-tech", action: "evaluate" },
  { id: 95103, resource: "arc-comm", action: "read" },
  { id: 95104, resource: "arc-comm", action: "evaluate" },
];
const SCOPE_ID_BASE = 95110;

export async function seedArcEvalPerms(db, userIds, {
  hospitality = IDS.hospitality.A,
  hotel = IDS.hotels.A1,
} = {}) {
  for (const p of PERMS) {
    await db.none(
      `INSERT INTO tbl_permissions (id, resource, action, ordering)
       VALUES ($1, $2, $3, 0) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.resource, p.action]
    );
  }
  await db.none(
    `INSERT INTO tbl_roles (id, title, description, created_by)
     VALUES ($1, 'ARC Eval Fixture', 'arc evaluation test fixture', NULL)
     ON CONFLICT (id) DO NOTHING`, [ROLE_ID]
  );
  for (const p of PERMS) {
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, $2 WHERE NOT EXISTS
         (SELECT 1 FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2)`,
      [ROLE_ID, p.id]
    );
  }
  for (let i = 0; i < userIds.length; i++) {
    await db.none(
      `INSERT INTO tbl_user_role_scopes (id, user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (id) DO NOTHING`,
      [SCOPE_ID_BASE + i, userIds[i], ROLE_ID, hospitality, hotel]
    );
  }
}

export async function cleanupArcEvalPerms(db, userIds) {
  const scopeIds = userIds.map((_, i) => SCOPE_ID_BASE + i);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = ANY($1::int[])`, [scopeIds]);
  await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [ROLE_ID]);
  await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [ROLE_ID]);
  await db.none(`DELETE FROM tbl_permissions WHERE id = ANY($1::int[])`, [PERMS.map((p) => p.id)]);
}
