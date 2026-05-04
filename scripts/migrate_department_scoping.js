/**
 * Department Scoping Migration Script
 *
 * Migrates user role scopes and schema to the simplified department model:
 *   - department_id = NULL means literally ALL departments (no tbl_user_department cross-check)
 *   - is_department_scoped column removed from tbl_approval_policies
 *   - access_type column removed from tbl_department
 *
 * Rules:
 *   0. Tender Creator (role_id=2) with specific dept → NULL (needs all-dept access always)
 *   1. Trio-dept users (Purchase=1, GM=7, Corporate=15) with specific dept scopes → NULL
 *      EXCEPT Technical Evaluator (6) and Technical Approver (7) — these keep specific dept
 *   1b. Trio-dept users with Technical roles at NULL → expand to user's mapped departments
 *   2. Trio-dept users with NULL scopes (non-technical) → keep NULL (already correct)
 *   3. Non-trio users with NULL scopes → expand into explicit per-department rows
 *      (excludes Tender Creator which must stay NULL)
 *   4. Drop is_department_scoped from tbl_approval_policies
 *   5. Drop access_type from tbl_department
 *
 * Both --dry-run and live execution generate the SAME Excel report
 * (scripts/migration_report.xlsx). Dry-run runs the full migration in a
 * transaction and rolls it back at the end — the DB is untouched but the
 * changelog records exactly what live mode would do.
 *
 * The Excel has three sheets:
 *   • Changes      — every (user, role, old scope, new scope, action) row
 *   • User Summary — per-user totals + which rules touched them
 *   • Rules Legend — plain-English description of each rule
 *
 * IMPORTANT — before running this script (dry-run or live):
 *   1. Stop the backend application. Rules 4 & 5 take ACCESS EXCLUSIVE locks
 *      on tbl_approval_policies and tbl_department — every running API request
 *      that reads these tables will block the migration indefinitely.
 *   2. Close any DB GUI sessions (DBeaver, pgAdmin) that have open transactions
 *      on these tables.
 *   3. The transaction sets lock_timeout = '30s' as a safety net. If the
 *      migration fails with "canceling statement due to lock timeout", that's
 *      the lock contention surfacing. Run `SELECT pid, state, query FROM
 *      pg_stat_activity WHERE state != 'idle'` from another session to find
 *      the blocking process.
 *
 * Usage:  node scripts/migrate_department_scoping.js [--dry-run]
 */

import dotenv from 'dotenv';
import pg from 'pg-promise';
import ExcelJS from 'exceljs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, 'migration_report.xlsx');

const pgp = pg();
const db = pgp({
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  host: process.env.HOST,
  port: process.env.DATABASE_PORT,
  ssl: { rejectUnauthorized: false },
});

const TRIO_DEPT_IDS = [1, 7, 15]; // Purchase, GM, Corporate
const TENDER_CREATOR_ROLE_ID = 2;
const TECHNICAL_ROLE_IDS = [6, 7]; // Technical Evaluator, Technical Approver
const DRY_RUN = process.argv.includes('--dry-run');

// Sentinel error: thrown at the end of the dry-run transaction so pg-promise
// rolls everything back. Distinct from a real error so main() can tell them
// apart and not exit non-zero on a successful dry run.
const DRY_RUN_ROLLBACK = '__DRY_RUN_ROLLBACK__';

// Changelog: every change is recorded here for the Excel export. Both dry-run
// and live populate this from the same rule functions.
const changelog = [];

// SQL fragment that fetches every column needed to fully describe a
// tbl_user_role_scopes row in the report — user info, role, full scope
// (company name, hotel name, old dept name) plus the user's department
// memberships as a single comma-separated string.
const SCOPE_COLUMNS = `
  urs.id                                                   AS scope_id,
  urs.user_id,
  u.name                                                   AS user_name,
  u.email                                                  AS user_email,
  (SELECT string_agg(d2.title, ', ' ORDER BY d2.title)
     FROM tbl_user_department ud2
     JOIN tbl_department d2 ON d2.id = ud2.department_id
    WHERE ud2.user_id = urs.user_id)                       AS user_departments,
  urs.role_id,
  r.title                                                  AS role_title,
  urs.company_id,
  (SELECT name FROM tbl_hospitality_companies
    WHERE id = urs.company_id)                             AS company_name,
  urs.hotel_id,
  (SELECT name FROM tbl_hospitality_company_hotels
    WHERE id = urs.hotel_id)                               AS hotel_name,
  urs.department_id                                        AS old_department_id,
  d_old.title                                              AS old_department_name
`;

