// ARC v2 — Universal (ARC-wide) technical-evaluation clauses.
//
// Product-level wave suite (real Express app + local Postgres; assertions on
// HTTP status/body + DB rows only — never on internal call counts). Covers the
// spec's §9 behaviours for the SECOND, separate universal clause configurator:
//
//   1. REGRESSION (§8.1, the primary guarantee): an ARC with ONLY per-item
//      clauses and NO universal owner flows identically end-to-end — score,
//      submit/auto-approve, allocate, finalize all behave as today, and NO
//      universal rows are ever created (universallyFailedVendorIds is a no-op).
//   2. UNIVERSAL GLOBAL KNOCKOUT: a vendor scored universal-FAIL is
//      (a) pricing-redacted in GET comm-eval on EVERY item incl. a clause-less
//      one, (b) rejected by POST comm-eval/allocation, (c) rejected by POST
//      comm-eval/finalize (stale-award guard), (d) rejected as a negotiation
//      target (arc-level AND item-scoped) — while a universal-PASS vendor
//      proceeds normally.
//   3. ITEM vs UNIVERSAL INDEPENDENCE (§8.2/§8.3): universal-PASS + item-FAIL
//      excluded from THAT item only; universal-FAIL + item-PASS excluded
//      everywhere.
//   4. SUBMIT persists the universal verdict from scored responses (rides the
//      SAME ARC_TECH instance — no separate approval), scoreUniversalResponse +
//      blind getUniversalTechEval read.
//   5. SEAL GATE (§6.1): the vendor cannot seal the technical envelope until
//      BOTH item and universal clauses are answered; commercial submit is
//      blocked until seal (even on a universal-only ARC).
//   6. SECURITY / IDOR: a universal clause-id from another ARC is rejected on
//      vendor draft (universalClauseIdsBelongToArc); a non-invited vendor is
//      rejected on universal evidence upload; a cross-tenant buyer cannot
//      setup / read / score the universal evaluation.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedArcEvalPerms, cleanupArcEvalPerms } from "../../helpers/arcEvalPerms.js";
import { ensureArcApprovable } from "../../helpers/arcApproverPerms.js";

const HC      = IDS.hospitality.A;
const HOTEL   = IDS.hotels.A1;
const DEPT    = IDS.departments.proc;
const PROC    = IDS.processes.A_P1;
const BUYER   = IDS.users.a1_proc_buyer;
const FINANCE = IDS.users.a1_proc_finance;
const CROSS   = IDS.users.companyB_admin; // active user, DIFFERENT tenant (Company B)
const P = IDS.users.vendor_alpha;  // universal-PASS vendor
const F = IDS.users.vendor_beta;   // universal-FAIL vendor
const M = IDS.users.vendor_gamma;  // universal-PASS but item-FAIL vendor
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

const TECH_POLICY_ID = 64975;      // ARC_TECH — sole approver IS the buyer (auto-approve)
const COMMITTEE_POLICY_ID = 64976; // ARC_COMMITTEE — finance approver
const NEGOTIATION_POLICY_ID = 64977; // ARC_NEGOTIATION — buyer approver (auto-approve)

const E = "/api/v1/arc-v2/evaluation";
const VBASE = "/api/v1/arc-v2/vendor";

