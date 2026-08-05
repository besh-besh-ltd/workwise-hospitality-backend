// GET /hospitality/approval/pending/counts — the header-nav badge.
// ---------------------------------------------------------------------------
// This endpoint is a SEPARATE query from the negotiation module's own
// "is this waiting on me" resolvers (getPendingNegotiationRoundIds /
// getPendingNegotiationParentIds). When those two gained a round-deadline
// condition, this one did not — so a round whose vendor window had closed
// would report "nothing needs you" inside the negotiation module while the
// top-nav badge still counted it, for up to the badge's 7-day staleness
// window. Clicking the badge lands on an approve page that renders nothing:
// ApproveRoundPage requires status === 'PENDING_APPROVAL' AND end_date > now.
//
// The rule is now applied in both places. NEGOTIATION_QUOTE approvals are
// product-level awards with no round window and are deliberately NOT gated.
//
// Pattern B (commit + cleanup).
//   TEST_RUN_ID=<unique> npm test -- --testPathPatterns "approval.pendingCountsNegotiationDeadline"

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

const APPROVER = IDS.users.a1_proc_finance;
const COUNTS_URL = "/api/v1/general/hospitality/approval/pending/counts";

const inserted = { rfqIds: [], rfqProductIds: [], roundIds: [], instanceIds: [] };

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  if (inserted.instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
                     (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [inserted.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [inserted.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [inserted.instanceIds]);
  }
  if (inserted.roundIds.length) {
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [inserted.roundIds]);
  }
  if (inserted.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [inserted.rfqProductIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

const ts = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

/**
 * A NEGOTIATION approval waiting on APPROVER, on a round whose window ends at
 * `endOffsetMs` from now. `created_at` is left at NOW() so the badge's own
 * 7-day staleness window never masks the case under test.
 */
async function seedRoundApproval({ endOffsetMs }) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);

  const prod = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, product_variant_id, variant, comment, spec_file, qap_file)
     VALUES ($1, 1, 0, '', '0', '0') RETURNING id`,
    [rfq_id]
  );
  inserted.rfqProductIds.push(Number(prod.id));

  const round = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, rfq_product_id, round_number, status,
        end_date, vendor_ids, created_by, created_at)
     VALUES ($1, 'RFQ', $1, $2, 1, 'PENDING_APPROVAL', $3, $4::int[], $5, now())
     RETURNING id`,
    [rfq_id, Number(prod.id), ts(endOffsetMs), [IDS.users.vendor_alpha], IDS.users.a1_proc_buyer]
  );
  inserted.roundIds.push(Number(round.id));

  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step, initiated_by,
        hospitality_company_id, hotel_id, department_id, metadata, created_at)
     VALUES ('NEGOTIATION', $1, $2, 'PENDING', 1, $3, $4, $5, $6, $7::jsonb, now())
     RETURNING id`,
    [
      Number(round.id), IDS.policies.A1_P1_RFQ, IDS.users.a1_proc_buyer,
      IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc,
      JSON.stringify({ round_id: Number(round.id), rfq_id }),
    ]
  );
  inserted.instanceIds.push(Number(inst.id));

  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`,
    [Number(inst.id)]
  );
  await db.none(
    `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING')`,
    [Number(step.id), APPROVER]
  );
  return { rfq_id, round_id: Number(round.id) };
}

async function negotiationCount() {
  const client = await httpClient(APPROVER);
  const res = await client.get(COUNTS_URL);
  expect(res.status).toBe(200);
  const row = (res.body.data || []).find((r) => r.entity_type === "NEGOTIATION");
  return row ? Number(row.count) : 0;
}

// ===========================================================================

describe("GET /hospitality/approval/pending/counts — negotiation deadline", () => {
  it("does NOT count a round approval whose vendor window has closed", async () => {
    const before = await negotiationCount();
    await seedRoundApproval({ endOffsetMs: -3600_000 });

    // The module reports "nothing needs you" for this round; the badge must
    // agree, or it sends the user to an approve page that renders nothing.
    expect(await negotiationCount()).toBe(before);
  });

  it("still counts a round approval whose window is open", async () => {
    const before = await negotiationCount();
    await seedRoundApproval({ endOffsetMs: 86400_000 });

    expect(await negotiationCount()).toBe(before + 1);
  });
});