const SCOPE_JOINS = `
  JOIN tbl_users u           ON u.id = urs.user_id
  JOIN tbl_roles r           ON r.id = urs.role_id
  LEFT JOIN tbl_department d_old ON d_old.id = urs.department_id
`;

// Renders a (company, hotel, department) triple into a human-readable string
// for the Old Scope / New Scope columns in the Excel.
function formatScope({ company_id, company_name, hotel_id, hotel_name, department_id, department_name }) {
  const co = company_name || (company_id ? `company#${company_id}` : '—');
  const ht = hotel_name || (hotel_id ? `hotel#${hotel_id}` : 'all hotels');
  const dp = department_id ? (department_name || `dept#${department_id}`) : 'All Departments';
  return `${co} / ${ht} / ${dp}`;
}

function logChange(entry) {
  const row = {
    user_id: entry.user_id,
    user_name: entry.user_name || '',
    user_email: entry.user_email || '',
    user_departments: entry.user_departments || '',
    rule: entry.rule,
    action: entry.action,
    role_id: entry.role_id,
    role_title: entry.role_title || '',
    company_id: entry.company_id ?? '',
    company_name: entry.company_name || '',
    hotel_id: entry.hotel_id ?? '',
    hotel_name: entry.hotel_name || '',
    old_department_id: entry.old_department_id ?? '',
    old_department_name: entry.old_department_name || (entry.old_department_id ? '' : 'All Departments'),
    new_department_id: entry.new_department_id ?? '',
    new_department_name: entry.new_department_name || (entry.new_department_id ? '' : 'All Departments'),
  };
  row.old_scope = formatScope({
    company_id: entry.company_id, company_name: entry.company_name,
    hotel_id: entry.hotel_id, hotel_name: entry.hotel_name,
    department_id: entry.old_department_id, department_name: entry.old_department_name,
  });
  row.new_scope = formatScope({
    company_id: entry.company_id, company_name: entry.company_name,
    hotel_id: entry.hotel_id, hotel_name: entry.hotel_name,
    department_id: entry.new_department_id, department_name: entry.new_department_name,
  });
  changelog.push(row);
}

