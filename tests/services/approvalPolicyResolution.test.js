// Approval-policy resolution tests.
//
// Validates the contract that `tbl_approval_policies.process_id` is part of
// resolution AT EVERY entity type. This locks F-APPROVAL-001 (cross-process
// fall-through to a process-agnostic policy must NOT happen) — the most
// load-bearing architectural rule on the approval engine.
//
// Each test uses fixture data (see tests/fixtures/) — the harness has already
// seeded:
//   - 3 processes: A_P1 (Standard Procurement), A_P2 (Daily Bazaar), B_P1
//   - Per-(process × hotel × entity) policies
//   - A1.P1 RFQ has 2 ALL steps (TECH_APPROVER role + finance user)
//   - A1.P2 RFQ has 1 ANY step (commercial-approver user)
//
// The tests below assert that an A1/proc RFQ in process P2 resolves to
// `IDS.policies.A1_P2_RFQ` (60041) — NOT to `IDS.policies.A1_P1_RFQ` (60001).
// This is the bug that F-APPROVAL-001 calls out in the auto-approve inline SQL
// at rfqController.js:3417.

import { describe, it, expect, afterAll, beforeEach } from "@jest/globals";
import { db, withTx, closeDb } from "../setup/db.js";
import {
  findBestMatchingPolicy,
  createApprovalInstance,
  checkIfUserIsFinalApprover,
} from "../../app/models/generalModel.js";
import { IDS } from "../fixtures/ids.js";

afterAll(async () => {
  await closeDb();
});

// Use distinct synthetic entity IDs per test so the unique-pending-instance
// guard inside createApprovalInstance doesn't cross-contaminate.
let ENTITY_ID_COUNTER = 9_000_000;
const nextEntityId = () => ++ENTITY_ID_COUNTER;

describe("findBestMatchingPolicy — master lookup (department_id IS NULL)", () => {
  it("returns the most specific policy for the given (process, hotel) pair", async () => {
    // Fixture policies are master (department_id IS NULL) per production
    // pattern (~92% of staging policies are master). The resolver picks the
    // most specific (process+hotel) match.
    const result = await findBestMatchingPolicy({
      entity_type: "RFQ",
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      department_id: null,
      process_id: IDS.processes.A_P1,
    });
    expect(result).not.toBeNull();
    expect(result.id).toBe(IDS.policies.A1_P1_RFQ);
    expect(result.process_id).toBe(IDS.processes.A_P1);
    expect(result.hotel_id).toBe(IDS.hotels.A1);
    // Specificity score 4 = (process_id NOT NULL) + (hotel_id NOT NULL).
    expect(result.specificity_score).toBe(4);
  });

  it("does NOT silently match a different process's policy", async () => {
    // Even if a process-agnostic master policy existed, it should never match
    // when we explicitly request process=B_P1 — they belong to different
    // companies. This guards against cross-company AND cross-process leakage.
    const result = await findBestMatchingPolicy({
      entity_type: "RFQ",
      hospitality_company_id: IDS.hospitality.B,
      hotel_id: IDS.hotels.B1,
      department_id: null,
      process_id: IDS.processes.A_P1, // wrong company's process
    });
    expect(result).toBeNull();
  });
});

