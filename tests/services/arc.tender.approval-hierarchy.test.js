// Phase 9 — product-level test for the tender approval hierarchy contract.
//
// What the architecture is: tender vs RFQ is discriminated by
// `process_id`, not by new entity types. Existing entity types
// (TENDER, TECHNICAL, NEGOTIATION_QUOTE, ARC) are reused; the engine
// resolves the correct policy via (entity_type, process_id) under the
// existing company+hotel+dept precedence.
//
// What the buyer should observe:
//   - Two distinct TENDER-typed processes (e.g. "Single Hotel ARC"
//     vs "Group ARC") route their stages to two different committees,
//     each carrying its own policy chain. They never cross-contaminate.
//   - When a stage has no policy configured under the chosen process,
//     the engine refuses with a structured TENDER_POLICY_NOT_CONFIGURED
//     code so the FE can deep-link the admin instead of silently
//     falling back to an RFQ committee.
//   - For Group ARC (tender_scope='GROUP'), the engine routes to the
//     single global policy under the parent tbl_company.id. No BU
//     scoping. No fallback to non-global. Missing → same structured
//     error code.
//   - Defence in depth: a process-agnostic policy (process_id IS NULL)
//     must NEVER be silently picked up for a tender stage that
//     supplied an explicit process_id. That would route a tender's
//     ARC stage to the routine RFQ committee.
//
// This suite locks the contract end-to-end via the engine's public API.

import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";

const TENDER_PROCESS_A = 70096;
const TENDER_PROCESS_B = 70097;

const POLICY_A_ARC = 60096;
const POLICY_B_ARC = 60097;
const POLICY_GLOBAL_ARC = 60098;
const POLICY_AGNOSTIC = 60099;

beforeAll(async () => {
  // Two distinct TENDER processes under company A.
  await db.none(
    `INSERT INTO tbl_approval_processes
       (id, company_id, name, description, is_active, created_by, process_type)
     VALUES
       ($1, $3, 'Tender Process A — Single Hotel ARC', '', true, $4, 'TENDER'),
       ($2, $3, 'Tender Process B — Different Committee', '', true, $4, 'TENDER')
     ON CONFLICT (id) DO NOTHING`,
    [TENDER_PROCESS_A, TENDER_PROCESS_B, IDS.companies.A, IDS.users.companyA_admin]
  );

  // Process A's ARC policy → committee = a1_proc_commApp.
  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped,
        version, company_id, is_global)
     VALUES ($1, 'ARC', $2, $3, NULL, true, $4, $5, false, false, 1, $6, 0)
     ON CONFLICT (id) DO NOTHING`,
    [POLICY_A_ARC, IDS.hospitality.A, IDS.hotels.A1,
     IDS.users.companyA_admin, TENDER_PROCESS_A, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ANY', 'USER', $2) ON CONFLICT DO NOTHING`,
    [POLICY_A_ARC, IDS.users.a1_proc_commApp]
  );

  // Process B's ARC policy → committee = a1_proc_finance (deliberately
  // different person so we can assert non-overlap).
  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped,
        version, company_id, is_global)
     VALUES ($1, 'ARC', $2, $3, NULL, true, $4, $5, false, false, 1, $6, 0)
     ON CONFLICT (id) DO NOTHING`,
    [POLICY_B_ARC, IDS.hospitality.A, IDS.hotels.A1,
     IDS.users.companyA_admin, TENDER_PROCESS_B, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ANY', 'USER', $2) ON CONFLICT DO NOTHING`,
    [POLICY_B_ARC, IDS.users.a1_proc_finance]
  );

  // Global ARC policy for Group ARC at company A — no BU scoping.
  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped,
        version, company_id, is_global)
     VALUES ($1, 'ARC', NULL, NULL, NULL, true, $2, NULL, false, false, 1, $3, 1)
     ON CONFLICT (id) DO NOTHING`,
    [POLICY_GLOBAL_ARC, IDS.users.companyA_admin, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ANY', 'USER', $2) ON CONFLICT DO NOTHING`,
    [POLICY_GLOBAL_ARC, IDS.users.companyA_admin]
  );

  // A process-agnostic ARC policy at the same scope (no process_id).
  // The strict process-match guard MUST refuse this for tender callers.
  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped,
        version, company_id, is_global)
     VALUES ($1, 'ARC', $2, $3, NULL, true, $4, NULL, false, false, 1, $5, 0)
     ON CONFLICT (id) DO NOTHING`,
    [POLICY_AGNOSTIC, IDS.hospitality.A, IDS.hotels.A2,
     IDS.users.companyA_admin, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ANY', 'USER', $2) ON CONFLICT DO NOTHING`,
    [POLICY_AGNOSTIC, IDS.users.superAdmin]
  );
});

