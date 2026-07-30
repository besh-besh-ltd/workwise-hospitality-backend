// P0 regression suite — pending-approval RFQs were bucketed as "drafts".
// ---------------------------------------------------------------------------
// An RFQ awaiting publish approval is `status = 3, is_published = 0`.
// getRfqListView's STAGE_BUCKET mapped RFQ_APPROVAL -> 'drafts', and bucketOf()
// short-circuited every `is_published === 0` row to 'drafts' as well. The
// listing therefore filed an RFQ that an approver must ACT on next to the
// buyer's own unfinished drafts, rendered only Edit/Delete, and routed the card
// into the edit wizard — where an approver can do nothing.
//
// The row payload also carried `action_holders` but no approval affordances, so
// the client had no way to tell "I am the pending approver" from "someone else
// is", nor which approval instance to act on.
//
// Contract locked in here:
//   - a status-3 RFQ lands in a bucket that is NOT 'drafts'
//   - the row carries can_approve: boolean and approval_instance_id: number|null
//   - a genuine unpublished draft (status 0) still buckets as 'drafts'
//
// Pattern B (commit + cleanup).
//   npm test -- rfq.listView.approvalBucket

import {
  describe, it, expect, afterAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

afterAll(async () => {
  await closeDb();
});

// TENDER_APPROVER (role 4) carries rfq.read, so this user passes the listing's
// permission filter. COMM_APPROVER (role 12) does NOT carry rfq.read.
const APPROVER = IDS.users.a1_proc_finance;
const CREATOR = IDS.users.a1_proc_buyer;

const inserted = { rfqIds: [], instanceIds: [], stepIds: [], approverIds: [] };

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  if (inserted.approverIds.length) {
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE id = ANY($1::int[])`, [inserted.approverIds]);
  }
  if (inserted.instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [inserted.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inserted.instanceIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

async function makeRfqAwaitingApproval({ approverUserId = APPROVER } = {}) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: CREATOR,
    status: 3,          // PENDING_APPROVAL
    is_published: 0,
    is_tender: 0,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);
  await db.none(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0)`,
    [rfq_id]
  );

  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, process_id)
     VALUES ('RFQ', $1, $2, 'PENDING', 1, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      rfq_id, IDS.policies.A1_P1_RFQ, IDS.hospitality.A, IDS.hotels.A1,
      IDS.departments.proc, CREATOR, IDS.processes.A_P1,
    ]
  );
  inserted.instanceIds.push(inst.id);

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`,
    [inst.id]
  );
  inserted.stepIds.push(step.id);

  const appr = await db.one(
    `INSERT INTO tbl_approval_step_approvers
       (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING') RETURNING id`,
    [step.id, approverUserId]
  );
  inserted.approverIds.push(appr.id);

  return { rfq_id, instance_id: inst.id, step_id: step.id };
}

async function listView(userId, body = {}) {
  const client = await httpClient(userId);
  const res = await client.post("/api/v1/rfq/list-view").send({ tab: "all", limit: 100, ...body });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  return res.body.data;
}

const rowFor = (data, rfq_id) =>
  (data.rows || []).find((r) => Number(r.id) === Number(rfq_id));

// ===========================================================================

describe("POST /rfq/list-view — pending-approval RFQs are not drafts", () => {
  it("a status-3 RFQ with a PENDING approval lands in a non-'drafts' bucket for the resolved approver", async () => {
    const { rfq_id, instance_id } = await makeRfqAwaitingApproval();

    const data = await listView(APPROVER);
    const row = rowFor(data, rfq_id);

    expect(row).toBeDefined();
    expect(row.bucket).not.toBe("drafts");
    expect(row.status_key).toBe("RFQ_APPROVAL");
    expect(row.can_approve).toBe(true);
    expect(row.approval_instance_id).toBe(instance_id);
  });

  it("the same row is reachable via its own tab and counted there, not under drafts", async () => {
    const { rfq_id } = await makeRfqAwaitingApproval();

    const all = await listView(APPROVER);
    const bucket = rowFor(all, rfq_id).bucket;

    const scoped = await listView(APPROVER, { tab: bucket });
    expect(rowFor(scoped, rfq_id)).toBeDefined();
    expect(all.tab_counts[bucket]).toBeGreaterThanOrEqual(1);

    const drafts = await listView(APPROVER, { tab: "drafts" });
    expect(rowFor(drafts, rfq_id)).toBeUndefined();
  });

  it("a non-approver in scope sees the row with can_approve false", async () => {
    const { rfq_id, instance_id } = await makeRfqAwaitingApproval();

    const data = await listView(CREATOR);
    const row = rowFor(data, rfq_id);

    expect(row).toBeDefined();
    expect(row.bucket).not.toBe("drafts");
    expect(row.can_approve).toBe(false);
    // The instance id is still emitted so the card can deep-link to the
    // approval on the detail page.
    expect(row.approval_instance_id).toBe(instance_id);
  });

  it("a genuine unpublished draft (status 0) still buckets as 'drafts' with can_approve false", async () => {
    const { rfq_id } = await makeRFQ(db, {
      createdBy: CREATOR,
      status: 0,
      is_published: 0,
      is_tender: 0,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      department: IDS.departments.proc,
      process: IDS.processes.A_P1,
    });
    inserted.rfqIds.push(rfq_id);

    const data = await listView(CREATOR);
    const row = rowFor(data, rfq_id);

    expect(row).toBeDefined();
    expect(row.bucket).toBe("drafts");
    expect(row.can_approve).toBe(false);
    expect(row.approval_instance_id).toBeNull();
  });
});
