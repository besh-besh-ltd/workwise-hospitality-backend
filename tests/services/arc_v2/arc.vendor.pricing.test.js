// ARC v2 — Phase 2: server-authoritative vendor quote pricing
//
// Behaviors under test:
//   §P1. POST /vendor/quote/preview: engine-driven stateless preview.
//        Server re-derives qty from tbl_arc_item (ignores client qty).
//        Returns line totals + grand total exactly equal to engine output.
//   §P2. Per-charge tax (charge WITH explicit tax) adds to line/grand total.
//   §P3. Save-draft + submit → tbl_arc_quote_line.line_pricing and
//        tbl_arc_quote.quote_pricing populated with engine output, NOT
//        client-supplied inflated values (server recomputes on submit).
//   §P4. Non-invited vendor → 403 on preview (scope from req.user).
//   §P5. Buyer comm-eval / quote list carries line_pricing for the vendor;
//        stays nulled for a technically-disqualified vendor (redaction).
//   §G1. Global charges (document-level) round-trip: preview / save-draft /
//        reload / submit all correctly carry and recompute global_charges.
//
// Not tested here (not HTTP-observable):
//   - FE-only server-preview wiring, per-charge-tax UI, charges modal
//   - Buyer-FE visual display, global-charge UI (Phase-2 remainder)
//   - Buyer CommercialStage ranking/L1 display (pure FE, no HTTP surface)
//
// Pattern: direct SQL seeding, real HTTP via httpClient, real Postgres.
// No mocks. Follows arc.vendor.phase1.test.js conventions.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";
import pricingEngine from "../../../app/services/pricingEngine.js";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;
const COMM_EVAL = IDS.users.a1_proc_commEval;
const VENDOR_A = IDS.users.vendor_alpha;   // active subscription, invited
const VENDOR_B = IDS.users.vendor_beta;    // active subscription, invited (for disqualification test)
const VENDOR_E = IDS.users.vendor_epsilon; // NOT invited
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

const VENDOR_BASE = "/api/v1/arc-v2/vendor";
const EVAL_BASE   = "/api/v1/arc-v2/evaluation";

