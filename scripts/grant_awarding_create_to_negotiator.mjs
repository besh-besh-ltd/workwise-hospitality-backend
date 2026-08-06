#!/usr/bin/env node
/**
 * Grant `awarding.create` to the "Commercial Negotiator N1" role.
 *
 * WHY
 * ---
 * Finalising a vendor (`quote-compare.create`) is what CREATES a PO draft, but
 * initiating that draft requires `awarding.create`. Only three roles grant
 * `quote-compare.create` — CEO, Company CEO and Commercial Negotiator N1 — and
 * the first two already carry `awarding.create`. Commercial Negotiator N1 does
 * not, so the people who actually award POs cannot move them forward.
 *
 * Measured on production before writing this:
 *   53 users can finalise · 32 can initiate · 49 can finalise but NOT initiate
 *   all 49 of those hold Commercial Negotiator N1  -> this grant fixes 100%
 *   all 51 CN1 users already hold awarding.read / rfq.read / boq.read, so the
 *   server's PO scope guard (PO_SCOPE_PERMISSIONS) is already satisfied and the
 *   grant cannot produce a button that 403s.
 *
 * WHAT IT DOES
 * ------------
 * Inserts exactly one row into tbl_role_permissions: (role 'Commercial
 * Negotiator N1', permission 'awarding.create'). Nothing else. It does not
 * touch tbl_user_role_scopes, so each user gains the permission only at the
 * hotels where they already hold the role — the existing scoping is preserved.
 *
 * SAFETY
 * ------
 *   - DRY RUN BY DEFAULT. Pass --apply to write.
 *   - Idempotent: re-running after a successful apply is a no-op.
 *   - Resolves role and permission BY NAME, not by hard-coded id, and aborts if
 *     either is missing or ambiguous.
 *   - Wrapped in a transaction and verified inside it before COMMIT.
 *   - Prints the affected-user count before and after.
 *
 * USAGE
 * -----
 *   node scripts/grant_awarding_create_to_negotiator.mjs            # dry run
 *   node scripts/grant_awarding_create_to_negotiator.mjs --apply    # write
 *
 * Reads DB config from the same env vars as the app (see .env).
 *
 * TO REVERSE
 * ----------
 *   DELETE FROM tbl_role_permissions
 *    WHERE role_id = (SELECT id FROM tbl_roles WHERE title = 'Commercial Negotiator N1')
 *      AND permission_id = (SELECT id FROM tbl_permissions WHERE resource='awarding' AND action='create');
 */

import 'dotenv/config';
import pgPromise from 'pg-promise';

const ROLE_TITLE = 'Commercial Negotiator N1';
const RESOURCE = 'awarding';
const ACTION = 'create';

const APPLY = process.argv.includes('--apply');

const pgp = pgPromise();
const db = pgp({
  host: process.env.HOST,
  port: Number(process.env.DATABASE_PORT) || 5432,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  // Mirrors app/config/dbConn.js — RDS requires TLS.
  ssl: process.env.TEST_DB_NO_SSL === '1' ? false : { rejectUnauthorized: false },
  max: 2,
});

const line = () => console.log('─'.repeat(72));

/** Users who can finalise (create a PO draft) but cannot initiate it. */
const STRANDED_SQL = `
  WITH perms AS (
    SELECT urs.user_id, p.resource, p.action::text AS action
      FROM tbl_user_role_scopes urs
      JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
      JOIN tbl_permissions p       ON p.id       = rp.permission_id
  )
  SELECT COUNT(DISTINCT user_id)::int AS n
    FROM perms
   WHERE resource = 'quote-compare' AND action = 'create'
     AND user_id NOT IN (
       SELECT user_id FROM perms
        WHERE resource = 'awarding' AND action IN ('create','update')
     )`;

async function main() {
  const dbName = (await db.one('SELECT current_database() AS db')).db;
  line();
  console.log(`  Grant ${RESOURCE}.${ACTION} -> "${ROLE_TITLE}"`);
  console.log(`  database : ${dbName}`);
  console.log(`  mode     : ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no changes)'}`);
  line();

  // Resolve by name; refuse to guess.
  const roles = await db.any('SELECT id, title FROM tbl_roles WHERE title = $1', [ROLE_TITLE]);
  if (roles.length !== 1) {
    throw new Error(`Expected exactly 1 role titled "${ROLE_TITLE}", found ${roles.length}. Aborting.`);
  }
  const perms = await db.any(
    'SELECT id FROM tbl_permissions WHERE resource = $1 AND action = $2',
    [RESOURCE, ACTION]
  );
  if (perms.length !== 1) {
    throw new Error(`Expected exactly 1 permission ${RESOURCE}.${ACTION}, found ${perms.length}. Aborting.`);
  }

  const roleId = roles[0].id;
  const permissionId = perms[0].id;
  console.log(`  role_id=${roleId}  permission_id=${permissionId}`);

  const existing = await db.oneOrNone(
    'SELECT id FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2',
    [roleId, permissionId]
  );
  const strandedBefore = (await db.one(STRANDED_SQL)).n;
  const roleUsers = (await db.one(
    'SELECT COUNT(DISTINCT user_id)::int AS n FROM tbl_user_role_scopes WHERE role_id = $1',
    [roleId]
  )).n;

  console.log(`  users holding the role      : ${roleUsers}`);
  console.log(`  can finalise, cannot initiate: ${strandedBefore}`);
  line();

  if (existing) {
    console.log('  Already granted (row id ' + existing.id + '). Nothing to do.');
    line();
    return;
  }

  if (!APPLY) {
    console.log('  DRY RUN — would INSERT INTO tbl_role_permissions (role_id, permission_id)');
    console.log(`                 VALUES (${roleId}, ${permissionId});`);
    console.log('');
    console.log('  Re-run with --apply to write.');
    line();
    return;
  }

  await db.tx(async (t) => {
    await t.none(
      'INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2)',
      [roleId, permissionId]
    );
    // Verify inside the transaction; throwing here rolls back.
    const check = await t.oneOrNone(
      'SELECT id FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2',
      [roleId, permissionId]
    );
    if (!check) throw new Error('Post-insert verification failed — rolling back.');
    console.log(`  INSERTED row id ${check.id}`);
  });

  const strandedAfter = (await db.one(STRANDED_SQL)).n;
  console.log(`  can finalise, cannot initiate: ${strandedBefore} -> ${strandedAfter}`);
  line();
  console.log('  Done. Users must re-login (or their permission cache expire) to see the change.');
  line();
}

main()
  .catch((err) => {
    console.error('\n  FAILED:', err.message, '\n');
    process.exitCode = 1;
  })
  .finally(() => pgp.end());
