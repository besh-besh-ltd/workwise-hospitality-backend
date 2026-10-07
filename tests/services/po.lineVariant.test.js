// A drafted PO line records the catalogue variant it was awarded for.
//
// tbl_purchase_order_product.product_variant_id was added for ARC call-off POs
// and only that path ever wrote it. The RFQ award path (draftPurchaseOrder,
// reached from /rfq/finalize, NEGOTIATION_QUOTE post-approval and the
// negotiation award) inserted lines without it, so every RFQ line on prod
// (2,387 of 2,387) had NULL — and any report that joined the variant through
// the line came back empty. The line now takes the variant from its
// rfq_product at insert time, on both the new-PO and the merge-onto-draft
// branches.
//
// Real HTTP: supertest -> buildTestApp, full middleware stack, then the line
// is read back from the database.

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";

const BUYER = IDS.users.a1_proc_buyer;
let VARIANT_A = 1;
let VARIANT_B = 2;

// finalize is gated by acl([2, 8, 10]) on tbl_users.user_type, which the shared
// fixture leaves NULL — same pattern as rfq.finalizeGuards.test.js.
beforeAll(async () => {
  const vs = await db.any(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 2`);
  if (vs[0]) VARIANT_A = vs[0].id;
  if (vs[1]) VARIANT_B = vs[1].id;
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
});

afterAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [BUYER]);
  await closeDb();
});

const inserted = { rfqIds: [], hierarchyIds: [] };
beforeEach(() => {
  inserted.rfqIds = [];
  inserted.hierarchyIds = [];
});

afterEach(async () => {
  if (inserted.rfqIds.length) {
    const pos = await db.any(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    const poIds = pos.map((p) => p.id);
    if (poIds.length) {
      await db.none(`DELETE FROM tbl_purchase_order_document WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
      await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
      await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]);
      const inst = await db.any(
        `SELECT id FROM tbl_approval_instances WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]
      );
      const ids = inst.map((r) => r.id);
      if (ids.length) {
        await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [ids]);
        await db.none(
          `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
             (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [ids]
        );
        await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [ids]);
        await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [ids]);
      }
      await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);
    }
    const rps = await db.any(`SELECT id FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    const rpIds = rps.map((r) => r.id);
    if (rpIds.length) {
      const inst = await db.any(
        `SELECT id FROM tbl_approval_instances WHERE entity_type = 'NEGOTIATION_QUOTE' AND entity_id = ANY($1::int[])`, [rpIds]
      );
      const ids = inst.map((r) => r.id);
      if (ids.length) {
        await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [ids]);
        await db.none(
          `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
             (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [ids]
        );
        await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [ids]);
        await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [ids]);
      }
    }
    await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
  if (inserted.hierarchyIds.length) {
    await db.none(`DELETE FROM tbl_approval_hierarchy WHERE id = ANY($1::int[])`, [inserted.hierarchyIds]);
  }
});

const tsString = (offsetMs) =>
  new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);

async function seedPoHierarchy() {
  const { company_id } = await db.one(`SELECT company_id FROM tbl_users WHERE id = $1`, [BUYER]);
  const row = await db.one(
    `INSERT INTO tbl_approval_hierarchy (company_id, user_id, approval_level, bypass_cap, hierarchy_type)
     VALUES ($1, $2, 1, 0, 'po') RETURNING id`,
    [company_id, BUYER]
  );
  inserted.hierarchyIds.push(row.id);
}

/**
 * A published, bid-closed RFQ with one product per variant and one vendor
 * quote line each. `hotel` / `process` pick the approval-policy path.
 */
