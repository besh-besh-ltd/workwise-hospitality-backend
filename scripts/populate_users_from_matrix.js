/**
 * Bulk User Role Population from Excel Matrix
 *
 * Ingests the "RFQ Based Hierarchy" sheet of an Excel matrix and populates:
 *   - tbl_user_department (user's own department from col 8)
 *   - tbl_user_role_scopes (per-role scopes from cols 10-23)
 *   - tbl_hospitality_user_mappings (hotel-level mapping)
 *
 * Only the "Approval Matrix for Unit Level RFQs" section (cols 10-23) is processed.
 * The "Approval Matrix for Project RFQs" section (cols 24+) is ignored.
 *
 * Awarding Approver priority:
 *   - Active YES rows are reversed (last YES row → P1)
 *   - Sequential mapping: 1st reversed → role 13 (P1), 2nd → 14 (P2), 3rd → 15 (P3),
 *     4th → P4 (auto-created if missing), 5th → P5, ...
 *   - When new P{N} role is created, permissions are copied from existing P1 (role 13).
 *
 * Wipe & replace strategy:
 *   - Existing tbl_user_role_scopes for (user_id, company_id, hotel_id) are deleted before insert
 *   - Existing tbl_user_department rows are wiped per user before insert
 *   - All operations atomic per-user via db.tx()
 *
 * Usage:
 *   node scripts/populate_users_from_matrix.js [--dry-run] [--file=<path>] [--hotel-id=<id>]
 *
 * Output:
 *   scripts/populate_users_report.xlsx (Changes / Errors / User Summary)
 */

import dotenv from 'dotenv';
import pg from 'pg-promise';
import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(__dirname, 'populate_users_report.xlsx');

// ─── DB ─────────────────────────────────────────────────────────────────────

const pgp = pg();
const db = pgp({
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  host: process.env.HOST,
  port: process.env.DATABASE_PORT,
  ssl: process.env.TEST_DB_NO_SSL === '1' ? false : { rejectUnauthorized: false },
});

// ─── Constants ──────────────────────────────────────────────────────────────

const SHEET_NAME = 'RFQ Based Hierarchy';
const DATA_START_ROW = 7; // 0-indexed; rows 0-6 are headers

// Column indices (Unit Level RFQ matrix only)
const COL = {
  ACTIVE: 3,
  EMPLOYEE_ID: 4,
  EMAIL: 5,
  DEPARTMENT: 8,
  DEPT_ACCESS: 9,
  RFQ_CREATOR: 10,             // YES → role 2 (always NULL dept)
  RFQ_PUB_DEPT: 11,
  RFQ_PUB_APPROVER: 12,        // YES → role 4
  TECH_EVAL_DEPT: 13,
  TECH_EVAL_APPROVER: 14,      // YES → role 6
  TECH_APPR_DEPT: 15,
  TECH_APPR_APPROVER: 16,      // YES → role 7
  COMM_EVAL_DEPT: 17,
  COMM_EVAL_APPROVER: 18,      // YES → role 8
  COMM_APPR_DEPT: 19,
  COMM_APPR_APPROVER: 20,      // YES → role 12
  AWARDING_DEPT: 21,
  AWARDING_APPROVER: 22,       // YES → role 13/14/15/...
  PR_RFQ_OBSERVER: 23,         // value → role 17
};

// Role IDs (existing)
const ROLE = {
  TENDER_CREATOR: 2,
  TENDER_APPROVER: 4,           // RFQ Publishing
  TECH_EVALUATOR: 6,
  TECH_APPROVER: 7,
  COMMERCIAL_NEGOTIATOR_N1: 8,  // Commercial Evaluator
  COMMERCIAL_APPROVER: 12,
  AWARDING_P1: 13,
  AWARDING_P2: 14,
  AWARDING_P3: 15,
  RFQ_OBSERVER: 17,
};

const AWARDING_BASE_ROLES = [ROLE.AWARDING_P1, ROLE.AWARDING_P2, ROLE.AWARDING_P3];

const ALL_DEPT_ALIASES = new Set(['all department', 'all departments', 'all dept', 'all dept.']);

