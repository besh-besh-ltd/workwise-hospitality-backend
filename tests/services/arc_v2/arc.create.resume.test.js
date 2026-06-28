// ARC v2 — TRACK B: draft is fully rehydratable from the detail payload.
//
// Product-level: real Express app + local Postgres. Asserts OBSERVABLE
// end-to-end behaviour over HTTP + DB rows; never internal call counts.
//
// ── What Track B promises ────────────────────────────────────────────────────
// Opening the create wizard at ?c=<id> must hydrate EVERY field/selection from a
// single round-trip. The backing contract is GET /arc-v2/:id (getById), which
// must return everything the wizard needs to repaint all six steps:
//   - arc.type (product|service)                         — Basics step
//   - scalars: title, description, dates, terms, hotel,  — Basics/BU/Terms steps
//     department, eligibility, escalation
//   - items[] with per-item UOM + spec + qty             — Items step
//   - items[].tech_eval = { minimum_passing_score,       — Tech step
//                           clauses:[...] }
//   - invitations[] each carrying vendor_id              — Vendors step
// A field missing from the payload is a REAL Track-B gap (the wizard can't
// rehydrate it) → that assertion FAILS.
//
// Cases (mapped to the Track-B requirement list):
//   B1  getById payload completeness: type + items[].tech_eval (min-pass +
//         clauses) + per-item UOM/spec/qty + invitations[].vendor_id all present.
//   B2  `type` create round-trip: createDraft persists `type`; getById returns it.
//   B3  `type` update round-trip: updateDraft (PATCH) persists a changed `type`.
//   B4  default `type` = 'product' when the create body omits it.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HC        = IDS.hospitality.A;          // 10001
const HOTEL     = IDS.hotels.A1;              // 10101
const DEPT      = IDS.departments.proc;       // 10201
const BUYER     = IDS.users.a1_proc_buyer;    // 80011 — the creator
const OUTSIDER  = IDS.users.companyB_admin;   // 80003 — Company B, no access to hotel A1
const VENDOR_A  = IDS.users.vendor_alpha;     // 80101
const VENDOR_B  = IDS.users.vendor_beta;      // 80102
const CATEGORY  = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;                         // '7 UP PEPSI 1.5 LTR' — seed_reference.sql

const BASE = "/api/v1/arc-v2";
const D = (days) => new Date(Date.now() + days * 86400_000).toISOString();

async function cleanupArc(arcId) {
  // Tech-eval config (clauses cascade from the eval row).
  await db.none(
    `DELETE FROM tbl_arc_item_tech_evaluation
      WHERE arc_item_id IN (SELECT id FROM tbl_arc_item WHERE arc_id = $1)`, [arcId]);
  await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
}