async function makeAwardableRfq({ variants, hotel, process }) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER, status: 1, is_published: 1, is_tender: 0,
    tender_publish_date: tsString(-2 * 86400_000),
    vendor_clarification_date: tsString(-86400_000),
    bid_end_date: tsString(-3600_000),
    hospitality: IDS.hospitality.A, hotel, department: IDS.departments.proc, process,
    title: "po line variant fixture",
  });
  inserted.rfqIds.push(rfq_id);
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
     VALUES ($1, $2, $3, $3, 1, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')) RETURNING id`,
    [rfq_id, rfq_no, IDS.users.vendor_alpha]
  );
  const products = [];
  for (const variant of variants) {
    const rp = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfq_id, variant]
    );
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
       VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`,
      [rfq_id, variant, IDS.users.vendor_alpha]
    );
    const qi = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, package_price,
          tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
       VALUES ($1, $2, $3, $4, 500, 50000, 0, 18, 0, 0, 'q', '15', '100', 'percentage', '[]')
       RETURNING id`,
      [rfq_id, rfq_no, q.id, variant]
    );
    products.push({ rfq_product_id: rp.id, variant, quote_item_id: qi.id });
  }
  return { rfq_id, rfq_no, products };
}

async function finalize({ rfq_id, rfq_no }, p) {
  const client = await httpClient(BUYER);
  return client.post("/api/v1/rfq/finalize").send({
    rfq_id, rfq_no, product_variant_id: p.variant, variant: 0,
    vendor_id: IDS.users.vendor_alpha, quote_id: p.quote_item_id, quote_item_id: p.quote_item_id,
    route_type: "PO", comment: "awarding for the line-variant test",
    total_value: 50000,
    // The shape quote-compare.js posts. It carries no variant — the line has
    // to get that from the rfq_product itself.
    product_info: {
      rfq_product_id: p.rfq_product_id,
      quantity: 100,
      unit: "NOS",
      unit_price: 500,
      charges_meta: { tax: 18, tax_mode: "percentage" },
      finalized_vendor_id: IDS.users.vendor_alpha,
    },
  });
}

async function linesOf(rfq_id) {
  return db.any(
    `SELECT pop.rfq_product_id, pop.product_variant_id
       FROM tbl_purchase_order_product pop
       JOIN tbl_rfq_purchase_order po ON po.id = pop.purchase_order_id
      WHERE po.rfq_id = $1
      ORDER BY pop.id`,
    [rfq_id]
  );
}

/**
 * The hotel/process pair whose award drafts a PO straight away — i.e. no
 * NEGOTIATION_QUOTE policy resolves for it in the seed. Probed rather than
 * hardcoded so a seed change can't silently turn this suite into a no-op.
 */
async function directDraftPath() {
  const candidates = [
    { hotel: IDS.hotels.A2, process: null },
    { hotel: IDS.hotels.A1, process: null },
    { hotel: IDS.hotels.A2, process: IDS.processes.A_P1 },
  ];
  for (const c of candidates) {
    const rfq = await makeAwardableRfq({ variants: [VARIANT_A], ...c });
    await seedPoHierarchy();
    const res = await finalize(rfq, rfq.products[0]);
    const lines = await linesOf(rfq.rfq_id);
    if (res.status === 200 && lines.length === 1) return { path: c, rfq, lines };
  }
  throw new Error("no seeded hotel/process drafts a PO directly on award — the suite cannot exercise draftPurchaseOrder");
}

describe("POST /rfq/finalize — the drafted PO line records its variant", () => {
  it("a new PO's line carries the awarded rfq_product's variant", async () => {
    const { rfq, lines } = await directDraftPath();
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].rfq_product_id)).toBe(Number(rfq.products[0].rfq_product_id));
    expect(lines[0].product_variant_id).toBe(VARIANT_A);
  });

  it("a second product merged onto the same draft PO carries ITS own variant", async () => {
    const { path } = await directDraftPath();
    const rfq = await makeAwardableRfq({ variants: [VARIANT_A, VARIANT_B], ...path });
    await seedPoHierarchy();
    for (const p of rfq.products) {
      const res = await finalize(rfq, p);
      expect(res.status).toBe(200);
    }
    const lines = await linesOf(rfq.rfq_id);
    const pos = await db.one(`SELECT COUNT(*)::int AS n FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq.rfq_id]);
    expect(pos.n).toBe(1); // merged, so the merge branch is the one under test
    expect(lines).toHaveLength(2);
    const byRp = Object.fromEntries(lines.map((l) => [l.rfq_product_id, l.product_variant_id]));
    expect(byRp[rfq.products[0].rfq_product_id]).toBe(VARIANT_A);
    expect(byRp[rfq.products[1].rfq_product_id]).toBe(VARIANT_B);
  });
});
