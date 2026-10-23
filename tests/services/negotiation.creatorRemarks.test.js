// negotiation.creatorRemarks.test.js - REQ-0026
//
// The person who opens a negotiation round can leave an internal note for the
// approvers (creator_remarks). It is trimmed, capped at 1000 chars, stored
// separately from `remarks` (the reject/withdraw reason), and NEVER returned
// to a vendor.

import { describe, it, expect, afterAll, afterEach, beforeAll, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import negotiationController from "../../app/controllers/negotiation/negotiationController.js";
import { makeRFQ } from "../factories/rfq.js";

const RFQ_CREATOR = IDS.users.a1_proc_buyer;
const NEGOTIATOR = IDS.users.a1_proc_commEval;
const VA = IDS.users.vendor_alpha;
const ROLE_COMM_APPROVER = 12;
const APPROVER = 80951; // own user: the routes run acl([2, 8])

const inserted = { rfqIds: [] };
let vendorPriorType;

beforeAll(async () => {
  // Fixture vendors carry a NULL user_type; the vendor branches key on 3.
  vendorPriorType = (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [VA])).user_type;
  await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [VA]);
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'A2 Remarks Approver', 'negremarks.approver@test.local', 1, 2, $2, now(), now())
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

afterAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [VA, vendorPriorType]);
  // Rejecting a round as the approver leaves rows that point at that user.
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE performed_by = $1`, [APPROVER]);
  await db.none(`DELETE FROM tbl_approval_actions WHERE approver_user_id = $1`, [APPROVER]);
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [APPROVER]);
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [APPROVER]);
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [APPROVER]);
  await closeDb();
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
    bid_end_date: ago(1),
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

// Opens a round as the negotiator through the controller.
async function createRound(rfqId, productId, extra = {}) {
  const m = mockExpress({
    user: { id: NEGOTIATOR },
    body: {
      rfq_id: rfqId,
      rfq_product_id: productId,
      end_date: futureIso(),
      vendor_targets: [{ vendor_id: VA, fields: [{ name: "base_price", target: 10 }] }],
      ...extra,
    },
  });
  await negotiationController.createRound(m.req, m.res);
  return m.calls;
}

async function setup(extra = {}) {
  const rfqId = await makeBidEndedRfq();
  const productId = await addProduct(rfqId, 1);
  const calls = await createRound(rfqId, productId, extra);
  return { rfqId, productId, calls };
}

const roundRow = (rfqId) =>
  db.one(`SELECT * FROM tbl_negotiation_rounds WHERE rfq_id = $1 ORDER BY id DESC LIMIT 1`, [rfqId]);

const hasKeyDeep = (value, key) => {
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key));
  if (value && typeof value === "object") {
    return Object.keys(value).some((k) => k === key || hasKeyDeep(value[k], key));
  }
  return false;
};

describe("creator_remarks on round creation", () => {
  it("stores trimmed creator_remarks on create", async () => {
    const { rfqId, calls } = await setup({ creator_remarks: "  Negotiated at unit level  " });
    expect(calls.status).toBe(200);
    expect((await roundRow(rfqId)).creator_remarks).toBe("Negotiated at unit level");
  });

  it("stores NULL for missing, empty and whitespace-only remarks", async () => {
    for (const extra of [{}, { creator_remarks: "" }, { creator_remarks: "   \n\t " }, { creator_remarks: null }]) {
      const { rfqId, calls } = await setup(extra);
      expect(calls.status).toBe(200);
      expect((await roundRow(rfqId)).creator_remarks).toBeNull();
    }
  });

  it("rejects remarks longer than 1000 characters with 400 and creates no round", async () => {
    const rfqId = await makeBidEndedRfq();
    const productId = await addProduct(rfqId, 1);
    const calls = await createRound(rfqId, productId, { creator_remarks: "a".repeat(1001) });
    expect(calls.status).toBe(400);
    expect(calls.body.message).toBe("Remarks can be at most 1000 characters.");
    const count = await db.one(`SELECT count(*)::int AS n FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfqId]);
    expect(count.n).toBe(0);

    const ok = await createRound(rfqId, productId, { creator_remarks: "a".repeat(1000) });
    expect(ok.status).toBe(200);
    expect((await roundRow(rfqId)).creator_remarks).toHaveLength(1000);
  });

  it("rejects non-string remarks with 400", async () => {
    const rfqId = await makeBidEndedRfq();
    const productId = await addProduct(rfqId, 1);
    const calls = await createRound(rfqId, productId, { creator_remarks: 42 });
    expect(calls.status).toBe(400);
    expect(calls.body.message).toBe("Remarks must be text.");
    const count = await db.one(`SELECT count(*)::int AS n FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfqId]);
    expect(count.n).toBe(0);
  });

  it("carries creator_remarks into the NEGOTIATION approval instance metadata", async () => {
    const { rfqId } = await setup({ creator_remarks: "Please approve today" });
    const round = await roundRow(rfqId);
    const inst = await db.one(
      `SELECT metadata FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id = $1`,
      [round.id]
    );
    expect(inst.metadata.creator_remarks).toBe("Please approve today");

    const { rfqId: rfq2 } = await setup({});
    const inst2 = await db.one(
      `SELECT metadata FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id = $1`,
      [(await roundRow(rfq2)).id]
    );
    expect(inst2.metadata.creator_remarks).toBeNull();
  });

  it("writes the remarks onto the CREATE_ROUND lifecycle row", async () => {
    const { rfqId } = await setup({ creator_remarks: "Context for the audit trail" });
    const row = await db.one(
      `SELECT remarks FROM tbl_lifecycle_history WHERE entity_id = $1 AND action = 'CREATE_ROUND'`,
      [rfqId]
    );
    expect(row.remarks).toBe("Context for the audit trail");
  });
});

describe("creator_remarks is independent of the reject/withdraw reason", () => {
  it("withdraw does not overwrite creator_remarks", async () => {
    const { rfqId } = await setup({ creator_remarks: "original note" });
    const round = await roundRow(rfqId);
    const m = mockExpress({ user: { id: NEGOTIATOR }, params: { id: String(round.id) }, body: { remarks: "changed my mind" } });
    await negotiationController.withdrawRound(m.req, m.res);
    expect(m.calls.status).toBe(200);
    const after = await roundRow(rfqId);
    expect(after.status).toBe("CANCELLED");
    expect(after.remarks).toBe("changed my mind");
    expect(after.creator_remarks).toBe("original note");
  });

  it("reject does not overwrite creator_remarks", async () => {
    const { rfqId } = await setup({ creator_remarks: "original note" });
    const round = await roundRow(rfqId);
    const client = await httpClient(APPROVER);
    const res = await client.post(`/api/v1/negotiation/rounds/${round.id}/reject`).send({ remarks: "too aggressive" });
    expect(res.status).toBe(200);
    const after = await roundRow(rfqId);
    expect(after.remarks).toBe("too aggressive");
    expect(after.creator_remarks).toBe("original note");
  });
});

describe("buyer reads include creator_remarks", () => {
  it("round detail and approval bundle expose it to the approver", async () => {
    const { rfqId } = await setup({ creator_remarks: "Visible to approvers" });
    const round = await roundRow(rfqId);
    const client = await httpClient(APPROVER);

    const detail = await client.get(`/api/v1/negotiation/rounds/${round.id}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.round.creator_remarks).toBe("Visible to approvers");

    const bundle = await client.get(`/api/v1/negotiation/rounds/${rfqId}/approval-bundle`);
    expect(bundle.status).toBe(200);
    const r = bundle.body.data.rounds_history.find((x) => Number(x.id) === Number(round.id));
    expect(r.creator_remarks).toBe("Visible to approvers");
  });
});