afterAll(async () => {
  await db.none(
    `DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`,
    [[POLICY_A_ARC, POLICY_B_ARC, POLICY_GLOBAL_ARC, POLICY_AGNOSTIC]]
  );
  await db.none(
    `DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`,
    [[POLICY_A_ARC, POLICY_B_ARC, POLICY_GLOBAL_ARC, POLICY_AGNOSTIC]]
  );
  await db.none(`DELETE FROM tbl_approval_processes WHERE id = ANY($1::int[])`,
    [[TENDER_PROCESS_A, TENDER_PROCESS_B]]);
  await closeDb();
});

// We use synthetic entity_ids well outside the real arc_item id range so
// each test gets its own non-conflicting "slot". The engine's existing-
// instance check is keyed by (entity_type, entity_id).
let entityIdSeed = 99000000;
const nextEntityId = () => ++entityIdSeed;

const cleanupInstance = async (instance) => {
  if (!instance?.id) return;
  await db.none(
    `DELETE FROM tbl_approval_step_approvers
      WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1)`,
    [instance.id]
  );
  await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = $1`, [instance.id]);
  await db.none(`DELETE FROM tbl_approval_instances WHERE id = $1`, [instance.id]);
};

describe("Tender approval hierarchy — process_id is the discriminator", () => {
  it("two distinct TENDER processes route their ARC stage to two distinct committees", async () => {
    const entityA = nextEntityId();
    const entityB = nextEntityId();

    const resA = await createApprovalInstance({
      entity_type: 'ARC',
      entity_id: entityA,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      process_id: TENDER_PROCESS_A,
      initiated_by: IDS.users.a1_proc_buyer,
      metadata: { test: 'process_a' },
    });
    expect(resA.instance.approval_policy_id).toBe(POLICY_A_ARC);

    const resB = await createApprovalInstance({
      entity_type: 'ARC',
      entity_id: entityB,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      process_id: TENDER_PROCESS_B,
      initiated_by: IDS.users.a1_proc_buyer,
      metadata: { test: 'process_b' },
    });
    expect(resB.instance.approval_policy_id).toBe(POLICY_B_ARC);

    // The two policies route to different approvers — confirm the step
    // approver lists are distinct (no cross-contamination).
    const aApprovers = await db.any(
      `SELECT sa.approver_user_id FROM tbl_approval_step_approvers sa
         JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
        WHERE s.approval_instance_id = $1`,
      [resA.instance.id]
    );
    const bApprovers = await db.any(
      `SELECT sa.approver_user_id FROM tbl_approval_step_approvers sa
         JOIN tbl_approval_instance_steps s ON s.id = sa.approval_instance_step_id
        WHERE s.approval_instance_id = $1`,
      [resB.instance.id]
    );
    expect(aApprovers.map((r) => r.approver_user_id)).toEqual([IDS.users.a1_proc_commApp]);
    expect(bApprovers.map((r) => r.approver_user_id)).toEqual([IDS.users.a1_proc_finance]);

    await cleanupInstance(resA.instance);
    await cleanupInstance(resB.instance);
  });

  it("a tender stage with NO policy configured under the chosen process returns TENDER_POLICY_NOT_CONFIGURED", async () => {
    // We use a tender process that has no ARC policy at hotel A3.
    const entityId = nextEntityId();
    let captured;
    try {
      await createApprovalInstance({
        entity_type: 'ARC',
        entity_id: entityId,
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A3,
        process_id: TENDER_PROCESS_A, // no A3 policy under this process
        initiated_by: IDS.users.a1_proc_buyer,
        metadata: {},
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeTruthy();
    expect(captured.code).toBe('TENDER_POLICY_NOT_CONFIGURED');
    expect(captured.message).toMatch(/process .* for this scope/i);
  });

  it("strict process-match guard: a process-agnostic policy at the same scope is REFUSED for tender callers (no silent RFQ-committee fallback)", async () => {
    // Hotel A2 has only POLICY_AGNOSTIC (process_id IS NULL). A tender
    // caller explicitly bound to TENDER_PROCESS_A must NOT pick that
    // up. The engine returns TENDER_POLICY_NOT_CONFIGURED.
    const entityId = nextEntityId();
    let captured;
    try {
      await createApprovalInstance({
        entity_type: 'ARC',
        entity_id: entityId,
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A2,
        process_id: TENDER_PROCESS_A,
        initiated_by: IDS.users.a1_proc_buyer,
        metadata: {},
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeTruthy();
    expect(captured.code).toBe('TENDER_POLICY_NOT_CONFIGURED');
    // The error must distinguish "no policy" from "wrong scope".
    expect(captured.message).toMatch(/process-agnostic|process .* for this scope/i);
  });

  it("Group ARC routes to the single global policy under the parent company — BU scoping is NOT applied", async () => {
    const entityId = nextEntityId();
    const res = await createApprovalInstance({
      entity_type: 'ARC',
      entity_id: entityId,
      // hospitality_company_id deliberately omitted — Group ARC is BU-agnostic.
      tender_scope: 'GROUP',
      company_id: IDS.companies.A,
      initiated_by: IDS.users.a1_proc_buyer,
      metadata: { scope: 'GROUP' },
    });
    expect(res.instance.approval_policy_id).toBe(POLICY_GLOBAL_ARC);

    await cleanupInstance(res.instance);
  });

  it("Group ARC with NO global policy under company → TENDER_POLICY_NOT_CONFIGURED (the engine never falls back to a BU policy)", async () => {
    const entityId = nextEntityId();
    let captured;
    try {
      await createApprovalInstance({
        entity_type: 'ARC',
        entity_id: entityId,
        tender_scope: 'GROUP',
        company_id: IDS.companies.B, // company B has no global ARC policy
        initiated_by: IDS.users.companyB_admin,
        metadata: {},
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeTruthy();
    expect(captured.code).toBe('TENDER_POLICY_NOT_CONFIGURED');
    expect(captured.details?.scope).toBe('GROUP');
  });

  it("the existing entity types are reused — no new types added — process_id is the only discriminator", async () => {
    // Two ARC instances at the same hotel/scope under DIFFERENT processes
    // resolve to DIFFERENT policies. Same entity_type ('ARC') in both
    // cases — no TENDER_ARC, TENDER_TECHNICAL etc.
    const entityIdA = nextEntityId();
    const entityIdB = nextEntityId();

    const resA = await createApprovalInstance({
      entity_type: 'ARC', entity_id: entityIdA,
      hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1,
      process_id: TENDER_PROCESS_A,
      initiated_by: IDS.users.a1_proc_buyer, metadata: {},
    });
    const resB = await createApprovalInstance({
      entity_type: 'ARC', entity_id: entityIdB,
      hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1,
      process_id: TENDER_PROCESS_B,
      initiated_by: IDS.users.a1_proc_buyer, metadata: {},
    });

    expect(resA.instance.entity_type).toBe('ARC');
    expect(resB.instance.entity_type).toBe('ARC');
    expect(resA.instance.approval_policy_id).not.toBe(resB.instance.approval_policy_id);

    await cleanupInstance(resA.instance);
    await cleanupInstance(resB.instance);
  });
});