describe("createApprovalInstance — process-scoped resolution", () => {
  it("RFQ in process P1 resolves to the P1 policy chain (NOT P2)", async () => {
    await withTx(async (t) => {
      const result = await createApprovalInstance({
        entity_type: "RFQ",
        entity_id: nextEntityId(),
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
        process_id: IDS.processes.A_P1,
        initiated_by: IDS.users.a1_proc_buyer,
        metadata: { rfq_number: "TEST-P1" },
        txContext: t,
      });
      expect(result.instance.approval_policy_id).toBe(IDS.policies.A1_P1_RFQ);
      // Sanity: it's NOT the P2 policy
      expect(result.instance.approval_policy_id).not.toBe(IDS.policies.A1_P2_RFQ);
    });
  });

  it("RFQ in process P2 resolves to the P2 policy chain (NOT P1)", async () => {
    await withTx(async (t) => {
      const result = await createApprovalInstance({
        entity_type: "RFQ",
        entity_id: nextEntityId(),
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
        process_id: IDS.processes.A_P2,
        initiated_by: IDS.users.a1_proc_buyer,
        metadata: { rfq_number: "TEST-P2" },
        txContext: t,
      });
      expect(result.instance.approval_policy_id).toBe(IDS.policies.A1_P2_RFQ);
      expect(result.instance.approval_policy_id).not.toBe(IDS.policies.A1_P1_RFQ);
    });
  });

  it("PO in process P1 vs P2 picks distinct PO policies", async () => {
    await withTx(async (t) => {
      const p1 = await createApprovalInstance({
        entity_type: "PO",
        entity_id: nextEntityId(),
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
        process_id: IDS.processes.A_P1,
        initiated_by: IDS.users.a1_proc_buyer,
        txContext: t,
      });
      const p2 = await createApprovalInstance({
        entity_type: "PO",
        entity_id: nextEntityId(),
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
        process_id: IDS.processes.A_P2,
        initiated_by: IDS.users.a1_proc_buyer,
        txContext: t,
      });
      expect(p1.instance.approval_policy_id).toBe(IDS.policies.A1_P1_PO);
      expect(p2.instance.approval_policy_id).toBe(IDS.policies.A1_P2_PO);
      expect(p1.instance.approval_policy_id).not.toBe(p2.instance.approval_policy_id);
    });
  });

  it("RFQ in process A_P2 + hotel A2/proc resolves to the A2_P2 policy distinctly — named in the refusal", async () => {
    // Multi-axis isolation: A2/P1 (no steps at all) and A2/P2 (a ROLE step whose
    // role cannot pass the read+approve gate for 'rfq'). Make sure P2 picks the
    // P2 policy and not P1's, or A1's.
    //
    // The observable proof of "which policy was picked" changed, the property
    // did not. This used to read the policy id off the created instance. The
    // A2_P2 fixture's single ROLE step resolves to zero approvers, and
    // createApprovalInstance now REFUSES a policy that resolves to nobody rather
    // than creating an instance born APPROVED with nobody asked — so there is no
    // instance row to read the id from. The refusal names the policy it
    // resolved, which is the same fact from the same lookup; asserting on it
    // keeps the cross-process isolation pinned. This mirrors the sibling test
    // "A2/P1 RFQ has zero steps and either auto-completes or throws clearly".
    await withTx(async (t) => {
      const attempt = createApprovalInstance({
        entity_type: "RFQ",
        entity_id: nextEntityId(),
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A2,
        department_id: IDS.departments.proc,
        process_id: IDS.processes.A_P2,
        initiated_by: IDS.users.a1_proc_buyer,
        txContext: t,
      });

      // The resolved policy is A2_P2 (60051) — NOT A2_P1 (60021), NOT A1_P2.
      await expect(attempt).rejects.toThrow(
        new RegExp(`policy ${IDS.policies.A2_P2_RFQ}\\b`, "i")
      );
      await expect(attempt).rejects.toMatchObject({
        code: "APPROVAL_POLICY_RESOLVES_TO_NOBODY",
        httpStatus: 400,
      });
    });
  });

  it("THROWS when no policy exists for the requested (process, scope) combo (no cross-process fall-through)", async () => {
    // A3 has only a P1 RFQ policy seeded; P2 does NOT exist for A3.
    // System MUST refuse to fall through to a P1 or process-agnostic policy.
    await withTx(async (t) => {
      await expect(
        createApprovalInstance({
          entity_type: "RFQ",
          entity_id: nextEntityId(),
          hospitality_company_id: IDS.hospitality.A,
          hotel_id: IDS.hotels.A3,
          department_id: IDS.departments.proc,
          process_id: IDS.processes.A_P2,
          initiated_by: IDS.users.a1_proc_buyer,
          txContext: t,
        })
      ).rejects.toThrow(/No approval policy found/i);
    });
  });

  it("THROWS for the deliberately-missing PO policy at A3/P1 (under-configured BU)", async () => {
    await withTx(async (t) => {
      await expect(
        createApprovalInstance({
          entity_type: "PO",
          entity_id: nextEntityId(),
          hospitality_company_id: IDS.hospitality.A,
          hotel_id: IDS.hotels.A3,
          department_id: IDS.departments.proc,
          process_id: IDS.processes.A_P1,
          initiated_by: IDS.users.a1_proc_buyer,
          txContext: t,
        })
      ).rejects.toThrow(/No approval policy found/i);
    });
  });
});

describe("createApprovalInstance — zero-approver auto-skip", () => {
  it("A2/P1 RFQ has zero steps and either auto-completes or throws clearly (NOT silently picks another policy)", async () => {
    // A2/P1 RFQ policy is seeded with NO steps. createApprovalInstance currently
    // throws 'Policy has no approval steps configured'. We assert that behaviour
    // — the engine must surface this case rather than fall through to a different
    // policy/process.
    await withTx(async (t) => {
      await expect(
        createApprovalInstance({
          entity_type: "RFQ",
          entity_id: nextEntityId(),
          hospitality_company_id: IDS.hospitality.A,
          hotel_id: IDS.hotels.A2,
          department_id: IDS.departments.proc,
          process_id: IDS.processes.A_P1,
          initiated_by: IDS.users.a1_proc_buyer,
          txContext: t,
        })
      ).rejects.toThrow(/no approval steps configured/i);
    });
  });
});

