// Process-scoped approver resolution — the "populate approvers by process"
// behavior. resolveApprovers() is the shared engine that createApprovalInstance
// uses for EVERY entity type, including ARC (ARC_TECH / ARC_COMMITTEE etc.):
// ARC controllers already pass `arc.process_id` into createApprovalInstance,
// which forwards it here. This suite proves that once a process is supplied,
// only users whose role scope covers that process (or hold the NULL wildcard)
// are resolved as approvers/action-takers.
//
// We exercise resolveApprovers directly (rather than a full createApprovalInstance)
// so the assertion is about WHO qualifies, isolated from policy/step plumbing.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { resolveApprovers } from "../../app/models/generalModel.js";

const ROLE_TENDER_CREATOR = 2;

// Base fixtures: a1_proc_buyer + multiHotel both hold TENDER_CREATOR at
// (A, A1, proc) with process_id NULL (wildcard) and have hospitality mappings
// at A/A1 — so a ROLE step at A1/proc resolves BOTH of them by default.
const A = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const PROC = IDS.departments.proc;
const P1 = IDS.processes.A_P1;
const P2 = IDS.processes.A_P2;
const BUYER = IDS.users.a1_proc_buyer;
const MULTI = IDS.users.multiHotel;

const roleStep = { approver_source_type: "ROLE", approver_source_id: ROLE_TENDER_CREATOR };
const userStep = (uid) => ({ approver_source_type: "USER", approver_source_id: uid });

async function addScopeRow({ user_id, role_id = ROLE_TENDER_CREATOR, company_id = A, hotel_id = A1, department_id = PROC, process_id = null }) {
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, role_id, company_id, COALESCE(hotel_id, 0), COALESCE(department_id, 0), COALESCE(process_id, 0))
     DO NOTHING`,
    [user_id, role_id, company_id, hotel_id, department_id, process_id]
  );
}

async function removeScopeRow({ user_id, role_id = ROLE_TENDER_CREATOR, company_id = A, hotel_id = A1, department_id = PROC, process_id = null }) {
  await db.none(
    `DELETE FROM tbl_user_role_scopes
      WHERE user_id = $1 AND role_id = $2 AND company_id = $3
        AND COALESCE(hotel_id, 0) = COALESCE($4, 0)
        AND COALESCE(department_id, 0) = COALESCE($5, 0)
        AND COALESCE(process_id, 0) = COALESCE($6, 0)`,
    [user_id, role_id, company_id, hotel_id, department_id, process_id]
  );
}

afterAll(async () => {
  await closeDb();
});

describe("resolveApprovers — ROLE step, wildcard (NULL) process rows", () => {
  it("resolves BOTH fixture role-holders for a P1 instance when their scope is the NULL wildcard", async () => {
    const ids = await resolveApprovers(roleStep, A, A1, PROC, db, null, P1);
    expect(ids).toEqual(expect.arrayContaining([BUYER, MULTI]));
  });

  it("resolves the same set when no process is supplied (legacy path, process_id = null)", async () => {
    const ids = await resolveApprovers(roleStep, A, A1, PROC, db, null, null);
    expect(ids).toEqual(expect.arrayContaining([BUYER, MULTI]));
  });
});

describe("resolveApprovers — ROLE step, process narrowing", () => {
  // Pin multiHotel to process P2 ONLY at A1/proc: drop the wildcard, add a
  // strict P2 row. a1_proc_buyer keeps its wildcard.
  beforeAll(async () => {
    await removeScopeRow({ user_id: MULTI, process_id: null });
    await addScopeRow({ user_id: MULTI, process_id: P2 });
  });
  afterAll(async () => {
    await removeScopeRow({ user_id: MULTI, process_id: P2 });
    await addScopeRow({ user_id: MULTI, process_id: null }); // restore fixture state
  });

  it("EXCLUDES the P2-pinned user from a P1 instance, keeps the wildcard user", async () => {
    const ids = await resolveApprovers(roleStep, A, A1, PROC, db, null, P1);
    expect(ids).toContain(BUYER);
    expect(ids).not.toContain(MULTI);
  });

  it("INCLUDES the P2-pinned user for a P2 instance (plus the wildcard user)", async () => {
    const ids = await resolveApprovers(roleStep, A, A1, PROC, db, null, P2);
    expect(ids).toEqual(expect.arrayContaining([BUYER, MULTI]));
  });

  it("still resolves BOTH when process is not supplied (narrowing only bites with a specific process)", async () => {
    const ids = await resolveApprovers(roleStep, A, A1, PROC, db, null, null);
    expect(ids).toEqual(expect.arrayContaining([BUYER, MULTI]));
  });
});

describe("resolveApprovers — USER step honors process scope", () => {
  beforeAll(async () => {
    await removeScopeRow({ user_id: MULTI, process_id: null });
    await addScopeRow({ user_id: MULTI, process_id: P2 });
  });
  afterAll(async () => {
    await removeScopeRow({ user_id: MULTI, process_id: P2 });
    await addScopeRow({ user_id: MULTI, process_id: null });
  });

  it("resolves a USER approver for the process they are pinned to (P2)", async () => {
    const ids = await resolveApprovers(userStep(MULTI), A, A1, PROC, db, null, P2);
    expect(ids).toContain(MULTI);
  });

  it("does NOT resolve the USER approver for a different process (P1)", async () => {
    const ids = await resolveApprovers(userStep(MULTI), A, A1, PROC, db, null, P1);
    expect(ids).not.toContain(MULTI);
  });

  it("resolves the USER approver when no process is supplied (legacy permissive)", async () => {
    const ids = await resolveApprovers(userStep(MULTI), A, A1, PROC, db, null, null);
    expect(ids).toContain(MULTI);
  });
});
