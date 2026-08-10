/**
 * Approver resolution and entity visibility must agree.
 *
 * ── THE INCIDENT (production, 2026-08-10, RFQ 791 / rfq_no 536332) ─────────
 * KUS404 submitted an RFQ. The approval instance resolved EMP003 as the step-1
 * approver and the RFQ detail page said so. EMP003 could not find the RFQ
 * anywhere — not in the RFQ list, not in "pending my approval". EMP005, the
 * step-2 approver, could see it fine.
 *
 * Neither user was misconfigured in any way an admin could have spotted. The
 * two subsystems simply ask different questions:
 *
 *   resolveApprovers (USER-source)  "does this user hold ANY tbl_user_role_scopes
 *                                    row covering company/hotel/dept/process?"
 *   the read predicate              "does this user hold such a row that ALSO
 *                                    carries rfq.read?"
 *
 * Nothing requires those to be the SAME row. EMP003 matched the first question
 * through 'Commercial Approver' (department-unrestricted, no rfq.read) and
 * failed the second because their only rfq.read came from 'CEO', which is
 * granted per-department and not for that RFQ's department. EMP005 happened to
 * hold 'RFQ Observer' with an unrestricted department, so for them one row
 * answered both.
 *
 * That is luck, not design, and it is invisible from every admin screen.
 *
 * ── WHY IT DEADLOCKS RATHER THAN MERELY ANNOYS ────────────────────────────
 * getPendingApprovalRfqs ANDs approver-hood with the read predicate, so the one
 * surface built to show "things waiting on you" returns EMPTY for the person
 * the workflow is waiting on. Measured across production: 6 such approver
 * slots, every single one at step 1.
 *
 * ── WHY THE FIX WIDENS READ RATHER THAN NARROWING RESOLUTION ──────────────
 * Making resolution stricter would stop resolving these users — turning
 * invisible work into a step that resolves to nobody, which stalls forever.
 * And the system already treats the approver snapshot as the authorization:
 * submitApprovalAction re-checks no role, no permission and no scope. If being
 * named already lets you APPROVE, it must let you SEE.
 *
 * These tests assert observable behaviour through the real model/controller
 * functions, never the SQL text.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

const { default: rfqModel } = await import("../../app/models/rfqModel.js");
const { createApprovalInstance, ENTITY_APPROVE_RESOURCE_MAP } = await import(
  "../../app/models/generalModel.js"
);

afterAll(async () => { await closeDb(); });

// ---------------------------------------------------------------------------
// Fixture: a user shaped exactly like EMP003 — resolvable as an approver, but
// holding no read permission that covers the RFQ's department.
// ---------------------------------------------------------------------------
const BLIND = 80091;          // "resolved but cannot read"
const SIGHTED = 80092;        // holds an unrestricted rfq.read, like EMP005
const OUTSIDER = 80093;       // no approval assignment, no covering read

const created = { rfqIds: [], instanceIds: [] };

async function permId(resource, action) {
  const r = await db.oneOrNone(
    `SELECT id FROM tbl_permissions WHERE resource::text=$1 AND action::text=$2 LIMIT 1`,
    [resource, action]
  );
  return r?.id ?? null;
}

/** A role carrying exactly the given resource.action pairs. */
async function makeRole(title, pairs) {
  const role = await db.one(
    `INSERT INTO tbl_roles (title, description, created_by) VALUES ($1, $1, NULL) RETURNING id`,
    [title]
  );
  for (const [res, act] of pairs) {
    const pid = await permId(res, act);
    if (pid) {
      await db.none(
        `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1,$2)`,
        [role.id, pid]
      );
    }
  }
  return role.id;
}

let roleNoRead, roleReadDeptBound, roleReadUnrestricted, roleBoqApprover;

