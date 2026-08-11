// PO Vendor/Date filters + Excel exports.
// ----------------------------------------------------------------------------
// The four PO surfaces (buyer dashboard, buyer tracking, buyer analytics, vendor
// order book) shipped with an Export button and Vendor/Date filter buttons that
// rendered but were wired to nothing. This suite covers the endpoints that make
// them real:
//
//   GET  /po/list?vendor_id=&date_from=&date_to=   (+ the `vendors` facet)
//   GET  /po/export
//   GET  /po/tracking?vendor_id=&date_from=&date_to=
//   GET  /po/tracking/export
//   GET  /po/analytics/export
//   POST /po/vendor/export
//
// Product-level: real Express app + Postgres over HTTP. The export assertions
// deliberately PARSE THE RETURNED WORKBOOK rather than trusting a 200 — the
// thing the user complained about is a file, so the file is what gets asserted.
//
// Tenant strategy mirrors po.dashboard.test.js: no hospitality headers are sent,
// so scope resolves the same way it does for that suite; a1_proc_buyer is in
// scope for company-A POs and companyB_admin never is.

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import excelJS from "exceljs";
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
  // The vendor-export tests authenticate as vendor users; acl([3]) needs them
  // to actually be user_type 3 (po.vendor.module.test.js does the same).
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`,
    [[IDS.users.vendor_alpha, IDS.users.vendor_beta]]);
});

// ---- Row tracking -----------------------------------------------------------
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

// ---- Setup helpers ----------------------------------------------------------
let PO_NO = 7_100_000;
const nextPoNo = () => `XPRT-PO-${++PO_NO}`;

async function makeRfqWithProductAndVendor({ vendorId = IDS.users.vendor_alpha } = {}) {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    bid_end_date: oneDayAgo,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
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
    [rfq_id, VARIANT_ID, vendorId]
  );

  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, vendorId]
  );
  inserted.quoteIds.push(quote.id);

  return { rfq_id, rfq_product_id: product.id, quote_id: quote.id };
}

async function makePo({
  rfq_id, vendorId = IDS.users.vendor_alpha, status = "acceptance_pending",
  rfq_product_ids = [], quote_ids = [], companyId = IDS.companies.A,
  totalValue = 1234.5, createdAtSql = "NOW()",
}) {
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, 100, $6, $7, $8, $9, ${createdAtSql}, NOW())
     RETURNING id, po_number`,
    [rfq_id, companyId, nextPoNo(), status, rfq_product_ids, vendorId, totalValue, quote_ids, IDS.users.a1_proc_buyer]
  );
  inserted.poIds.push(po.id);
  return po;
}

