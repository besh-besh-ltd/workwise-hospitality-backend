// negotiation.roundDetail.test.js — Negotiation Command Center contract.
//
// GET /api/v1/negotiation/rounds/:id/detail?scope=round|cycle
//
// This endpoint is the single source of truth for one negotiation: what was
// asked for, what was achieved, who responded, what the deadline is, where the
// approval sits, and which actions the caller may take.
//
// The traps this suite exists to pin down (all verified against production):
//
//   1. For RFQ rounds `nrq.quoted_price` is the landed LINE TOTAL, while
//      `vendor_approvals[].negotiation_fields[].target` for `base_price` is a
//      UNIT price. Comparing them directly is wrong by ~qty x tax.
//      => achieved_pct is computed on line totals, requested_pct on units,
//         both off the SAME baseline.
//   2. `previous_price` is NULL for every legacy row, so the baseline has to
//      fall back through prior_round -> quote_history -> current_quote. The
//      response MUST say which one it used (`baseline_source`).
//   3. Savings are SIGNED. Prices genuinely go UP (prod rounds 890/891).
//      Never clamp to zero.
//   4. Free-text targets (payment_terms, documents, comment(s), delivery_period,
//      global_comment) must never enter numeric maths.
//
// Fixture strategy: one RFQ carrying one product per baseline-source branch so
// each branch is observable in isolation, plus rounds for cycle grouping,
// cumulative roll-up, whole-RFQ mode and multi-item mode.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

const HC_A = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const PROC = IDS.departments.proc;

// Role 8 = Commercial Negotiator N1 → negotiation.{read,create,update,approve}
const ROLE_NEG_FULL = 8;
// Role 17 = RFQ Observer → negotiation.read only (no approve/update/create)
const ROLE_NEG_READONLY = 17;

const U_NEG = 80931; // full negotiation rights at (HC_A, A1, all depts)
const U_OBSERVER = 80932; // read-only at (HC_A, A1, all depts)

const VA = IDS.users.vendor_alpha;
const VB = IDS.users.vendor_beta;

// Product variants from the reference seed.
const V1 = 1;
const V2 = 2;
const V3 = 3;
const V4 = 4;
const V5 = 5;

const PAST_BID_END = new Date(Date.now() - 3 * 86_400_000)
  .toISOString()
  .replace("T", " ")
  .slice(0, 19);

const D = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

const created = {
  rfqIds: [],
  roundIds: [],
  quoteIds: [],
  rfqProductIds: [],
};

let rfqId;
let rfqNo;
const RP = {}; // key → rfq_product id
const QI = {}; // key → quote_item id
const R = {}; // key → round id

async function addUser(userId, name, roleId) {
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 2, $4, now(), now())
     ON CONFLICT (id) DO UPDATE SET user_type = 2, status = 1`,
    [userId, name, `negdetail.${userId}@test.local`, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings
       (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
    [userId, HC_A, A1, IDS.users.superAdmin]
  );
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
     VALUES ($1, $2, $3, $4, NULL)`,
    [userId, roleId, HC_A, A1]
  );
}

async function addProduct(key, variantId, variant, quantity, unit) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, product_variant_id, variant, comment, spec_file, qap_file)
     VALUES ($1, $2, $3, $4, '0', '0') RETURNING id`,
    [rfqId, variantId, variant, `${key} line`]
  );
  RP[key] = Number(row.id);
  created.rfqProductIds.push(RP[key]);
  await db.none(
    `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, variant, title, value)
     VALUES ($1, $2, $3, 'Quantity', $4), ($1, $2, $3, 'Unit', $5)`,
    [rfqId, variantId, variant, String(quantity), unit]
  );
  return RP[key];
}

async function addQuoteItem(key, quoteId, variantId, variant, { unit_price, tax, total_price, quantity }) {
  const row = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, variant, product_name,
        unit_price, package_price, tax, freight_price, total_price, quantity, tax_mode,
        comment, delivery_period)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 0, $9, $10, 'percentage', '', '7')
     RETURNING id`,
    [rfqId, rfqNo, quoteId, variantId, variant, `${key} product`, unit_price, tax, total_price, String(quantity)]
  );
  QI[key] = Number(row.id);
  return QI[key];
}

