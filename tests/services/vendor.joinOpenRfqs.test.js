// WH-67 regression: post-payment "auto-join open RFQs" must survive an RFQ
// whose `bid_end_date` is an EMPTY STRING.
//
// Production incident (P1): tbl_rfq.bid_end_date is a TEXT column. RFQ 744
// (rfq_no 536286) was published with bid_end_date = '' (empty string, NOT
// null). The backfill query in
// `hospitalityModel.getMatchingOpenRfqsForVendor` cast that column with no
// guard:
//
//     AND r.bid_end_date::timestamp > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
//
// Because that row satisfies `status = 1 AND is_published = 1`, the cast was
// evaluated on it and the WHOLE query aborted with
// `invalid input syntax for type timestamp: ""`. Every newly registered
// vendor therefore got a 500 on
// `GET /hospitality/vendor/matching-open-rfqs`, the frontend swallowed it,
// and the vendor landed on an empty dashboard with zero RFQs.
//
// The same unguarded cast lives in `hospitalityController.joinOpenRfqs`
// (scoped by `WHERE id = ANY($1::int[])`), so it only detonates when the
// poison id is passed in — which is exactly what the data-repair runbook
// does. This suite passes the poison id to `join-open-rfqs` on purpose.
//
// THE EMPTY-bid_end_date FIXTURE ROW IS THE REGRESSION GUARD. Remove it and
// this suite passes against the buggy code.
//
// Semantics locked in by these tests: an empty deadline EXCLUDES the RFQ
// from auto-join (conservative — we do not auto-join vendors to an RFQ that
// has no deadline). Note this deliberately differs from the vendor *listing*
// query (`rfqModel.getRfqByUser`) which treats bid_end_date = '' as open.
//
// Isolation: Pattern B (commit + cleanup) — the production model queries `db`
// directly and the flow is exercised over real HTTP.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import hospitalityModel from "../../app/models/hospitalityModel.js";

// Dedicated "just registered" vendor. Sits in the vendor-user range
// (80101..80199) but outside the fixture block (80101..80105) so no other
// suite touches it.
const NEW_VENDOR_ID = 80151;

const created = {
  rfqIds: [],
  variantMappingIds: [],
  subscriptionIds: [],
  poIds: [],
};

let variantId;
let poisonRfq; // published + active, bid_end_date = ''  ← the regression guard
let validRfq; // published + active, bid_end_date = future
let nullPoLineRfq; // has a completed PO whose line has rfq_product_id NULL ← guard #2
let finalizedRfq; // has a genuinely approved PO on its product ⇒ must stay excluded

async function addSub(itemType, itemId) {
  const row = await db.one(
    `INSERT INTO tbl_vendor_hotel_category_subscription
       (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
     VALUES ($1, $2, $3, 500,
             (now() - interval '30 days')::date,
             (now() + interval '335 days')::date,
             'active')
     RETURNING id`,
    [NEW_VENDOR_ID, itemType, itemId]
  );
  created.subscriptionIds.push(row.id);
  return row.id;
}

async function addRfqProduct(rfqId) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, variant)
     VALUES ($1, '', '0', '', '', $2, 1)
     RETURNING id`,
    [rfqId, variantId]
  );
  return row.id;
}

/**
 * A purchase order in a "finalizing" status (approved/sent/GRN/completed) with
 * one line. Pass `rfqProductId: null` to reproduce the production shape that
 * broke the backfill: 57 live rows in `tbl_purchase_order_product` have a NULL
 * `rfq_product_id` (legacy/manually-raised POs), and `rfq_product_id` is
 * nullable by schema.
 */
async function addFinalizedPO(rfqId, rfqProductId) {
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity,
        unit_price, finalized_vendor_id, total_value, quote_id, initiated_by)
     VALUES ($1, $2, $3, 'completed', '{}'::int[], 1, 100, $4, 100, '{}'::int[], $5)
     RETURNING id`,
    [
      rfqId,
      IDS.companies.A,
      `WH67-TEST-PO-${rfqId}-${Date.now()}`,
      NEW_VENDOR_ID,
      IDS.users.a1_proc_buyer,
    ]
  );
  created.poIds.push(po.id);
  await db.none(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quantity, unit, unit_price, total_price, product_variant_id)
     VALUES ($1, $2, 1, 'NOS', 100, 100, $3)`,
    [po.id, rfqProductId, variantId]
  );
  return po.id;
}

/**
 * A pristine published RFQ this vendor matches on every axis (variant,
 * category, hotel, open deadline). Created per-test on purpose: the suite's
 * earlier POST test joins whatever is offered, and a joined RFQ is then
 * correctly excluded as "already mapped" — so sharing one RFQ across tests
 * would couple them to execution order.
 */
async function makeFreshMatchingRfq(label) {
  const future = new Date(Date.now() + 14 * 86400_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  const rfq = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    bid_end_date: future,
    title: `WH-67 fresh open RFQ (${label})`,
  });
  created.rfqIds.push(rfq.rfq_id);
  await addRfqProduct(rfq.rfq_id);
  await mapRfqToHotel(rfq.rfq_id, IDS.hotels.A1);
  return rfq;
}

async function mapRfqToHotel(rfqId, hotelId) {
  await db.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT ON CONSTRAINT uq_rfq_hotel_mapping DO NOTHING`,
    [rfqId, hotelId, IDS.users.a1_proc_buyer]
  );
}

