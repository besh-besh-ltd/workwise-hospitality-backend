// rfqController.getRfqLineage — suite G coverage.
//
// Lineage = back-link (copied_from) + forward-link (copies) for an RFQ.
// The endpoint must filter both sides by the caller's accessible hotels so
// users cannot enumerate copies they wouldn't otherwise be able to see.
//
// Pattern B (commit + cleanup). npm test -- rfq.copy.lineage

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

// Same notification mocks as rfq.copy.test.js — we still create copies as
// part of setup.
jest.unstable_mockModule("../../app/helper/sendEmailFunctions/approvalEmails.js", () => ({
  sendRfqCreationNotification: async () => {},
  sendApprovalStepNotification: async () => {},
  sendRfqReadyToPublishNotification: async () => {},
  sendRfqPublishedNotification: async () => {},
  sendVendorRfqNotification: async () => {},
  sendVendorAutoAddedToRfqNotification: async () => {},
  sendVendorBulkRfqJoinNotification: async () => {},
  sendRfqClosedHeadsUpNotification: async () => {},
  sendApprovalCancelledNotification: async () => {},
  sendPolicyChangeNotification: async () => {},
  sendApproverRemovedNotification: async () => {},
  sendApprovalStandsNotification: async () => {},
  sendApproverAddedMidFlightNotification: async () => {},
}));
jest.unstable_mockModule("../../app/helper/whatsappNotificationAISensy.js", () => ({
  default: { buyerCreatesRFQNotification: () => {} },
}));

const { default: rfqController } = await import("../../app/controllers/rfq/rfqController.js");

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return { req: { user: opts.user, params: opts.params || {}, body: opts.body || {} }, res, calls };
}

const userCtx = (id) => ({ id, name: `user-${id}` });

const inserted = { rfqIds: [] };

beforeEach(() => { inserted.rfqIds = []; });