// ─── CLI parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const fileArg = args.find(a => a.startsWith('--file='));
const hotelArg = args.find(a => a.startsWith('--hotel-id='));
const FILE_PATH = fileArg
  ? fileArg.slice('--file='.length)
  : path.resolve(process.env.HOME || '', 'Downloads/orchid_pune_matrix.xlsx');
const ARG_HOTEL_ID = hotelArg ? parseInt(hotelArg.slice('--hotel-id='.length), 10) : null;

// ─── State ──────────────────────────────────────────────────────────────────

const changelog = [];   // detailed change log for Changes sheet
const errors = [];      // error log for Errors sheet
const userSummary = {}; // per user_id summary

function logChange(entry) { changelog.push(entry); }
function logError(entry)  { errors.push(entry); }
function bumpSummary(userId, userName, key) {
  if (!userSummary[userId]) {
    userSummary[userId] = { user_id: userId, user_name: userName, role_scopes: 0, depts: 0, mapping_created: 0, errors: 0 };
  }
  userSummary[userId][key] = (userSummary[userId][key] || 0) + 1;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

function isYes(v) {
  if (v == null) return false;
  return String(v).trim().toUpperCase() === 'YES';
}

function isAllDept(v) {
  if (v == null) return false;
  return ALL_DEPT_ALIASES.has(String(v).trim().toLowerCase());
}

function isBlank(v) {
  if (v == null) return true;
  const s = String(v).trim();
  return s === '' || s === '-';
}

function ordinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ─── Pre-flight: hotel + department lookups ─────────────────────────────────

async function getHotel(hotelId) {
  return db.oneOrNone(
    `SELECT id, hospitality_company_id, name
     FROM tbl_hospitality_company_hotels
     WHERE id = $1 AND is_deleted = 0`,
    [hotelId]
  );
}

async function loadDepartmentMap() {
  const rows = await db.any(`SELECT id, title FROM tbl_department`);
  const byLowerTitle = new Map();
  for (const r of rows) byLowerTitle.set(r.title.trim().toLowerCase(), r);
  return byLowerTitle;
}

// Resolve a department name from Excel → { id, title } | null (for ALL Dept) | undefined (not found)
function resolveDept(name, deptMap) {
  if (isBlank(name)) return undefined;
  if (isAllDept(name)) return null; // null means "All Departments"
  const found = deptMap.get(String(name).trim().toLowerCase());
  return found || 'NOT_FOUND';
}

// ─── User resolution ────────────────────────────────────────────────────────

async function resolveUser(empCode, email) {
  const empCodeStr = empCode != null ? String(empCode).trim() : '';
  const emailStr = email != null ? String(email).trim().toLowerCase() : '';

  if (empCodeStr) {
    const u = await db.oneOrNone(
      `SELECT id, name, email, employee_code, status
       FROM tbl_users
       WHERE employee_code = $1 AND is_deleted = 0
       LIMIT 1`,
      [empCodeStr]
    );
    if (u) return u;
  }
  if (emailStr) {
    const u = await db.oneOrNone(
      `SELECT id, name, email, employee_code, status
       FROM tbl_users
       WHERE LOWER(email) = $1 AND is_deleted = 0
       LIMIT 1`,
      [emailStr]
    );
    if (u) return u;
  }
  return null;
}

// ─── Awarding role provisioning ─────────────────────────────────────────────

/**
 * Ensure awarding roles up to needed level (P{N}) exist.
 * Creates new "Final Awarding P{N}" roles + copies permissions from P1 if missing.
 * Returns array of role_ids in order [P1, P2, P3, P4, ...].
 */
async function ensureAwardingRoles(neededCount, t = db) {
  const ids = [...AWARDING_BASE_ROLES];
  if (neededCount <= ids.length) return ids.slice(0, neededCount);

  // Need P4, P5, ... — check what already exists with title "Final Awarding P{N}"
  for (let n = ids.length + 1; n <= neededCount; n++) {
    const title = `Final Awarding P${n}`;
    let existing = await t.oneOrNone(
      `SELECT id FROM tbl_roles WHERE title = $1 LIMIT 1`,
      [title]
    );
    if (!existing) {
      if (DRY_RUN) {
        // Reserve a placeholder id; in dry-run we won't actually need it for inserts
        ids.push(`NEW(${title})`);
        logChange({
          rule: 'Role Provisioning',
          action: 'ROLE_CREATED (dry-run)',
          role_id: '',
          role_title: title,
          notes: `Would create P${n} with permissions copied from P1 (role 13)`
        });
        continue;
      }
      const description = `${ordinalSuffix(n)}-level awarding approver`;
      const created = await t.one(
        `INSERT INTO tbl_roles (title, description, created_by) VALUES ($1, $2, NULL) RETURNING id`,
        [title, description]
      );
      // Copy permissions from P1 (role 13)
      await t.none(
        `INSERT INTO tbl_role_permissions (role_id, permission_id)
         SELECT $1, permission_id FROM tbl_role_permissions WHERE role_id = $2
         ON CONFLICT DO NOTHING`,
        [created.id, ROLE.AWARDING_P1]
      );
      logChange({
        rule: 'Role Provisioning',
        action: 'ROLE_CREATED',
        role_id: created.id,
        role_title: title,
        notes: `Created P${n}; copied permissions from P1 (role 13)`
      });
      ids.push(created.id);
    } else {
      ids.push(existing.id);
    }
  }
  return ids;
}

// ─── Per-user processing ────────────────────────────────────────────────────

/**
 * Build the list of role scope assignments for a single user from their Excel row.
 * Returns: { scopes: [{role_id, department_id, source}], userDeptId, observerDeptResolved, errors }
 */
function buildRoleScopesForRow({ row, awardingRoleId, deptMap, rowNum, userInfo }) {
  const scopes = [];
  const issues = [];

  // Resolve user's own department (col 8 — for tbl_user_department)
  let userDeptId;
  const userDeptRaw = row[COL.DEPARTMENT];
  const userDeptResolved = resolveDept(userDeptRaw, deptMap);
  if (userDeptResolved === undefined) {
    userDeptId = undefined;
  } else if (userDeptResolved === null) {
    // "ALL Department" as user's own dept doesn't make sense; skip
    issues.push({ field: 'Department (col 8)', value: userDeptRaw, reason: 'User own department cannot be ALL — skipped tbl_user_department insert' });
    userDeptId = undefined;
  } else if (userDeptResolved === 'NOT_FOUND') {
    issues.push({ field: 'Department (col 8)', value: userDeptRaw, reason: 'Department not found in tbl_department — skipped tbl_user_department insert' });
    userDeptId = undefined;
  } else {
    userDeptId = userDeptResolved.id;
  }

  // Resolve Department Access fallback (col 9)
  const deptAccessRaw = row[COL.DEPT_ACCESS];
  const deptAccessResolved = resolveDept(deptAccessRaw, deptMap);

  // Helper: resolve a per-role department col → returns { dept_id (null=ALL, number, or undefined for skip), error? }
  function resolveRoleDept(roleDeptCol, roleName) {
    const v = row[roleDeptCol];
    let resolved = resolveDept(v, deptMap);

    // Fallback to Department Access if dept col is blank/dash
    if (resolved === undefined) {
      resolved = deptAccessResolved;
      if (resolved === undefined) {
        return { error: `${roleName}: dept col is blank and Department Access (col 9) is also blank; skipped` };
      }
    }

    if (resolved === 'NOT_FOUND') {
      return { error: `${roleName}: dept value "${v}" not found in tbl_department; skipped` };
    }
    if (resolved === null) return { dept_id: null }; // ALL → NULL
    return { dept_id: resolved.id };
  }

  // 1. RFQ Creator (col 10) — role 2, always NULL dept
  if (isYes(row[COL.RFQ_CREATOR])) {
    scopes.push({ role_id: ROLE.TENDER_CREATOR, role_title: 'Tender Creator', department_id: null, source: 'RFQ Creator (col 10)' });
  }

  // 2. RFQ Publishing (col 11/12) — role 4
  if (isYes(row[COL.RFQ_PUB_APPROVER])) {
    const r = resolveRoleDept(COL.RFQ_PUB_DEPT, 'RFQ Publishing');
    if (r.error) issues.push({ field: 'RFQ Publishing (col 11/12)', value: row[COL.RFQ_PUB_DEPT], reason: r.error });
    else scopes.push({ role_id: ROLE.TENDER_APPROVER, role_title: 'Tender Approver', department_id: r.dept_id, source: 'RFQ Publishing (col 11/12)' });
  }

  // 3. Tech Evaluator (col 13/14) — role 6
  if (isYes(row[COL.TECH_EVAL_APPROVER])) {
    const r = resolveRoleDept(COL.TECH_EVAL_DEPT, 'Technical Evaluator');
    if (r.error) issues.push({ field: 'Tech Evaluator (col 13/14)', value: row[COL.TECH_EVAL_DEPT], reason: r.error });
    else scopes.push({ role_id: ROLE.TECH_EVALUATOR, role_title: 'Technical Evaluator', department_id: r.dept_id, source: 'Tech Evaluator (col 13/14)' });
  }

  // 4. Tech Approver (col 15/16) — role 7
  if (isYes(row[COL.TECH_APPR_APPROVER])) {
    const r = resolveRoleDept(COL.TECH_APPR_DEPT, 'Technical Approver');
    if (r.error) issues.push({ field: 'Tech Approver (col 15/16)', value: row[COL.TECH_APPR_DEPT], reason: r.error });
    else scopes.push({ role_id: ROLE.TECH_APPROVER, role_title: 'Technical Approver', department_id: r.dept_id, source: 'Tech Approver (col 15/16)' });
  }

  // 5. Commercial Evaluator (col 17/18) — role 8
  if (isYes(row[COL.COMM_EVAL_APPROVER])) {
    const r = resolveRoleDept(COL.COMM_EVAL_DEPT, 'Commercial Evaluator');
    if (r.error) issues.push({ field: 'Comm Evaluator (col 17/18)', value: row[COL.COMM_EVAL_DEPT], reason: r.error });
    else scopes.push({ role_id: ROLE.COMMERCIAL_NEGOTIATOR_N1, role_title: 'Commercial Negotiator N1', department_id: r.dept_id, source: 'Comm Evaluator (col 17/18)' });
  }

  // 6. Commercial Approver (col 19/20) — role 12
  if (isYes(row[COL.COMM_APPR_APPROVER])) {
    const r = resolveRoleDept(COL.COMM_APPR_DEPT, 'Commercial Approver');
    if (r.error) issues.push({ field: 'Comm Approver (col 19/20)', value: row[COL.COMM_APPR_DEPT], reason: r.error });
    else scopes.push({ role_id: ROLE.COMMERCIAL_APPROVER, role_title: 'Commercial Approver', department_id: r.dept_id, source: 'Comm Approver (col 19/20)' });
  }

  // 7. Awarding Approver (col 21/22) — role assigned by awardingRoleId param
  if (isYes(row[COL.AWARDING_APPROVER]) && awardingRoleId != null) {
    const r = resolveRoleDept(COL.AWARDING_DEPT, 'Awarding Approver');
    if (r.error) issues.push({ field: 'Awarding (col 21/22)', value: row[COL.AWARDING_DEPT], reason: r.error });
    else scopes.push({ role_id: awardingRoleId, role_title: `Awarding (P-tier)`, department_id: r.dept_id, source: 'Awarding (col 21/22)' });
  }

  // 8. PR & RFQ Observer (col 23) — role 17
  const obsRaw = row[COL.PR_RFQ_OBSERVER];
  if (!isBlank(obsRaw)) {
    const obsResolved = resolveDept(obsRaw, deptMap);
    if (obsResolved === 'NOT_FOUND') {
      issues.push({ field: 'PR & RFQ Observer (col 23)', value: obsRaw, reason: `Dept "${obsRaw}" not found; skipped observer role` });
    } else {
      const deptId = obsResolved === null ? null : obsResolved.id;
      scopes.push({ role_id: ROLE.RFQ_OBSERVER, role_title: 'RFQ Observer', department_id: deptId, source: 'PR & RFQ Observer (col 23)' });
    }
  }

  return { scopes, userDeptId, issues };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '='.repeat(72));
  console.log('  Bulk User Role Population from Excel Matrix');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no DB changes)' : 'LIVE'}`);
  console.log('='.repeat(72) + '\n');

  // 1. Hotel ID
  let hotelId = ARG_HOTEL_ID;
  if (!hotelId) {
    const ans = await ask('Enter hotel_id (business unit): ');
    hotelId = parseInt(ans.trim(), 10);
  }
  if (!hotelId || isNaN(hotelId)) {
    console.error('✗ Invalid hotel_id');
    process.exit(1);
  }

  // 2. Validate hotel
  const hotel = await getHotel(hotelId);
  if (!hotel) {
    console.error(`✗ Hotel id ${hotelId} not found (or is_deleted=1)`);
    process.exit(1);
  }
  const companyId = hotel.hospitality_company_id;
  console.log(`Hotel:   #${hotel.id}  ${hotel.name}`);
  console.log(`Company: #${companyId}\n`);

  // 3. Load Excel
  console.log(`Reading: ${FILE_PATH}`);
  const wb = XLSX.readFile(FILE_PATH);
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    console.error(`✗ Sheet "${SHEET_NAME}" not found. Available: ${wb.SheetNames.join(', ')}`);
    process.exit(1);
  }
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  console.log(`Total rows in sheet: ${data.length}`);

  // 4. Load departments
  const deptMap = await loadDepartmentMap();
  console.log(`Departments loaded: ${deptMap.size}`);

  // 5. Filter active rows
  const activeRows = [];
  for (let i = DATA_START_ROW; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[1]) continue;
    const activeFlag = String(row[COL.ACTIVE] || '').trim().toLowerCase();
    if (activeFlag !== 'active') {
      logError({
        excel_row: i + 1,
        name: row[1],
        reason: `Skipped: status is "${row[COL.ACTIVE]}" (not Active)`,
      });
      continue;
    }
    activeRows.push({ row, excelRowNum: i + 1 });
  }
  console.log(`Active rows to process: ${activeRows.length}`);

  // 6. Determine awarding priority assignments (reverse order: last YES → P1)
  const awardingYesRows = activeRows.filter(({ row }) => isYes(row[COL.AWARDING_APPROVER]));
  const awardingReversed = [...awardingYesRows].reverse();
  console.log(`Awarding YES users: ${awardingReversed.length}`);

  // Pre-create P{N} roles if needed (in own tx so it's persisted before per-user txs)
  let awardingRoleIds = [];
  if (awardingReversed.length > 0) {
    if (DRY_RUN) {
      awardingRoleIds = await ensureAwardingRoles(awardingReversed.length);
    } else {
      awardingRoleIds = await db.tx(t => ensureAwardingRoles(awardingReversed.length, t));
    }
    console.log(`Awarding role IDs (P1..P${awardingReversed.length}): ${awardingRoleIds.join(', ')}`);
  }

  // Map each excelRowNum → assigned awarding role id (or undefined if not in awarding YES list)
  const awardingRoleByRow = new Map();
  for (let i = 0; i < awardingReversed.length; i++) {
    const { excelRowNum } = awardingReversed[i];
    awardingRoleByRow.set(excelRowNum, awardingRoleIds[i]);
  }

  // 7. Process each active user
  console.log('\n--- Processing users ---');
  let okCount = 0;
  let failCount = 0;

  for (const { row, excelRowNum } of activeRows) {
    const name = row[1];
    const empCode = row[COL.EMPLOYEE_ID];
    const email = row[COL.EMAIL];

    // Resolve user
    const user = await resolveUser(empCode, email);
    if (!user) {
      console.log(`  Row ${excelRowNum}: ✗ ${name} — user not found (emp=${empCode}, email=${email})`);
      logError({
        excel_row: excelRowNum,
        name,
        employee_code: empCode || '',
        email: email || '',
        reason: 'User not found by employee_code or email',
      });
      failCount++;
      continue;
    }

    // Build scopes
    const awardingRoleId = awardingRoleByRow.get(excelRowNum) ?? null;
    const { scopes, userDeptId, issues } = buildRoleScopesForRow({
      row,
      awardingRoleId,
      deptMap,
      rowNum: excelRowNum,
      userInfo: user,
    });

    for (const issue of issues) {
      logError({
        excel_row: excelRowNum,
        name,
        user_id: user.id,
        reason: `${issue.field}: value=${JSON.stringify(issue.value)} → ${issue.reason}`,
      });
      bumpSummary(user.id, user.name, 'errors');
    }

    // Apply DB changes
    if (!DRY_RUN) {
      try {
        await db.tx(async t => {
          // Wipe scopes for this hotel
          await t.none(
            `DELETE FROM tbl_user_role_scopes
             WHERE user_id = $1 AND company_id = $2 AND hotel_id = $3`,
            [user.id, companyId, hotelId]
          );
          // Wipe user departments (Excel is source of truth)
          await t.none(`DELETE FROM tbl_user_department WHERE user_id = $1`, [user.id]);

          // Insert new dept
          if (userDeptId) {
            await t.none(
              `INSERT INTO tbl_user_department (user_id, department_id) VALUES ($1, $2)`,
              [user.id, userDeptId]
            );
          }

          // Insert role scopes (multi-row)
          if (scopes.length > 0) {
            const params = [];
            const placeholders = scopes.map(s => {
              const base = params.length;
              params.push(user.id, s.role_id, companyId, hotelId, s.department_id);
              return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
            });
            await t.none(
              `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
               VALUES ${placeholders.join(', ')}`,
              params
            );
          }

          // Upsert hotel mapping (mapping_type=1)
          await t.none(
            `INSERT INTO tbl_hospitality_user_mappings
              (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, auto_map_projects, created_by)
             VALUES ($1, $2, $3, 1, false, $4)
             ON CONFLICT (user_id, mapping_type, hospitality_company_id, hospitality_hotel_id) DO NOTHING`,
            [user.id, companyId, hotelId, user.id]
          );
        });
      } catch (err) {
        console.log(`  Row ${excelRowNum}: ✗ ${name} (#${user.id}) — DB error: ${err.message}`);
        logError({ excel_row: excelRowNum, name, user_id: user.id, reason: `DB error: ${err.message}` });
        failCount++;
        continue;
      }
    }

    // Log changes
    if (userDeptId) {
      const deptTitle = [...deptMap.values()].find(d => d.id === userDeptId)?.title || `#${userDeptId}`;
      logChange({
        excel_row: excelRowNum,
        user_id: user.id,
        user_name: user.name,
        rule: 'User Department',
        action: DRY_RUN ? 'WOULD_INSERT' : 'INSERTED',
        role_id: '',
        role_title: '',
        department_id: userDeptId,
        department_name: deptTitle,
        company_id: '',
        hotel_id: '',
        notes: `tbl_user_department: ${deptTitle}`,
      });
      bumpSummary(user.id, user.name, 'depts');
    }

    for (const s of scopes) {
      const deptTitle = s.department_id == null
        ? 'All Departments (NULL)'
        : ([...deptMap.values()].find(d => d.id === s.department_id)?.title || `#${s.department_id}`);
      logChange({
        excel_row: excelRowNum,
        user_id: user.id,
        user_name: user.name,
        rule: s.source,
        action: DRY_RUN ? 'WOULD_INSERT' : 'INSERTED',
        role_id: s.role_id,
        role_title: s.role_title,
        department_id: s.department_id ?? '',
        department_name: deptTitle,
        company_id: companyId,
        hotel_id: hotelId,
        notes: '',
      });
      bumpSummary(user.id, user.name, 'role_scopes');
    }

    logChange({
      excel_row: excelRowNum,
      user_id: user.id,
      user_name: user.name,
      rule: 'Hotel Mapping',
      action: DRY_RUN ? 'WOULD_UPSERT' : 'UPSERTED',
      role_id: '',
      role_title: '',
      department_id: '',
      department_name: '',
      company_id: companyId,
      hotel_id: hotelId,
      notes: 'tbl_hospitality_user_mappings (mapping_type=1)',
    });
    bumpSummary(user.id, user.name, 'mapping_created');

    okCount++;
    console.log(`  Row ${excelRowNum}: ✓ ${name} (#${user.id}) — ${scopes.length} scopes, dept=${userDeptId || 'none'}`);
  }

  console.log(`\nDone. Processed: ${activeRows.length}, OK: ${okCount}, Failed: ${failCount}, Errors logged: ${errors.length}`);

  // 8. Generate Excel report
  await writeReport(hotel);
  console.log(`Report: ${REPORT_PATH}\n`);

  pgp.end();
}

