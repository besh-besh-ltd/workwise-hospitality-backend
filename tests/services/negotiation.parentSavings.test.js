// negotiation.parentSavings.test.js — the money on an RFQ-first negotiation card.
//
// POST /api/v1/negotiation/list-view with groupBy:'parent' emits TWO savings
// figures per parent, because they answer different questions:
//
//   saved_value / baseline_total / achieved_total / saved_pct
//       across ALL participating vendors. Same basis as the round-detail page's
//       `cumulative` tile, so the two levels agree when a user drills in.
//   saved_value_awarded / baseline_total_awarded / …
//       restricted to the vendor whose quote was actually APPROVED (an APPROVED
//       NEGOTIATION_QUOTE whose metadata.vendor_id matches). The realised
//       benefit. Zero for parents with no approved quote — correct, not a bug
//       (36 of 124 production RFQs).
//
// WHY THE LADDER, NOT "first round price vs last round price":
//   Only 78 of 428 production (rfq, vendor, product) triples appear in more
//   than one round at all, so the naive rule reports ₹0 for 91 of 101 priced
//   RFQs — ₹3.43 lakh in total. Anchoring the baseline with the documented
//   ladder (previous_price → prior_round → quote_history → current_quote)
//   evaluated at the pair's EARLIEST round yields ₹98.46 lakh on a ₹8.04 crore
//   baseline. That is the whole point of the exercise.
//
// AND THE RULES THAT MAKE IT HONEST:
//   * per (vendor, rfq_product): baseline from the EARLIEST round, achieved
//     from the LATEST — the full span, not the last leg;
//   * CANCELLED rounds are excluded entirely;
//   * values are SIGNED and NEVER clamped. 14 production RFQs genuinely ended
//     above their baseline and a floor of zero would hide it.
//
// SECURITY: the savings query reads tbl_quotes / tbl_quote_items /
// tbl_quote_item_history and carries NO scope of its own. It may only ever be
// fed rfq ids that already survived the RBAC-scoped parent query. The last test
// here is the product-level proof that it is.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

const HC_A = IDS.hospitality.A;
const HC_B = IDS.hospitality.B;
const A1 = IDS.hotels.A1;
const B1 = IDS.hotels.B1;
const PROC = IDS.departments.proc;
const PROCESS = IDS.processes.A_P1;

// Role 8 = Commercial Negotiator N1 — carries permission negotiation.read.
const ROLE_NEG_READ = 8;

// Purpose-built users (80951+ — clear of every other negotiation suite).
const U_A = 80951;
const U_B = 80952;

const VA = IDS.users.vendor_alpha;
const VB = IDS.users.vendor_beta;

// Product variants from the reference seed — one per scenario so each
// (vendor, product) pair is independently observable.
const V_HIST = 1; // single-round vendor, has quote history
const V_PRIOR = 2; // two-round vendor, NO quote history
const V_RISE = 3; // price went UP
const V_CANCEL = 4; // a CANCELLED round must not become the achieved anchor

const OWN_POLICY_ID = 979101;
const PFX = "NEGSAV-";
const PAST = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

let clientA, clientB;
const rfq = {}; // key → { id, no }
const RP = {}; // key → rfq_product id
const QI = {}; // key → quote_item id
const roundIds = [];
let instanceId = null;
let policyId = null;
let ownedPolicy = false;

async function makeScopedUser(userId, name, { company, hc }) {
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 2, $4, now(), now())
     ON CONFLICT (id) DO UPDATE SET user_type = 2, status = 1`,
    [userId, name, `negsav.${userId}@test.local`, company]
  );
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings
       (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
     VALUES ($1, $2, NULL, 0, $3)
     ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
    [userId, hc, IDS.users.superAdmin]
  );
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
     VALUES ($1, $2, $3, NULL, NULL)`,
    [userId, ROLE_NEG_READ, hc]
  );
}

async function seedRfq(key, { hc, hotel, title }) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: IDS.users.superAdmin,
    hospitality: hc,
    hotel,
    department: PROC,
    process: PROCESS,
    title: `${PFX}${title}`,
  });
  rfq[key] = { id: Number(rfq_id), no: Number(rfq_no) };
  return rfq[key];
}

