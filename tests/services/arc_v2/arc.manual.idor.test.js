// ARC v2 — Manual entry: cross-tenant IDOR on the items section (SEC-1, P0).
//
// In saveSection's `items` branch the ARC is reload-and-verified for scope, but
// the per-item UPDATE, the raw HSN UPDATE, and the history-snapshot upsert all
// key on the client-supplied `it.id` with NO `arc_id` predicate. So a user who
// legitimately owns draft ARC-A can overwrite ANOTHER tenant's contract line
// item (qty/uom/spec/hsn + consumption-history rows) just by passing that
// foreign item's id in ARC-A's items payload.
//
// This asserts the observable security contract: a foreign item id is rejected
// or silently ignored, and the foreign tenant's tbl_arc_item row + its
// tbl_arc_item_history_snapshot rows are left BYTE-FOR-BYTE unchanged.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

describe("ARC v2 manual — cross-tenant IDOR on items (SEC-1)", () => {
  const BUYER_A = IDS.users.a1_proc_buyer;   // Hotel A1 / Hospitality A only
  const HOTEL_A1 = IDS.hotels.A1;
  const HOTEL_B1 = IDS.hotels.B1;            // Hospitality B — buyer A has NO access
  const DEPT = IDS.departments.proc;
  const HC_B = IDS.hospitality.B;
  const CATEGORY = TEST_CATEGORIES.beverages;
  const VARIANT_A = 1;
  const VARIANT_B = 2;                        // distinct variant so B's item is unique
  const VENDOR_B = IDS.users.vendor_beta;    // any real user for the snapshot's last_vendor_id
  let client;
  const createdArcIds = [];

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER_A]);
    client = await httpClient(BUYER_A);
  });

  afterAll(async () => {
    if (createdArcIds.length) {
      await db.none(
        `DELETE FROM tbl_arc_item_history_snapshot
          WHERE arc_item_id IN (SELECT id FROM tbl_arc_item WHERE arc_id = ANY($1::int[]))`,
        [createdArcIds]
      );
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_manual_entry WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [createdArcIds]);
    }
  });

  // Seed ARC-A through the real create endpoint (buyer A owns it, scope-valid).
  async function newDraftA() {
    const res = await client.post("/api/v1/arc-v2/manual/draft").send({
      header: { title: "A-side manual", type: "product", eligibility_type: "open" },
      scope: { hotel_id: HOTEL_A1, category_id: CATEGORY, department_id: DEPT },
      provenance: { target_stage: "evaluation", created_at: "2024-04-01T00:00:00Z" },
    });
    expect(res.status).toBe(200);
    const id = res.body.data.arc.id;
    createdArcIds.push(id);
    return id;
  }

  // Seed ARC-B (Hospitality B) + one item + a history snapshot directly in the
  // DB as a DIFFERENT tenant that buyer A cannot access.
  async function seedForeignArcWithItem() {
    const arcB = await db.one(
      `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, status, created_by)
       VALUES ($1, 'B-side manual', $2, $3, $4, $5, 'draft', $6) RETURNING *`,
      [`ARC-IDOR-B-${Date.now()}`, CATEGORY, HC_B, HOTEL_B1, DEPT, IDS.users.companyB_admin]
    );
    createdArcIds.push(arcB.id);
    await db.none(
      `INSERT INTO tbl_arc_manual_entry (arc_id, target_stage, entered_by) VALUES ($1, 'evaluation', $2)`,
      [arcB.id, IDS.users.companyB_admin]
    );
    const itemB = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, spec_text, target_price, indicative_qty, uom, hsn)
       VALUES ($1, $2, 'B original spec', 50, 800, 'kg', '0703') RETURNING *`,
      [arcB.id, VARIANT_B]
    );
    await db.none(
      `INSERT INTO tbl_arc_item_history_snapshot (arc_item_id, year_offset, consumed_qty, last_rate, last_vendor_id)
       VALUES ($1, 1, 700, 48, $2)`,
      [itemB.id, VENDOR_B]
    );
    return { arcB, itemB };
  }

  test("PUT items with a FOREIGN item id does not overwrite the other tenant's item or history", async () => {
    const arcAId = await newDraftA();
    const { arcB, itemB } = await seedForeignArcWithItem();

    // Snapshot B's item + history BEFORE the attack, for a byte-for-byte compare.
    const beforeItem = await db.one(`SELECT * FROM tbl_arc_item WHERE id = $1`, [itemB.id]);
    const beforeHist = await db.one(
      `SELECT * FROM tbl_arc_item_history_snapshot WHERE arc_item_id = $1 AND year_offset = 1`,
      [itemB.id]
    );

    // Attacker (buyer A) PUTs ARC-A's items section but smuggles in B's item id,
    // attempting to overwrite qty/uom/spec/hsn + history on a tenant they cannot reach.
    const res = await client.put(`/api/v1/arc-v2/manual/draft/${arcAId}/section/items`).send({
      items: [
        // legitimately own a new item on ARC-A (so the request isn't trivially empty)
        { product_variant_id: VARIANT_A, indicative_qty: 100, uom: "litre", hsn: "2202" },
        // the IDOR payload: B's item id with tampered values
        {
          id: itemB.id,
          product_variant_id: VARIANT_B,
          indicative_qty: 999999,
          uom: "HACKED",
          spec_text: "tampered by tenant A",
          hsn: "9999",
          history: [{ year_offset: 1, consumed_qty: 1, last_rate: 1, last_vendor_id: VENDOR_B }],
        },
      ],
    });

    // The foreign item must be rejected (4xx) or silently ignored (no-op) — but
    // NEVER applied. Either way B's data must be untouched.
    expect(res.status).not.toBe(500);

    // B's item row is UNCHANGED.
    const afterItem = await db.one(`SELECT * FROM tbl_arc_item WHERE id = $1`, [itemB.id]);
    expect(afterItem.spec_text).toBe(beforeItem.spec_text);
    expect(afterItem.spec_text).toBe("B original spec");
    expect(Number(afterItem.indicative_qty)).toBe(Number(beforeItem.indicative_qty));
    expect(Number(afterItem.indicative_qty)).toBe(800);
    expect(afterItem.uom).toBe(beforeItem.uom);
    expect(afterItem.uom).toBe("kg");
    expect(afterItem.hsn).toBe(beforeItem.hsn);
    expect(afterItem.hsn).toBe("0703");

    // B's history snapshot row is UNCHANGED.
    const afterHist = await db.one(
      `SELECT * FROM tbl_arc_item_history_snapshot WHERE arc_item_id = $1 AND year_offset = 1`,
      [itemB.id]
    );
    expect(Number(afterHist.consumed_qty)).toBe(Number(beforeHist.consumed_qty));
    expect(Number(afterHist.consumed_qty)).toBe(700);
    expect(Number(afterHist.last_rate)).toBe(Number(beforeHist.last_rate));
    expect(Number(afterHist.last_rate)).toBe(48);

    // B still has exactly its one item (the attacker did not graft a row onto it
    // and ARC-A's legitimate new item landed on ARC-A, not ARC-B).
    const bItemCount = await db.one(`SELECT COUNT(*)::int AS c FROM tbl_arc_item WHERE arc_id = $1`, [arcB.id]);
    expect(bItemCount.c).toBe(1);
  });
});