// ─── Excel Report ───────────────────────────────────────────────────────────

async function writeReport(hotel) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'populate_users_from_matrix.js';
  wb.created = new Date();

  // Sheet 1: Changes
  const ws1 = wb.addWorksheet('Changes');
  ws1.columns = [
    { header: 'Excel Row', key: 'excel_row', width: 10 },
    { header: 'User ID', key: 'user_id', width: 10 },
    { header: 'User Name', key: 'user_name', width: 24 },
    { header: 'Rule / Source', key: 'rule', width: 26 },
    { header: 'Action', key: 'action', width: 18 },
    { header: 'Role ID', key: 'role_id', width: 10 },
    { header: 'Role', key: 'role_title', width: 24 },
    { header: 'Dept ID', key: 'department_id', width: 10 },
    { header: 'Department', key: 'department_name', width: 24 },
    { header: 'Company ID', key: 'company_id', width: 12 },
    { header: 'Hotel ID', key: 'hotel_id', width: 10 },
    { header: 'Notes', key: 'notes', width: 50 },
  ];
  styleHeader(ws1);
  for (const row of changelog) ws1.addRow(row);

  // Sheet 2: Errors
  const ws2 = wb.addWorksheet('Errors');
  ws2.columns = [
    { header: 'Excel Row', key: 'excel_row', width: 10 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Employee Code', key: 'employee_code', width: 16 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'User ID', key: 'user_id', width: 10 },
    { header: 'Reason', key: 'reason', width: 80 },
  ];
  styleHeader(ws2);
  for (const row of errors) ws2.addRow(row);

  // Sheet 3: User Summary
  const ws3 = wb.addWorksheet('User Summary');
  ws3.columns = [
    { header: 'User ID', key: 'user_id', width: 10 },
    { header: 'User Name', key: 'user_name', width: 24 },
    { header: 'Role Scopes', key: 'role_scopes', width: 14 },
    { header: 'Departments', key: 'depts', width: 14 },
    { header: 'Hotel Mapping', key: 'mapping_created', width: 16 },
    { header: 'Errors', key: 'errors', width: 10 },
  ];
  styleHeader(ws3);
  for (const u of Object.values(userSummary)) ws3.addRow(u);

  // Sheet 4: Run Info
  const ws4 = wb.addWorksheet('Run Info');
  ws4.columns = [
    { header: 'Field', key: 'field', width: 24 },
    { header: 'Value', key: 'value', width: 60 },
  ];
  styleHeader(ws4);
  ws4.addRows([
    { field: 'Mode', value: DRY_RUN ? 'DRY RUN (no DB changes)' : 'LIVE' },
    { field: 'Excel File', value: FILE_PATH },
    { field: 'Hotel ID', value: hotel.id },
    { field: 'Hotel Name', value: hotel.name },
    { field: 'Hospitality Company ID', value: hotel.hospitality_company_id },
    { field: 'Run At', value: new Date().toISOString() },
    { field: 'Total Changes', value: changelog.length },
    { field: 'Total Errors', value: errors.length },
    { field: 'Users Touched', value: Object.keys(userSummary).length },
  ]);

  await wb.xlsx.writeFile(REPORT_PATH);
}

function styleHeader(ws) {
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('\n✗ FATAL:', err);
  process.exit(1);
});