// Wraps a rule function with start/end logs + duration so the operator can see
// exactly which rule is running and how long it took. If a rule hangs, the
// caller sees "▶ <rule> starting…" with no matching "✓" line.
async function runRule(name, fn) {
  console.log(`▶ ${name} starting…`);
  const start = Date.now();
  await fn();
  const ms = Date.now() - start;
  console.log(`✓ ${name} done in ${ms}ms`);
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  Department Scoping Migration');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (transaction will be rolled back)' : 'LIVE'}`);
  console.log(`${'='.repeat(60)}\n`);

  await printCurrentState();

  let migrationFailed = false;

  try {
    await db.tx(async (t) => {
      // Fail fast on lock contention instead of hanging forever. Rules 4 & 5
      // take ACCESS EXCLUSIVE locks via DROP COLUMN; if the backend or another
      // session is reading these tables, the DDL will queue. 30s is plenty for
      // a clean migration run, short enough that "stuck on lock" surfaces as a
      // clear error rather than an indefinite freeze.
      await t.none(`SET LOCAL lock_timeout = '30s'`);
      // Statement timeout as a second safety net for any individual SELECT/UPDATE
      // that might pathologically scan. Tune up if your dataset is huge.
      await t.none(`SET LOCAL statement_timeout = '5min'`);

      await runRule('Rule 0  — Tender Creator specific dept → NULL',           () => rule0_tenderCreatorToNull(t));
      await runRule('Rule 0d — dedup Tender Creator NULL rows',                 () => rule0_deduplicate(t));
      await runRule('Rule 1  — trio-user non-technical specific → NULL',        () => rule1_trioSpecificToNull(t));
      await runRule('Rule 1d — dedup NULL-scope rows',                          () => rule1_deduplicate(t));
      await runRule('Rule 1b — trio-technical NULL → expand to mapped depts',   () => rule1b_trioTechnicalExpand(t));
      await runRule('Rule 3  — non-trio NULL → expand to mapped depts',         () => rule3_expandNonTrioNull(t));
      await runRule('Rule 4  — DROP tbl_approval_policies.is_department_scoped',() => rule4_dropIsDepartmentScoped(t));
      await runRule('Rule 5  — DROP tbl_department.access_type',                () => rule5_dropAccessType(t));

      if (DRY_RUN) {
        // Forces pg-promise to roll back. Caught below so the dry-run path
        // still generates the report and exits cleanly.
        throw new Error(DRY_RUN_ROLLBACK);
      }
    });

    if (!DRY_RUN) {
      console.log('\n✓ Migration committed successfully.\n');
    }
  } catch (err) {
    if (err.message === DRY_RUN_ROLLBACK) {
      console.log('\n✓ Dry run complete — transaction rolled back, no DB changes persisted.\n');
    } else {
      migrationFailed = true;
      console.error('\n✗ Migration FAILED — transaction rolled back.\n');
      console.error('   Error:', err.message);
      if (/lock_timeout|statement_timeout|canceling statement/i.test(err.message || '')) {
        console.error('\n   This looks like a lock or statement timeout.');
        console.error('   Most likely cause: another session is holding locks on the affected tables.');
        console.error('   To find the blocker, run from a separate psql session:');
        console.error(`     SELECT pid, state, wait_event_type, wait_event, query`);
        console.error(`     FROM pg_stat_activity`);
        console.error(`     WHERE state != 'idle' OR wait_event IS NOT NULL`);
        console.error(`     ORDER BY query_start;`);
        console.error('   Stop the backend app + DB GUI sessions, then retry.\n');
      }
    }
  }

  await printCurrentState();

  // Always emit the Excel — both dry-run and live. Even on a failed live run,
  // the changelog up to the failure point is useful for triage.
  try {
    await generateReport();
    console.log(`✓ Report saved to: ${OUTPUT}\n`);
  } catch (reportErr) {
    console.error('Failed to write Excel report:', reportErr.message);
  }

  pgp.end();
  if (migrationFailed) process.exit(1);
}

// ─── Pre-flight state ───────────────────────────────────────────────────────

async function printCurrentState() {
  const totalScopes = await db.one('SELECT COUNT(*) AS cnt FROM tbl_user_role_scopes');
  const nullScopes = await db.one('SELECT COUNT(*) AS cnt FROM tbl_user_role_scopes WHERE department_id IS NULL');
  const specificScopes = await db.one('SELECT COUNT(*) AS cnt FROM tbl_user_role_scopes WHERE department_id IS NOT NULL');

  console.log('Current state of tbl_user_role_scopes:');
  console.log(`  Total rows:                ${totalScopes.cnt}`);
  console.log(`  department_id IS NULL:     ${nullScopes.cnt}`);
  console.log(`  department_id IS NOT NULL: ${specificScopes.cnt}`);

  const hasDeptScoped = await db.oneOrNone(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tbl_approval_policies' AND column_name = 'is_department_scoped'
  `);
  const hasAccessType = await db.oneOrNone(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tbl_department' AND column_name = 'access_type'
  `);
  console.log(`  tbl_approval_policies.is_department_scoped: ${hasDeptScoped ? 'EXISTS' : 'DROPPED'}`);
  console.log(`  tbl_department.access_type:                 ${hasAccessType ? 'EXISTS' : 'DROPPED'}`);
  console.log('');
}

// ─── Rule 0: Tender Creator specific dept → NULL ────────────────────────────

async function rule0_tenderCreatorToNull(t) {
  const rows = await t.any(`
    SELECT ${SCOPE_COLUMNS}
    FROM tbl_user_role_scopes urs
    ${SCOPE_JOINS}
    WHERE urs.role_id = $1 AND urs.department_id IS NOT NULL
  `, [TENDER_CREATOR_ROLE_ID]);

  for (const r of rows) {
    logChange({
      ...r,
      rule: 'Rule 0',
      action: 'SCOPE_TO_NULL',
      new_department_id: null,
      new_department_name: 'All Departments',
    });
  }

  const result = await t.result(`
    UPDATE tbl_user_role_scopes SET department_id = NULL
    WHERE role_id = $1 AND department_id IS NOT NULL
  `, [TENDER_CREATOR_ROLE_ID]);
  console.log(`   Rule 0:  ${result.rowCount} Tender Creator scopes → NULL`);
}

async function rule0_deduplicate(t) {
  // Capture rows about to be deleted (with full context) before deleting.
  const dupes = await t.any(`
    WITH ranked AS (
      SELECT urs.id,
             ROW_NUMBER() OVER (
               PARTITION BY urs.user_id, urs.role_id, urs.company_id, urs.hotel_id, urs.department_id
               ORDER BY urs.id
             ) AS rn
      FROM tbl_user_role_scopes urs
      WHERE urs.role_id = $1 AND urs.department_id IS NULL
    )
    SELECT ${SCOPE_COLUMNS}
    FROM tbl_user_role_scopes urs
    ${SCOPE_JOINS}
    JOIN ranked rk ON rk.id = urs.id AND rk.rn > 1
  `, [TENDER_CREATOR_ROLE_ID]);

  for (const r of dupes) {
    logChange({
      ...r,
      rule: 'Rule 0 dedup',
      action: 'ROW_DELETED_DEDUP',
      new_department_id: null,
      new_department_name: '— (duplicate row removed)',
    });
  }

  if (dupes.length > 0) {
    await t.result(`DELETE FROM tbl_user_role_scopes WHERE id IN ($1:csv)`, [dupes.map(d => d.scope_id)]);
  }
  console.log(`   Rule 0d: removed ${dupes.length} duplicate Tender Creator NULL rows`);
}

// ─── Rule 1: Trio-dept specific → NULL (EXCEPT technical roles) ─────────────

async function rule1_trioSpecificToNull(t) {
  const rows = await t.any(`
    SELECT ${SCOPE_COLUMNS}
    FROM tbl_user_role_scopes urs
    ${SCOPE_JOINS}
    WHERE urs.department_id IS NOT NULL
      AND urs.role_id != ALL($2::int[])
      AND EXISTS (
        SELECT 1 FROM tbl_user_department ud
        WHERE ud.user_id = urs.user_id AND ud.department_id = ANY($1::int[])
      )
  `, [TRIO_DEPT_IDS, TECHNICAL_ROLE_IDS]);

  for (const r of rows) {
    logChange({
      ...r,
      rule: 'Rule 1',
      action: 'SCOPE_TO_NULL',
      new_department_id: null,
      new_department_name: 'All Departments',
    });
  }

  const result = await t.result(`
    UPDATE tbl_user_role_scopes urs SET department_id = NULL
    WHERE urs.department_id IS NOT NULL
      AND urs.role_id != ALL($2::int[])
      AND EXISTS (
        SELECT 1 FROM tbl_user_department ud
        WHERE ud.user_id = urs.user_id AND ud.department_id = ANY($1::int[])
      )
  `, [TRIO_DEPT_IDS, TECHNICAL_ROLE_IDS]);
  console.log(`   Rule 1:  ${result.rowCount} trio-user scopes → NULL (excl technical)`);
}

async function rule1_deduplicate(t) {
  const dupes = await t.any(`
    WITH ranked AS (
      SELECT urs.id,
             ROW_NUMBER() OVER (
               PARTITION BY urs.user_id, urs.role_id, urs.company_id, urs.hotel_id, urs.department_id
               ORDER BY urs.id
             ) AS rn
      FROM tbl_user_role_scopes urs
      WHERE urs.department_id IS NULL
    )
    SELECT ${SCOPE_COLUMNS}
    FROM tbl_user_role_scopes urs
    ${SCOPE_JOINS}
    JOIN ranked rk ON rk.id = urs.id AND rk.rn > 1
  `);

  for (const r of dupes) {
    logChange({
      ...r,
      rule: 'Rule 1 dedup',
      action: 'ROW_DELETED_DEDUP',
      new_department_id: null,
      new_department_name: '— (duplicate row removed)',
    });
  }

  if (dupes.length > 0) {
    await t.result(`DELETE FROM tbl_user_role_scopes WHERE id IN ($1:csv)`, [dupes.map(d => d.scope_id)]);
  }
  console.log(`   Rule 1d: removed ${dupes.length} duplicate NULL-scope rows`);
}

// ─── Rule 1b: Trio users with Technical roles at NULL → expand ──────────────

async function rule1b_trioTechnicalExpand(t) {
  const nullRows = await t.any(`
    SELECT ${SCOPE_COLUMNS}
    FROM tbl_user_role_scopes urs
    ${SCOPE_JOINS}
    WHERE urs.department_id IS NULL
      AND urs.role_id = ANY($2::int[])
      AND EXISTS (
        SELECT 1 FROM tbl_user_department ud
        WHERE ud.user_id = urs.user_id AND ud.department_id = ANY($1::int[])
      )
  `, [TRIO_DEPT_IDS, TECHNICAL_ROLE_IDS]);

  let inserted = 0;
  let deleted = 0;

  for (const row of nullRows) {
    // Get user's mapped departments (the destinations for the expansion).
    const depts = await t.any(`
      SELECT d.id, d.title FROM tbl_user_department ud
      JOIN tbl_department d ON d.id = ud.department_id
      WHERE ud.user_id = $1 ORDER BY d.title
    `, [row.user_id]);

    for (const dept of depts) {
      const exists = await t.oneOrNone(`
        SELECT 1 FROM tbl_user_role_scopes
        WHERE user_id = $1 AND role_id = $2 AND company_id = $3
          AND COALESCE(hotel_id, 0) = COALESCE($4, 0) AND department_id = $5
      `, [row.user_id, row.role_id, row.company_id, row.hotel_id, dept.id]);

      if (!exists) {
        await t.none(`
          INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
          VALUES ($1, $2, $3, $4, $5)
        `, [row.user_id, row.role_id, row.company_id, row.hotel_id, dept.id]);
        inserted++;
        logChange({
          ...row,
          rule: 'Rule 1b',
          action: 'ROW_INSERTED',
          old_department_id: null,
          old_department_name: 'All Departments',
          new_department_id: dept.id,
          new_department_name: dept.title,
        });
      }
    }

    await t.none('DELETE FROM tbl_user_role_scopes WHERE id = $1', [row.scope_id]);
    deleted++;
    logChange({
      ...row,
      rule: 'Rule 1b',
      action: 'NULL_ROW_DELETED',
      old_department_id: null,
      old_department_name: 'All Departments',
      new_department_id: null,
      new_department_name: '— (replaced by per-dept rows above)',
    });
  }

  console.log(`   Rule 1b: expanded ${nullRows.length} trio-technical NULL rows → inserted ${inserted}, deleted ${deleted}`);
}

// ─── Rule 3: Non-trio users with NULL scopes → expand ───────────────────────

async function rule3_expandNonTrioNull(t) {
  const nullRows = await t.any(`
    SELECT ${SCOPE_COLUMNS}
    FROM tbl_user_role_scopes urs
    ${SCOPE_JOINS}
    WHERE urs.department_id IS NULL
      AND urs.role_id != $2
      AND NOT EXISTS (
        SELECT 1 FROM tbl_user_department ud
        WHERE ud.user_id = urs.user_id AND ud.department_id = ANY($1::int[])
      )
  `, [TRIO_DEPT_IDS, TENDER_CREATOR_ROLE_ID]);

  let inserted = 0;
  let deleted = 0;

  for (const row of nullRows) {
    const depts = await t.any(`
      SELECT d.id, d.title FROM tbl_user_department ud
      JOIN tbl_department d ON d.id = ud.department_id
      WHERE ud.user_id = $1 ORDER BY d.title
    `, [row.user_id]);

    for (const dept of depts) {
      const exists = await t.oneOrNone(`
        SELECT 1 FROM tbl_user_role_scopes
        WHERE user_id = $1 AND role_id = $2 AND company_id = $3
          AND COALESCE(hotel_id, 0) = COALESCE($4, 0) AND department_id = $5
      `, [row.user_id, row.role_id, row.company_id, row.hotel_id, dept.id]);

      if (!exists) {
        await t.none(`
          INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
          VALUES ($1, $2, $3, $4, $5)
        `, [row.user_id, row.role_id, row.company_id, row.hotel_id, dept.id]);
        inserted++;
        logChange({
          ...row,
          rule: 'Rule 3',
          action: 'ROW_INSERTED',
          old_department_id: null,
          old_department_name: 'All Departments',
          new_department_id: dept.id,
          new_department_name: dept.title,
        });
      }
    }

    await t.none('DELETE FROM tbl_user_role_scopes WHERE id = $1', [row.scope_id]);
    deleted++;
    logChange({
      ...row,
      rule: 'Rule 3',
      action: 'NULL_ROW_DELETED',
      old_department_id: null,
      old_department_name: 'All Departments',
      new_department_id: null,
      new_department_name: '— (replaced by per-dept rows above)',
    });
  }

  console.log(`   Rule 3:  expanded ${nullRows.length} non-trio NULL rows → inserted ${inserted}, deleted ${deleted}`);
}

// ─── Rule 4: Drop is_department_scoped ──────────────────────────────────────

async function rule4_dropIsDepartmentScoped(t) {
  const exists = await t.oneOrNone(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tbl_approval_policies' AND column_name = 'is_department_scoped'
  `);
  if (exists) {
    await t.none('ALTER TABLE tbl_approval_policies DROP COLUMN is_department_scoped');
    console.log('   Rule 4:  dropped tbl_approval_policies.is_department_scoped');
  } else {
    console.log('   Rule 4:  column already dropped (skipped)');
  }
}