async function addProduct(rfqKey, key, variantId) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, product_variant_id, variant, comment, spec_file, qap_file)
     VALUES ($1, $2, 0, $3, '0', '0') RETURNING id`,
    [rfq[rfqKey].id, variantId, `${key} line`]
  );
  RP[key] = Number(row.id);
  return RP[key];
}

async function addQuote(rfqKey, vendorId) {
  const row = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, "timestamp", is_regret)
     VALUES ($1, $2, 1, $3, $3, now(), 0) RETURNING id`,
    [rfq[rfqKey].id, rfq[rfqKey].no, vendorId]
  );
  return Number(row.id);
}

// The vendor's LIVE quote item — total_price is the CURRENT (already
// negotiated) price; earlier revisions live in tbl_quote_item_history.
async function addQuoteItem(rfqKey, key, quoteId, variantId, totalPrice) {
  const row = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, variant, product_name,
        unit_price, package_price, tax, freight_price, total_price, quantity,
        tax_mode, comment, delivery_period)
     VALUES ($1, $2, $3, $4, 0, $5, $6, 0, 0, 0, $6, '1', 'percentage', '', '7')
     RETURNING id`,
    [rfq[rfqKey].id, rfq[rfqKey].no, quoteId, variantId, `${key} product`, totalPrice]
  );
  QI[key] = Number(row.id);
  return QI[key];
}

async function addHistory(rfqKey, key, variantId, totalPrice, agoMinutes = 120) {
  await db.none(
    `INSERT INTO tbl_quote_item_history
       (quote_item_id, rfq_id, product_variant_id, variant, unit_price, package_price,
        tax, freight_price, total_price, quantity, tax_mode, timestamp)
     VALUES ($1, $2, $3, 0, $4, 0, 0, 0, $4, '1', 'percentage', now() - ($5 || ' minutes')::interval)`,
    [QI[key], rfq[rfqKey].id, variantId, totalPrice, String(agoMinutes)]
  );
}

async function addRound(rfqKey, { number, status = "ENDED", createdAgoDays }) {
  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (rfq_id, source_type, source_id, round_number, status, end_date,
        vendor_ids, created_by, created_at)
     VALUES ($1, 'RFQ', $1, $2, $3, $4, $5::int[], $6, $4)
     RETURNING id`,
    [rfq[rfqKey].id, number, status, PAST(createdAgoDays), [VA, VB], IDS.users.superAdmin]
  );
  const id = Number(row.id);
  roundIds.push(id);
  return id;
}

