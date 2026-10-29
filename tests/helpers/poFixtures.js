// Shared purchase-order fixtures.
//
// makeRfqWithProductAndVendor / makeFinalization / makePo / attachProductToPo
// are copied from tests/services/po.acceptReject.test.js, which still keeps
// its own copies for now (an unmerged sibling branch edits that file; it can
// switch to this helper once that lands).
//
// The originals closed over a module-level `inserted` tracker. Here the
// tracker is injected, so a suite does:
//
//   const inserted = newPoFixtureTracker();
//   const { makeRfqWithProductAndVendor, makePo, ... } = poFixtures(inserted);
//   afterEach(() => cleanupPoFixtures(inserted));
//
// and every call site keeps the original signature.

import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

export function newPoFixtureTracker() {
  return {
    rfqIds: [],
    poIds: [],
    poProductIds: [],
    finalizationIds: [],
    finalizationHistoryIds: [],
    rfqProductIds: [],
    quoteIds: [],
  };
}

// po_number is not UNIQUE-constrained; a distinct range from the
// acceptReject suite just keeps failures easy to attribute.
let PO_NO = 6_000_000;
const nextPoNo = () => `TEST-PO-${++PO_NO}`;

export function poFixtures(inserted) {
  async function makeRfqWithProductAndVendor({ vendorId = IDS.users.vendor_alpha, productVariantId = 1 } = {}) {
    const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      status: 1,
      is_published: 1,
      bid_end_date: oneDayAgo,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      process: IDS.processes.A_P1,
    });
    inserted.rfqIds.push(rfq_id);
    const product = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0)
       RETURNING id`,
      [rfq_id, productVariantId]
    );
    inserted.rfqProductIds.push(product.id);
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
       VALUES ($1, $2, $3, 0)`,
      [rfq_id, productVariantId, vendorId]
    );
    // A minimal quote to satisfy quote_id FK in finalization.
    const quote = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
       VALUES ($1, 1, $2, $2) RETURNING id`,
      [rfq_id, vendorId]
    );
    inserted.quoteIds.push(quote.id);
    return { rfq_id, rfq_product_id: product.id, product_variant_id: productVariantId, quote_id: quote.id };
  }

  async function makeFinalization(rfq_id, product_variant_id, vendor_id, quote_id) {
    const row = await db.one(
      `INSERT INTO tbl_quote_finalization
         (rfq_id, rfq_no, quote_id, product_variant_id, variant, vendor_id, created_by)
       VALUES ($1, 1, $2, $3, 0, $4, $5) RETURNING id`,
      [rfq_id, quote_id, product_variant_id, vendor_id, IDS.users.a1_proc_buyer]
    );
    inserted.finalizationIds.push(row.id);
    return row.id;
  }

  async function makePo({
    rfq_id, vendorId = IDS.users.vendor_alpha, status = "acceptance_pending",
    rfq_product_ids = [], quote_ids = [], initiatedBy = IDS.users.a1_proc_buyer,
    companyId = IDS.companies.A, // tbl_company.id (parent), NOT tbl_hospitality_companies.id
  }) {
    const po = await db.one(
      `INSERT INTO tbl_rfq_purchase_order
         (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
          finalized_vendor_id, total_value, quote_id, initiated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, 100, $6, 100, $7, $8, NOW(), NOW())
       RETURNING id`,
      [
        rfq_id,
        companyId,
        nextPoNo(),
        status,
        rfq_product_ids,
        vendorId,
        quote_ids,
        initiatedBy,
      ]
    );
    inserted.poIds.push(po.id);
    return po.id;
  }

  async function attachProductToPo(po_id, rfq_product_id, quote_id) {
    const r = await db.one(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
       VALUES ($1, $2, $3, 1, 'NOS', 100, 100) RETURNING id`,
      [po_id, rfq_product_id, quote_id]
    );
    inserted.poProductIds.push(r.id);
    return r.id;
  }

  return { makeRfqWithProductAndVendor, makeFinalization, makePo, attachProductToPo };
}

/**
 * Deletes everything the fixtures above recorded, then resets the tracker.
 * Same order as the original afterEach in po.acceptReject.test.js.
 */
export async function cleanupPoFixtures(inserted) {
  if (inserted.finalizationHistoryIds.length) {
    await db.none(`DELETE FROM tbl_quote_finalization_history WHERE id = ANY($1::int[])`, [inserted.finalizationHistoryIds]);
  }
  if (inserted.poProductIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE id = ANY($1::int[])`, [inserted.poProductIds]);
  }
  if (inserted.poIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type='PO' AND entity_id = ANY($1::int[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [inserted.poIds]);
  }
  if (inserted.finalizationIds.length) {
    // Some may have been moved to history by the controller; that's fine.
    await db.none(`DELETE FROM tbl_quote_finalization WHERE id = ANY($1::int[])`, [inserted.finalizationIds]);
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
  for (const k of Object.keys(inserted)) inserted[k] = [];
}