// ─── Rule 5: Drop access_type ───────────────────────────────────────────────

async function rule5_dropAccessType(t) {
  const exists = await t.oneOrNone(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tbl_department' AND column_name = 'access_type'
  `);
  if (exists) {
    await t.none('ALTER TABLE tbl_department DROP COLUMN access_type');
    console.log('   Rule 5:  dropped tbl_department.access_type');
  } else {
    console.log('   Rule 5:  column already dropped (skipped)');
  }
}

// ─── Excel Report ───────────────────────────────────────────────────────────

async function generateReport() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Department Scoping Migration';
  wb.created = new Date();

  // Sheet 1: All Changes (detailed)
  const ws = wb.addWorksheet('Changes');
  ws.columns = [
    { header: 'User ID',           key: 'user_id',             width: 9 },
    { header: 'User Name',         key: 'user_name',           width: 22 },
    { header: 'User Email',        key: 'user_email',          width: 28 },
    { header: 'User Departments',  key: 'user_departments',    width: 32 },
    { header: 'Rule',              key: 'rule',                width: 14 },
    { header: 'Action',            key: 'action',              width: 20 },
    { header: 'Role ID',           key: 'role_id',             width: 9 },
    { header: 'Role',              key: 'role_title',          width: 22 },
    { header: 'Old Scope',         key: 'old_scope',           width: 50 },
    { header: 'New Scope',         key: 'new_scope',           width: 50 },
    { header: 'Company ID',        key: 'company_id',          width: 11 },
    { header: 'Company',           key: 'company_name',        width: 22 },
    { header: 'Hotel ID',          key: 'hotel_id',            width: 9 },
    { header: 'Hotel',             key: 'hotel_name',          width: 22 },
    { header: 'Old Dept ID',       key: 'old_department_id',   width: 11 },
    { header: 'Old Department',    key: 'old_department_name', width: 22 },
    { header: 'New Dept ID',       key: 'new_department_id',   width: 11 },
    { header: 'New Department',    key: 'new_department_name', width: 28 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const entry of changelog) ws.addRow(entry);
  if (changelog.length > 0) {
    ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } };
  }

  // Sheet 2: Per-user summary
  const summary = wb.addWorksheet('User Summary');
  const userMap = {};
  for (const c of changelog) {
    if (!userMap[c.user_id]) {
      userMap[c.user_id] = {
        user_id: c.user_id,
        user_name: c.user_name,
        user_email: c.user_email,
        user_departments: c.user_departments,
        scopes_to_null: 0,
        rows_inserted: 0,
        rows_deleted: 0,
        dedup_deleted: 0,
        rules_applied: new Set(),
      };
    }
    const u = userMap[c.user_id];
    u.rules_applied.add(c.rule);
    if (c.action === 'SCOPE_TO_NULL') u.scopes_to_null++;
    else if (c.action === 'ROW_INSERTED') u.rows_inserted++;
    else if (c.action === 'NULL_ROW_DELETED') u.rows_deleted++;
    else if (c.action === 'ROW_DELETED_DEDUP') u.dedup_deleted++;
  }

  summary.columns = [
    { header: 'User ID',          key: 'user_id',          width: 9 },
    { header: 'User Name',        key: 'user_name',        width: 22 },
    { header: 'User Email',       key: 'user_email',       width: 28 },
    { header: 'User Departments', key: 'user_departments', width: 32 },
    { header: 'Rules Applied',    key: 'rules',            width: 30 },
    { header: 'Scopes → NULL',    key: 'scopes_to_null',   width: 14 },
    { header: 'Rows Inserted',    key: 'rows_inserted',    width: 14 },
    { header: 'Rows Deleted',     key: 'rows_deleted',     width: 14 },
    { header: 'Dedup Deleted',    key: 'dedup_deleted',    width: 14 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  summary.views = [{ state: 'frozen', ySplit: 1 }];
  for (const u of Object.values(userMap)) {
    summary.addRow({ ...u, rules: [...u.rules_applied].join(', ') });
  }
  if (Object.keys(userMap).length > 0) {
    summary.autoFilter = { from: 'A1', to: { row: 1, column: summary.columns.length } };
  }

  // Sheet 3: Rule legend
  const legend = wb.addWorksheet('Rules Legend');
  legend.columns = [
    { header: 'Rule', key: 'rule', width: 14 },
    { header: 'Description', key: 'desc', width: 100 },
  ];
  legend.getRow(1).font = { bold: true };
  legend.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  legend.addRow({ rule: 'Rule 0',       desc: 'Tender Creator (role_id=2) with specific dept → All Departments (always needs cross-dept access).' });
  legend.addRow({ rule: 'Rule 0 dedup', desc: 'Removed duplicate Tender Creator NULL rows that Rule 0 produced.' });
  legend.addRow({ rule: 'Rule 1',       desc: 'Corp/Purchase/GM users: non-technical roles with specific dept → All Departments.' });
  legend.addRow({ rule: 'Rule 1 dedup', desc: 'Removed duplicate NULL rows that Rule 1 produced.' });
  legend.addRow({ rule: 'Rule 1b',      desc: 'Corp/Purchase/GM users: Technical Evaluator/Approver roles with All Departments → expanded into one row per mapped department.' });
  legend.addRow({ rule: 'Rule 3',       desc: 'Non-admin users (not Corp/Purchase/GM): any role except Tender Creator with All Departments → expanded into one row per mapped department.' });

  await wb.xlsx.writeFile(OUTPUT);
  console.log(`Report:  ${changelog.length} change entries across ${Object.keys(userMap).length} users`);
}

main();
