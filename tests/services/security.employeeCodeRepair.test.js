/**
 * The one-off production repair that must run before the unique index can be
 * added (scripts/login_identity/repair_duplicate_employee_codes.sql).
 *
 * It is executed here against rows shaped exactly like production's — the same
 * user ids, statuses and companies, with stand-in codes — because it will run
 * once, on production, with no second chance. What must hold:
 *   - it frees the codes held by the three deactivated twins, recodes our own
 *     test account, and trims the padded code — and touches nothing else;
 *   - the pair only the client can resolve is left alone, so the migration
 *     still refuses, naming only that pair;
 *   - if production no longer looks as verified, it changes NOTHING;
 *   - every change lands in the audit trail under one request id.
 *
 * Isolation: commit + cleanup; the unique index is lifted for the duration.
 */
import fs from "fs";
import path from "path";
import { db, closeDb } from "../setup/db.js";
import { dropEmployeeCodeIndex, restoreEmployeeCodeIndex, employeeCodeIndexDef } from "../helpers/employeeCodeIndex.js";

const REPAIR = path.resolve("scripts/login_identity/repair_duplicate_employee_codes.sql");
const MIGRATION = path.resolve("migrations/20261016100000_unique_employee_code.sql");

const IDS = [330, 360, 135, 294, 144, 1005, 615, 617, 324, 325, 819];
const COMPANIES = [13, 90];

// Production's shape on 2026-10-16, codes replaced with stand-ins.
const PRODUCTION_SHAPE = [
  { id: 330, code: "EMP-A", status: 0, company: 13 },
  { id: 360, code: "EMP-A", status: 1, company: 13 },
  { id: 135, code: "EMP-B", status: 0, company: 13 },
  { id: 294, code: "EMP-B", status: 1, company: 13 },
  { id: 144, code: "EMP-C", status: 0, company: 13 },
  { id: 1005, code: "EMP-C", status: 1, company: 13 },
  { id: 615, code: "AWS1", status: 1, company: 90 },
  { id: 617, code: "AWS1", status: 1, company: 90 },
  { id: 324, code: "EMP-D", status: 1, company: 13 },
  { id: 325, code: "EMP-D", status: 1, company: 13 },
  { id: 819, code: " EMP-E", status: 1, company: 13 },
];

// On its own connection: a RAISE inside the file's BEGIN leaves that session
// in an aborted transaction, which must not go back to the pool.
const runFile = (file) =>
  db.task(async (t) => {
    try {
      await t.none(fs.readFileSync(file, "utf8"));
    } catch (err) {
      await t.none("ROLLBACK");
      throw err;
    }
  });

const codes = async () =>
  Object.fromEntries(
    (await db.any("SELECT id, employee_code FROM tbl_users WHERE id = ANY($1)", [IDS])).map((r) => [Number(r.id), r.employee_code])
  );

async function seed(rows = PRODUCTION_SHAPE) {
  for (const c of COMPANIES) {
    await db.none(
      `INSERT INTO tbl_company (id, company_name, is_hospitality, "createdAt") VALUES ($1, $2, 1, now()) ON CONFLICT (id) DO NOTHING`,
      [c, `Repair test company ${c}`]
    );
  }
  for (const r of rows) {
    await db.none(
      `INSERT INTO tbl_users (id, name, email, status, is_deleted, user_type, company_id, employee_code, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 0, 2, $5, $6, now(), now())`,
      [r.id, `Repair ${r.id}`, `repair-${r.id}@example.com`, r.status, r.company, r.code]
    );
  }
}

let indexDef;

beforeAll(async () => {
  indexDef = await dropEmployeeCodeIndex();
});

afterEach(async () => {
  await db.none("DELETE FROM tbl_audit_row_changes WHERE table_name = 'tbl_users' AND record_id = ANY($1)", [IDS]);
  await db.none("DELETE FROM tbl_users WHERE id = ANY($1)", [IDS]);
});

// The two company rows stay: the reference seed's approval processes point at
// company 13 through a NOT VALID foreign key, so deleting it is refused. They
// carry no users once this file is done, and every run gets a fresh database.
afterAll(async () => {
  await restoreEmployeeCodeIndex(indexDef);
  await closeDb();
});