async function addHistory(quoteItemId, variantId, variant, { unit_price, tax, total_price, quantity }, agoMinutes = 60) {
  await db.none(
    `INSERT INTO tbl_quote_item_history
       (quote_item_id, rfq_id, product_variant_id, variant, unit_price, package_price,
        tax, freight_price, total_price, quantity, tax_mode, timestamp)
     VALUES ($1, $2, $3, $4, $5, 0, $6, 0, $7, $8, 'percentage', now() - ($9 || ' minutes')::interval)`,
    [quoteItemId, rfqId, variantId, variant, unit_price, tax, total_price, String(quantity), String(agoMinutes)]
  );
}

async function addRound(key, { productId = null, products = null, roundNumber, status, vendors, approvals, endDate = D(5) }) {
  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, rfq_product_id, products, round_number, status,
        end_date, vendor_ids, vendor_approvals, created_by, remarks, created_at)
     VALUES ($1, 'RFQ', $1, $2, $3::jsonb, $4, $5, $6, $7::int[], $8::jsonb, $9, $10, now())
     RETURNING id`,
    [
      rfqId,
      productId,
      products ? JSON.stringify(products) : null,
      roundNumber,
      status,
      endDate,
      vendors,
      JSON.stringify(approvals),
      U_NEG,
      `${key} remarks`,
    ]
  );
  R[key] = Number(row.id);
  created.roundIds.push(R[key]);
  return R[key];
}

async function addRoundQuote(roundId, vendorId, rfqProductId, quotedPrice, previousPrice = null) {
  await db.none(
    `INSERT INTO tbl_negotiation_round_quotes
       (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, previous_price, submitted_at, created_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())`,
    [roundId, vendorId, rfqProductId, quotedPrice, previousPrice]
  );
}

const approvalFor = (vendorId, fields, status = "PENDING") => ({
  vendor_id: vendorId,
  status,
  remarks: null,
  acted_by: null,
  acted_at: null,
  negotiation_fields: fields,
});

describe("Negotiation round detail — contract, baselines and signed savings", () => {
  let client;
  let observerClient;

  beforeAll(async () => {
    await addUser(U_NEG, "NegDetail Negotiator", ROLE_NEG_FULL);
    await addUser(U_OBSERVER, "NegDetail Observer", ROLE_NEG_READONLY);

    const rfq = await makeRFQ(db, {
      createdBy: U_NEG,
      hospitality: HC_A,
      hotel: A1,
      department: PROC,
      bid_end_date: PAST_BID_END,
      title: "NEGDETAIL Main RFQ",
      status: 1,
      is_published: 1,
    });
    rfqId = Number(rfq.rfq_id);
    rfqNo = Number(rfq.rfq_no);
    created.rfqIds.push(rfqId);

    // ── Products (one per baseline-source branch) ────────────────────────────
    await addProduct("PREV", V1, 0, 10, "NOS");
    await addProduct("PRIOR", V2, 0, 20, "NOS");
    await addProduct("HIST", V3, 0, 100, "KG");
    await addProduct("CUR", V4, 0, 4, "BOX");
    await addProduct("ZERO", V5, 0, 5, "NOS");

    // ── Vendor quotes ────────────────────────────────────────────────────────
    const qa = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, "timestamp", is_regret)
       VALUES ($1, $2, 1, $3, $3, now(), 0) RETURNING id`,
      [rfqId, rfqNo, VA]
    );
    const quoteA = Number(qa.id);
    created.quoteIds.push(quoteA);

    const qb = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, "timestamp", is_regret)
       VALUES ($1, $2, 1, $3, $3, now(), 0) RETURNING id`,
      [rfqId, rfqNo, VB]
    );
    const quoteB = Number(qb.id);
    created.quoteIds.push(quoteB);

    // PREV: current quote unit 90 x qty 10 x 1.18 = 1062
    await addQuoteItem("PREV", quoteA, V1, 0, { unit_price: 90, tax: 18, total_price: 1062, quantity: 10 });
    // A history row at unit 100 exists, but previous_price must win over it.
    await addHistory(QI.PREV, V1, 0, { unit_price: 100, tax: 18, total_price: 1180, quantity: 10 });

    // PRIOR: current quote unit 90 x qty 20 x 1.18 = 2124
    await addQuoteItem("PRIOR", quoteA, V2, 0, { unit_price: 90, tax: 18, total_price: 2124, quantity: 20 });
    await addHistory(QI.PRIOR, V2, 0, { unit_price: 100, tax: 18, total_price: 2360, quantity: 20 });

    // HIST: the production 890 regression — vendor came BACK HIGHER.
    // history 4130 (unit 35) → round quote 4366 (unit 37).
    await addQuoteItem("HIST", quoteA, V3, 0, { unit_price: 37, tax: 18, total_price: 4366, quantity: 100 });
    await addHistory(QI.HIST, V3, 0, { unit_price: 35, tax: 18, total_price: 4130, quantity: 100 });

    // CUR: no history at all → only the current quote can serve as baseline.
    await addQuoteItem("CUR", quoteA, V4, 0, { unit_price: 50, tax: 0, total_price: 200, quantity: 4 });

    // ZERO: vendor B quoted but never responded to the round.
    await addQuoteItem("ZERO", quoteB, V5, 0, { unit_price: 20, tax: 0, total_price: 100, quantity: 5 });

    // ── Rounds ───────────────────────────────────────────────────────────────
    // 1. previous_price branch
    await addRound("PREV", {
      productId: RP.PREV,
      roundNumber: 1,
      status: "ENDED",
      vendors: [VA],
      approvals: [approvalFor(VA, [{ name: "base_price", target: "95" }], "APPROVED")],
    });
    await addRoundQuote(R.PREV, VA, RP.PREV, 1062, 1180);

    // 2. prior_round branch (round 1 then round 2 on the same product)
    await addRound("PRIOR1", {
      productId: RP.PRIOR,
      roundNumber: 1,
      status: "ENDED",
      vendors: [VA],
      approvals: [approvalFor(VA, [{ name: "base_price", target: "100" }])],
    });
    await addRoundQuote(R.PRIOR1, VA, RP.PRIOR, 2360);

    await addRound("PRIOR2", {
      productId: RP.PRIOR,
      roundNumber: 2,
      status: "ENDED",
      vendors: [VA],
      approvals: [approvalFor(VA, [{ name: "base_price", target: "85" }])],
    });
    await addRoundQuote(R.PRIOR2, VA, RP.PRIOR, 2124);

    // 3. quote_history branch + the signed-negative regression
    await addRound("HIST", {
      productId: RP.HIST,
      roundNumber: 1,
      status: "ENDED",
      vendors: [VA],
      approvals: [approvalFor(VA, [{ name: "base_price", target: "33.25" }])],
    });
    await addRoundQuote(R.HIST, VA, RP.HIST, 4366);

    // 3b. sibling of PRIOR2 by (source, round_number=2) — used for cycle scope,
    //     and the second leg of the cumulative roll-up on HIST.
    await addRound("HIST2", {
      productId: RP.HIST,
      roundNumber: 2,
      status: "ENDED",
      vendors: [VA],
      approvals: [approvalFor(VA, [{ name: "base_price", target: "32" }])],
    });
    await addRoundQuote(R.HIST2, VA, RP.HIST, 3835);

    // 3c. a CANCELLED third round on HIST — must render, must NOT pollute cumulative
    await addRound("HISTCANCEL", {
      productId: RP.HIST,
      roundNumber: 3,
      status: "CANCELLED",
      vendors: [VA],
      approvals: [approvalFor(VA, [{ name: "base_price", target: "30" }])],
    });
    await addRoundQuote(R.HISTCANCEL, VA, RP.HIST, 9999);

    // 4. current_quote branch + free-text-only targets
    await addRound("CUR", {
      productId: RP.CUR,
      roundNumber: 1,
      status: "ENDED",
      vendors: [VA],
      approvals: [
        approvalFor(VA, [
          { name: "payment_terms", target: "60 days credit" },
          { name: "delivery_period", target: "10 days" },
          { name: "comment", target: "please improve packaging" },
        ]),
      ],
    });
    await addRoundQuote(R.CUR, VA, RP.CUR, 200);

    // 5. zero-response round (vendor B invited, never answered)
    await addRound("ZERO", {
      productId: RP.ZERO,
      roundNumber: 1,
      status: "ACTIVE",
      vendors: [VB],
      approvals: [approvalFor(VB, [{ name: "base_price", target: "18" }])],
      endDate: D(5),
    });

    // 6. whole-RFQ (rfq-level) round
    await addRound("RFQLEVEL", {
      products: [{ is_rfq_level: true, vendor_targets: [{ vendor_id: VA, fields: [{ name: "freight", target: "500", mode: "absolute" }] }] }],
      roundNumber: 4,
      status: "ENDED",
      vendors: [VA],
      approvals: [approvalFor(VA, [])],
    });

    // 7. multi-item round covering PREV + PRIOR
    await addRound("MULTI", {
      products: [
        { rfq_product_id: RP.PREV, vendor_targets: [{ vendor_id: VA, fields: [{ name: "base_price", target: "88" }] }] },
        { rfq_product_id: RP.PRIOR, vendor_targets: [{ vendor_id: VA, fields: [{ name: "base_price", target: "80" }] }] },
      ],
      roundNumber: 5,
      status: "ENDED",
      vendors: [VA],
      approvals: [approvalFor(VA, [])],
    });

    client = await httpClient(U_NEG);
    observerClient = await httpClient(U_OBSERVER);
  });

  afterAll(async () => {
    if (created.roundIds.length) {
      await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [created.roundIds]);
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [created.roundIds]);
    }
    if (created.quoteIds.length) {
      await db.none(
        `DELETE FROM tbl_quote_item_history WHERE quote_item_id IN (
           SELECT id FROM tbl_quote_items WHERE quote_id = ANY($1::int[]))`,
        [created.quoteIds]
      );
      await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [created.quoteIds]);
      await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [created.quoteIds]);
    }
    if (created.rfqIds.length) {
      await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqIds]);
    }
    const users = [U_NEG, U_OBSERVER];
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [users]);
  });

  const detail = (roundId, scope) =>
    client.get(`/api/v1/negotiation/rounds/${roundId}/detail${scope ? `?scope=${scope}` : ""}`);

  const lineFor = (body, productKey, vendorId = VA) =>
    body.data.lines.find(
      (l) => Number(l.rfq_product_id) === RP[productKey] && Number(l.vendor_id) === vendorId
    );

  // ── CONTRACT SHAPE ────────────────────────────────────────────────────────
  test("returns the full command-center envelope for a round", async () => {
    const res = await detail(R.PREV);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const d = res.body.data;
    expect(d.scope).toBe("round");

    // Round identity + state
    expect(d.round.round_id).toBe(R.PREV);
    expect(d.round.round_number).toBe(1);
    expect(d.round.status).toBe("ENDED");
    expect(d.round.effective_status).toBe("AWAITING_DECISION");
    expect(d.round.source_type).toBe("RFQ");
    expect(d.round.source_id).toBe(rfqId);
    expect(d.round.mode).toBe("PER_ITEM");
    expect(typeof d.round.end_date).toBe("string");
    expect(d.round.created_by.user_id).toBe(U_NEG);

    // BOTH denominators — the UI's "Round 5 of 32" bug came from mixing them.
    // This round is round_number 1 and covers product PREV. Ten rounds exist on
    // the RFQ; TWO of them touch PREV (this one, plus the multi-item round
    // numbered 5). So "Round 1 of 10" and "Round 1 of 2" are both misleading and
    // the honest denominator is a third number — hence all three are returned.
    expect(d.round.rounds_on_parent).toBeGreaterThanOrEqual(9);
    expect(d.round.rounds_on_products).toBe(2);
    expect(d.round.max_round_number_on_products).toBe(5);

    // Parent identifiers
    expect(d.parent.source_type).toBe("RFQ");
    expect(d.parent.rfq_id).toBe(rfqId);
    expect(d.parent.rfq_no).toBe(rfqNo);
    expect(d.parent.arc_number).toBeNull();
    expect(d.parent.title).toBe("NEGDETAIL Main RFQ");
    expect(d.parent.hotel_id).toBe(A1);
    expect(d.parent.department_id).toBe(PROC);
    expect(typeof d.parent.hotel_name).toBe("string");

    // Quote visibility (bid_end_date is in the past → unlocked)
    expect(d.quote_visibility.locked).toBe(false);

    // Lines, totals, cumulative, vendors, approval, actions all present
    expect(Array.isArray(d.lines)).toBe(true);
    expect(d.totals).toBeTruthy();
    expect(d.cumulative).toBeTruthy();
    expect(Array.isArray(d.vendors)).toBe(true);
    expect(d.approval).toBeTruthy();
    expect(d.actions).toBeTruthy();
  });

  // ── BASELINE SOURCE 1: previous_price ─────────────────────────────────────
  test("baseline_source=previous_price when the column is populated (and it beats history)", async () => {
    const res = await detail(R.PREV);
    const line = lineFor(res.body, "PREV");

    expect(line.baseline_source).toBe("previous_price");
    expect(Number(line.baseline_line_total)).toBeCloseTo(1180, 2);
    expect(Number(line.baseline_unit)).toBeCloseTo(100, 4);
    expect(Number(line.achieved_line_total)).toBeCloseTo(1062, 2);
    expect(Number(line.achieved_unit)).toBeCloseTo(90, 4);
    expect(Number(line.quantity)).toBe(10);
    expect(line.uom).toBe("NOS");

    // target is a UNIT price → requested_pct is a UNIT comparison
    expect(Number(line.target_unit)).toBeCloseTo(95, 4);
    expect(Number(line.requested_pct)).toBeCloseTo(5, 4);
    // achieved is a LINE TOTAL comparison off the same baseline
    expect(Number(line.achieved_pct)).toBeCloseTo(10, 4);
    expect(Number(line.saved_value)).toBeCloseTo(118, 2);
    expect(line.responded).toBe(true);
    expect(line.outcome).toBe("target_met");
    expect(line.target_met).toBe(true);
    expect(line.vendor_approval_status).toBe("APPROVED");
  });

  // ── BASELINE SOURCE 2: prior_round ────────────────────────────────────────
  test("baseline_source=prior_round uses the previous round's quoted line total", async () => {
    const res = await detail(R.PRIOR2);
    const line = lineFor(res.body, "PRIOR");

    expect(line.baseline_source).toBe("prior_round");
    expect(line.baseline_round_id).toBe(R.PRIOR1);
    expect(Number(line.baseline_line_total)).toBeCloseTo(2360, 2);
    expect(Number(line.baseline_unit)).toBeCloseTo(100, 4);
    expect(Number(line.achieved_line_total)).toBeCloseTo(2124, 2);
    expect(Number(line.requested_pct)).toBeCloseTo(15, 4);
    expect(Number(line.achieved_pct)).toBeCloseTo(10, 4);
    expect(Number(line.saved_value)).toBeCloseTo(236, 2);
    expect(line.outcome).toBe("target_missed");
    expect(line.target_met).toBe(false);
  });

  // ── BASELINE SOURCE 3: quote_history + SIGNED NEGATIVE SAVING ─────────────
  test("baseline_source=quote_history, and a price INCREASE surfaces as a negative saving", async () => {
    const res = await detail(R.HIST);
    const line = lineFor(res.body, "HIST");

    expect(line.baseline_source).toBe("quote_history");
    expect(Number(line.baseline_line_total)).toBeCloseTo(4130, 2);
    expect(Number(line.baseline_unit)).toBeCloseTo(35, 4);
    expect(Number(line.achieved_line_total)).toBeCloseTo(4366, 2);

    // SIGNED, never clamped.
    expect(Number(line.saved_value)).toBeCloseTo(-236, 2);
    expect(Number(line.achieved_pct)).toBeLessThan(0);
    expect(Number(line.achieved_pct)).toBeCloseTo(-5.7143, 3);
    expect(Number(line.requested_pct)).toBeCloseTo(5, 4);
    expect(line.outcome).toBe("regressed");
    expect(line.target_met).toBe(false);

    // and it must propagate to the aggregate, still signed
    expect(Number(res.body.data.totals.saved_value)).toBeCloseTo(-236, 2);
    expect(Number(res.body.data.totals.saved_pct)).toBeLessThan(0);
    expect(res.body.data.totals.lines_regressed).toBe(1);
    expect(res.body.data.totals.lines_improved).toBe(0);
  });

  // ── BASELINE SOURCE 4: current_quote + non-numeric targets ────────────────
  test("baseline_source=current_quote when nothing else exists; free-text targets stay out of the maths", async () => {
    const res = await detail(R.CUR);
    const line = lineFor(res.body, "CUR");

    expect(line.baseline_source).toBe("current_quote");
    expect(Number(line.baseline_line_total)).toBeCloseTo(200, 2);
    expect(Number(line.achieved_line_total)).toBeCloseTo(200, 2);
    expect(Number(line.saved_value)).toBeCloseTo(0, 6);
    expect(line.outcome).toBe("unchanged");

    // No numeric target was ever set — never infer one.
    expect(line.has_numeric_target).toBe(false);
    expect(line.target_unit).toBeNull();
    expect(line.requested_pct).toBeNull();
    expect(line.target_met).toBeNull();
    expect(line.numeric_targets).toEqual([]);

    // The three free-text asks are surfaced separately, verbatim.
    const names = line.text_targets.map((t) => t.name).sort();
    expect(names).toEqual(["comment", "delivery_period", "payment_terms"]);
    expect(line.text_targets.find((t) => t.name === "payment_terms").target).toBe("60 days credit");

    // Aggregates must report "no numeric target" honestly, not as 0%.
    expect(res.body.data.totals.lines_with_numeric_target).toBe(0);
    expect(res.body.data.totals.requested_pct).toBeNull();
    expect(res.body.data.totals.target_met).toBeNull();
  });

  // ── ZERO RESPONSE ─────────────────────────────────────────────────────────
  test("a round with no vendor responses renders with responded=false and zeroed counts", async () => {
    const res = await detail(R.ZERO);
    expect(res.status).toBe(200);

    const line = lineFor(res.body, "ZERO", VB);
    expect(line).toBeTruthy();
    expect(line.responded).toBe(false);
    expect(line.responded_at).toBeNull();
    expect(line.achieved_line_total).toBeNull();
    expect(line.saved_value).toBeNull();
    expect(line.outcome).toBe("no_response");

    const t = res.body.data.totals;
    expect(t.lines_total).toBe(1);
    expect(t.lines_responded).toBe(0);
    expect(t.lines_awaiting).toBe(1);
    expect(Number(t.baseline_total)).toBe(0);
    expect(Number(t.achieved_total)).toBe(0);
    expect(Number(t.saved_value)).toBe(0);
    expect(t.saved_pct).toBeNull();

    // vendor roll-up still names the silent vendor
    expect(res.body.data.vendors).toHaveLength(1);
    expect(Number(res.body.data.vendors[0].vendor_id)).toBe(VB);
    expect(res.body.data.vendors[0].has_responded).toBe(false);

    // an ACTIVE round with a future end_date is open
    expect(res.body.data.round.effective_status).toBe("ACTIVE");
    expect(res.body.data.round.is_open).toBe(true);
    expect(res.body.data.round.is_expired).toBe(false);
  });

  // ── MODES ─────────────────────────────────────────────────────────────────
  test("whole-RFQ rounds report mode=WHOLE_RFQ and one rfq-level line", async () => {
    const res = await detail(R.RFQLEVEL);
    expect(res.status).toBe(200);
    expect(res.body.data.round.mode).toBe("WHOLE_RFQ");
    expect(res.body.data.lines).toHaveLength(1);
    const line = res.body.data.lines[0];
    expect(line.is_rfq_level).toBe(true);
    expect(line.rfq_product_id).toBeNull();
    expect(line.numeric_targets.map((t) => t.name)).toContain("freight");
    expect(line.numeric_targets.find((t) => t.name === "freight").mode).toBe("absolute");
    // freight is a charge, not base_price → no unit target for the line
    expect(line.target_unit).toBeNull();
  });

  test("multi-item rounds report mode=MULTI_ITEM with one line per covered product", async () => {
    const res = await detail(R.MULTI);
    expect(res.status).toBe(200);
    expect(res.body.data.round.mode).toBe("MULTI_ITEM");
    expect(res.body.data.lines).toHaveLength(2);
    const ids = res.body.data.lines.map((l) => Number(l.rfq_product_id)).sort();
    expect(ids).toEqual([RP.PREV, RP.PRIOR].sort());
    // per-product targets come from products[].vendor_targets, not vendor_approvals
    expect(Number(lineFor(res.body, "PREV").target_unit)).toBeCloseTo(88, 4);
    expect(Number(lineFor(res.body, "PRIOR").target_unit)).toBeCloseTo(80, 4);
  });

  // ── CANCELLED / EXPIRED STILL RENDER ──────────────────────────────────────
  test("a CANCELLED round still renders in full", async () => {
    const res = await detail(R.HISTCANCEL);
    expect(res.status).toBe(200);
    expect(res.body.data.round.status).toBe("CANCELLED");
    expect(res.body.data.round.effective_status).toBe("CANCELLED");
    expect(res.body.data.round.is_open).toBe(false);
    expect(res.body.data.lines).toHaveLength(1);
    // no negotiation action should be offered on a cancelled round
    expect(res.body.data.actions.can_approve).toBe(false);
    expect(res.body.data.actions.can_close).toBe(false);
  });

  // ── CYCLE SCOPE ───────────────────────────────────────────────────────────
  test("scope=cycle groups sibling rounds sharing (source_type, source_id, round_number)", async () => {
    const res = await detail(R.PRIOR2, "cycle");
    expect(res.status).toBe(200);
    expect(res.body.data.scope).toBe("cycle");

    const d = res.body.data;
    expect(d.cycle.round_number).toBe(2);
    expect(d.cycle.sibling_round_ids.sort()).toEqual([R.PRIOR2, R.HIST2].sort());
    expect(d.cycle.sibling_count).toBe(2);
    expect(d.cycle.excluded_sibling_count).toBe(0);

    // lines from BOTH siblings
    expect(d.lines).toHaveLength(2);
    expect(d.lines.map((l) => Number(l.round_id)).sort()).toEqual([R.PRIOR2, R.HIST2].sort());

    // aggregate spans both: (2360-2124) + (4366-3835) = 236 + 531 = 767
    expect(Number(d.totals.baseline_total)).toBeCloseTo(2360 + 4366, 2);
    expect(Number(d.totals.achieved_total)).toBeCloseTo(2124 + 3835, 2);
    expect(Number(d.totals.saved_value)).toBeCloseTo(767, 2);
    expect(d.totals.lines_total).toBe(2);
    expect(d.totals.lines_responded).toBe(2);
  });

  test("scope=round on the same id keeps only that round's line", async () => {
    const res = await detail(R.PRIOR2, "round");
    expect(res.body.data.scope).toBe("round");
    expect(res.body.data.lines).toHaveLength(1);
    expect(res.body.data.cycle).toBeNull();
  });

  // ── CUMULATIVE ────────────────────────────────────────────────────────────
  test("cumulative spans rounds 1..N on the same products and excludes CANCELLED rounds", async () => {
    const res = await detail(R.HIST2);
    const c = res.body.data.cumulative;

    expect(c.from_round_number).toBe(1);
    expect(c.to_round_number).toBe(2);
    expect(c.round_ids.sort()).toEqual([R.HIST, R.HIST2].sort());
    expect(c.round_ids).not.toContain(R.HISTCANCEL);
    expect(c.rounds_counted).toBe(2);

    // earliest baseline 4130 → latest achieved 3835 (NOT the cancelled 9999)
    expect(Number(c.baseline_total)).toBeCloseTo(4130, 2);
    expect(Number(c.achieved_total)).toBeCloseTo(3835, 2);
    expect(Number(c.saved_value)).toBeCloseTo(295, 2);
    expect(Number(c.saved_pct)).toBeCloseTo((295 / 4130) * 100, 4);
  });

  // ── BASELINE PROVENANCE ROLL-UP ───────────────────────────────────────────
  test("totals.baseline_sources reports the provenance mix", async () => {
    const res = await detail(R.PREV);
    expect(res.body.data.totals.baseline_sources).toEqual({
      previous_price: 1,
      prior_round: 0,
      quote_history: 0,
      current_quote: 0,
      none: 0,
    });
  });

  // ── ACTIONS ───────────────────────────────────────────────────────────────
  test("actions are derived from state + the caller's negotiation permissions", async () => {
    const active = await detail(R.ZERO);
    expect(active.body.data.actions.can_close).toBe(true);
    expect(active.body.data.actions.can_view_quotes).toBe(true);

    // read-only caller (RFQ Observer) gets no write actions
    const obs = await observerClient.get(`/api/v1/negotiation/rounds/${R.ZERO}/detail`);
    expect(obs.status).toBe(200);
    expect(obs.body.data.actions.can_close).toBe(false);
    expect(obs.body.data.actions.can_approve).toBe(false);
    expect(obs.body.data.actions.can_create_next_round).toBe(false);
    expect(obs.body.data.actions.can_view_quotes).toBe(true);
    expect(obs.body.data.permissions).toEqual({
      read: true,
      create: false,
      update: false,
      approve: false,
      delete: false,
    });
  });

  // ── INPUT VALIDATION ──────────────────────────────────────────────────────
  test("an invalid scope value is rejected", async () => {
    const res = await client.get(`/api/v1/negotiation/rounds/${R.PREV}/detail?scope=bogus`);
    expect(res.status).toBe(400);
  });
});