describe("vendors never see creator_remarks", () => {
  it("no vendor read exposes creator_remarks", async () => {
    const { rfqId, productId } = await setup({ creator_remarks: "SECRET-INTERNAL-NOTE" });
    const round = await roundRow(rfqId);
    // Make the round live so every vendor read has something to return.
    await db.none(
      `UPDATE tbl_negotiation_rounds SET status = 'ACTIVE', approved_at = NOW(), published_at = NOW() WHERE id = $1`,
      [round.id]
    );
    expect((await roundRow(rfqId)).creator_remarks).toBe("SECRET-INTERNAL-NOTE");

    const vendor = await httpClient(VA);
    const base = `/api/v1/negotiation/rounds/${rfqId}`;
    const reads = {
      getRounds: `${base}`,
      getRoundsForProduct: `${base}?rfq_product_id=${productId}`,
      getActiveRound: `${base}/active?rfq_product_id=${productId}`,
      getActiveRounds: `${base}/active-all`,
      getVendorNegotiationStatus: `${base}/product/${productId}/vendor-status`,
      getAllVendorNegotiationStatus: `${base}/vendor-status`,
    };
    for (const [name, url] of Object.entries(reads)) {
      const res = await vendor.get(url);
      expect([name, res.status]).toEqual([name, 200]);
      // The read must actually have returned the round, otherwise "no leak" is vacuous.
      expect([name, JSON.stringify(res.body).includes(`"id":${round.id}`)]).toEqual([name, true]);
      expect([name, hasKeyDeep(res.body, "creator_remarks")]).toEqual([name, false]);
      expect([name, JSON.stringify(res.body).includes("SECRET-INTERNAL-NOTE")]).toEqual([name, false]);
    }
  });
});