async function addRoundQuote(roundId, vendorId, rfqProductId, quotedPrice) {
  await db.none(
    `INSERT INTO tbl_negotiation_round_quotes
       (negotiation_round_id, vendor_id, rfq_product_id, quoted_price, submitted_at, created_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [roundId, vendorId, rfqProductId, quotedPrice]
  );
}

describe("Negotiation parent savings — the baseline ladder, signed and scoped", () => {
  beforeAll(async () => {
    await makeScopedUser(U_A, "NegSav A User", { company: IDS.companies.A, hc: HC_A });
    await makeScopedUser(U_B, "NegSav B User", { company: IDS.companies.B, hc: HC_B });

    // ══ MAIN: every vendor improves, so the awarded subset is a true subset ══
    await seedRfq("MAIN", { hc: HC_A, hotel: A1, title: "Main Savings" });
    await addProduct("MAIN", "HIST", V_HIST);
    await addProduct("MAIN", "PRIOR", V_PRIOR);
    await addProduct("MAIN", "CANCEL", V_CANCEL);

    const qA = await addQuote("MAIN", VA);
    const qB = await addQuote("MAIN", VB);

    // HIST — vendor A, ONE round. Live quote 900, earliest revision 1000.
    // Naive first-vs-last would report ₹0 (one round = one price). The ladder
    // reaches back to the original quote: baseline 1000 → achieved 900 → 100.
    await addQuoteItem("MAIN", "HIST", qA, V_HIST, 900);
    await addHistory("MAIN", "HIST", V_HIST, 1000);

    // PRIOR — vendor B, TWO rounds, and NO quote-item history at all. The
    // earliest round's own price is the only earlier price on record, so the
    // prior_round rung carries it: baseline 950 → achieved 900 → 50.
    // Without that rung it would fall to current_quote (900) and report ₹0.
    await addQuoteItem("MAIN", "PRIOR", qB, V_PRIOR, 900);

    // CANCEL — vendor A. A later CANCELLED round quotes an absurd 100. If
    // cancelled rounds were counted it would become the achieved anchor and
    // invent 900 of savings.
    await addQuoteItem("MAIN", "CANCEL", qA, V_CANCEL, 800);
    await addHistory("MAIN", "CANCEL", V_CANCEL, 1000);

    const r1 = await addRound("MAIN", { number: 1, createdAgoDays: 6 });
    const r2 = await addRound("MAIN", { number: 2, createdAgoDays: 4 });
    const rCancelled = await addRound("MAIN", { number: 3, status: "CANCELLED", createdAgoDays: 2 });

    await addRoundQuote(r1, VA, RP.HIST, 900); // single-round pair
    await addRoundQuote(r1, VB, RP.PRIOR, 950); // earliest of two
    await addRoundQuote(r2, VB, RP.PRIOR, 900); // latest of two
    await addRoundQuote(r1, VA, RP.CANCEL, 800);
    await addRoundQuote(rCancelled, VA, RP.CANCEL, 100); // must be ignored

    // Vendor A's HIST quote is the one that was APPROVED downstream.
    // The policy row only has to satisfy the FK — the savings query never reads
    // it — so reuse whatever the fixture seed already has rather than fighting
    // uq_approval_policy_scope_process.
    const existingPolicy = await db.oneOrNone(
      `SELECT id FROM tbl_approval_policies ORDER BY id LIMIT 1`
    );
    if (existingPolicy) {
      policyId = Number(existingPolicy.id);
    } else {
      await db.none(
        `INSERT INTO tbl_approval_policies
           (id, entity_type, hospitality_company_id, hotel_id, department_id,
            is_active, created_by, process_id, is_master, is_department_scoped, version)
         VALUES ($1, 'NEGOTIATION_QUOTE', $2, $3, NULL, true, $4, $5, false, false, 1)`,
        [OWN_POLICY_ID, HC_A, A1, IDS.users.superAdmin, PROCESS]
      );
      policyId = OWN_POLICY_ID;
      ownedPolicy = true;
    }
    const inst = await db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          initiated_by, hospitality_company_id, hotel_id, department_id, metadata)
       VALUES ('NEGOTIATION_QUOTE', $1, $2, 'APPROVED', 1, $3, $4, $5, $6, $7::jsonb)
       RETURNING id`,
      [RP.HIST, policyId, IDS.users.superAdmin, HC_A, A1, PROC, JSON.stringify({ vendor_id: VA })]
    );
    instanceId = Number(inst.id);

    // ══ RISE: the vendor came back HIGHER. Signed, unclamped. ══════════════
    await seedRfq("RISE", { hc: HC_A, hotel: A1, title: "Price Rise" });
    await addProduct("RISE", "RISE", V_RISE);
    const qRise = await addQuote("RISE", VA);
    await addQuoteItem("RISE", "RISE", qRise, V_RISE, 900);
    await addHistory("RISE", "RISE", V_RISE, 800); // original was CHEAPER
    const rRise = await addRound("RISE", { number: 1, createdAgoDays: 3 });
    await addRoundQuote(rRise, VA, RP.RISE, 900);

    // ══ NOAWARD: real savings, but nothing was ever approved ═══════════════
    await seedRfq("NOAWARD", { hc: HC_A, hotel: A1, title: "No Award" });
    await addProduct("NOAWARD", "NOAWARD", V_HIST);
    const qNo = await addQuote("NOAWARD", VA);
    await addQuoteItem("NOAWARD", "NOAWARD", qNo, V_HIST, 700);
    await addHistory("NOAWARD", "NOAWARD", V_HIST, 1000);
    const rNo = await addRound("NOAWARD", { number: 1, createdAgoDays: 3 });
    await addRoundQuote(rNo, VA, RP.NOAWARD, 700);

    // ══ FOREIGN: another tenant's priced negotiation ═══════════════════════
    await seedRfq("FOREIGN", { hc: HC_B, hotel: B1, title: "Other Company" });
    await addProduct("FOREIGN", "FOREIGN", V_HIST);
    const qF = await addQuote("FOREIGN", VA);
    await addQuoteItem("FOREIGN", "FOREIGN", qF, V_HIST, 500);
    await addHistory("FOREIGN", "FOREIGN", V_HIST, 1000);
    const rF = await addRound("FOREIGN", { number: 1, createdAgoDays: 3 });
    await addRoundQuote(rF, VA, RP.FOREIGN, 500);

    clientA = await httpClient(U_A);
    clientB = await httpClient(U_B);
  });

  afterAll(async () => {
    if (roundIds.length) {
      await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [roundIds]);
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [roundIds]);
    }
    if (instanceId) await db.none(`DELETE FROM tbl_approval_instances WHERE id = $1`, [instanceId]);
    if (ownedPolicy) await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [OWN_POLICY_ID]);
    const rfqIds = Object.values(rfq).map((r) => r.id);
    if (rfqIds.length) {
      await db.none(`DELETE FROM tbl_quote_item_history WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
      await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
      await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
    }
    const users = [U_A, U_B];
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [users]);
    await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [users]);
  });

  const rowFor = async (client, key) => {
    const res = await client
      .post("/api/v1/negotiation/list-view")
      .send({ limit: 200, filters: { parentKey: [`RFQ:${rfq[key].id}`] } });
    expect(res.status).toBe(200);
    return res.body.data.rows[0];
  };

  // ── The ladder ────────────────────────────────────────────────────────────
  test("a SINGLE-round vendor is priced off quote_history — not ₹0", async () => {
    const row = await rowFor(clientA, "MAIN");
    expect(row).toBeDefined();
    // HIST 1000→900 (=100) + PRIOR 950→900 (=50) + CANCEL 1000→800 (=200).
    expect(Number(row.baseline_total)).toBe(2950);
    expect(Number(row.achieved_total)).toBe(2600);
    expect(Number(row.saved_value)).toBe(350);
    expect(Number(row.savings_pairs_counted)).toBe(3);
    // The HIST and CANCEL pairs both reached back through quote history; the
    // naive "first round vs last round" rule would have scored them at zero.
    expect(row.baseline_sources.quote_history).toBe(2);
  });

  test("a TWO-round vendor with no quote history is priced off the prior round", async () => {
    const row = await rowFor(clientA, "MAIN");
    expect(row.baseline_sources.prior_round).toBe(1);
    // The prior_round pair contributes 950 - 900 = 50 of the 350 total; with
    // the rung missing it would have fallen to current_quote (900) and 0.
    expect(row.baseline_sources.current_quote).toBe(0);
  });

  test("saved_value is exactly baseline_total - achieved_total, and saved_pct agrees", async () => {
    const row = await rowFor(clientA, "MAIN");
    expect(Number(row.saved_value)).toBeCloseTo(
      Number(row.baseline_total) - Number(row.achieved_total), 2
    );
    expect(Number(row.saved_pct)).toBeCloseTo(
      (Number(row.saved_value) / Number(row.baseline_total)) * 100, 3
    );
  });

  // ── Signed, unclamped ─────────────────────────────────────────────────────
  test("a price RISE yields a NEGATIVE saved_value — never clamped to zero", async () => {
    const row = await rowFor(clientA, "RISE");
    expect(Number(row.baseline_total)).toBe(800);
    expect(Number(row.achieved_total)).toBe(900);
    expect(Number(row.saved_value)).toBe(-100);
    expect(Number(row.saved_pct)).toBeLessThan(0);
  });

  // ── CANCELLED rounds ──────────────────────────────────────────────────────
  test("a CANCELLED round is excluded — it never becomes the achieved anchor", async () => {
    const row = await rowFor(clientA, "MAIN");
    // The cancelled round quoted 100. Counting it would drag achieved_total to
    // 1900 and invent 1050 of savings.
    expect(Number(row.achieved_total)).toBe(2600);
    expect(Number(row.saved_value)).toBe(350);
    expect(Number(row.saved_value)).not.toBe(1050);
  });

  // ── The awarded subset ────────────────────────────────────────────────────
  test("the awarded figure is the subset for the vendor whose quote was APPROVED", async () => {
    const row = await rowFor(clientA, "MAIN");
    // Only vendor A's HIST pair carries an APPROVED NEGOTIATION_QUOTE.
    expect(Number(row.baseline_total_awarded)).toBe(1000);
    expect(Number(row.achieved_total_awarded)).toBe(900);
    expect(Number(row.saved_value_awarded)).toBe(100);
    expect(Number(row.savings_pairs_counted_awarded)).toBe(1);
    // …and it is a SUBSET of the all-vendor figure.
    expect(Number(row.saved_value_awarded)).toBeLessThanOrEqual(Number(row.saved_value));
    expect(Number(row.savings_pairs_counted_awarded)).toBeLessThan(Number(row.savings_pairs_counted));
  });

  test("with NO approved quote the awarded figure is zero while the all-vendor figure is not", async () => {
    const row = await rowFor(clientA, "NOAWARD");
    expect(Number(row.saved_value)).toBe(300); // 1000 → 700
    expect(Number(row.baseline_total_awarded)).toBe(0);
    expect(Number(row.achieved_total_awarded)).toBe(0);
    expect(Number(row.saved_value_awarded)).toBe(0);
    expect(row.saved_pct_awarded).toBeNull();
    expect(Number(row.savings_pairs_counted_awarded)).toBe(0);
  });

  // ── Sorting on the number ─────────────────────────────────────────────────
  test("sort='savings' orders parents by saved_value descending, negatives last", async () => {
    const res = await clientA.post("/api/v1/negotiation/list-view").send({ limit: 200, sort: "savings" });
    expect(res.status).toBe(200);
    const vals = res.body.data.rows.map((r) => Number(r.saved_value || 0));
    expect(vals).toEqual([...vals].sort((a, b) => b - a));
    const keys = res.body.data.rows.map((r) => String(r.parent_key));
    // MAIN (+350) and NOAWARD (+300) both before RISE (-100).
    expect(keys.indexOf(`RFQ:${rfq.MAIN.id}`)).toBeLessThan(keys.indexOf(`RFQ:${rfq.RISE.id}`));
    expect(keys.indexOf(`RFQ:${rfq.NOAWARD.id}`)).toBeLessThan(keys.indexOf(`RFQ:${rfq.RISE.id}`));
  });

  // ── SECURITY: savings are computed for in-scope ids ONLY ──────────────────
  test("savings are never computed for — or returned from — an out-of-scope parent", async () => {
    // The foreign RFQ is genuinely priced: its own tenant sees the number.
    const theirs = await rowFor(clientB, "FOREIGN");
    expect(theirs).toBeDefined();
    expect(Number(theirs.saved_value)).toBe(500); // 1000 → 500

    // The company-A user cannot reach it by any of the three doors: the plain
    // listing, an rfqId filter, or a parentKey filter. Each is an empty page —
    // not a 403, and never a price.
    const plain = await clientA.post("/api/v1/negotiation/list-view").send({ limit: 200 });
    expect(plain.status).toBe(200);
    expect(plain.body.data.rows.map((r) => String(r.parent_key)))
      .not.toContain(`RFQ:${rfq.FOREIGN.id}`);

    for (const filters of [
      { rfqId: [String(rfq.FOREIGN.id)] },
      { parentKey: [`RFQ:${rfq.FOREIGN.id}`] },
    ]) {
      const res = await clientA.post("/api/v1/negotiation/list-view").send({ limit: 200, filters });
      expect(res.status).toBe(200);
      expect(res.body.data.rows).toHaveLength(0);
      expect(res.body.data.total).toBe(0);
    }
  });

  test("groupBy:'round' carries no savings fields at all", async () => {
    const res = await clientA
      .post("/api/v1/negotiation/list-view")
      .send({ limit: 200, groupBy: "round" });
    expect(res.status).toBe(200);
    for (const r of res.body.data.rows) {
      expect(r).not.toHaveProperty("saved_value");
      expect(r).not.toHaveProperty("baseline_total");
      expect(r).not.toHaveProperty("saved_value_awarded");
    }
  });
});
