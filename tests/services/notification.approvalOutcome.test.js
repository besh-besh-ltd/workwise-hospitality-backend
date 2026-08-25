// Approval outcomes reach the person who raised them.
//
// The defect this guards: rejection was silent for every entity type except the
// ARC family. `submitApprovalAction`'s REJECT branch flipped the instance and
// returned — no mail, no bell — and each entity's rejection handler did its own
// state unwinding just as quietly. So:
//
//   - an RFQ was pushed back to draft and its publish schedule disarmed
//   - a PO was rejected and its vendor de-finalized, cancelling the upstream
//     finalization approval
//   - a material requisition was refused
//   - a negotiation round was cancelled with every vendor flipped to REJECTED
//
// ...and in every case the initiator was told nothing. They found out by
// noticing the state had changed underneath them.
//
// Cancellation had the mirror problem: only closeRFQ notified, so the ARC
// publish-withdrawal, the generic cancel endpoint and the four sendback
// cascades left approvers holding a task that could never be actioned.

import { describe, it, expect, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";

afterAll(async () => {
  await closeDb();
});

const INITIATOR = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_poApp;

const created = { instanceIds: [], stepIds: [], poIds: [], rfqIds: [] };

beforeEach(async () => {
  created.instanceIds = [];
  created.stepIds = [];
  created.poIds = [];
  created.rfqIds = [];
  await db.none(
    `DELETE FROM tbl_notifications
      WHERE COALESCE(recipient_user_id, sender_user_id) = ANY($1::int[])`,
    [[INITIATOR, APPROVER]]
  );
});

afterEach(async () => {
  if (created.instanceIds.length) {
    await db.none(
      `DELETE FROM tbl_notifications WHERE additional_data->>'approval_instance_id' = ANY($1)`,
      [created.instanceIds.map(String)]
    );
  }
  await db.none(
    `DELETE FROM tbl_notifications
      WHERE COALESCE(recipient_user_id, sender_user_id) = ANY($1::int[])`,
    [[INITIATOR, APPROVER]]
  );
  if (created.poIds.length) {
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [created.poIds]);
  }
  if (created.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqIds]);
  }
});

let PO_SEQ = 9_600_000;

/**
 * A real purchase order row.
 *
 * Most tests here get away with a synthetic entity_id because a REJECT only
 * logs "PO not found" and moves on. An APPROVE no longer can: a PO approval now
 * generates its document inside the approval transaction, and a PO that does
 * not exist cannot produce one, so the approval correctly fails. The instance
 * has to point at something real.
 */
async function makeRealPo() {
  const rfqNo = ++PO_SEQ;
  const rfq = await db.one(
    `INSERT INTO tbl_rfq (rfq_no, comment, company_name, response_email, contact_name,
                          contact_number, bid_end_date, location, is_published, status,
                          created_by, updated_by, "timestamp", hospitality_company_id,
                          hotel_id, process_id, is_tender, title)
     VALUES ($1,'','','b@t','b','0', NOW() + INTERVAL '7 days','Mumbai',1,1,$2,$2,NOW(),$3,$4,$5,0,$6)
     RETURNING id`,
    [rfqNo, INITIATOR, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1, `Notif RFQ ${rfqNo}`]
  );
  created.rfqIds.push(rfq.id);

  const product = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1,'','','','','',1,0) RETURNING id`,
    [rfq.id]
  );

  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order (rfq_id, rfq_product_id, po_number, company_id, status,
                                         quantity, unit_price, finalized_vendor_id, total_value, created_at)
     VALUES ($1,ARRAY[$2::int],$3,$4,'pending_approval',5,100,$5,500,NOW()) RETURNING id, po_number`,
    [rfq.id, product.id, `NOTIF-${++PO_SEQ}`, IDS.companies.A, IDS.users.vendor_alpha]
  );
  created.poIds.push(po.id);
  return po;
}

// A minimal PENDING instance with one step and one approver — enough for the
// engine to accept a decision on it.
async function makePendingApproval({ entityType = "PO", entityId = 999001, metadata = {} } = {}) {
  const instance = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, status, initiated_by, metadata,
        approval_policy_id, hospitality_company_id, hotel_id, created_at)
     VALUES ($1, $2, 'PENDING', $3, $4, $5, $6, $7, NOW())
     RETURNING id`,
    [
      entityType,
      entityId,
      INITIATOR,
      JSON.stringify(metadata),
      IDS.policies.A1_P1_PO,
      IDS.hospitality.A,
      IDS.hotels.A1,
    ]
  );
  created.instanceIds.push(instance.id);

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, step_order, decision_rule, status, created_at)
     VALUES ($1, 1, 'ANY', 'PENDING', NOW())
     RETURNING id`,
    [instance.id]
  );
  created.stepIds.push(step.id);

  await db.none(
    `INSERT INTO tbl_approval_step_approvers
       (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING')`,
    [step.id, APPROVER]
  );

  return { instanceId: instance.id, stepId: step.id };
}

const notificationsFor = (userId, type) =>
  db.any(
    `SELECT title, message, action_url, category, additional_data
       FROM tbl_notifications
      WHERE COALESCE(recipient_user_id, sender_user_id) = $1 AND type = $2
      ORDER BY id DESC`,
    [userId, type]
  );

