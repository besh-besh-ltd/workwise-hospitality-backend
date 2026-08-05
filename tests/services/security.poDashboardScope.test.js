// SECURITY — PO dashboard cross-hotel scope (P1, ₹2.8 crore exposure in prod).
// ----------------------------------------------------------------------------
// poDashboardModel.buildScopeClause() took hotel/department ONLY from the
// optional `x-hotel-ids` / `x-department-id` request headers, and emitted the
// hotel predicate only `if (scope.hotelIds && scope.hotelIds.length > 0)`.
// Omit the header → the hotel filter vanished and the query fell back to
// "every PO in every company the user is mapped to". There was no process
// axis at all.
//
// Verified in production for user 168 (RBAC scope = company 5 / hotel 6 only):
// GET /po/list returned 163 POs across 15 business units / ₹4,86,12,564 where
// the correct scoped answer is 45 POs / 1 unit / ₹2,06,56,843.
//
// The fix replaces the header-derived predicate with the canonical 4-axis
// EXISTS clause from authorizationService.buildScopeExistsClause(), and keeps
// the headers only as a NARROWING filter intersected with the scoped set.
//
// Fixture users used here:
//   a1_proc_buyer  — role scope (company A, hotel A1, dept proc)
//   multiHotel     — role scope (company A, hotel A1) + (company A, hotel A2)
//   companyA_admin — role scope (company A, hotel NULL = all hotels)

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

afterAll(async () => {
  await closeDb();
});

let VARIANT_ID = 1;
beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT_ID = v.id;
});

const inserted = { rfqIds: [], poIds: [], poProductIds: [], rfqProductIds: [], quoteIds: [] };

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  if (inserted.poProductIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE id = ANY($1::int[])`, [inserted.poProductIds]);
  }
  if (inserted.poIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type='PO' AND entity_id = ANY($1::int[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [inserted.poIds]);
  }
  if (inserted.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [inserted.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [inserted.quoteIds]);
  }
  if (inserted.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [inserted.rfqProductIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

let PO_NO = 7_000_000;
const nextPoNo = () => `SCOPE-PO-${++PO_NO}`;

// Build an RFQ + product + vendor + quote at an explicit (company, hotel, dept,
// process) scope, then a PO hanging off it. Returns { rfq_id, po_id }.
async function makeScopedPo({
  hotel,
  department = IDS.departments.proc,
  process = IDS.processes.A_P1,
  hospitality = IDS.hospitality.A,
  totalValue = 1000,
  status = "approved",
}) {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    bid_end_date: oneDayAgo,
    hospitality,
    hotel,
    department,
    process,
  });
  inserted.rfqIds.push(rfq_id);

  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, 'Spec text', '', '', '', '', $2, 0)
     RETURNING id`,
    [rfq_id, VARIANT_ID]
  );
  inserted.rfqProductIds.push(product.id);

  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, VARIANT_ID, IDS.users.vendor_alpha]
  );

  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, IDS.users.vendor_alpha]
  );
  inserted.quoteIds.push(quote.id);

  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, 100, $6, $7, $8, $9, NOW(), NOW())
     RETURNING id`,
    [rfq_id, IDS.companies.A, nextPoNo(), status, [product.id], IDS.users.vendor_alpha,
     totalValue, [quote.id], IDS.users.a1_proc_buyer]
  );
  inserted.poIds.push(po.id);

  const pop = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
     VALUES ($1, $2, $3, 1, 'NOS', 100, $4) RETURNING id`,
    [po.id, product.id, quote.id, totalValue]
  );
  inserted.poProductIds.push(pop.id);

  return { rfq_id, po_id: po.id, po_number: null };
}

const idsOf = (res) => (res.body?.data || []).map((r) => r.id);

// ---------------------------------------------------------------------------
describe("SECURITY: GET /po/list is hotel-scoped WITHOUT any x-hotel-ids header", () => {
  it("a hotel-A1 buyer sees A1 POs and NOT A2 POs when no header is sent", async () => {
    const a1 = await makeScopedPo({ hotel: IDS.hotels.A1 });
    const a2 = await makeScopedPo({ hotel: IDS.hotels.A2 });

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get("/api/v1/po/list?limit=100");

    expect(res.status).toBe(200);
    const ids = idsOf(res);
    expect(ids).toContain(a1.po_id);
    expect(ids).not.toContain(a2.po_id);
  });

  it("sending x-hotel-ids for an out-of-scope hotel does NOT widen the set", async () => {
    const a1 = await makeScopedPo({ hotel: IDS.hotels.A1 });
    const a2 = await makeScopedPo({ hotel: IDS.hotels.A2 });

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client
      .get("/api/v1/po/list?limit=100")
      .set("x-hotel-ids", String(IDS.hotels.A2));

    expect(res.status).toBe(200);
    const ids = idsOf(res);
    expect(ids).not.toContain(a2.po_id);
    // Header acts as a NARROWING filter intersected with the scoped set: A2 is
    // outside the user's scope, so the intersection is empty for both rows.
    expect(ids).not.toContain(a1.po_id);
  });

  it("x-hotel-ids still narrows WITHIN the user's own scope (multi-hotel user)", async () => {
    const a1 = await makeScopedPo({ hotel: IDS.hotels.A1 });
    const a2 = await makeScopedPo({ hotel: IDS.hotels.A2 });

    const client = await httpClient(IDS.users.multiHotel);

    const both = await client.get("/api/v1/po/list?limit=100");
    expect(idsOf(both)).toEqual(expect.arrayContaining([a1.po_id, a2.po_id]));

    const narrowed = await client
      .get("/api/v1/po/list?limit=100")
      .set("x-hotel-ids", String(IDS.hotels.A1));
    const nIds = idsOf(narrowed);
    expect(nIds).toContain(a1.po_id);
    expect(nIds).not.toContain(a2.po_id);
  });

  it("a company-wide (hotel_id NULL) scope still sees every hotel in the company", async () => {
    const a1 = await makeScopedPo({ hotel: IDS.hotels.A1 });
    const a2 = await makeScopedPo({ hotel: IDS.hotels.A2 });

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.get("/api/v1/po/list?limit=100");

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual(expect.arrayContaining([a1.po_id, a2.po_id]));
  });

  it("a company-B user never sees company-A POs", async () => {
    const a1 = await makeScopedPo({ hotel: IDS.hotels.A1 });

    const client = await httpClient(IDS.users.companyB_admin);
    const res = await client.get("/api/v1/po/list?limit=100");

    expect(idsOf(res)).not.toContain(a1.po_id);
  });
});