describe("on production's shape", () => {
  it("frees the deactivated twins' codes, recodes our test account, trims the padded code", async () => {
    await seed();
    await runFile(REPAIR);

    expect(await codes()).toEqual({
      330: "EMP-A-INACTIVE-330",
      360: "EMP-A",
      135: "EMP-B-INACTIVE-135",
      294: "EMP-B",
      144: "EMP-C-INACTIVE-144",
      1005: "EMP-C",
      615: "AWS1",
      617: "AWS2",
      324: "EMP-D",
      325: "EMP-D",
      819: "EMP-E",
    });
  });

  it("changes nothing but the employee codes", async () => {
    await seed();
    const before = await db.any("SELECT id, status, is_deleted, user_type, company_id, name, email FROM tbl_users WHERE id = ANY($1) ORDER BY id", [IDS]);
    await runFile(REPAIR);
    const after = await db.any("SELECT id, status, is_deleted, user_type, company_id, name, email FROM tbl_users WHERE id = ANY($1) ORDER BY id", [IDS]);
    expect(after).toEqual(before);
  });

  it("records every change in the audit trail under one request id", async () => {
    await seed();
    await runFile(REPAIR);
    const audit = await db.any(
      `SELECT record_id, request_id FROM tbl_audit_row_changes
        WHERE table_name = 'tbl_users' AND operation = 'UPDATE' AND record_id = ANY($1)`,
      [IDS]
    );
    expect(audit.map((a) => Number(a.record_id)).sort((a, b) => a - b)).toEqual([135, 144, 330, 617, 819]);
    expect(new Set(audit.map((a) => a.request_id)).size).toBe(1);
    expect(audit[0].request_id).toBeTruthy();
  });

  it("leaves the migration refusing only for the pair the client must resolve", async () => {
    await seed();
    await runFile(REPAIR);
    let message = "";
    try {
      await runFile(MIGRATION);
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/EMP-D \(users 324, 325\)/);
    expect(message).not.toMatch(/EMP-A|EMP-B|EMP-C|AWS1/);
    expect(await employeeCodeIndexDef()).toBeNull();
  });

  it("lets the migration add the index once the client's pair is corrected", async () => {
    await seed();
    await runFile(REPAIR);
    await db.none("UPDATE tbl_users SET employee_code = 'EMP-D2' WHERE id = 325");
    await runFile(MIGRATION);
    expect(await employeeCodeIndexDef()).not.toBeNull();
    await db.none("DROP INDEX public.uq_users_employee_code_live");
  });
});

describe("when production no longer looks as verified, it changes nothing", () => {
  const variants = [
    ["a deactivated twin was reactivated", (rows) => rows.map((r) => (r.id === 330 ? { ...r, status: 1 } : r))],
    ["a twin's active partner was deactivated too", (rows) => rows.map((r) => (r.id === 360 ? { ...r, status: 0 } : r))],
    ["a code was already fixed by hand", (rows) => rows.map((r) => (r.id === 135 ? { ...r, code: "EMP-B-OLD" } : r))],
    ["the padded code was already trimmed", (rows) => rows.map((r) => (r.id === 819 ? { ...r, code: "EMP-E" } : r))],
    ["AWS2 is already taken", (rows) => [...rows.filter((r) => r.id !== 615), { id: 615, code: "AWS2", status: 1, company: 90 }]],
    ["a new duplicate has appeared", (rows) => rows.map((r) => (r.id === 1005 ? { ...r, code: "EMP-A" } : r))],
  ];

  it.each(variants)("%s", async (_label, mutate) => {
    const rows = mutate(PRODUCTION_SHAPE);
    await seed(rows);
    const before = await codes();
    await expect(runFile(REPAIR)).rejects.toThrow(/precondition|postcondition|expected/);
    expect(await codes()).toEqual(before);
  });

  it("refuses a second run", async () => {
    await seed();
    await runFile(REPAIR);
    const once = await codes();
    await expect(runFile(REPAIR)).rejects.toThrow(/precondition/);
    expect(await codes()).toEqual(once);
  });
});
