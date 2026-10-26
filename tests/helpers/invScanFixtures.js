// Fixtures for the scan / label / short-link suites (Task B4).
//
// Every builder takes the caller's connection, so a test that runs inside
// withTx gets everything rolled back. No tbl_product / tbl_product_variant rows
// are inserted: tests borrow seeded variants that no stock item maps yet
// (freeVariants), which keeps clear of the product sequences entirely.

import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

let seq = 0;
export const tag = (prefix = "inv-b4") => `${prefix}-${process.pid}-${++seq}`;

export async function storekeeperRoleId(t) {
  const row = await t.one(`SELECT id FROM tbl_roles WHERE title = 'Storekeeper' AND created_by IS NULL`);
  return Number(row.id);
}

/** A role holding exactly the given permission keys, e.g. ['grn.read']. */
export async function roleWith(t, keys) {
  const role = await t.one(
    `INSERT INTO tbl_roles (title, description, created_by) VALUES ($1, 'B4 test role', $2) RETURNING id`,
    [tag("B4 role"), IDS.users.superAdmin]
  );
  await t.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, p.id FROM tbl_permissions p
      WHERE (p.resource::text || '.' || p.action::text) = ANY($2::text[])`,
    [role.id, keys]
  );
  return Number(role.id);
}

export async function makeItem(t, {
  companyId = IDS.hospitality.A, name = `Item ${tag()}`, stockUom = "kg", itemCode = null,
} = {}) {
  const row = await t.one(
    `INSERT INTO tbl_inv_item (hospitality_company_id, display_name, stock_uom, item_code)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [companyId, name, stockUom, itemCode]
  );
  return Number(row.id);
}

export async function addBarcode(t, { companyId = IDS.hospitality.A, invItemId, code, packFactor = 1 }) {
  await t.none(
    `INSERT INTO tbl_inv_item_barcode (hospitality_company_id, inv_item_id, code, pack_factor)
     VALUES ($1, $2, $3, $4)`,
    [companyId, invItemId, code, packFactor]
  );
}

export async function setBin(t, { companyId = IDS.hospitality.A, hotelId, invItemId, binLabel }) {
  await t.none(
    `INSERT INTO tbl_inv_hotel_item (hotel_id, inv_item_id, hospitality_company_id, bin_label)
     VALUES ($1, $2, $3, $4)`,
    [hotelId, invItemId, companyId, binLabel]
  );
}

/** Seeded catalogue variants that no stock item maps yet (highest ids first). */
export async function freeVariants(t, n) {
  const rows = await t.any(
    `SELECT pv.id FROM tbl_product_variant pv
      WHERE NOT EXISTS (SELECT 1 FROM tbl_inv_item_variant iv WHERE iv.product_variant_id = pv.id)
      ORDER BY pv.id DESC LIMIT $1`,
    [n]
  );
  if (rows.length < n) throw new Error(`need ${n} unmapped variants, found ${rows.length}`);
  return rows.map((r) => Number(r.id));
}

export async function mapVariant(t, { companyId = IDS.hospitality.A, invItemId, variantId }) {
  await t.none(
    `INSERT INTO tbl_inv_item_variant (hospitality_company_id, inv_item_id, product_variant_id)
     VALUES ($1, $2, $3)`,
    [companyId, invItemId, variantId]
  );
}

/**
 * An RFQ PO at `hotel` with one PO line per entry of `lines`
 * ([{variantId, qty, unit}]). Returns {poId, lineIds}.
 */
export async function makeRfqPo(t, {
  hospitality = IDS.hospitality.A, company = IDS.companies.A, hotel = IDS.hotels.A1,
  status = "approved", lines = [],
} = {}) {
  const { rfq_id } = await makeRFQ(t, {
    createdBy: IDS.users.a1_proc_buyer, status: 1, is_published: 1, hospitality, hotel,
  });
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by)
     VALUES ($1, $2, $3, $4, '{}', 1, 100, $5, 100, '{}', $6) RETURNING id`,
    [rfq_id, company, `INV-B4-${tag()}`, status, IDS.users.vendor_alpha, IDS.users.a1_proc_buyer]
  );
  const lineIds = [];
  for (const l of lines) {
    const row = await t.one(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, quantity, unit, unit_price, total_price, product_variant_id)
       VALUES ($1, $2, $3, 100, $4, $5) RETURNING id`,
      [po.id, l.qty ?? 10, l.unit ?? "kg", 100 * (l.qty ?? 10), l.variantId ?? null]
    );
    lineIds.push(Number(row.id));
  }
  return { poId: Number(po.id), lineIds };
}

/**
 * A posted RECEIPT GRN. lines = [{poLineId, invItemId, accepted, rejected?,
 * uomFactor?, stockQty?, poUom?, batchNo?, expiryDate?}].
 */
export async function makeGrn(t, {
  companyId = IDS.hospitality.A, hotelId = IDS.hotels.A1, poId, status = "posted",
  docType = "RECEIPT", reversesGrnId = null, lines = [],
}) {
  const grn = await t.one(
    `INSERT INTO tbl_grn (grn_number, hospitality_company_id, hotel_id, po_id, doc_type,
                          reverses_grn_id, status, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-10-20') RETURNING id`,
    [`GRN/B4/${tag()}`.slice(0, 40), companyId, hotelId, poId, docType, reversesGrnId, status]
  );
  for (const l of lines) {
    const rejected = l.rejected ?? 0;
    await t.none(
      `INSERT INTO tbl_grn_line
         (hospitality_company_id, grn_id, po_line_id, inv_item_id, po_uom, received_qty, accepted_qty,
          rejected_qty, rejection_reason, uom_factor, stock_qty, batch_no, expiry_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        companyId, grn.id, l.poLineId, l.invItemId, l.poUom ?? "kg", l.accepted + rejected, l.accepted,
        rejected, rejected > 0 ? "damaged" : null, l.uomFactor ?? null, l.stockQty ?? null,
        l.batchNo ?? null, l.expiryDate ?? null,
      ]
    );
  }
  return Number(grn.id);
}

export async function makeDispatch(t, { companyId = IDS.hospitality.A, poId, hotelId = null }) {
  const row = await t.one(
    `INSERT INTO tbl_po_dispatch (dispatch_number, hospitality_company_id, po_id, vendor_id, hotel_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [`DSP/B4/${tag()}`.slice(0, 40), companyId, poId, IDS.users.vendor_alpha, hotelId]
  );
  return Number(row.id);
}

/** Runs fn in a SAVEPOINT and returns what it threw (or fails the test). */
export async function thrownBy(t, fn) {
  try {
    await t.tx((sp) => fn(sp));
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}
