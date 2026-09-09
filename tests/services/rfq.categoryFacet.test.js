// An RFQ's categories must come from its products, not from a coincidence.
//
// CONFIRMED DEFECT, reported on RFQ #536476. The RFQ was raised for the
// product "MIS AND REPORTING" (category IT, sub-category SOFTWARE) and the
// listing displayed it as:
//
//     PACKING MATERIAL, FNB PAPER PLASTIC PKGNG
//
// Four more were checked and every one was wrong in a DIFFERENT way, all for
// the same LAPTOP product (IT / COMPUTERS):
//
//     #536507  GENERAL, FIRST-AID
//     #536506  GENERAL, FIRST-AID
//     #536498  GENERAL, DECORATION & DISPLAY
//     #536453  ENGINEERING, FURNITURE & CARPENTARY
//
// That per-RFQ variation is the tell. `getAllBuyerRfq` built its `categories`
// facet with
//
//     JOIN tbl_product_categories TPC ON TPC.product_id = RP_CAT.id
//
// where RP_CAT is tbl_rfq_products. But `tbl_product_categories.product_id` is
// a tbl_product id, and `RP_CAT.id` is the RFQ LINE ROW's own primary key —
// two unrelated key spaces. So each RFQ was labelled with the categories of
// whichever product happened to share a number with its line row, and since
// that row id differs per RFQ, the same product produced a different wrong
// answer every time. Every other one of the ~50 tbl_product_categories joins
// in this codebase keys on tbl_product.id or tbl_product_variant.product_id;
// these were the only two that did not (the sibling is the vendor-facing
// payload in the same file).
//
// This is not cosmetic. The same value backs the listing's CATEGORY facet, so
// filtering RFQs by category returned rows that had nothing to do with it —
// a laptop RFQ counted under ENGINEERING.
//
// The decoy row below is the defect made deterministic: a tbl_product_categories
// row whose product_id equals the RFQ's line row id. The old query reads it;
// the correct one cannot see it.
//
//   npm test -- rfq.categoryFacet

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

const CREATOR = IDS.users.a1_proc_buyer;
const VARIANT_ID = 1;

const inserted = { rfqIds: [], categoryIds: [], mappingIds: [] };

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  if (inserted.mappingIds.length) {
    await db.none(`DELETE FROM tbl_product_categories WHERE id = ANY($1::int[])`, [inserted.mappingIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  if (inserted.categoryIds.length) {
    await db.none(`DELETE FROM tbl_category WHERE id = ANY($1::int[])`, [inserted.categoryIds]);
  }
});

/** A category with a title nothing else in the fixtures can collide with. */
async function makeCategory(label) {
  const title = `ZZ_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const row = await db.one(
    `INSERT INTO tbl_category (title, slug, parent_id, status, created_by)
     VALUES ($1, $2, 0, 1, $3) RETURNING id, title`,
    [title, title.toLowerCase(), CREATOR]
  );
  inserted.categoryIds.push(row.id);
  return row;
}

async function mapCategory(productId, category) {
  const row = await db.one(
    `INSERT INTO tbl_product_categories (product_id, category_name, category_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [productId, category.title, category.id]
  );
  inserted.mappingIds.push(row.id);
  return row.id;
}

/** Published RFQ carrying one line for VARIANT_ID. Returns the line row id too. */
async function makeRfqWithProduct() {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: CREATOR,
    status: 1,
    is_published: 1,
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);

  const line = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', $2, 0)
     RETURNING id`,
    [rfq_id, VARIANT_ID]
  );

  return { rfq_id, rfq_product_row_id: line.id };
}

async function listView(userId, body = {}) {
  const client = await httpClient(userId);
  const res = await client.post("/api/v1/rfq/list-view").send({ tab: "all", limit: 200, ...body });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  return res.body.data;
}

const titlesFor = (row) =>
  (row?.categories || []).map((c) => c?.title).filter(Boolean);

describe("RFQ listing — categories come from the RFQ's products", () => {
  it("reports the product's own category and ignores a same-numbered decoy", async () => {
    const variant = await db.one(
      `SELECT product_id FROM tbl_product_variant WHERE id = $1`,
      [VARIANT_ID]
    );

    const real = await makeCategory("REAL");
    const decoy = await makeCategory("DECOY");

    const { rfq_id, rfq_product_row_id } = await makeRfqWithProduct();

    // The product this RFQ is actually for.
    await mapCategory(variant.product_id, real);

    // The defect, made deterministic: a mapping for the *product id* that
    // happens to equal this RFQ's line ROW id. Nothing links it to the RFQ —
    // only the broken join could reach it.
    expect(rfq_product_row_id).not.toBe(variant.product_id);
    await mapCategory(rfq_product_row_id, decoy);

    const rows = await listView(CREATOR);
    const mine = rows.find((r) => Number(r.id) === Number(rfq_id));
    expect(mine).toBeTruthy();

    const titles = titlesFor(mine);
    expect(titles).toContain(real.title);
    expect(titles).not.toContain(decoy.title);
  });

  it("returns no categories when the RFQ's product has none", async () => {
    const variant = await db.one(
      `SELECT product_id FROM tbl_product_variant WHERE id = $1`,
      [VARIANT_ID]
    );
    const decoy = await makeCategory("ORPHAN");

    const { rfq_id, rfq_product_row_id } = await makeRfqWithProduct();
    expect(rfq_product_row_id).not.toBe(variant.product_id);

    // Only the decoy exists. A correct query finds nothing to report; the old
    // one would confidently label this RFQ with the decoy's category.
    await mapCategory(rfq_product_row_id, decoy);

    const rows = await listView(CREATOR);
    const mine = rows.find((r) => Number(r.id) === Number(rfq_id));
    expect(mine).toBeTruthy();
    expect(titlesFor(mine)).not.toContain(decoy.title);
  });
});
