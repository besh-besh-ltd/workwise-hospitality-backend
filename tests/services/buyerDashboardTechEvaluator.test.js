// Integration test for the Technical Evaluator dashboard widgets.
//
// Seeds a deterministic tech-eval state at Hotel A1 in PRODUCTION shapes and
// asserts exact counts + exact tech-eval ids over real HTTP:
//
//   · "pending" means ACTIONABLE — prod had 212 open evaluation rows of which
//     at most 78 could be acted on (the rest sat on closed / unpublished /
//     already-awarded RFQs, or were still inside the bid window);
//   · vendors answer a clause with free text, and prod stores the negative as
//     'I Dont Agree' — never 'disagree', which is why the old widget was 0.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import moment from "moment-timezone";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  cleanupTechEvals,
  addProductToRfq,
  makeTechEval,
  insertVendorTechResponse,
  insertVendorQuote,
  makePO,
  cleanupPurchaseOrders,
  cleanupApprovalInstances,
} from "../helpers/dashboardSeed.js";

const inserted = { rfqIds: [], poIds: [], techApprovalEntityIds: [] };
const seeded = {};

// bid_end_date is naive IST text.
const istDateTime = (offsetDays) =>
  moment.tz("Asia/Kolkata").add(offsetDays, "days").format("YYYY-MM-DDTHH:mm");

/** An RFQ at A1 whose bid window closed `daysAgo` days ago, with one real quote. */
async function closedRfqWithEval(t, title, { daysAgo = 2, hotel = IDS.hotels.A1, status = 1, quote = true } = {}) {
  const rfq = await makeRfqVisibleToDashboard(t, {
    createdBy: IDS.users.a1_proc_buyer,
    hospitality: IDS.hospitality.A,
    hotel,
    status,
    is_published: 1,
    title,
    bid_end_date: istDateTime(-daysAgo),
  });
  const prod = await addProductToRfq(t, rfq.rfq_id);
  if (quote) await insertVendorQuote(t, { rfq_id: rfq.rfq_id, vendor_user_id: IDS.users.vendor_alpha });
  const te = await makeTechEval(t, { rfq_id: rfq.rfq_id, rfq_product_id: prod.rfq_product_id, isComplete: false });
  inserted.rfqIds.push(rfq.rfq_id);
  return { rfq_id: rfq.rfq_id, rfq_product_id: prod.rfq_product_id, ...te };
}

