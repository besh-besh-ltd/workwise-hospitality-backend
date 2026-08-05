// P1 security regression — GET /rfq/quote-comparison-view/:id leaked across
// business units inside a tenant.
// ---------------------------------------------------------------------------
// quoteCompareViewModel.getQuoteComparisonView() gated on company ONLY, by
// explicit design ("Hotel/department are narrowing filters in the dashboards;
// the single-RFQ view only needs the company-level ownership gate"). In prod
// that admitted 223 RFQs for a user whose RBAC scope covers 47 — every
// out-of-scope RFQ's competitor pricing and vendor names were readable.
//
// The sibling endpoint GET /rfq/quote-comparison/:id already calls
// assertCanReadParentRfq(); this suite locks the same gate onto the view
// endpoint, and keeps the company gate as defence-in-depth.
//
// Pattern B (commit + cleanup).
//   npm test -- rfq.quoteComparisonView.scope

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

const inserted = { rfqIds: [], rfqProductIds: [] };

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  if (inserted.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [inserted.rfqProductIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

const tsString = (offsetMs) =>
  new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);

async function makeRfqAtHotel(hotel) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.multiHotel,
    status: 1,
    is_published: 1,
    is_tender: 0,
    hospitality: IDS.hospitality.A,
    hotel,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
    tender_publish_date: tsString(-2 * 86400_000),
    vendor_clarification_date: tsString(-86400_000),
    bid_end_date: tsString(-3600_000), // past deadline => quotes unlocked
  });
  inserted.rfqIds.push(rfq_id);
  const p = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
    [rfq_id]
  );
  inserted.rfqProductIds.push(p.id);
  return rfq_id;
}

// ===========================================================================

describe("GET /rfq/quote-comparison-view/:id — RBAC scope, not just tenant", () => {
  it("403s a same-company user whose RBAC scope does not cover the RFQ's business unit", async () => {
    // a1_proc_buyer is scoped to hotel A1 only; this RFQ lives at hotel A2.
    // Both users resolve to hospitality company A, so the company-only gate
    // used to let this through.
    const rfq_id = await makeRfqAtHotel(IDS.hotels.A2);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/rfq/quote-comparison-view/${rfq_id}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PROCESS_NOT_IN_USER_SCOPE");
    // No comparison payload leaked.
    expect(res.body.products).toBeUndefined();
  });

  it("200s the legitimately-scoped user for the same RFQ", async () => {
    const rfq_id = await makeRfqAtHotel(IDS.hotels.A2);

    // multiHotel holds TENDER_CREATOR (rfq.read) at both A1 and A2.
    const client = await httpClient(IDS.users.multiHotel);
    const res = await client.get(`/api/v1/rfq/quote-comparison-view/${rfq_id}`);

    expect(res.status).toBe(200);
    expect(res.body.rfq).toBeDefined();
    expect(Number(res.body.rfq.id)).toBe(Number(rfq_id));
  });

  it("still 200s an in-scope user for an RFQ at their own business unit", async () => {
    const rfq_id = await makeRfqAtHotel(IDS.hotels.A1);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/rfq/quote-comparison-view/${rfq_id}`);

    expect(res.status).toBe(200);
    expect(Number(res.body.rfq.id)).toBe(Number(rfq_id));
  });

  it("cross-tenant reads stay blocked (company gate remains as defence-in-depth)", async () => {
    const rfq_id = await makeRfqAtHotel(IDS.hotels.A1);

    const client = await httpClient(IDS.users.companyB_admin);
    const res = await client.get(`/api/v1/rfq/quote-comparison-view/${rfq_id}`);

    expect([403, 404]).toContain(res.status);
    expect(res.body.rfq).toBeUndefined();
  });
});
