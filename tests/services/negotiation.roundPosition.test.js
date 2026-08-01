// negotiation.roundPosition.test.js — round_number is RFQ-WIDE.
//
// PRODUCT DEFINITION (authoritative): "round_number means the number of the
// current round in the whole RFQ, not product-wise. If this RFQ had 3 rounds
// for 3 different products, then a round for a brand-new product 4 should get
// round 4, not round 1."
//
// The displayed number already obeys that (roundPositionSql computes it with
// ROW_NUMBER() at read time). What lagged behind was the STORED column: the
// allocator was `MAX(round_number) + 1` across the RFQ, and stored values are
// per-product legacy numbers, so on production RFQ 512 — 138 rounds, highest
// stored value 4 — a new round was written as 5 when its true position is 139.
//
// Wiring getNextRoundPositionForRfq was blocked until the buyer dashboard
// stopped keying its savings baseline on `round_number = 1`. It no longer does
// (see dashboard.negotiationSavingsLadder.test.js), so this is the other half.
//
// Two things had to move with it:
//   * getSiblingRoundIds grouped a "cycle" by (source_type, source_id,
//     round_number). RFQ-wide numbers are unique per RFQ, so every cycle would
//     collapse to a single round and scope=cycle would silently degrade to
//     scope=round. Production has sibling groups of up to 46 rounds. It is now
//     keyed on the round's ITEM-WISE CYCLE ORDINAL instead — verified
//     byte-identical to the old grouping on all 886 production rounds.
//   * the allocator races. There is no unique constraint on
//     (rfq_id, round_number) — production already holds 46 rounds sharing one
//     value — so a concurrent double-read duplicates rather than errors. The
//     FOR UPDATE row lock only serialises if it runs in the CALLER's
//     transaction.
//
// Existing stored values are NOT renumbered. Display is computed.

import { describe, it, expect, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import negotiationController from "../../app/controllers/negotiation/negotiationController.js";
import negotiationModel from "../../app/models/negotiationModel.js";
import { makeRFQ } from "../factories/rfq.js";

afterAll(async () => {
  await closeDb();
});

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: { user: opts.user, params: opts.params || {}, body: opts.body || {}, query: opts.query || {} },
    res,
    next: jest.fn(),
    calls,
  };
}

const BUYER = IDS.users.a1_proc_buyer;
const VA = IDS.users.vendor_alpha;
const futureIso = (offsetMs = 7 * 86400_000) => new Date(Date.now() + offsetMs).toISOString();

const inserted = { rfqIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
});

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  const roundIds = (
    await db.any(`SELECT id FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds])
  ).map((r) => Number(r.id));
  if (roundIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_actions WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[]))`,
      [roundIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT s.id FROM tbl_approval_instance_steps s
         JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
         WHERE i.entity_type='NEGOTIATION' AND i.entity_id = ANY($1::int[]))`,
      [roundIds]
    );
    await db.none(
      `DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[]))`,
      [roundIds]
    );
    await db.none(`DELETE FROM tbl_approval_instances WHERE entity_type='NEGOTIATION' AND entity_id = ANY($1::int[])`, [roundIds]);
    await db.none(`DELETE FROM tbl_negotiation_round_approvals WHERE negotiation_round_id = ANY($1::int[])`, [roundIds]);
    await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [roundIds]);
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [roundIds]);
  }
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  inserted.rfqIds = [];
});

// ── setup helpers ─────────────────────────────────────────────────────────

async function makeBidEndedRfq() {
  const ago = (d) => new Date(Date.now() - d * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const { rfq_id } = await makeRFQ(db, {
    createdBy: BUYER,
    status: 1,
    is_published: 1,
    tender_publish_date: ago(3),
    vendor_clarification_date: ago(2),
    bid_end_date: ago(1), // bid window CLOSED → negotiation allowed
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(Number(rfq_id));
  return Number(rfq_id);
}

async function addBareProduct(rfqId, variantId) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '', '', '', $2, 0) RETURNING id`,
    [rfqId, variantId]
  );
  return Number(row.id);
}

async function addProduct(rfqId, variantId) {
  const id = await addBareProduct(rfqId, variantId);
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfqId, variantId, VA]
  );
  return id;
}

