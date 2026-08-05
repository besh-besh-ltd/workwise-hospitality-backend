// ARC v2 — Sr 54: commercial-ranked shortlist gate on Technical Evaluation.
//
// Confirmed design (see .pipeline/spec.md + .pipeline/changes.md):
//   - Blind-preserving (OQ1=A): the SYSTEM ranks sealed commercial quotes; the
//     tech evaluator sees ONLY shortlist membership (aliases) + aggregate
//     counts — NEVER prices, basket totals, rank numbers, or on-hold identity.
//   - Whole-ARC granularity (OQ2=A): one rank per vendor across their entire
//     basket (not per item).
//   - Automatic promotion (OQ4): a shortlisted vendor ending not_qualified
//     auto-promotes the next held vendor — no buyer action.
//   - Fixed size = 5. <=5 responders => everyone in_eval, none on_hold.
//   - A vendor with a sealed tech envelope but NO commercial quote is
//     unrankable: excluded from the shortlist AND from total_participating.
//
// Product-level: real Express app + local Postgres. Assertions on HTTP + DB
// rows only (never on internal call counts or helper wiring).

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";

const HC      = IDS.hospitality.A;
const HOTEL   = IDS.hotels.A1;
const DEPT    = IDS.departments.proc;
const PROC    = IDS.processes.A_P1;
const BUYER   = IDS.users.a1_proc_buyer;
const CROSS_USER = IDS.users.companyB_admin; // legitimate active user, DIFFERENT tenant (Company B)
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;
const TECH_POLICY_ID = 64970; // ARC_TECH — sole approver IS the buyer (auto-approve)
const MIN_PASS = 60;

const E = "/api/v1/arc-v2/evaluation";

// ---- Ad hoc vendor user ids reserved for this suite (96601..96617) ----
const V = {
  v1: 96601, v2: 96602, v3: 96603, v4: 96604, v5: 96605, v6: 96606, v7: 96607, v8: 96608,
};
const SMALL = { s1: 96609, s2: 96610, s3: 96611 };
const TIE = { a: 96612, b: 96613, c: 96614, d: 96615, e: 96616, f: 96617 };
const ALL_AD_HOC_VENDORS = [
  ...Object.values(V), ...Object.values(SMALL), ...Object.values(TIE),
];

// Distinctive fractional rates — a leaked numeric price/basket_total would
// show up verbatim as one of these strings in a serialized JSON body, and a
// fractional value can't collide accidentally with an autoincrement id.
const RATES = {
  [V.v1]: 111.11, [V.v2]: 222.22, [V.v3]: 333.33, [V.v4]: 444.44,
  [V.v5]: 555.55, [V.v6]: 666.66, [V.v7]: 777.77,
};

