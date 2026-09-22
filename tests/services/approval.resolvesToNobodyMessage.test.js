// When a policy resolves to nobody, the refusal has to name the actual gap.
//
// Production incident 2026-09-21, RFQ 536602 at ORCHID PASSAROS GOA. Policy 83
// has two steps and both dropped:
//   step 1  ROLE "RFQ Creator"     — holds rfq.read/create/update but NOT
//                                    rfq.approve, so it can NEVER approve.
//   step 2  ROLE "Tender Approver" — qualified, but nobody held it for
//                                    department Housekeeping at that unit.
//
// The engine correctly refused (failing closed beats auto-approving), but told
// the creator only:
//
//   "Approval policy 83 for RFQ resolved to zero usable approval steps ...
//    Fix the policy (Settings -> Approvals) — each step needs an approver who
//    holds both read and approve on this entity"
//
// That sends the admin to the wrong place. Policy 83 was fine for 10 of the 16
// departments; the real gap was a missing department-scoped role assignment.
// An admin opens the policy, sees two sensible roles, and is stuck — the exact
// dead end the engine's own comments warn about for the `tender.read` case.
//
// The two failures need different fixes, so the message must distinguish them
// and name the role, the department and the business unit.
//
// Isolation: Pattern A (transactional rollback) — createApprovalInstance takes
// a tx context, so nothing is committed.

import { describe, it, expect, afterAll } from "@jest/globals";
import { db, withTx, closeDb } from "../setup/db.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";
import { IDS } from "../fixtures/ids.js";

// Mirrors prod: role 2 holds rfq read+create but NOT approve; role 5 holds
// read+approve but (asserted below) nobody holds it in this scope.
const ROLE_CANNOT_APPROVE = 2;
const ROLE_QUALIFIED_BUT_UNHELD = 5;

let ENTITY_ID = 9_400_000;
const nextEntityId = () => ++ENTITY_ID;

afterAll(async () => {
  await closeDb();
});

/** Build a two-step RFQ policy shaped exactly like production policy 83. */
async function makePolicy83Shape(t) {
  const policy = await t.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id, process_id,
        is_active, created_by, is_master)
     VALUES ('RFQ', $1, $2, NULL, NULL, true, $3, true)
     RETURNING id`,
    [IDS.hospitality.A, IDS.hotels.A1, IDS.users.companyA_admin]
  );
  for (const [order, roleId] of [[1, ROLE_CANNOT_APPROVE], [2, ROLE_QUALIFIED_BUT_UNHELD]]) {
    await t.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, approval_type, decision_rule,
          approver_source_type, approver_source_id)
       VALUES ($1, $2, 'STANDARD', 'ANY', 'ROLE', $3)`,
      [policy.id, order, roleId]
    );
  }
  return policy.id;
}

const attemptSubmit = (t, policyHint) =>
  createApprovalInstance({
    entity_type: "RFQ",
    entity_id: nextEntityId(),
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: IDS.hotels.A1,
    department_id: IDS.departments.hk,
    initiated_by: IDS.users.companyA_admin,
    txContext: t,
    ...policyHint,
  });

describe("refusal message when a policy resolves to nobody", () => {
  it("still refuses rather than creating an unapprovable instance", async () => {
    await withTx(async (t) => {
      await makePolicy83Shape(t);
      await expect(attemptSubmit(t)).rejects.toMatchObject({
        code: "APPROVAL_POLICY_RESOLVES_TO_NOBODY",
        httpStatus: 400,
      });
    });
  });

  it("names the business unit and department the creator was working in", async () => {
    await withTx(async (t) => {
      await makePolicy83Shape(t);
      const hotel = await t.one(`SELECT name FROM tbl_hospitality_company_hotels WHERE id = $1`, [IDS.hotels.A1]);
      const dept = await t.one(`SELECT title FROM tbl_department WHERE id = $1`, [IDS.departments.hk]);

      const err = await attemptSubmit(t).catch((e) => e);
      expect(err.message).toContain(hotel.name);
      expect(err.message).toContain(dept.title);
    });
  });

  it("says which role can never approve, and names the missing permission", async () => {
    await withTx(async (t) => {
      await makePolicy83Shape(t);
      const role = await t.one(`SELECT title FROM tbl_roles WHERE id = $1`, [ROLE_CANNOT_APPROVE]);

      const err = await attemptSubmit(t).catch((e) => e);
      expect(err.message).toContain(role.title);
      expect(err.message).toMatch(/rfq\.approve/);
    });
  });

  it("distinguishes a role with nobody assigned from a role that cannot approve", async () => {
    await withTx(async (t) => {
      await makePolicy83Shape(t);

      // Precondition: the second role really is unheld in this scope, so the
      // step drops for "nobody assigned" and not for permissions.
      const held = await t.one(
        `SELECT COUNT(*)::int AS n FROM tbl_user_role_scopes
          WHERE role_id = $1 AND company_id = $2
            AND (hotel_id IS NULL OR hotel_id = $3)
            AND (department_id IS NULL OR department_id = $4)`,
        [ROLE_QUALIFIED_BUT_UNHELD, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.hk]
      );
      expect(held.n).toBe(0);

      const qualifiedRole = await t.one(`SELECT title FROM tbl_roles WHERE id = $1`, [ROLE_QUALIFIED_BUT_UNHELD]);
      const err = await attemptSubmit(t).catch((e) => e);

      expect(err.message).toContain(qualifiedRole.title);
      // The two steps failed for different reasons and need different fixes.
      expect(err.message).toMatch(/nobody|no one|not assigned/i);
    });
  });

  it("keeps the diagnostics on the error for support to read", async () => {
    await withTx(async (t) => {
      const policyId = await makePolicy83Shape(t);
      const err = await attemptSubmit(t).catch((e) => e);

      expect(err.message).toContain(String(policyId));
      expect(err.diagnostics.policy_step_count).toBe(2);
      expect(err.diagnostics.resolved_step_count).toBe(0);
      expect(err.diagnostics.skipped_steps.map((s) => s.reason).sort()).toEqual(
        ["NO_APPROVERS_RESOLVED", "ROLE_LACKS_READ_AND_APPROVE"]
      );
    });
  });
});
