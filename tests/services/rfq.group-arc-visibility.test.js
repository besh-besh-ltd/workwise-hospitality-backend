// Group ARC tender visibility across the lists buyers actually use.
//
// Real-world bug: a Group ARC tender (tender_scope='GROUP', covering
// multiple hotels via tbl_rfq_hotel_mappings) was invisible to the
// CREATOR in the RFQ Management list, because the inner permission
// filter required network-scope boq.read which the creator (a tender
// author, not an evaluator) didn't have. The outer creator-OR was
// AND'd with the permission filter, so even being the creator wasn't
// enough.
//
// What we lock in here, end-to-end through the REAL list queries:
//
//   1. CREATOR: a Group ARC author who holds NO boq.read at any scope
//      sees their own RFQ in the management list and count.
//   2. NETWORK READER: a non-creator who holds ONLY network-scope
//      boq.read sees the Group ARC RFQ in their management list.
//   3. UNRELATED USER: a non-creator with no boq.read at any scope
//      does NOT see the Group ARC RFQ.
//   4. PENDING-APPROVER ON GROUP ARC: a user who is set as an active
//      approver on a Group ARC tender approval instance sees the RFQ
//      in their Pending Approvals list — even when they hold NO
//      boq.read at any scope. Approver status IS the permission.
//
// These cover the core class of bug we shipped to staging unnoticed.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import rbacModel from "../../app/models/rbacModel.js";
import rfqModel from "../../app/models/rfqModel.js";

let savedBoqRolePerms = [];

beforeAll(async () => {
  // Snapshot all boq role-permission bindings and clear them so the
  // test owns the matrix. Restored in afterAll. This isolates the
  // visibility assertions from whatever the seed happens to bind.
  savedBoqRolePerms = await db.any(
    `SELECT rp.role_id, rp.permission_id
       FROM tbl_role_permissions rp
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE p.resource = 'boq'`
  );
  await db.none(
    `DELETE FROM tbl_role_permissions
      WHERE permission_id IN (SELECT id FROM tbl_permissions WHERE resource = 'boq')`
  );
});

afterAll(async () => {
  for (const r of savedBoqRolePerms) {
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [r.role_id, r.permission_id]
    );
  }
  await closeDb();
});