describe("rejection tells the initiator", () => {
  it("notifies the person who raised the PO", async () => {
    const { instanceId, stepId } = await makePendingApproval({
      entityType: "PO",
      entityId: 999001,
      metadata: { po_number: "PO-4471", po_id: 999001, rfq_id: 359 },
    });

    const { executeApprovalAction } = await import(
      "../../app/services/approvalActionService.js"
    );
    await executeApprovalAction({
      approval_instance_id: instanceId,
      approval_instance_step_id: stepId,
      approver_user_id: APPROVER,
      action: "REJECT",
      comment: "Rates exceed the sanctioned budget",
    });

    const rows = await notificationsFor(INITIATOR, "approval_rejected");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("Rejected");
    expect(rows[0].title).toContain("Purchase Order");
    expect(rows[0].title).toContain("PO-4471");
    // The reason is the single most useful thing to carry.
    expect(rows[0].message).toContain("Rates exceed the sanctioned budget");
  });

  it("deep-links to the rejected record rather than a dashboard", async () => {
    const { instanceId, stepId } = await makePendingApproval({
      entityType: "PO",
      entityId: 999002,
      metadata: { po_id: 61, rfq_id: 359 },
    });

    const { executeApprovalAction } = await import(
      "../../app/services/approvalActionService.js"
    );
    await executeApprovalAction({
      approval_instance_id: instanceId,
      approval_instance_step_id: stepId,
      approver_user_id: APPROVER,
      action: "REJECT",
      comment: "no",
    });

    const rows = await notificationsFor(INITIATOR, "approval_rejected");
    expect(rows[0].action_url).toBe("/dashboard/buyer/purchase-orders/61");
    expect(rows[0].action_url).not.toBe("/dashboard");
  });

  it("carries a readable label for a material requisition", async () => {
    const { instanceId, stepId } = await makePendingApproval({
      entityType: "MR",
      entityId: 812,
      metadata: { mr_number: "MR-812", mr_id: 812 },
    });

    const { executeApprovalAction } = await import(
      "../../app/services/approvalActionService.js"
    );
    await executeApprovalAction({
      approval_instance_id: instanceId,
      approval_instance_step_id: stepId,
      approver_user_id: APPROVER,
      action: "REJECT",
      comment: "Stock already available",
    });

    const rows = await notificationsFor(INITIATOR, "approval_rejected");
    expect(rows[0].title).toContain("Material Requisition");
    expect(rows[0].title).not.toContain("MR #");
    expect(rows[0].action_url).toBe("/dashboard/buyer/material-requisitions/812");
  });

  it("does not notify the approver about their own decision", async () => {
    const { instanceId, stepId } = await makePendingApproval({ entityId: 999003 });

    const { executeApprovalAction } = await import(
      "../../app/services/approvalActionService.js"
    );
    await executeApprovalAction({
      approval_instance_id: instanceId,
      approval_instance_step_id: stepId,
      approver_user_id: APPROVER,
      action: "REJECT",
      comment: "no",
    });

    expect(await notificationsFor(APPROVER, "approval_rejected")).toHaveLength(0);
  });
});

describe("approval tells the initiator too", () => {
  it("notifies when the instance clears every step", async () => {
    const po = await makeRealPo();
    const { instanceId, stepId } = await makePendingApproval({
      entityType: "PO",
      entityId: po.id,
      metadata: { po_number: "PO-9", po_id: po.id, rfq_id: 359 },
    });

    const { executeApprovalAction } = await import(
      "../../app/services/approvalActionService.js"
    );
    await executeApprovalAction({
      approval_instance_id: instanceId,
      approval_instance_step_id: stepId,
      approver_user_id: APPROVER,
      action: "APPROVE",
    });

    const rows = await notificationsFor(INITIATOR, "approval_approved");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("Approved");
    expect(rows[0].title).toContain("PO-9");
  });
});

describe("cancellation releases the approvers", () => {
  it("tells pending approvers the task is moot", async () => {
    const { instanceId } = await makePendingApproval({
      entityType: "PO",
      entityId: 999005,
      metadata: { po_number: "PO-77", po_id: 61, rfq_id: 359 },
    });

    const { cancelApprovalInstance } = await import("../../app/models/generalModel.js");
    await cancelApprovalInstance(instanceId, INITIATOR, "RFQ was closed");

    const rows = await notificationsFor(APPROVER, "approval_cancelled");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("No longer needed");
    expect(rows[0].message).toContain("RFQ was closed");
  });

  it("does not notify whoever performed the cancellation", async () => {
    const { instanceId } = await makePendingApproval({ entityId: 999006 });

    const { cancelApprovalInstance } = await import("../../app/models/generalModel.js");
    await cancelApprovalInstance(instanceId, APPROVER, "withdrawn");

    expect(await notificationsFor(APPROVER, "approval_cancelled")).toHaveLength(0);
  });

  it("still reports the cancellation to its caller", async () => {
    const { instanceId } = await makePendingApproval({ entityId: 999007 });

    const { cancelApprovalInstance } = await import("../../app/models/generalModel.js");
    const result = await cancelApprovalInstance(instanceId, INITIATOR, "withdrawn");

    // The notification is additive — the existing contract must not change.
    expect(result.status).toBe("CANCELLED");
    expect(result.message).toBe("Approval instance cancelled");
  });
});
