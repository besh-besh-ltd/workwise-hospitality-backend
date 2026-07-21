// RBAC persist/read round-trip for the process scope axis. The Approval
// Wizard's approver filtering (frontend useApprovalData → getBatchUserRoleScopes)
// depends on getUserRoleScopesBatch returning process_id + process_name +
// process_type per scope row, so this pins that contract.

import { describe, it, expect, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import rbacModel from "../../app/models/rbacModel.js";

const ROLE_TENDER_CREATOR = 2;
const A = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const PROC = IDS.departments.proc;
const P1 = IDS.processes.A_P1;
// dualRole is a fixture user we can attach an extra process-scoped row to
// without disturbing the approver-resolution fixtures.
const U = IDS.users.dualRole;

async function cleanup() {
  await db.none(
    `DELETE FROM tbl_user_role_scopes
      WHERE user_id = $1 AND role_id = $2 AND company_id = $3
        AND COALESCE(hotel_id,0) = $4 AND COALESCE(department_id,0) = $5
        AND process_id = $6`,
    [U, ROLE_TENDER_CREATOR, A, A1, PROC, P1]
  );
}

afterEach(cleanup);
afterAll(async () => { await closeDb(); });

describe("rbacModel — process_id persist + read round-trip", () => {
  it("assignUserRoleScopes persists process_id and getUserRoleScopesBatch returns it enriched", async () => {
    await rbacModel.assignUserRoleScopes([
      { user_id: U, role_id: ROLE_TENDER_CREATOR, company_id: A, hotel_id: A1, department_id: PROC, process_id: P1 },
    ]);

    const batch = await rbacModel.getUserRoleScopesBatch([U]);
    const row = batch.find(
      (r) => Number(r.process_id) === P1 && Number(r.role_id) === ROLE_TENDER_CREATOR && Number(r.hotel_id) === A1
    );

    expect(row).toBeTruthy();
    expect(Number(row.process_id)).toBe(P1);
    // Enriched from the LEFT JOIN on tbl_approval_processes — the wizard uses
    // these to label/filter approver options by process.
    expect(row.process_name).toBeTruthy();
    expect(["RFQ", "TENDER", "ARC"]).toContain(row.process_type);
  });

  it("getUserRoleScopes (single) also surfaces the process fields", async () => {
    await rbacModel.assignUserRoleScopes([
      { user_id: U, role_id: ROLE_TENDER_CREATOR, company_id: A, hotel_id: A1, department_id: PROC, process_id: P1 },
    ]);

    const rows = await rbacModel.getUserRoleScopes(U);
    const row = rows.find((r) => Number(r.process_id) === P1);
    expect(row).toBeTruthy();
    expect(row.process_name).toBeTruthy();
  });

  it("a scope row with NULL process_id round-trips as the wildcard (process_id null, no process name)", async () => {
    // The base fixture rows for dualRole are NULL-process. Assert at least one
    // NULL-process row reads back with null process metadata.
    const rows = await rbacModel.getUserRoleScopes(U);
    const wildcard = rows.find((r) => r.process_id == null);
    expect(wildcard).toBeTruthy();
    expect(wildcard.process_name == null).toBe(true);
  });
});