// A legacy round row, written straight to the table the way the per-product
// allocator used to write them.
async function seedLegacyRound(rfqId, { productId, storedNumber, agoMinutes, status = "CLOSED" }) {
  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, rfq_product_id, round_number, status, end_date,
        vendor_ids, created_by, created_at)
     VALUES ($1, 'RFQ', $1, $2, $3, $4, now() - interval '1 day', $5::int[], $6,
             now() - ($7 || ' minutes')::interval)
     RETURNING id`,
    [rfqId, productId, storedNumber, status, [VA], BUYER, String(agoMinutes)]
  );
  return Number(row.id);
}

const createRound = async (body) => {
  const m = mockExpress({ user: { id: BUYER }, body });
  await negotiationController.createRound(m.req, m.res);
  return m.calls;
};

// ══════════════════════════════════════════════════════════════════════════
//  The allocator
// ══════════════════════════════════════════════════════════════════════════

describe("round_number allocation is RFQ-wide", () => {
  it("stores position 139 on an RFQ with 138 rounds whose highest stored value is 4", async () => {
    const rfqId = await makeBidEndedRfq();
    const newProduct = await addProduct(rfqId, 2);

    // 138 legacy rounds spread over 35 products, each product numbered from 1 —
    // the shape of production RFQ 512, where per-product numbering never got
    // past 4. (A partial unique index on (rfq_id, rfq_product_id, round_number)
    // enforces that a product cannot repeat a number, which is exactly why the
    // legacy allocator could never produce an RFQ-wide sequence.)
    let seededRounds = 0;
    let minutesAgo = 5000;
    for (let p = 0; p < 35 && seededRounds < 138; p += 1) {
      const productId = await addBareProduct(rfqId, 1);
      for (let n = 1; n <= 4 && seededRounds < 138; n += 1) {
        await seedLegacyRound(rfqId, { productId, storedNumber: n, agoMinutes: minutesAgo });
        minutesAgo -= 1;
        seededRounds += 1;
      }
    }
    const seeded = await db.one(
      `SELECT COUNT(*)::int AS n, MAX(round_number)::int AS mx FROM tbl_negotiation_rounds WHERE rfq_id = $1`,
      [rfqId]
    );
    expect(seeded.n).toBe(138);
    expect(seeded.mx).toBe(4); // MAX+1 would allocate 5

    const calls = await createRound({
      rfq_id: rfqId,
      rfq_product_id: newProduct,
      end_date: futureIso(),
      vendor_targets: [{ vendor_id: VA, fields: [{ name: "base_price", target: 10 }] }],
    });
    expect(calls.status).toBe(200);

    const fresh = await db.one(
      `SELECT round_number FROM tbl_negotiation_rounds
        WHERE rfq_id = $1 AND rfq_product_id = $2 ORDER BY id DESC LIMIT 1`,
      [rfqId, newProduct]
    );
    expect(Number(fresh.round_number)).toBe(139);
  });

  it("a round covering TWO products is stored as ONE row with ONE number", async () => {
    const rfqId = await makeBidEndedRfq();
    const p1 = await addProduct(rfqId, 1);
    const p2 = await addProduct(rfqId, 2);

    const calls = await createRound({
      rfq_id: rfqId,
      end_date: futureIso(),
      products: [
        { rfq_product_id: p1, vendor_targets: [{ vendor_id: VA, fields: [{ name: "base_price", target: 10 }] }] },
        { rfq_product_id: p2, vendor_targets: [{ vendor_id: VA, fields: [{ name: "base_price", target: 10 }] }] },
      ],
    });
    expect(calls.status).toBe(200);

    const rows = await db.any(
      `SELECT id, round_number, rfq_product_id, products FROM tbl_negotiation_rounds WHERE rfq_id = $1`,
      [rfqId]
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].round_number)).toBe(1);
    expect(rows[0].rfq_product_id).toBeNull();
    expect(rows[0].products).toHaveLength(2);

    // A later round on a third product continues the RFQ's chronology.
    const p3 = await addProduct(rfqId, 3);
    const second = await createRound({
      rfq_id: rfqId,
      rfq_product_id: p3,
      end_date: futureIso(),
      vendor_targets: [{ vendor_id: VA, fields: [{ name: "base_price", target: 10 }] }],
    });
    expect(second.status).toBe(200);
    const later = await db.one(
      `SELECT round_number FROM tbl_negotiation_rounds WHERE rfq_id = $1 AND rfq_product_id = $2`,
      [rfqId, p3]
    );
    expect(Number(later.round_number)).toBe(2);
  });

  it("two concurrent allocations on one RFQ never store the same number", async () => {
    const rfqId = await makeBidEndedRfq();
    const p1 = await addProduct(rfqId, 1);
    await seedLegacyRound(rfqId, { productId: p1, storedNumber: 1, agoMinutes: 60 });

    // Each transaction allocates and writes, exactly as createRound does. The
    // FOR UPDATE lock on the parent RFQ only serialises them when it runs in
    // the caller's transaction — which is why the txContext is threaded.
    //
    // Written in the MULTI-PRODUCT shape (rfq_product_id NULL, products JSONB)
    // on purpose: the partial unique index on
    // (rfq_id, rfq_product_id, round_number) does not cover NULL products, so
    // nothing but the lock stands between two concurrent creates and a silently
    // duplicated stored number.
    const allocateAndInsert = () =>
      db.tx(async (t) => {
        const n = await negotiationModel.getNextRoundPositionForRfq(rfqId, t);
        const row = await t.one(
          `INSERT INTO tbl_negotiation_rounds
             (rfq_id, source_type, source_id, rfq_product_id, round_number, status,
              end_date, products, vendor_ids, created_by, created_at)
           VALUES ($1, 'RFQ', $1, NULL, $2, 'CLOSED', now() + interval '1 day',
                   $3::jsonb, $4::int[], $5, now())
           RETURNING round_number`,
          [rfqId, n, JSON.stringify([{ rfq_product_id: p1, vendor_targets: [] }]), [VA], BUYER]
        );
        return Number(row.round_number);
      });

    const [a, b] = await Promise.all([allocateAndInsert(), allocateAndInsert()]);
    expect(new Set([a, b]).size).toBe(2);
    expect([a, b].sort((x, y) => x - y)).toEqual([2, 3]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Cycles survive the change
// ══════════════════════════════════════════════════════════════════════════

describe("getSiblingRoundIds groups a cycle without reading round_number", () => {
  it("keeps legacy cycles intact and admits a round the new allocator numbered RFQ-wide", async () => {
    const rfqId = await makeBidEndedRfq();
    const pA = await addProduct(rfqId, 1);
    const pB = await addProduct(rfqId, 2);
    const pC = await addProduct(rfqId, 3);

    // Legacy wave 1 — one row per product, all stored as round_number 1.
    const a1 = await seedLegacyRound(rfqId, { productId: pA, storedNumber: 1, agoMinutes: 100 });
    const b1 = await seedLegacyRound(rfqId, { productId: pB, storedNumber: 1, agoMinutes: 95 });
    const c1 = await seedLegacyRound(rfqId, { productId: pC, storedNumber: 1, agoMinutes: 90 });
    // Legacy wave 2 — products A and B only.
    const a2 = await seedLegacyRound(rfqId, { productId: pA, storedNumber: 2, agoMinutes: 80 });
    const b2 = await seedLegacyRound(rfqId, { productId: pB, storedNumber: 2, agoMinutes: 75 });

    expect(await negotiationModel.getSiblingRoundIds(a1)).toEqual([a1, b1, c1].sort((x, y) => x - y));
    expect(await negotiationModel.getSiblingRoundIds(a2)).toEqual([a2, b2].sort((x, y) => x - y));

    // Now the second round on product C, written by the RFQ-WIDE allocator, so
    // its stored number is 6 — its position in the RFQ, not its position on C.
    // It is still the SECOND wave for C and belongs with a2/b2. Grouping on the
    // stored value would have made it a lonely cycle of one.
    const c2 = await seedLegacyRound(rfqId, { productId: pC, storedNumber: 6, agoMinutes: 70 });
    expect(await negotiationModel.getSiblingRoundIds(c2)).toEqual([a2, b2, c2].sort((x, y) => x - y));
    expect(await negotiationModel.getSiblingRoundIds(a2)).toEqual([a2, b2, c2].sort((x, y) => x - y));
    // …and wave 1 is untouched by any of it.
    expect(await negotiationModel.getSiblingRoundIds(b1)).toEqual([a1, b1, c1].sort((x, y) => x - y));
  });

  it("a multi-product round shares the cycle of the rounds it follows", async () => {
    const rfqId = await makeBidEndedRfq();
    const pA = await addProduct(rfqId, 1);
    const pB = await addProduct(rfqId, 2);

    const a1 = await seedLegacyRound(rfqId, { productId: pA, storedNumber: 1, agoMinutes: 100 });
    const b1 = await seedLegacyRound(rfqId, { productId: pB, storedNumber: 1, agoMinutes: 95 });

    // One multi-product round covering BOTH A and B — the shape every new round
    // takes. Second wave for both, so it groups with neither of the wave-1 rows.
    const multi = await db.one(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, source_type, source_id, rfq_product_id, round_number, status, end_date,
          products, vendor_ids, created_by, created_at)
       VALUES ($1, 'RFQ', $1, NULL, 3, 'CLOSED', now() - interval '1 day',
               $2::jsonb, $3::int[], $4, now() - interval '80 minutes')
       RETURNING id`,
      [
        rfqId,
        JSON.stringify([{ rfq_product_id: pA, vendor_targets: [] }, { rfq_product_id: pB, vendor_targets: [] }]),
        [VA],
        BUYER,
      ]
    );
    const multiId = Number(multi.id);

    expect(await negotiationModel.getSiblingRoundIds(multiId)).toEqual([multiId]);
    expect(await negotiationModel.getSiblingRoundIds(a1)).toEqual([a1, b1].sort((x, y) => x - y));
  });
});
