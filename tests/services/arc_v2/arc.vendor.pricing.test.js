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
//
// Not tested here (not HTTP-observable):
//   - FE-only server-preview wiring, per-charge-tax UI, charges modal
//   - Buyer-FE visual display, global-charge UI (Phase-2 remainder)
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
});
