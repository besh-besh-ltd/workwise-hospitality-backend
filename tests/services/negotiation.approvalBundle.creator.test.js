// negotiation.approvalBundle.creator.test.js — whose name the negotiation
// approval page prints next to "created by".
//
// GET /api/v1/negotiation/rounds/:rfq_id/approval-bundle is the ONLY read the
// approve screen makes for round metadata
// (components/dashboard/buyer/negotiation/create-round/ApproveRoundPage.js
// renders `round.created_by_name` for every round awaiting the caller).
//
// A client report claimed that field names the RFQ's creator rather than the
// person who opened the negotiation. The two are genuinely different people on
// 737 of 901 production RFQ rounds, so the distinction is load-bearing and
// nothing else in the payload carries it — hence this test pins the contract:
// `created_by_name` resolves tbl_negotiation_rounds.created_by, never
// tbl_rfq.created_by.

import { describe, it, expect, afterAll, afterEach, beforeAll, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import negotiationController from "../../app/controllers/negotiation/negotiationController.js";
import { makeRFQ } from "../factories/rfq.js";

afterAll(async () => {
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [APPROVER]);
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [APPROVER]);
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [APPROVER]);
  await closeDb();
});

beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'A1 Negotiation Approver', 'negbundle.approver@test.local', 1, 2, $2, now(), now())
     ON CONFLICT (id) DO UPDATE SET user_type = 2, status = 1`,
    [APPROVER, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings
       (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
    [APPROVER, IDS.hospitality.A, IDS.hotels.A1, IDS.users.superAdmin]
  );
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
     VALUES ($1, $2, $3, $4, NULL)`,
    [APPROVER, ROLE_COMM_APPROVER, IDS.hospitality.A, IDS.hotels.A1]
  );
});

// The RFQ is raised by one person and the negotiation by another — the exact
// split the report is about.
const RFQ_CREATOR = IDS.users.a1_proc_buyer;
const NEGOTIATOR = IDS.users.a1_proc_commEval;
const VA = IDS.users.vendor_alpha;

// Role 12 = Commercial Approver — the ROLE the NEGOTIATION policy step resolves.
const ROLE_COMM_APPROVER = 12;
// Own user rather than the shared fixture approver: the route runs acl([2, 8])
// and fixture users deliberately carry a NULL user_type.
const APPROVER = 80941;

const inserted = { rfqIds: [] };

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  const roundIds = (
    await db.any(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds])
  ).map((r) => Number(r.id));
  if (roundIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_actions WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[]))`,
      [roundIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT s.id FROM tbl_approval_instance_steps s
         JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
         WHERE i.entity_type='NEGOTIATION' AND i.entity_id = ANY($1::int[]))`,
      [roundIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[]))`,
      [roundIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[])`,
      [roundIds]
    );
    await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [roundIds]);
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [roundIds]);
  }
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  inserted.rfqIds = [];
});

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: { user: opts.user, params: opts.params || {}, body: opts.body || {}, query: {} },
    res,
    next: jest.fn(),
    calls,
  };
}

const ago = (d) => new Date(Date.now() - d * 86400_000).toISOString().replace("T", " ").slice(0, 19);
const futureIso = (offsetMs = 7 * 86400_000) => new Date(Date.now() + offsetMs).toISOString();

async function makeBidEndedRfq() {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: RFQ_CREATOR,
    status: 1,
    is_published: 1,
    tender_publish_date: ago(3),
    vendor_clarification_date: ago(2),
    bid_end_date: ago(1), // bid window CLOSED → negotiation allowed
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(Number(rfq_id));
  return Number(rfq_id);
}

async function addProduct(rfqId, variantId) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '', '', '', $2, 0) RETURNING id`,
    [rfqId, variantId]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfqId, variantId, VA]
  );
  return Number(row.id);
}

describe("negotiation approval bundle — who opened the round", () => {
  it("names the round's creator, not the RFQ's, on the round awaiting approval", async () => {
    const rfqId = await makeBidEndedRfq();
    const productId = await addProduct(rfqId, 1);

    // The negotiator — NOT the RFQ creator — opens the round.
    const create = mockExpress({
      user: { id: NEGOTIATOR },
      body: {
        rfq_id: rfqId,
        rfq_product_id: productId,
        end_date: futureIso(),
        vendor_targets: [{ vendor_id: VA, fields: [{ name: "base_price", target: 10 }] }],
      },
    });
    await negotiationController.createRound(create.req, create.res);
    expect(create.calls.status).toBe(200);

    // The approver opens the approval page.
    const client = await httpClient(APPROVER);
    const res = await client.get(`/api/v1/negotiation/rounds/${rfqId}/approval-bundle`);
    expect(res.status).toBe(200);

    const rounds = res.body?.data?.rounds_history || [];
    expect(rounds).toHaveLength(1);
    const round = rounds[0];

    // This is the row the approve screen renders — it is pending on the caller.
    expect(round.status).toBe("PENDING_APPROVAL");
    const instances = res.body.data.negotiation_instances[String(round.id)] || [];
    expect(instances.some((i) => i.status === "PENDING" && i.can_user_approve)).toBe(true);

    const names = await db.one(
      `SELECT (SELECT name FROM tbl_users WHERE id = $1) AS negotiator,
              (SELECT name FROM tbl_users WHERE id = $2) AS rfq_creator`,
      [NEGOTIATOR, RFQ_CREATOR]
    );
    expect(names.negotiator).not.toBe(names.rfq_creator); // guards the fixture

    expect(round.created_by).toBe(NEGOTIATOR);
    expect(round.created_by_name).toBe(names.negotiator);
    expect(round.created_by_name).not.toBe(names.rfq_creator);
  });
});
