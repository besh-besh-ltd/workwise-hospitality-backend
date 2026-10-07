// Migration 20260929100000 — backfill product_variant_id on RFQ PO lines.
//
// The test DB applies it through tests/setup/pendingMigrations.json, exactly as
// a real environment would. These tests re-run it (and its down) against lines
// seeded in the production shape and assert what is observable afterwards:
// which lines carry a variant, and that the down undoes exactly what the up
// did — never a line the fixed insert path wrote, never one corrected later.
//
// The suite leaves the migration APPLIED, the state every other suite expects.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  makePO,
  cleanupPurchaseOrders,
} from "../helpers/dashboardSeed.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const UP = "20260929100000_po_line_variant_backfill.sql";
const DOWN = "20260929100000_po_line_variant_backfill.down.sql";
const run = (file) => db.none(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));

const BUYER = IDS.users.a1_proc_buyer;
const seeded = { rfqIds: [], poIds: [] };
let VARIANT_A;
let VARIANT_B;

// Lines, by role in the scenario:
//   nullLine      prod shape: NULL variant, rfq_product on the PO's own RFQ
//   foreignLine   NULL variant, but its rfq_product belongs to ANOTHER RFQ (ambiguous)
//   writtenLine   variant written at insert by the fixed code path
let nullLine;
let foreignLine;
let writtenLine;

async function variantOf(lineId) {
  const r = await db.one(`SELECT product_variant_id FROM tbl_purchase_order_product WHERE id = $1`, [lineId]);
  return r.product_variant_id;
}

async function rfqWithProduct(variant) {
  const { rfq_id } = await makeRfqVisibleToDashboard(db, {
    createdBy: BUYER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    is_published: 1, status: 1, title: "po line variant backfill",
  });
  seeded.rfqIds.push(rfq_id);
  const rp = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', $2, 0) RETURNING id`,
    [rfq_id, variant]
  );
  return { rfq_id, rfq_product_id: rp.id };
}

async function poLine(rfq_id, rfq_product_id) {
  const { po_id, pop_id } = await makePO(db, {
    rfq_id, rfq_product_id, vendor_user_id: IDS.users.vendor_alpha,
    company_id: IDS.companies.A, status: "approved", unit_price: 100, quantity: 1, total_value: 100,
  });
  seeded.poIds.push(po_id);
  return pop_id;
}

beforeAll(async () => {
  const vs = await db.any(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 2`);
  VARIANT_A = vs[0].id;
  VARIANT_B = vs[1].id;

  const a = await rfqWithProduct(VARIANT_A);
  const b = await rfqWithProduct(VARIANT_B);
  nullLine = await poLine(a.rfq_id, a.rfq_product_id);
  // A line on RFQ a pointing at RFQ b's product: which variant is right is
  // not knowable, so the backfill must leave it alone.
  foreignLine = await poLine(a.rfq_id, b.rfq_product_id);
  writtenLine = await poLine(a.rfq_id, a.rfq_product_id);
  await db.none(`UPDATE tbl_purchase_order_product SET product_variant_id = $1 WHERE id = $2`, [VARIANT_A, writtenLine]);
});

afterAll(async () => {
  // Leave the migration applied, as the test DB was prepared.
  await run(UP);
  await cleanupPurchaseOrders(db, seeded.poIds);
  if (seeded.rfqIds.length) await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [seeded.rfqIds]);
  await cleanupRfqs(db, seeded.rfqIds);
  await closeDb();
});

describe("20260929100000 po line variant backfill", () => {
  it("up: fills a prod-shaped line from its own rfq_product, and records it", async () => {
    expect(await variantOf(nullLine)).toBeNull();
    await run(UP);
    expect(await variantOf(nullLine)).toBe(VARIANT_A);
    const ledger = await db.oneOrNone(
      `SELECT product_variant_id FROM tbl_po_line_variant_backfill WHERE purchase_order_product_id = $1`,
      [nullLine]
    );
    expect(ledger?.product_variant_id).toBe(VARIANT_A);
  });

  it("up: leaves an ambiguous line (rfq_product from another RFQ) NULL", async () => {
    await run(UP);
    expect(await variantOf(foreignLine)).toBeNull();
  });

  it("up: never touches a line that already carries a variant, and does not record it", async () => {
    await run(UP);
    expect(await variantOf(writtenLine)).toBe(VARIANT_A);
    const ledger = await db.oneOrNone(
      `SELECT 1 FROM tbl_po_line_variant_backfill WHERE purchase_order_product_id = $1`, [writtenLine]
    );
    expect(ledger).toBeNull();
  });

  it("up is idempotent: a second run changes nothing", async () => {
    await run(UP);
    const before = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_po_line_variant_backfill`);
    await run(UP);
    const after = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_po_line_variant_backfill`);
    expect(after.n).toBe(before.n);
    expect(await variantOf(nullLine)).toBe(VARIANT_A);
  });

  it("down: clears exactly what up set — not a code-written line, not a later correction", async () => {
    await run(UP);
    // Someone corrects a backfilled line afterwards: that value is theirs now.
    const corrected = await poLine(seeded.rfqIds[0], (await db.one(
      `SELECT rfq_product_id FROM tbl_purchase_order_product WHERE id = $1`, [nullLine]
    )).rfq_product_id);
    await run(UP);
    await db.none(`UPDATE tbl_purchase_order_product SET product_variant_id = $1 WHERE id = $2`, [VARIANT_B, corrected]);

    await run(DOWN);
    expect(await variantOf(nullLine)).toBeNull();
    expect(await variantOf(writtenLine)).toBe(VARIANT_A);
    expect(await variantOf(corrected)).toBe(VARIANT_B);
    const table = await db.one(`SELECT to_regclass('public.tbl_po_line_variant_backfill') AS t`);
    expect(table.t).toBeNull();
  });

  it("down then up restores the backfill", async () => {
    await run(DOWN);
    await run(UP);
    expect(await variantOf(nullLine)).toBe(VARIANT_A);
  });
});