beforeAll(async () => {
  // A real seeded variant whose product sits in BEVERAGES (215) — the
  // category the new vendor will subscribe to.
  const v = await db.one(
    `SELECT pv.id
       FROM tbl_product_variant pv
       JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
      WHERE pc.category_id = $1
      ORDER BY pv.id
      LIMIT 1`,
    [TEST_CATEGORIES.beverages]
  );
  variantId = v.id;

  // --- the "just registered + just paid" vendor -----------------------------
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, company_id, created_at, updated_at)
     VALUES ($1, 'Post-Payment New Vendor', 'postpay.new@vendor.test', 1, $2, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [NEW_VENDOR_ID, IDS.companies.vendorAlpha]
  );

  const mapping = await db.one(
    `INSERT INTO tbl_product_variant_vendor_mapping
       (product_variant_id, vendor_id, status, is_approved, created_by, created_at, updated_at)
     VALUES ($1, $2, true, true, $2, now(), now())
     RETURNING id`,
    [variantId, NEW_VENDOR_ID]
  );
  created.variantMappingIds.push(mapping.id);

  await addSub("category", TEST_CATEGORIES.beverages);
  await addSub("hotel", IDS.hotels.A1);

  // --- RFQ 1: THE POISON ROW (bid_end_date = '') ---------------------------
  // Published + active, matching products + hotel, so it is a genuine
  // candidate row and the cast is definitely evaluated on it.
  poisonRfq = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    bid_end_date: "",
    title: "WH-67 poison RFQ (empty bid_end_date)",
  });
  created.rfqIds.push(poisonRfq.rfq_id);
  await addRfqProduct(poisonRfq.rfq_id);
  await mapRfqToHotel(poisonRfq.rfq_id, IDS.hotels.A1);

  // --- RFQ 2: the legitimately open RFQ the vendor should be joined to ------
  const future = new Date(Date.now() + 14 * 86400_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  validRfq = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    bid_end_date: future,
    title: "WH-67 valid open RFQ",
  });
  created.rfqIds.push(validRfq.rfq_id);
  await addRfqProduct(validRfq.rfq_id);
  await mapRfqToHotel(validRfq.rfq_id, IDS.hotels.A1);

  // --- RFQ 3: THE SECOND POISON ROW (completed PO, line rfq_product_id NULL) --
  // Nothing about this RFQ should affect the vendor's other RFQs. It exists
  // only so that the `finalized_products` set contains a NULL, which is what
  // made `rp.id NOT IN (SELECT rfq_product_id FROM finalized_products)`
  // evaluate to NULL — never TRUE — and silently return ZERO rows for every
  // vendor platform-wide.
  nullPoLineRfq = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    bid_end_date: future,
    title: "WH-67 poison RFQ (completed PO line with NULL rfq_product_id)",
  });
  created.rfqIds.push(nullPoLineRfq.rfq_id);
  await addRfqProduct(nullPoLineRfq.rfq_id);
  await mapRfqToHotel(nullPoLineRfq.rfq_id, IDS.hotels.A1);
  await addFinalizedPO(nullPoLineRfq.rfq_id, null);

  // --- RFQ 4: genuinely finalized — the clause's REAL job ---------------------
  // Same vendor, same category, same hotel, open deadline: eligible on every
  // axis except that its product already has an approved PO. It must stay
  // excluded. This is the mutation guard — deleting the clause outright (rather
  // than making it NULL-safe) makes this test fail.
  finalizedRfq = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    bid_end_date: future,
    title: "WH-67 already-finalized RFQ (approved PO on its product)",
  });
  created.rfqIds.push(finalizedRfq.rfq_id);
  const finalizedRfqProductId = await addRfqProduct(finalizedRfq.rfq_id);
  await mapRfqToHotel(finalizedRfq.rfq_id, IDS.hotels.A1);
  await addFinalizedPO(finalizedRfq.rfq_id, finalizedRfqProductId);
});