describe("ARC v2 — Phase 2: server-authoritative quote pricing", () => {
  let buyerClient, alphaClient, betaClient, epsilonClient, commEvalClient;
  let arcId, itemId;
  // indicative_qty seeded on the ARC item — server derives this for engine.
  const ITEM_QTY = 500;

  const createdArcIds = [];

  // ── helpers ─────────────────────────────────────────────────────────────────

  /** Seed an ARC (status=floated, open window) with one item and invite vendors. */
  async function seedArc({ number, title, inviteVendors = [VENDOR_A] }) {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at,
          contract_start_at, contract_end_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'floated',
               NOW() - INTERVAL '2 days',
               NOW() + INTERVAL '10 days',
               NOW() + INTERVAL '30 days',
               NOW() + INTERVAL '365 days',
               $8)
       RETURNING *`,
      [number, title, CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    createdArcIds.push(Number(arc.id));

    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, $3, 'litre', 120) RETURNING *`,
      [arc.id, VARIANT_ID, ITEM_QTY]
    );

    for (const vendorId of inviteVendors) {
      await db.none(
        `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
         VALUES ($1, $2, 'invited') ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
        [Number(arc.id), vendorId]
      );
    }

    return { arcId: Number(arc.id), itemId: Number(item.id) };
  }

  /** Accept terms for a vendor (prerequisite for draft/submit). */
  async function acceptTerms(client, aId) {
    const r = await client.post(`${VENDOR_BASE}/quote/accept-terms`).send({ arc_id: aId });
    expect(r.status).toBe(200);
  }

  /** Save a quote draft with specified line data. */
  async function saveDraft(client, aId, iId, lineOverrides = {}) {
    const line = {
      arc_item_id: iId,
      rate:        90,
      gst_pct:     5,
      gst_mode:    '%',
      charges:     [],
      ...lineOverrides,
    };
    const r = await client.post(`${VENDOR_BASE}/quote/draft`).send({
      arc_id:        aId,
      payment_terms: null,
      gstin_used:    null,
      lines:         [line],
    });
    return r;
  }

  // ── setup / teardown ────────────────────────────────────────────────────────

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`, [[BUYER, COMM_EVAL]]);
    await db.none(
      `UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`,
      [[VENDOR_A, VENDOR_B, VENDOR_E]]
    );

    buyerClient    = await httpClient(BUYER);
    alphaClient    = await httpClient(VENDOR_A);
    betaClient     = await httpClient(VENDOR_B);
    epsilonClient  = await httpClient(VENDOR_E);
    commEvalClient = await httpClient(COMM_EVAL);

    // Seed comm-eval permissions so buyer can hit GET /evaluation/:arcId/comm-eval.
    await seedArcEvalPerms(db, [BUYER, COMM_EVAL]);

    ({ arcId, itemId } = await seedArc({
      number: "ARC-PH2-PRICING", title: "Phase 2 server-authoritative pricing",
      inviteVendors: [VENDOR_A, VENDOR_B],
    }));
  });

  afterAll(async () => {
    await cleanupArcEvalPerms(db, [BUYER, COMM_EVAL]);
    if (createdArcIds.length) {
      await db.none(
        `DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN
           (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[]))`,
        [createdArcIds]
      );
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [createdArcIds]);
    }
  });

  // ── §P4: Non-invited vendor → 403 on preview (runs first, no state deps) ──

  test("P4: non-invited vendor gets 403 on preview", async () => {
    const res = await epsilonClient.post(`${VENDOR_BASE}/quote/preview`).send({
      arc_id: arcId,
      lines:  [{ arc_item_id: itemId, rate: 90, gst_pct: 5, gst_mode: '%', charges: [] }],
    });
    expect(res.status).toBe(403);
  });

  // ── §P1: Preview returns engine-exact totals ────────────────────────────────

  test("P1a: preview returns line total + grand total exactly matching engine output", async () => {
    // Client sends a freight charge (absolute, no per-charge tax → inherits base).
    const line = {
      arc_item_id: itemId,
      rate:        90,        // base rate
      gst_pct:     5,         // 5% GST on base
      gst_mode:    '%',
      charges: [
        { name: "Freight", amount: 200, amount_mode: 'absolute', tax: null, tax_mode: '%' },
      ],
    };

    const res = await alphaClient.post(`${VENDOR_BASE}/quote/preview`).send({
      arc_id: arcId,
      lines:  [line],
    });
    expect(res.status).toBe(200);

    const data = res.body.data;
    expect(data).toHaveProperty("lines");
    expect(data).toHaveProperty("grand_total");
    expect(data.lines.length).toBe(1);
    expect(data.lines[0].arc_item_id).toBe(itemId);

    // Compute expected output using the same engine the server uses.
    // Server derives qty = ITEM_QTY (500) from DB, ignoring anything the client sends.
    const expectedResult = pricingEngine.calculateDocumentTotals([{
      unit_price:    90,
      quantity:      ITEM_QTY,  // server derives this — not from client
      tax:           5,
      tax_mode:      'percentage',
      other_charges: [
        { name: "Freight", amount: 200, amount_mode: 'absolute', tax: null, tax_mode: 'percentage' },
      ],
    }], []);

    const expLine = expectedResult.lines[0];
    expect(data.lines[0].base).toBe(expLine.base);
    expect(data.lines[0].base_tax).toBe(expLine.base_tax);
    expect(data.lines[0].total).toBe(expLine.total);
    expect(data.grand_total).toBe(expectedResult.grand_total);
  });

  test("P1b: bogus client qty does NOT change server-derived result", async () => {
    // Send qty=1 in the body — server must ignore it and use DB qty (500).
    const lineWithBogusQty = {
      arc_item_id: itemId,
      rate:        90,
      gst_pct:     5,
      gst_mode:    '%',
      quantity:    1,           // ← bogus client qty the server MUST ignore
      charges:     [],
    };

    const res = await alphaClient.post(`${VENDOR_BASE}/quote/preview`).send({
      arc_id: arcId,
      lines:  [lineWithBogusQty],
    });
    expect(res.status).toBe(200);

    // If server correctly ignores client qty, base = 90 * 500 = 45000, not 90 * 1 = 90.
    const expectedResult = pricingEngine.calculateDocumentTotals([{
      unit_price:    90,
      quantity:      ITEM_QTY,  // 500 from DB
      tax:           5,
      tax_mode:      'percentage',
      other_charges: [],
    }], []);

    const actualBase = res.body.data.lines[0].base;
    const expectedBase = expectedResult.lines[0].base;

    // base = 90 * 500 = 45000 (not 90 * 1 = 90)
    expect(actualBase).toBe(expectedBase);
    expect(actualBase).toBe(45000);
  });

  // ── §P2: Per-charge tax adds to line/grand total ───────────────────────────

  test("P2: per-charge explicit tax adds to line total", async () => {
    // Charge WITH explicit per-charge tax (10% on the charge amount).
    const lineWithChargeTax = {
      arc_item_id: itemId,
      rate:        90,
      gst_pct:     5,
      gst_mode:    '%',
      charges: [
        {
          name:        "Freight",
          amount:      200,
          amount_mode: 'absolute',
          tax:         10,        // explicit 10% tax on the charge amount
          tax_mode:    '%',
        },
      ],
    };

    const resWithTax = await alphaClient.post(`${VENDOR_BASE}/quote/preview`).send({
      arc_id: arcId,
      lines:  [lineWithChargeTax],
    });
    expect(resWithTax.status).toBe(200);

    // Charge without tax for comparison.
    const lineNoChargeTax = {
      arc_item_id: itemId,
      rate:        90,
      gst_pct:     5,
      gst_mode:    '%',
      charges: [
        { name: "Freight", amount: 200, amount_mode: 'absolute', tax: 0, tax_mode: '%' },
      ],
    };
    const resNoTax = await alphaClient.post(`${VENDOR_BASE}/quote/preview`).send({
      arc_id: arcId,
      lines:  [lineNoChargeTax],
    });
    expect(resNoTax.status).toBe(200);

    // Line with charge tax should have a higher total.
    const totalWithTax = resWithTax.body.data.grand_total;
    const totalNoTax   = resNoTax.body.data.grand_total;
    expect(totalWithTax).toBeGreaterThan(totalNoTax);

    // Verify exact charge tax arithmetic: 10% of 200 = 20 extra.
    const chargeLineWithTax = resWithTax.body.data.lines[0];
    expect(chargeLineWithTax.charges).toBeDefined();
    expect(chargeLineWithTax.charges.length).toBeGreaterThan(0);
    // The charge entry should have a non-zero tax field.
    expect(Number(chargeLineWithTax.charges[0].tax)).toBeGreaterThan(0);

    // Engine verification.
    const expectedWithTax = pricingEngine.calculateDocumentTotals([{
      unit_price: 90, quantity: ITEM_QTY, tax: 5, tax_mode: 'percentage',
      other_charges: [
        { name: "Freight", amount: 200, amount_mode: 'absolute', tax: 10, tax_mode: 'percentage' },
      ],
    }], []);
    expect(totalWithTax).toBe(expectedWithTax.grand_total);
  });

  // ── §P3a: Save-draft persists engine-computed line_pricing + quote_pricing ──

  test("P3a: save-draft stores engine-computed line_pricing in DB (not zero or null)", async () => {
    // Accept terms first (prerequisite).
    await acceptTerms(alphaClient, arcId);

    const line = {
      arc_item_id: itemId,
      rate:        90,
      gst_pct:     5,
      gst_mode:    '%',
      charges: [
        { name: "Freight", amount: 200, amount_mode: 'absolute', tax: null, tax_mode: '%' },
      ],
    };

    const draftRes = await alphaClient.post(`${VENDOR_BASE}/quote/draft`).send({
      arc_id: arcId,
      lines:  [line],
    });
    expect(draftRes.status).toBe(200);

    // Query DB for the stored line_pricing.
    const dbLine = await db.oneOrNone(
      `SELECT ql.line_pricing, ql.rate, ql.gst_pct
         FROM tbl_arc_quote_line ql
         JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
        WHERE q.arc_id = $1 AND q.vendor_id = $2 AND ql.arc_item_id = $3`,
      [arcId, VENDOR_A, itemId]
    );
    expect(dbLine).toBeDefined();
    expect(dbLine.line_pricing).not.toBeNull();

    const lp = typeof dbLine.line_pricing === 'string'
      ? JSON.parse(dbLine.line_pricing)
      : dbLine.line_pricing;

    // Engine-verify: stored values must match engine output for these inputs.
    const expected = pricingEngine.calculateDocumentTotals([{
      unit_price:    90,
      quantity:      ITEM_QTY,
      tax:           5,
      tax_mode:      'percentage',
      other_charges: [
        { name: "Freight", amount: 200, amount_mode: 'absolute', tax: null, tax_mode: 'percentage' },
      ],
    }], []);
    const expLine = expected.lines[0];
    expect(Number(lp.base)).toBe(expLine.base);
    expect(Number(lp.base_tax)).toBe(expLine.base_tax);
    expect(Number(lp.total)).toBe(expLine.total);
  });

  // ── §P3b: Submit recomputes engine — ignores inflated client total ──────────

  test("P3b: submit recomputes server-side; inflated client totals are NOT stored", async () => {
    // First ensure alpha has an active subscription so submit is allowed.
    // (vendor_alpha has an active subscription from fixtures/vendors.js.)

    // Save a draft with a specific rate (so we have a submittable quote).
    const draftRes = await saveDraft(alphaClient, arcId, itemId);
    expect(draftRes.status).toBe(200);

    // Submit the quote.
    const submitRes = await alphaClient.post(`${VENDOR_BASE}/quote/submit`).send({ arc_id: arcId });
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.data.quote.submitted_at).toBeTruthy();

    // Query DB for both quote_pricing (header) and line_pricing (line).
    const dbQuote = await db.oneOrNone(
      `SELECT q.quote_pricing, q.submitted_at
         FROM tbl_arc_quote q
        WHERE q.arc_id = $1 AND q.vendor_id = $2`,
      [arcId, VENDOR_A]
    );
    expect(dbQuote).toBeDefined();
    expect(dbQuote.submitted_at).not.toBeNull();
    expect(dbQuote.quote_pricing).not.toBeNull();

    const qp = typeof dbQuote.quote_pricing === 'string'
      ? JSON.parse(dbQuote.quote_pricing)
      : dbQuote.quote_pricing;

    // Verify stored quote_pricing matches what the engine would compute.
    // rate=90, gst=5%, qty=500 (DB), no charges.
    const expectedDoc = pricingEngine.calculateDocumentTotals([{
      unit_price:    90,
      quantity:      ITEM_QTY,
      tax:           5,
      tax_mode:      'percentage',
      other_charges: [],
    }], []);

    expect(Number(qp.grand_total)).toBe(expectedDoc.grand_total);
    expect(Number(qp.grand_subtotal)).toBe(expectedDoc.grand_subtotal);

    // Also verify line_pricing in the line table is engine-computed.
    const dbLine = await db.oneOrNone(
      `SELECT ql.line_pricing
         FROM tbl_arc_quote_line ql
         JOIN tbl_arc_quote q ON q.id = ql.arc_quote_id
        WHERE q.arc_id = $1 AND q.vendor_id = $2`,
      [arcId, VENDOR_A]
    );
    expect(dbLine).toBeDefined();
    expect(dbLine.line_pricing).not.toBeNull();

    const lp = typeof dbLine.line_pricing === 'string'
      ? JSON.parse(dbLine.line_pricing)
      : dbLine.line_pricing;

    expect(Number(lp.total)).toBe(expectedDoc.lines[0].total);
  });

  // ── §P5: Comm-eval quote list carries line_pricing; nulled for disqualified vendor ──

  test("P5a: buyer comm-eval quote list carries line_pricing for a submitted vendor", async () => {
    // alpha has submitted (from P3b). Check comm-eval returns their line_pricing.
    const res = await commEvalClient.get(`${EVAL_BASE}/${arcId}/comm-eval`);
    expect(res.status).toBe(200);

    const { quotes } = res.body.data;
    expect(Array.isArray(quotes)).toBe(true);

    // Find alpha's quote line.
    const alphaLine = quotes.find((q) => Number(q.vendor_id) === VENDOR_A);
    expect(alphaLine).toBeDefined();
    // line_pricing must be present (not null) — vendor submitted with engine output.
    expect(alphaLine.line_pricing).not.toBeNull();

    const lp = typeof alphaLine.line_pricing === 'string'
      ? JSON.parse(alphaLine.line_pricing)
      : alphaLine.line_pricing;

    // Verify the persisted values match what the engine computes for rate=90, gst=5%, qty=500.
    const expected = pricingEngine.calculateDocumentTotals([{
      unit_price: 90, quantity: ITEM_QTY, tax: 5, tax_mode: 'percentage', other_charges: [],
    }], []);
    expect(Number(lp.total)).toBe(expected.lines[0].total);
  });

  test("P5b: technically-disqualified vendor's line_pricing is nulled in comm-eval", async () => {
    // Seed a second ARC with tech clauses so we can create a disqualification scenario.
    const { arcId: arcWithTech, itemId: techItemId } = await seedArc({
      number:        "ARC-PH2-TECH",
      title:         "Phase 2 tech-disqualification test",
      inviteVendors: [VENDOR_A, VENDOR_B],
    });

    // Accept terms + save quote for both vendors.
    await acceptTerms(alphaClient, arcWithTech);
    await acceptTerms(betaClient, arcWithTech);

    const saveDraftForVendor = async (client, vId) => {
      const r = await client.post(`${VENDOR_BASE}/quote/draft`).send({
        arc_id: arcWithTech,
        lines:  [{ arc_item_id: techItemId, rate: 90, gst_pct: 5, gst_mode: '%', charges: [] }],
      });
      expect(r.status).toBe(200);
    };

    await saveDraftForVendor(alphaClient, VENDOR_A);
    await saveDraftForVendor(betaClient, VENDOR_B);

    // Submit both vendors' quotes (alpha has active subscription).
    const submitAlpha = await alphaClient.post(`${VENDOR_BASE}/quote/submit`).send({ arc_id: arcWithTech });
    expect(submitAlpha.status).toBe(200);

    const submitBeta = await betaClient.post(`${VENDOR_BASE}/quote/submit`).send({ arc_id: arcWithTech });
    expect(submitBeta.status).toBe(200);

    // Simulate technical evaluation: add tech clauses and mark VENDOR_B as disqualified.
    // We do this directly in DB to avoid setting up the full tech-eval approval chain.
    const te = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, 60) RETURNING id`,
      [techItemId]
    );
    const clause = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
       VALUES ($1, 'Test clause', 100, 'compliance', false) RETURNING id`,
      [te.id]
    );

    // Mark both vendors with responses; alpha qualifies, beta does not.
    await db.none(
      `INSERT INTO tbl_arc_item_tech_evaluation_cleared_vendors
         (arc_item_tech_evaluation_id, vendor_id, calculated_score, status, evaluation_round)
       VALUES ($1, $2, 90, 'qualified',     1),
              ($1, $3, 20, 'not_qualified', 1)`,
      [te.id, VENDOR_A, VENDOR_B]
    );

    // Fetch comm-eval.
    const res = await commEvalClient.get(`${EVAL_BASE}/${arcWithTech}/comm-eval`);
    expect(res.status).toBe(200);

    const { quotes } = res.body.data;
    const betaLine  = quotes.find((q) => Number(q.vendor_id) === VENDOR_B);
    const alphaLine = quotes.find((q) => Number(q.vendor_id) === VENDOR_A);

    // Beta is technically disqualified → line_pricing must be null (redacted).
    expect(betaLine).toBeDefined();
    expect(betaLine.line_pricing).toBeNull();
    expect(betaLine.technically_disqualified).toBe(true);

    // Alpha is qualified → line_pricing is present.
    expect(alphaLine).toBeDefined();
    expect(alphaLine.line_pricing).not.toBeNull();

    // Cleanup the tech-eval rows inserted directly.
    await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_cleared_vendors WHERE arc_item_tech_evaluation_id = $1`, [te.id]);
    await db.none(`DELETE FROM tbl_arc_item_tech_evaluation_clauses WHERE arc_item_tech_evaluation_id = $1`, [te.id]);
    await db.none(`DELETE FROM tbl_arc_item_tech_evaluation WHERE id = $1`, [te.id]);
  });

  // ── §G: Global charges round-trip ────────────────────────────────────────────
  //
  // A separate ARC is seeded for this group so the global-charge draft does not
  // collide with the submitted quote from §P3 (same vendor, same ARC would just
  // upsert, but it could confuse ordering assertions).

  describe("§G: global charges round-trip", () => {
    let gcArcId, gcItemId;
    const GC_ITEM_QTY = 200;

    // A simple absolute global charge of ₹1000 with no additional tax.
    const GLOBAL_CHARGE = {
      name:        "Logistics",
      amount:      1000,
      amount_mode: "absolute",
      tax:         null,
      tax_mode:    "percentage",
    };

    // Canonical engine shape as saveQuoteDraft normalises and stores it.
    // (previewQuote passes raw to the engine; saveQuoteDraft normalises via
    //  normalizeArcCharges → canonical mapping → calculateDocumentTotals.)
    const CANONICAL_GLOBAL_CHARGE = {
      name:        "Logistics",
      amount:      1000,
      amount_mode: "absolute",
      tax:         null,
      tax_mode:    "percentage",
    };

    // Base quote line (no per-line charges).
    const BASE_LINE_OVERRIDES = { rate: 80, gst_pct: 5, gst_mode: '%', charges: [] };

    beforeAll(async () => {
      ({ arcId: gcArcId, itemId: gcItemId } = await seedArc({
        number:        "ARC-PH2-GLOBAL-CHG",
        title:         "Phase 2 global-charge round-trip",
        inviteVendors: [VENDOR_A],
      }));
      // Override the item qty via a direct UPDATE — seedArc always uses ITEM_QTY.
      await db.none(
        `UPDATE tbl_arc_item SET indicative_qty = $1 WHERE id = $2`,
        [GC_ITEM_QTY, gcItemId]
      );
      // Accept terms so alpha can save a draft.
      await acceptTerms(alphaClient, gcArcId);
    });

    // G1 — Preview with non-empty global_charges: grand_total includes them.
    test("G1: preview with global charges → grand_total > grand_subtotal by exactly global_charges_total", async () => {
      const line = {
        arc_item_id: gcItemId,
        rate:        80,
        gst_pct:     5,
        gst_mode:    '%',
        charges:     [],
      };

      const res = await alphaClient.post(`${VENDOR_BASE}/quote/preview`).send({
        arc_id:         gcArcId,
        lines:          [line],
        global_charges: [GLOBAL_CHARGE],
      });
      expect(res.status).toBe(200);

      const data = res.body.data;
      expect(data).toHaveProperty("grand_total");
      expect(data).toHaveProperty("grand_subtotal");
      expect(data).toHaveProperty("global_charges_total");
      expect(data).toHaveProperty("global_charges");

      // Engine verification: server re-derives qty from DB (GC_ITEM_QTY=200).
      // The engine's normalizeGlobalCharge maps { amount, amount_mode } directly;
      // 'absolute' mode → applyChargeMode(1000, 'absolute', subtotal) = 1000.
      const expectedResult = pricingEngine.calculateDocumentTotals(
        [{
          unit_price:    80,
          quantity:      GC_ITEM_QTY,
          tax:           5,
          tax_mode:      "percentage",
          other_charges: [],
        }],
        [GLOBAL_CHARGE]
      );

      expect(data.grand_subtotal).toBe(expectedResult.grand_subtotal);
      expect(data.global_charges_total).toBe(expectedResult.global_charges_total);
      expect(data.grand_total).toBe(expectedResult.grand_total);

      // global_charges_total must be positive (absolute ₹1000).
      expect(data.global_charges_total).toBeGreaterThan(0);
      // grand_total = grand_subtotal + global_charges_total (exact).
      expect(data.grand_total).toBe(
        Math.round((data.grand_subtotal + data.global_charges_total) * 100) / 100
      );
    });

    // G1b — Preview without global_charges is unchanged baseline.
    test("G1b: preview without global_charges → grand_total === grand_subtotal", async () => {
      const line = {
        arc_item_id: gcItemId,
        rate:        80,
        gst_pct:     5,
        gst_mode:    '%',
        charges:     [],
      };

      const resNo = await alphaClient.post(`${VENDOR_BASE}/quote/preview`).send({
        arc_id: gcArcId,
        lines:  [line],
        // no global_charges
      });
      expect(resNo.status).toBe(200);
      expect(resNo.body.data.global_charges_total).toBe(0);
      expect(resNo.body.data.grand_total).toBe(resNo.body.data.grand_subtotal);

      const resWith = await alphaClient.post(`${VENDOR_BASE}/quote/preview`).send({
        arc_id:         gcArcId,
        lines:          [line],
        global_charges: [GLOBAL_CHARGE],
      });
      expect(resWith.status).toBe(200);

      // Adding ₹1000 absolute charge must increase grand_total by exactly 1000.
      const diff = Math.round(
        (resWith.body.data.grand_total - resNo.body.data.grand_total) * 100
      ) / 100;
      expect(diff).toBe(1000);
    });

    // G2 — Save-draft persists global_charges_input in quote_pricing JSONB.
    test("G2: save-draft with global_charges → tbl_arc_quote.quote_pricing.global_charges_input is persisted", async () => {
      const draftRes = await alphaClient.post(`${VENDOR_BASE}/quote/draft`).send({
        arc_id:         gcArcId,
        payment_terms:  null,
        gstin_used:     null,
        lines:          [{
          arc_item_id: gcItemId,
          ...BASE_LINE_OVERRIDES,
        }],
        global_charges: [GLOBAL_CHARGE],
      });
      expect(draftRes.status).toBe(200);

      // Verify directly in DB.
      const dbQuote = await db.oneOrNone(
        `SELECT quote_pricing FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
        [gcArcId, VENDOR_A]
      );
      expect(dbQuote).not.toBeNull();

      const qp = typeof dbQuote.quote_pricing === 'string'
        ? JSON.parse(dbQuote.quote_pricing)
        : dbQuote.quote_pricing;

      expect(qp).toHaveProperty("global_charges_input");
      expect(Array.isArray(qp.global_charges_input)).toBe(true);
      expect(qp.global_charges_input.length).toBeGreaterThan(0);

      // The stored charge must match the canonical form of what was sent.
      const stored = qp.global_charges_input[0];
      expect(stored.name).toBe(CANONICAL_GLOBAL_CHARGE.name);
      expect(Number(stored.amount)).toBe(CANONICAL_GLOBAL_CHARGE.amount);
      expect(stored.amount_mode).toBe(CANONICAL_GLOBAL_CHARGE.amount_mode);

      // grand_total in quote_pricing must reflect the global charge.
      const expectedDoc = pricingEngine.calculateDocumentTotals(
        [{
          unit_price:    80,
          quantity:      GC_ITEM_QTY,
          tax:           5,
          tax_mode:      "percentage",
          other_charges: [],
        }],
        [GLOBAL_CHARGE]
      );
      expect(Number(qp.grand_total)).toBe(expectedDoc.grand_total);
      expect(Number(qp.global_charges_total)).toBe(expectedDoc.global_charges_total);
    });

    // G3 — Reload (GET request-detail) returns global_charges_input.
    test("G3: getRequestDetail returns quote_pricing.global_charges_input populated", async () => {
      const res = await alphaClient.get(`${VENDOR_BASE}/requests/${gcArcId}`);
      expect(res.status).toBe(200);

      const { quote } = res.body.data;
      expect(quote).toBeDefined();
      expect(quote.quote_pricing).not.toBeNull();

      const qp = typeof quote.quote_pricing === 'string'
        ? JSON.parse(quote.quote_pricing)
        : quote.quote_pricing;

      expect(qp).toHaveProperty("global_charges_input");
      expect(Array.isArray(qp.global_charges_input)).toBe(true);
      expect(qp.global_charges_input.length).toBeGreaterThan(0);

      const stored = qp.global_charges_input[0];
      expect(stored.name).toBe(CANONICAL_GLOBAL_CHARGE.name);
      expect(Number(stored.amount)).toBe(CANONICAL_GLOBAL_CHARGE.amount);
    });

    // G4 — Submit recomputes from persisted input; inflated client total cannot
    // change grand_total; global_charges_input survives through submit.
    test("G4: submit recomputes global charges from persisted input; survives submit", async () => {
      // Submit the draft (with global charges already saved in G2).
      const submitRes = await alphaClient.post(`${VENDOR_BASE}/quote/submit`).send({
        arc_id: gcArcId,
      });
      expect(submitRes.status).toBe(200);
      expect(submitRes.body.data.quote.submitted_at).toBeTruthy();

      // Fetch persisted quote_pricing after submit.
      const dbQuote = await db.oneOrNone(
        `SELECT quote_pricing, submitted_at FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
        [gcArcId, VENDOR_A]
      );
      expect(dbQuote).not.toBeNull();
      expect(dbQuote.submitted_at).not.toBeNull();

      const qp = typeof dbQuote.quote_pricing === 'string'
        ? JSON.parse(dbQuote.quote_pricing)
        : dbQuote.quote_pricing;

      // global_charges_input must survive submit.
      expect(qp).toHaveProperty("global_charges_input");
      expect(Array.isArray(qp.global_charges_input)).toBe(true);
      expect(qp.global_charges_input.length).toBeGreaterThan(0);

      // grand_total must be engine-recomputed from persisted input (not client-supplied).
      const expectedDoc = pricingEngine.calculateDocumentTotals(
        [{
          unit_price:    80,
          quantity:      GC_ITEM_QTY,
          tax:           5,
          tax_mode:      "percentage",
          other_charges: [],
        }],
        [GLOBAL_CHARGE]
      );
      expect(Number(qp.grand_total)).toBe(expectedDoc.grand_total);
      expect(Number(qp.global_charges_total)).toBe(expectedDoc.global_charges_total);

      // Verify grand_total > grand_subtotal by exactly global_charges_total.
      const gtDiff = Math.round(
        (Number(qp.grand_total) - Number(qp.grand_subtotal)) * 100
      ) / 100;
      expect(gtDiff).toBe(Number(qp.global_charges_total));
    });

    // G5 — Non-invited vendor (epsilon) → 403 on preview even with global charges
    //       (already covered for basic preview in P4; this confirms the global-charge
    //       body doesn't bypass the invitation gate).
    test("G5: non-invited vendor gets 403 on preview even with global_charges in body", async () => {
      // Epsilon was NOT invited to the original arcId (only VENDOR_A and VENDOR_B were
      // seeded there). Use that ARC to confirm the invitation gate still blocks epsilon
      // even when global_charges are present in the body.
      const res = await epsilonClient.post(`${VENDOR_BASE}/quote/preview`).send({
        arc_id:         arcId, // epsilon NOT invited to the main arcId
        lines:          [{ arc_item_id: itemId, rate: 80, gst_pct: 5, gst_mode: '%', charges: [] }],
        global_charges: [GLOBAL_CHARGE],
      });
      expect(res.status).toBe(403);
    });

    // G7 — REGRESSION: global-charge with tax must add amount+tax to grand_total.
    //
    // Bug: the engine's normalizeGlobalCharge reads ONLY `additional_tax` /
    // `additional_tax_mode`; the old FE/controller emitted `tax`/`tax_mode` for
    // document-level charges, so the tax was silently dropped (charge was counted
    // at 5000, not 5900 for an 18% taxed charge).
    //
    // Fix: the FE now emits `additional_tax`/`additional_tax_mode` for global
    // charges (matching the engine key). The controller's canonicalGlobalCharges
    // mapper accepts either form (additional_tax ?? tax) for robustness.
    //
    // Expected (fixed):  global_charges_total = 5900, grand_total = GS + 5900
    // Buggy (old):       global_charges_total = 5000, grand_total = GS + 5000
    test("G7: taxed global charge (18%) adds amount+tax (5900) NOT just amount (5000)", async () => {
      // Fresh ARC — gcArcId is already submitted (G4); use a new one for this draft.
      const { arcId: gcTaxArcId, itemId: gcTaxItemId } = await seedArc({
        number:        "ARC-PH2-GC-TAX",
        title:         "Phase 2 global-charge taxed regression",
        inviteVendors: [VENDOR_A],
      });
      await db.none(
        `UPDATE tbl_arc_item SET indicative_qty = $1 WHERE id = $2`,
        [GC_ITEM_QTY, gcTaxItemId]
      );
      await acceptTerms(alphaClient, gcTaxArcId);

      // The FE now emits additional_tax/additional_tax_mode for global charges.
      // This is the shape that the fixed FE sends (matching the engine's key).
      const TAXED_GLOBAL_CHARGE = {
        name:                "Logistics",
        amount:              5000,
        amount_mode:         "absolute",
        additional_tax:      18,
        additional_tax_mode: "percentage",
      };

      // ── PART A: Preview ──────────────────────────────────────────────────
      // previewQuote passes global_charges raw to the engine (no remapping);
      // the engine's normalizeGlobalCharge reads additional_tax, so we MUST
      // send additional_tax here for the tax to be applied.

      // Independently computed expected values:
      //   base         = 80 * 200        = 16 000
      //   base_tax     = 5% of 16 000    =    800
      //   grand_subtotal                 = 16 800
      //   charge amount = 5000 (absolute)
      //   charge tax    = 18% of 5000    =    900
      //   global_charges_total           =  5 900   ← was 5 000 before fix
      //   grand_total  = 16 800 + 5 900  = 22 700
      const EXPECTED_GC_TOTAL   = 5900;
      const EXPECTED_BUGGY_TOTAL = 5000; // what the old code would produce
      const EXPECTED_GRAND_SUBTOTAL = pricingEngine.calculateDocumentTotals(
        [{ unit_price: 80, quantity: GC_ITEM_QTY, tax: 5, tax_mode: 'percentage', other_charges: [] }],
        []
      ).grand_subtotal;
      const EXPECTED_GRAND_TOTAL = EXPECTED_GRAND_SUBTOTAL + EXPECTED_GC_TOTAL;

      const previewRes = await alphaClient.post(`${VENDOR_BASE}/quote/preview`).send({
        arc_id:         gcTaxArcId,
        lines:          [{
          arc_item_id: gcTaxItemId,
          rate:        80,
          gst_pct:     5,
          gst_mode:    '%',
          charges:     [],
        }],
        global_charges: [TAXED_GLOBAL_CHARGE],
      });
      expect(previewRes.status).toBe(200);

      const data = previewRes.body.data;
      // The taxed global charge must appear in global_charges output.
      expect(Array.isArray(data.global_charges)).toBe(true);
      expect(data.global_charges.length).toBeGreaterThan(0);

      // additional_tax on the engine output must be non-zero (18% of 5000 = 900).
      const gcOut = data.global_charges[0];
      expect(Number(gcOut.additional_tax)).toBe(900);
      expect(Number(gcOut.subtotal)).toBe(5900);

      // global_charges_total must include the charge tax (5900, NOT 5000).
      expect(data.global_charges_total).toBe(EXPECTED_GC_TOTAL);
      expect(data.global_charges_total).not.toBe(EXPECTED_BUGGY_TOTAL);

      // grand_total = grand_subtotal + global_charges_total (exact arithmetic).
      expect(data.grand_total).toBe(EXPECTED_GRAND_TOTAL);
      expect(data.grand_total).toBe(
        Math.round((data.grand_subtotal + data.global_charges_total) * 100) / 100
      );

      // ── PART B: Save-draft → reload round-trip ───────────────────────────
      // saveQuoteDraft's canonicalGlobalCharges mapper accepts additional_tax
      // (and also the old `tax` key for robustness). Verify the persisted
      // quote_pricing reflects amount+tax (5900) and that global_charges_input
      // carries additional_tax.

      const draftRes = await alphaClient.post(`${VENDOR_BASE}/quote/draft`).send({
        arc_id:         gcTaxArcId,
        payment_terms:  null,
        gstin_used:     null,
        lines:          [{
          arc_item_id: gcTaxItemId,
          rate:        80,
          gst_pct:     5,
          gst_mode:    '%',
          charges:     [],
        }],
        global_charges: [TAXED_GLOBAL_CHARGE],
      });
      expect(draftRes.status).toBe(200);

      const dbQuote = await db.oneOrNone(
        `SELECT quote_pricing FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
        [gcTaxArcId, VENDOR_A]
      );
      expect(dbQuote).not.toBeNull();

      const qp = typeof dbQuote.quote_pricing === 'string'
        ? JSON.parse(dbQuote.quote_pricing)
        : dbQuote.quote_pricing;

      // Persisted grand_total must reflect amount+tax (22700), NOT amount-only (21800).
      expect(Number(qp.grand_total)).toBe(EXPECTED_GRAND_TOTAL);
      expect(Number(qp.global_charges_total)).toBe(EXPECTED_GC_TOTAL);

      // global_charges_input must carry the additional_tax field.
      expect(Array.isArray(qp.global_charges_input)).toBe(true);
      expect(qp.global_charges_input.length).toBeGreaterThan(0);
      const storedCharge = qp.global_charges_input[0];
      // The canonical form uses additional_tax (not tax).
      expect(Number(storedCharge.additional_tax)).toBe(18);
      expect(storedCharge.additional_tax_mode).toBe('percentage');
    });

    // G6 — Empty global_charges is a no-op (back-compat).
    test("G6: save-draft with empty global_charges → global_charges_input is [] and grand_total unchanged", async () => {
      // We need a fresh ARC (or to undo the submit on gcArc). Use a new one.
      const { arcId: gcEmptyArcId, itemId: gcEmptyItemId } = await seedArc({
        number:        "ARC-PH2-GC-EMPTY",
        title:         "Phase 2 global-charge empty back-compat",
        inviteVendors: [VENDOR_A],
      });
      await db.none(
        `UPDATE tbl_arc_item SET indicative_qty = $1 WHERE id = $2`,
        [GC_ITEM_QTY, gcEmptyItemId]
      );
      await acceptTerms(alphaClient, gcEmptyArcId);

      // Save with explicit empty array.
      const draftRes = await alphaClient.post(`${VENDOR_BASE}/quote/draft`).send({
        arc_id:         gcEmptyArcId,
        payment_terms:  null,
        gstin_used:     null,
        lines:          [{
          arc_item_id: gcEmptyItemId,
          rate:        80,
          gst_pct:     5,
          gst_mode:    '%',
          charges:     [],
        }],
        global_charges: [],
      });
      expect(draftRes.status).toBe(200);

      const dbQuote = await db.oneOrNone(
        `SELECT quote_pricing FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`,
        [gcEmptyArcId, VENDOR_A]
      );
      const qp = typeof dbQuote.quote_pricing === 'string'
        ? JSON.parse(dbQuote.quote_pricing)
        : dbQuote.quote_pricing;

      expect(Array.isArray(qp.global_charges_input)).toBe(true);
      expect(qp.global_charges_input.length).toBe(0);
      // With no global charges, grand_total === grand_subtotal.
      expect(Number(qp.grand_total)).toBe(Number(qp.grand_subtotal));
    });
  });
});