describe("ARC v2 — universal (ARC-wide) technical-evaluation clauses", () => {
  let buyerClient, crossClient, alpha, gamma;
  const createdArcIds = [];

  // ── seed helpers ──────────────────────────────────────────────────────────
  async function insertArc(number, status, { endOffsetDays = -1 } = {}) {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               NOW() - INTERVAL '7 days', NOW() + ($9 || ' days')::interval,
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $10) RETURNING id`,
      [number, `Universal ${number}`, CATEGORY, HC, HOTEL, DEPT, PROC, status, String(endOffsetDays), BUYER]
    );
    const id = Number(arc.id);
    createdArcIds.push(id);
    return id;
  }

  async function seedItem(arcId, { withClause = false, qty = 1000, variantId = VARIANT_ID } = {}) {
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, $3, 'litre', 100) RETURNING id`,
      [arcId, variantId, qty]
    );
    const out = { itemId: Number(item.id) };
    if (withClause) {
      const te = await db.one(
        `INSERT INTO tbl_arc_item_tech_evaluation (arc_item_id, minimum_passing_score)
         VALUES ($1, 60) RETURNING id`,
        [item.id]
      );
      const clause = await db.one(
        `INSERT INTO tbl_arc_item_tech_evaluation_clauses
           (arc_item_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
         VALUES ($1, 'Item spec compliance', 100, 'spec', false) RETURNING id`,
        [te.id]
      );
      out.teId = Number(te.id);
      out.clauseId = Number(clause.id);
    }
    return out;
  }

  async function seedItemResponse(clauseId, vendorId, text = "answer") {
    return Number((await db.one(
      `INSERT INTO tbl_arc_item_tech_evaluation_vendors_response
         (arc_item_tech_evaluation_clauses_id, vendor_id, vendor_response)
       VALUES ($1, $2, $3) RETURNING id`,
      [clauseId, vendorId, text]
    )).id);
  }

  async function seedItemCleared(teId, vendorId, status) {
    await db.none(
      `INSERT INTO tbl_arc_item_tech_evaluation_cleared_vendors
         (arc_item_tech_evaluation_id, vendor_id, calculated_score, status, evaluation_round)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (arc_item_tech_evaluation_id, vendor_id, evaluation_round) DO UPDATE SET status = EXCLUDED.status`,
      [teId, vendorId, status === "qualified" ? 90 : 10, status]
    );
  }

  // Universal owner + one clause (mandatory optional). Returns { ownerId, clauseId }.
  async function seedUniversal(arcId, { minPass = 60, mandatory = false } = {}) {
    const owner = await db.one(
      `INSERT INTO tbl_arc_universal_tech_evaluation (arc_id, minimum_passing_score, current_round)
       VALUES ($1, $2, 1) RETURNING id`,
      [arcId, minPass]
    );
    const clause = await db.one(
      `INSERT INTO tbl_arc_universal_tech_evaluation_clauses
         (arc_universal_tech_evaluation_id, clause_text, weightage, clause_type, is_mandatory)
       VALUES ($1, 'ARC-wide GST compliance', 100, 'compliance', $2) RETURNING id`,
      [owner.id, mandatory]
    );
    return { ownerId: Number(owner.id), clauseId: Number(clause.id) };
  }

  async function seedUniversalResponse(clauseId, vendorId, text = "univ answer") {
    return Number((await db.one(
      `INSERT INTO tbl_arc_universal_tech_evaluation_vendors_response
         (arc_universal_tech_evaluation_clauses_id, vendor_id, vendor_response)
       VALUES ($1, $2, $3) RETURNING id`,
      [clauseId, vendorId, text]
    )).id);
  }

  async function seedUniversalCleared(ownerId, vendorId, status) {
    await db.none(
      `INSERT INTO tbl_arc_universal_tech_evaluation_cleared_vendors
         (arc_universal_tech_evaluation_id, vendor_id, calculated_score, status, evaluation_round)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (arc_universal_tech_evaluation_id, vendor_id, evaluation_round) DO UPDATE SET status = EXCLUDED.status`,
      [ownerId, vendorId, status === "qualified" ? 90 : 10, status]
    );
  }

  // Submitted commercial quote + line for an item (distinct fractional rate).
  async function seedQuote(arcId, vendorId, itemId, rate, { techSealed = false } = {}) {
    const q = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, tech_submitted_at)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (arc_id, vendor_id) DO UPDATE SET submitted_at = EXCLUDED.submitted_at
       RETURNING id`,
      [arcId, vendorId, techSealed ? new Date() : null]
    );
    const line = await db.one(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
       VALUES ($1, $2, $3, 5)
       ON CONFLICT (arc_quote_id, arc_item_id) DO UPDATE SET rate = EXCLUDED.rate
       RETURNING id`,
      [q.id, itemId, rate]
    );
    return { quoteId: Number(q.id), lineId: Number(line.id) };
  }

  // Seed an APPROVED ARC_TECH approval instance so the lifecycle recognises the
  // technical stage as ratified (complete) → commercial unlocks. Needed for the
  // pre-seeded knockout ARCs now that a universal-clause ARC correctly REQUIRES a
  // technical approval before awarding (the fix): without it the lifecycle keeps
  // commercial LOCKED and the write endpoints 409 before reaching the knockout.
  let _techInstanceSeq = 99900001;
  async function seedApprovedTechInstance(arcId) {
    const id = _techInstanceSeq++;
    await db.none(
      `INSERT INTO tbl_approval_instances
         (id, entity_type, entity_id, approval_policy_id, status, current_step,
          hospitality_company_id, hotel_id, department_id, initiated_by, process_id, completed_at)
       VALUES ($1, 'ARC_TECH', $2, $3, 'APPROVED', 1, $4, $5, $6, $7, $8, NOW())`,
      [id, arcId, TECH_POLICY_ID, HC, HOTEL, DEPT, BUYER, PROC]
    );
    return id;
  }

  async function invite(arcId, vendorIds) {
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status)
       SELECT $1, v, 'submitted' FROM UNNEST($2::int[]) AS v
       ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
      [arcId, vendorIds]
    );
  }

  // ── shared fixtures for the various scenarios ──────────────────────────────
  // ARC_REG — item-only, NO universal (regression, real end-to-end flow).
  let regArc, regItem, regClause, regTe, regLine, regRespP;
  // ARC_KO — universal + a clause-less item; F universal-FAIL, P universal-PASS.
  let koArc, koItem, koOwner, koLineP, koLineF;
  // ARC_FIN — universal knockout at finalize (stale award to F).
  let finArc, finItem, finLineF;
  // ARC_IND — independence: 2 clause-bearing items; M item-FAIL on item1, F universal-FAIL.
  let indArc, indItem1, indItem2;
  // ARC_SUBMIT — submit persists the universal verdict from scored responses.
  let subArc, subUnivClause, subRespP, subRespF;
  // ARC_SEAL — seal gate (universal + item, window open); also the IDOR host ARC.
  let sealArc, sealItem, sealItemClause, sealUnivClause;
  // ARC_OTHER — a SECOND ARC whose universal clause id proves cross-ARC rejection.
  let otherArc, otherUnivClause, otherUnivResp;
  // ARC_UONLY — a genuinely UNIVERSAL-ONLY ARC (universal clauses, ZERO item
  // clauses) driven through the REAL lifecycle (no pre-seeded verdicts/status).
  let uoArc, uoItem, uoUnivClause, uoRespP, uoRespF, uoLineP, uoLineF;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET status = 1 WHERE id = ANY($1::int[])`, [[CROSS, FINANCE]]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`, [[P, F, M]]);

    buyerClient = await httpClient(BUYER);
    crossClient = await httpClient(CROSS);
    alpha       = await httpClient(P);
    gamma       = await httpClient(M);
    await seedArcEvalPerms(db, [BUYER]);

    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );

    // ARC_TECH — sole approver is the buyer → submit auto-approves.
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
    await ensureArcApprovable(db, [BUYER], HC);
    // ARC_COMMITTEE — finalize spawns this instance (one finance approver).
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_COMMITTEE', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [COMMITTEE_POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2) ON CONFLICT DO NOTHING`,
      [COMMITTEE_POLICY_ID, FINANCE]
    );
    await ensureArcApprovable(db, [FINANCE], HC);
    // ARC_NEGOTIATION — buyer is the sole approver → createRound auto-approves.
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_NEGOTIATION', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [NEGOTIATION_POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ANY', 'USER', $2) ON CONFLICT DO NOTHING`,
      [NEGOTIATION_POLICY_ID, BUYER]
    );
    await ensureArcApprovable(db, [BUYER], HC);

    // ── ARC_REG — item-only, no universal. submission_closed, real flow. ──
    regArc = await insertArc(`UNIV-REG-${Date.now()}`, "submission_closed");
    ({ itemId: regItem, teId: regTe, clauseId: regClause } = await seedItem(regArc, { withClause: true }));
    regRespP = await seedItemResponse(regClause, P, "reg answer");
    ({ lineId: regLine } = await seedQuote(regArc, P, regItem, 123.45));
    await invite(regArc, [P]);

    // ── ARC_KO — universal + clause-less item. F universal-FAIL, P universal-PASS. ──
    koArc = await insertArc(`UNIV-KO-${Date.now()}`, "comm_eval_in_progress");
    ({ itemId: koItem } = await seedItem(koArc, { withClause: false }));
    ({ ownerId: koOwner } = await seedUniversal(koArc));
    await seedUniversalCleared(koOwner, P, "qualified");
    await seedUniversalCleared(koOwner, F, "not_qualified");
    ({ lineId: koLineP } = await seedQuote(koArc, P, koItem, 123.45));
    ({ lineId: koLineF } = await seedQuote(koArc, F, koItem, 678.90));
    await invite(koArc, [P, F]);
    // Ratify technical so commercial is legitimately open (universal clauses now
    // require a technical approval before awarding — see the lifecycle fix).
    await seedApprovedTechInstance(koArc);

    // ── ARC_FIN — universal knockout at finalize (an award to F pre-dates the verdict). ──
    finArc = await insertArc(`UNIV-FIN-${Date.now()}`, "comm_eval_in_progress");
    ({ itemId: finItem } = await seedItem(finArc, { withClause: false }));
    const finU = await seedUniversal(finArc);
    await seedUniversalCleared(finU.ownerId, F, "not_qualified");
    ({ lineId: finLineF } = await seedQuote(finArc, F, finItem, 555.55));
    await invite(finArc, [F]);
    await seedApprovedTechInstance(finArc); // ratify technical → commercial open
    // Directly seed a comm-eval + a full-qty award to F (simulating an award saved
    // before the universal verdict landed) so finalize hits the stale-award guard.
    const finComm = await db.one(
      `INSERT INTO tbl_arc_comm_evaluation (arc_id, status) VALUES ($1, 'in_progress') RETURNING id`,
      [finArc]
    );
    await db.none(
      `INSERT INTO tbl_arc_comm_evaluation_award
         (arc_comm_evaluation_id, arc_item_id, awarded_vendor_id, awarded_quote_line_id,
          allocated_qty, l_rank, is_l1_default, awarded_quote_snapshot)
       VALUES ($1, $2, $3, $4, 1000, 'L1', true, '{}'::jsonb)`,
      [finComm.id, finItem, F, finLineF]
    );

    // ── ARC_IND — independence. 2 clause-bearing items. ──
    //   item1 clauses: P qualified, F qualified, M NOT qualified.
    //   item2 clauses: P qualified, F qualified, M qualified.
    //   universal:     P qualified, M qualified, F NOT qualified.
    indArc = await insertArc(`UNIV-IND-${Date.now()}`, "comm_eval_in_progress");
    const i1 = await seedItem(indArc, { withClause: true, variantId: 1 });
    const i2 = await seedItem(indArc, { withClause: true, variantId: 3 });
    indItem1 = i1.itemId; indItem2 = i2.itemId;
    await seedItemCleared(i1.teId, P, "qualified");
    await seedItemCleared(i1.teId, F, "qualified");
    await seedItemCleared(i1.teId, M, "not_qualified");
    await seedItemCleared(i2.teId, P, "qualified");
    await seedItemCleared(i2.teId, F, "qualified");
    await seedItemCleared(i2.teId, M, "qualified");
    const indU = await seedUniversal(indArc);
    await seedUniversalCleared(indU.ownerId, P, "qualified");
    await seedUniversalCleared(indU.ownerId, M, "qualified");
    await seedUniversalCleared(indU.ownerId, F, "not_qualified");
    for (const [vid, rate] of [[P, 100.11], [F, 200.22], [M, 300.33]]) {
      const q = await db.one(
        `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at) VALUES ($1, $2, NOW()) RETURNING id`,
        [indArc, vid]
      );
      await db.none(
        `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
         VALUES ($1, $2, $3, 5), ($1, $4, $3, 5)`,
        [q.id, indItem1, rate, indItem2]
      );
    }
    await invite(indArc, [P, F, M]);

    // ── ARC_SUBMIT — submit persists the universal verdict from scored responses. ──
    subArc = await insertArc(`UNIV-SUB-${Date.now()}`, "submission_closed");
    const subItem = await seedItem(subArc, { withClause: true });
    // Score P's item response so P is item-qualified (submit records both matrices).
    await seedItemResponse(subItem.clauseId, P, "sub item answer");
    const subU = await seedUniversal(subArc, { minPass: 60 });
    subUnivClause = subU.clauseId;
    subRespP = await seedUniversalResponse(subUnivClause, P, "P universal answer");
    subRespF = await seedUniversalResponse(subUnivClause, F, "F universal answer");
    await seedQuote(subArc, P, subItem.itemId, 111.11);
    await seedQuote(subArc, F, subItem.itemId, 222.22);
    await invite(subArc, [P, F]);

    // ── ARC_SEAL — seal gate (window OPEN) + IDOR host. universal + item clause. ──
    sealArc = await insertArc(`UNIV-SEAL-${Date.now()}`, "floated", { endOffsetDays: 10 });
    const sealI = await seedItem(sealArc, { withClause: true });
    sealItem = sealI.itemId; sealItemClause = sealI.clauseId;
    const sealU = await seedUniversal(sealArc);
    sealUnivClause = sealU.clauseId;
    await invite(sealArc, [P, F]); // gamma (M) intentionally NOT invited → upload IDOR

    // ── ARC_OTHER — a separate ARC whose universal clause proves cross-ARC 400. ──
    otherArc = await insertArc(`UNIV-OTHER-${Date.now()}`, "floated", { endOffsetDays: 10 });
    await seedItem(otherArc, { withClause: false });
    const otherU = await seedUniversal(otherArc);
    otherUnivClause = otherU.clauseId;
    otherUnivResp = await seedUniversalResponse(otherUnivClause, P, "other answer");
    await invite(otherArc, [P]);

    // ── ARC_UONLY — UNIVERSAL-ONLY, real lifecycle. Window CLOSED
    // (submission_closed), ONE clause-less item, universal clauses, submitted
    // commercial quotes + vendor universal responses. NO cleared rows, NO
    // comm-eval, NO forced comm_eval status — the buyer drives the real flow.
    uoArc = await insertArc(`UNIV-UONLY-${Date.now()}`, "submission_closed");
    ({ itemId: uoItem } = await seedItem(uoArc, { withClause: false }));
    const uoU = await seedUniversal(uoArc, { minPass: 60 });
    uoUnivClause = uoU.clauseId;
    uoRespP = await seedUniversalResponse(uoUnivClause, P, "P universal-only answer");
    uoRespF = await seedUniversalResponse(uoUnivClause, F, "F universal-only answer");
    ({ lineId: uoLineP } = await seedQuote(uoArc, P, uoItem, 321.01, { techSealed: true }));
    ({ lineId: uoLineF } = await seedQuote(uoArc, F, uoItem, 654.02, { techSealed: true }));
    await invite(uoArc, [P, F]);
  });

  afterAll(async () => {
    // Negotiation rounds are polymorphic (source_type='ARC') — not cascaded.
    const roundIds = (await db.any(
      `SELECT id FROM tbl_negotiation_rounds WHERE source_type='ARC' AND source_id = ANY($1::bigint[])`,
      [createdArcIds]
    )).map((r) => r.id);
    // Approval instances (ARC_TECH/ARC_COMMITTEE keyed on arc id; ARC_NEGOTIATION
    // keyed on round id) are not FK-cascaded from tbl_arc.
    const instanceIds = (await db.any(
      `SELECT id FROM tbl_approval_instances
        WHERE (entity_type IN ('ARC_TECH','ARC_COMMITTEE') AND entity_id = ANY($1::bigint[]))
           OR (entity_type = 'ARC_NEGOTIATION' AND entity_id = ANY($2::bigint[]))`,
      [createdArcIds, roundIds.length ? roundIds : [0]]
    )).map((r) => r.id);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_step_approvers
                      WHERE approval_instance_step_id IN
                        (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    if (roundIds.length) {
      await db.none(`DELETE FROM tbl_negotiation_round_quotes WHERE negotiation_round_id = ANY($1::int[])`, [roundIds]);
      await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [roundIds]);
    }
    const policyIds = [TECH_POLICY_ID, COMMITTEE_POLICY_ID, NEGOTIATION_POLICY_ID];
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [policyIds]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [policyIds]);
    await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = ANY($1::text[])`,
      [createdArcIds.map(String)]);
    // tbl_arc cascades items, item/universal tech-eval families, quotes, awards,
    // comm-eval, invitations, event log, aliases.
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [createdArcIds]);
    await db.none(
      `DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`,
      [CATEGORY, DEPT]
    );
    await cleanupArcEvalPerms(db, [BUYER]);
  });

  // ============================================================
  // 1 — REGRESSION: zero-universal ARC behaves identically (§8.1)
  // ============================================================
  describe("regression — an ARC with only per-item clauses (no universal) is unaffected", () => {
    test("universal read returns empty shells for an ARC that never configured universal", async () => {
      const res = await buyerClient.get(`${E}/${regArc}/universal-tech-eval`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(
        expect.objectContaining({ tech_evaluation: null, clauses: [], scores: [], responses: [] })
      );
    });

    test("full flow (score → submit/auto-approve → allocate → finalize) works; NO universal rows created", async () => {
      // Score P's item response so P is technically qualified.
      const score = await buyerClient.post(`${E}/tech-eval/score`).send({ response_id: regRespP, buyer_marks: 90 });
      expect(score.status).toBe(200);

      const submit = await buyerClient.post(`${E}/${regArc}/tech-eval/submit`).send({});
      expect(submit.status).toBe(200);

      // Auto-approval flips the ARC to tech_eval_approved (unchanged behaviour).
      const afterSubmit = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [regArc]);
      expect(afterSubmit.status).toBe("tech_eval_approved");

      // The universal fold is a strict no-op: no owner, no cleared rows exist.
      const univOwner = await db.oneOrNone(`SELECT id FROM tbl_arc_universal_tech_evaluation WHERE arc_id = $1`, [regArc]);
      expect(univOwner).toBeNull();

      // comm-eval: P is visible with real pricing, never redacted.
      const comm = await buyerClient.get(`${E}/${regArc}/comm-eval`);
      expect(comm.status).toBe(200);
      const pQuote = comm.body.data.quotes.find((q) => Number(q.vendor_id) === P);
      expect(pQuote).toBeTruthy();
      expect(pQuote.rate).not.toBeNull();
      expect(pQuote.technically_disqualified).toBeUndefined();
      expect(pQuote.universally_disqualified).toBeUndefined();

      // Allocate the whole qty to P, then finalize → committee instance spawns.
      const alloc = await buyerClient.post(`${E}/${regArc}/comm-eval/allocation`).send({
        item_id: regItem,
        allocations: [{ awarded_vendor_id: P, awarded_quote_line_id: regLine, allocated_qty: 1000, l_rank: "L1", is_l1_default: true, awarded_quote_snapshot: { rate: 123.45 } }],
      });
      expect(alloc.status).toBe(200);

      const finalize = await buyerClient.post(`${E}/${regArc}/comm-eval/finalize`).send({});
      expect(finalize.status).toBe(200);
      expect(finalize.body.data.approval_instance_id).toBeTruthy();
      const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [regArc]);
      expect(arc.status).toBe("committee_review");
    });
  });

  // ============================================================
  // 2 — UNIVERSAL GLOBAL KNOCKOUT at every commercial/award surface
  // ============================================================
  describe("universal global knockout — a universal-FAIL vendor is excluded from the whole ARC", () => {
    test("(a) comm-eval REDACTS the universal-FAIL vendor's pricing on a CLAUSE-LESS item; PASS vendor stays visible", async () => {
      const res = await buyerClient.get(`${E}/${koArc}/comm-eval`);
      expect(res.status).toBe(200);
      const quotes = res.body.data.quotes;

      const pQuote = quotes.find((q) => Number(q.vendor_id) === P);
      const fQuote = quotes.find((q) => Number(q.vendor_id) === F);
      expect(pQuote).toBeTruthy();
      expect(fQuote).toBeTruthy();

      // PASS vendor: pricing intact, no disqualification markers.
      expect(pQuote.rate).not.toBeNull();
      expect(pQuote.universally_disqualified).toBeUndefined();

      // FAIL vendor: pricing nulled + BOTH markers set — even though the item has
      // NO clauses (so qualifiedVendorsByItem omits it; the explicit universal set covers it).
      expect(fQuote.rate).toBeNull();
      expect(fQuote.line_pricing).toBeNull();
      expect(fQuote.technically_disqualified).toBe(true);
      expect(fQuote.universally_disqualified).toBe(true);

      // Belt-and-braces: the FAIL vendor's distinctive rate never leaks in the body.
      expect(JSON.stringify(res.body)).not.toContain("678.9");
    });

    test("(b) allocation to the universal-FAIL vendor is rejected (400); to the PASS vendor it succeeds", async () => {
      const badAlloc = await buyerClient.post(`${E}/${koArc}/comm-eval/allocation`).send({
        item_id: koItem,
        allocations: [{ awarded_vendor_id: F, awarded_quote_line_id: koLineF, allocated_qty: 1000, l_rank: "L1", is_l1_default: true, awarded_quote_snapshot: { rate: 678.90 } }],
      });
      expect(badAlloc.status).toBe(400);
      expect(badAlloc.body.message).toMatch(/ARC-wide \(universal\) technical clauses/i);

      const okAlloc = await buyerClient.post(`${E}/${koArc}/comm-eval/allocation`).send({
        item_id: koItem,
        allocations: [{ awarded_vendor_id: P, awarded_quote_line_id: koLineP, allocated_qty: 1000, l_rank: "L1", is_l1_default: true, awarded_quote_snapshot: { rate: 123.45 } }],
      });
      expect(okAlloc.status).toBe(200);
    });

    test("(c) finalize is rejected while an award still names a universal-FAIL vendor (stale-award guard)", async () => {
      const res = await buyerClient.post(`${E}/${finArc}/comm-eval/finalize`).send({});
      expect(res.status).toBe(400);
      // Universal (ARC-wide) failure now takes precedence over the per-item
      // reason, so the message names the ARC-wide clauses explicitly.
      expect(res.body.message).toMatch(/ARC-wide \(universal\) technical clauses/i);
      // The ARC never advanced — finalize was blocked.
      const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [finArc]);
      expect(arc.status).toBe("comm_eval_in_progress");
    });

    test("(d) the universal-FAIL vendor is not an eligible negotiation target (arc-level AND item-scoped); the PASS vendor is", async () => {
      const future = new Date(Date.now() + 2 * 86400_000).toISOString();

      // arc-level entry targeting the FAIL vendor → rejected.
      const arcLevelBad = await buyerClient.post(`${E}/${koArc}/comm-eval/negotiation/rounds`).send({
        end_date: future,
        products: [{ is_arc_level: true, vendor_targets: [{ vendor_id: F }] }],
      });
      expect(arcLevelBad.status).toBe(400);
      expect(arcLevelBad.body.message).toMatch(/ARC-wide \(universal\) technical clauses/i);

      // item-scoped entry targeting the FAIL vendor → rejected.
      const itemBad = await buyerClient.post(`${E}/${koArc}/comm-eval/negotiation/rounds`).send({
        end_date: future,
        products: [{ arc_item_id: koItem, vendor_targets: [{ vendor_id: F }] }],
      });
      expect(itemBad.status).toBe(400);
      expect(itemBad.body.message).toMatch(/ARC-wide \(universal\) technical clauses/i);

      // arc-level entry targeting the PASS vendor → accepted (proceeds normally).
      const okRound = await buyerClient.post(`${E}/${koArc}/comm-eval/negotiation/rounds`).send({
        end_date: future,
        products: [{ is_arc_level: true, vendor_targets: [{ vendor_id: P }] }],
      });
      expect(okRound.status).toBe(200);
    });
  });

  // ============================================================
  // 3 — ITEM vs UNIVERSAL INDEPENDENCE (§8.2 / §8.3)
  // ============================================================
  describe("item vs universal independence", () => {
    test("universal-PASS + item-FAIL vendor is excluded from THAT item ONLY; universal-FAIL vendor is excluded EVERYWHERE", async () => {
      const res = await buyerClient.get(`${E}/${indArc}/comm-eval`);
      expect(res.status).toBe(200);
      const q = (vid, item) => res.body.data.quotes.find(
        (x) => Number(x.vendor_id) === vid && Number(x.arc_item_id) === item
      );

      // P — universal-PASS + item-PASS everywhere → visible on both items.
      expect(q(P, indItem1).rate).not.toBeNull();
      expect(q(P, indItem2).rate).not.toBeNull();

      // M — universal-PASS but item-FAIL on item1: redacted on item1 (item reason,
      // NOT universal), but VISIBLE on item2 where it qualified.
      expect(q(M, indItem1).rate).toBeNull();
      expect(q(M, indItem1).technically_disqualified).toBe(true);
      expect(q(M, indItem1).universally_disqualified).toBeUndefined();
      expect(q(M, indItem2).rate).not.toBeNull();
      expect(q(M, indItem2).universally_disqualified).toBeUndefined();

      // F — universal-FAIL though item-PASS on both: redacted EVERYWHERE with the
      // universal marker.
      expect(q(F, indItem1).rate).toBeNull();
      expect(q(F, indItem1).universally_disqualified).toBe(true);
      expect(q(F, indItem2).rate).toBeNull();
      expect(q(F, indItem2).universally_disqualified).toBe(true);
    });
  });

  // ============================================================
  // 4 — SUBMIT persists the universal verdict (rides the SAME ARC_TECH instance)
  // ============================================================
  describe("submit records the universal cleared verdict alongside the per-item one", () => {
    test("scoreUniversalResponse persists marks blindly (no vendor_id leak)", async () => {
      const rP = await buyerClient.post(`${E}/universal-tech-eval/score`).send({ response_id: subRespP, buyer_marks: 90 });
      expect(rP.status).toBe(200);
      // Blind: the scored row echoes an alias, never the real vendor_id.
      expect(JSON.stringify(rP.body)).not.toMatch(/"vendor_id"/);

      const rF = await buyerClient.post(`${E}/universal-tech-eval/score`).send({ response_id: subRespF, buyer_marks: 10 });
      expect(rF.status).toBe(200);

      const rows = await db.any(
        `SELECT vendor_id, buyer_marks FROM tbl_arc_universal_tech_evaluation_vendors_response
          WHERE id = ANY($1::bigint[])`,
        [[subRespP, subRespF]]
      );
      const byV = Object.fromEntries(rows.map((r) => [Number(r.vendor_id), Number(r.buyer_marks)]));
      expect(byV[P]).toBe(90);
      expect(byV[F]).toBe(10);
    });

    test("blind buyer read exposes universal clauses + scores without leaking vendor_id", async () => {
      const res = await buyerClient.get(`${E}/${subArc}/universal-tech-eval`);
      expect(res.status).toBe(200);
      expect(res.body.data.tech_evaluation).toBeTruthy();
      expect(res.body.data.clauses.length).toBe(1);
      // Blind matrix: no real vendor_id in the payload.
      expect(JSON.stringify(res.body.data)).not.toMatch(/"vendor_id"/);
    });

    test("submit writes universal cleared rows (P qualified, F not_qualified) under NO new approval entity", async () => {
      const submit = await buyerClient.post(`${E}/${subArc}/tech-eval/submit`).send({});
      expect(submit.status).toBe(200);

      const cleared = await db.any(
        `SELECT cv.vendor_id, cv.status
           FROM tbl_arc_universal_tech_evaluation_cleared_vendors cv
           JOIN tbl_arc_universal_tech_evaluation te ON te.id = cv.arc_universal_tech_evaluation_id
          WHERE te.arc_id = $1`,
        [subArc]
      );
      const byV = Object.fromEntries(cleared.map((r) => [Number(r.vendor_id), r.status]));
      expect(byV[P]).toBe("qualified");
      expect(byV[F]).toBe("not_qualified");

      // Single-instance guarantee: only an ARC_TECH approval exists — never a
      // separate ARC_UNIVERSAL_TECH entity.
      const instances = await db.any(
        `SELECT DISTINCT entity_type FROM tbl_approval_instances WHERE entity_id = $1`,
        [subArc]
      );
      const types = instances.map((r) => r.entity_type);
      expect(types).toContain("ARC_TECH");
      expect(types).not.toContain("ARC_UNIVERSAL_TECH");

      // The persisted verdict now drives the knockout: F is redacted in comm-eval.
      const comm = await buyerClient.get(`${E}/${subArc}/comm-eval`);
      const fQuote = comm.body.data.quotes.find((q) => Number(q.vendor_id) === F);
      expect(fQuote.universally_disqualified).toBe(true);
    });
  });

  // ============================================================
  // 5 — SEAL GATE (§6.1): both item AND universal must be answered before sealing
  // ============================================================
  describe("seal gate — vendor cannot seal until BOTH item and universal clauses are answered", () => {
    test("the vendor tech-clauses payload carries a distinct `universal` section", async () => {
      const res = await alpha.get(`${VBASE}/requests/${sealArc}/tech-clauses`);
      expect(res.status).toBe(200);
      expect(res.body.data.universal).toBeTruthy();
      expect(res.body.data.universal.clauses.length).toBe(1);
      expect(res.body.data.universal.clauses[0].clause_text).toMatch(/ARC-wide/);
      // Universal clause is kept STRUCTURALLY SEPARATE from the per-item block
      // (assert by text — item/universal clause ids come from independent
      // sequences and can collide numerically).
      const itemClauseTexts = res.body.data.items.flatMap((it) => it.clauses.map((c) => c.clause_text));
      expect(itemClauseTexts).toContain("Item spec compliance");
      expect(itemClauseTexts).not.toContain("ARC-wide GST compliance");
    });

    test("answering ONLY the item clause is not enough to seal (409); commercial submit stays blocked", async () => {
      const itemDraft = await alpha.post(`${VBASE}/tech-envelope/draft`).send({
        arc_id: sealArc, responses: [{ clause_id: sealItemClause, vendor_response: "item answered" }],
      });
      expect(itemDraft.status).toBe(200);

      const sealBlocked = await alpha.post(`${VBASE}/tech-envelope/submit`).send({ arc_id: sealArc });
      expect(sealBlocked.status).toBe(409);
      expect(sealBlocked.body.message).toMatch(/Respond to all clauses/i);

      // Commercial submit is also blocked while the seal is missing.
      await alpha.post(`${VBASE}/quote/draft`).send({ arc_id: sealArc, lines: [{ arc_item_id: sealItem, rate: 90, gst_pct: 5 }] });
      const commBlocked = await alpha.post(`${VBASE}/quote/submit`).send({ arc_id: sealArc });
      expect(commBlocked.status).toBe(409);
      expect(commBlocked.body.message).toMatch(/technical envelope/i);
    });

    test("answering the universal clause too lets the seal succeed", async () => {
      const univDraft = await alpha.post(`${VBASE}/universal-tech-envelope/draft`).send({
        arc_id: sealArc, responses: [{ clause_id: sealUnivClause, vendor_response: "universal answered" }],
      });
      expect(univDraft.status).toBe(200);
      expect(univDraft.body.data.saved).toBe(1);

      const seal = await alpha.post(`${VBASE}/tech-envelope/submit`).send({ arc_id: sealArc });
      expect(seal.status).toBe(200);
      expect(seal.body.data.tech_submitted_at).toBeTruthy();
    });
  });

  // ============================================================
  // 6 — SECURITY / IDOR
  // ============================================================
  describe("security / IDOR — cross-ARC clause ids and cross-tenant callers are rejected", () => {
    test("a universal clause id from ANOTHER ARC is rejected on the vendor draft (400)", async () => {
      // Host on otherArc (P invited, NOT sealed) but reference a universal clause
      // that belongs to sealArc → the belongs-to guard rejects it.
      const res = await alpha.post(`${VBASE}/universal-tech-envelope/draft`).send({
        arc_id: otherArc, // says this ARC…
        responses: [{ clause_id: sealUnivClause, vendor_response: "cross-ARC leak attempt" }], // …but a clause from sealArc
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/does not belong to this rate contract/i);
    });

    test("a NON-invited vendor cannot upload universal evidence (403)", async () => {
      // gamma (M) was never invited to ARC_OTHER.
      const pdf = Buffer.from("%PDF-1.4\n%idor\n");
      const res = await gamma
        .post(`${VBASE}/universal-tech-envelope/clause/${otherUnivClause}/file`)
        .attach("file", pdf, { filename: "x.pdf", contentType: "application/pdf" });
      expect(res.status).toBe(403);
    });

    test("a cross-tenant buyer cannot setup / read / score the universal evaluation (403)", async () => {
      const future = new Date(Date.now() + 5 * 86400_000).toISOString();

      const setup = await crossClient.post(`${E}/${sealArc}/universal-tech-eval`).send({
        minimum_passing_score: 60,
        clauses: [{ clause_text: "hijack", weightage: 100 }],
      });
      expect(setup.status).toBe(403);

      const read = await crossClient.get(`${E}/${sealArc}/universal-tech-eval`);
      expect(read.status).toBe(403);

      const score = await crossClient.post(`${E}/universal-tech-eval/score`).send({
        response_id: otherUnivResp, buyer_marks: 50,
      });
      expect(score.status).toBe(403);

      // No universal owner was created on the cross-tenant setup attempt.
      const owner = await db.oneOrNone(
        `SELECT 1 FROM tbl_arc_universal_tech_evaluation te
           JOIN tbl_arc_universal_tech_evaluation_clauses c ON c.arc_universal_tech_evaluation_id = te.id
          WHERE te.arc_id = $1 AND c.clause_text = 'hijack'`,
        [sealArc]
      );
      expect(owner).toBeNull();
    });
  });

  // ============================================================
  // 7 — UNIVERSAL-ONLY ARC through the REAL lifecycle (regression for the
  //     "universal-only silently skips technical & awards without knockout" bug)
  //
  // Nothing is pre-seeded here beyond clauses / vendor responses / quotes: NO
  // cleared-vendor rows, NO comm-eval row, NO forced comm_eval status. The buyer
  // drives the real endpoints so this scenario would FAIL against the pre-fix
  // code (where the lifecycle "needs technical?" predicate counted item clauses
  // only → technical skipped → awarding opened with no universal knockout).
  // ============================================================
  describe("universal-only ARC — real lifecycle, no pre-seeding", () => {
    const stageOf = (body, key) => body.data.stages.find((s) => s.key === key);

    test("(a/b) before technical approval: technical is NOT skipped + commercial is LOCKED; awarding is blocked (409)", async () => {
      const lc = await buyerClient.get(`/api/v1/arc-v2/${uoArc}/lifecycle`);
      expect(lc.status).toBe(200);

      const tech = stageOf(lc.body, "technical");
      const comm = stageOf(lc.body, "commercial");
      // The whole point: a universal-only ARC must NOT skip technical.
      expect(tech.state).not.toBe("skipped");
      expect(tech.reason).not.toBe("no_clauses_configured");
      expect(["active", "partial"]).toContain(tech.state); // technical in-progress
      // …and commercial stays locked behind the (un-ratified) technical stage.
      expect(comm.state).toBe("locked");
      expect(comm.reason).toBe("technical_incomplete");

      // Awarding cannot be reached before the ARC_TECH approval lands.
      const blocked = await buyerClient.post(`${E}/${uoArc}/comm-eval/allocation`).send({
        item_id: uoItem,
        allocations: [{ awarded_vendor_id: P, awarded_quote_line_id: uoLineP, allocated_qty: 1000, l_rank: "L1", is_l1_default: true, awarded_quote_snapshot: { rate: 321.01 } }],
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe("STAGE_LOCKED");
    });

    test("(c) real score → submit auto-approves, records the universal verdict, and unlocks commercial", async () => {
      const sP = await buyerClient.post(`${E}/universal-tech-eval/score`).send({ response_id: uoRespP, buyer_marks: 90 });
      expect(sP.status).toBe(200);
      const sF = await buyerClient.post(`${E}/universal-tech-eval/score`).send({ response_id: uoRespF, buyer_marks: 10 });
      expect(sF.status).toBe(200);

      const submit = await buyerClient.post(`${E}/${uoArc}/tech-eval/submit`).send({});
      expect(submit.status).toBe(200);

      // The shared ARC_TECH approval auto-approves (buyer is the approver) → the
      // ARC advances, and the universal verdict is persisted (P pass / F fail).
      const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [uoArc]);
      expect(arc.status).toBe("tech_eval_approved");

      const cleared = await db.any(
        `SELECT cv.vendor_id, cv.status
           FROM tbl_arc_universal_tech_evaluation_cleared_vendors cv
           JOIN tbl_arc_universal_tech_evaluation te ON te.id = cv.arc_universal_tech_evaluation_id
          WHERE te.arc_id = $1`,
        [uoArc]
      );
      const byV = Object.fromEntries(cleared.map((r) => [Number(r.vendor_id), r.status]));
      expect(byV[P]).toBe("qualified");
      expect(byV[F]).toBe("not_qualified");

      // Only an ARC_TECH instance exists (single-instance guarantee) — never a
      // separate ARC_UNIVERSAL_TECH entity.
      const types = (await db.any(
        `SELECT DISTINCT entity_type FROM tbl_approval_instances WHERE entity_id = $1`, [uoArc]
      )).map((r) => r.entity_type);
      expect(types).toContain("ARC_TECH");
      expect(types).not.toContain("ARC_UNIVERSAL_TECH");

      // Lifecycle now reflects the approval: technical complete, commercial open.
      const lc = await buyerClient.get(`/api/v1/arc-v2/${uoArc}/lifecycle`);
      expect(stageOf(lc.body, "technical").state).toBe("complete");
      expect(stageOf(lc.body, "commercial").state).not.toBe("locked");
    });

    test("(c) after the real approval, the universal-FAIL vendor is knocked out of allocation, finalize & negotiation; the PASS vendor proceeds", async () => {
      // Allocation to the universal-FAIL vendor is rejected outright.
      const badAlloc = await buyerClient.post(`${E}/${uoArc}/comm-eval/allocation`).send({
        item_id: uoItem,
        allocations: [{ awarded_vendor_id: F, awarded_quote_line_id: uoLineF, allocated_qty: 1000, l_rank: "L1", is_l1_default: true, awarded_quote_snapshot: { rate: 654.02 } }],
      });
      expect(badAlloc.status).toBe(400);
      expect(badAlloc.body.message).toMatch(/ARC-wide \(universal\) technical clauses/i);

      // The PASS vendor IS allocatable (opens comm-eval for real).
      const okAlloc = await buyerClient.post(`${E}/${uoArc}/comm-eval/allocation`).send({
        item_id: uoItem,
        allocations: [{ awarded_vendor_id: P, awarded_quote_line_id: uoLineP, allocated_qty: 1000, l_rank: "L1", is_l1_default: true, awarded_quote_snapshot: { rate: 321.01 } }],
      });
      expect(okAlloc.status).toBe(200);

      // Negotiation: the universal-FAIL vendor is not an eligible target.
      const future = new Date(Date.now() + 2 * 86400_000).toISOString();
      const negBad = await buyerClient.post(`${E}/${uoArc}/comm-eval/negotiation/rounds`).send({
        end_date: future,
        products: [{ is_arc_level: true, vendor_targets: [{ vendor_id: F }] }],
      });
      expect(negBad.status).toBe(400);
      expect(negBad.body.message).toMatch(/ARC-wide \(universal\) technical clauses/i);

      // Finalize: if an award still names the universal-FAIL vendor it is rejected
      // by the stale-award guard. Point the (real) award at F, finalize, restore.
      const comm = await db.one(`SELECT id FROM tbl_arc_comm_evaluation WHERE arc_id = $1`, [uoArc]);
      await db.none(
        `UPDATE tbl_arc_comm_evaluation_award SET awarded_vendor_id = $1
          WHERE arc_comm_evaluation_id = $2 AND arc_item_id = $3`,
        [F, comm.id, uoItem]
      );
      const finBad = await buyerClient.post(`${E}/${uoArc}/comm-eval/finalize`).send({});
      expect(finBad.status).toBe(400);
      // Universal (ARC-wide) failure takes precedence in the finalize guard.
      expect(finBad.body.message).toMatch(/ARC-wide \(universal\) technical clauses/i);
      await db.none(
        `UPDATE tbl_arc_comm_evaluation_award SET awarded_vendor_id = $1
          WHERE arc_comm_evaluation_id = $2 AND arc_item_id = $3`,
        [P, comm.id, uoItem]
      );
    });

    test("(d) a universal-only ARC's commercial can be sent back to technical", async () => {
      const res = await buyerClient.post(`${E}/${uoArc}/comm-eval/send-back-to-tech`).send({
        reason: "Re-check ARC-wide GST compliance evidence",
      });
      expect(res.status).toBe(200);

      // Commercial parks at sent_back; the ARC reopens technical.
      const comm = await db.one(`SELECT status FROM tbl_arc_comm_evaluation WHERE arc_id = $1`, [uoArc]);
      expect(comm.status).toBe("sent_back");
      const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [uoArc]);
      expect(arc.status).toBe("tech_eval_in_progress");

      // Lifecycle: commercial locked (sent back), technical no longer complete.
      const lc = await buyerClient.get(`/api/v1/arc-v2/${uoArc}/lifecycle`);
      const commStage = stageOf(lc.body, "commercial");
      expect(commStage.state).toBe("locked");
      expect(commStage.reason).toBe("sent_back_to_tech");
      expect(stageOf(lc.body, "technical").state).not.toBe("complete");
    });
  });
});
