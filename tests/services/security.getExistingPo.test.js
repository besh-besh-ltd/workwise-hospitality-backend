// SECURITY — GET /rfq/get-existing-po: buyer-only and tenant-scoped (ruling R22).
// ----------------------------------------------------------------------------
// The route took rfq_id and vendor_id from the query string and returned that
// vendor's raw draft PO rows (SELECT PO.*) to ANY signed-in caller: another
// tenant's buyer, or a vendor reading a competitor's drafts. No frontend calls
// it, but it was reachable.
//
// Now:
//   - acl([2, 8]): vendors get the ACL's standard 403.
//   - the RFQ is checked with the fail-closed gate GET /po/rfq/:rfq_id uses;
//     out of scope (or no such RFQ) is a 404 that does not reveal existence.
//   - vendor_id only narrows an RFQ the caller can already read.
//   - an in-scope buyer still gets the rows, buyer-only fields included.
//
// Real HTTP, real Postgres. Mail is captured at the SMTP transport.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const fakeTransport = { sendMail: (opts, cb) => cb(null, { messageId: "<captured>" }) };
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { IDS } = await import("../fixtures/ids.js");
const { makePoRejectWorld, W } = await import("../helpers/poRejectWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");

const FOREIGN = IDS.users.companyB_admin; // company-level scope on company B
const world = makePoRejectWorld(db);
let foreignBackup = null;

beforeAll(async () => {
  await world.setup();
  foreignBackup = await db.one(`SELECT user_type, status FROM tbl_users WHERE id = $1`, [FOREIGN]);
  await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [FOREIGN]);
});
afterEach(async () => {
  await drainPoRejectedNotifications();
  await world.cleanup();
});
afterAll(async () => {
  if (foreignBackup) {
    await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`,
      [FOREIGN, foreignBackup.user_type, foreignBackup.status]);
  }
  await world.teardown();
  await closeDb();
});

const query = (rfqId, vendorId) => `/api/v1/rfq/get-existing-po?vendor_id=${vendorId}&rfq_id=${rfqId}`;

/**
 * Company A's RFQ with a re-award draft for vendor B: vendor A's PO was
 * rejected, so B's draft carries replaces_po_id.
 */
async function reawardDraft() {
  const staged = await world.stageRfq({ products: 1, vendors: [W.VENDOR_A, W.VENDOR_B] });
  const product = staged.products[0];
  const first = (await world.award(staged, product, [W.VENDOR_A])).pos[0].id;
  await world.initiate(first);
  expect((await world.rejectOnPoPage(first, { remarks: "late", reason_category: "RENEGOTIATE" })).status).toBe(200);
  const draft = (await world.award(staged, product, [W.VENDOR_B])).pos[0].id;
  return { rfqId: staged.rfq.id, rejectedPoId: first, draftPoId: draft };
}

describe("GET /rfq/get-existing-po", () => {
  it("refuses a vendor, even for its own drafts", async () => {
    const { rfqId } = await reawardDraft();
    const res = await (await world.client(W.VENDOR_B)).get(query(rfqId, W.VENDOR_B));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: "Insufficient permissions" });
  });

  it("answers another tenant's buyer 404, the same as for an RFQ that does not exist", async () => {
    const { rfqId } = await reawardDraft();
    const foreign = await world.client(FOREIGN);

    const res = await foreign.get(query(rfqId, W.VENDOR_B));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      status: 2, message: "Purchase order not found.", code: "PO_NOT_FOUND_OR_OUT_OF_SCOPE",
    });
    expect(res.body.existingPOS).toBeUndefined();

    // Indistinguishable from an RFQ id that does not exist, or none at all.
    const missing = await foreign.get(query(2_000_000_000, W.VENDOR_B));
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(res.body);
    const noRfq = await foreign.get(`/api/v1/rfq/get-existing-po?vendor_id=${W.VENDOR_B}`);
    expect(noRfq.status).toBe(404);
    expect(noRfq.body).toEqual(res.body);
  });

  it("still gives an in-scope buyer the vendor's draft rows, buyer-only fields included", async () => {
    const { rfqId, rejectedPoId, draftPoId } = await reawardDraft();
    const buyer = await world.client(W.CREATOR);

    const res = await buyer.get(query(rfqId, W.VENDOR_B));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.existingPOS.map((p) => p.id)).toEqual([draftPoId]);
    expect(res.body.existingPOS[0]).toMatchObject({
      rfq_id: rfqId, status: "draft", finalized_vendor_id: W.VENDOR_B, replaces_po_id: rejectedPoId,
    });

    // vendor_id only filters: vendor A has no draft on this RFQ any more.
    const other = await buyer.get(query(rfqId, W.VENDOR_A));
    expect(other.status).toBe(200);
    expect(other.body.existingPOS).toEqual([]);
  });
});