afterAll(async () => {
  if (created.poIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [created.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [created.poIds]);
  }
  if (created.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(
      `DELETE FROM tbl_vendor_rfq_tokens_non_login
        WHERE vendor_id = $1
          AND rfq_no IN (SELECT rfq_no FROM tbl_rfq WHERE id = ANY($2::int[]))`,
      [NEW_VENDOR_ID, created.rfqIds]
    );
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqIds]);
  }
  if (created.variantMappingIds.length) {
    await db.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE id = ANY($1::int[])`, [
      created.variantMappingIds,
    ]);
  }
  if (created.subscriptionIds.length) {
    await db.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE id = ANY($1::int[])`, [
      created.subscriptionIds,
    ]);
  }
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [NEW_VENDOR_ID]);
  await closeDb();
});

describe("WH-67 post-payment auto-join — empty bid_end_date must not poison the backfill", () => {
  it("GET /hospitality/vendor/matching-open-rfqs returns 200 (not 500) and includes the open RFQ", async () => {
    const client = await httpClient(NEW_VENDOR_ID);
    const res = await client.get("/api/v1/hospitality/vendor/matching-open-rfqs");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const ids = (res.body.data?.rfqs ?? []).map((r) => Number(r.rfq_id));
    expect(ids).toContain(validRfq.rfq_id);
  });

  it("excludes the RFQ whose bid_end_date is an empty string (no deadline ⇒ no auto-join)", async () => {
    const client = await httpClient(NEW_VENDOR_ID);
    const res = await client.get("/api/v1/hospitality/vendor/matching-open-rfqs");

    expect(res.status).toBe(200);
    const ids = (res.body.data?.rfqs ?? []).map((r) => Number(r.rfq_id));
    expect(ids).not.toContain(poisonRfq.rfq_id);
  });

  it("POST /hospitality/vendor/join-open-rfqs survives the poison id and writes vendor rows for the open RFQ", async () => {
    const client = await httpClient(NEW_VENDOR_ID);
    // Deliberately include the poison id: the data-repair runbook posts the
    // ids returned by the GET, and any caller may pass a stale one. The
    // controller's own cast must be guarded too.
    const res = await client
      .post("/api/v1/hospitality/vendor/join-open-rfqs")
      .send({ rfq_ids: [validRfq.rfq_id, poisonRfq.rfq_id] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.rfqs.map((r) => Number(r.rfq_id))).toContain(validRfq.rfq_id);

    const rows = await db.any(
      `SELECT rfq_id FROM tbl_rfq_product_vendors WHERE user_id = $1 AND rfq_id = ANY($2::int[])`,
      [NEW_VENDOR_ID, [validRfq.rfq_id, poisonRfq.rfq_id]]
    );
    const joinedIds = rows.map((r) => Number(r.rfq_id));
    expect(joinedIds).toContain(validRfq.rfq_id);
    expect(joinedIds).not.toContain(poisonRfq.rfq_id);
  });

  it("the joined RFQ then shows up on the vendor's dashboard (POST /rfq/getMyRfq)", async () => {
    const client = await httpClient(NEW_VENDOR_ID);
    const res = await client.post("/api/v1/rfq/getMyRfq").send({ page: 1, limit: 50 });

    expect(res.status).toBe(200);
    const ids = (res.body.data ?? []).map((r) => Number(r.rfq_id ?? r.id));
    expect(ids).toContain(validRfq.rfq_id);
  });
});

// Second NULL hazard in the SAME query, four lines below the first.
//
// Production incident (P0), 2026-10-08. A vendor subscribed on 6 Oct to a
// hotel + category matching RFQ 536694, which was open until 8 Oct. The
// post-payment auto-join ran and added them to nothing, so the buyer's RFQ
// never reached them and they reported never receiving it.
//
// `getMatchingOpenRfqsForVendor` filtered finalized products with:
//
//     AND rp.id NOT IN (SELECT rfq_product_id FROM finalized_products)
//
// `tbl_purchase_order_product.rfq_product_id` is NULLABLE and 57 live rows
// (legacy/manually-raised PO lines) are NULL. `x NOT IN (… NULL …)` is NULL in
// SQL — never TRUE — so the WHERE dropped EVERY row for EVERY vendor.
//
// What made it a time bomb: the NULL-bearing POs only entered
// `finalized_products` once they reached a finalizing status. A bulk script on
// 2026-10-06 06:58:48 set 62 previously status-less POs to completed, 45 of
// them carrying NULL lines. Before that moment the query worked (vendor 968
// auto-joined successfully on 3 Oct); five hours after it, it returned zero
// rows for everyone. No deploy was involved, so nothing correlated the
// breakage with a release.
//
// THE NULL-rfq_product_id PO LINE (RFQ 3) IS THE REGRESSION GUARD, and the
// genuinely-finalized RFQ 4 is the mutation guard. Together they pin the fix
// to "make it NULL-safe", not "delete the filter".
describe("WH-67 post-payment auto-join — a NULL rfq_product_id must not void the whole backfill", () => {
  it("still returns the open RFQ even though a completed PO line has a NULL rfq_product_id", async () => {
    const fresh = await makeFreshMatchingRfq("null-hazard");
    const client = await httpClient(NEW_VENDOR_ID);
    const res = await client.get("/api/v1/hospitality/vendor/matching-open-rfqs");

    expect(res.status).toBe(200);
    const ids = (res.body.data?.rfqs ?? []).map((r) => Number(r.rfq_id));
    // Pre-fix this array was EMPTY — not "missing one entry", but empty.
    expect(ids).toContain(fresh.rfq_id);
  });

  it("does not collapse to an empty list (the production symptom)", async () => {
    await makeFreshMatchingRfq("non-empty");
    const client = await httpClient(NEW_VENDOR_ID);
    const res = await client.get("/api/v1/hospitality/vendor/matching-open-rfqs");

    expect(res.body.data?.rfqs?.length ?? 0).toBeGreaterThan(0);
  });

  it("still EXCLUDES an RFQ whose product already has an approved PO", async () => {
    const client = await httpClient(NEW_VENDOR_ID);
    const res = await client.get("/api/v1/hospitality/vendor/matching-open-rfqs");

    const ids = (res.body.data?.rfqs ?? []).map((r) => Number(r.rfq_id));
    expect(ids).not.toContain(finalizedRfq.rfq_id);
  });

  it("the vendor can actually join, and the RFQ reaches their dashboard", async () => {
    const fresh = await makeFreshMatchingRfq("joinable");
    const client = await httpClient(NEW_VENDOR_ID);
    const list = await client.get("/api/v1/hospitality/vendor/matching-open-rfqs");
    const offered = (list.body.data?.rfqs ?? []).map((r) => Number(r.rfq_id));

    // The vendor-facing flow posts back exactly what the GET offered. If the
    // GET is empty the frontend's `if (rfqs.length > 0)` never fires and the
    // vendor is silently left out — which is how this went unnoticed.
    const res = await client
      .post("/api/v1/hospitality/vendor/join-open-rfqs")
      .send({ rfq_ids: offered });

    expect(res.status).toBe(200);
    const rows = await db.any(
      `SELECT rfq_id FROM tbl_rfq_product_vendors WHERE user_id = $1 AND rfq_id = ANY($2::int[])`,
      [NEW_VENDOR_ID, [fresh.rfq_id, finalizedRfq.rfq_id]]
    );
    const joined = rows.map((r) => Number(r.rfq_id));
    expect(joined).toContain(fresh.rfq_id);
    expect(joined).not.toContain(finalizedRfq.rfq_id);

    const dash = await client.post("/api/v1/rfq/getMyRfq").send({ page: 1, limit: 50 });
    expect((dash.body.data ?? []).map((r) => Number(r.rfq_id ?? r.id))).toContain(fresh.rfq_id);
  });

  it("agrees with getEligibleVendorsForVariant — the two gates must not diverge", async () => {
    // The live defect showed up as exactly this divergence: the snapshot gate
    // called vendor 507 eligible for RFQ 536694's variant while the join gate
    // offered them nothing, so the vendor was eligible-but-unreachable with no
    // way in. Any future filter added to one gate and not the other reopens
    // the same hole, so assert the invariant rather than either side alone.
    const fresh = await makeFreshMatchingRfq("gate-parity");

    const eligible = await hospitalityModel.getEligibleVendorsForVariant(variantId, [IDS.hotels.A1]);
    expect(eligible.map((r) => Number(r.vendor_id))).toContain(NEW_VENDOR_ID);

    const offered = await hospitalityModel.getMatchingOpenRfqsForVendor(NEW_VENDOR_ID);
    expect(offered.map((r) => Number(r.rfq_id))).toContain(fresh.rfq_id);
  });
});