async function attachProductToPo(po_id, rfq_product_id, quote_id) {
  const r = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
     VALUES ($1, $2, $3, 2, 'NOS', 50, 100) RETURNING id`,
    [po_id, rfq_product_id, quote_id]
  );
  inserted.poProductIds.push(r.id);
  return r.id;
}

// A PO of each flavour, ready to be filtered. Returns both handles.
async function seedTwoVendorPos() {
  const a = await makeRfqWithProductAndVendor({ vendorId: IDS.users.vendor_alpha });
  const alphaPo = await makePo({
    rfq_id: a.rfq_id, vendorId: IDS.users.vendor_alpha, status: "approved",
    rfq_product_ids: [a.rfq_product_id], quote_ids: [a.quote_id], totalValue: 1000,
  });
  await attachProductToPo(alphaPo.id, a.rfq_product_id, a.quote_id);

  const b = await makeRfqWithProductAndVendor({ vendorId: IDS.users.vendor_beta });
  const betaPo = await makePo({
    rfq_id: b.rfq_id, vendorId: IDS.users.vendor_beta, status: "approved",
    rfq_product_ids: [b.rfq_product_id], quote_ids: [b.quote_id], totalValue: 2000,
  });
  await attachProductToPo(betaPo.id, b.rfq_product_id, b.quote_id);

  return { alphaPo, betaPo };
}

// ---- Workbook helpers -------------------------------------------------------
// Supertest parses by content-type; an .xlsx has none it knows, so buffer the
// raw bytes ourselves and hand them to ExcelJS.
const binary = (req) =>
  req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "binary")));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

async function loadWorkbook(buf) {
  const wb = new excelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

/** Every cell value on a sheet, flattened to strings — for "contains" assertions. */
function sheetText(ws) {
  const out = [];
  ws.eachRow((row) => row.eachCell((cell) => out.push(String(cell.value ?? ""))));
  return out;
}

/** Header row labels, in order. */
function headers(ws) {
  return ws.getRow(1).values.slice(1).map((v) => String(v));
}

// ===========================================================================
// 1) Vendor filter
// ===========================================================================
describe("GET /po/list — Vendor filter", () => {
  it("?vendor_id= returns only that vendor's POs, and the `vendors` facet lists both", async () => {
    const { alphaPo, betaPo } = await seedTwoVendorPos();
    const client = await httpClient(IDS.users.a1_proc_buyer);

    const unfiltered = await client.get("/api/v1/po/list?limit=100");
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body.data.map((p) => p.id)).toEqual(expect.arrayContaining([alphaPo.id, betaPo.id]));

    // The dropdown's options come from the response, and must be scoped too.
    expect(Array.isArray(unfiltered.body.vendors)).toBe(true);
    const facetIds = unfiltered.body.vendors.map((v) => v.id);
    expect(facetIds).toEqual(expect.arrayContaining([IDS.users.vendor_alpha, IDS.users.vendor_beta]));
    for (const v of unfiltered.body.vendors) {
      expect(typeof v.label).toBe("string");
      expect(typeof v.count).toBe("number");
    }

    const filtered = await client.get(`/api/v1/po/list?limit=100&vendor_id=${IDS.users.vendor_beta}`);
    expect(filtered.status).toBe(200);
    const ids = filtered.body.data.map((p) => p.id);
    expect(ids).toContain(betaPo.id);
    expect(ids).not.toContain(alphaPo.id);
    // Nothing from any other vendor slipped through.
    for (const p of filtered.body.data) expect(p.vendor.id).toBe(IDS.users.vendor_beta);
  });

  it("a malformed vendor_id is ignored rather than 400-ing the dashboard, while a valid one still filters", async () => {
    const { alphaPo, betaPo } = await seedTwoVendorPos();
    const client = await httpClient(IDS.users.a1_proc_buyer);

    const junk = await client.get("/api/v1/po/list?limit=100&vendor_id=not-a-number");
    expect(junk.status).toBe(200);
    expect(junk.body.data.map((p) => p.id)).toEqual(expect.arrayContaining([alphaPo.id, betaPo.id]));

    // The pairing is the point: "ignored" must mean the parser rejected THIS
    // value, not that vendor_id is ignored across the board.
    const valid = await client.get(`/api/v1/po/list?limit=100&vendor_id=${IDS.users.vendor_alpha}`);
    expect(valid.body.data.map((p) => p.id)).not.toContain(betaPo.id);
  });
});

// ===========================================================================
// 2) Date filter
// ===========================================================================
describe("GET /po/list — Date filter", () => {
  it("date_from/date_to window the list by creation date, both ends inclusive", async () => {
    const recent = await makeRfqWithProductAndVendor();
    const recentPo = await makePo({
      rfq_id: recent.rfq_id, status: "approved",
      rfq_product_ids: [recent.rfq_product_id], quote_ids: [recent.quote_id],
    });
    await attachProductToPo(recentPo.id, recent.rfq_product_id, recent.quote_id);

    const old = await makeRfqWithProductAndVendor();
    const oldPo = await makePo({
      rfq_id: old.rfq_id, status: "approved",
      rfq_product_ids: [old.rfq_product_id], quote_ids: [old.quote_id],
      createdAtSql: "NOW() - INTERVAL '400 days'",
    });
    await attachProductToPo(oldPo.id, old.rfq_product_id, old.quote_id);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

    const windowed = await client.get(`/api/v1/po/list?limit=100&date_from=${monthAgo}&date_to=${today}`);
    expect(windowed.status).toBe(200);
    const ids = windowed.body.data.map((p) => p.id);
    // Inclusive upper bound: a PO created MINUTES ago on `today` must be in,
    // which a naive "created_at <= date_to" would drop.
    expect(ids).toContain(recentPo.id);
    expect(ids).not.toContain(oldPo.id);

    // Widening the window brings the old PO back — proves it was excluded by
    // the filter, not by scope or by an unrelated accident.
    const wide = await client.get(`/api/v1/po/list?limit=100&date_from=2000-01-01&date_to=${today}`);
    expect(wide.body.data.map((p) => p.id)).toEqual(expect.arrayContaining([recentPo.id, oldPo.id]));
  });
});

// ===========================================================================
// 3) Buyer list export
// ===========================================================================
describe("GET /po/export", () => {
  it("returns a readable .xlsx whose rows are exactly the POs the caller can see", async () => {
    const { alphaPo, betaPo } = await seedTwoVendorPos();
    const client = await httpClient(IDS.users.a1_proc_buyer);

    const res = await binary(client.get("/api/v1/po/export"));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="purchase-orders_\d{4}-\d{2}-\d{2}\.xlsx"/);

    const wb = await loadWorkbook(res.body);
    const ws = wb.getWorksheet("Purchase orders");
    expect(ws).toBeDefined();

    // Clean, well-formed headers — not a raw column dump.
    expect(headers(ws)).toEqual([
      "PO #", "Status", "Pending with", "RFQ #", "RFQ title", "Vendor", "Items",
      "Item count", "Quantity", "Value (₹)", "Initiated by", "Created (IST)",
    ]);
    // Sensible widths (Excel's 8.43 default renders vendor names as ####).
    expect(ws.getColumn(6).width).toBeGreaterThan(20);
    // Frozen header + autofilter, so a long export is usable on open.
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.autoFilter).toBeDefined();

    const text = sheetText(ws);
    expect(text).toContain(alphaPo.po_number);
    expect(text).toContain(betaPo.po_number);

    // Money is a NUMBER with a currency format, not the string "₹1,000" — the
    // whole point of the export is that it sums and sorts.
    const row = ws.getRows(2, ws.rowCount).find((r) => r.getCell(1).value === alphaPo.po_number);
    expect(typeof row.getCell(10).value).toBe("number");
    expect(row.getCell(10).value).toBeCloseTo(1000, 2);
    expect(ws.getColumn(10).numFmt).toBe("#,##0.00");
    // Dates are real dates, not text.
    expect(row.getCell(12).value instanceof Date).toBe(true);

    // Provenance sheet so a forwarded file is self-describing.
    const info = wb.getWorksheet("Report info");
    expect(info).toBeDefined();
    expect(sheetText(info).join("|")).toContain("Purchase orders");
  });

  it("honours the active filters — a vendor-filtered export omits the other vendor", async () => {
    const { alphaPo, betaPo } = await seedTwoVendorPos();
    const client = await httpClient(IDS.users.a1_proc_buyer);

    const res = await binary(client.get(`/api/v1/po/export?vendor_id=${IDS.users.vendor_beta}`));
    expect(res.status).toBe(200);
    const wb = await loadWorkbook(res.body);
    const text = sheetText(wb.getWorksheet("Purchase orders"));
    expect(text).toContain(betaPo.po_number);
    expect(text).not.toContain(alphaPo.po_number);
  });

  it("honours the status tab — ?status=rejected omits an approved PO", async () => {
    const { alphaPo } = await seedTwoVendorPos();
    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await binary(client.get("/api/v1/po/export?status=rejected"));
    expect(res.status).toBe(200);
    const wb = await loadWorkbook(res.body);
    expect(sheetText(wb.getWorksheet("Purchase orders"))).not.toContain(alphaPo.po_number);
  });
});

// ===========================================================================
// 4) SECURITY — the export can never widen what a caller can see
// ===========================================================================
describe("SECURITY: /po/export is scoped from req.user", () => {
  it("a company-B buyer's export contains no company-A PO, while the A buyer's does", async () => {
    const a = await makeRfqWithProductAndVendor();
    const aPo = await makePo({
      rfq_id: a.rfq_id, status: "approved",
      rfq_product_ids: [a.rfq_product_id], quote_ids: [a.quote_id],
      companyId: IDS.companies.A,
    });
    await attachProductToPo(aPo.id, a.rfq_product_id, a.quote_id);

    const bClient = await httpClient(IDS.users.companyB_admin);
    const bRes = await binary(bClient.get("/api/v1/po/export"));
    expect(bRes.status).toBe(200);
    const bWb = await loadWorkbook(bRes.body);
    expect(sheetText(bWb.getWorksheet("Purchase orders"))).not.toContain(aPo.po_number);

    // Sanity: the PO really exists and IS exportable by the tenant that owns it.
    const aClient = await httpClient(IDS.users.a1_proc_buyer);
    const aRes = await binary(aClient.get("/api/v1/po/export"));
    expect(sheetText((await loadWorkbook(aRes.body)).getWorksheet("Purchase orders"))).toContain(aPo.po_number);
  });

  it("company scope is NOT taken from the request — a forged company id changes nothing", async () => {
    const a = await makeRfqWithProductAndVendor();
    const aPo = await makePo({
      rfq_id: a.rfq_id, status: "approved",
      rfq_product_ids: [a.rfq_product_id], quote_ids: [a.quote_id],
      companyId: IDS.companies.A,
    });
    await attachProductToPo(aPo.id, a.rfq_product_id, a.quote_id);

    const bClient = await httpClient(IDS.users.companyB_admin);
    // Every shape a client could plausibly use to assert somebody else's tenant.
    const forged = await binary(
      bClient
        .get(`/api/v1/po/export?company_id=${IDS.companies.A}&hospitality_company_id=${IDS.hospitality.A}`)
        .set("x-company-id", String(IDS.companies.A))
    );
    expect(forged.status).toBe(200);
    expect(sheetText((await loadWorkbook(forged.body)).getWorksheet("Purchase orders")))
      .not.toContain(aPo.po_number);
  });

  it("a vendor (user_type 3) is refused the buyer exports", async () => {
    const vendorClient = await httpClient(IDS.users.vendor_alpha);
    for (const path of ["/api/v1/po/export", "/api/v1/po/tracking/export", "/api/v1/po/analytics/export"]) {
      const res = await vendorClient.get(path);
      expect(res.status).toBe(403);
    }
  });
});

// ===========================================================================
// 5) Tracking — filters + export
// ===========================================================================
describe("GET /po/tracking — Vendor/Date filters and export", () => {
  it("?vendor_id= narrows the tracking table and exposes the same `vendors` facet", async () => {
    const { alphaPo, betaPo } = await seedTwoVendorPos();
    const client = await httpClient(IDS.users.a1_proc_buyer);

    const all = await client.get("/api/v1/po/tracking?tab=all&limit=100");
    expect(all.status).toBe(200);
    expect(all.body.data.map((p) => p.id)).toEqual(expect.arrayContaining([alphaPo.id, betaPo.id]));
    expect(Array.isArray(all.body.vendors)).toBe(true);

    const filtered = await client.get(`/api/v1/po/tracking?tab=all&limit=100&vendor_id=${IDS.users.vendor_alpha}`);
    expect(filtered.status).toBe(200);
    const ids = filtered.body.data.map((p) => p.id);
    expect(ids).toContain(alphaPo.id);
    expect(ids).not.toContain(betaPo.id);
    // tab_counts must reflect the filtered set, not the unfiltered one — a
    // count that ignores the filter is the bug the user sees as "it did nothing".
    expect(filtered.body.tab_counts.all).toBeLessThan(all.body.tab_counts.all);
  });

  it("GET /po/tracking/export returns a tracking workbook honouring the vendor filter", async () => {
    const { alphaPo, betaPo } = await seedTwoVendorPos();
    const client = await httpClient(IDS.users.a1_proc_buyer);

    const res = await binary(client.get(`/api/v1/po/tracking/export?tab=all&vendor_id=${IDS.users.vendor_alpha}`));
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("po-tracking_");

    const ws = (await loadWorkbook(res.body)).getWorksheet("PO tracking");
    expect(headers(ws)).toContain("Current stage");
    expect(headers(ws)).toContain("Value (₹)");
    const text = sheetText(ws);
    expect(text).toContain(alphaPo.po_number);
    expect(text).not.toContain(betaPo.po_number);
  });
});

// ===========================================================================
// 6) Analytics export
// ===========================================================================
describe("GET /po/analytics/export", () => {
  it("returns one sheet per chart with real numbers", async () => {
    const { alphaPo } = await seedTwoVendorPos();
    expect(alphaPo.id).toBeGreaterThan(0);

    const client = await httpClient(IDS.users.a1_proc_buyer);
    const res = await binary(client.get("/api/v1/po/analytics/export?period=this-month"));
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("po-analytics_");

    const wb = await loadWorkbook(res.body);
    for (const name of ["KPIs", "Spend trend", "Status mix", "Top vendors", "Approval queue", "Report info"]) {
      expect(wb.getWorksheet(name)).toBeDefined();
    }
    // The KPI sheet's value column is numeric, so it can be charted downstream.
    expect(wb.getWorksheet("KPIs").getColumn(2).numFmt).toBe("#,##0.00");
  });
});

// ===========================================================================
// 7) Vendor order book export
// ===========================================================================
describe("POST /po/vendor/export", () => {
  it("a vendor exports their own orders and never another vendor's", async () => {
    const { alphaPo, betaPo } = await seedTwoVendorPos();

    const alphaClient = await httpClient(IDS.users.vendor_alpha);
    const res = await binary(alphaClient.post("/api/v1/po/vendor/export").send({ tab: "all" }));
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("my-purchase-orders_");

    const ws = (await loadWorkbook(res.body)).getWorksheet("My orders");
    expect(headers(ws)).toEqual([
      "PO #", "Status", "Order type", "Buyer", "Hotel", "Value (₹)", "Created (IST)",
    ]);
    const text = sheetText(ws);
    expect(text).toContain(alphaPo.po_number);
    // THE scope assertion: beta's order is invisible to alpha.
    expect(text).not.toContain(betaPo.po_number);

    // And symmetric — beta sees theirs, not alpha's.
    const betaClient = await httpClient(IDS.users.vendor_beta);
    const betaRes = await binary(betaClient.post("/api/v1/po/vendor/export").send({ tab: "all" }));
    const betaText = sheetText((await loadWorkbook(betaRes.body)).getWorksheet("My orders"));
    expect(betaText).toContain(betaPo.po_number);
    expect(betaText).not.toContain(alphaPo.po_number);
  });

  it("honours the tab filter the page is showing", async () => {
    const { alphaPo } = await seedTwoVendorPos(); // seeded 'approved' == in fulfilment
    const alphaClient = await httpClient(IDS.users.vendor_alpha);

    const rejected = await binary(alphaClient.post("/api/v1/po/vendor/export").send({ tab: "rejected" }));
    expect(sheetText((await loadWorkbook(rejected.body)).getWorksheet("My orders")))
      .not.toContain(alphaPo.po_number);

    const fulfilment = await binary(alphaClient.post("/api/v1/po/vendor/export").send({ tab: "fulfilment" }));
    expect(sheetText((await loadWorkbook(fulfilment.body)).getWorksheet("My orders")))
      .toContain(alphaPo.po_number);
  });

  it("a buyer (non-vendor) is refused the vendor export", async () => {
    const buyerClient = await httpClient(IDS.users.a1_proc_buyer);
    const res = await buyerClient.post("/api/v1/po/vendor/export").send({ tab: "all" });
    expect(res.status).toBe(403);
  });
});
