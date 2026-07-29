// Grants a user the full set of ARC module roles so every lifecycle tab is
// visible and actionable. Idempotent — safe to re-run.
//
//   node scripts/grant_arc_access.js <email> [hospitalityCompanyId]
//   node scripts/grant_arc_access.js kushal+hospi@letsworkwise.com 13
//
// Grants COMPANY-WIDE scopes (hotel NULL, department NULL) for these roles:
//   ARC Creator              → arc.read, arc.create, arc-tech.read, arc-comm.read
//   ARC Tech Evaluator       → arc-tech.read, arc-tech.evaluate
//   ARC Commercial Evaluator → arc-tech.read, arc-comm.read, arc-comm.evaluate
//   ARC Committee Member     → arc-tech.read, arc-comm.read, arc-committee.read/approve
// (Deliberately NOT "ARC Admin" — arc.admin overrides every per-tab check,
//  which defeats permission-variant testing. Pass --admin to add it anyway.)

import db from '../app/config/dbConn.js';

const ROLE_TITLES = ['ARC Creator', 'ARC Tech Evaluator', 'ARC Commercial Evaluator', 'ARC Committee Member'];

async function main() {
  const email = process.argv[2];
  const companyId = Number(process.argv[3] || 13);
  const withAdmin = process.argv.includes('--admin');
  if (!email) {
    console.error('Usage: node scripts/grant_arc_access.js <email> [hospitalityCompanyId] [--admin]');
    process.exit(1);
  }

  const user = await db.oneOrNone(`SELECT id, name, email FROM tbl_users WHERE email = $1`, [email]);
  if (!user) { console.error(`No user with email ${email}`); process.exit(1); }
  console.log(`User: #${user.id} ${user.name} <${user.email}> — company ${companyId}`);

  const titles = withAdmin ? [...ROLE_TITLES, 'ARC Admin'] : ROLE_TITLES;
  const roles = await db.any(`SELECT id, title FROM tbl_roles WHERE title IN ($1:csv) ORDER BY id`, [titles]);
  const missing = titles.filter((t) => !roles.some((r) => r.title === t));
  if (missing.length) console.warn(`Roles not found (skipped): ${missing.join(', ')}`);

  for (const role of roles) {
    const existing = await db.oneOrNone(
      `SELECT id FROM tbl_user_role_scopes
        WHERE user_id = $1 AND role_id = $2 AND company_id = $3
          AND hotel_id IS NULL AND department_id IS NULL`,
      [user.id, role.id, companyId]
    );
    if (existing) {
      console.log(`  = already scoped: ${role.title} (scope #${existing.id})`);
      continue;
    }
    const row = await db.one(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, NULL, NULL) RETURNING id`,
      [user.id, role.id, companyId]
    );
    console.log(`  + granted: ${role.title} (scope #${row.id})`);
  }

  // Show the effective ARC permission set the lifecycle endpoint will compute.
  const perms = await db.any(
    `SELECT DISTINCT p.resource, p.action
       FROM tbl_user_role_scopes urs
       JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE urs.user_id = $1 AND urs.company_id = $2 AND p.resource::text LIKE 'arc%'
      ORDER BY p.resource, p.action`,
    [user.id, companyId]
  );
  console.log('Effective ARC permissions in this company:');
  for (const p of perms) console.log(`  · ${p.resource}.${p.action}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
