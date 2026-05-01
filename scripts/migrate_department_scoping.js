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
 * Generates: scripts/migration_report.xlsx with all changes for product team review
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

// Changelog: every change is recorded here for the Excel export
const changelog = [];

function logChange({ user_id, user_name, rule, role_id, role_title, action, old_department_id, old_department_name, new_department_id, new_department_name, company_id, hotel_id }) {
  changelog.push({
    user_id,
    user_name: user_name || '',
    rule,
    role_id,
    role_title: role_title || '',
    action, // SCOPE_TO_NULL, SCOPE_EXPANDED, ROW_DELETED_DEDUP, ROW_INSERTED
    old_department_id: old_department_id ?? '',
    old_department_name: old_department_name || '',
    new_department_id: new_department_id ?? '',
    new_department_name: new_department_name || '',
    company_id: company_id || '',
    hotel_id: hotel_id || ''
  });
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  Department Scoping Migration');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE'}`);
  console.log(`${'='.repeat(60)}\n`);

  await printCurrentState();

  if (DRY_RUN) {
    await simulateChanges();
    console.log('\n--- DRY RUN complete. No changes made. Run without --dry-run to apply. ---\n');
    process.exit(0);
  }

  try {
    await db.tx(async t => {
      await rule0_tenderCreatorToNull(t);
      await rule0_deduplicate(t);
      await rule1_trioSpecificToNull(t);
      await rule1_deduplicate(t);
      await rule1b_trioTechnicalExpand(t);
      await rule3_expandNonTrioNull(t);
      await rule4_dropIsDepartmentScoped(t);
      await rule5_dropAccessType(t);
    });

    console.log('\n✓ Migration completed successfully.\n');
    await printCurrentState();

    // Generate Excel report
    await generateReport();
    console.log(`✓ Report saved to: ${OUTPUT}\n`);
  } catch (err) {
    console.error('\n✗ Migration FAILED — transaction rolled back.\n', err.message);
    process.exit(1);
  }

  pgp.end();
}

// ─── Pre-flight state ───────────────────────────────────────────────────────

async function printCurrentState() {
  const totalScopes = await db.one('SELECT COUNT(*) AS cnt FROM tbl_user_role_scopes');
  const nullScopes = await db.one('SELECT COUNT(*) AS cnt FROM tbl_user_role_scopes WHERE department_id IS NULL');
  const specificScopes = await db.one('SELECT COUNT(*) AS cnt FROM tbl_user_role_scopes WHERE department_id IS NOT NULL');

  console.log('Current state of tbl_user_role_scopes:');
  console.log(`  Total rows:              ${totalScopes.cnt}`);
  console.log(`  department_id IS NULL:    ${nullScopes.cnt}`);
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

// ─── Dry-run simulation ─────────────────────────────────────────────────────

async function simulateChanges() {
  // Rule 0
  const rule0Affected = await db.any(`
    SELECT urs.user_id, u.name, urs.department_id, d.title AS dept_title
    FROM tbl_user_role_scopes urs
    JOIN tbl_users u ON u.id = urs.user_id
    LEFT JOIN tbl_department d ON d.id = urs.department_id
    WHERE urs.role_id = $1 AND urs.department_id IS NOT NULL
    ORDER BY urs.user_id
  `, [TENDER_CREATOR_ROLE_ID]);
  console.log(`\nRule 0 — Tender Creator specific dept → NULL: ${rule0Affected.length} rows`);
  for (const r of rule0Affected) console.log(`    User ${r.user_id} (${r.name}) | ${r.dept_title} → NULL`);

  // Rule 1 (excludes technical roles)
  const rule1Affected = await db.any(`
    SELECT urs.user_id, u.name, urs.role_id, r.title AS role_title,
           urs.department_id, d.title AS dept_title
    FROM tbl_user_role_scopes urs
    JOIN tbl_users u ON u.id = urs.user_id
    JOIN tbl_roles r ON r.id = urs.role_id
    LEFT JOIN tbl_department d ON d.id = urs.department_id
    WHERE urs.department_id IS NOT NULL
      AND urs.role_id != ALL($2::int[])
      AND EXISTS (
        SELECT 1 FROM tbl_user_department ud
        WHERE ud.user_id = urs.user_id AND ud.department_id = ANY($1::int[])
      )
    ORDER BY urs.user_id, urs.role_id
  `, [TRIO_DEPT_IDS, TECHNICAL_ROLE_IDS]);
  console.log(`\nRule 1 — Trio-dept specific → NULL (excl technical): ${rule1Affected.length} rows`);
  for (const r of rule1Affected) console.log(`    User ${r.user_id} (${r.name}) | ${r.role_title} | ${r.dept_title} → NULL`);

  // Rule 1b (trio users with technical roles at NULL → expand)
  const rule1bAffected = await db.any(`
    SELECT urs.user_id, u.name, urs.role_id, r.title AS role_title,
           urs.company_id, urs.hotel_id
    FROM tbl_user_role_scopes urs
    JOIN tbl_users u ON u.id = urs.user_id
    JOIN tbl_roles r ON r.id = urs.role_id
    WHERE urs.department_id IS NULL
      AND urs.role_id = ANY($2::int[])
      AND EXISTS (
        SELECT 1 FROM tbl_user_department ud
        WHERE ud.user_id = urs.user_id AND ud.department_id = ANY($1::int[])
      )
    ORDER BY urs.user_id, urs.role_id
  `, [TRIO_DEPT_IDS, TECHNICAL_ROLE_IDS]);
  console.log(`\nRule 1b — Trio technical NULL → expand to user depts: ${rule1bAffected.length} rows`);
  for (const r of rule1bAffected) {
    const depts = await db.any(`SELECT d.id, d.title FROM tbl_user_department ud JOIN tbl_department d ON d.id = ud.department_id WHERE ud.user_id = $1 ORDER BY d.title`, [r.user_id]);
    console.log(`    User ${r.user_id} (${r.name}) | ${r.role_title} | NULL → [${depts.map(d => d.title).join(', ')}]`);
  }

  // Rule 3 (non-trio NULL → expand, excludes Tender Creator + already handled by 1b for trio technical)
  const rule3Users = await db.any(`
    SELECT urs.user_id, u.name, urs.role_id, r.title AS role_title,
           urs.company_id, urs.hotel_id
    FROM tbl_user_role_scopes urs
    JOIN tbl_users u ON u.id = urs.user_id
    JOIN tbl_roles r ON r.id = urs.role_id
    WHERE urs.department_id IS NULL
      AND urs.role_id != $2
      AND NOT EXISTS (
        SELECT 1 FROM tbl_user_department ud
        WHERE ud.user_id = urs.user_id AND ud.department_id = ANY($1::int[])
      )
    ORDER BY urs.user_id, urs.role_id
  `, [TRIO_DEPT_IDS, TENDER_CREATOR_ROLE_ID]);
  console.log(`\nRule 3 — Non-trio NULL → expand: ${rule3Users.length} rows`);
  for (const r of rule3Users) {
    const depts = await db.any(`SELECT d.id, d.title FROM tbl_user_department ud JOIN tbl_department d ON d.id = ud.department_id WHERE ud.user_id = $1 ORDER BY d.title`, [r.user_id]);
    console.log(`    User ${r.user_id} (${r.name}) | ${r.role_title} | NULL → [${depts.map(d => d.title).join(', ')}]`);
  }

  // Rule 2 (no change)
  const rule2Count = await db.one(`
    SELECT COUNT(*) AS cnt FROM tbl_user_role_scopes urs
    WHERE urs.department_id IS NULL
      AND urs.role_id != ALL($2::int[])
      AND EXISTS (
        SELECT 1 FROM tbl_user_department ud
        WHERE ud.user_id = urs.user_id AND ud.department_id = ANY($1::int[])
      )
  `, [TRIO_DEPT_IDS, TECHNICAL_ROLE_IDS]);
  console.log(`\nRule 2 — Trio NULL non-technical (no change): ${rule2Count.cnt} rows`);
}

// ─── Rule 0: Tender Creator specific dept → NULL ────────────────────────────

async function rule0_tenderCreatorToNull(t) {
  // Capture before updating for changelog
  const rows = await t.any(`
    SELECT urs.user_id, u.name, urs.role_id, r.title AS role_title,
           urs.department_id, d.title AS dept_title, urs.company_id, urs.hotel_id
    FROM tbl_user_role_scopes urs
    JOIN tbl_users u ON u.id = urs.user_id
    JOIN tbl_roles r ON r.id = urs.role_id
    LEFT JOIN tbl_department d ON d.id = urs.department_id
    WHERE urs.role_id = $1 AND urs.department_id IS NOT NULL
  `, [TENDER_CREATOR_ROLE_ID]);

  for (const r of rows) {
    logChange({ user_id: r.user_id, user_name: r.name, rule: 'Rule 0', role_id: r.role_id, role_title: r.role_title, action: 'SCOPE_TO_NULL', old_department_id: r.department_id, old_department_name: r.dept_title, new_department_id: null, new_department_name: 'All Departments', company_id: r.company_id, hotel_id: r.hotel_id });
  }

  const result = await t.result(`
    UPDATE tbl_user_role_scopes SET department_id = NULL
    WHERE role_id = $1 AND department_id IS NOT NULL
  `, [TENDER_CREATOR_ROLE_ID]);
  console.log(`Rule 0: Set ${result.rowCount} Tender Creator scopes to NULL`);
}

async function rule0_deduplicate(t) {
  const dupes = await t.any(`
    SELECT id, user_id FROM (
      SELECT id, user_id, ROW_NUMBER() OVER (
        PARTITION BY user_id, role_id, company_id, hotel_id, department_id ORDER BY id
      ) AS rn FROM tbl_user_role_scopes WHERE role_id = $1 AND department_id IS NULL
    ) d WHERE rn > 1
  `, [TENDER_CREATOR_ROLE_ID]);

  if (dupes.length > 0) {
    for (const d of dupes) logChange({ user_id: d.user_id, rule: 'Rule 0 dedup', role_id: TENDER_CREATOR_ROLE_ID, role_title: 'Tender Creator', action: 'ROW_DELETED_DEDUP' });
    await t.result(`DELETE FROM tbl_user_role_scopes WHERE id IN ($1:csv)`, [dupes.map(d => d.id)]);
  }
  console.log(`Rule 0 (dedup): Removed ${dupes.length} duplicate rows`);
}

// ─── Rule 1: Trio-dept specific → NULL (EXCEPT technical roles) ─────────────

async function rule1_trioSpecificToNull(t) {
  const rows = await t.any(`
    SELECT urs.user_id, u.name, urs.role_id, r.title AS role_title,
           urs.department_id, d.title AS dept_title, urs.company_id, urs.hotel_id
    FROM tbl_user_role_scopes urs
    JOIN tbl_users u ON u.id = urs.user_id
    JOIN tbl_roles r ON r.id = urs.role_id
    LEFT JOIN tbl_department d ON d.id = urs.department_id
    WHERE urs.department_id IS NOT NULL
      AND urs.role_id != ALL($2::int[])
      AND EXISTS (
        SELECT 1 FROM tbl_user_department ud
        WHERE ud.user_id = urs.user_id AND ud.department_id = ANY($1::int[])
      )
  `, [TRIO_DEPT_IDS, TECHNICAL_ROLE_IDS]);

  for (const r of rows) {
    logChange({ user_id: r.user_id, user_name: r.name, rule: 'Rule 1', role_id: r.role_id, role_title: r.role_title, action: 'SCOPE_TO_NULL', old_department_id: r.department_id, old_department_name: r.dept_title, new_department_id: null, new_department_name: 'All Departments', company_id: r.company_id, hotel_id: r.hotel_id });
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
  console.log(`Rule 1: Set ${result.rowCount} trio-user scopes to NULL (excl technical)`);
}

async function rule1_deduplicate(t) {
  const dupes = await t.any(`
    SELECT id, user_id, role_id FROM (
      SELECT id, user_id, role_id, ROW_NUMBER() OVER (
        PARTITION BY user_id, role_id, company_id, hotel_id, department_id ORDER BY id
      ) AS rn FROM tbl_user_role_scopes WHERE department_id IS NULL
    ) d WHERE rn > 1
  `);

  if (dupes.length > 0) {
    for (const d of dupes) logChange({ user_id: d.user_id, rule: 'Rule 1 dedup', role_id: d.role_id, action: 'ROW_DELETED_DEDUP' });
    await t.result(`DELETE FROM tbl_user_role_scopes WHERE id IN ($1:csv)`, [dupes.map(d => d.id)]);
  }
  console.log(`Rule 1 (dedup): Removed ${dupes.length} duplicate NULL-scope rows`);
}

// ─── Rule 1b: Trio users with Technical roles at NULL → expand ──────────────

async function rule1b_trioTechnicalExpand(t) {
  // Find trio users with technical roles scoped to NULL
  const nullRows = await t.any(`
    SELECT urs.id, urs.user_id, u.name, urs.role_id, r.title AS role_title,
           urs.company_id, urs.hotel_id
    FROM tbl_user_role_scopes urs
    JOIN tbl_users u ON u.id = urs.user_id
    JOIN tbl_roles r ON r.id = urs.role_id
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
    // Get user's departments
    const depts = await t.any(`
      SELECT d.id, d.title FROM tbl_user_department ud
      JOIN tbl_department d ON d.id = ud.department_id
      WHERE ud.user_id = $1 ORDER BY d.title
    `, [row.user_id]);

    // Insert explicit rows per department
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
        logChange({ user_id: row.user_id, user_name: row.name, rule: 'Rule 1b', role_id: row.role_id, role_title: row.role_title, action: 'ROW_INSERTED', old_department_id: null, old_department_name: 'All Departments', new_department_id: dept.id, new_department_name: dept.title, company_id: row.company_id, hotel_id: row.hotel_id });
      }
    }

    // Delete the original NULL row
    await t.none('DELETE FROM tbl_user_role_scopes WHERE id = $1', [row.id]);
    deleted++;
    logChange({ user_id: row.user_id, user_name: row.name, rule: 'Rule 1b', role_id: row.role_id, role_title: row.role_title, action: 'NULL_ROW_DELETED', old_department_id: null, old_department_name: 'All Departments', company_id: row.company_id, hotel_id: row.hotel_id });
  }

  console.log(`Rule 1b: Expanded ${nullRows.length} trio-technical NULL rows → inserted ${inserted}, deleted ${deleted}`);
}