beforeAll(async () => {
  // Mirrors production 'Commercial Approver': real scope coverage, no rfq.read.
  roleNoRead = await makeRole("T_NoRfqRead", [["negotiation", "read"], ["negotiation", "approve"]]);
  // Mirrors production 'CEO': rfq.read, but granted per-department.
  roleReadDeptBound = await makeRole("T_ReadDeptBound", [["rfq", "read"], ["rfq", "approve"]]);
  // Mirrors production 'RFQ Observer': rfq.read with no department restriction.
  roleReadUnrestricted = await makeRole("T_ReadAll", [["rfq", "read"]]);
  // For the TENDER map test: holds boq read+approve (what tenders actually need).
  roleBoqApprover = await makeRole("T_BoqApprover", [["boq", "read"], ["boq", "approve"]]);

  for (const uid of [BLIND, SIGHTED, OUTSIDER]) {
    await db.none(
      `INSERT INTO tbl_users (id, name, email, user_type, status, company_id)
       VALUES ($1, 'T'||$1, 't'||$1||'@test.local', 2, 1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [uid, IDS.companies?.A ?? 90001]
    );
    await db.none(
      `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
       VALUES ($1, $2, NULL, 0)`,
      [uid, IDS.hospitality.A]
    );
  }

  // BLIND: scope coverage everywhere (no read) + read bound to a DIFFERENT dept.
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
     VALUES ($1,$2,$3,NULL,NULL,NULL)`,
    [BLIND, roleNoRead, IDS.hospitality.A]
  );
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
     VALUES ($1,$2,$3,NULL,$4,NULL)`,
    [BLIND, roleReadDeptBound, IDS.hospitality.A, IDS.departments.eng]
  );
  // SIGHTED: unrestricted read — the lucky shape.
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
     VALUES ($1,$2,$3,NULL,NULL,NULL)`,
    [SIGHTED, roleReadUnrestricted, IDS.hospitality.A]
  );
  // OUTSIDER: read bound to a different dept only, and never an approver.
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
     VALUES ($1,$2,$3,NULL,$4,NULL)`,
    [OUTSIDER, roleReadDeptBound, IDS.hospitality.A, IDS.departments.eng]
  );
});

afterEach(async () => {
  if (created.instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
                   (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
                  [created.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [created.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [created.instanceIds]);
    created.instanceIds = [];
  }
  if (created.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqIds]);
    created.rfqIds = [];
  }
});

/** A submitted RFQ in the PROCUREMENT department (the one BLIND cannot read). */
async function makeSubmittedRfq() {
  const iso = (ms) => new Date(Date.now() + ms).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 3, is_published: 0,
    tender_publish_date: iso(86400_000),
    vendor_clarification_date: iso(5 * 86400_000),
    bid_end_date: iso(7 * 86400_000),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
  });
  await db.none(`UPDATE tbl_rfq SET department_id = $2 WHERE id = $1`, [rfq_id, IDS.departments.proc]);
  created.rfqIds.push(rfq_id);
  return rfq_id;
}

/** Assign `userId` as a live PENDING approver on `rfqId`, as the engine would. */
async function assignApprover(rfqId, userId, { stepOrder = 1, current = 1 } = {}) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step, initiated_by,
        hospitality_company_id, hotel_id, department_id, process_id)
     VALUES ('RFQ',$1,$2,'PENDING',$3,$4,$5,$6,$7,$8) RETURNING id`,
    [rfqId, IDS.policies.A1_P1_RFQ, current, IDS.users.a1_proc_buyer,
     IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P1]
  );
  created.instanceIds.push(inst.id);
  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, status, decision_rule)
     VALUES ($1,$2,'PENDING','ANY') RETURNING id`,
    [inst.id, stepOrder]
  );
  await db.none(
    `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
     VALUES ($1,$2,'PENDING')`,
    [step.id, userId]
  );
  return inst.id;
}

const idsOf = (rows) => (rows || []).map(r => Number(r.id ?? r.rfq_id));

// ===========================================================================
//  Group 1 — the incident
// ===========================================================================

describe("an approver can see the RFQ they must approve", () => {
  it("shows it in the buyer RFQ list even though no scope row grants read for its department", async () => {
    const rfqId = await makeSubmittedRfq();
    await assignApprover(rfqId, BLIND);

    const rows = await rfqModel.getAllBuyerRfq(200, 0, BLIND, null, null, null, null, null, null, null, null);
    expect(idsOf(rows)).toContain(rfqId);
  });

  it("shows it in 'pending my approval' — the surface that returned empty in production", async () => {
    const rfqId = await makeSubmittedRfq();
    await assignApprover(rfqId, BLIND);

    const rows = await rfqModel.getPendingApprovalRfqs(200, 0, BLIND, null, null, null, null, null, null, null);
    expect(idsOf(rows)).toContain(rfqId);
  });

  it("counts it, so the badge and the list agree", async () => {
    const rfqId = await makeSubmittedRfq();
    await assignApprover(rfqId, BLIND);

    const count = await rfqModel.getPendingApprovalRfqCount(BLIND, null, null, null, null, null, null);
    expect(Number(count?.count ?? count ?? 0)).toBeGreaterThan(0);
  });

  it("still shows it to a later-step approver before their turn", async () => {
    // EMP005's real situation: step 2 while step 1 is current. They could see it
    // by luck of scope; now it is by design.
    const rfqId = await makeSubmittedRfq();
    await assignApprover(rfqId, BLIND, { stepOrder: 2, current: 1 });

    const rows = await rfqModel.getAllBuyerRfq(200, 0, BLIND, null, null, null, null, null, null, null, null);
    expect(idsOf(rows)).toContain(rfqId);
  });
});

// ===========================================================================
//  Group 2 — the exemption is narrow
// ===========================================================================

describe("the exemption grants nothing beyond the entity it is for", () => {
  it("does not reveal an RFQ to a user who is not an approver on it", async () => {
    const rfqId = await makeSubmittedRfq();
    await assignApprover(rfqId, BLIND);

    const rows = await rfqModel.getAllBuyerRfq(200, 0, OUTSIDER, null, null, null, null, null, null, null, null);
    expect(idsOf(rows)).not.toContain(rfqId);
  });

  it("does not reveal OTHER RFQs to someone who approves one of them", async () => {
    const mine = await makeSubmittedRfq();
    const other = await makeSubmittedRfq();
    await assignApprover(mine, BLIND);

    const rows = await rfqModel.getAllBuyerRfq(200, 0, BLIND, null, null, null, null, null, null, null, null);
    expect(idsOf(rows)).toContain(mine);
    expect(idsOf(rows)).not.toContain(other);
  });

  it("evaporates once the approval instance completes", async () => {
    const rfqId = await makeSubmittedRfq();
    const instId = await assignApprover(rfqId, BLIND);

    await db.none(`UPDATE tbl_approval_instances SET status='APPROVED' WHERE id=$1`, [instId]);

    const rows = await rfqModel.getAllBuyerRfq(200, 0, BLIND, null, null, null, null, null, null, null, null);
    expect(idsOf(rows)).not.toContain(rfqId);
  });

  it("evaporates when the approver row is removed mid-flight", async () => {
    const rfqId = await makeSubmittedRfq();
    const instId = await assignApprover(rfqId, BLIND);

    await db.none(
      `UPDATE tbl_approval_step_approvers SET removed_at = NOW()
        WHERE approval_instance_step_id IN
              (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id=$1)`,
      [instId]
    );

    const rows = await rfqModel.getAllBuyerRfq(200, 0, BLIND, null, null, null, null, null, null, null, null);
    expect(idsOf(rows)).not.toContain(rfqId);
  });

  it("leaves a user who already had read exactly as visible as before", async () => {
    const rfqId = await makeSubmittedRfq();
    // SIGHTED is not an approver — visibility must come purely from their scope.
    const rows = await rfqModel.getAllBuyerRfq(200, 0, SIGHTED, null, null, null, null, null, null, null, null);
    expect(idsOf(rows)).toContain(rfqId);
  });
});

// ===========================================================================
//  Group 3 — the resource map holes that silently dropped approval steps
// ===========================================================================

describe("every approval entity type resolves to a satisfiable permission resource", () => {
  it("maps TENDER to a resource that has a read action at all", async () => {
    // 'tender' carries ONLY `approve` — there is no tender.read row and never
    // has been — so roleHasReadAndApprovePermission could not be satisfied by
    // any role, and every ROLE step of every TENDER policy was dropped.
    const resource = ENTITY_APPROVE_RESOURCE_MAP['TENDER'];
    const readRow = await permId(resource, 'read');
    const approveRow = await permId(resource, 'approve');
    expect({ resource, hasRead: !!readRow, hasApprove: !!approveRow })
      .toEqual({ resource, hasRead: true, hasApprove: true });
  });

  it("maps TENDER to the same resource the tender UI reads on", async () => {
    // The read predicate keys on `CASE WHEN is_tender = 1 THEN 'boq' ELSE 'rfq'`.
    // If the approval gate names a different resource, "resolved as approver"
    // and "can see it" can never be made to agree for tenders.
    expect(ENTITY_APPROVE_RESOURCE_MAP['TENDER']).toBe('boq');
  });

  it("maps ARC_AMENDMENT, which used to fall through to a non-existent resource", async () => {
    const resource = ENTITY_APPROVE_RESOURCE_MAP['ARC_AMENDMENT'];
    expect(resource).toBeDefined();
    expect(await permId(resource, 'read')).toBeTruthy();
    expect(await permId(resource, 'approve')).toBeTruthy();
  });

  it("every mapped resource can actually satisfy the read+approve gate", async () => {
    const broken = [];
    for (const [entityType, resource] of Object.entries(ENTITY_APPROVE_RESOURCE_MAP)) {
      const r = await permId(resource, 'read');
      const a = await permId(resource, 'approve');
      if (!r || !a) broken.push({ entityType, resource, read: !!r, approve: !!a });
    }
    expect(broken).toEqual([]);
  });
});

// ===========================================================================
//  Group 4 — a policy nobody can approve must never auto-approve
// ===========================================================================

describe("createApprovalInstance refuses a policy that resolves to nobody", () => {
  it("throws instead of creating an instance born APPROVED", async () => {
    const rfqId = await makeSubmittedRfq();

    // A policy whose only step is a ROLE holding nothing on 'rfq'. Before this
    // change the step was dropped and the instance was inserted APPROVED with
    // current_step = 0 — the entity proceeded as approved with nobody asked.
    const pol = await db.one(
      `INSERT INTO tbl_approval_policies
         (entity_type, hospitality_company_id, hotel_id, department_id, process_id,
          is_active, is_master, created_by)
       VALUES ('RFQ',$1,NULL,NULL,NULL,true,true,$2) RETURNING id`,
      [IDS.hospitality.A, IDS.users.a1_proc_buyer]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, approval_type, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1,1,'STANDARD','ANY','ROLE',$2)`,
      [pol.id, roleNoRead]
    );

    await expect(
      createApprovalInstance({
        entity_type: 'RFQ', entity_id: rfqId, approval_policy_id: pol.id,
        hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc, process_id: IDS.processes.A_P1,
        initiated_by: IDS.users.a1_proc_buyer,
      })
    ).rejects.toThrow(/resolved to zero usable approval steps/i);

    const orphan = await db.oneOrNone(
      `SELECT id, status FROM tbl_approval_instances WHERE entity_type='RFQ' AND entity_id=$1`,
      [rfqId]
    );
    expect(orphan).toBeNull();

    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`, [pol.id]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id=$1`, [pol.id]);
  });

  it("refuses an entity_type that has no resource mapping at all", async () => {
    // generalController.submitApproval takes entity_type straight from the
    // request body with no whitelist, so an arbitrary string used to mint a
    // self-approving instance.
    const rfqId = await makeSubmittedRfq();
    await expect(
      createApprovalInstance({
        entity_type: 'TOTALLY_MADE_UP', entity_id: rfqId,
        hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1,
        department_id: IDS.departments.proc, process_id: IDS.processes.A_P1,
        initiated_by: IDS.users.a1_proc_buyer,
      })
    ).rejects.toThrow(/ENTITY_APPROVE_RESOURCE_MAP|no entry in/i);
  });

  it("still builds a normal instance when at least one step resolves", async () => {
    // The guard must not fire on healthy policies — this is the regression that
    // matters most, because failing closed on a working policy blocks creation.
    const rfqId = await makeSubmittedRfq();
    const res = await createApprovalInstance({
      entity_type: 'RFQ', entity_id: rfqId,
      hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1,
      department_id: IDS.departments.proc, process_id: IDS.processes.A_P1,
      initiated_by: IDS.users.a1_proc_buyer,
    });
    if (res?.instance?.id) created.instanceIds.push(res.instance.id);
    expect(res?.instance?.id).toBeTruthy();
    expect(res?.totalSteps ?? 0).toBeGreaterThan(0);
  });
});
