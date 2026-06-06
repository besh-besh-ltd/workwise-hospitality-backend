// Integration tests for GET /api/v1/vendor-dashboard/status-banner.
//
// Mirrors the buyer-side banner test pattern. Vendor scope is implicit
// (req.user.id) so we just authenticate as a vendor fixture and assert
// the mode escalates as we seed the right state.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  makePO,
  cleanupPurchaseOrders,
} from "../helpers/dashboardSeed.js";

afterAll(async () => {
  await closeDb();
});

const ENDPOINT = "/api/v1/vendor-dashboard/status-banner";

function offsetString(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);
}

const inserted = { rfqIds: [], poIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
  inserted.poIds = [];
});

afterEach(async () => {
  await cleanupPurchaseOrders(db, inserted.poIds);
  if (inserted.rfqIds.length) {
    // Drop product-vendor invite rows + quotes we may have seeded.
    await db.none(
      `DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1)`,
      [inserted.rfqIds]
    );
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1)`, [inserted.rfqIds]);
  }
  await cleanupRfqs(db, inserted.rfqIds);
});

// Helper — seed an RFQ + invite a vendor to it.
async function seedInvitedRfq({ vendor_id, bid_end_date, viewed = false }) {
  const r = await makeRfqVisibleToDashboard(db, {
    createdBy: IDS.users.a1_proc_buyer,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    is_published: 1,
    status: 1,
    bid_end_date,
    title: `Invited RFQ for vendor ${vendor_id}`,
  });
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, is_rfq_viewed)
     VALUES ($1, 1, $2, $3)`,
    [r.rfq_id, vendor_id, viewed ? 1 : 0]
  );
  return r.rfq_id;
}

describe("GET /vendor-dashboard/status-banner — auth", () => {
  it("returns 401 without a JWT", async () => {
    const client = await httpClient(null);
    const res = await client.get(ENDPOINT);
    expect([401, 403]).toContain(res.status);
  });
});

describe("GET /vendor-dashboard/status-banner — mode = clear", () => {
  it("returns clear with zeroed counts when nothing is pending", async () => {
    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(ENDPOINT);

    expect(res.status).toBe(200);
    expect(res.body?.status).toBe(1);
    const d = res.body?.data;
    expect(d).toBeDefined();
    // No invited / closing / negotiation / PO state seeded in this test.
    expect(d.counts.closing_soon).toBe(0);
    expect(d.counts.pending_negotiation).toBe(0);
    expect(d.counts.po_acceptance_pending).toBe(0);
    // Mode could be clear or steady depending on shared seed; both are
    // acceptable when none of the action-needed counts fired.
    expect(["clear", "steady"]).toContain(d.mode);
    expect(d.greeting).toBeDefined();
  });
});

describe("GET /vendor-dashboard/status-banner — mode escalates with state", () => {
  it("steady: vendor was invited to an RFQ they have not viewed (with bid still future)", async () => {
    const rfqId = await seedInvitedRfq({
      vendor_id: IDS.users.vendor_alpha,
      // Future enough that closing_soon doesn't fire (>24h).
      bid_end_date: offsetString(5 * 86400_000),
      viewed: false,
    });
    inserted.rfqIds.push(rfqId);

    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.counts.new_rfqs_unviewed).toBeGreaterThanOrEqual(1);
    // Could be steady or escalated if subscription is also expiring; both valid.
    expect(["steady", "action_needed", "critical"]).toContain(d.mode);
  });

  it("action_needed: an invited RFQ closes within 24h and vendor hasn't quoted", async () => {
    const rfqId = await seedInvitedRfq({
      vendor_id: IDS.users.vendor_alpha,
      bid_end_date: offsetString(12 * 3600_000),
      viewed: true, // simulate they viewed but didn't quote
    });
    inserted.rfqIds.push(rfqId);

    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.counts.closing_soon).toBeGreaterThanOrEqual(1);
    expect(["action_needed", "critical"]).toContain(d.mode);
    expect(d.soonest_closing).toBeTruthy();
    expect(d.soonest_closing.id).toBe(rfqId);
  });

  it("action_needed: a PO is sitting in acceptance_pending for this vendor", async () => {
    // Seed published RFQ + product + PO awaiting acceptance by vendor_alpha.
    const r = await makeRfqVisibleToDashboard(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_published: 1,
      status: 1,
      bid_end_date: offsetString(7 * 86400_000),
      title: "PO awaiting vendor accept",
    });
    inserted.rfqIds.push(r.rfq_id);

    const variantRow = await db.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`);
    const prodRow = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
       VALUES ($1, '', '0', '', '', $2, 1)
       RETURNING id`,
      [r.rfq_id, variantRow.id]
    );
    const { po_id } = await makePO(db, {
      rfq_id: r.rfq_id,
      rfq_product_id: prodRow.id,
      vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A,
      status: "acceptance_pending",
    });
    inserted.poIds.push(po_id);

    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.counts.po_acceptance_pending).toBeGreaterThanOrEqual(1);
    expect(["action_needed", "critical"]).toContain(d.mode);
  });

  it("includes a greeting with the user's first name", async () => {
    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(200);
    expect(res.body.data.greeting).toBeDefined();
    expect(typeof res.body.data.greeting.first_name).toBe("string");
    expect(res.body.data.greeting.first_name.length).toBeGreaterThan(0);
    expect(res.body.data.greeting.first_name).not.toMatch(/\s/);
  });
});

describe("GET /vendor-dashboard/status-banner — scope", () => {
  it("does not expose another vendor's invited RFQ to this vendor", async () => {
    // RFQ where vendor_beta is invited; vendor_alpha must NOT see it.
    const rfqId = await seedInvitedRfq({
      vendor_id: IDS.users.vendor_beta,
      bid_end_date: offsetString(6 * 3600_000),
      viewed: true,
    });
    inserted.rfqIds.push(rfqId);

    const client = await httpClient(IDS.users.vendor_alpha);
    const res = await client.get(ENDPOINT);
    expect(res.status).toBe(200);
    const d = res.body.data;
    // The closing_soon count for vendor_alpha must NOT include vendor_beta's RFQ.
    expect(
      d.soonest_closing == null || d.soonest_closing.id !== rfqId
    ).toBe(true);
  });
});
