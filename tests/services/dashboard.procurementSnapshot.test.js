// Integration tests for GET /api/v1/dashboard-v2/procurement-snapshot.
//
// Covers the client-requested snapshot changes (CSV Sr 233-237):
//   - active_rfqs   : currently live RFQs (is_published=1 AND status=1)
//   - closed_rfqs   : RFQs in CLOSED state (status=2) within the window
//   - spend_breakup : { base_excl_gst, total_gst, total_incl_gst } where
//                     base_excl_gst = total_incl_gst - total_gst and GST is
//                     derived from tbl_purchase_order_product.charges_meta.
//
// Product-level tests over real HTTP against the local Postgres seed. Because
// the shared seed may already contain rows for the fixture scope, every test
// measures a BASELINE via the endpoint, seeds known rows, then asserts on the
// DELTA — never on absolute totals.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  addProductToRfq,
  makePO,
  cleanupPurchaseOrders,
} from "../helpers/dashboardSeed.js";

afterAll(async () => {
  await closeDb();
});

const ENDPOINT = "/api/v1/dashboard-v2/procurement-snapshot";

// Wide window so seeded rows (created "now") always fall inside it.
const WIDE = { start_date: "2020-01-01", end_date: "2999-01-01" };

const inserted = { rfqIds: [], poIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.poIds = [];
});

afterEach(async () => {
  await cleanupPurchaseOrders(db, inserted.poIds);
  await cleanupRfqs(db, inserted.rfqIds);
});

async function fetchSnapshot() {
  const client = await httpClient(IDS.users.a1_proc_buyer);
  const res = await client
    .get(ENDPOINT)
    .query({ hotel_ids: String(IDS.hotels.A1), ...WIDE });
  expect(res.status).toBe(200);
  expect(res.body?.status).toBe(1);
  return res.body.data;
}

describe("GET /dashboard-v2/procurement-snapshot — RFQ state counts (Sr 234)", () => {
  it("counts a newly published, live RFQ in active_rfqs", async () => {
    const before = await fetchSnapshot();

    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1, // OPEN / live
      title: "Active snapshot RFQ",
    });
    inserted.rfqIds.push(rfq_id);

    const after = await fetchSnapshot();
    expect(after.active_rfqs - before.active_rfqs).toBe(1);
  });

  it("counts a CLOSED RFQ in closed_rfqs, not active_rfqs", async () => {
    const before = await fetchSnapshot();

    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 2, // CLOSED
      title: "Closed snapshot RFQ",
    });
    inserted.rfqIds.push(rfq_id);

    const after = await fetchSnapshot();
    expect(after.closed_rfqs - before.closed_rfqs).toBe(1);
    expect(after.active_rfqs - before.active_rfqs).toBe(0);
  });
});

describe("GET /dashboard-v2/procurement-snapshot — pos_issued excludes draft/cancelled (Item 5 D)", () => {
  it("does not count a draft PO in pos_issued but counts a non-draft PO", async () => {
    const before = await fetchSnapshot();

    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      title: "pos_issued filter RFQ",
    });
    inserted.rfqIds.push(rfq_id);

    const { rfq_product_id } = await addProductToRfq(db, rfq_id);

    // Seed a DRAFT PO — must NOT count in pos_issued.
    const { po_id: draftPoId } = await makePO(db, {
      rfq_id,
      rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      status: "draft",
    });
    inserted.poIds.push(draftPoId);

    const afterDraft = await fetchSnapshot();
    // Draft PO must NOT bump pos_issued.
    expect(afterDraft.pos_issued - before.pos_issued).toBe(0);

    // Seed an APPROVED PO — must count in pos_issued.
    const { rfq_product_id: rfq_product_id2 } = await addProductToRfq(db, rfq_id);
    const { po_id: approvedPoId } = await makePO(db, {
      rfq_id,
      rfq_product_id: rfq_product_id2,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      status: "approved",
    });
    inserted.poIds.push(approvedPoId);

    const afterApproved = await fetchSnapshot();
    expect(afterApproved.pos_issued - before.pos_issued).toBe(1);
  });

  it("does not count a cancelled PO in pos_issued", async () => {
    const before = await fetchSnapshot();

    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      title: "pos_issued cancelled filter RFQ",
    });
    inserted.rfqIds.push(rfq_id);

    const { rfq_product_id } = await addProductToRfq(db, rfq_id);

    // Seed a CANCELLED PO — must NOT count in pos_issued.
    const { po_id: cancelledPoId } = await makePO(db, {
      rfq_id,
      rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      status: "cancelled",
    });
    inserted.poIds.push(cancelledPoId);

    const after = await fetchSnapshot();
    expect(after.pos_issued - before.pos_issued).toBe(0);
  });
});

describe("GET /dashboard-v2/procurement-snapshot — spend breakup (Sr 235)", () => {
  it("splits approved PO spend into base, GST and total (GST from charges_meta)", async () => {
    const before = await fetchSnapshot();

    const { rfq_id } = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      title: "Spend split RFQ",
    });
    inserted.rfqIds.push(rfq_id);

    const { rfq_product_id } = await addProductToRfq(db, rfq_id);

    // unit_price 100 x qty 2 = base 200; 18% GST = 36; total 236.
    const { po_id, pop_id } = await makePO(db, {
      rfq_id,
      rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      status: "approved",
      unit_price: 100,
      quantity: 2,
      total_value: 236,
    });
    inserted.poIds.push(po_id);

    // Attach the GST as a percentage charge so the model derives it.
    await db.none(
      `UPDATE tbl_purchase_order_product
         SET charges_meta = '{"tax":"18","tax_mode":"percentage"}'::jsonb
       WHERE id = $1`,
      [pop_id]
    );

    const after = await fetchSnapshot();
    expect(after.spend_breakup).toBeDefined();
    expect(after.spend_breakup.total_incl_gst - before.spend_breakup.total_incl_gst).toBeCloseTo(236, 1);
    expect(after.spend_breakup.total_gst - before.spend_breakup.total_gst).toBeCloseTo(36, 1);
    expect(after.spend_breakup.base_excl_gst - before.spend_breakup.base_excl_gst).toBeCloseTo(200, 1);
    // base + gst must reconcile to total.
    expect(
      after.spend_breakup.base_excl_gst + after.spend_breakup.total_gst
    ).toBeCloseTo(after.spend_breakup.total_incl_gst, 1);
  });
});
