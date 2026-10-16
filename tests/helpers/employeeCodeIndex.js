// The unique index that makes a duplicate employee code impossible
// (migrations/20261016100000_unique_employee_code.sql).
//
// Tests that replay production's legacy state — two live rows sharing a code,
// as existed before the index — have to lift it for their block. They capture
// the definition first and put back exactly that, so a suite can never leave
// the database weaker than it found it.
import { db } from "../setup/db.js";

export const EMPLOYEE_CODE_INDEX = "uq_users_employee_code_live";

export async function employeeCodeIndexDef() {
  const row = await db.oneOrNone(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1",
    [EMPLOYEE_CODE_INDEX]
  );
  return row?.indexdef ?? null;
}

/** Drops the index if present; returns its definition for restoreEmployeeCodeIndex. */
export async function dropEmployeeCodeIndex() {
  const def = await employeeCodeIndexDef();
  if (def) await db.none(`DROP INDEX public.${EMPLOYEE_CODE_INDEX}`);
  return def;
}

export async function restoreEmployeeCodeIndex(def) {
  if (def && !(await employeeCodeIndexDef())) await db.none(def);
}