// ============================================================================
// F-APPROVAL-001 — auto-approve branch must scope by process_id
//
// Two distinct bug sites still in production:
//   (a) checkIfUserIsFinalApprover (generalModel.js:2301) does not accept a
//       process_id parameter; it then calls findBestMatchingPolicyTx WITHOUT
//       process_id, falling through to process-agnostic policies (or returning
//       null when no agnostic policy exists).
//   (b) The auto-approve inline SQL at rfqController.js:3419-3437 omits
//       process_id from its WHERE clause, so when the auto-approve branch IS
//       entered for a multi-process tenant, it silently picks any process's
//       policy by specificity ordering.
//
// These tests assert the POST-FIX correct behaviour: process_id is honoured at
// every step of the auto-approve path. They will fail until both sites are
// fixed. After the fix, this is the regression lock.
// ============================================================================
describe("F-APPROVAL-001 — auto-approve must scope by process_id", () => {
  it("checkIfUserIsFinalApprover returns TRUE for the P2 final approver under a P2 RFQ", async () => {
    // a1_proc_commApp (80015) is the SOLE step-1 ANY approver of A1_P2_RFQ
    // (60041), and is therefore the final approver of any P2 RFQ at A1/proc.
    // The function MUST accept process_id and resolve the P2 policy chain.
    await withTx(async (t) => {
      const result = await checkIfUserIsFinalApprover(
        IDS.users.a1_proc_commApp,
        "RFQ",
        IDS.hospitality.A,
        IDS.hotels.A1,
        IDS.departments.proc,
        t,
        IDS.processes.A_P2 /* process_id — currently ignored by the function */
      );
      expect(result).toBe(true);
    });
  });

  it("checkIfUserIsFinalApprover returns FALSE for a P1-only final approver under a P2 RFQ (no cross-process leak)", async () => {
    // a1_proc_finance (80017) is the final approver of A1_P1_RFQ (2-step ALL,
    // step 2 = finance user). They are NOT in the A1_P2_RFQ chain at all.
    // For a P2 RFQ scope, the function must return FALSE — must not fall
    // through to P1 to claim "yes you are a final approver".
    await withTx(async (t) => {
      const result = await checkIfUserIsFinalApprover(
        IDS.users.a1_proc_finance,
        "RFQ",
        IDS.hospitality.A,
        IDS.hotels.A1,
        IDS.departments.proc,
        t,
        IDS.processes.A_P2
      );
      expect(result).toBe(false);
    });
  });

  it("checkIfUserIsFinalApprover returns TRUE for the P1 final approver under a P1 RFQ", async () => {
    // Positive control: a1_proc_finance IS the final approver of A1_P1_RFQ.
    // Under process P1, the function must return TRUE.
    await withTx(async (t) => {
      const result = await checkIfUserIsFinalApprover(
        IDS.users.a1_proc_finance,
        "RFQ",
        IDS.hospitality.A,
        IDS.hotels.A1,
        IDS.departments.proc,
        t,
        IDS.processes.A_P1
      );
      expect(result).toBe(true);
    });
  });
});

describe("createApprovalInstance — duplicate-pending guard", () => {
  it("refuses to create a second PENDING instance for the same (entity_type, entity_id)", async () => {
    await withTx(async (t) => {
      const entityId = nextEntityId();
      const first = await createApprovalInstance({
        entity_type: "RFQ",
        entity_id: entityId,
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
        process_id: IDS.processes.A_P1,
        initiated_by: IDS.users.a1_proc_buyer,
        txContext: t,
      });
      expect(first.instance.id).toBeTruthy();
      // Re-attempt against same entity_id within the same tx: should reject.
      await expect(
        createApprovalInstance({
          entity_type: "RFQ",
          entity_id: entityId,
          hospitality_company_id: IDS.hospitality.A,
          hotel_id: IDS.hotels.A1,
          department_id: IDS.departments.proc,
          process_id: IDS.processes.A_P1,
          initiated_by: IDS.users.a1_proc_buyer,
          txContext: t,
        })
      ).rejects.toThrow(/already exists/i);
    });
  });

  it("allows a fresh instance for NEGOTIATION_QUOTE even if a prior APPROVED instance exists", async () => {
    // Quote re-finalization (after vendor PO reject) must be allowed without
    // tripping the duplicate guard.
    await withTx(async (t) => {
      const entityId = nextEntityId();
      // Direct INSERT to seed an APPROVED instance, bypassing the standard path.
      await t.none(
        `INSERT INTO tbl_approval_instances
           (entity_type, entity_id, approval_policy_id, status, current_step,
            initiated_by, hospitality_company_id, hotel_id, department_id, process_id, completed_at)
         VALUES ('NEGOTIATION_QUOTE', $1, $2, 'APPROVED', 0, $3, $4, $5, $6, $7, NOW())`,
        [
          entityId,
          IDS.policies.A1_P1_NEGOTIATION_QUOTE,
          IDS.users.a1_proc_buyer,
          IDS.hospitality.A,
          IDS.hotels.A1,
          IDS.departments.proc,
          IDS.processes.A_P1,
        ]
      );

      const fresh = await createApprovalInstance({
        entity_type: "NEGOTIATION_QUOTE",
        entity_id: entityId,
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc,
        process_id: IDS.processes.A_P1,
        initiated_by: IDS.users.a1_proc_buyer,
        txContext: t,
      });
      expect(fresh.instance.status).toBe("PENDING");
      expect(fresh.instance.id).toBeTruthy();
    });
  });
});
