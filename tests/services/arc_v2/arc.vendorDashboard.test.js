// Vendor dashboard — GET /v1/arc-v2/vendor/dashboard.
//
// Proves the rollup payload against a seeded landscape covering every
// invitation state:
//   1. ACL: vendors only (buyer → 403).
//   2. counts: open / submitted / evaluating / awaiting_sign / active / past
//      derived exactly like the requests inbox.
//   3. totals + spend rollups (category / BU / product) from real contract
//      lines, and consumed value from call-off releases.
//   4. next_action prefers awaiting-sign over open invitations.
//   5. recent_call_offs + performance computed from PO statuses; the range
//      param scopes call-off aggregates (an old call-off drops out of QTD).
//   6. activity: whitelisted vendor-safe events only — buyer-internal eval
//      events and rows tagged with another vendor's id never appear.
//   7. Cross-vendor isolation + a fresh vendor gets a clean all-zero payload.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HC     = IDS.hospitality.A;
const HOTEL  = IDS.hotels.A1;
const DEPT   = IDS.departments.proc;
const PROC   = IDS.processes.A_P1;
const BUYER  = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const OTHER_VENDOR = IDS.users.vendor_beta;
const FRESH_VENDOR = IDS.users.vendor_gamma;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

describe("Vendor dashboard — counts, rollups, range, isolation", () => {
  let vendorClient, buyerClient;
  const arcIds = {};          // key → arc id
  let activeContractId, activeLineId;

  async function seedArc(key, number, status, { end = "180 days" } = {}) {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               NOW() - INTERVAL '20 days', NOW() + INTERVAL '5 days',
               NOW() - INTERVAL '10 days', NOW() + INTERVAL '${end}',
               $9) RETURNING *`,
      [number, `Dashboard ${key}`, CATEGORY, HC, HOTEL, DEPT, PROC, status, BUYER]
    );
    arcIds[key] = arc.id;
    return arc;
  }
  const invite = (arcId, vendorId) => db.none(
    `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1, $2, 'invited')`,
    [arcId, vendorId]
  );
  const submitQuote = (arcId, vendorId) => db.none(
    `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at) VALUES ($1, $2, NOW())`,
    [arcId, vendorId]
  );

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id IN ($1, $2, $3)`,
      [VENDOR, OTHER_VENDOR, FRESH_VENDOR]);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    vendorClient = await httpClient(VENDOR);
    buyerClient  = await httpClient(BUYER);

    // ── invitation landscape for vendor_alpha ──────────────────────────
    // A: floated, no quote          → open
    // B: floated, quote submitted   → submitted
    // C: in commercial eval, quoted → evaluating
    // D: awarded, contract awaiting → awaiting_sign
    // E: live contract              → active
    // F: arc expired, never awarded → past
    const arcA = await seedArc("A", "ARC-TEST-VD-A", "floated");
    const arcB = await seedArc("B", "ARC-TEST-VD-B", "floated");
    const arcC = await seedArc("C", "ARC-TEST-VD-C", "comm_eval_in_progress");
    const arcD = await seedArc("D", "ARC-TEST-VD-D", "awaiting_vendor_acceptance");
    const arcE = await seedArc("E", "ARC-TEST-VD-E", "contract_active");
    const arcF = await seedArc("F", "ARC-TEST-VD-F", "expired");

    for (const arc of [arcA, arcB, arcC, arcD, arcE, arcF]) await invite(arc.id, VENDOR);
    await submitQuote(arcB.id, VENDOR);
    await submitQuote(arcC.id, VENDOR);

    await db.none(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, awaiting_until)
       VALUES ($1, $2, 'awaiting_acceptance', NOW() + INTERVAL '5 days')`,
      [arcD.id, VENDOR]
    );

    // Active contract: one line, rate 100 × committed 500 = ₹50,000.
    const contract = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status)
       VALUES ($1, $2, 'active') RETURNING *`, [arcE.id, VENDOR]);
    activeContractId = contract.id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 500, 'litre') RETURNING *`, [arcE.id, VARIANT_ID]);
    activeLineId = (await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 100, 5, 500) RETURNING id`, [activeContractId, item.id])).id;

    // ── call-offs via the real release path (3 MRs: 60 / 40 / 20 units) ─
    const { handleMrPostApproval } = await import("../../../app/controllers/mr/mrController.js");
    const releaseQty = async (n, qty) => {
      const mr = await db.one(
        `INSERT INTO tbl_material_requisition
           (mr_number, title, hospitality_company_id, hotel_id, department_id,
            urgency, raised_by, status, submitted_at)
         VALUES ($1, 'Dashboard call-off', $2, $3, $4, 'normal', $5, 'pending_approval', NOW())
         RETURNING *`,
        [`MR-TEST-VD-${n}`, HC, HOTEL, DEPT, BUYER]
      );
      await db.none(
        `INSERT INTO tbl_material_requisition_item
           (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
         VALUES ($1, $2, $3, 'litre', $4, $5, 100)`,
        [mr.id, VARIANT_ID, qty, activeContractId, activeLineId]
      );
      await handleMrPostApproval(90000 + n, BUYER, {
        instance: { id: 90000 + n, entity_type: "MR", entity_id: mr.id, status: "APPROVED" },
      });
      return db.one(`SELECT * FROM tbl_arc_callof_po WHERE mr_id = $1`, [mr.id]);
    };
    const co1 = await releaseQty(1, 60);
    const co2 = await releaseQty(2, 40);
    const co3 = await releaseQty(3, 20);

    // co1 delivered; co3 released long before the current quarter/FY.
    await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'GRN' WHERE id = $1`, [co1.po_id]);
    await db.none(`UPDATE tbl_arc_callof_po SET released_at = NOW() - INTERVAL '400 days' WHERE id = $1`, [co3.id]);

    // ── event-log probes ────────────────────────────────────────────────
    await db.none(
      `INSERT INTO tbl_arc_event_log (arc_id, event_type, actor_id, payload) VALUES
         ($1, 'floated', $2, '{}'::jsonb),
         ($3, 'tech_eval_scored', $2, '{}'::jsonb),
         ($3, 'contract_signed', $2, $4::jsonb)`,
      [arcA.id, BUYER, arcE.id, JSON.stringify({ vendor_id: OTHER_VENDOR })]
    );

    // ── another vendor's world (must never leak into alpha's payload) ──
    const arcG = await seedArc("G", "ARC-TEST-VD-G", "contract_active");
    await invite(arcG.id, OTHER_VENDOR);
    await db.none(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active')`,
      [arcG.id, OTHER_VENDOR]
    );
  });

  afterAll(async () => {
    const ids = Object.values(arcIds);
    await db.none(`DELETE FROM tbl_arc_callof_po WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[]))`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[]))`, [ids]);
    await db.none(`DELETE FROM tbl_material_requisition_item WHERE mr_id IN (SELECT id FROM tbl_material_requisition WHERE mr_number LIKE 'MR-TEST-VD-%')`);
    await db.none(`DELETE FROM tbl_material_requisition WHERE mr_number LIKE 'MR-TEST-VD-%'`);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[]))`, [ids]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[])`, [ids]);
    await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [ids]);
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`, [ids]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [ids]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[])`, [ids]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [ids]);
  });

  test("buyers cannot read the vendor dashboard", async () => {
    const res = await buyerClient.get("/api/v1/arc-v2/vendor/dashboard");
    expect(res.status).toBe(403);
  });

  test("counts bucket every invitation state correctly", async () => {
    const res = await vendorClient.get("/api/v1/arc-v2/vendor/dashboard");
    expect(res.status).toBe(200);
    const { counts } = res.body.data;
    expect(counts.open).toBe(1);
    expect(counts.submitted).toBe(1);
    expect(counts.evaluating).toBe(1);
    expect(counts.awaiting_sign).toBe(1);
    expect(counts.active).toBe(1);
    expect(counts.past).toBe(1);
  });

  test("totals + spend rollups come from real contract lines", async () => {
    const res = await vendorClient.get("/api/v1/arc-v2/vendor/dashboard");
    const d = res.body.data;
    expect(Number(d.totals.awarded_value)).toBe(50_000);          // 100 × 500
    expect(Number(d.totals.consumed_value)).toBe(12_000);         // 60+40+20 × 100
    expect(d.totals.call_off_count).toBe(3);

    expect(d.spend_by_category.length).toBe(1);
    expect(Number(d.spend_by_category[0].value)).toBe(50_000);

    expect(d.spend_by_bu.length).toBe(1);
    expect(d.spend_by_bu[0].hotel_id).toBe(HOTEL);
    expect(Number(d.spend_by_bu[0].value)).toBe(50_000);

    expect(d.top_products.length).toBe(1);
    expect(Number(d.top_products[0].value)).toBe(50_000);
    expect(Number(d.top_products[0].consumed)).toBe(12_000);
  });

  test("next_action prefers the contract awaiting signature", async () => {
    const res = await vendorClient.get("/api/v1/arc-v2/vendor/dashboard");
    const next = res.body.data.next_action;
    expect(next).toBeTruthy();
    expect(next.status).toBe("awaiting_sign");
    expect(next.arc_number).toBe("ARC-TEST-VD-D");
    expect(next.contract_id).toBeTruthy();

    const needs = res.body.data.needs_action;
    expect(needs.length).toBe(4); // awaiting + open + submitted + evaluating
    expect(needs[0].status).toBe("awaiting_sign");
  });

  test("recent call-offs and fulfilment performance reflect PO statuses", async () => {
    const res = await vendorClient.get("/api/v1/arc-v2/vendor/dashboard");
    const d = res.body.data;
    expect(d.recent_call_offs.length).toBe(3);
    // Newest first; the backdated one sorts last.
    const values = d.recent_call_offs.map((p) => Number(p.value));
    expect(values).toContain(6_000);
    expect(values).toContain(4_000);
    expect(values).toContain(2_000);
    expect(d.recent_call_offs[2].variant_name).toBeTruthy();

    expect(d.performance.total_call_offs).toBe(3);
    expect(d.performance.delivered).toBe(1);
    expect(d.performance.delivered_pct).toBe(33);
    expect(d.performance.accepted_pct).toBe(100);
    expect(Number(d.performance.call_off_value)).toBe(12_000);
  });

  test("range=qtd drops call-offs released before the quarter", async () => {
    const res = await vendorClient.get("/api/v1/arc-v2/vendor/dashboard?range=qtd");
    const d = res.body.data;
    expect(d.range).toBe("qtd");
    expect(d.performance.total_call_offs).toBe(2);                // 400-day-old one excluded
    expect(Number(d.performance.call_off_value)).toBe(10_000);    // 60+40 × 100
    expect(d.totals.call_off_count).toBe(2);
    // Contract-line totals stay cumulative — they aren't range-scoped.
    expect(Number(d.totals.awarded_value)).toBe(50_000);
  });

  test("activity is whitelisted and never carries another vendor's events", async () => {
    const res = await vendorClient.get("/api/v1/arc-v2/vendor/dashboard");
    const types = res.body.data.activity.map((e) => e.event_type);
    expect(types).toContain("floated");                 // seeded probe
    expect(types).toContain("call_off_released");       // logged by the release path
    expect(types).not.toContain("tech_eval_scored");    // buyer-internal, excluded
    // The contract_signed probe is tagged with OTHER_VENDOR — filtered out.
    const raw = JSON.stringify(res.body.data.activity);
    expect(raw).not.toContain(String(OTHER_VENDOR));
  });

  test("another vendor's contracts never leak into the payload", async () => {
    const res = await vendorClient.get("/api/v1/arc-v2/vendor/dashboard");
    expect(JSON.stringify(res.body.data)).not.toContain("ARC-TEST-VD-G");
  });

  test("a vendor with no ARC history gets a clean zeroed payload", async () => {
    const fresh = await httpClient(FRESH_VENDOR);
    const res = await fresh.get("/api/v1/arc-v2/vendor/dashboard");
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.counts).toEqual({ open: 0, submitted: 0, evaluating: 0, awaiting_sign: 0, active: 0, past: 0 });
    expect(Number(d.totals.awarded_value)).toBe(0);
    expect(d.next_action).toBeNull();
    expect(d.needs_action).toEqual([]);
    expect(d.spend_by_category).toEqual([]);
    expect(d.recent_call_offs).toEqual([]);
    expect(d.performance.delivered_pct).toBeNull();
    expect(d.performance.accepted_pct).toBeNull();
  });
});