const tracked = { rfqIds: [], scopeIds: [], rolePerms: [], approvalInstanceIds: [], policyIds: [] };
afterEach(async () => {
  // Approval cleanup first (FKs cascade through instance_steps + approvers).
  if (tracked.approvalInstanceIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_step_approvers
        WHERE approval_instance_step_id IN (
          SELECT id FROM tbl_approval_instance_steps
           WHERE approval_instance_id = ANY($1::int[])
        )`,
      [tracked.approvalInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`,
      [tracked.approvalInstanceIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`,
      [tracked.approvalInstanceIds]
    );
    tracked.approvalInstanceIds = [];
  }
  if (tracked.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [tracked.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [tracked.rfqIds]);
    tracked.rfqIds = [];
  }
  if (tracked.scopeIds.length) {
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = ANY($1::int[])`, [tracked.scopeIds]);
    tracked.scopeIds = [];
  }
  if (tracked.rolePerms.length) {
    for (const [rid, pid] of tracked.rolePerms) {
      await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2`, [rid, pid]);
    }
    tracked.rolePerms = [];
  }
  if (tracked.policyIds.length) {
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [tracked.policyIds]);
    tracked.policyIds = [];
  }
});

const grantBoqPermToRole = async (roleId, action) => {
  const perm = await db.one(
    `SELECT id FROM tbl_permissions WHERE resource = 'boq' AND action = $1 LIMIT 1`,
    [action]
  );
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [roleId, perm.id]
  );
  tracked.rolePerms.push([roleId, perm.id]);
};

const grantNetworkRole = async (userId, roleId) => {
  await rbacModel.assignUserRoleScopes([
    { user_id: userId, role_id: roleId, is_network_scope: 1 },
  ]);
  const rows = await db.any(
    `SELECT id FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2 AND is_network_scope = 1`,
    [userId, roleId]
  );
  rows.forEach((r) => tracked.scopeIds.push(r.id));
};

const createGroupArcRfq = async ({ creator, hospCompanyId, hotelIds, departmentId }) => {
  // Build a representative Group-ARC RFQ row directly. The inner-list
  // queries inspect tbl_rfq + tbl_rfq_hotel_mappings only; full create
  // flow is out of scope for this visibility test.
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, response_email, contact_name, contact_number, bid_end_date, location,
        is_published, status, is_tender, tender_scope, hospitality_company_id, hotel_id,
        department_id, created_by, updated_by, timestamp, company_name)
     VALUES (FLOOR(RANDOM() * 1000000000 + 1)::int, 'visibility test', 'visibility@test.local', 'Visibility', '+91-9999999999',
             NOW() + INTERVAL '30 days', 'Test', 1, 4, 1, 'GROUP', $1, $2, $3, $4, $4, NOW(), 'Visibility Test Co')
     RETURNING id`,
    [hospCompanyId, hotelIds[0], departmentId, creator]
  );
  for (const hid of hotelIds) {
    await db.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [rfq.id, hid, creator]
    );
  }
  tracked.rfqIds.push(rfq.id);
  return rfq.id;
};

describe("Group ARC tender visibility — RFQ Management list", () => {
  it("CREATOR sees their own Group ARC RFQ even with NO boq.read at any scope", async () => {
    // Kushal (a1_proc_buyer) creates a Group ARC tender across A1+A2.
    // We deliberately grant him NO boq permissions whatsoever — the
    // creator-OR exemption in the permission filter is what we lock in.
    const rfqId = await createGroupArcRfq({
      creator: IDS.users.a1_proc_buyer,
      hospCompanyId: IDS.hospitality.A,
      hotelIds: [IDS.hotels.A1, IDS.hotels.A2],
      departmentId: IDS.departments.proc,
    });

    const list = await rfqModel.getAllBuyerRfq(
      50, 0, IDS.users.a1_proc_buyer,
      null, "DESC", null, null, null, 1, undefined, []
    );
    const ids = list.map((r) => Number(r.id));
    expect(ids).toContain(rfqId);

    const count = await rfqModel.getBuyerRfqCount(
      IDS.users.a1_proc_buyer, null, null, null, null, 1, undefined, []
    );
    expect(Number(count)).toBeGreaterThanOrEqual(1);
  });

  it("NETWORK READER (only network-scope boq.read) sees Group ARC RFQs they didn't create", async () => {
    // Group ARC created by a1_proc_buyer.
    const rfqId = await createGroupArcRfq({
      creator: IDS.users.a1_proc_buyer,
      hospCompanyId: IDS.hospitality.A,
      hotelIds: [IDS.hotels.A1, IDS.hotels.A2],
      departmentId: IDS.departments.proc,
    });

    // Different user — gets boq.read via network-scope role.
    await grantBoqPermToRole(ROLE_IDS.COMM_APPROVER, "read");
    await grantNetworkRole(IDS.users.companyA_admin, ROLE_IDS.COMM_APPROVER);

    const list = await rfqModel.getAllBuyerRfq(
      50, 0, IDS.users.companyA_admin,
      null, "DESC", null, null, null, 1, undefined, []
    );
    expect(list.map((r) => Number(r.id))).toContain(rfqId);
  });

  it("UNRELATED USER with NO boq.read does NOT see the Group ARC RFQ", async () => {
    const rfqId = await createGroupArcRfq({
      creator: IDS.users.a1_proc_buyer,
      hospCompanyId: IDS.hospitality.A,
      hotelIds: [IDS.hotels.A1, IDS.hotels.A2],
      departmentId: IDS.departments.proc,
    });

    // companyB_admin: has CEO at company B, no perms in A, no
    // network-scope boq.read.
    const list = await rfqModel.getAllBuyerRfq(
      50, 0, IDS.users.companyB_admin,
      null, "DESC", null, null, null, 1, undefined, []
    );
    expect(list.map((r) => Number(r.id))).not.toContain(rfqId);
  });
});

describe("Group ARC tender visibility — Pending Approvals list", () => {
  it("an active approver on a Group ARC pending instance sees the RFQ in pending approvals — even with NO boq.read", async () => {
    // Group ARC RFQ.
    const rfqId = await createGroupArcRfq({
      creator: IDS.users.a1_proc_buyer,
      hospCompanyId: IDS.hospitality.A,
      hotelIds: [IDS.hotels.A1, IDS.hotels.A2],
      departmentId: IDS.departments.proc,
    });

    // Pending TENDER approval instance with companyA_admin as the only
    // active approver. We DON'T grant them boq.read at any scope —
    // their approver status alone must let them see the RFQ in
    // pending approvals. We need a placeholder policy_id (NOT NULL FK)
    // so we create a minimal one inline.
    const policy = await db.one(
      `INSERT INTO tbl_approval_policies
         (entity_type, hospitality_company_id, hotel_id, department_id,
          created_by, is_active, is_master, is_global, company_id)
       VALUES ('TENDER', $1, NULL, NULL, $2, true, false, 1, $3)
       RETURNING id`,
      [null, IDS.users.a1_proc_buyer, IDS.companies.A]
    );
    tracked.policyIds.push(policy.id);

    const instance = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step, initiated_by,
          hospitality_company_id, hotel_id, department_id, process_id, metadata, created_at)
       VALUES ('TENDER', $1, $4, 'PENDING', 1, $2, $3, NULL, NULL, NULL, '{}'::jsonb, NOW())
       RETURNING id`,
      [rfqId, IDS.users.a1_proc_buyer, IDS.hospitality.A, policy.id]
    );
    tracked.approvalInstanceIds.push(instance.id);

    const step = await db.one(
      `INSERT INTO tbl_approval_instance_steps
         (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`,
      [instance.id]
    );
    await db.none(
      `INSERT INTO tbl_approval_step_approvers
         (approval_instance_step_id, approver_user_id, status)
       VALUES ($1, $2, 'PENDING')`,
      [step.id, IDS.users.companyA_admin]
    );

    const list = await rfqModel.getPendingApprovalRfqs(
      50, 0, IDS.users.companyA_admin,
      null, "DESC", null, null, 1
    );
    expect(list.map((r) => Number(r.id))).toContain(rfqId);

    const count = await rfqModel.getPendingApprovalRfqCount(
      IDS.users.companyA_admin, null, null, null, null, 1
    );
    expect(Number(count)).toBeGreaterThanOrEqual(1);
  });

  it("a user who is NOT an approver does NOT see the Group ARC RFQ in pending approvals — even if they hold network-scope boq.read", async () => {
    // Confirms the outer EXISTS approver-status gate is still enforced
    // — we only relaxed the redundant inner permission filter. A
    // network-scope boq.read holder who isn't an approver doesn't
    // accidentally show up in someone else's pending-approvals list.
    const rfqId = await createGroupArcRfq({
      creator: IDS.users.a1_proc_buyer,
      hospCompanyId: IDS.hospitality.A,
      hotelIds: [IDS.hotels.A1, IDS.hotels.A2],
      departmentId: IDS.departments.proc,
    });

    await grantBoqPermToRole(ROLE_IDS.COMM_APPROVER, "read");
    await grantNetworkRole(IDS.users.companyA_admin, ROLE_IDS.COMM_APPROVER);

    const list = await rfqModel.getPendingApprovalRfqs(
      50, 0, IDS.users.companyA_admin,
      null, "DESC", null, null, 1
    );
    expect(list.map((r) => Number(r.id))).not.toContain(rfqId);
  });
});