// ---------------------------------------------------------------------------
describe("SECURITY: the scope fix covers every dashboard endpoint, not just /po/list", () => {
  it("KPI + analytics + status_counts totals agree with the scoped row set", async () => {
    await makeScopedPo({ hotel: IDS.hotels.A1, totalValue: 500 });
    const a2 = await makeScopedPo({ hotel: IDS.hotels.A2, totalValue: 999999 });

    const client = await httpClient(IDS.users.a1_proc_buyer);

    const list = await client.get("/api/v1/po/list?limit=100");
    const scopedIds = idsOf(list);
    expect(scopedIds).not.toContain(a2.po_id);

    // status_counts.all must equal the number of rows the scope really yields.
    const counts = list.body.status_counts || {};
    expect(counts.all).toBe(list.body.total_items);

    const kpis = await client.get("/api/v1/po/dashboard/kpis");
    expect(kpis.status).toBe(200);

    const analytics = await client.get("/api/v1/po/analytics?period=ytd");
    expect(analytics.status).toBe(200);
    // The out-of-scope ₹999,999 PO must not show up in the spend total.
    const spend = Number(analytics.body?.data?.kpis?.totalSpend ?? analytics.body?.kpis?.totalSpend ?? 0);
    expect(spend).toBeLessThan(999999);
  });

  it("/po/tracking excludes out-of-scope hotels", async () => {
    const a1 = await makeScopedPo({ hotel: IDS.hotels.A1, status: "approved" });
    const a2 = await makeScopedPo({ hotel: IDS.hotels.A2, status: "approved" });

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get("/api/v1/po/tracking?limit=100");

    expect(res.status).toBe(200);
    const ids = (res.body?.data || []).map((r) => r.id);
    expect(ids).toContain(a1.po_id);
    expect(ids).not.toContain(a2.po_id);
  });

  it("/po/awaiting and /po/detail/:po_id refuse an out-of-scope PO", async () => {
    const a2 = await makeScopedPo({ hotel: IDS.hotels.A2 });

    const client = await httpClient(IDS.users.a1_proc_buyer);

    const awaiting = await client.get("/api/v1/po/awaiting");
    expect(awaiting.status).toBe(200);
    expect((awaiting.body?.data || []).map((r) => r.id)).not.toContain(a2.po_id);

    const detail = await client.get(`/api/v1/po/detail/${a2.po_id}`);
    expect([400, 403, 404]).toContain(detail.status);
  });

  it("/po/detail/:po_id still returns an in-scope PO", async () => {
    const a1 = await makeScopedPo({ hotel: IDS.hotels.A1 });

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await client.get(`/api/v1/po/detail/${a1.po_id}`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("SECURITY: the process axis is enforced (previously absent entirely)", () => {
  it("a process-bound user does not see POs from another process", async () => {
    // Bind the engineering buyer's scope to process A_P1 only, then publish a
    // PO under A_P2 at the same hotel.
    await db.none(
      `UPDATE tbl_user_role_scopes SET process_id = $1
        WHERE user_id = $2 AND company_id = $3`,
      [IDS.processes.A_P1, IDS.users.a1_eng_buyer, IDS.hospitality.A]
    );
    try {
      const p1 = await makeScopedPo({
        hotel: IDS.hotels.A1, department: IDS.departments.eng, process: IDS.processes.A_P1,
      });
      const p2 = await makeScopedPo({
        hotel: IDS.hotels.A1, department: IDS.departments.eng, process: IDS.processes.A_P2,
      });

      const client = await httpClient(IDS.users.a1_eng_buyer);
      const res = await client.get("/api/v1/po/list?limit=100");

      const ids = idsOf(res);
      expect(ids).toContain(p1.po_id);
      expect(ids).not.toContain(p2.po_id);
    } finally {
      await db.none(
        `UPDATE tbl_user_role_scopes SET process_id = NULL
          WHERE user_id = $1 AND company_id = $2`,
        [IDS.users.a1_eng_buyer, IDS.hospitality.A]
      );
    }
  });
});