// Seed per-item tech-eval CONFIG (min-pass + clauses) directly, mirroring the
// columns arcEvaluationModel.upsertTechEval + addClause write. This is the
// buyer-authored config the wizard's Tech step must rehydrate on resume.
async function seedTechEval(arcItemId, { minPass, clauses }) {
  const te = await db.one(
    `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score, current_round)
     VALUES ($1, $2, 1) RETURNING id`, [arcItemId, minPass]);
  for (const c of clauses) {
    await db.none(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
       VALUES ($1, $2, $3, $4, $5)`,
      [te.id, c.clause_text, c.weightage, c.clause_type || null, c.is_mandatory === true]);
  }
  return te.id;
}

describe("ARC v2 — Track B: draft resume payload completeness", () => {
  let client;
  const createdArcs = [];

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id IN ($1,$2)`, [VENDOR_A, VENDOR_B]);
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );
    client = await httpClient(BUYER);
  });

  afterAll(async () => {
    for (const arcId of createdArcs) await cleanupArc(arcId);
    await db.none(
      `DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`,
      [CATEGORY, DEPT]
    );
  });

  // ── H1: getById is tenant-scoped (the resume read path must not leak) ───────
  // The detail payload carries commercial + tech-eval config, so a buyer outside
  // the ARC's hotel must NOT be able to read it by id. The creator still can.
  test("H1. getById denies a cross-tenant reader (Company B buyer) but allows the creator", async () => {
    const createRes = await client.post(BASE).send({
      title: "Tenant scope — cross-read denial",
      category_id: CATEGORY,
      hotel_id: HOTEL,
      department_id: DEPT,
      type: "product",
      eligibility_type: "open",
      submission_start_at: D(1),
      submission_end_at:   D(7),
      contract_start_at:   D(14),
      contract_end_at:     D(200),
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(createRes.status).toBe(200);
    const arcId = Number(createRes.body.data.arc.id);
    createdArcs.push(arcId);

    // Outsider = Company B admin (no access to hotel A1 / Company A).
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [OUTSIDER]);
    const outsider = await httpClient(OUTSIDER);
    const denied = await outsider.get(`${BASE}/${arcId}`);
    expect(denied.status).toBe(403);

    // The creator still reads it fine.
    const allowed = await client.get(`${BASE}/${arcId}`);
    expect(allowed.status).toBe(200);
    expect(Number(allowed.body.data.arc.id)).toBe(arcId);
  });

  // ── B1: GET /:id returns everything the wizard needs to rehydrate ───────────
  test("B1. getById returns type + scalars + items[](uom/spec/qty) + items[].tech_eval + invitations[].vendor_id", async () => {
    // Create an invitation-type draft with two items, two invited vendors, and a
    // `type` of 'service' — the full surface the wizard collects.
    const createRes = await client.post(BASE).send({
      title: "Resume completeness — F&B service ARC",
      description: "Internal ref: RC-2026-RESUME-01",
      category_id: CATEGORY,
      hotel_id: HOTEL,
      department_id: DEPT,
      type: "service",
      eligibility_type: "invitation",
      technical_response_required: true,
      sample_required: true,
      submission_start_at: D(1),
      submission_end_at:   D(7),
      contract_start_at:   D(14),
      contract_end_at:     D(200),
      escalation_clause_json: { type: "capped", cap_pct: 5 },
      payment_terms_expected: "Net 45",
      delivery_expected: "Within 3 days",
      penalty_clause: "1% per day late",
      invited_vendor_ids: [VENDOR_A, VENDOR_B],
      items: [
        { product_variant_id: VARIANT_ID, indicative_qty: 500, uom: "litre", spec_text: "Chilled, branded" },
      ],
    });
    expect(createRes.status).toBe(200);
    const arcId = Number(createRes.body.data.arc.id);
    createdArcs.push(arcId);

    // The create endpoint only seeds items passed up-front; the first item exists.
    // Add a SECOND item directly so we can attach tech-eval to a known arc_item id
    // and prove per-item UOM is preserved across items.
    const item2 = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, spec_text, target_price)
       VALUES ($1, $2, 250, 'case', 'Glass bottle', 90) RETURNING id`,
      [arcId, 2]);

    // Attach buyer-authored tech-eval config to BOTH items.
    const items0 = await db.any(`SELECT id, product_variant_id FROM tbl_arc_item WHERE arc_id = $1 ORDER BY id`, [arcId]);
    const item1Id = Number(items0[0].id);
    await seedTechEval(item1Id, {
      minPass: 70,
      clauses: [
        { clause_text: "ISO 22000 certified", weightage: 60, clause_type: "compliance", is_mandatory: true },
        { clause_text: "Cold-chain SOP", weightage: 40, clause_type: "quality", is_mandatory: false },
      ],
    });
    await seedTechEval(Number(item2.id), {
      minPass: 50,
      clauses: [{ clause_text: "FSSAI license", weightage: 100, clause_type: "compliance", is_mandatory: true }],
    });

    // The resume round-trip.
    const res = await client.get(`${BASE}/${arcId}`);
    expect(res.status).toBe(200);
    const { arc, items, invitations } = res.body.data;

    // --- arc.type (Basics step) ---
    expect(arc).toBeTruthy();
    expect(arc.type).toBe("service");

    // --- scalars (Basics / BU / Terms steps) ---
    expect(arc.title).toBe("Resume completeness — F&B service ARC");
    expect(arc.description).toBe("Internal ref: RC-2026-RESUME-01");
    expect(Number(arc.hotel_id)).toBe(HOTEL);
    expect(Number(arc.department_id)).toBe(DEPT);
    expect(Number(arc.category_id)).toBe(CATEGORY);
    expect(arc.eligibility_type).toBe("invitation");
    expect(arc.payment_terms_expected).toBe("Net 45");
    expect(arc.delivery_expected).toBe("Within 3 days");
    expect(arc.penalty_clause).toBe("1% per day late");
    expect(arc.sample_required).toBe(true);
    expect(arc.technical_response_required).toBe(true);
    // dates present (the wizard slices to YYYY-MM-DD on resume)
    for (const k of ["submission_start_at", "submission_end_at", "contract_start_at", "contract_end_at"]) {
      expect(arc[k]).toBeTruthy();
    }
    // escalation round-trips as { type, cap_pct }
    expect(arc.escalation_clause_json).toMatchObject({ type: "capped", cap_pct: 5 });

    // --- items[] with per-item UOM + spec + qty (Items step) ---
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(2);
    const byVariant = Object.fromEntries(items.map((it) => [Number(it.product_variant_id), it]));
    expect(byVariant[VARIANT_ID]).toBeTruthy();
    expect(byVariant[VARIANT_ID].uom).toBe("litre");
    expect(byVariant[VARIANT_ID].spec_text).toBe("Chilled, branded");
    expect(Number(byVariant[VARIANT_ID].indicative_qty)).toBe(500);
    expect(byVariant[2]).toBeTruthy();
    expect(byVariant[2].uom).toBe("case");
    // each item carries a product_variant_id (the FE keys its maps off this)
    for (const it of items) expect(it.product_variant_id != null).toBe(true);

    // --- items[].tech_eval (min-pass + clauses) (Tech step) ---
    const it1 = byVariant[VARIANT_ID];
    expect(it1.tech_eval).toBeTruthy();
    expect(Number(it1.tech_eval.minimum_passing_score)).toBe(70);
    expect(Array.isArray(it1.tech_eval.clauses)).toBe(true);
    expect(it1.tech_eval.clauses.length).toBe(2);
    const clauseTexts = it1.tech_eval.clauses.map((c) => c.clause_text);
    expect(clauseTexts).toContain("ISO 22000 certified");
    expect(clauseTexts).toContain("Cold-chain SOP");
    // every clause exposes the fields the wizard re-paints
    for (const c of it1.tech_eval.clauses) {
      expect(c).toHaveProperty("clause_text");
      expect(c).toHaveProperty("weightage");
      expect(c).toHaveProperty("clause_type");
      expect(c).toHaveProperty("is_mandatory");
    }
    const it2 = byVariant[2];
    expect(it2.tech_eval).toBeTruthy();
    expect(Number(it2.tech_eval.minimum_passing_score)).toBe(50);
    expect(it2.tech_eval.clauses.length).toBe(1);

    // --- invitations[].vendor_id (Vendors step) ---
    expect(Array.isArray(invitations)).toBe(true);
    const invitedVendorIds = invitations.map((i) => Number(i.vendor_id));
    expect(invitedVendorIds).toContain(VENDOR_A);
    expect(invitedVendorIds).toContain(VENDOR_B);
    for (const inv of invitations) expect(inv.vendor_id != null).toBe(true);
  });

  // ── B2: `type` create round-trip ────────────────────────────────────────────
  test("B2. createDraft persists `type` and getById returns it", async () => {
    const createRes = await client.post(BASE).send({
      title: "Type round-trip — create as service",
      category_id: CATEGORY,
      hotel_id: HOTEL,
      department_id: DEPT,
      type: "service",
      eligibility_type: "open",
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(createRes.status).toBe(200);
    const arcId = Number(createRes.body.data.arc.id);
    createdArcs.push(arcId);
    // The create response itself echoes the persisted type.
    expect(createRes.body.data.arc.type).toBe("service");

    const res = await client.get(`${BASE}/${arcId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.arc.type).toBe("service");
  });

  // ── B3: `type` update round-trip ────────────────────────────────────────────
  test("B3. updateDraft persists a changed `type` and getById returns it", async () => {
    const createRes = await client.post(BASE).send({
      title: "Type round-trip — created product, patched to service",
      category_id: CATEGORY,
      hotel_id: HOTEL,
      department_id: DEPT,
      type: "product",
      eligibility_type: "open",
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(createRes.status).toBe(200);
    const arcId = Number(createRes.body.data.arc.id);
    createdArcs.push(arcId);
    expect(createRes.body.data.arc.type).toBe("product");

    const patch = await client.patch(`${BASE}/${arcId}`).send({ type: "service" });
    expect(patch.status).toBe(200);
    expect(patch.body.data.arc.type).toBe("service");

    const res = await client.get(`${BASE}/${arcId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.arc.type).toBe("service");
  });

  // ── B4: default `type` = 'product' when omitted ─────────────────────────────
  test("B4. createDraft defaults `type` to 'product' when the body omits it", async () => {
    const createRes = await client.post(BASE).send({
      title: "Type default — omitted",
      category_id: CATEGORY,
      hotel_id: HOTEL,
      department_id: DEPT,
      eligibility_type: "open",
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(createRes.status).toBe(200);
    const arcId = Number(createRes.body.data.arc.id);
    createdArcs.push(arcId);

    const res = await client.get(`${BASE}/${arcId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.arc.type).toBe("product");
  });
});