beforeAll(async () => {
  await db.tx(async (t) => {
    // ── Actionable: bid closed, a real quote in, not awarded, not submitted
    const a1 = await closedRfqWithEval(t, "TE actionable — older", { daysAgo: 3 });
    const a2 = await closedRfqWithEval(t, "TE actionable — newer", { daysAgo: 1 });

    // ── NOT actionable ────────────────────────────────────────────────
    // Bid window still open — quotes are sealed.
    const openRfq = await makeRfqVisibleToDashboard(t, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      status: 1, is_published: 1, title: "TE bid still open",
      bid_end_date: istDateTime(5),
    });
    inserted.rfqIds.push(openRfq.rfq_id);
    const openProd = await addProductToRfq(t, openRfq.rfq_id);
    await insertVendorQuote(t, { rfq_id: openRfq.rfq_id, vendor_user_id: IDS.users.vendor_alpha });
    const teOpen = await makeTechEval(t, { rfq_id: openRfq.rfq_id, rfq_product_id: openProd.rfq_product_id });

    // RFQ closed (status 2).
    const closed = await closedRfqWithEval(t, "TE on a closed RFQ", { status: 2 });
    // Nobody quoted — nothing to evaluate.
    const noQuote = await closedRfqWithEval(t, "TE with no quotes", { quote: false });
    // Product already on a live PO.
    const awarded = await closedRfqWithEval(t, "TE already awarded");
    const po = await makePO(t, {
      rfq_id: awarded.rfq_id, rfq_product_id: awarded.rfq_product_id,
      vendor_user_id: IDS.users.vendor_alpha, company_id: IDS.companies.A,
      status: "approved",
    });
    inserted.poIds.push(po.po_id);
    // Evaluator already submitted — a PENDING TECHNICAL approval exists for
    // the product (entity_id is the round; the product is in metadata).
    const submitted = await closedRfqWithEval(t, "TE submitted for approval");
    const roundId = 900000 + submitted.tech_eval_id;
    await t.none(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, current_step,
          initiated_by, hospitality_company_id, hotel_id, metadata)
       VALUES ('TECHNICAL', $1, $2, 'PENDING', 1, $3, $4, $5, $6)`,
      [roundId, IDS.policies.A1_P1_TECHNICAL, IDS.users.a1_proc_techEval, IDS.hospitality.A, IDS.hotels.A1,
        { rfq_id: submitted.rfq_id, rfq_product_id: submitted.rfq_product_id }]
    );
    inserted.techApprovalEntityIds.push(roundId);

    // Completed evaluation.
    const done = await closedRfqWithEval(t, "TE complete");
    await t.none(`UPDATE tbl_rfq_product_tech_evaluation SET is_complete = true WHERE id = $1`, [done.tech_eval_id]);

    // Wrong hotel.
    const a2Hotel = await closedRfqWithEval(t, "TE at A2", { hotel: IDS.hotels.A2 });

    // ── Disagreements (prod wording) ──────────────────────────────────
    // a1: two vendors say 'I Dont Agree' on one clause.
    await insertVendorTechResponse(t, { clause_id: a1.clause_ids[0], vendor_id: IDS.users.vendor_alpha, response: "I Dont Agree" });
    await insertVendorTechResponse(t, { clause_id: a1.clause_ids[0], vendor_id: IDS.users.vendor_beta, response: "I Dont Agree" });
    // a2: one vendor disagrees on two clauses (legacy 'disagree' still counts).
    await insertVendorTechResponse(t, { clause_id: a2.clause_ids[0], vendor_id: IDS.users.vendor_alpha, response: "I Dont Agree" });
    await insertVendorTechResponse(t, { clause_id: a2.clause_ids[1], vendor_id: IDS.users.vendor_alpha, response: "disagree" });
    // 'I Agree' and free text never count.
    await insertVendorTechResponse(t, { clause_id: a2.clause_ids[1], vendor_id: IDS.users.vendor_beta, response: "I Agree" });
    await insertVendorTechResponse(t, { clause_id: a2.clause_ids[0], vendor_id: IDS.users.vendor_beta, response: "Conforms to the specified formulation." });
    // Disagreement on a CLOSED RFQ — not actionable.
    await insertVendorTechResponse(t, { clause_id: closed.clause_ids[0], vendor_id: IDS.users.vendor_alpha, response: "I Dont Agree" });
    // Disagreement at A2 — out of the selected hotel.
    await insertVendorTechResponse(t, { clause_id: a2Hotel.clause_ids[0], vendor_id: IDS.users.vendor_alpha, response: "I Dont Agree" });

    Object.assign(seeded, {
      a1, a2, closed, noQuote, awarded, submitted, done, a2Hotel,
      teOpen: teOpen.tech_eval_id,
    });
  });
});

afterAll(async () => {
  await cleanupApprovalInstances(db, "TECHNICAL", inserted.techApprovalEntityIds);
  await cleanupPurchaseOrders(db, inserted.poIds);
  await cleanupTechEvals(db, inserted.rfqIds);
  await cleanupRfqs(db, inserted.rfqIds);
  await closeDb();
});

describe("Buyer Dashboard — Technical Evaluator widgets (real data)", () => {
  describe("GET /dashboard-v2/my-tech-evals-pending", () => {
    it("returns only the evaluations someone can act on now, oldest bid close first", async () => {
      const client = await httpClient(IDS.users.a1_proc_techEval);
      const res = await client
        .get("/api/v1/dashboard-v2/my-tech-evals-pending")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(1);
      expect(res.body.data.count).toBe(2);

      const ids = res.body.data.items.map((i) => i.id);
      expect(ids).toEqual([seeded.a1.tech_eval_id, seeded.a2.tech_eval_id]);

      for (const excluded of [seeded.teOpen, seeded.closed.tech_eval_id, seeded.noQuote.tech_eval_id,
        seeded.awarded.tech_eval_id, seeded.submitted.tech_eval_id, seeded.done.tech_eval_id,
        seeded.a2Hotel.tech_eval_id]) {
        expect(ids).not.toContain(excluded);
      }

      // Link contract: rfq_id + rfq_product_id (tbl_rfq_products.id).
      const first = res.body.data.items[0];
      expect(first.rfq_id).toBe(seeded.a1.rfq_id);
      expect(first.rfq_product_id).toBe(seeded.a1.rfq_product_id);
      expect(first).toHaveProperty("rfq_no");
      expect(first).toHaveProperty("product_name");
      expect(first.waiting_since).toBeTruthy();
      expect(res.body.data.oldest_waiting_since).toBe(first.waiting_since);
    });
  });

  describe("GET /dashboard-v2/tech-evals-with-disagreements", () => {
    it("counts prod's 'I Dont Agree' responses on open evaluations", async () => {
      const client = await httpClient(IDS.users.a1_proc_techEval);
      const res = await client
        .get("/api/v1/dashboard-v2/tech-evals-with-disagreements")
        .query({ hotel_ids: String(IDS.hotels.A1) });

      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(2);

      const byId = {};
      for (const item of res.body.data.items) byId[item.id] = item;

      expect(byId[seeded.a1.tech_eval_id].disagreeing_vendor_count).toBe(2);
      expect(byId[seeded.a1.tech_eval_id].disagreeing_clause_count).toBe(1);
      expect(byId[seeded.a2.tech_eval_id].disagreeing_vendor_count).toBe(1);
      expect(byId[seeded.a2.tech_eval_id].disagreeing_clause_count).toBe(2);
      expect(byId[seeded.a2.tech_eval_id].rfq_product_id).toBe(seeded.a2.rfq_product_id);
      expect(res.body.data.total_disagreement_clauses).toBe(3);

      // Closed RFQ and other-hotel disagreements are not in the queue.
      expect(byId[seeded.closed.tech_eval_id]).toBeUndefined();
      expect(byId[seeded.a2Hotel.tech_eval_id]).toBeUndefined();

      // Most vendors disagreeing first.
      expect(res.body.data.items[0].id).toBe(seeded.a1.tech_eval_id);
    });
  });

  describe("Scope isolation", () => {
    it("Hotel B user sees zero tech-evals for our seeded A-side data", async () => {
      const client = await httpClient(IDS.users.companyB_admin);
      const [pending, disagree] = await Promise.all([
        client.get("/api/v1/dashboard-v2/my-tech-evals-pending").query({ hotel_ids: String(IDS.hotels.B1) }),
        client.get("/api/v1/dashboard-v2/tech-evals-with-disagreements").query({ hotel_ids: String(IDS.hotels.B1) }),
      ]);
      expect(pending.body.data.count).toBe(0);
      expect(disagree.body.data.count).toBe(0);
      expect(disagree.body.data.total_disagreement_clauses).toBe(0);
    });
  });
});