// ─── Rule 3: Non-trio users with NULL scopes → expand ───────────────────────

async function rule3_expandNonTrioNull(t) {
  // Capture rows before expansion for changelog
  const nullRows = await t.any(`
    SELECT urs.id, urs.user_id, u.name, urs.role_id, r.title AS role_title,
           urs.company_id, urs.hotel_id
    FROM tbl_user_role_scopes urs
    JOIN tbl_users u ON u.id = urs.user_id
    JOIN tbl_roles r ON r.id = urs.role_id
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
        logChange({ user_id: row.user_id, user_name: row.name, rule: 'Rule 3', role_id: row.role_id, role_title: row.role_title, action: 'ROW_INSERTED', old_department_id: null, old_department_name: 'All Departments', new_department_id: dept.id, new_department_name: dept.title, company_id: row.company_id, hotel_id: row.hotel_id });
      }
    }

    await t.none('DELETE FROM tbl_user_role_scopes WHERE id = $1', [row.id]);
    deleted++;
    logChange({ user_id: row.user_id, user_name: row.name, rule: 'Rule 3', role_id: row.role_id, role_title: row.role_title, action: 'NULL_ROW_DELETED', old_department_id: null, old_department_name: 'All Departments', company_id: row.company_id, hotel_id: row.hotel_id });
  }

  console.log(`Rule 3: Expanded ${nullRows.length} non-trio NULL rows → inserted ${inserted}, deleted ${deleted}`);
}

// ─── Rule 4: Drop is_department_scoped ──────────────────────────────────────

async function rule4_dropIsDepartmentScoped(t) {
  const exists = await t.oneOrNone(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tbl_approval_policies' AND column_name = 'is_department_scoped'
  `);
  if (exists) {
    await t.none('ALTER TABLE tbl_approval_policies DROP COLUMN is_department_scoped');
    console.log('Rule 4: Dropped tbl_approval_policies.is_department_scoped');
  } else {
    console.log('Rule 4: Column already dropped (skipped)');
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
    console.log('Rule 5: Dropped tbl_department.access_type');
  } else {
    console.log('Rule 5: Column already dropped (skipped)');
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
    { header: 'User ID', key: 'user_id', width: 10 },
    { header: 'User Name', key: 'user_name', width: 22 },
    { header: 'Rule', key: 'rule', width: 14 },
    { header: 'Action', key: 'action', width: 20 },
    { header: 'Role ID', key: 'role_id', width: 10 },
    { header: 'Role', key: 'role_title', width: 24 },
    { header: 'Old Dept ID', key: 'old_department_id', width: 12 },
    { header: 'Old Department', key: 'old_department_name', width: 22 },
    { header: 'New Dept ID', key: 'new_department_id', width: 12 },
    { header: 'New Department', key: 'new_department_name', width: 22 },
    { header: 'Company ID', key: 'company_id', width: 12 },
    { header: 'Hotel ID', key: 'hotel_id', width: 10 },
  ];

  // Style header row
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };

  for (const entry of changelog) ws.addRow(entry);

  // Sheet 2: Summary per user
  const summary = wb.addWorksheet('User Summary');
  const userMap = {};
  for (const c of changelog) {
    if (!userMap[c.user_id]) userMap[c.user_id] = { user_id: c.user_id, user_name: c.user_name, scopes_to_null: 0, rows_inserted: 0, rows_deleted: 0, dedup_deleted: 0, rules_applied: new Set() };
    const u = userMap[c.user_id];
    u.rules_applied.add(c.rule);
    if (c.action === 'SCOPE_TO_NULL') u.scopes_to_null++;
    else if (c.action === 'ROW_INSERTED') u.rows_inserted++;
    else if (c.action === 'NULL_ROW_DELETED') u.rows_deleted++;
    else if (c.action === 'ROW_DELETED_DEDUP') u.dedup_deleted++;
  }

  summary.columns = [
    { header: 'User ID', key: 'user_id', width: 10 },
    { header: 'User Name', key: 'user_name', width: 22 },
    { header: 'Rules Applied', key: 'rules', width: 30 },
    { header: 'Scopes → NULL', key: 'scopes_to_null', width: 14 },
    { header: 'Rows Inserted', key: 'rows_inserted', width: 14 },
    { header: 'Rows Deleted', key: 'rows_deleted', width: 14 },
    { header: 'Dedup Deleted', key: 'dedup_deleted', width: 14 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };

  for (const u of Object.values(userMap)) {
    summary.addRow({ ...u, rules: [...u.rules_applied].join(', ') });
  }

  // Sheet 3: Rule legend
  const legend = wb.addWorksheet('Rules Legend');
  legend.columns = [
    { header: 'Rule', key: 'rule', width: 14 },
    { header: 'Description', key: 'desc', width: 80 },
  ];
  legend.getRow(1).font = { bold: true };
  legend.addRow({ rule: 'Rule 0', desc: 'Tender Creator (role_id=2) with specific dept → All Departments (always needs cross-dept access)' });
  legend.addRow({ rule: 'Rule 0 dedup', desc: 'Removed duplicate Tender Creator NULL rows created by Rule 0' });
  legend.addRow({ rule: 'Rule 1', desc: 'Corp/Purchase/GM users: non-technical roles with specific dept → All Departments' });
  legend.addRow({ rule: 'Rule 1 dedup', desc: 'Removed duplicate NULL rows created by Rule 1' });
  legend.addRow({ rule: 'Rule 1b', desc: 'Corp/Purchase/GM users: Technical Evaluator/Approver roles with All Departments → expanded to user\'s mapped departments only' });
  legend.addRow({ rule: 'Rule 3', desc: 'Non-admin users (not Corp/Purchase/GM): any role (except Tender Creator) with All Departments → expanded to user\'s mapped departments' });

  await wb.xlsx.writeFile(OUTPUT);
  console.log(`Report: ${changelog.length} change entries across ${Object.keys(userMap).length} users`);
}

main();