afterEach(async () => {
  if (inserted.rfqIds.length) {
    const ids = inserted.rfqIds;
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`UPDATE tbl_rfq SET copied_from_rfq_id = NULL WHERE copied_from_rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
  }
});

afterAll(async () => {
  await db.none(
    `DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id IN (
       SELECT id FROM tbl_rfq WHERE rfq_no >= 8000100 AND created_by = ANY($1::int[])
     )`,
    [[IDS.users.a1_proc_buyer, IDS.users.crossCompany, IDS.users.companyB_admin]]
  );
  await db.none(
    `UPDATE tbl_rfq SET copied_from_rfq_id = NULL WHERE copied_from_rfq_id IN (
       SELECT id FROM tbl_rfq WHERE rfq_no >= 8000100 AND created_by = ANY($1::int[])
     )`,
    [[IDS.users.a1_proc_buyer, IDS.users.crossCompany, IDS.users.companyB_admin]]
  );
  await db.none(
    `DELETE FROM tbl_rfq WHERE rfq_no >= 8000100 AND created_by = ANY($1::int[])`,
    [[IDS.users.a1_proc_buyer, IDS.users.crossCompany, IDS.users.companyB_admin]]
  );
  await closeDb();
});

async function trackedMakeRFQ(opts) {
  const row = await makeRFQ(db, opts);
  inserted.rfqIds.push(row.rfq_id);
  return row;
}

async function copyOnce(userId, sourceId, hotelId) {
  const m = mockExpress({
    user: userCtx(userId),
    body: { source_rfq_id: sourceId, target_hotel_id: hotelId },
  });
  await rfqController.copyRfq(m.req, m.res);
  const id = m.calls.body?.data?.new_rfq_id;
  if (id) inserted.rfqIds.push(id);
  return id;
}

async function callLineage(userId, rfqId) {
  const m = mockExpress({ user: userCtx(userId), params: { id: String(rfqId) } });
  await rfqController.getRfqLineage(m.req, m.res);
  return m;
}

describe("G. Lineage", () => {
  it("back-link: GET on a copy returns copied_from populated", async () => {
    const { rfq_id: source, rfq_no: sourceNo } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const copyId = await copyOnce(IDS.users.a1_proc_buyer, source, IDS.hotels.A1);
    expect(copyId).toBeTruthy();

    const m = await callLineage(IDS.users.a1_proc_buyer, copyId);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.data.copied_from).toMatchObject({
      id: source,
      rfq_no: sourceNo,
      hotel_id: IDS.hotels.A1,
    });
    expect(m.calls.body.data.copies).toEqual([]);
  });

  it("forward-link: GET on the source returns all copies", async () => {
    const { rfq_id: source } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const c1 = await copyOnce(IDS.users.a1_proc_buyer, source, IDS.hotels.A1);
    const c2 = await copyOnce(IDS.users.a1_proc_buyer, source, IDS.hotels.A1);
    expect(c1).toBeTruthy();
    expect(c2).toBeTruthy();

    const m = await callLineage(IDS.users.a1_proc_buyer, source);
    expect(m.calls.status).toBe(200);
    const copyIds = m.calls.body.data.copies.map(c => c.id);
    expect(copyIds).toContain(c1);
    expect(copyIds).toContain(c2);
    // Newest first.
    expect(copyIds[0]).toBeGreaterThan(copyIds[1]);
    expect(m.calls.body.data.copied_from).toBeNull();
  });

  it("plain RFQ with no copies and not itself a copy → both null/empty", async () => {
    const { rfq_id } = await trackedMakeRFQ({ createdBy: IDS.users.a1_proc_buyer });
    const m = await callLineage(IDS.users.a1_proc_buyer, rfq_id);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.data.copied_from).toBeNull();
    expect(m.calls.body.data.copies).toEqual([]);
  });

  it("404 on non-existent RFQ", async () => {
    const m = await callLineage(IDS.users.a1_proc_buyer, 9999999);
    expect(m.calls.status).toBe(404);
  });

  it("404 when caller cannot access the RFQ's hotel", async () => {
    const { rfq_id } = await trackedMakeRFQ({
      createdBy: IDS.users.companyB_admin,
      hospitality: IDS.hospitality.B,
      hotel: IDS.hotels.B1,
    });
    const m = await callLineage(IDS.users.a1_proc_buyer, rfq_id);
    expect(m.calls.status).toBe(404);
  });

  it("forward-link filters out copies the caller cannot see (cross-tenant)", async () => {
    // Source on hotel A1 owned by a buyer who can also see B1 (crossCompany).
    const { rfq_id: source } = await trackedMakeRFQ({
      createdBy: IDS.users.crossCompany,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
    });
    // crossCompany copies once to A1 (visible to A-only users) and once to B1.
    const copyA1 = await copyOnce(IDS.users.crossCompany, source, IDS.hotels.A1);
    const copyB1 = await copyOnce(IDS.users.crossCompany, source, IDS.hotels.B1);
    expect(copyA1).toBeTruthy();
    expect(copyB1).toBeTruthy();

    // a1_proc_buyer can only see A1 — B1 copy must be filtered out.
    const m = await callLineage(IDS.users.a1_proc_buyer, source);
    expect(m.calls.status).toBe(200);
    const copyIds = m.calls.body.data.copies.map(c => c.id);
    expect(copyIds).toContain(copyA1);
    expect(copyIds).not.toContain(copyB1);
  });

  it("back-link filters out parent when caller cannot see it (cross-tenant)", async () => {
    // Source on B1, copied to A1 by crossCompany. A1-only user views the copy
    // — they CAN see the copy itself (it's on A1), but they CANNOT see the
    // parent (it's on B1) — so copied_from must come back null.
    const { rfq_id: source } = await trackedMakeRFQ({
      createdBy: IDS.users.crossCompany,
      hospitality: IDS.hospitality.B,
      hotel: IDS.hotels.B1,
    });
    const copyId = await copyOnce(IDS.users.crossCompany, source, IDS.hotels.A1);
    expect(copyId).toBeTruthy();

    const m = await callLineage(IDS.users.a1_proc_buyer, copyId);
    expect(m.calls.status).toBe(200);
    expect(m.calls.body.data.copied_from).toBeNull();
  });

  it("400 on invalid id param", async () => {
    const m = await callLineage(IDS.users.a1_proc_buyer, "not-a-number");
    expect(m.calls.status).toBe(400);
  });
});