describe("ARC v2 — Sr54 commercial-ranked technical-evaluation shortlist", () => {
  let buyerClient, crossClient;

  // Main scenario: 8 vendors respond technically; 7 of them ALSO submit a
  // commercial quote at distinct ascending rates; 1 (v8) never quotes.
  let mainArcId, mainItemId, mainTeId;
  const respByVendor = {};

  // <5 participants: backward-compat (all in_eval, none on_hold).
  let smallArcId, smallItemId;

  // Tie at the shortlist boundary: deterministic tiebreak.
  let tieArcId, tieItemId;
  const createdArcIds = [];

  async function insertVendorUser(id, label) {
    await db.none(
      `INSERT INTO tbl_users (id, name, email, status, user_type, created_at, updated_at)
       VALUES ($1, $2, $3, 1, 3, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET status = 1, user_type = 3`,
      [id, `Shortlist ${label}`, `shortlist.${label.toLowerCase().replace(/\s+/g, "-")}@test.local`]
    );
  }

  async function seedTechEvalItem(arcId, variantId, { qty = 1 } = {}) {
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, $3, 'litre', 100) RETURNING id`,
      [arcId, variantId, qty]
    );
    const te = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
       VALUES ($1, $2) RETURNING id`,
      [item.id, MIN_PASS]
    );
    const clause = await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_clauses
         (arc_item_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
       VALUES ($1, 'Spec compliance', 100, 'spec', false) RETURNING id`,
      [te.id]
    );
    return { itemId: Number(item.id), teId: Number(te.id), clauseId: Number(clause.id) };
  }

  async function seedResponse(clauseId, vendorId, text) {
    return Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
         (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response)
       VALUES ($1, $2, $3) RETURNING id`,
      [clauseId, vendorId, text]
    )).id);
  }

  async function seedQuote(arcId, vendorId, itemId, rate, { commercial = true, hoursAgo = 1 } = {}) {
    const q = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, tech_submitted_at)
       VALUES ($1, $2, $3, NOW() - ($4 || ' hours')::interval)
       ON CONFLICT (arc_id, vendor_id) DO UPDATE
         SET submitted_at = EXCLUDED.submitted_at, tech_submitted_at = EXCLUDED.tech_submitted_at
       RETURNING id`,
      [arcId, vendorId, commercial ? new Date() : null, hoursAgo]
    );
    if (rate != null) {
      await db.none(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
         VALUES ($1, $2, $3, 5) ON CONFLICT (arc_quote_id, arc_item_id) DO NOTHING`,
        [q.id, itemId, rate]
      );
    }
    return Number(q.id);
  }

  async function insertArc(number, label) {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'submission_closed',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $8) RETURNING id`,
      [number, label, CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    const arcId = Number(arc.id);
    createdArcIds.push(arcId);
    return arcId;
  }

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET status = 1 WHERE id = $1`, [CROSS_USER]);
    for (const id of ALL_AD_HOC_VENDORS) {
      await insertVendorUser(id, `Vendor ${id}`);
    }

    buyerClient = await httpClient(BUYER);
    crossClient = await httpClient(CROSS_USER);
    await seedArcEvalPerms(db, [BUYER]); // scoped to HOTEL (Hotel A1)

    // ARC_TECH policy — sole approver IS the buyer (auto-approve on submit),
    // same pattern as arc.autoApprove.hooks.test.js.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_TECH', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [TECH_POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ANY', 'USER', $2) ON CONFLICT DO NOTHING`,
      [TECH_POLICY_ID, BUYER]
    );

    // ───────── Main ARC: 8 technical respondents, 7 with commercial quotes ─────────
    mainArcId = await insertArc(`ARC-SHORTLIST-MAIN-${Date.now()}`, "Shortlist main");
    const mainItem = await seedTechEvalItem(mainArcId, VARIANT_ID);
    mainItemId = mainItem.itemId;
    mainTeId = mainItem.teId;

    for (const [vid, rate] of Object.entries(RATES)) {
      const vendorId = Number(vid);
      respByVendor[vendorId] = await seedResponse(mainItem.clauseId, vendorId, `vendor ${vendorId} answer`);
      await seedQuote(mainArcId, vendorId, mainItemId, rate, { commercial: true });
    }
    // v8 — sealed a technical envelope but NEVER submitted a commercial quote.
    respByVendor[V.v8] = await seedResponse(mainItem.clauseId, V.v8, `vendor ${V.v8} answer`);
    await seedQuote(mainArcId, V.v8, mainItemId, null, { commercial: false });

    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
       SELECT $1, v, 'submitted' FROM UNNEST($2::int[]) AS v
       ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
      [mainArcId, Object.values(V)]
    );

    // ───────── Small ARC: 3 vendors, all quoted (< 5 => backward-compat) ─────────
    smallArcId = await insertArc(`ARC-SHORTLIST-SMALL-${Date.now()}`, "Shortlist small");
    const smallItem = await seedTechEvalItem(smallArcId, VARIANT_ID);
    smallItemId = smallItem.itemId;
    for (const [i, vid] of Object.values(SMALL).entries()) {
      await seedResponse(smallItem.clauseId, vid, `small vendor ${vid} answer`);
      await seedQuote(smallArcId, vid, smallItemId, 100 * (i + 1));
    }

    // ───────── Tie ARC: 6 vendors, rank5/rank6 tied on basket_total ─────────
    tieArcId = await insertArc(`ARC-SHORTLIST-TIE-${Date.now()}`, "Shortlist tie");
    const tieItem = await seedTechEvalItem(tieArcId, VARIANT_ID);
    tieItemId = tieItem.itemId;
    const tieRates = [[TIE.a, 100], [TIE.b, 200], [TIE.c, 300], [TIE.d, 400]];
    for (const [vid, rate] of tieRates) {
      await seedResponse(tieItem.clauseId, vid, `tie vendor ${vid} answer`);
      await seedQuote(tieArcId, vid, tieItemId, rate);
    }
    // e and f tie at 500 — e submits its commercial quote strictly EARLIER, so
    // the deterministic tiebreak (submitted_at ASC, then vendor_id ASC) must
    // keep e in_eval (rank 5) and push f to on_hold (rank 6).
    await seedResponse(tieItem.clauseId, TIE.e, `tie vendor ${TIE.e} answer`);
    await db.none(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, tech_submitted_at)
       VALUES ($1, $2, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '3 hours')`,
      [tieArcId, TIE.e]
    );
    const qe = await db.one(`SELECT id FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`, [tieArcId, TIE.e]);
    await db.none(`INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct) VALUES ($1,$2,500,5)`, [qe.id, tieItemId]);

    await seedResponse(tieItem.clauseId, TIE.f, `tie vendor ${TIE.f} answer`);
    await db.none(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, tech_submitted_at)
       VALUES ($1, $2, NOW() - INTERVAL '1 hours', NOW() - INTERVAL '3 hours')`,
      [tieArcId, TIE.f]
    );
    const qf = await db.one(`SELECT id FROM tbl_arc_quote WHERE arc_id = $1 AND vendor_id = $2`, [tieArcId, TIE.f]);
    await db.none(`INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct) VALUES ($1,$2,500,5)`, [qf.id, tieItemId]);
  });

  afterAll(async () => {
    // Approval instances (not FK-cascaded from tbl_arc — entity_type/entity_id pair).
    const instanceIds = (await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_TECH' AND entity_id = ANY($1::bigint[])`,
      [createdArcIds]
    )).map((r) => r.id);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers
                      WHERE approval_instance_step_id IN
                        (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [TECH_POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [TECH_POLICY_ID]);
    await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = ANY($1::text[])`,
      [createdArcIds.map(String)]);
    // tbl_arc cascades item/te/clauses/response/response_files/quote/quote_line/
    // vendor_alias/tech_shortlist/cleared_vendors/event_log/invitation.
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [createdArcIds]);
    await db.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [ALL_AD_HOC_VENDORS]);
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  // ============================================================
  // Scenario 1 — 7 participating (rankable) vendors -> top 5 in, 2 held.
  // ============================================================
  describe("7 rankable vendors (+1 unrankable) — top 5 by lowest commercial basket", () => {
    test("DB truth: exactly the 5 lowest-basket vendors are in_eval, the 2 highest are on_hold", async () => {
      // Lazy backstop — the shortlist doesn't exist yet; the GET computes it.
      const res = await buyerClient.get(`${E}/items/${mainItemId}/tech-eval`);
      expect(res.status).toBe(200);

      const rows = await db.any(
        `SELECT vendor_id, commercial_rank, status, basket_total
           FROM tbl_arc_tech_shortlist WHERE arc_id = $1 ORDER BY commercial_rank ASC`,
        [mainArcId]
      );
      expect(rows.length).toBe(7); // v8 (no commercial quote) never gets a row
      const expectedOrder = [V.v1, V.v2, V.v3, V.v4, V.v5, V.v6, V.v7];
      rows.forEach((r, i) => {
        expect(Number(r.vendor_id)).toBe(expectedOrder[i]);
        expect(Number(r.commercial_rank)).toBe(i + 1);
      });
      expect(rows.slice(0, 5).every((r) => r.status === "in_eval")).toBe(true);
      expect(rows.slice(5).every((r) => r.status === "on_hold")).toBe(true);
      expect(rows.find((r) => Number(r.vendor_id) === V.v8)).toBeUndefined();
    });

    test("tech-eval payload exposes ONLY the 5 in_eval aliases + a count block", async () => {
      const res = await buyerClient.get(`${E}/items/${mainItemId}/tech-eval`);
      expect(res.status).toBe(200);
      const { responses, scores, shortlist } = res.body.data;
      expect(shortlist).toEqual({ total_participating: 7, in_evaluation: 5, on_hold: 2 });
      expect(responses.length).toBe(5);
      expect(scores.length).toBe(5);

      const inEvalRespIds = new Set(
        [V.v1, V.v2, V.v3, V.v4, V.v5].map((v) => String(respByVendor[v]))
      );
      for (const r of responses) {
        expect(inEvalRespIds.has(String(r.response_id))).toBe(true);
      }
    });

    test("BLIND: no price / basket_total / commercial_rank / vendor_id leaks to the evaluator payload", async () => {
      const res = await buyerClient.get(`${E}/items/${mainItemId}/tech-eval`);
      const blob = JSON.stringify(res.body);
      for (const rate of Object.values(RATES)) {
        expect(blob).not.toContain(String(rate));
      }
      expect(blob).not.toMatch(/"commercial_rank"/);
      expect(blob).not.toMatch(/"basket_total"/);
      expect(blob).not.toMatch(/"vendor_id"/);
    });

    test("no-commercial-quote vendor (v8) is excluded from the shortlist, the count, and the matrix", async () => {
      const res = await buyerClient.get(`${E}/items/${mainItemId}/tech-eval`);
      expect(res.body.data.shortlist.total_participating).toBe(7); // NOT 8
      const v8RespId = String(respByVendor[V.v8]);
      expect(res.body.data.responses.some((r) => String(r.response_id) === v8RespId)).toBe(false);
      expect(res.body.data.scores.some((s) => s.response_id != null && String(s.response_id) === v8RespId)).toBe(false);
      const row = await db.oneOrNone(
        `SELECT 1 FROM tbl_arc_tech_shortlist WHERE arc_id = $1 AND vendor_id = $2`, [mainArcId, V.v8]
      );
      expect(row).toBeNull();
    });
  });

  // ============================================================
  // Scenario 2 — automatic promotion.
  // ============================================================
  describe("automatic promotion: a top-5 vendor going not_qualified promotes rank 6", () => {
    test("scoring v1 below the pass bar auto-promotes v6 (no buyer action) on submit", async () => {
      const score = async (respId, marks) => {
        const r = await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: respId, buyer_marks: marks });
        expect(r.status).toBe(200);
      };
      await score(respByVendor[V.v1], 10); // < 60 => not_qualified
      await score(respByVendor[V.v2], 90);
      await score(respByVendor[V.v3], 90);
      await score(respByVendor[V.v4], 90);
      await score(respByVendor[V.v5], 90);

      const submit = await buyerClient.post(`${E}/${mainArcId}/tech-eval/submit`).send({});
      expect(submit.status).toBe(200);

      // BLIND requirement: the submit response — seen by the SAME tech
      // evaluator who just scored these vendors — must not leak commercial
      // rank/price data even while reporting a promotion happened.
      const submitBlob = JSON.stringify(submit.body);
      expect(submitBlob).not.toMatch(/"commercial_rank"/);
      expect(submitBlob).not.toMatch(/"basket_total"/);
      expect(submitBlob).not.toMatch(/"vendor_id"/);

      // Correctness — verified via DB truth (blind-safe), not the HTTP body.
      const rows = await db.any(`SELECT vendor_id, status FROM tbl_arc_tech_shortlist WHERE arc_id = $1`, [mainArcId]);
      const byV = Object.fromEntries(rows.map((r) => [Number(r.vendor_id), r.status]));
      expect(byV[V.v1]).toBe("in_eval"); // NEVER demoted, even though not_qualified
      expect(byV[V.v6]).toBe("promoted"); // rank 6 — the next held vendor
      expect(byV[V.v7]).toBe("on_hold"); // still held

      const cleared = await db.any(
        `SELECT vendor_id, status FROM tbl_arc_item_tech_evaluation_cleared_vendors WHERE arc_item_tech_evaluation_id = $1`,
        [mainTeId]
      );
      const clearedByV = Object.fromEntries(cleared.map((r) => [Number(r.vendor_id), r.status]));
      expect(clearedByV[V.v1]).toBe("not_qualified");
      expect(clearedByV[V.v2]).toBe("qualified");
      expect(clearedByV[V.v3]).toBe("qualified");
      expect(clearedByV[V.v4]).toBe("qualified");
      expect(clearedByV[V.v5]).toBe("qualified");
      expect(clearedByV[V.v6]).toBeUndefined(); // held vendors are never scored/recorded
      expect(clearedByV[V.v7]).toBeUndefined();
      expect(clearedByV[V.v8]).toBeUndefined();

      const evt = await db.oneOrNone(
        `SELECT payload FROM tbl_arc_event_log
          WHERE arc_id = $1 AND event_type = 'tech_shortlist_promoted'
          ORDER BY id DESC LIMIT 1`,
        [mainArcId]
      );
      expect(evt).toBeTruthy();
      expect(Number(evt.payload.vendor_id)).toBe(V.v6);
      expect(Number(evt.payload.commercial_rank)).toBe(6);
    });

    test("the promoted vendor now appears in the tech-eval matrix; counts become 6 in-eval / 1 on-hold", async () => {
      const res = await buyerClient.get(`${E}/items/${mainItemId}/tech-eval`);
      expect(res.status).toBe(200);
      expect(res.body.data.shortlist).toEqual({ total_participating: 7, in_evaluation: 6, on_hold: 1 });
      const respIds = res.body.data.responses.map((r) => String(r.response_id));
      expect(respIds).toContain(String(respByVendor[V.v6]));
      expect(respIds).not.toContain(String(respByVendor[V.v7]));

      // Still blind — the promoted vendor's identity/price is not disclosed.
      const blob = JSON.stringify(res.body);
      for (const rate of Object.values(RATES)) {
        expect(blob).not.toContain(String(rate));
      }
      expect(blob).not.toMatch(/"commercial_rank"/);
      expect(blob).not.toMatch(/"basket_total"/);
    });
  });

  // ============================================================
  // Scenario 3 — backward-compat: fewer than 5 participants.
  // ============================================================
  describe("< 5 participants — everyone in_eval, none on_hold", () => {
    test("3 vendors: all in_eval, shortlist reports 0 on_hold", async () => {
      const res = await buyerClient.get(`${E}/items/${smallItemId}/tech-eval`);
      expect(res.status).toBe(200);
      expect(res.body.data.shortlist).toEqual({ total_participating: 3, in_evaluation: 3, on_hold: 0 });

      const rows = await db.any(`SELECT status FROM tbl_arc_tech_shortlist WHERE arc_id = $1`, [smallArcId]);
      expect(rows.length).toBe(3);
      expect(rows.every((r) => r.status === "in_eval")).toBe(true);
    });
  });

  // ============================================================
  // Scenario 4 — deterministic tiebreak at the boundary.
  // ============================================================
  describe("tie at the rank 5/6 boundary — deterministic tiebreak", () => {
    test("earlier commercial submission wins the last in_eval slot; later loses to on_hold", async () => {
      const res = await buyerClient.get(`${E}/items/${tieItemId}/tech-eval`);
      expect(res.status).toBe(200);

      const rows = await db.any(
        `SELECT vendor_id, commercial_rank, status FROM tbl_arc_tech_shortlist WHERE arc_id = $1 ORDER BY commercial_rank ASC`,
        [tieArcId]
      );
      expect(rows.length).toBe(6); // exactly N despite the tie — not N+1
      expect(Number(rows[4].vendor_id)).toBe(TIE.e);
      expect(rows[4].status).toBe("in_eval");
      expect(Number(rows[4].commercial_rank)).toBe(5);
      expect(Number(rows[5].vendor_id)).toBe(TIE.f);
      expect(rows[5].status).toBe("on_hold");
      expect(Number(rows[5].commercial_rank)).toBe(6);
    });
  });

  // ============================================================
  // Scenario 5 — scope / IDOR.
  // ============================================================
  describe("scope / IDOR — a cross-tenant caller cannot read or mutate the shortlist", () => {
    test("cross-tenant read of the shortlisted tech-eval matrix is denied (403), no data leaks in the denial body", async () => {
      const res = await crossClient.get(`${E}/items/${mainItemId}/tech-eval`);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toMatch(/total_participating/);
    });

    test("cross-tenant mutation (score) of a response in this ARC is denied (403)", async () => {
      const res = await crossClient.post(`${E}/tech-eval/score`).send({
        response_id: respByVendor[V.v2], buyer_marks: 50,
      });
      expect(res.status).toBe(403);
    });
  });
});
