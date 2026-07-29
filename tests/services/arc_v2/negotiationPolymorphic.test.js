// Negotiation polymorphic refactor — proves the new (source_type, source_id)
// columns work for both RFQ and ARC flows, that the trigger auto-fills
// source_type='RFQ' for legacy RFQ-only inserts, and that ARC-sourced rounds
// can be persisted without an rfq_id.

import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { makeRFQ } from "../../factories/rfq.js";

describe("Negotiation polymorphic — source_type + source_id", () => {
  const BUYER = IDS.users.a1_proc_buyer;

  async function seedRfqWithProduct() {
    const { rfq_id } = await makeRFQ(db, { createdBy: BUYER });
    const product = await db.one(
      `INSERT INTO tbl_rfq_products
         (rfq_id, product_variant_id, comment, spec_file, qap_file)
       VALUES ($1, 1, '', '', '') RETURNING *`,
      [rfq_id]
    );
    return { rfq_id, product_id: product.id };
  }

  async function cleanupRfq({ rfq_id, product_id }) {
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = $1`, [product_id]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = $1`, [rfq_id]);
  }

  test("legacy INSERT (rfq_id only) auto-fills source_type='RFQ', source_id=rfq_id via trigger", async () => {
    const seed = await seedRfqWithProduct();
    const round = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, rfq_product_id, round_number, end_date, created_by)
       VALUES ($1, $2, 1, NOW() + INTERVAL '7 days', $3)
       RETURNING *`,
      [seed.rfq_id, seed.product_id, BUYER]
    );
    expect(round.source_type).toBe("RFQ");
    expect(round.source_id).toBe(seed.rfq_id);
    expect(round.rfq_id).toBe(seed.rfq_id);

    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = $1`, [round.id]);
    await cleanupRfq(seed);
  });

  test("ARC INSERT with explicit source_type='ARC' + source_id works without rfq_id", async () => {
    const seed = await seedRfqWithProduct();
    const ARC_ID_SENTINEL = 999999;
    const round = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, rfq_product_id, round_number, end_date, created_by,
          source_type, source_id)
       VALUES (NULL, $1, 1, NOW() + INTERVAL '7 days', $2, 'ARC', $3)
       RETURNING *`,
      [seed.product_id, BUYER, ARC_ID_SENTINEL]
    );
    expect(round.source_type).toBe("ARC");
    expect(round.source_id).toBe(ARC_ID_SENTINEL);
    expect(round.rfq_id).toBeNull();

    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = $1`, [round.id]);
    await cleanupRfq(seed);
  });

  test("source_type CHECK constraint rejects unknown values", async () => {
    const seed = await seedRfqWithProduct();
    await expect(db.one(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, rfq_product_id, round_number, end_date, created_by, source_type, source_id)
       VALUES (NULL, $1, 1, NOW() + INTERVAL '7 days', $2, 'PO', $3) RETURNING *`,
      [seed.product_id, BUYER, 42]
    )).rejects.toThrow(/check constraint|source_type_chk/i);
    await cleanupRfq(seed);
  });
});
